"""Groq via the OpenAI-compatible Chat Completions API (groq SDK).

The LLM owns exactly two judgments — what to remember (extract) and how a new
fact relates to an old one (judge_conflict) — plus the user-facing reply. Both
judgments use structured output (a JSON schema derived from the Pydantic model)
so the decision is a typed object, not free text. Every call returns
(result, meta) where meta carries tokens + latency for the metrics surface.
"""

from __future__ import annotations

import time
from typing import Any, Type

from groq import Groq
from pydantic import BaseModel

from . import config
from .models import Extraction, Judgment

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
        _client = Groq(api_key=config.GROQ_API_KEY or None)
    return _client


# ---- Pydantic -> Groq strict-schema (inline $refs, whitelist keys, all-required) ----
# Groq strict json_schema requires every property to be in `required` and every
# object to set additionalProperties:false. Pydantic omits defaulted fields from
# `required`, so we recompute it from the property set.
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


def _meta(model_id: str, completion: Any, started: float) -> dict:
    u = getattr(completion, "usage", None)
    return {
        "model": model_id,
        "input_tokens": getattr(u, "prompt_tokens", 0) or 0,
        "output_tokens": getattr(u, "completion_tokens", 0) or 0,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }


def _structured(
    model_id: str,
    system: str,
    prompt: str,
    schema_model: Type[BaseModel],
    max_tokens: int,
) -> tuple[BaseModel, dict]:
    started = time.perf_counter()
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
                "schema": _groq_schema(schema_model),
            },
        },
    )
    text = _strip_fences(completion.choices[0].message.content or "{}")
    parsed = schema_model.model_validate_json(text)
    return parsed, _meta(model_id, completion, started)


EXTRACT_SYSTEM = """You extract durable, long-term memories about the USER from a chat message.

Store a candidate only if it is a stable fact, preference, identity detail, or an
ongoing situation worth recalling in future conversations. Do NOT store: greetings,
one-off questions, transient mood, or anything about the assistant.

For each candidate: write `text` as a standalone third-person statement ("The user
is vegetarian."), pick the most specific `scope`, quote the exact `source_excerpt`
from the message that evidences it, and set `confidence` between 0 and 1.

If the user explicitly asks to forget or delete something they told you, set
`forget_request` to the subject (e.g. "diet", "my job"); otherwise an empty string.

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
    return parsed, meta  # type: ignore[return-value]


def judge_conflict(candidate_text: str, neighbour_text: str) -> tuple[Judgment, dict]:
    prompt = f"NEW candidate:\n{candidate_text}\n\nEXISTING memory:\n{neighbour_text}"
    parsed, meta = _structured(config.JUDGE_MODEL, JUDGE_SYSTEM, prompt, Judgment, 512)
    return parsed, meta  # type: ignore[return-value]


def reply(user_msg: str, history: list[dict], memories: list[dict]) -> tuple[str, dict]:
    mem_block = (
        "\n".join(f"- ({m['scope']}) {m['text']}" for m in memories)
        or "(none retrieved)"
    )
    prompt = (
        f"Conversation so far:\n{_format_history(history)}\n\n"
        f"MEMORIES about the user:\n{mem_block}\n\nUser message:\n{user_msg}"
    )
    started = time.perf_counter()
    completion = client().chat.completions.create(
        model=config.REPLY_MODEL,
        messages=[
            {"role": "system", "content": REPLY_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        max_completion_tokens=1024,
    )
    return (completion.choices[0].message.content or ""), _meta(
        config.REPLY_MODEL, completion, started
    )
