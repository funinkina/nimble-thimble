"""Re-embed every stored memory after an embedding-model / dim change.

The vec0 virtual table bakes its dimension at creation time, so switching
EMBED_MODEL (and thus EMBED_DIM) leaves an existing DB's vec index at the old
width and KNN breaks. This drops and rebuilds `vec_memories` at the current
config.EMBED_DIM and re-embeds every memory row with the current model.
Idempotent; safe to re-run. A fresh DB needs nothing (the IF NOT EXISTS DDL
already builds the index at the new dim).

    cd backend
    uv run python scripts/reembed.py                 # migrates $DB_PATH (default memory.db)
    DB_PATH=./other.db uv run python scripts/reembed.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import sqlite_vec

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

from app import config, db, embeddings  # noqa: E402

BATCH = 64


def main() -> None:
    conn = db.connect()
    rows = conn.execute("SELECT id, text FROM memories ORDER BY rowid").fetchall()
    print(
        f"reembed: {len(rows)} memories -> {config.EMBED_MODEL} "
        f"({config.EMBED_DIM}-d) in {config.DB_PATH}"
    )

    conn.execute("DROP TABLE IF EXISTS vec_memories")
    conn.executescript(db.VEC_SCHEMA)  # rebuilt at the current EMBED_DIM
    conn.commit()

    done = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        vecs = embeddings.embed([r["text"] for r in batch])
        for r, v in zip(batch, vecs):
            conn.execute(
                "INSERT INTO vec_memories(memory_id, embedding) VALUES (?,?)",
                (r["id"], sqlite_vec.serialize_float32(v)),
            )
        conn.commit()
        done += len(batch)
        print(f"  {done}/{len(rows)}")

    print(f"reembed: done, {done} vectors at {config.EMBED_DIM}-d")


if __name__ == "__main__":
    main()
