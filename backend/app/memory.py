"""The pipeline: extract -> embed -> dedup -> conflict/supersede -> write ->
retrieve -> reply. Deterministic code owns similarity, thresholds, status
transitions and decay; the LLM owns only extraction and the relation judgment.
Every stage writes a trace so any reply can be explained end to end.
"""

from __future__ import annotations

import math

from . import config, embeddings, llm, reranker, store
from .decay import decay_score
from .models import ChatResponse, MemoryEvent, Relation, RetrievedRef, Status


def _rrf(rank: int) -> float:
    """Reciprocal-rank-fusion contribution of a single ranked list."""
    return 1.0 / (config.RRF_K + rank)


def retrieve_memories(
    user_msg: str,
    conversation_id: str,
    *,
    use_bm25: bool = True,
    use_rerank: bool | None = None,
) -> list[dict]:
    """Hybrid retrieval: dense (vec) + sparse (BM25), fused with RRF, then an
    optional cross-encoder rerank. Returns up to TOP_K_RETRIEVE active memories
    best-first, each a dict carrying every sub-score so a reply is fully
    explainable. Flags are exposed so the eval harness can A/B the stages.
    """
    if use_rerank is None:
        use_rerank = config.USE_RERANK

    try:
        q_emb = embeddings.embed_one(user_msg)
    except Exception:  # noqa: BLE001 - retrieval is best-effort; the reply still runs
        return []
    vec_hits = store.knn(q_emb, config.HYBRID_PREFETCH, conversation_id)
    bm_hits = (
        store.bm25(user_msg, config.HYBRID_PREFETCH, conversation_id)
        if use_bm25
        else []
    )

    cand: dict[str, dict] = {}
    for rank, (mid, cos) in enumerate(vec_hits, start=1):
        if cos < config.RETRIEVE_THRESHOLD:
            continue  # dense floor: drop weak semantic matches
        cand.setdefault(mid, {}).update(cosine=cos, vec_rank=rank)
    for rank, (mid, score) in enumerate(bm_hits, start=1):
        cand.setdefault(mid, {}).update(bm25_score=round(score, 4), bm25_rank=rank)

    rows: list[tuple[str, dict]] = []
    for mid, info in cand.items():
        row = store.get_row(mid)
        if not row or row["status"] != Status.active.value:
            continue
        info["rrf_score"] = (
            _rrf(info["vec_rank"]) if "vec_rank" in info else 0.0
        ) + (_rrf(info["bm25_rank"]) if "bm25_rank" in info else 0.0)
        info["row"] = row
        rows.append((mid, info))

    if use_rerank and rows:
        scores = reranker.rerank(user_msg, [info["row"]["text"] for _, info in rows])
        for (_, info), s in zip(rows, scores):
            info["rerank_score"] = round(float(s), 4)
            info["base"] = 1.0 / (1.0 + math.exp(-float(s)))  # sigmoid -> (0,1)
    else:
        for _, info in rows:
            info["rerank_score"] = None
            info["base"] = info["rrf_score"]

    out: list[dict] = []
    for mid, info in rows:
        row = info["row"]
        d = decay_score(row["last_used_at"], row["created_at"], row["use_count"])
        out.append(
            {
                "memory_id": mid,
                "text": row["text"],
                "scope": row["scope"],
                "status": row["status"],
                "cosine": round(info.get("cosine", 0.0), 4),
                "vec_rank": info.get("vec_rank"),
                "bm25_rank": info.get("bm25_rank"),
                "rrf_score": round(info["rrf_score"], 5),
                "rerank_score": info["rerank_score"],
                "decay": round(d, 4),
                "score": round(info["base"] * d, 4),
            }
        )
    out.sort(key=lambda r: r["score"], reverse=True)
    return out[: config.TOP_K_RETRIEVE]


def _title_from(msg: str, limit: int = 48) -> str:
    t = " ".join(msg.split())
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def _nudge(c: float) -> float:
    """Move confidence toward 1.0 by a fixed fraction of the remaining gap."""
    return min(1.0, c + config.CONFIDENCE_STEP * (1.0 - c))


def _active_neighbour(
    emb: list[float], conversation_id: str, exclude_id: str | None = None
) -> tuple[str, float] | None:
    """Nearest ACTIVE memory to an embedding, as (id, cosine). Skips exclude_id."""
    for mem_id, cos in store.knn(emb, config.TOP_K_CANDIDATES, conversation_id):
        if mem_id == exclude_id:
            continue
        row = store.get_row(mem_id)
        if row and row["status"] == Status.active.value:
            return mem_id, cos
    return None


def duplicate_of(
    text: str, conversation_id: str, exclude_id: str
) -> tuple[str, float] | None:
    """Nearest active memory (other than exclude_id) at/above DEDUP_THRESHOLD, else
    None. Lets a manual inspector edit refuse to silently re-create a duplicate."""
    emb = embeddings.embed_one(text)
    hit = _active_neighbour(emb, conversation_id, exclude_id=exclude_id)
    if hit and hit[1] >= config.DEDUP_THRESHOLD:
        return hit
    return None


def _handle_forget(
    subject: str, message_id: str, conversation_id: str
) -> MemoryEvent | None:
    try:
        emb = embeddings.embed_one(subject)
    except Exception:  # noqa: BLE001 - forget is best-effort; never 500 the turn
        return None
    hit = _active_neighbour(emb, conversation_id)
    if hit and hit[1] >= config.FORGET_THRESHOLD:
        row = store.get_row(hit[0])
        store.set_status(hit[0], Status.forgotten)
        store.add_revision(
            memory_id=hit[0],
            change_type="forgotten",
            old_text=row["text"],
            new_text=row["text"],
            old_confidence=row["confidence"],
            new_confidence=row["confidence"],
            old_status=row["status"],
            new_status=Status.forgotten.value,
            source_message_id=message_id,
            reason=f"User asked to forget '{subject}'.",
            cosine=round(hit[1], 4),
        )
        return MemoryEvent(
            type="forgotten",
            memory_id=hit[0],
            detail=f"Forgot '{row['text']}' (matched \"{subject}\", cosine={hit[1]:.2f})",
        )
    return None


def process_turn(user_msg: str, conversation_id: str) -> ChatResponse:
    history = store.recent_messages(
        config.HISTORY_TURNS, conversation_id
    )  # prior turns only
    message_id = store.add_message("user", user_msg, conversation_id)
    store.touch_conversation(conversation_id)
    # First user turn in an untitled conversation gets a title from the message.
    conv = store.get_conversation(conversation_id)
    if conv and not conv["title"]:
        store.set_conversation_title(conversation_id, _title_from(user_msg))
    events: list[MemoryEvent] = []

    # 1. EXTRACT
    extraction, ex_meta = llm.extract(user_msg, history)
    forget_resolution = None
    if extraction.forget_request:
        ev = _handle_forget(extraction.forget_request, message_id, conversation_id)
        if ev:
            events.append(ev)
            forget_resolution = ev.detail
    store.add_trace(
        message_id,
        "extract",
        {
            "candidates": [c.model_dump() for c in extraction.candidates],
            "forget_request": extraction.forget_request,
            "forget_resolution": forget_resolution,
            "llm": ex_meta,
        },
        conversation_id,
    )

    # 2-4. EMBED -> DEDUP -> CONFLICT/SUPERSEDE for each candidate
    dropped: list[dict] = []
    resolutions: list[dict] = []
    for cand in extraction.candidates:
        try:
            emb = embeddings.embed_one(cand.text)
        except Exception as e:  # noqa: BLE001 - degrade like the LLM calls, never 500
            dropped.append(
                {
                    "candidate": cand.text,
                    "neighbour": None,
                    "cosine": None,
                    "reason": f"Embedding failed, candidate skipped: {e}",
                    "llm": None,
                }
            )
            continue
        hit = _active_neighbour(emb, conversation_id)

        if hit is None or hit[1] < config.CONFLICT_LOW:
            # no meaningful neighbour -> store fresh
            mem_id = store.add_memory(
                text=cand.text,
                scope=cand.scope,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason="New fact, no similar memory.",
                confidence=cand.confidence,
                embedding=emb,
                conversation_id=conversation_id,
            )
            store.add_revision(
                memory_id=mem_id,
                change_type="created",
                new_text=cand.text,
                new_confidence=cand.confidence,
                new_status=Status.active.value,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason="New fact, no similar memory.",
            )
            events.append(
                MemoryEvent(type="created", memory_id=mem_id, detail=cand.text)
            )
            resolutions.append(
                {
                    "candidate": cand.text,
                    "relation": "new",
                    "neighbour": None,
                    "cosine": round(hit[1], 4) if hit else None,
                    "action": "created",
                    "memory_id": mem_id,
                }
            )
            continue

        neigh_id, cos = hit
        neigh = store.get_row(neigh_id)

        if cos >= config.DEDUP_THRESHOLD:
            # near-identical embedding -> duplicate deterministically, no LLM call.
            # drop the candidate and reinforce the existing memory.
            reason = f"Near-identical to existing memory (cosine={cos:.2f} ≥ {config.DEDUP_THRESHOLD})."
            new_conf = _nudge(neigh["confidence"])
            store.reinforce_memory(neigh_id, new_conf)
            store.add_revision(
                memory_id=neigh_id,
                change_type="reinforced",
                old_text=neigh["text"],
                new_text=neigh["text"],
                old_confidence=neigh["confidence"],
                new_confidence=new_conf,
                old_status=neigh["status"],
                new_status=neigh["status"],
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=reason,
                cosine=round(cos, 4),
            )
            events.append(
                MemoryEvent(
                    type="duplicate",
                    memory_id=neigh_id,
                    detail=f"Duplicate of existing memory: {neigh['text']}",
                )
            )
            dropped.append(
                {
                    "candidate": cand.text,
                    "neighbour": neigh["text"],
                    "neighbour_id": neigh_id,
                    "cosine": round(cos, 4),
                    "reason": reason,
                    "llm": None,  # deterministic, no judge call
                }
            )
            continue

        # ambiguous band [CONFLICT_LOW, DEDUP_THRESHOLD) -> let the LLM judge.
        judgment, j_meta = llm.judge_conflict(cand.text, neigh["text"])
        rel = judgment.relation

        if rel == Relation.duplicate:
            # LLM says same meaning despite sub-threshold cosine -> reinforce.
            new_conf = _nudge(neigh["confidence"])
            store.reinforce_memory(neigh_id, new_conf)
            store.add_revision(
                memory_id=neigh_id,
                change_type="reinforced",
                old_text=neigh["text"],
                new_text=neigh["text"],
                old_confidence=neigh["confidence"],
                new_confidence=new_conf,
                old_status=neigh["status"],
                new_status=neigh["status"],
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=judgment.reason,
                cosine=round(cos, 4),
            )
            events.append(
                MemoryEvent(
                    type="duplicate",
                    memory_id=neigh_id,
                    detail=f"Duplicate of existing memory: {neigh['text']}",
                )
            )
            dropped.append(
                {
                    "candidate": cand.text,
                    "neighbour": neigh["text"],
                    "neighbour_id": neigh_id,
                    "cosine": round(cos, 4),
                    "reason": judgment.reason,
                    "llm": j_meta,
                }
            )
            continue

        if rel == Relation.update:
            # Refine: same subject, sharper value. Fold into the SAME canonical row
            # in place, append a revision, carry decay strength forward. Stable id —
            # a refined fact is still the current fact, so the row stays active.
            new_conf = _nudge(max(neigh["confidence"], cand.confidence))
            store.revise_memory(
                neigh_id,
                text=cand.text,
                embedding=emb,
                confidence=new_conf,
                status=Status.active,
                bump=True,
            )
            store.add_revision(
                memory_id=neigh_id,
                change_type="refined",
                old_text=neigh["text"],
                new_text=cand.text,
                old_confidence=neigh["confidence"],
                new_confidence=new_conf,
                old_status=neigh["status"],
                new_status=Status.active.value,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=f"Refines earlier memory: {judgment.reason}",
                cosine=round(cos, 4),
            )
            events.append(
                MemoryEvent(
                    type="updated",
                    memory_id=neigh_id,
                    detail=f"refines {neigh_id[:8]}: {cand.text}",
                )
            )
            resolutions.append(
                {
                    "candidate": cand.text,
                    "relation": rel.value,
                    "neighbour": neigh["text"],
                    "neighbour_id": neigh_id,
                    "cosine": round(cos, 4),
                    "reason": judgment.reason,
                    "action": "updated",
                    "memory_id": neigh_id,
                    "llm": j_meta,
                }
            )
            continue

        if rel == Relation.supersede:
            # Contradiction: the old fact is now false. Invalidate-not-delete — mark
            # the old row `superseded`, write a NEW active row linked back via
            # supersedes_id. Both stay inspectable; only the new one is retrievable.
            # (Bi-temporal model, à la Zep/Graphiti: superseded facts are invalidated,
            # not discarded, so the inspector can show what changed and when.)
            store.set_status(neigh_id, Status.superseded)
            store.add_revision(
                memory_id=neigh_id,
                change_type="superseded",
                old_text=neigh["text"],
                new_text=cand.text,
                old_confidence=neigh["confidence"],
                new_confidence=neigh["confidence"],
                old_status=neigh["status"],
                new_status=Status.superseded.value,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=f"Contradicted by newer fact: {judgment.reason}",
                cosine=round(cos, 4),
            )
            new_id = store.add_memory(
                text=cand.text,
                scope=cand.scope,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=f"Supersedes {neigh_id[:8]}: {judgment.reason}",
                confidence=cand.confidence,
                embedding=emb,
                conversation_id=conversation_id,
                supersedes_id=neigh_id,
            )
            store.add_revision(
                memory_id=new_id,
                change_type="created",
                new_text=cand.text,
                new_confidence=cand.confidence,
                new_status=Status.active.value,
                source_message_id=message_id,
                source_excerpt=cand.source_excerpt,
                reason=f"Supersedes earlier memory {neigh_id[:8]}: {judgment.reason}",
                cosine=round(cos, 4),
            )
            events.append(
                MemoryEvent(
                    type="superseded",
                    memory_id=neigh_id,  # point at the now-faded old card
                    detail=f"superseded by: {cand.text}",
                )
            )
            events.append(
                MemoryEvent(type="created", memory_id=new_id, detail=cand.text)
            )
            resolutions.append(
                {
                    "candidate": cand.text,
                    "relation": rel.value,
                    "neighbour": neigh["text"],
                    "neighbour_id": neigh_id,
                    "cosine": round(cos, 4),
                    "reason": judgment.reason,
                    "action": "superseded",
                    "memory_id": new_id,
                    "supersedes_id": neigh_id,
                    "llm": j_meta,
                }
            )
            continue

        # unrelated / new despite similarity -> store fresh
        mem_id = store.add_memory(
            text=cand.text,
            scope=cand.scope,
            source_message_id=message_id,
            source_excerpt=cand.source_excerpt,
            reason=f"Distinct from similar-looking memory: {judgment.reason}",
            confidence=cand.confidence,
            embedding=emb,
            conversation_id=conversation_id,
        )
        store.add_revision(
            memory_id=mem_id,
            change_type="created",
            new_text=cand.text,
            new_confidence=cand.confidence,
            new_status=Status.active.value,
            source_message_id=message_id,
            source_excerpt=cand.source_excerpt,
            reason=f"Distinct from similar-looking memory: {judgment.reason}",
            cosine=round(cos, 4),
        )
        events.append(MemoryEvent(type="created", memory_id=mem_id, detail=cand.text))
        resolutions.append(
            {
                "candidate": cand.text,
                "relation": rel.value,
                "neighbour": neigh["text"],
                "neighbour_id": neigh_id,
                "cosine": round(cos, 4),
                "reason": judgment.reason,
                "action": "created",
                "memory_id": mem_id,
                "llm": j_meta,
            }
        )

    if dropped:
        store.add_trace(message_id, "dedup", {"dropped": dropped}, conversation_id)
    if resolutions:
        store.add_trace(
            message_id, "conflict", {"resolutions": resolutions}, conversation_id
        )

    # 5. RETRIEVE — dense by default; BM25 fusion + rerank are config-gated
    hits = retrieve_memories(user_msg, conversation_id, use_bm25=config.USE_BM25)
    retrieved_refs, retrieved_for_reply, trace_rows = [], [], []
    for rank, h in enumerate(hits, start=1):
        retrieved_refs.append(
            RetrievedRef(
                memory_id=h["memory_id"],
                text=h["text"],
                cosine=h["cosine"],
                decay=h["decay"],
                score=h["score"],
                rank=rank,
            )
        )
        retrieved_for_reply.append({"text": h["text"], "scope": h["scope"]})
        trace_rows.append({**h, "rank": rank})
    store.bump_usage([r.memory_id for r in retrieved_refs])
    store.add_trace(
        message_id,
        "retrieve",
        {
            "retrieved": trace_rows,
            "threshold": config.RETRIEVE_THRESHOLD,
            "hybrid": config.USE_BM25,
            "reranked": config.USE_RERANK,
        },
        conversation_id,
    )

    # 6. REPLY
    reply_text, r_meta = llm.reply(user_msg, history, retrieved_for_reply)
    store.add_message("assistant", reply_text, conversation_id)
    store.add_trace(
        message_id,
        "reply",
        {
            "used_memory_ids": [r.memory_id for r in retrieved_refs],
            "reply_preview": reply_text[:280],
            "llm": r_meta,
        },
        conversation_id,
    )

    return ChatResponse(
        reply=reply_text,
        message_id=message_id,
        memory_events=events,
        retrieved=retrieved_refs,
    )
