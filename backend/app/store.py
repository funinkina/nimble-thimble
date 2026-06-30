"""Persistence helpers. memory.py stays focused on pipeline logic; all SQL +
vec index bookkeeping lives here. Rows are turned into MemoryOut with decay
computed at read time.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import sqlite_vec

from . import db, decay
from .models import MemoryOut, Scope, Status, TraceOut


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _id() -> str:
    return uuid.uuid4().hex


# ---- messages ----
def add_message(role: str, content: str) -> str:
    mid = _id()
    ts = now_iso()
    db.write(lambda c: c.execute(
        "INSERT INTO messages(id, role, content, created_at) VALUES (?,?,?,?)",
        (mid, role, content, ts),
    ))
    return mid


def recent_messages(limit: int) -> list[dict]:
    rows = db.query(
        "SELECT role, content FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (limit,),
    )
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def count_user_messages() -> int:
    r = db.query_one("SELECT COUNT(*) AS n FROM messages WHERE role='user'")
    return r["n"] if r else 0


# ---- memories ----
def add_memory(*, text: str, scope: Scope, source_message_id: str, source_excerpt: str,
               reason: str, confidence: float, embedding: list[float],
               supersedes_id: str | None = None) -> str:
    mem_id = _id()
    ts = now_iso()
    blob = sqlite_vec.serialize_float32(embedding)

    def _do(c):
        c.execute(
            """INSERT INTO memories(id, text, scope, status, source_message_id, source_excerpt,
                   reason, confidence, supersedes_id, use_count, last_used_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (mem_id, text, scope.value if isinstance(scope, Scope) else scope, Status.active.value,
             source_message_id, source_excerpt, reason, confidence, supersedes_id, 0, None, ts, ts),
        )
        c.execute("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)", (mem_id, blob))

    db.write(_do)
    return mem_id


def set_status(mem_id: str, status: Status) -> None:
    db.write(lambda c: c.execute(
        "UPDATE memories SET status=?, updated_at=? WHERE id=?",
        (status.value, now_iso(), mem_id),
    ))


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
        c.execute("UPDATE memories SET text=?, updated_at=? WHERE id=?", (text, now_iso(), mem_id))
        c.execute("DELETE FROM vec_memories WHERE memory_id=?", (mem_id,))
        c.execute("INSERT INTO vec_memories(memory_id, embedding) VALUES (?,?)", (mem_id, blob))

    db.write(_do)


def delete_memory(mem_id: str) -> None:
    def _do(c):
        c.execute("DELETE FROM memories WHERE id=?", (mem_id,))
        c.execute("DELETE FROM vec_memories WHERE memory_id=?", (mem_id,))

    db.write(_do)


def get_row(mem_id: str):
    return db.query_one("SELECT * FROM memories WHERE id=?", (mem_id,))


def knn(embedding: list[float], k: int) -> list[tuple[str, float]]:
    """Return [(memory_id, cosine_similarity)] nearest first."""
    blob = sqlite_vec.serialize_float32(embedding)
    rows = db.query(
        "SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        (blob, k),
    )
    return [(r["memory_id"], 1.0 - r["distance"]) for r in rows]


def list_memories(status: str | None = None, scope: str | None = None) -> list[MemoryOut]:
    sql = "SELECT * FROM memories"
    clauses, params = [], []
    if status:
        clauses.append("status=?"); params.append(status)
    if scope:
        clauses.append("scope=?"); params.append(scope)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY created_at DESC, rowid DESC"
    return [row_to_out(r) for r in db.query(sql, tuple(params))]


def row_to_out(r) -> MemoryOut:
    by = db.query_one("SELECT id FROM memories WHERE supersedes_id=?", (r["id"],))
    return MemoryOut(
        id=r["id"], text=r["text"], scope=r["scope"], status=r["status"],
        source_message_id=r["source_message_id"], source_excerpt=r["source_excerpt"],
        reason=r["reason"], confidence=r["confidence"], supersedes_id=r["supersedes_id"],
        superseded_by=by["id"] if by else None,
        use_count=r["use_count"], last_used_at=r["last_used_at"],
        created_at=r["created_at"], updated_at=r["updated_at"],
        decay_score=decay.decay_score(r["last_used_at"], r["created_at"], r["use_count"]),
    )


# ---- traces ----
def add_trace(message_id: str, stage: str, payload: dict) -> None:
    db.write(lambda c: c.execute(
        "INSERT INTO traces(id, message_id, stage, payload, created_at) VALUES (?,?,?,?,?)",
        (_id(), message_id, stage, json.dumps(payload, default=str), now_iso()),
    ))


def traces_for(message_id: str) -> list[TraceOut]:
    rows = db.query(
        "SELECT * FROM traces WHERE message_id=? ORDER BY created_at ASC, rowid ASC",
        (message_id,),
    )
    return [TraceOut(id=r["id"], message_id=r["message_id"], stage=r["stage"],
                     payload=json.loads(r["payload"]), created_at=r["created_at"]) for r in rows]


def all_traces() -> list[dict]:
    rows = db.query("SELECT stage, payload FROM traces")
    return [{"stage": r["stage"], "payload": json.loads(r["payload"])} for r in rows]
