# Design

## The core idea: split judgment from mechanics

A memory system has two kinds of work, and conflating them is how these systems
get unreliable and un-debuggable.

- **Judgment** (open-ended, needs a model): *Is this worth remembering? Does this
  new statement contradict that old one, or just refine it?* Same input, asked
  twice, can reasonably yield a nuanced answer. This is LLM work.
- **Mechanics** (same input → same output, by definition): cosine similarity,
  threshold comparisons, scope filtering, status transitions, decay scoring,
  ranking, trace assembly. This is deterministic code.

So the LLM owns exactly two decisions — **extraction** (`llm.extract`) and the
**relation judgment** between a new fact and its nearest existing memory
(`llm.judge_conflict`) — plus the user-facing reply. Everything else is plain
Python. Both judgment calls use **structured output** on the Gemini Interactions
API: a JSON schema derived from the Pydantic model constrains the response, which
is then validated straight back into that model. A decision is a typed object you
can store, render, and assert on — never free text you have to re-parse. This is
what makes the system both trustworthy and debuggable: when a memory was
superseded, there is a typed `Judgment{relation, reason}` on record explaining why.

(One wrinkle the code handles: Gemini's `response_format` wants a self-contained
schema, but Pydantic's `model_json_schema()` emits `$ref`/`$defs` for nested models
and enums plus numeric bounds Gemini rejects. `llm._gemini_schema` deterministically
inlines the refs and whitelists the supported keys — schema-shaping is mechanics,
not judgment, so it lives in plain code.)

## The pipeline (one pass per user turn)

`memory.py::process_turn` runs six stages and writes a trace row for each:

1. **extract** — `llm.extract(message, history)` returns `Candidate[]` (each with
   text, scope, a quoted `source_excerpt` for evidence, confidence) plus an
   optional `forget_request`. Chit-chat yields an empty list.
2. **embed** — each candidate is embedded locally (`fastembed`, 384-d, L2-normalized).
3. **dedup** — find the nearest *active* memory. If similarity ≥ `DEDUP_THRESHOLD`
   and the LLM judges `duplicate`, drop the candidate and reinforce the existing
   one (bump its use count). No duplicate rows.
4. **conflict / supersede** — if the nearest active memory is within
   `[CONFLICT_LOW, DEDUP_THRESHOLD)`, ask `llm.judge_conflict`. The returned
   `relation` drives a deterministic status transition (below).
5. **retrieve** — embed the user message, pull candidates from the vec index,
   keep active ones above `RETRIEVE_THRESHOLD`, rank by **cosine × decay**, take
   the top *k*, and reinforce them. Each retrieved row records cosine, decay,
   final score, and rank.
6. **reply** — `llm.reply` answers using the retrieved memories as context; the
   trace records which memory ids were in scope and the token/latency cost.

Thresholds and decay constants live in one block in `config.py` — visible and
tunable, not scattered through the logic.

## Status state machine

Memories are never silently destroyed; they transition and stay inspectable.

```
                         new candidate
                              │
        ┌─────────────────────┼───────────────────────────┐
   cos < CONFLICT_LOW   CONFLICT_LOW ≤ cos < DEDUP    cos ≥ DEDUP
   (or no neighbour)    → judge_conflict()            → judge_conflict()
        │                     │                            │
     CREATE              relation:                    duplicate → DROP
     active            ├ update  → old⇒UPDATED,         (reinforce existing)
                       │           new⇒active (supersedes_id→old)
                       ├ supersede→ old⇒SUPERSEDED,
                       │           new⇒active (supersedes_id→old)
                       └ unrelated→ CREATE active (false match)

   explicit "forget X" → matched active memory ⇒ FORGOTTEN
```

- `active` — live, retrievable.
- `updated` — refined by a newer memory (same subject, new/sharper value).
- `superseded` — contradicted by a newer memory.
- `forgotten` — explicitly removed by the user (still shown under the Forgotten filter).

`supersedes_id` on the new memory points back at what it replaced; the API derives
`superseded_by` for the old one, so the inspector can link a superseded card to
its successor in both directions. The distinction between *update* and *supersede*
is the LLM's `relation` judgment — refinement vs contradiction — and the reason is
stored on the new memory.

## Decay model

Retrieval relevance is not just similarity. A fact you mentioned once a month ago
should rank below one you reference constantly. `decay.py`:

```
decay_score = recency_weight(last_used_at | created_at) × usage_weight(use_count)
            clamped to [DECAY_FLOOR, 1.0]
```

- **recency_weight** — exponential half-life (`DECAY_HALF_LIFE_DAYS`, default 14).
  A retrieval resets the clock (`last_used_at` updates), so used memories stay fresh.
- **usage_weight** — starts at `USAGE_BASE` (0.6) for a never-retrieved memory and
  saturates toward 1.0 with use. New memories are still retrievable; reinforced
  ones rank higher.
- Computed **at read time**, never stored stale. A faded memory drops in ranking
  but is never deleted — it remains in the inspector with a low decay bar.

Final retrieval ranking is `cosine × decay_score`, so a slightly-less-similar but
fresh, frequently-used memory can outrank a stale exact match — and the trace
shows both numbers so you can see why.

## Debuggability: the trace is the product

Every turn writes one `traces` row per stage (`extract`, `dedup`, `conflict`,
`retrieve`, `reply`), keyed by the user message id, with a JSON payload. That is
the answer to *"why did the assistant say that / use that memory?"*:

- extract → the candidates and their confidence, any forget request.
- dedup → what was dropped, against which neighbour, at what similarity, and the LLM's reason.
- conflict → each resolution: relation, the neighbour, the similarity, the LLM's reason, and the resulting action.
- retrieve → every retrieved memory with cosine, decay, score, rank.
- reply → the memory ids actually in context, plus token/latency cost.

`GET /traces/{message_id}` returns the ordered list; the UI renders it as a
per-turn drawer. `GET /metrics` aggregates across all traces (dedup rate,
supersede count, avg retrieval similarity, token + latency totals) for the live
metrics surface. Because traces are the single source, metrics are just a fold
over them — no separate bookkeeping to drift.

## Frontend: everything visible, Nothing design

The brief is that the *frontend* exposes everything — so all of it is on screen,
not in a console: a three-pane shell of **chat** (assistant-ui), **memory
inspector** (cards showing text, scope, status, source evidence, the why-stored
reason, confidence, use count, decay bar, supersede links, and edit/forget/delete
actions), and **trace + metrics** (the per-turn pipeline drawer plus live
counters).

The visual language is **Nothing design, light mode**: a printed-technical-manual
feel — off-white page, white cards for elevation with no shadows, monochrome by
default with status color applied to the *value* (green active, amber updated, red
superseded/forgotten). Monospace ALL-CAPS labels, a strict three-layer hierarchy,
and exactly one expressive break per pane (a dot-matrix `Doto` hero number in the
metrics bar). Data *is* the visual — `cos 0.83 · decay 0.74 · rank 1` in mono type
needs no decoration.

## Trade-offs (chosen deliberately)

- **SQLite + sqlite-vec + local embeddings** over Postgres/pgvector + a hosted
  vector DB: this is a single-box demo where setup friction and inspectability
  matter more than horizontal scale. One file, one command, one API key. The vec
  index, relational rows, and trace log live together. At production scale you'd
  swap the store and a hosted embedding model — the pipeline boundary
  (`store.py`) is where that change lands.
- **Local embeddings (bge-small)** trade some retrieval recall versus a hosted
  model for zero extra keys and offline operation. The retrieval threshold is
  tuned for this model and lives in `config.py`.
- **Two judge calls per candidate at most** keeps cost and latency bounded and
  every judgment on record. The deterministic gates (`DEDUP_THRESHOLD`,
  `CONFLICT_LOW`) ensure the LLM is only consulted when similarity is genuinely
  ambiguous — clear-cut new facts and clear-cut duplicates are handled in code.
- **`gemini-3.1-flash-lite` for judgment, `gemini-3.5-flash` for replies**:
  per-turn extraction and conflict judgment run on the cheap, fast model with
  `thinking_level: low` and a schema-constrained response; replies get the stronger
  model. Both ids are one line in `config.py` (swap in `gemini-3.1-pro-preview` for
  replies if you want maximum reasoning). Embeddings stay local — switching the LLM
  provider touched only `llm.py` + `config.py`, nothing in the pipeline, store, or
  API contract.
```
