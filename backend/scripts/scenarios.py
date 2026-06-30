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

    print("\n=== Scenario 2: SUPERSEDE / CONFLICT (invalidate-not-delete) ===")
    active_before = len(memories(status="active"))
    r = chat("Actually, I'm not vegetarian anymore — I started eating fish.")
    evt = {e["type"]: e for e in r["memory_events"]}
    check(
        "a supersede/update event fired",
        any(t in evt for t in ("superseded", "updated")),
        f"events={list(evt)}",
    )
    _neg = (
        "not",
        "no longer",
        "anymore",
        "stopped",
        "former",
        "used to",
        "transitioned",
        "from being",
        "switched",
        "moved on",
        "instead of",
    )
    check(
        "no active memory still positively claims 'vegetarian'",
        not any(
            "vegetarian" in t and not any(n in t for n in _neg)
            for t in active_texts()
        ),
        f"active={active_texts()}",
    )
    # Active count stays flat: supersede swaps one active for another (old ->
    # superseded, new active); an in-place update folds. Either way it must not grow.
    check(
        "active memory count did not grow",
        len(memories(status="active")) <= active_before,
        f"{active_before} -> {len(memories(status='active'))}",
    )
    # The original row carries a refined/superseded revision over its old text.
    revs = revisions(veg_id) if veg_id else []
    conflict_rev = next(
        (rv for rv in revs if rv["change_type"] in ("refined", "superseded")), None
    )
    check(
        "a refined/superseded revision was appended to the original memory",
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
            "revision records old + new confidence",
            conflict_rev["old_confidence"] is not None
            and conflict_rev["new_confidence"] is not None,
            f"{conflict_rev['old_confidence']} -> {conflict_rev['new_confidence']}",
        )
    # When the judge calls it a SUPERSEDE (expected for a contradiction), prove the
    # invalidate-not-delete machinery: old row parked at 'superseded', a NEW active
    # row created, the two linked both ways.
    if "superseded" in evt:
        check(
            "superseded event points at the original (now-invalidated) memory",
            evt["superseded"]["memory_id"] == veg_id,
            f"event_id={evt['superseded']['memory_id']} veg_id={veg_id}",
        )
        old = next(
            (m for m in memories(status="superseded") if m["id"] == veg_id), None
        )
        check("original memory is now status=superseded", old is not None)
        if old:
            new_id = old.get("superseded_by")
            check("superseded row links forward via superseded_by", bool(new_id), repr(new_id))
            successor = next(
                (m for m in memories(status="active") if m["id"] == new_id), None
            )
            check(
                "the successor is active and supersedes the original",
                successor is not None and successor.get("supersedes_id") == veg_id,
                f"successor={new_id}",
            )
        cr = next((t for t in traces(r["message_id"]) if t["stage"] == "conflict"), None)
        actions = [x.get("action") for x in (cr["payload"]["resolutions"] if cr else [])]
        check("conflict trace records a 'superseded' action", "superseded" in actions, f"{actions}")
    else:  # judge chose an in-place refine
        check(
            "updated event reuses the original canonical id (in-place fold)",
            evt["updated"]["memory_id"] == veg_id,
            f"event_id={evt['updated']['memory_id']} veg_id={veg_id}",
        )
    check(
        "conflict trace recorded",
        any(t["stage"] == "conflict" for t in traces(r["message_id"])),
    )

    print("\n=== Scenario 2b: UPDATE / REFINE (in-place fold, no tombstone) ===")
    chat("I have a dog.")
    dog = next((m for m in memories(status="active") if "dog" in m["text"].lower()), None)
    check("a 'dog' memory exists", dog is not None)
    if dog:
        dog_id = dog["id"]
        active_before = len(memories(status="active"))
        chat("My dog is a golden retriever named Max.")
        # A refine folds in place and flips the row to status='updated' (still live +
        # retrievable). It must keep its id and must NOT spawn a second row.
        still = next((m for m in memories() if m["id"] == dog_id), None)
        check(
            "refined memory keeps its id and stays live (active/updated)",
            still is not None and still["status"] in ("active", "updated"),
            f"status={still['status'] if still else None}",
        )
        check(
            "refine flipped the row to the 'updated' state (inspector shows it)",
            still is not None and still["status"] == "updated",
            f"status={still['status'] if still else None}",
        )
        check(
            "refine did not spawn a second row",
            len([m for m in memories() if m["id"] == dog_id]) == 1,
        )
        kinds = [rv["change_type"] for rv in revisions(dog_id)]
        folded = still is not None and "retriever" in (still["text"].lower() if still else "")
        check(
            "refinement folded in (a 'refined' revision or the text was updated)",
            "refined" in kinds or folded,
            f"revisions={kinds}",
        )
        # F1 guard: the 'updated' status must be retrievable, not a dead bucket.
        r_ret = chat("Tell me about my dog.")
        check(
            "an 'updated'-status memory is still retrievable in a later turn",
            any(x["memory_id"] == dog_id for x in r_ret["retrieved"]),
            f"retrieved={[x['memory_id'][:8] for x in r_ret['retrieved']]}",
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

    print("\n=== Scenario 5: NO DUPLICATION when a known fact is restated ===")
    chat("For the record, I work as a software engineer at a startup.")
    active_before = len(memories(status="active"))
    # Restate the same fact. Either the extractor suppresses it (no candidate) or
    # the dedup stage drops it — BOTH must avoid spawning a second memory. And if
    # the dedup stage does run on a >= DEDUP_THRESHOLD match, it must be
    # deterministic (no LLM judge): that's the A1 fix.
    r = chat("For the record, I work as a software engineer at a startup.")
    check(
        "restating a known fact added no new active memory",
        len(memories(status="active")) <= active_before,
        f"{active_before} -> {len(memories(status='active'))}",
    )
    dt = next((t for t in traces(r["message_id"]) if t["stage"] == "dedup"), None)
    dropped = dt["payload"]["dropped"] if dt else []
    if dropped:
        check(
            "high-cosine duplicate skipped the LLM judge (deterministic, llm=null)",
            any(d.get("llm") is None for d in dropped),
            f"llm_metas={[d.get('llm') for d in dropped]}",
        )
    else:
        check(
            "extractor suppressed the restated fact (no dedup needed)",
            not any(e["type"] == "created" for e in r["memory_events"]),
            f"events={[e['type'] for e in r['memory_events']]}",
        )

    print("\n=== Scenario 6: FORGET PRECISION (loose subject must NOT forget) ===")
    active_ids_before = {m["id"] for m in memories(status="active")}
    # Subject unrelated to anything stored: must not fall through FORGET_THRESHOLD.
    r = chat("Please forget about my favourite Pokemon.")
    check(
        "no forgotten event fired for an unrelated subject",
        not any(e["type"] == "forgotten" for e in r["memory_events"]),
        f"events={[e['type'] for e in r['memory_events']]}",
    )
    still_active = {m["id"] for m in memories(status="active")}
    check(
        "no existing memory was wrongly forgotten",
        active_ids_before <= still_active,
        f"missing={active_ids_before - still_active}",
    )

    print("\n=== Scenario 7: MANUAL EDIT via PATCH (inspector action) ===")
    target = next(iter(memories(status="active")), None)
    if target:
        new_text = target["text"].rstrip(".") + " (edited in the inspector)."
        patched = requests.patch(
            f"{BASE}/memories/{target['id']}", json={"text": new_text}, timeout=30
        ).json()
        check("PATCH returned the new text", patched.get("text") == new_text)
        kinds = [rv["change_type"] for rv in revisions(target["id"])]
        check("an 'edited' revision was appended", "edited" in kinds, f"revisions={kinds}")
        # Dedup guard: editing one memory's text to match ANOTHER active memory must
        # be rejected (409) rather than silently creating a duplicate.
        actives = memories(status="active")
        other = next((m for m in actives if m["id"] != target["id"]), None)
        if other:
            resp = requests.patch(
                f"{BASE}/memories/{target['id']}", json={"text": other["text"]}, timeout=30
            )
            check(
                "editing a memory to duplicate another is rejected (409)",
                resp.status_code == 409,
                f"status={resp.status_code}",
            )
    else:
        check("an active memory exists to edit", False)

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
