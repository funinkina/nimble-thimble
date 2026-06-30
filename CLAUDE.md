# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A chat assistant with an inspectable long-term memory system. Two services:
a **FastAPI backend** (`backend/`) that runs the memory pipeline, and a
**React/Vite/TS frontend** (`frontend/`) styled to the Nothing design system
(light mode). Read `README.md` for the API contract and `DESIGN.md` for the
design rationale and the memory state machine — they are the source of truth for
behaviour.

## Commands

Backend (Python, `uv`; venv is pinned **<3.14** because fastembed/onnxruntime
lack 3.14 wheels — `uv sync` handles this):

```bash
cd backend
uv sync
uv run uvicorn app.main:app --port 8000 --reload        # serve (needs GROQ_API_KEY in backend/.env)
uv run python -m py_compile app/**/*.py                  # quick compile check
```

There is no unit-test framework. **`scripts/scenarios.py` is the test harness** —
it drives the four memory behaviours (create / update-conflict / retrieve /
forget) end-to-end through the live API and asserts statuses + trace contents.
Run it against a fresh DB with a real key set:

```bash
cd backend
DB_PATH=./scenarios.db uv run uvicorn app.main:app --port 8000   # terminal 1
rm -f scenarios.db                                               # clean start
uv run python scripts/scenarios.py                              # terminal 2 (exits non-zero on failure)
```

Frontend:

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (backend CORS allows this origin only)
npm run build        # tsc -b && vite build — this is the typecheck gate
```

## Architecture — the big picture

**The pipeline is the product, and it lives in one function:**
`backend/app/memory.py::process_turn`. Every user turn runs six stages —
`extract → embed → dedup → conflict/supersede → retrieve → reply` — and writes
**one trace row per stage**. Understanding that function plus `store.py` is 80% of
the backend.

**Latent vs deterministic split (the core design rule — preserve it).** The LLM
owns exactly three calls, all in `llm.py`: `extract` (is this memory-worthy),
`judge_conflict` (does a new fact duplicate/update/supersede an old one), and
`reply`. Everything else — cosine similarity, threshold gates, status
transitions, decay, ranking, trace assembly — is deterministic code. When adding
behaviour, decide which half it belongs to; don't push mechanics into prompts or
judgment into code.

**Traces are the single source of truth for observability.** `metrics.py`
computes `/metrics` by folding over the `traces` table — there is no separate
counter bookkeeping. If you add a metric, derive it from trace payloads, not a new
column.

**Two swap boundaries are deliberately thin:**
- *LLM provider* = `llm.py` + `config.py` only. Currently Groq via the
  **OpenAI-compatible Chat Completions API** (`client.chat.completions.create`).
  Provider-agnostic layers
  (store, pipeline, routes, the HTTP/Pydantic API contract, the entire frontend)
  never import the SDK.
- *Persistence / vector store* = `store.py` only. It owns all SQL and all
  `sqlite-vec` bookkeeping; the pipeline calls `store.*`, never raw SQL.

**Config is centralized.** Every threshold, decay constant, and model id is in
`backend/app/config.py`. Tune there, not inline.

**Frontend data flow.** `useLocalRuntime` + a custom `ChatModelAdapter`
(`runtime.ts`) POST to `/chat`. The adapter returns only the reply text to
assistant-ui, and pushes the full response (`message_id`, `retrieved`,
`memory_events`) into a `useSyncExternalStore` store (`store.ts`); the memory,
trace, and metrics panes subscribe and refetch. The chat UI is built from
assistant-ui **primitives** (not the pre-styled `<Thread/>`) so it can be styled
to Nothing tokens, which live in `theme.css`.

## Non-obvious gotchas

- **`@assistant-ui/react` is pinned EXACT to `0.11.56`** (and `react-markdown` to
  `0.11.9`). `0.11.58` has a StrictMode crash regression
  ([#3103](https://github.com/assistant-ui/assistant-ui/issues/3103)):
  `Cannot set properties of undefined (setting '_getInitializePromise')`. Do not
  bump these without verifying the runtime mounts; markdown's peer range must
  still include the pinned react version.
- **`sqlite-vec`**: the `vec_memories` vtable uses `distance_metric=cosine`, so
  similarity = `1 - distance` (see `store.knn`). KNN queries need `embedding MATCH
  ? AND k = ?`. The vec index can't filter on `memories.status`, so retrieval
  **over-fetches** (`VEC_OVERFETCH`) then filters status in Python.
- **Groq structured output**: `llm._groq_schema` deterministically inlines
  Pydantic `$ref`/`$defs`, whitelists keys, and recomputes `required` from the full
  property set (+ `additionalProperties:false`), because Groq strict `json_schema`
  rejects `$ref`/numeric bounds and demands every field be required. Any new
  LLM-output Pydantic model passes through it. For the same reason,
  `Extraction.forget_request` is `str = ""`, not `Optional[str]` — avoid
  `anyOf:[..., null]` in LLM-facing schemas.
- **Embeddings are local** (`fastembed`, bge-base-en-v1.5, 768-d) — there is no
  embedding API key; only `GROQ_API_KEY` is required. `EMBED_MODEL`/`EMBED_DIM` live
  in `config.py`; the dim is baked into the vec0 vtable, so changing the model means
  running `scripts/reembed.py`. First `/chat` downloads the model (~0.21 GB) once.
- **Decay** (`decay.py`) is computed at read time and never stored; memories below
  the floor fade in ranking but are never deleted (still shown in the inspector).
- Route handlers are **sync `def`** on purpose — FastAPI runs them in a threadpool
  so the blocking embed + LLM pipeline doesn't stall the event loop.
- The repo is auto-formatted (ruff/black-style); generated files may get rewrapped
  after you write them — cosmetic, don't fight it.
