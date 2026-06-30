# Inspectable Memory Chat

A chat assistant that remembers. As you talk to it normally, it extracts durable
facts about you, dedupes and reconciles them against what it already knows
(updating, superseding, or forgetting), retrieves the relevant ones into later
replies — and shows you **every** decision it made. Chat, memory lifecycle,
per-turn pipeline traces, and live metrics are all visible in the UI; nothing is
hidden in a log.

```
┌──────────────┐   user turn    ┌────────────────────────────────────────────────┐
│   React UI   │ ─────────────▶ │  FastAPI pipeline (one pass per turn)          │
│  (Nothing    │                │                                                │
│   design,    │ ◀───────────── │  extract → embed → dedup → conflict/supersede  │
│   3 panes)   │  reply +       │     → write → retrieve → reply                 │
└──────────────┘  events +      │                                                │
                  retrieved     │  every stage writes a trace row                │
                                └────────────────────────────────────────────────┘
                                   SQLite + sqlite-vec   |   fastembed (local)
                                   Groq (gpt-oss)
```

The design rationale, state machine, and trade-offs are in [DESIGN.md](DESIGN.md).

## What it does

- **Extracts** memory-worthy facts from natural conversation (ignores chit-chat).
- **Dedupes** near-identical facts instead of piling up copies.
- **Updates / supersedes** when you refine or contradict something you said before — the old memory is kept, marked, and linked to its successor.
- **Forgets** on request, and via the inspector's forget/delete actions.
- **Retrieves** the relevant memories into each reply, ranked by semantic similarity × a recency/usage **decay** score. An optional hybrid path (BM25 + cross-encoder rerank) is one env flag away — see [Retrieval quality](#retrieval-quality-measured).
- **Explains itself**: each reply links to the exact pipeline trace — what was extracted, what was deduped (and whether deterministically or by the LLM), what conflicted (and why), what was retrieved (with similarity, decay, rank, and every fusion/rerank sub-score), and which memories fed the reply. The chat badge opens a provenance popover of those memories; each assistant turn shows chips for what it created/updated/superseded/forgot.
- **Degrades instead of crashing**: every LLM call has a timeout and bounded retry; Groq's strict-schema failures (~10% under load) fall back to a safe empty result so a turn never 500s, and the failure is recorded in the trace.

## Stack

| Layer      | Choice                                                                  | Why                                                                         |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Backend    | FastAPI (Python)                                                        | async API, Pydantic doubles as the LLM structured-output contract           |
| Store      | SQLite + `sqlite-vec`                                                   | one file, zero infra — vectors + relational + trace data together           |
| Embeddings | `fastembed` (BAAI/bge-small-en-v1.5, 384-d)                             | local, free, no second API key                                              |
| LLM        | Groq — `openai/gpt-oss-120b` (replies), `openai/gpt-oss-20b` (judgment) | Chat Completions `json_schema` structured output makes judgment inspectable |
| Frontend   | React + Vite + TS + assistant-ui                                        | streaming chat primitives; Nothing-design light theme                       |

## Setup

Prerequisites: Python ≥3.12 (`uv` recommended), Node ≥18, and a Groq API key ([get one here](https://console.groq.com/keys)).

### 1. Backend

```bash
cd backend
cp .env.example .env          # then put your real GROQ_API_KEY in .env
uv sync                       # creates .venv (pinned <3.14 for fastembed wheels)
uv run uvicorn app.main:app --port 8000 --reload
```

First request downloads the embedding model (~130 MB) once. Only `GROQ_API_KEY` is required — embeddings run locally.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

The backend allows CORS from `:5173`. Open the UI and start chatting.

## Test scenarios

`scripts/scenarios.py` drives the memory behaviours end-to-end through the live
API and asserts the resulting statuses, supersede links, retrieval, and trace
contents (structural assertions, robust to LLM phrasing). Run against a **fresh**
database:

```bash
cd backend
DB_PATH=./scenarios.db uv run uvicorn app.main:app --port 8000   # terminal 1
rm -f scenarios.db                                               # ensure clean start
uv run python scripts/scenarios.py                              # terminal 2 (exits non-zero on failure)
```

Seven scenarios:

1. **Creation** — a fact is extracted with evidence, scope, reason, one `created` revision.
2. **Update / conflict** — "vegetarian → eats fish" supersedes the old claim in place (same id), appends a revision over the prior text.
3. **Retrieval** — a dinner question pulls the diet memory with cosine + decay + score + rank, and the reply trace lists the used ids.
4. **Forget / delete** — "forget my diet" → forgotten, gone from retrieval, still shown in the inspector.
5. **No duplication** — restating a known fact spawns no second memory; if the dedup stage runs on a ≥ threshold match it does so deterministically (no LLM judge call).
6. **Forget precision** — an unrelated forget subject ("forget my favourite Pokemon") forgets nothing.
7. **Manual edit** — `PATCH /memories/{id}` rewrites text (re-embeds) and appends an `edited` revision.

### Retrieval quality (measured)

Retrieval is the part of "AI memory judgment" that's actually measurable, so it
has its own harness. `scripts/eval_retrieval.py` seeds a fixed memory set with
confusable distractors and scores three configurations on Recall@3 + MRR — no
LLM, no server, fully deterministic:

```bash
cd backend && uv run python scripts/eval_retrieval.py
```

```
config            Recall@3     MRR
vec-only             0.786   0.804
vec+rerank           0.786   0.804
hybrid               0.714   0.714
hybrid+rerank        0.786   0.804
```

**Verdict, stated honestly:** on this app's data distribution — short, standalone
profile facts — local dense retrieval (`bge-small`) is already at ceiling. Naïve
BM25 rank-fusion *regresses* ranking (lexical noise), and the cross-encoder rerank
only claws it back to dense parity. So the shipped default is **dense-only**:
simplest, fastest, no extra model download, and provably no worse. The full
hybrid + rerank pipeline is implemented and one flag away (`USE_BM25=1
USE_RERANK=1`) for deployments with larger/noisier memory stores, where the
literature shows it pays off — and the per-row fusion sub-scores it adds to the
trace are useful for debugging either way. Building it, measuring it, and *not*
forcing it on for zero measured gain is the point.

## API

| Method | Path                       | Purpose                                                                    |
| ------ | -------------------------- | -------------------------------------------------------------------------- |
| POST   | `/chat`                    | run a turn → reply + memory_events + retrieved refs                        |
| GET    | `/memories?status=&scope=` | all memories with evidence, scope, reason, supersede links, decay          |
| PATCH  | `/memories/{id}`           | edit text (re-embeds) or `{forget:true}`                                   |
| DELETE | `/memories/{id}`           | hard delete                                                                |
| GET    | `/traces/{message_id}`     | ordered pipeline stages for one turn                                       |
| GET    | `/metrics`                 | counts, dedup/supersede rates, avg retrieval score, token + latency totals |

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
    llm.py         extract() / judge_conflict() / reply() — timeout + retry + safe degrade
    reranker.py    optional local cross-encoder (fastembed), lazy singleton
    store.py       persistence + vec index + BM25 (FTS5) bookkeeping
    memory.py      the pipeline + retrieve_memories() (dense | hybrid + rerank)
    routes/        chat, memories, traces, metrics
  scripts/
    scenarios.py        end-to-end behaviour assertions (live API)
    eval_retrieval.py   Recall@3 / MRR over vec / hybrid / rerank (offline)
frontend/          React + Vite + assistant-ui (Nothing light theme)
```
