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


# All scenarios run inside a single fresh conversation (multi-chat scoping).
CONV: str = ""


def ensure_conv() -> str:
    global CONV
    if not CONV:
        r = requests.post(f"{BASE}/conversations", json={}, timeout=30)
        r.raise_for_status()
        CONV = r.json()["id"]
    return CONV


def chat(msg: str) -> dict:
    r = requests.post(
        f"{BASE}/chat",
        json={"message": msg, "conversation_id": ensure_conv()},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()


def memories(**params) -> list[dict]:
    params["conversation_id"] = ensure_conv()
    return requests.get(f"{BASE}/memories", params=params, timeout=30).json()


def traces(mid: str) -> list[dict]:
    return requests.get(f"{BASE}/traces/{mid}", timeout=30).json()


def revisions(mem_id: str) -> list[dict]:
    return requests.get(f"{BASE}/memories/{mem_id}/revisions", timeout=30).json()


def active_texts() -> list[str]:
    return [m["text"].lower() for m in memories(status="active")]


def main():
    print("\n=== Scenario 1: CREATION ===")
    r = chat("Hi! I'm Aryan and I'm a vegetarian.")
    created = [e for e in r["memory_events"] if e["type"] == "created"]
    check(
        "a memory was created",
        len(created) >= 1,
        f"events={[e['type'] for e in r['memory_events']]}",
    )
    veg = next(
        (m for m in memories(status="active") if "vegetarian" in m["text"].lower()),
        None,
    )
    check("active 'vegetarian' memory exists", veg is not None)
    if veg:
        check(
            "memory has source evidence",
            bool(veg["source_excerpt"]),
            repr(veg["source_excerpt"]),
        )
        check("memory has a stored reason", bool(veg["reason"]), repr(veg["reason"]))
        check(
            "memory has a scope",
            veg["scope"] in ("preference", "user_profile", "fact", "context"),
            veg["scope"],
        )
    veg_id = veg["id"] if veg else None
    if veg:
        check(
            "fresh memory has a single 'created' revision",
            [rv["change_type"] for rv in revisions(veg_id)] == ["created"],
        )
    st = traces(r["message_id"])
    check("extract trace recorded", any(t["stage"] == "extract" for t in st))

    print("\n=== Scenario 2: UPDATE / CONFLICT (in-place fold) ===")
    active_before = len(memories(status="active"))
    r = chat("Actually, I'm not vegetarian anymore — I started eating fish.")
    evt_types = [e["type"] for e in r["memory_events"]]
    check(
        "a supersede/update event fired",
        any(t in evt_types for t in ("superseded", "updated")),
        f"events={evt_types}",
    )
    # The fact is updated IN PLACE: same canonical id, no new row spawned.
    conflict_evt = next(
        (e for e in r["memory_events"] if e["type"] in ("superseded", "updated")), None
    )
    check(
        "conflict event reuses the same canonical memory id",
        conflict_evt is not None and conflict_evt["memory_id"] == veg_id,
        f"event_id={(conflict_evt or {}).get('memory_id')} veg_id={veg_id}",
    )
    _neg = ("not", "no longer", "anymore", "stopped", "former", "used to")
    check(
        "no active memory still positively claims 'vegetarian'",
        not any(
            "vegetarian" in t and not any(n in t for n in _neg)
            for t in active_texts()
        ),
        f"active={active_texts()}",
    )
    check(
        "active memory count did not grow (folded in place)",
        len(memories(status="active")) <= active_before,
        f"{active_before} -> {len(memories(status='active'))}",
    )
    # The timeline carries the change: a refined/superseded revision over the old text.
    revs = revisions(veg_id) if veg_id else []
    conflict_rev = next(
        (rv for rv in revs if rv["change_type"] in ("refined", "superseded")), None
    )
    check(
        "a refined/superseded revision was appended",
        conflict_rev is not None,
        f"revisions={[rv['change_type'] for rv in revs]}",
    )
    if conflict_rev:
        check(
            "revision records the prior 'vegetarian' text",
            "vegetarian" in (conflict_rev["old_text"] or "").lower(),
            repr(conflict_rev["old_text"]),
        )
        check(
            "revision moved confidence",
            conflict_rev["old_confidence"] != conflict_rev["new_confidence"],
            f"{conflict_rev['old_confidence']} -> {conflict_rev['new_confidence']}",
        )
    check(
        "conflict trace recorded",
        any(t["stage"] == "conflict" for t in traces(r["message_id"])),
    )

    print("\n=== Scenario 3: RETRIEVAL ===")
    r = chat("What should I cook for dinner tonight?")
    check(
        "at least one memory was retrieved",
        len(r["retrieved"]) >= 1,
        f"retrieved={[round(x['score'], 2) for x in r['retrieved']]}",
    )
    if r["retrieved"]:
        top = r["retrieved"][0]
        check(
            "retrieval ref carries cosine+decay+score+rank",
            all(k in top for k in ("cosine", "decay", "score", "rank")),
        )
    rt = next((t for t in traces(r["message_id"]) if t["stage"] == "retrieve"), None)
    check(
        "retrieve trace recorded with rows",
        rt is not None and len(rt["payload"]["retrieved"]) >= 1,
    )
    rep = next((t for t in traces(r["message_id"]) if t["stage"] == "reply"), None)
    check(
        "reply trace lists used memory ids",
        rep is not None and len(rep["payload"]["used_memory_ids"]) >= 1,
    )

    print("\n=== Scenario 4: FORGET / DELETE ===")
    before = len(memories(status="forgotten"))
    r = chat("Please forget everything about my diet.")
    check(
        "a forgotten event fired",
        any(e["type"] == "forgotten" for e in r["memory_events"]),
        f"events={[e['type'] for e in r['memory_events']]}",
    )
    after = memories(status="forgotten")
    check("a memory is now forgotten", len(after) > before, f"{before} -> {len(after)}")
    check("forgotten memory still visible in inspector", len(after) >= 1)
    # forgotten memory should not be retrievable anymore
    r2 = chat("Any dinner ideas based on what I eat?")
    forgotten_ids = {m["id"] for m in after}
    leaked = [x for x in r2["retrieved"] if x["memory_id"] in forgotten_ids]
    check("forgotten memory no longer retrieved", not leaked, f"leaked={leaked}")

    print("\n=== METRICS ===")
    m = requests.get(
        f"{BASE}/metrics", params={"conversation_id": ensure_conv()}, timeout=30
    ).json()
    print("  " + ", ".join(f"{k}={v}" for k, v in m.items() if not isinstance(v, dict)))
    check("metrics counted LLM calls", m["llm_calls"] > 0)

    print(
        f"\n{'=' * 40}\n{'ALL SCENARIOS PASSED' if _failures == 0 else f'{_failures} CHECK(S) FAILED'}\n{'=' * 40}"
    )
    sys.exit(1 if _failures else 0)


if __name__ == "__main__":
    main()
