"""Persistence helpers. memory.py stays focused on pipeline logic; all SQL +
vec index bookkeeping lives here. Rows are turned into MemoryOut with decay
computed at read time.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import sqlite_vec

from . import db, decay
from .models import (
    LIVE_STATUS_VALUES,
    MemoryOut,
    MemoryRevisionOut,
    Scope,
    Status,
    TraceOut,
)


def _loads(payload) -> dict:
    """Trace payloads are ones we wrote via json.dumps, but a truncated/corrupt row
    shouldn't 500 a whole endpoint. Return {} on any decode failure."""
    try:
        v = json.loads(payload)
        return v if isinstance(v, dict) else {}
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _id() -> str:
    return uuid.uuid4().hex


# ---- conversations ----
def create_conversation(title: str = "") -> dict:
    cid = _id()
    ts = now_iso()
    db.write(
        lambda c: c.execute(
            "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (cid, title, ts, ts),
        )
    )
    return {"id": cid, "title": title, "created_at": ts, "updated_at": ts}


def list_conversations() -> list[dict]:
    # Creation order (oldest first) so a new chat appends at the bottom of the
    # sidebar and its position number is the next in sequence.
    rows = db.query(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY created_at ASC, rowid ASC"
    )
    return [dict(r) for r in rows]


def get_conversation(cid: str) -> dict | None:
    r = db.query_one(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id=?", (cid,)
    )
    return dict(r) if r else None


def set_conversation_title(cid: str, title: str) -> None:
    db.write(
        lambda c: c.execute(
            "UPDATE conversations SET title=?, updated_at=? WHERE id=?",
            (title, now_iso(), cid),
        )
    )


def touch_conversation(cid: str) -> None:
    db.write(
        lambda c: c.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now_iso(), cid))
    )


def delete_conversation(cid: str) -> None:
    def _do(c):
        c.execute(
            "DELETE FROM vec_memories WHERE memory_id IN "
            "(SELECT id FROM memories WHERE conversation_id=?)",
            (cid,),
        )
        c.execute(
            "DELETE FROM memory_revisions WHERE memory_id IN "
            "(SELECT id FROM memories WHERE conversation_id=?)",
            (cid,),
        )
        c.execute(
            "DELETE FROM memories_fts WHERE memory_id IN "
            "(SELECT id FROM memories WHERE conversation_id=?)",
            (cid,),
        )
        c.execute("DELETE FROM memories WHERE conversation_id=?", (cid,))
        c.execute("DELETE FROM traces WHERE conversation_id=?", (cid,))
        c.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
        c.execute("DELETE FROM conversations WHERE id=?", (cid,))

    db.write(_do)


# ---- messages ----
def add_message(role: str, content: str, conversation_id: str) -> str:
    mid = _id()
    ts = now_iso()
    db.write(
        lambda c: c.execute(
            "INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)",
            (mid, conversation_id, role, content, ts),
        )
    )
    return mid


def recent_messages(limit: int, conversation_id: str) -> list[dict]:
    rows = db.query(
        "SELECT role, content FROM messages WHERE conversation_id=? "
        "ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (conversation_id, limit),
    )
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def messages_for(conversation_id: str, limit: int = 1000, offset: int = 0) -> list[dict]:
    """Ordered history for one conversation, for restore on the client. Bounded so a
    pathologically long thread can't force the whole transcript into memory at once."""
    rows = db.query(
        "SELECT id, role, content FROM messages WHERE conversation_id=? "
        "ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?",
        (conversation_id, limit, offset),
    )
    return [dict(r) for r in rows]


def count_user_messages(conversation_id: str) -> int:
    r = db.query_one(
        "SELECT COUNT(*) AS n FROM messages WHERE role='user' AND conversation_id=?",
        (conversation_id,),
    )
    return r["n"] if r else 0


# ---- memories ----
def add_memory(
    *,
    text: str,
    scope: Scope,
    source_message_id: str,
    source_excerpt: str,
    reason: str,
    confidence: float,
    embedding: list[float],
    conversation_id: str,
    supersedes_id: str | None = None,
) -> str:
    mem_id = _id()
    ts = now_iso()
    blob = sqlite_vec.serialize_float32(embedding)

    def _do(c):
        c.execute(
            """INSERT INTO memories(id, conversation_id, text, scope, status, source_message_id,
                   source_excerpt, reason, confidence, supersedes_id, use_count, last_used_at,
                   created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                mem_id,
                conversation_id,
                text,
                scope.value if isinstance(scope, Scope) else scope,
                Status.active.value,
                source_message_id,
                source_excerpt,
                reason,
                confidence,
                supersedes_id,
                0,
                None,
                ts,
                ts,
            ),
        )
        c.execute(
            "INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)",
            (mem_id, blob),
        )
        c.execute("INSERT INTO memories_fts(memory_id, text) VALUES (?, ?)", (mem_id, text))

    db.write(_do)
    return mem_id


def set_status(mem_id: str, status: Status) -> None:
    db.write(
        lambda c: c.execute(
            "UPDATE memories SET status=?, updated_at=? WHERE id=?",
            (status.value, now_iso(), mem_id),
        )
    )


def set_pinned(mem_id: str, pinned: bool) -> None:
    db.write(
        lambda c: c.execute(
            "UPDATE memories SET pinned=?, updated_at=? WHERE id=?",
            (1 if pinned else 0, now_iso(), mem_id),
        )
    )


def bump_usage(mem_ids: list[str]) -> None:
    if not mem_ids:
        return
    ts = now_iso()

    def _do(c):
        for mid in mem_ids:
            c.execute(
                "UPDATE memories SET use_count = use_count + 1, last_used_at=? WHERE id=?",
                (ts, mid),
            )

    db.write(_do)


def update_text(mem_id: str, text: str, embedding: list[float]) -> None:
    blob = sqlite_vec.serialize_float32(embedding)

    def _do(c):
        c.execute(
            "UPDATE memories SET text=?, updated_at=? WHERE id=?",
            (text, now_iso(), mem_id),
        )
        c.execute("DELETE FROM vec_memories WHERE memory_id=?", (mem_id,))
        c.execute(
            "INSERT INTO vec_memories(memory_id, embedding) VALUES (?,?)",
            (mem_id, blob),
        )
        c.execute("DELETE FROM memories_fts WHERE memory_id=?", (mem_id,))
        c.execute("INSERT INTO memories_fts(memory_id, text) VALUES (?,?)", (mem_id, text))

    db.write(_do)


def revise_memory(
    mem_id: str,
    *,
    text: str,
    embedding: list[float],
    confidence: float,
    status: Status = Status.active,
    bump: bool = True,
) -> None:
    """In-place update of a canonical memory: new text + re-embed + new confidence,
    carrying use_count/last_used_at forward (decay strength survives refinement).
    Replaces the vec row so KNN stays consistent."""
    blob = sqlite_vec.serialize_float32(embedding)
    ts = now_iso()

    def _do(c):
        if bump:
            c.execute(
                "UPDATE memories SET text=?, confidence=?, status=?, "
                "use_count=use_count+1, last_used_at=?, updated_at=? WHERE id=?",
                (text, confidence, status.value, ts, ts, mem_id),
            )
        else:
            c.execute(
                "UPDATE memories SET text=?, confidence=?, status=?, updated_at=? WHERE id=?",
                (text, confidence, status.value, ts, mem_id),
            )
        c.execute("DELETE FROM vec_memories WHERE memory_id=?", (mem_id,))
        c.execute(
            "INSERT INTO vec_memories(memory_id, embedding) VALUES (?,?)",
            (mem_id, blob),
        )
        c.execute("DELETE FROM memories_fts WHERE memory_id=?", (mem_id,))
        c.execute("INSERT INTO memories_fts(memory_id, text) VALUES (?,?)", (mem_id, text))

    db.write(_do)


def reinforce_memory(mem_id: str, confidence: float) -> None:
    """Duplicate reinforcement: bump usage + nudge confidence, text unchanged."""
    ts = now_iso()
    db.write(
        lambda c: c.execute(
            "UPDATE memories SET use_count=use_count+1, last_used_at=?, "
            "confidence=?, updated_at=? WHERE id=?",
            (ts, confidence, ts, mem_id),
        )
    )


def add_revision(
    *,
    memory_id: str,
    change_type: str,
    old_text: str | None = None,
    new_text: str | None = None,
    old_confidence: float | None = None,
    new_confidence: float | None = None,
    old_status: str | None = None,
    new_status: str | None = None,
    source_message_id: str | None = None,
    source_excerpt: str | None = None,
    reason: str | None = None,
    cosine: float | None = None,
) -> str:
    rev_id = _id()
    ts = now_iso()

    def _do(c):
        row = c.execute(
            "SELECT COALESCE(MAX(revision_index), -1) AS m FROM memory_revisions WHERE memory_id=?",
            (memory_id,),
        ).fetchone()
        idx = row["m"] + 1
        c.execute(
            "INSERT INTO memory_revisions(id, memory_id, revision_index, change_type, "
            "old_text, new_text, old_confidence, new_confidence, old_status, new_status, "
            "source_message_id, source_excerpt, reason, cosine, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                rev_id,
                memory_id,
                idx,
                change_type,
                old_text,
                new_text,
                old_confidence,
                new_confidence,
                old_status,
                new_status,
                source_message_id,
                source_excerpt,
                reason,
                cosine,
                ts,
            ),
        )

    db.write(_do)
    return rev_id


def list_revisions(memory_id: str) -> list[MemoryRevisionOut]:
    rows = db.query(
        "SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY revision_index ASC",
        (memory_id,),
    )
    return [
        MemoryRevisionOut(
            id=r["id"],
            memory_id=r["memory_id"],
            revision_index=r["revision_index"],
            change_type=r["change_type"],
            old_text=r["old_text"],
            new_text=r["new_text"],
            old_confidence=r["old_confidence"],
            new_confidence=r["new_confidence"],
            old_status=r["old_status"],
            new_status=r["new_status"],
            source_message_id=r["source_message_id"],
            source_excerpt=r["source_excerpt"],
            reason=r["reason"],
            cosine=r["cosine"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


def revision_count(memory_id: str) -> int:
    r = db.query_one("SELECT COUNT(*) AS n FROM memory_revisions WHERE memory_id=?", (memory_id,))
    return r["n"] if r else 0


def delete_memory(mem_id: str) -> None:
    def _do(c):
        c.execute("DELETE FROM memories WHERE id=?", (mem_id,))
        c.execute("DELETE FROM vec_memories WHERE memory_id=?", (mem_id,))
        c.execute("DELETE FROM memories_fts WHERE memory_id=?", (mem_id,))
        c.execute("DELETE FROM memory_revisions WHERE memory_id=?", (mem_id,))

    db.write(_do)


def get_row(mem_id: str):
    return db.query_one("SELECT * FROM memories WHERE id=?", (mem_id,))


def knn(embedding: list[float], k: int, conversation_id: str) -> list[tuple[str, float]]:
    """Return up to k [(memory_id, cosine_similarity)] nearest first, scoped to
    one conversation. The vec0 index can't join on memories.conversation_id, so
    over-fetch VEC_PREFETCH raw neighbours and filter to the conversation here."""
    from .config import VEC_PREFETCH

    blob = sqlite_vec.serialize_float32(embedding)
    rows = db.query(
        "SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        (blob, max(k, VEC_PREFETCH)),
    )
    if not rows:
        return []
    # One batch lookup instead of a query per neighbour (was N+1). Keep only ids
    # owned by this conversation, preserving vec's distance ordering.
    ids = [r["memory_id"] for r in rows]
    placeholders = ",".join("?" * len(ids))
    owned = {
        row["id"]
        for row in db.query(
            f"SELECT id FROM memories WHERE conversation_id=? AND id IN ({placeholders})",
            (conversation_id, *ids),
        )
    }
    out: list[tuple[str, float]] = []
    for r in rows:
        if r["memory_id"] in owned:
            out.append((r["memory_id"], 1.0 - r["distance"]))
            if len(out) >= k:
                break
    return out


def _fts_query(text: str) -> str | None:
    """Build a safe FTS5 MATCH expression from arbitrary user text: take word
    tokens, quote each (so FTS operators in the input can't break the query),
    OR them together. Returns None when there's nothing to search."""
    import re

    toks = re.findall(r"\w+", text.lower())
    if not toks:
        return None
    return " OR ".join(f'"{t}"' for t in toks)


def bm25(query: str, k: int, conversation_id: str) -> list[tuple[str, float]]:
    """Top-k ACTIVE memories by BM25 keyword relevance, scoped to one conversation.
    Returns [(memory_id, bm25_score)] best-first. Empty when the query has no
    indexable tokens or nothing matches."""
    match = _fts_query(query)
    if not match:
        return []
    placeholders = ",".join("?" * len(LIVE_STATUS_VALUES))
    rows = db.query(
        "SELECT f.memory_id AS memory_id, bm25(memories_fts) AS score "
        "FROM memories_fts f JOIN memories m ON m.id = f.memory_id "
        f"WHERE memories_fts MATCH ? AND m.conversation_id = ? AND m.status IN ({placeholders}) "
        "ORDER BY score LIMIT ?",
        (match, conversation_id, *LIVE_STATUS_VALUES, k),
    )
    # bm25() returns a negative number; smaller = better. Negate for "higher=better".
    return [(r["memory_id"], -r["score"]) for r in rows]


def list_memories(
    conversation_id: str, status: str | None = None, scope: str | None = None
) -> list[MemoryOut]:
    sql = "SELECT * FROM memories"
    clauses, params = ["conversation_id=?"], [conversation_id]
    if status:
        clauses.append("status=?")
        params.append(status)
    if scope:
        clauses.append("scope=?")
        params.append(scope)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, rowid DESC"
    sup, rev = _out_maps(conversation_id)
    return [
        row_to_out(r, sup.get(r["id"]), rev.get(r["id"], 1)) for r in db.query(sql, tuple(params))
    ]


def search_memories(conversation_id: str, query: str, limit: int = 50) -> list[MemoryOut]:
    """Full-text search over the BM25 index, across ALL statuses (active, updated,
    superseded, forgotten) so the inspector can find any memory regardless of state.
    Best-match first. Empty when the query has no indexable tokens or nothing hits."""
    match = _fts_query(query)
    if not match:
        return []
    rows = db.query(
        "SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.memory_id "
        "WHERE memories_fts MATCH ? AND m.conversation_id = ? "
        "ORDER BY bm25(memories_fts) LIMIT ?",
        (match, conversation_id, limit),
    )
    sup, rev = _out_maps(conversation_id)
    return [row_to_out(r, sup.get(r["id"]), rev.get(r["id"], 1)) for r in rows]


_UNSET = object()


def row_to_out(r, superseded_by=_UNSET, rev_count=_UNSET) -> MemoryOut:
    # Single-row callers let these default (one extra query each); list/search pass
    # precomputed maps so the whole page costs 2 queries, not 2 per row (was N+1).
    if superseded_by is _UNSET:
        by = db.query_one("SELECT id FROM memories WHERE supersedes_id=?", (r["id"],))
        superseded_by = by["id"] if by else None
    if rev_count is _UNSET:
        rev_count = revision_count(r["id"])
    return MemoryOut(
        id=r["id"],
        text=r["text"],
        scope=r["scope"],
        status=r["status"],
        source_message_id=r["source_message_id"],
        source_excerpt=r["source_excerpt"],
        reason=r["reason"],
        confidence=r["confidence"],
        supersedes_id=r["supersedes_id"],
        superseded_by=superseded_by,
        pinned=bool(r["pinned"]),
        use_count=r["use_count"],
        last_used_at=r["last_used_at"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
        decay_score=decay.decay_score(
            r["last_used_at"], r["created_at"], r["use_count"], pinned=bool(r["pinned"])
        ),
        revision_count=rev_count,
    )


def _out_maps(conversation_id: str) -> tuple[dict[str, str], dict[str, int]]:
    """Bulk (superseded_by, revision_count) maps for a conversation's memories, so a
    list/search page turns 2N per-row queries into 2 total."""
    sup = {
        row["supersedes_id"]: row["id"]
        for row in db.query(
            "SELECT id, supersedes_id FROM memories "
            "WHERE conversation_id=? AND supersedes_id IS NOT NULL",
            (conversation_id,),
        )
    }
    rev = {
        row["memory_id"]: row["n"]
        for row in db.query(
            "SELECT mr.memory_id AS memory_id, COUNT(*) AS n FROM memory_revisions mr "
            "JOIN memories m ON m.id = mr.memory_id WHERE m.conversation_id=? "
            "GROUP BY mr.memory_id",
            (conversation_id,),
        )
    }
    return sup, rev


# ---- traces ----
def add_trace(message_id: str, stage: str, payload: dict, conversation_id: str) -> None:
    db.write(
        lambda c: c.execute(
            "INSERT INTO traces(id, conversation_id, message_id, stage, payload, created_at) VALUES (?,?,?,?,?,?)",
            (
                _id(),
                conversation_id,
                message_id,
                stage,
                json.dumps(payload, default=str),
                now_iso(),
            ),
        )
    )


def retrieved_by_user_message(conversation_id: str) -> dict[str, list[dict]]:
    """Map each user message_id to the retrieved rows from its retrieve trace,
    for rebuilding the [N MEMORIES USED] badge when restoring a conversation."""
    rows = db.query(
        "SELECT message_id, payload FROM traces WHERE conversation_id=? AND stage='retrieve'",
        (conversation_id,),
    )
    return {r["message_id"]: _loads(r["payload"]).get("retrieved", []) for r in rows}


def events_by_user_message(conversation_id: str) -> dict[str, list[dict]]:
    """Map each user message_id to its turn's memory events (created/updated/etc.),
    read back from the reply trace, for rebuilding the 'changed this turn' strip
    when restoring a conversation."""
    rows = db.query(
        "SELECT message_id, payload FROM traces WHERE conversation_id=? AND stage='reply'",
        (conversation_id,),
    )
    return {r["message_id"]: _loads(r["payload"]).get("events", []) for r in rows}


def traces_for(message_id: str) -> list[TraceOut]:
    rows = db.query(
        "SELECT * FROM traces WHERE message_id=? ORDER BY created_at ASC, rowid ASC",
        (message_id,),
    )
    return [
        TraceOut(
            id=r["id"],
            message_id=r["message_id"],
            stage=r["stage"],
            payload=_loads(r["payload"]),
            created_at=r["created_at"],
        )
        for r in rows
    ]


def all_traces(conversation_id: str) -> list[dict]:
    rows = db.query("SELECT stage, payload FROM traces WHERE conversation_id=?", (conversation_id,))
    return [{"stage": r["stage"], "payload": _loads(r["payload"])} for r in rows]
