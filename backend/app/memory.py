"""The pipeline: extract -> embed -> dedup -> conflict/supersede -> write ->
retrieve -> reply. Deterministic code owns similarity, thresholds, status
transitions and decay; the LLM owns only extraction and the relation judgment.
Every stage writes a trace so any reply can be explained end to end.
"""
from __future__ import annotations

from . import config, embeddings, llm, store
from .decay import decay_score
from .models import (ChatResponse, MemoryEvent, Relation, RetrievedRef, Status)


def _active_neighbour(emb: list[float]) -> tuple[str, float] | None:
    """Nearest ACTIVE memory to an embedding, as (id, cosine)."""
    for mem_id, cos in store.knn(emb, config.TOP_K_CANDIDATES):
        row = store.get_row(mem_id)
        if row and row["status"] == Status.active.value:
            return mem_id, cos
    return None


def _handle_forget(subject: str, message_id: str) -> MemoryEvent | None:
    emb = embeddings.embed_one(subject)
    hit = _active_neighbour(emb)
    if hit and hit[1] >= config.RETRIEVE_THRESHOLD:
        store.set_status(hit[0], Status.forgotten)
        row = store.get_row(hit[0])
        return MemoryEvent(type="forgotten", memory_id=hit[0],
                           detail=f"Forgot '{row['text']}' (matched \"{subject}\", cosine={hit[1]:.2f})")
    return None


def process_turn(user_msg: str) -> ChatResponse:
    history = store.recent_messages(config.HISTORY_TURNS)   # prior turns only
    message_id = store.add_message("user", user_msg)
    events: list[MemoryEvent] = []

    # 1. EXTRACT
    extraction, ex_meta = llm.extract(user_msg, history)
    forget_resolution = None
    if extraction.forget_request:
        ev = _handle_forget(extraction.forget_request, message_id)
        if ev:
            events.append(ev)
            forget_resolution = ev.detail
    store.add_trace(message_id, "extract", {
        "candidates": [c.model_dump() for c in extraction.candidates],
        "forget_request": extraction.forget_request,
        "forget_resolution": forget_resolution,
        "llm": ex_meta,
    })

    # 2-4. EMBED -> DEDUP -> CONFLICT/SUPERSEDE for each candidate
    dropped: list[dict] = []
    resolutions: list[dict] = []
    for cand in extraction.candidates:
        emb = embeddings.embed_one(cand.text)
        hit = _active_neighbour(emb)

        if hit is None or hit[1] < config.CONFLICT_LOW:
            # no meaningful neighbour -> store fresh
            mem_id = store.add_memory(
                text=cand.text, scope=cand.scope, source_message_id=message_id,
                source_excerpt=cand.source_excerpt, reason="New fact, no similar memory.",
                confidence=cand.confidence, embedding=emb)
            events.append(MemoryEvent(type="created", memory_id=mem_id, detail=cand.text))
            resolutions.append({"candidate": cand.text, "relation": "new",
                                "neighbour": None, "cosine": hit[1] if hit else None,
                                "action": "created", "memory_id": mem_id})
            continue

        neigh_id, cos = hit
        neigh = store.get_row(neigh_id)
        judgment, j_meta = llm.judge_conflict(cand.text, neigh["text"])
        rel = judgment.relation

        if rel == Relation.duplicate:
            # same meaning, no new info -> drop and reinforce the existing memory
            store.bump_usage([neigh_id])
            events.append(MemoryEvent(type="duplicate", memory_id=neigh_id,
                                      detail=f"Duplicate of existing memory: {neigh['text']}"))
            dropped.append({"candidate": cand.text, "neighbour": neigh["text"],
                            "cosine": round(cos, 4), "reason": judgment.reason, "llm": j_meta})
            continue

        if rel in (Relation.update, Relation.supersede):
            new_status = Status.updated if rel == Relation.update else Status.superseded
            store.set_status(neigh_id, new_status)
            verb = "Refines" if rel == Relation.update else "Contradicts"
            mem_id = store.add_memory(
                text=cand.text, scope=cand.scope, source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=f"{verb} earlier memory: {judgment.reason}",
                confidence=cand.confidence, embedding=emb, supersedes_id=neigh_id)
            events.append(MemoryEvent(
                type="updated" if rel == Relation.update else "superseded",
                memory_id=mem_id, detail=f"{verb.lower()} {neigh_id[:8]}: {cand.text}"))
            resolutions.append({"candidate": cand.text, "relation": rel.value,
                                "neighbour": neigh["text"], "neighbour_id": neigh_id,
                                "cosine": round(cos, 4), "reason": judgment.reason,
                                "action": new_status.value, "memory_id": mem_id, "llm": j_meta})
            continue

        # unrelated / new despite similarity -> store fresh
        mem_id = store.add_memory(
            text=cand.text, scope=cand.scope, source_message_id=message_id,
            source_excerpt=cand.source_excerpt,
            reason=f"Distinct from similar-looking memory: {judgment.reason}",
            confidence=cand.confidence, embedding=emb)
        events.append(MemoryEvent(type="created", memory_id=mem_id, detail=cand.text))
        resolutions.append({"candidate": cand.text, "relation": rel.value,
                            "neighbour": neigh["text"], "neighbour_id": neigh_id,
                            "cosine": round(cos, 4), "reason": judgment.reason,
                            "action": "created", "memory_id": mem_id, "llm": j_meta})

    if dropped:
        store.add_trace(message_id, "dedup", {"dropped": dropped})
    if resolutions:
        store.add_trace(message_id, "conflict", {"resolutions": resolutions})

    # 5. RETRIEVE — rank active memories by cosine * decay
    q_emb = embeddings.embed_one(user_msg)
    scored = []
    for mem_id, cos in store.knn(q_emb, config.VEC_OVERFETCH):
        if cos < config.RETRIEVE_THRESHOLD:
            continue
        row = store.get_row(mem_id)
        if not row or row["status"] != Status.active.value:
            continue
        d = decay_score(row["last_used_at"], row["created_at"], row["use_count"])
        scored.append((mem_id, row, cos, d, cos * d))
    scored.sort(key=lambda x: x[4], reverse=True)
    scored = scored[:config.TOP_K_RETRIEVE]

    retrieved_refs, retrieved_for_reply, trace_rows = [], [], []
    for rank, (mem_id, row, cos, d, score) in enumerate(scored, start=1):
        retrieved_refs.append(RetrievedRef(memory_id=mem_id, text=row["text"],
                                           cosine=round(cos, 4), decay=round(d, 4),
                                           score=round(score, 4), rank=rank))
        retrieved_for_reply.append({"text": row["text"], "scope": row["scope"]})
        trace_rows.append({"memory_id": mem_id, "text": row["text"], "scope": row["scope"],
                           "cosine": round(cos, 4), "decay": round(d, 4),
                           "score": round(score, 4), "rank": rank})
    store.bump_usage([r.memory_id for r in retrieved_refs])
    store.add_trace(message_id, "retrieve", {"retrieved": trace_rows,
                                             "threshold": config.RETRIEVE_THRESHOLD})

    # 6. REPLY
    reply_text, r_meta = llm.reply(user_msg, history, retrieved_for_reply)
    store.add_message("assistant", reply_text)
    store.add_trace(message_id, "reply", {
        "used_memory_ids": [r.memory_id for r in retrieved_refs],
        "reply_preview": reply_text[:280],
        "llm": r_meta,
    })

    return ChatResponse(reply=reply_text, message_id=message_id,
                        memory_events=events, retrieved=retrieved_refs)
