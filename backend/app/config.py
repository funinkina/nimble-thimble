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
# >= this -> duplicate without an LLM call (deterministic). Set at 0.92, not 0.88:
# a refinement that adds specifics ("has a dog" -> "has a golden retriever named
# Max") measures ~0.89 cosine — high topic overlap but genuinely new info — and must
# reach the judge to be folded as an `update`, not auto-dropped as a duplicate. True
# restatements sit at 0.99-1.0, so they still dedup deterministically below the gate.
DEDUP_THRESHOLD = 0.90
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
# Reply cap. 1024 truncated longer answers mid-sentence ("response cuts off"); 2048
# clears typical replies. finish_reason=="length" still lands in the trace when hit.
REPLY_MAX_TOKENS = int(os.getenv("REPLY_MAX_TOKENS", "2048"))

# --- LLM resilience (Groq strict json_schema fails ~10% under load) ---
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "30"))  # seconds per call
LLM_RETRIES = int(
    os.getenv("LLM_RETRIES", "2")
)  # extra attempts on a bad/invalid response

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

# --- server ---
# Comma-separated allowed browser origins for CORS. Override per-deployment.
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if o.strip()
]


# --- runtime-editable settings registry (drives GET/PATCH /settings + the UI) ---
# ONLY knobs read fresh on each call belong here — no embed model/dim (baked into
# the vec vtable), no rerank model (loads once), no client-cached LLM_TIMEOUT, no
# secrets. Each entry carries the bounds the API validates against and the metadata
# the frontend renders. `min`/`max`/`step` apply to number types only.
SETTINGS_SPEC: list[dict] = [
    # Retrieval
    {"key": "RETRIEVE_THRESHOLD", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Retrieval", "label": "Retrieve threshold", "help": "Min cosine for a memory to be eligible for retrieval."},
    {"key": "TOP_K_RETRIEVE", "type": "int", "min": 1, "max": 20, "step": 1, "group": "Retrieval", "label": "Top-K retrieved", "help": "Memories injected into a reply."},
    {"key": "VEC_OVERFETCH", "type": "int", "min": 1, "max": 200, "step": 1, "group": "Retrieval", "label": "Vec overfetch", "help": "Rows pulled from the vec index before status filtering."},
    {"key": "VEC_PREFETCH", "type": "int", "min": 1, "max": 500, "step": 1, "group": "Retrieval", "label": "Vec prefetch", "help": "Raw vec rows fetched before conversation + status filtering."},
    # Dedup & conflict
    {"key": "DEDUP_THRESHOLD", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Dedup & conflict", "label": "Dedup threshold", "help": "At/above this cosine a candidate is a duplicate — no LLM call."},
    {"key": "CONFLICT_LOW", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Dedup & conflict", "label": "Conflict floor", "help": "Below this, a neighbour is unrelated; above (and below dedup) the LLM judges."},
    {"key": "FORGET_THRESHOLD", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Dedup & conflict", "label": "Forget match threshold", "help": "Min cosine for an explicit 'forget X' to match a memory."},
    {"key": "TOP_K_CANDIDATES", "type": "int", "min": 1, "max": 20, "step": 1, "group": "Dedup & conflict", "label": "Top-K neighbours", "help": "Neighbours pulled per new candidate."},
    {"key": "CONFIDENCE_STEP", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Dedup & conflict", "label": "Confidence step", "help": "Nudge toward 1.0 on reinforce: c + step*(1-c)."},
    # Decay
    {"key": "DECAY_HALF_LIFE_DAYS", "type": "float", "min": 0.1, "max": 365.0, "step": 0.5, "group": "Decay", "label": "Recency half-life (days)", "help": "Days for recency weight to halve."},
    {"key": "USAGE_SATURATION", "type": "float", "min": 0.1, "max": 100.0, "step": 0.5, "group": "Decay", "label": "Usage saturation", "help": "use_count at which usage weight is ~saturated."},
    {"key": "USAGE_BASE", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Decay", "label": "Usage base", "help": "Usage weight for a never-retrieved memory."},
    {"key": "DECAY_FLOOR", "type": "float", "min": 0.0, "max": 1.0, "step": 0.01, "group": "Decay", "label": "Decay floor", "help": "decay_score never drops below this."},
    # Chat
    {"key": "HISTORY_TURNS", "type": "int", "min": 1, "max": 50, "step": 1, "group": "Chat", "label": "History turns", "help": "Recent messages fed to extract() + reply()."},
    {"key": "REPLY_MAX_TOKENS", "type": "int", "min": 256, "max": 8192, "step": 64, "group": "Chat", "label": "Reply max tokens", "help": "Cap on reply length."},
    {"key": "LLM_RETRIES", "type": "int", "min": 0, "max": 5, "step": 1, "group": "Chat", "label": "LLM retries", "help": "Extra attempts on a bad/invalid structured response."},
    # Hybrid retrieval
    {"key": "USE_BM25", "type": "bool", "group": "Hybrid retrieval", "label": "Fuse BM25 (RRF)", "help": "Add sparse keyword search, fused with dense via RRF."},
    {"key": "USE_RERANK", "type": "bool", "group": "Hybrid retrieval", "label": "Cross-encoder rerank", "help": "Rerank the shortlist with a local cross-encoder."},
    {"key": "HYBRID_PREFETCH", "type": "int", "min": 1, "max": 200, "step": 1, "group": "Hybrid retrieval", "label": "Hybrid prefetch", "help": "Candidates each of vec + bm25 contribute before fusion."},
    {"key": "RRF_K", "type": "int", "min": 1, "max": 200, "step": 1, "group": "Hybrid retrieval", "label": "RRF constant", "help": "Reciprocal-rank-fusion constant."},
]

EDITABLE_KEYS = [s["key"] for s in SETTINGS_SPEC]
# Snapshot the code defaults NOW, before any DB override is applied at startup, so
# "reset to defaults" restores the .env/literal values, not the last saved ones.
SETTINGS_DEFAULTS = {k: globals()[k] for k in EDITABLE_KEYS}

# Read-only context shown in the panel — not editable (would require a rebuild).
INFO_FIELDS = [
    {"key": "REPLY_MODEL", "label": "Reply model", "value": REPLY_MODEL},
    {"key": "JUDGE_MODEL", "label": "Extract/judge model", "value": JUDGE_MODEL},
    {"key": "EMBED_MODEL", "label": "Embedding model", "value": EMBED_MODEL},
    {"key": "EMBED_DIM", "label": "Embedding dimensions", "value": EMBED_DIM},
]
