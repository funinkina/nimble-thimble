"""Groq via the OpenAI-compatible Chat Completions API (groq SDK).

The LLM owns exactly two judgments — what to remember (extract) and how a new
fact relates to an old one (judge_conflict) — plus the user-facing reply. Both
judgments use structured output (a JSON schema derived from the Pydantic model)
so the decision is a typed object, not free text. Every call returns
(result, meta) where meta carries tokens + latency for the metrics surface.
"""

from __future__ import annotations

import time
from functools import lru_cache
from typing import Any, Iterator, Type

from groq import Groq
from pydantic import BaseModel

from . import config
from .models import Extraction, Judgment, Relation

_client: Groq | None = None

# Keys Groq's json_schema structured output accepts; everything else (title,
# default, numeric bounds, $defs) is stripped. Groq strict mode rejects numeric
# bounds (minimum/maximum) and $ref, same as OpenAI's constrained decoding.
_ALLOWED = {
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "description",
}


def client() -> Groq:
    global _client
    if _client is None:
        # max_retries=0: the SDK retries 5xx/timeouts, but json_validate_failed is
        # a 400 it won't retry — we own that loop in _structured instead.
        _client = Groq(
            api_key=config.GROQ_API_KEY or None,
            timeout=config.LLM_TIMEOUT,
            max_retries=0,
        )
    return _client


# ---- Pydantic -> Groq strict-schema (inline $refs, whitelist keys, all-required) ----
# Groq strict json_schema requires every property to be in `required` and every
# object to set additionalProperties:false. Pydantic omits defaulted fields from
# `required`, so we recompute it from the property set.
@lru_cache(maxsize=None)
def _groq_schema(model: Type[BaseModel]) -> dict:
    raw = model.model_json_schema()
    defs = raw.get("$defs", {})

    def resolve(node: Any) -> Any:
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            target = resolve(defs[node["$ref"].split("/")[-1]])
            if "description" in node and isinstance(target, dict):
                target = {**target, "description": node["description"]}
            return target
        if "allOf" in node and len(node["allOf"]) == 1:
            base = resolve(node["allOf"][0])
            if "description" in node and isinstance(base, dict):
                base = {**base, "description": node["description"]}
            return base
        if "anyOf" in node:  # defensive: Optional[...] -> pick non-null branch
            branches = [b for b in node["anyOf"] if b.get("type") != "null"]
            return resolve(branches[0]) if branches else {"type": "string"}
        out: dict = {}
        for k, v in node.items():
            if k not in _ALLOWED:
                continue
            if k == "properties":
                out[k] = {name: resolve(sub) for name, sub in v.items()}
            elif k == "items":
                out[k] = resolve(v)
            else:
                out[k] = v
        if out.get("type") == "object" and "properties" in out:
            out["required"] = list(out["properties"].keys())
            out["additionalProperties"] = False
        return out

    return resolve(raw)


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.endswith("```"):
            t = t[:-3]
    return t.strip()


def _cached_tokens(usage: Any) -> int:
    """Groq (OpenAI-compat) reports prefix-cache hits at
    usage.prompt_tokens_details.cached_tokens. Robust to object or dict shape."""
    d = getattr(usage, "prompt_tokens_details", None)
    if d is None:
        return 0
    if isinstance(d, dict):
        return d.get("cached_tokens", 0) or 0
    return getattr(d, "cached_tokens", 0) or 0


def _meta(model_id: str, completion: Any, started: float) -> dict:
    u = getattr(completion, "usage", None)
    return {
        "model": model_id,
        "input_tokens": getattr(u, "prompt_tokens", 0) or 0,
        "output_tokens": getattr(u, "completion_tokens", 0) or 0,
        "cached_tokens": _cached_tokens(u),
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }


def _structured(
    model_id: str,
    system: str,
    prompt: str,
    schema_model: Type[BaseModel],
    max_tokens: int,
) -> tuple[BaseModel | None, dict]:
    """Call Groq with strict json_schema. Returns (parsed, meta), or (None, meta)
    if every attempt fails — Groq's strict mode 400s with json_validate_failed on
    ~10% of requests, so retry, then degrade gracefully rather than 500 the turn.
    `meta` carries an `error` field on the final failure so the trace shows it."""
    started = time.perf_counter()
    schema = _groq_schema(schema_model)
    last_err = ""
    for attempt in range(config.LLM_RETRIES + 1):
        try:
            completion = client().chat.completions.create(
                model=model_id,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                max_completion_tokens=max_tokens,
                reasoning_effort="low",
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_model.__name__.lower(),
                        "strict": True,
                        "schema": schema,
                    },
                },
            )
            text = _strip_fences(completion.choices[0].message.content or "{}")
            parsed = schema_model.model_validate_json(text)
            meta = _meta(model_id, completion, started)
            if attempt:
                meta["retries"] = attempt
            return parsed, meta
        except Exception as e:  # noqa: BLE001 - degrade on any LLM/parse failure
            last_err = f"{type(e).__name__}: {e}"
    return None, {
        "model": model_id,
        "input_tokens": 0,
        "output_tokens": 0,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        "error": last_err,
        "retries": config.LLM_RETRIES,
    }


EXTRACT_SYSTEM = """You extract durable, long-term memories about the USER from a chat message.

Store a candidate only if it is a stable fact, preference, identity detail, or an
ongoing situation worth recalling in future conversations. Do NOT store: greetings,
one-off questions, transient mood, or anything about the assistant.

For each candidate: write `text` as a standalone third-person statement ("The user
is vegetarian."), pick the most specific `scope`, quote the exact `source_excerpt`
from the message that evidences it, and set `confidence` between 0 and 1.

Detecting forget requests is REQUIRED. If the user asks you to forget, delete,
drop, remove, or stop remembering something, set `forget_request` to the subject
phrase (and do NOT also store it as a candidate). Examples:
- "forget everything about my diet" -> forget_request: "diet"
- "please delete what I told you about my job" -> forget_request: "my job"
- "stop remembering my address" -> forget_request: "address"
Otherwise set `forget_request` to an empty string.

Return an empty candidate list for pure chit-chat."""

JUDGE_SYSTEM = """You compare a NEW candidate memory against the single EXISTING memory most
similar to it, and classify their relation:

- duplicate: same meaning, no new information -> the new one should be dropped.
- update: same subject, a refined or more specific value (not a contradiction).
- supersede: same subject, the new value CONTRADICTS the old one.
- unrelated: they only look similar; actually different subjects.
- new: no meaningful relation; store the candidate fresh.

Give a one-sentence reason citing both texts."""

REPLY_SYSTEM = """You are a warm, concise chat assistant with long-term memory of the user.

You are given MEMORIES retrieved about the user. Use them naturally when they are
relevant to the user's message — they are why you "remember" things. Never invent
memories you weren't given, and don't list them back mechanically. If no memory is
relevant, just answer normally. Respond directly, without preamble."""


def _format_history(history: list[dict]) -> str:
    return "\n".join(
        f"{m['role']}: {m['content']}" for m in history[-config.HISTORY_TURNS :]
    )


def extract(user_msg: str, history: list[dict]) -> tuple[Extraction, dict]:
    prompt = (
        f"Recent conversation:\n{_format_history(history)}\n\n"
        f"Latest user message to analyse:\n{user_msg}"
    )
    parsed, meta = _structured(
        config.JUDGE_MODEL, EXTRACT_SYSTEM, prompt, Extraction, 1024
    )
    # degrade: extract nothing this turn rather than crash
    return parsed or Extraction(candidates=[], forget_request=""), meta


def judge_conflict(candidate_text: str, neighbour_text: str) -> tuple[Judgment, dict]:
    prompt = f"NEW candidate:\n{candidate_text}\n\nEXISTING memory:\n{neighbour_text}"
    parsed, meta = _structured(config.JUDGE_MODEL, JUDGE_SYSTEM, prompt, Judgment, 512)
    # degrade: treat as a fresh, unrelated fact rather than crash
    return parsed or Judgment(relation=Relation.new, reason="judge unavailable"), meta


REPLY_FALLBACK = "Sorry — I had trouble generating a reply just now. Try again?"


def _reply_messages(
    user_msg: str, history: list[dict], memories: list[dict]
) -> list[dict]:
    """Real message array (not a flattened blob) so Groq prefix-caches the stable
    head — [system] + prior turns — across turns of a conversation. Static REPLY_SYSTEM
    stays at index 0; retrieval-dynamic memories ride the final user turn (the tail),
    so they never invalidate the cached prefix."""
    mem_block = (
        "\n".join(f"- ({m['scope']}) {m['text']}" for m in memories)
        or "(none retrieved)"
    )
    msgs: list[dict] = [{"role": "system", "content": REPLY_SYSTEM}]
    for m in history[-config.HISTORY_TURNS :]:
        msgs.append({"role": m["role"], "content": m["content"]})
    msgs.append(
        {
            "role": "user",
            "content": f"MEMORIES about the user:\n{mem_block}\n\nUser message:\n{user_msg}",
        }
    )
    return msgs


def reply(user_msg: str, history: list[dict], memories: list[dict]) -> tuple[str, dict]:
    messages = _reply_messages(user_msg, history, memories)
    started = time.perf_counter()
    try:
        completion = client().chat.completions.create(
            model=config.REPLY_MODEL,
            messages=messages,
            max_completion_tokens=config.REPLY_MAX_TOKENS,
        )
        meta = _meta(config.REPLY_MODEL, completion, started)
        finish = getattr(completion.choices[0], "finish_reason", None)
        if finish and finish != "stop":
            meta["finish_reason"] = finish
        return (completion.choices[0].message.content or ""), meta
    except Exception as e:  # noqa: BLE001 - degrade to a graceful message, never 500
        meta = _meta(config.REPLY_MODEL, None, started)
        meta["error"] = f"{type(e).__name__}: {e}"
        return (REPLY_FALLBACK, meta)


def reply_stream(
    user_msg: str, history: list[dict], memories: list[dict]
) -> Iterator[tuple[str, Any]]:
    """Stream the reply token-by-token. Yields ("delta", text) per chunk, then a
    final ("done", (full_text, meta)). Degrades like reply(): on any error it yields
    no deltas and a single ("done", (fallback, meta-with-error)) so the turn never
    500s. full_text from the "done" event is always authoritative."""
    messages = _reply_messages(user_msg, history, memories)
    started = time.perf_counter()
    parts: list[str] = []
    usage = None
    finish = None
    try:
        stream = client().chat.completions.create(
            model=config.REPLY_MODEL,
            messages=messages,
            max_completion_tokens=config.REPLY_MAX_TOKENS,
            stream=True,
        )
        for chunk in stream:
            xg = getattr(chunk, "x_groq", None)
            usage = getattr(chunk, "usage", None) or getattr(xg, "usage", None) or usage
            choices = getattr(chunk, "choices", None)
            if not choices:
                continue
            ch = choices[0]
            delta = getattr(ch.delta, "content", None)
            if delta:
                parts.append(delta)
                yield ("delta", delta)
            if getattr(ch, "finish_reason", None):
                finish = ch.finish_reason
        meta = {
            "model": config.REPLY_MODEL,
            "input_tokens": getattr(usage, "prompt_tokens", 0) or 0,
            "output_tokens": getattr(usage, "completion_tokens", 0) or 0,
            "cached_tokens": _cached_tokens(usage),
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
        }
        # finish_reason=="length" means we hit REPLY_MAX_TOKENS mid-reply — surface
        # it in the trace instead of letting the text silently cut off.
        if finish and finish != "stop":
            meta["finish_reason"] = finish
        yield ("done", ("".join(parts), meta))
    except Exception as e:  # noqa: BLE001 - degrade gracefully, never 500
        # Keep whatever already streamed so a mid-stream drop doesn't blank the
        # bubble; only fall back to the canned line if nothing arrived at all.
        partial = "".join(parts)
        meta = {
            "model": config.REPLY_MODEL,
            "input_tokens": 0,
            "output_tokens": 0,
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "error": f"{type(e).__name__}: {e}",
        }
        yield ("done", (partial or REPLY_FALLBACK, meta))
