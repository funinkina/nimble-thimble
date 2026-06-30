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
# bge-base-en-v1.5 (768-d) over bge-small (384-d): same BGE family so it's a drop-in
# (symmetric, no query/doc prefix needed), ~0.21 GB one-time download, materially
# stronger retrieval/dedup/conflict matching. Changing this changes EMBED_DIM, which
# is baked into the vec0 vtable — run scripts/reembed.py to migrate an existing DB.
EMBED_MODEL = os.getenv("EMBED_MODEL", "BAAI/bge-base-en-v1.5")  # local (fastembed)
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))

# --- retrieval / dedup / conflict thresholds (cosine similarity, 0..1) ---
DEDUP_THRESHOLD = 0.88  # >= this -> duplicate without an LLM call (deterministic)
CONFLICT_LOW = 0.55  # [CONFLICT_LOW, DEDUP) -> ask llm: update/supersede/unrelated
FORGET_THRESHOLD = 0.55  # min cosine for an explicit "forget X" to match a memory
RETRIEVE_THRESHOLD = 0.30  # min cosine to be eligible for retrieval
TOP_K_CANDIDATES = 5  # neighbours pulled per new candidate
TOP_K_RETRIEVE = 5  # memories injected into a reply
VEC_OVERFETCH = 25  # pull this many from vec index before status filtering
VEC_PREFETCH = 100  # raw vec rows fetched before conversation+status filtering

# --- hybrid retrieval (dense vec + BM25, fused with RRF, then reranked) ---
# Both OFF by default: on this app's short-fact corpus, scripts/eval_retrieval.py
# shows dense-only is already at ceiling — BM25 fusion REGRESSES ranking and the
# cross-encoder only claws it back to parity (no net gain). Flip these on for
# larger/noisier memory stores where hybrid+rerank is known to pay off.
USE_BM25 = os.getenv("USE_BM25", "0") != "0"  # fuse sparse keyword search via RRF
USE_RERANK = os.getenv("USE_RERANK", "0") != "0"  # cross-encoder rerank of shortlist
RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2"  # local cross-encoder (fastembed)
HYBRID_PREFETCH = 25  # candidates each of vec + bm25 contribute before fusion
RRF_K = 60  # reciprocal-rank-fusion constant (standard default)

# --- confidence accumulation (deterministic; no LLM call) ---
CONFIDENCE_STEP = 0.15  # nudge toward 1.0 on refine-agree / reinforce: c + STEP*(1-c)

# --- decay (computed at retrieval, never stored stale) ---
DECAY_HALF_LIFE_DAYS = 14.0  # recency half-life
USAGE_SATURATION = 5.0  # use_count at which usage weight is ~saturated
USAGE_BASE = 0.6  # usage weight for a never-retrieved memory
DECAY_FLOOR = 0.2  # decay_score never drops below this

# --- chat context ---
HISTORY_TURNS = 8  # recent messages fed to extract() + reply()

# --- LLM resilience (Groq strict json_schema fails ~10% under load) ---
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "30"))  # seconds per call
LLM_RETRIES = int(os.getenv("LLM_RETRIES", "2"))  # extra attempts on a bad/invalid response

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
