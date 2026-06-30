# Inspectable Memory Chat

A chat assistant that remembers. As you talk to it normally, it extracts durable
facts about you, dedupes and reconciles them against what it already knows
(updating, superseding, or forgetting), retrieves the relevant ones into later
replies — and shows you **every** decision it made. Chat, memory lifecycle,
per-turn pipeline traces, and live metrics are all visible in the UI; nothing is
hidden in a log.

```
┌──────────────┐   user turn    ┌──────────────────────────────────────────────┐
│   React UI   │ ─────────────▶ │  FastAPI pipeline (one pass per turn)          │
│  (Nothing    │                │                                                │
│   design,    │ ◀───────────── │  extract → embed → dedup → conflict/supersede  │
│   3 panes)   │  reply +       │     → write → retrieve → reply                 │
└──────────────┘  events +      │                                                │
                  retrieved     │  every stage writes a trace row                │
                                └──────────────────────────────────────────────┘
                                   SQLite + sqlite-vec   |   fastembed (local)
                                   Claude (Anthropic)
```

The design rationale, state machine, and trade-offs are in [DESIGN.md](DESIGN.md).

## What it does

- **Extracts** memory-worthy facts from natural conversation (ignores chit-chat).
- **Dedupes** near-identical facts instead of piling up copies.
- **Updates / supersedes** when you refine or contradict something you said before — the old memory is kept, marked, and linked to its successor.
- **Forgets** on request, and via the inspector's forget/delete actions.
- **Retrieves** the relevant memories into each reply, ranked by semantic similarity × a recency/usage **decay** score.
- **Explains itself**: each reply links to the exact pipeline trace — what was extracted, what was deduped, what conflicted (and why), what was retrieved (with similarity + decay + rank).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | FastAPI (Python) | async API, Pydantic doubles as the LLM structured-output contract |
| Store | SQLite + `sqlite-vec` | one file, zero infra — vectors + relational + trace data together |
| Embeddings | `fastembed` (BAAI/bge-small-en-v1.5, 384-d) | local, free, no second API key |
| LLM | Claude — `claude-opus-4-8` (replies), `claude-sonnet-4-6` (judgment) | structured outputs make judgment inspectable |
| Frontend | React + Vite + TS + assistant-ui | streaming chat primitives; Nothing-design light theme |

## Setup

Prerequisites: Python ≥3.12 (`uv` recommended), Node ≥18, and an Anthropic API key.

### 1. Backend

```bash
cd backend
cp .env.example .env          # then put your real ANTHROPIC_API_KEY in .env
uv sync                       # creates .venv (pinned <3.14 for fastembed wheels)
uv run uvicorn app.main:app --port 8000 --reload
```

First request downloads the embedding model (~130 MB) once. Only `ANTHROPIC_API_KEY` is required — embeddings run locally.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

The backend allows CORS from `:5173`. Open the UI and start chatting.

## Test scenarios

`scripts/scenarios.py` drives the four required behaviours end-to-end through the
live API and asserts the resulting statuses, supersede links, retrieval, and
trace contents (structural assertions, robust to LLM phrasing). Run against a
**fresh** database:

```bash
cd backend
DB_PATH=./scenarios.db uv run uvicorn app.main:app --port 8000   # terminal 1
rm -f scenarios.db                                               # ensure clean start
uv run python scripts/scenarios.py                              # terminal 2
```

Covers: **creation** → **update/conflict** (vegetarian → eats fish, old memory
superseded + linked) → **retrieval** (dinner question pulls the diet memory with
its score) → **forget/delete** (diet forgotten, gone from retrieval, still shown
in the inspector).

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat` | run a turn → reply + memory_events + retrieved refs |
| GET | `/memories?status=&scope=` | all memories with evidence, scope, reason, supersede links, decay |
| PATCH | `/memories/{id}` | edit text (re-embeds) or `{forget:true}` |
| DELETE | `/memories/{id}` | hard delete |
| GET | `/traces/{message_id}` | ordered pipeline stages for one turn |
| GET | `/metrics` | counts, dedup/supersede rates, avg retrieval score, token + latency totals |

Interactive docs at `http://localhost:8000/docs`.

## Layout

```
backend/
  app/
    config.py      thresholds, decay constants, model ids — all tunable in one place
    db.py          sqlite + sqlite-vec (cosine), schema
    models.py      Pydantic schemas (also the LLM output contracts)
    embeddings.py  fastembed wrapper (L2-normalized → cosine = dot)
    decay.py       recency × usage scoring
    llm.py         extract() / judge_conflict() / reply()
    store.py       persistence + vec index bookkeeping
    memory.py      the pipeline (extract→dedup→conflict→retrieve→reply)
    routes/        chat, memories, traces, metrics
  scripts/scenarios.py
frontend/          React + Vite + assistant-ui (Nothing light theme)
```
