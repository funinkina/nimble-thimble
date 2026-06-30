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
_lock = threading.Lock()

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
    use_count       INTEGER NOT NULL DEFAULT 0,
    last_used_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

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

    # Any row with a NULL conversation_id (legacy data, or just-added column)
    # belongs to the DEFAULT conversation.
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
    _migrate(conn)
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
