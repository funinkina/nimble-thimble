"""Anthropic calls. The LLM owns exactly two judgments — what to remember
(extract) and how a new fact relates to an old one (judge_conflict) — plus the
user-facing reply. Both judgments use structured outputs so the decision is a
typed object, not free text. Every call returns (result, meta) where meta carries
tokens + latency for the metrics surface.
"""
from __future__ import annotations

import time
from typing import Any

import anthropic

from . import config
from .models import Extraction, Judgment

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY or None)
    return _client


def _meta(model: str, resp: Any, started: float) -> dict:
    u = getattr(resp, "usage", None)
    return {
        "model": model,
        "input_tokens": getattr(u, "input_tokens", 0) or 0,
        "output_tokens": getattr(u, "output_tokens", 0) or 0,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }


EXTRACT_SYSTEM = """You extract durable, long-term memories about the USER from a chat message.

Store a candidate only if it is a stable fact, preference, identity detail, or an
ongoing situation worth recalling in future conversations. Do NOT store: greetings,
one-off questions, transient mood, or anything about the assistant.

For each candidate: write `text` as a standalone third-person statement ("The user
is vegetarian."), pick the most specific `scope`, quote the exact `source_excerpt`
from the message that evidences it, and set `confidence`.

If the user explicitly asks to forget or delete something they told you, set
`forget_request` to the subject (e.g. "diet", "my job"); otherwise null.

Return an empty candidate list for pure chit-chat."""

JUDGE_SYSTEM = """You compare a NEW candidate memory against the single EXISTING memory most
similar to it, and classify their relation:

- duplicate: same meaning, no new information -> the new one should be dropped.
- update: same subject, a refined or more specific value (not a contradiction).
- supersede: same subject, the new value CONTRADICTS the old one.
- unrelated: they only look similar; actually different subjects.
- new: no meaningful relation; store the candidate fresh.

Give a one-sentence reason citing both texts."""


def extract(user_msg: str, history: list[dict]) -> tuple[Extraction, dict]:
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history[-config.HISTORY_TURNS:])
    started = time.perf_counter()
    resp = client().messages.parse(
        model=config.JUDGE_MODEL,
        max_tokens=1024,
        system=EXTRACT_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Recent conversation:\n{convo}\n\nLatest user message to analyse:\n{user_msg}",
        }],
        output_format=Extraction,
    )
    return resp.parsed_output, _meta(config.JUDGE_MODEL, resp, started)


def judge_conflict(candidate_text: str, neighbour_text: str) -> tuple[Judgment, dict]:
    started = time.perf_counter()
    resp = client().messages.parse(
        model=config.JUDGE_MODEL,
        max_tokens=512,
        system=JUDGE_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"NEW candidate:\n{candidate_text}\n\nEXISTING memory:\n{neighbour_text}",
        }],
        output_format=Judgment,
    )
    return resp.parsed_output, _meta(config.JUDGE_MODEL, resp, started)


REPLY_SYSTEM = """You are a warm, concise chat assistant with long-term memory of the user.

You are given MEMORIES retrieved about the user. Use them naturally when they are
relevant to the user's message — they are why you "remember" things. Never invent
memories you weren't given, and don't list them back mechanically. If no memory is
relevant, just answer normally. Respond directly, without preamble."""


def reply(user_msg: str, history: list[dict], memories: list[dict]) -> tuple[str, dict]:
    if memories:
        mem_block = "\n".join(f"- ({m['scope']}) {m['text']}" for m in memories)
    else:
        mem_block = "(none retrieved)"
    msgs = [{"role": m["role"], "content": m["content"]} for m in history[-config.HISTORY_TURNS:]]
    msgs.append({
        "role": "user",
        "content": f"MEMORIES about the user:\n{mem_block}\n\nUser message:\n{user_msg}",
    })
    started = time.perf_counter()
    resp = client().messages.create(
        model=config.REPLY_MODEL,
        max_tokens=1024,
        system=REPLY_SYSTEM,
        messages=msgs,
    )
    text = "".join(b.text for b in resp.content if b.type == "text")
    return text, _meta(config.REPLY_MODEL, resp, started)
