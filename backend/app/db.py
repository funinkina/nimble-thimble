"""SQLite + sqlite-vec. One module-level connection guarded by a write lock.

Holds three relational tables (memories, messages, traces) and one vec0 virtual
table for embeddings. Cosine distance metric so similarity = 1 - distance.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone

import sqlite_vec

from . import config

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()  # serializes write+commit on the shared connection

# Per-conversation pipeline locks. `_lock` only makes each write atomic; it does
# NOT stop two concurrent /chat turns for the same conversation from interleaving
# read -> judge -> write on the same memory. process_turn holds the conversation's
# turn_lock for its whole body so same-conversation turns serialize while different
# conversations still run in parallel. Distinct from _lock, so nesting can't deadlock.
_turn_locks: dict[str, threading.Lock] = {}
_turn_locks_guard = threading.Lock()


def turn_lock(key: str) -> threading.Lock:
    with _turn_locks_guard:
        lk = _turn_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _turn_locks[key] = lk
        return lk


DEFAULT_CONVERSATION_ID = "default"

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT,
    text            TEXT NOT NULL,
    scope           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    source_message_id TEXT,
    source_excerpt  TEXT,
    reason          TEXT,
    confidence      REAL NOT NULL DEFAULT 0.0,
    supersedes_id   TEXT,
    pinned          INTEGER NOT NULL DEFAULT 0,
    use_count       INTEGER NOT NULL DEFAULT 0,
    last_used_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_revisions (
    id              TEXT PRIMARY KEY,
    memory_id       TEXT NOT NULL,
    revision_index  INTEGER NOT NULL,
    change_type     TEXT NOT NULL,   -- created|refined|superseded|reinforced|edited|forgotten
    old_text        TEXT,
    new_text        TEXT,
    old_confidence  REAL,
    new_confidence  REAL,
    old_status      TEXT,
    new_status      TEXT,
    source_message_id TEXT,
    source_excerpt  TEXT,
    reason          TEXT,
    cosine          REAL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_memory
    ON memory_revisions(memory_id, revision_index);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    conversation_id TEXT,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    id          TEXT PRIMARY KEY,
    conversation_id TEXT,
    message_id  TEXT NOT NULL,
    stage       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_message ON traces(message_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
"""

# Indexes on conversation_id are created in _migrate, after the column exists
# (an existing pre-multichat DB only gets the column via ALTER there).
CONV_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_conversation ON memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_traces_conversation ON traces(conversation_id);
"""

VEC_SCHEMA = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding float[{config.EMBED_DIM}] distance_metric=cosine
);
"""

# BM25 keyword index over memory text, for hybrid (dense + sparse) retrieval.
# Manually kept in sync from store.py — memory_id UNINDEXED so it's a stored
# lookup key, not a search column.
FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED,
    text
);
"""


def _backfill_fts(conn: sqlite3.Connection) -> None:
    """Seed memories_fts from existing memories if empty (legacy DBs). Idempotent."""
    if conn.execute("SELECT 1 FROM memories_fts LIMIT 1").fetchone():
        return
    for r in conn.execute("SELECT id, text FROM memories").fetchall():
        conn.execute(
            "INSERT INTO memories_fts(memory_id, text) VALUES (?,?)",
            (r["id"], r["text"]),
        )


def _migrate(conn: sqlite3.Connection) -> None:
    """Bring a pre-multichat DB up to date. CREATE TABLE IF NOT EXISTS never
    adds columns to an existing table, so add conversation_id where missing and
    backfill every orphaned row into one DEFAULT conversation. Idempotent."""

    def has_col(table: str) -> bool:
        cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(c["name"] == "conversation_id" for c in cols)

    altered = False
    for t in ("messages", "memories", "traces"):
        if not has_col(t):
            conn.execute(f"ALTER TABLE {t} ADD COLUMN conversation_id TEXT")
            altered = True

    mcols = [c["name"] for c in conn.execute("PRAGMA table_info(memories)").fetchall()]
    if "pinned" not in mcols:
        conn.execute(
            "ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"
        )

    orphans = conn.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id IS NULL"
    ).fetchone()["n"]
    if altered or orphans:
        ts = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT OR IGNORE INTO conversations(id, title, created_at, updated_at) VALUES (?,?,?,?)",
            (DEFAULT_CONVERSATION_ID, "Default", ts, ts),
        )
        for t in ("messages", "memories", "traces"):
            conn.execute(
                f"UPDATE {t} SET conversation_id=? WHERE conversation_id IS NULL",
                (DEFAULT_CONVERSATION_ID,),
            )

    conn.executescript(CONV_INDEXES)


def _backfill_revisions(conn: sqlite3.Connection) -> None:
    """Seed memory_revisions from legacy append-only data so no timeline starts
    empty. Idempotent: skips entirely once any revision exists. Every memory gets
    a 'created' entry; legacy superseded/updated rows also get a linkage entry
    pointing at the row that replaced them (via supersedes_id)."""
    if conn.execute("SELECT 1 FROM memory_revisions LIMIT 1").fetchone():
        return
    rows = conn.execute(
        "SELECT id, text, status, confidence, source_message_id, source_excerpt, "
        "reason, supersedes_id, created_at FROM memories ORDER BY created_at ASC, rowid ASC"
    ).fetchall()
    if not rows:
        return
    successor = {}  # parent_id -> child row that superseded it
    for r in rows:
        if r["supersedes_id"]:
            successor[r["supersedes_id"]] = r
    for r in rows:
        conn.execute(
            "INSERT INTO memory_revisions(id, memory_id, revision_index, change_type, "
            "old_text, new_text, old_confidence, new_confidence, old_status, new_status, "
            "source_message_id, source_excerpt, reason, cosine, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                uuid_hex(),
                r["id"],
                0,
                "created",
                None,
                r["text"],
                None,
                r["confidence"],
                None,
                "active",
                r["source_message_id"],
                r["source_excerpt"],
                r["reason"],
                None,
                r["created_at"],
            ),
        )
        child = successor.get(r["id"])
        if child is not None and r["status"] in ("superseded", "updated"):
            conn.execute(
                "INSERT INTO memory_revisions(id, memory_id, revision_index, change_type, "
                "old_text, new_text, old_confidence, new_confidence, old_status, new_status, "
                "source_message_id, source_excerpt, reason, cosine, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    uuid_hex(),
                    r["id"],
                    1,
                    "refined" if r["status"] == "updated" else "superseded",
                    r["text"],
                    child["text"],
                    r["confidence"],
                    child["confidence"],
                    r["status"],
                    "active",
                    child["source_message_id"],
                    child["source_excerpt"],
                    child["reason"],
                    None,
                    child["created_at"],
                ),
            )


def uuid_hex() -> str:
    import uuid

    return uuid.uuid4().hex


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.executescript(SCHEMA)
    conn.executescript(VEC_SCHEMA)
    conn.executescript(FTS_SCHEMA)
    _migrate(conn)
    _backfill_revisions(conn)
    _backfill_fts(conn)
    conn.commit()
    _conn = conn
    return conn


def write(fn):
    """Run fn(conn) under the write lock and commit. Returns fn's result."""
    conn = connect()
    with _lock:
        result = fn(conn)
        conn.commit()
    return result


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    conn = connect()
    return conn.execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    conn = connect()
    return conn.execute(sql, params).fetchone()
