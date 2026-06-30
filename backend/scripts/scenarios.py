"""End-to-end proof of the four required memory behaviours, driven through the
live HTTP API. Run against a FRESH database:

    DB_PATH=./scenarios.db uv run uvicorn app.main:app --port 8000   # terminal 1
    rm -f scenarios.db                                               # ensure clean
    uv run python scripts/scenarios.py                               # terminal 2

Assertions are structural (events, statuses, supersedes links, retrieval, trace
stages) so they're robust to normal LLM phrasing variance.
"""
from __future__ import annotations

import os
import sys

import requests

BASE = os.getenv("API_BASE", "http://localhost:8000")
PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
_failures = 0


def check(name: str, ok: bool, detail: str = ""):
    global _failures
    print(f"  [{PASS if ok else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        _failures += 1


def chat(msg: str) -> dict:
    r = requests.post(f"{BASE}/chat", json={"message": msg}, timeout=120)
    r.raise_for_status()
    return r.json()


def memories(**params) -> list[dict]:
    return requests.get(f"{BASE}/memories", params=params, timeout=30).json()


def traces(mid: str) -> list[dict]:
    return requests.get(f"{BASE}/traces/{mid}", timeout=30).json()


def active_texts() -> list[str]:
    return [m["text"].lower() for m in memories(status="active")]


def main():
    print("\n=== Scenario 1: CREATION ===")
    r = chat("Hi! I'm Aryan and I'm a vegetarian.")
    created = [e for e in r["memory_events"] if e["type"] == "created"]
    check("a memory was created", len(created) >= 1, f"events={[e['type'] for e in r['memory_events']]}")
    veg = next((m for m in memories(status="active") if "vegetarian" in m["text"].lower()), None)
    check("active 'vegetarian' memory exists", veg is not None)
    if veg:
        check("memory has source evidence", bool(veg["source_excerpt"]), repr(veg["source_excerpt"]))
        check("memory has a stored reason", bool(veg["reason"]), repr(veg["reason"]))
        check("memory has a scope", veg["scope"] in ("preference", "user_profile", "fact", "context"), veg["scope"])
    st = traces(r["message_id"])
    check("extract trace recorded", any(t["stage"] == "extract" for t in st))

    print("\n=== Scenario 2: UPDATE / CONFLICT ===")
    r = chat("Actually, I'm not vegetarian anymore — I started eating fish.")
    evt_types = [e["type"] for e in r["memory_events"]]
    check("a supersede/update event fired", any(t in evt_types for t in ("superseded", "updated")),
          f"events={evt_types}")
    check("no active memory still says plain 'vegetarian'",
          not any("vegetarian" in t and "not" not in t for t in active_texts()),
          f"active={active_texts()}")
    old = [m for m in memories() if m["status"] in ("superseded", "updated")]
    check("old memory flipped to superseded/updated", len(old) >= 1)
    new_active = next((m for m in memories(status="active") if m["supersedes_id"]), None)
    check("new active memory links back via supersedes_id", new_active is not None,
          (new_active or {}).get("text", ""))
    if old:
        check("superseded card exposes its successor", bool(old[0].get("superseded_by")))
    check("conflict trace recorded", any(t["stage"] == "conflict" for t in traces(r["message_id"])))

    print("\n=== Scenario 3: RETRIEVAL ===")
    r = chat("What should I cook for dinner tonight?")
    check("at least one memory was retrieved", len(r["retrieved"]) >= 1,
          f"retrieved={[round(x['score'],2) for x in r['retrieved']]}")
    if r["retrieved"]:
        top = r["retrieved"][0]
        check("retrieval ref carries cosine+decay+score+rank",
              all(k in top for k in ("cosine", "decay", "score", "rank")))
    rt = next((t for t in traces(r["message_id"]) if t["stage"] == "retrieve"), None)
    check("retrieve trace recorded with rows", rt is not None and len(rt["payload"]["retrieved"]) >= 1)
    rep = next((t for t in traces(r["message_id"]) if t["stage"] == "reply"), None)
    check("reply trace lists used memory ids", rep is not None and len(rep["payload"]["used_memory_ids"]) >= 1)

    print("\n=== Scenario 4: FORGET / DELETE ===")
    before = len(memories(status="forgotten"))
    r = chat("Please forget everything about my diet.")
    check("a forgotten event fired", any(e["type"] == "forgotten" for e in r["memory_events"]),
          f"events={[e['type'] for e in r['memory_events']]}")
    after = memories(status="forgotten")
    check("a memory is now forgotten", len(after) > before, f"{before} -> {len(after)}")
    check("forgotten memory still visible in inspector", len(after) >= 1)
    # forgotten memory should not be retrievable anymore
    r2 = chat("Any dinner ideas based on what I eat?")
    forgotten_ids = {m["id"] for m in after}
    leaked = [x for x in r2["retrieved"] if x["memory_id"] in forgotten_ids]
    check("forgotten memory no longer retrieved", not leaked, f"leaked={leaked}")

    print("\n=== METRICS ===")
    m = requests.get(f"{BASE}/metrics", timeout=30).json()
    print("  " + ", ".join(f"{k}={v}" for k, v in m.items() if not isinstance(v, dict)))
    check("metrics counted LLM calls", m["llm_calls"] > 0)

    print(f"\n{'='*40}\n{'ALL SCENARIOS PASSED' if _failures == 0 else f'{_failures} CHECK(S) FAILED'}\n{'='*40}")
    sys.exit(1 if _failures else 0)


if __name__ == "__main__":
    main()
