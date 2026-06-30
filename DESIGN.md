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
Python. Both judgment calls use **structured output** on the Groq Chat
Completions API: a JSON schema derived from the Pydantic model constrains the
response (`response_format` type `json_schema`, `strict: true`), which is then
validated straight back into that model. A decision is a typed object you can
store, render, and assert on — never free text you have to re-parse. This is
what makes the system both trustworthy and debuggable: when a memory was
superseded, there is a typed `Judgment{relation, reason}` on record explaining why.

(One wrinkle the code handles: Groq strict `json_schema` wants a self-contained
schema with every field required and `additionalProperties: false`, but Pydantic's
`model_json_schema()` emits `$ref`/`$defs` for nested models, omits defaulted fields
from `required`, and adds numeric bounds Groq rejects. `llm._groq_schema`
deterministically inlines the refs, whitelists the supported keys, and recomputes
`required` from the full property set — schema-shaping is mechanics, not judgment,
so it lives in plain code.)

## The pipeline (one pass per user turn)

`memory.py::process_turn` runs six stages and writes a trace row for each:

1. **extract** — `llm.extract(message, history)` returns `Candidate[]` (each with
   text, scope, a quoted `source_excerpt` for evidence, confidence) plus an
   optional `forget_request`. Chit-chat yields an empty list.
2. **embed** — each candidate is embedded locally (`fastembed`, bge-base, 768-d, L2-normalized).
3. **dedup** — find the nearest *active* memory. If similarity ≥ `DEDUP_THRESHOLD`
   the candidate is a duplicate **deterministically** — dropped and the existing
   memory reinforced, with **no LLM call** (a near-identical embedding is not an
   ambiguous case, so spending a judge call on it would be waste; the dedup trace
   marks it `llm: null`). No duplicate rows.
4. **conflict / supersede** — only the genuinely ambiguous band
   `[CONFLICT_LOW, DEDUP_THRESHOLD)` reaches `llm.judge_conflict`. The returned
   `relation` (duplicate / update / supersede / unrelated) drives a deterministic
   status transition (below). This is the latent/deterministic split made literal:
   the model is consulted only where similarity alone can't decide.
5. **retrieve** — embed the user message, pull candidates from the vec index,
   keep active ones above `RETRIEVE_THRESHOLD`, rank by **cosine × decay**, take
   the top *k*, and reinforce them. Each retrieved row records cosine, decay,
   final score, rank, and its status. An optional hybrid path (BM25 fused with
   RRF, then a local cross-encoder rerank — both behind `USE_BM25`/`USE_RERANK`)
   adds per-row `vec_rank`/`bm25_rank`/`rrf_score`/`rerank_score` to the trace;
   see [README → Retrieval quality](README.md#retrieval-quality-measured) for why
   it's off by default.
6. **reply** — `llm.reply` answers using the retrieved memories as context; the
   trace records which memory ids were in scope and the token/latency cost.

Thresholds and decay constants live in one block in `config.py` — visible and
tunable, not scattered through the logic.

## Canonical memories + revision timeline

A memory has a **stable canonical id** and a `memory_revisions` timeline. A
**refinement** updates the row in place (same id) and appends a revision. A
**contradiction** is handled differently — *invalidate-not-delete*: the old row
is parked at `superseded` (kept, faded, still inspectable) and a **new active
row** takes over, linked back to it via `supersedes_id`. Nothing is silently
destroyed; the full lineage stays on screen. (This is the bi-temporal idea behind
Zep/Graphiti — a superseded fact is *invalidated, not discarded*, so "what did I
believe, and when" stays answerable.)

```
                         new candidate
                              │
        ┌─────────────────────┼───────────────────────────┐
   cos < CONFLICT_LOW   CONFLICT_LOW ≤ cos < DEDUP    cos ≥ DEDUP
   (or no neighbour)    → judge_conflict()            → DETERMINISTIC duplicate
        │                     │                          (no LLM call)
     CREATE              relation:                          │
     active            ├ duplicate → DROP + REINFORCE   DROP candidate +
     + 'created' rev   ├ update  → fold IN PLACE:        REINFORCE existing
                       │           text re-embedded,     (bump usage, nudge
                       │           confidence nudged↑,    confidence, append
                       │           +'refined' rev          'reinforced' rev)
                       ├ supersede→ INVALIDATE-NOT-DELETE:
                       │           old row → SUPERSEDED (kept, faded);
                       │           NEW active row, linked via supersedes_id;
                       │           +'superseded' rev (old) +'created' rev (new)
                       └ unrelated→ CREATE active (false match) +'created' rev

   explicit "forget X" → nearest active memory with cos ≥ FORGET_THRESHOLD
                         ⇒ FORGOTTEN +'forgotten' rev   (else: forgets nothing)
```

A **refined** memory stays `active` with its **decay strength carried forward**
(`use_count`/`last_used_at` are not reset), so a long-reinforced fact keeps its
rank when sharpened. A **superseded** memory moves to the `superseded` status: it
drops out of retrieval (only `active` rows are retrieved) but stays in the
inspector, faded, with a forward link to the fact that replaced it. So three
statuses are live resting states — `active`, `superseded`, `forgotten` — while
`updated` is a *transition*, surfaced as a per-turn event and a `refined`
revision rather than a status a row rests in. The LLM's `relation` judgment only
picks refine-vs-contradict; the in-place mutation, the new-row linkage, the
confidence formula (`c + CONFIDENCE_STEP·(1−c)`), and the revision writes are all
deterministic code in `memory.py`/`store.py`.

`memory_revisions` (one row per change: `change_type`, `old_text`/`new_text`,
`old_confidence`/`new_confidence`, status delta, source, reason, cosine) is the
lineage. `GET /memories/{id}/revisions` returns the ordered timeline; the inspector
card renders it under an expandable **HISTORY (N)**. A guarded one-shot backfill
seeds every pre-existing memory a `created` revision (and any legacy
`supersedes_id` chain a linkage revision), so no history is lost on upgrade.
`confidence` is no longer frozen at insert — it accumulates on the canonical row.

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
reason, confidence, use count, decay bar, an expandable revision timeline, and
edit/forget/delete actions), and **trace + metrics** (the per-turn pipeline drawer plus live
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
- **Local embeddings (bge-base, 768-d)** trade some retrieval recall versus a
  hosted model for zero extra keys and offline operation. Upgraded from bge-small
  (384-d) because retrieval quality is this corpus's main accuracy lever (see
  *Memory accuracy* below); the retrieval threshold is tuned per-model and lives
  in `config.py`. `scripts/reembed.py` migrates an existing DB when model/dim change.
- **One judge call per candidate at most** keeps cost and latency bounded and
  every judgment on record. The deterministic gates ensure the LLM is consulted
  *only* in the ambiguous band: `cos < CONFLICT_LOW` creates in code, `cos ≥
  DEDUP_THRESHOLD` dedups in code, and only `[CONFLICT_LOW, DEDUP_THRESHOLD)`
  spends a `judge_conflict` call. (Forget matching uses its own
  `FORGET_THRESHOLD`, set at `CONFLICT_LOW` rather than the much looser retrieval
  floor, so "forget my diet" can't sweep away a marginally-related memory.)

- **The pipeline degrades, it doesn't crash.** Groq's strict `json_schema` mode
  returns `json_validate_failed` on a non-trivial fraction of requests under load;
  a raw `model_validate_json` on that would 500 the whole turn with no trace.
  `llm._structured` gives every judgment call a timeout (`LLM_TIMEOUT`) and a
  bounded retry (`LLM_RETRIES`), then falls back to a safe empty result —
  `extract` → no candidates, `judge_conflict` → treat as a fresh fact, `reply` →
  a graceful apology — and records the failure in that stage's trace `llm.error`.
  A flaky model degrades memory quality for one turn instead of breaking the
  request. These are mechanics (retry/timeout/fallback), so they live in code,
  not in a prompt.
- **`openai/gpt-oss-20b` for judgment, `openai/gpt-oss-120b` for replies**:
  per-turn extraction and conflict judgment run on the cheap, fast model with
  `reasoning_effort: low` and a schema-constrained response; replies get the
  larger model. Both are Groq's strict-`json_schema` models. Both ids are one line
  in `config.py` (swap in `openai/gpt-oss-120b` for judgment too if you want
  maximum reasoning). Embeddings stay local — switching the LLM provider touched
  only `llm.py` + `config.py`, nothing in the pipeline, store, or API contract.

## Memory accuracy: the levers (measured and deferred)

Accuracy here means two things: **retrieval** (does the right memory reach the
reply) and **judgment** (extract/dedup/conflict). The pipeline isolates them, so
each can be improved without touching the other.

**Taken — embedding upgrade (the corpus's main lever).** `scripts/eval_retrieval.py`
scores a fixed memory set with confusable distractors. The retrieval stack was
already at its structural ceiling on short profile facts (BM25 fusion *regresses*
on lexical noise), so the lever that actually moves the number is embedding
quality. Swapping bge-small (384-d) → **bge-base (768-d)** is a one-line config
change (same BGE family, symmetric, no query/doc prefixing) plus a `reembed.py`
migration. A useful side effect showed up in the eval: with the stronger
embeddings the **cross-encoder rerank stopped being a no-op** — `vec+rerank` now
leads `vec-only` (Recall@3 0.786 → 0.857, MRR 0.786 → 0.839 on the 14-query set),
where on bge-small it only clawed back to parity. Small N, so suggestive not
conclusive, but the regime changed: rerank (`USE_RERANK=1`,
`Xenova/ms-marco-MiniLM`, or `bge-reranker-v2-m3` for more headroom) is now a
justified flag, not dead weight. Kept off by default pending a larger eval set.

**Deferred (documented, not built):**

- **Full bi-temporal validity windows.** The supersede refactor does the *invalidate-
  not-delete* half (old row kept as `superseded`, linked forward). The full
  bi-temporal model (Zep/Graphiti) adds explicit `valid_from`/`valid_to` per fact
  and queries "what was true at time T." It's the SOTA for temporal memory —
  Graphiti scores **63.8% vs Mem0's 49.0% on LongMemEval** ([Zep, arXiv:2501.13956](https://arxiv.org/abs/2501.13956)).
  Deferred because it wants a graph store; the current relational + revision model
  already answers "what changed and when" for this scope.
- **Entity tagging for dedup/forget keying** (`gliner`, lightweight modern NER).
  Today dedup and forget key on whole-sentence cosine; tagging the *subject* entity
  would tighten "forget my diet" precision and catch dedups that share a subject but
  not surface form. ~0.2 GB model, fits the local-first posture.
- **Per-scope thresholds.** `user_profile` facts could demand a tighter dedup band
  than transient `context`. One dict in `config.py`; deferred for lack of data to
  tune it against.

The throughline: every lever is either measured before shipping (`eval_retrieval.py`)
or left as a typed config knob, never a silent prompt tweak.
