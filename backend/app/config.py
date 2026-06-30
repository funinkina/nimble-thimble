"""Single source of truth for tunable knobs. Everything inspectable lives here."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# --- paths ---
DB_PATH = os.getenv(
    "DB_PATH", str(Path(__file__).resolve().parent.parent / "memory.db")
)

# --- models (Groq, via the OpenAI-compatible Chat Completions API) ---
# gpt-oss are the models that support strict json_schema structured output on Groq.
REPLY_MODEL = os.getenv("REPLY_MODEL", "openai/gpt-oss-120b")  # quality-facing replies
JUDGE_MODEL = os.getenv(
    "JUDGE_MODEL", "openai/gpt-oss-20b"
)  # cheap per-turn extraction + conflict
EMBED_MODEL = "BAAI/bge-small-en-v1.5"  # local (fastembed), no API key
EMBED_DIM = 384

# --- retrieval / dedup / conflict thresholds (cosine similarity, 0..1) ---
DEDUP_THRESHOLD = 0.88  # >= this AND llm says "same meaning" -> duplicate, drop
CONFLICT_LOW = 0.55  # [CONFLICT_LOW, DEDUP) -> ask llm: update/supersede/unrelated
RETRIEVE_THRESHOLD = 0.30  # min cosine to be eligible for retrieval
TOP_K_CANDIDATES = 5  # neighbours pulled per new candidate
TOP_K_RETRIEVE = 5  # memories injected into a reply
VEC_OVERFETCH = 25  # pull this many from vec index before status filtering
VEC_PREFETCH = 100  # raw vec rows fetched before conversation+status filtering

# --- decay (computed at retrieval, never stored stale) ---
DECAY_HALF_LIFE_DAYS = 14.0  # recency half-life
USAGE_SATURATION = 5.0  # use_count at which usage weight is ~saturated
USAGE_BASE = 0.6  # usage weight for a never-retrieved memory
DECAY_FLOOR = 0.2  # decay_score never drops below this

# --- chat context ---
HISTORY_TURNS = 8  # recent messages fed to extract() + reply()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
