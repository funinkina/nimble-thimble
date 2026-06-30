"""Measure the retrieval upgrade. Seeds a fixed memory set, runs a labelled query
set through three configurations, and reports Recall@5 + MRR for each:

    vec-only        dense embeddings only (the original behaviour)
    hybrid          dense + BM25, fused with RRF
    hybrid+rerank   the above, then a cross-encoder rerank (shipped default)

No LLM and no HTTP server: this exercises `memory.retrieve_memories` directly
against a throwaway DB, so it's deterministic and fast. Run:

    cd backend && uv run python scripts/eval_retrieval.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

# Point the app at a throwaway DB BEFORE importing it (config reads env at import).
_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP.close()
os.environ["DB_PATH"] = _TMP.name

from app import memory, store  # noqa: E402

CONV = "eval"

# (memory text, scope). Several CONFUSABLE pairs share a keyword or name but
# differ in meaning — the case where a bi-encoder alone tends to misrank.
MEMORIES = [
    ("The user is a vegetarian.", "preference"),
    ("The user's favourite programming language is Rust.", "preference"),
    ("The user is currently learning Go for a work project.", "context"),
    ("The user works as a backend engineer at a fintech startup.", "user_profile"),
    ("The user has a dog named Pixel.", "fact"),
    ("The user's phone is a Google Pixel 8 Pro.", "fact"),
    ("The user lives in Bangalore.", "user_profile"),
    ("The user grew up in Jaipur.", "fact"),
    ("The user is allergic to peanuts.", "fact"),
    ("The user loves peanut butter cookies.", "preference"),
    ("The user's sister is named Priya.", "fact"),
    ("The user's manager is named Priya.", "fact"),
    ("The user is training for a half marathon in October.", "context"),
    ("The user drives a blue Tata Nexon EV.", "fact"),
    ("The user prefers dark mode in every app.", "preference"),
    ("The user's partner is allergic to cats.", "fact"),
    ("The user quit drinking coffee last month.", "context"),
    ("The user buys oat milk every week.", "preference"),
    ("The user broke their right wrist skiing in February.", "fact"),
    ("The user plays the electric guitar on weekends.", "preference"),
    ("The user's gym locker number is 314.", "fact"),
    ("The user's apartment number is 27.", "fact"),
    ("The user's employee badge ID is BG-4471.", "fact"),
]

# (query, set of memory texts that SHOULD be top-ranked). Each targets the right
# member of a confusable pair, so getting it #1 needs more than dense similarity.
CASES = [
    ("What should I cook for dinner?", {"The user is a vegetarian."}),
    (
        "Which language am I learning for my job right now?",
        {"The user is currently learning Go for a work project."},
    ),
    ("What's my dog's name?", {"The user has a dog named Pixel."}),
    ("What phone do I use?", {"The user's phone is a Google Pixel 8 Pro."}),
    ("What food allergy do I have?", {"The user is allergic to peanuts."}),
    ("What's my sister's name?", {"The user's sister is named Priya."}),
    ("Who is my manager?", {"The user's manager is named Priya."}),
    ("Which city did I grow up in?", {"The user grew up in Jaipur."}),
    ("How far is my race?", {"The user is training for a half marathon in October."}),
    # harder: an intent-sensitive query where a distractor is more central
    ("Is it safe for me to eat a PB&J sandwich?", {"The user is allergic to peanuts."}),
    ("Can you make me an espresso?", {"The user quit drinking coffee last month."}),
    (
        "Should I book a window seat or an aisle so I can rest my arm?",
        {"The user broke their right wrist skiing in February."},
    ),
    # lexical discriminators: near-identical memories separated by one keyword
    ("Which locker is mine?", {"The user's gym locker number is 314."}),
    ("What's my badge ID?", {"The user's employee badge ID is BG-4471."}),
]

CONFIGS = {
    "vec-only": dict(use_bm25=False, use_rerank=False),
    "vec+rerank": dict(use_bm25=False, use_rerank=True),
    "hybrid": dict(use_bm25=True, use_rerank=False),
    "hybrid+rerank": dict(use_bm25=True, use_rerank=True),
}


# Filler distractors: a realistic store holds many memories, so the target often
# falls OUTSIDE dense's top-k prefetch. That's where BM25 keyword-recall + rerank
# earn their keep. Generated, not hand-picked, so the benchmark isn't rigged.
_TOPICS = [
    "enjoys the {} cuisine",
    "visited {} last summer",
    "is reading a book about {}",
    "subscribes to a {} newsletter",
    "owns a {} mug",
    "watched a documentary on {}",
    "has a playlist named {}",
    "bookmarked an article about {}",
]
_WORDS = [
    "Thai", "Peru", "astronomy", "pottery", "vintage", "glaciers", "midnight",
    "origami", "Lisbon", "ceramics", "cycling", "jazz", "tofu", "Kyoto",
    "lighthouse", "ferns", "denim", "cartography", "Oslo", "beekeeping",
]


def _filler() -> list[tuple[str, str]]:
    out = []
    for i, w in enumerate(_WORDS):
        tmpl = _TOPICS[i % len(_TOPICS)]
        out.append((f"The user {tmpl.format(w)}.", "context"))
    return out


def seed():
    from app import embeddings

    rows = MEMORIES + _filler()
    for text, scope in rows:
        store.add_memory(
            text=text,
            scope=scope,
            source_message_id="seed",
            source_excerpt=text,
            reason="eval seed",
            confidence=0.9,
            embedding=embeddings.embed_one(text),
            conversation_id=CONV,
        )
    return len(rows)


RECALL_AT = 3  # tighter than top-5 so ranking quality actually shows


def evaluate(flags) -> tuple[float, float]:
    recall_hits, rr_sum = 0, 0.0
    for query, expected in CASES:
        hits = memory.retrieve_memories(query, CONV, **flags)
        texts = [h["text"] for h in hits]
        if expected & set(texts[:RECALL_AT]):
            recall_hits += 1
        rank = next((i for i, t in enumerate(texts, 1) if t in expected), 0)
        rr_sum += 1.0 / rank if rank else 0.0
    n = len(CASES)
    return recall_hits / n, rr_sum / n


def main():
    # No conversations row needed: knn/bm25 filter on memories.conversation_id only.
    n_mem = seed()
    print(f"\nRetrieval eval — {n_mem} memories, {len(CASES)} queries\n")
    print(f"  {'config':<16}{f'Recall@{RECALL_AT}':>10}{'MRR':>8}")
    print("  " + "-" * 32)
    for name, flags in CONFIGS.items():
        recall, mrr = evaluate(flags)
        print(f"  {name:<16}{recall:>10.3f}{mrr:>8.3f}")
    print()
    os.unlink(_TMP.name)


if __name__ == "__main__":
    main()
