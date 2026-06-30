"""SQLite + sqlite-vec. One module-level connection guarded by a write lock.

Holds three relational tables (memories, messages, traces) and one vec0 virtual
table for embeddings. Cosine distance metric so similarity = 1 - distance.
"""

from __future__ import annotations

import sqlite3
import threading

import sqlite_vec

from . import config

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id              TEXT PRIMARY KEY,
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
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    stage       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_message ON traces(message_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
"""

VEC_SCHEMA = f"""
CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
    memory_id TEXT PRIMARY KEY,
    embedding float[{config.EMBED_DIM}] distance_metric=cosine
);
"""


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
