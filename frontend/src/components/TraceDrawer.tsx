import { useEffect, useState, type ReactNode } from "react";
import { GitMerge, MessageSquare, Search, Sparkles, Workflow } from "lucide-react";
import { getTraces } from "../api";
import { store, useSelectedMessageId, useTurnSeq } from "../store";
import type {
  ConflictPayload,
  DedupPayload,
  ExtractPayload,
  LlmMeta,
  ReplyPayload,
  RetrievePayload,
  Trace,
  TraceStage,
} from "../types";

const STAGE_ORDER: TraceStage[] = [
  "extract",
  "dedup",
  "conflict",
  "retrieve",
  "reply",
];

const STAGE_ICON: Record<TraceStage, typeof Search> = {
  extract: Sparkles,
  dedup: GitMerge,
  conflict: GitMerge,
  retrieve: Search,
  reply: MessageSquare,
};

const LABEL = "font-mono text-label uppercase text-muted";
const EMPTY_NOTE = "font-mono text-caption tracking-[0.04em] text-faint";
const Q = "font-mono text-caption text-muted";
const CAND = "flex flex-col gap-[3px] border-l-2 border-line pl-2";
const CAND_TEXT = "font-sans text-body-sm leading-[1.4] text-ink";
const REASON = "font-sans text-body-sm italic leading-[1.4] text-muted";
const RELATION = "rounded border px-1.5 py-0.5 font-mono text-label uppercase whitespace-nowrap";

// status is encoded on the value: red = supersede, amber = update, green = new.
function relTone(kind: string): string {
  switch (kind) {
    case "supersede":
    case "superseded":
      return "border-accent text-accent";
    case "update":
    case "updated":
      return "border-warning text-warning";
    case "new":
    case "created":
      return "border-success text-success";
    case "duplicate":
      return "border-line text-faint";
    default:
      return "border-line text-muted";
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function LlmLine({ llm }: { llm: LlmMeta | undefined }) {
  if (!llm) return null;
  const b = "font-normal text-muted";
  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-border pt-2 font-mono text-label tracking-[0.06em] text-faint">
      <span>
        <b className={b}>MODEL</b> {llm.model}
      </span>
      <span>
        <b className={b}>IN</b> {llm.input_tokens}
      </span>
      <span>
        <b className={b}>OUT</b> {llm.output_tokens}
      </span>
      <span>
        <b className={b}>LAT</b> {llm.latency_ms}MS
      </span>
    </div>
  );
}

function Extract({ p }: { p: ExtractPayload }) {
  return (
    <>
      {p.candidates.length === 0 ? (
        <div className={EMPTY_NOTE}>NO CANDIDATES — TREATED AS CHIT-CHAT</div>
      ) : (
        p.candidates.map((c, i) => (
          <div className={CAND} key={i}>
            <div className={CAND_TEXT}>{c.text}</div>
            <div className="flex flex-wrap items-center gap-4">
              <span className={`${RELATION} ${relTone(c.scope)}`}>
                {c.scope.replace("_", " ")}
              </span>
              <span className={Q}>conf {c.confidence.toFixed(2)}</span>
            </div>
            <div className={Q}>&ldquo;{c.source_excerpt}&rdquo;</div>
          </div>
        ))
      )}
      {p.forget_request && (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Forget Request</span>
          <span className="font-sans text-body-sm leading-[1.4] text-primary">
            {p.forget_request}
          </span>
          {p.forget_resolution && (
            <span className={REASON}>{p.forget_resolution}</span>
          )}
        </div>
      )}
      <LlmLine llm={p.llm} />
    </>
  );
}

function Dedup({ p }: { p: DedupPayload }) {
  return (
    <>
      {p.dropped.map((d, i) => (
        <div className={CAND} key={i}>
          <div className={CAND_TEXT}>{d.candidate}</div>
          <div className="flex flex-wrap items-center gap-4">
            <span className={`${RELATION} ${relTone("duplicate")}`}>DUPLICATE</span>
            <span className={Q}>cos {d.cosine.toFixed(4)}</span>
          </div>
          {d.neighbour_id ? (
            <button
              className={`${Q} text-left cursor-pointer hover:text-ink hover:underline`}
              title={`Highlight ${shortId(d.neighbour_id)} in the memory inspector`}
              onClick={() => store.highlightMemory(d.neighbour_id!)}
            >
              vs &ldquo;{d.neighbour}&rdquo; ({shortId(d.neighbour_id)})
            </button>
          ) : (
            <div className={Q}>vs &ldquo;{d.neighbour}&rdquo;</div>
          )}
          <div className={REASON}>{d.reason}</div>
          <LlmLine llm={d.llm} />
        </div>
      ))}
    </>
  );
}

function Conflict({ p }: { p: ConflictPayload }) {
  return (
    <>
      {p.resolutions.map((r, i) => (
        <div className={CAND} key={i}>
          <div className={CAND_TEXT}>{r.candidate}</div>
          <div className="flex flex-wrap items-center gap-4">
            <span className={`${RELATION} ${relTone(r.relation)}`}>{r.relation}</span>
            <span className={`${RELATION} ${relTone(r.action)}`}>{r.action}</span>
            {r.cosine != null && (
              <span className={Q}>cos {r.cosine.toFixed(4)}</span>
            )}
          </div>
          {r.neighbour && (
            <div className={Q}>
              vs &ldquo;{r.neighbour}&rdquo;
              {r.neighbour_id ? ` (${shortId(r.neighbour_id)})` : ""}
            </div>
          )}
          {r.reason && <div className={REASON}>{r.reason}</div>}
          <LlmLine llm={r.llm} />
        </div>
      ))}
    </>
  );
}

// status -> a small colored dot, so retrieval shows WHAT it pulled, not just how well
function statusDot(status: string): string {
  switch (status) {
    case "active":
      return "bg-success";
    case "updated":
      return "bg-warning";
    case "superseded":
      return "bg-accent";
    default:
      return "bg-faint";
  }
}

// text tone to pair with the dot so the status is legible, not just a 6px colour
function statusText(status: string): string {
  switch (status) {
    case "active":
      return "text-success";
    case "updated":
      return "text-warning";
    case "superseded":
      return "text-accent";
    default:
      return "text-faint";
  }
}

function Retrieve({ p }: { p: RetrievePayload }) {
  const cell =
    "grid grid-cols-[22px_1fr_56px_52px_52px] gap-2 items-center px-2 py-1.5";
  const rankedBy = p.reranked
    ? "rerank × decay"
    : p.hybrid
      ? "RRF × decay"
      : "cosine × decay";
  return (
    <>
      <div className={Q}>
        threshold {p.threshold} &middot; ranked by {rankedBy}
        {p.hybrid ? " · hybrid (vec+bm25)" : ""}
      </div>
      {p.retrieved.length === 0 ? (
        <div className={EMPTY_NOTE}>NOTHING ABOVE THRESHOLD</div>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-md border border-border">
          <div className={`${cell} bg-raised border-b border-border [&>span]:font-mono [&>span]:text-label [&>span]:uppercase [&>span]:tracking-[0.06em] [&>span]:text-faint`}>
            <span>#</span>
            <span>MEMORY</span>
            <span className="text-right">COS</span>
            <span className="text-right">DECAY</span>
            <span className="text-right">SCORE</span>
          </div>
          {p.retrieved.map((row) => (
            <button
              className={`${cell} border-b border-border last:border-b-0 text-left transition-colors duration-150 ease-nothing cursor-pointer hover:bg-raised`}
              key={row.memory_id}
              title={`Highlight ${shortId(row.memory_id)} in the memory inspector`}
              onClick={() => store.highlightMemory(row.memory_id)}
            >
              <span className="font-mono text-label text-faint">{row.rank}</span>
              <span className="flex flex-col gap-0.5 min-w-0">
                <span
                  className={`inline-flex items-center gap-1 font-mono text-label uppercase tracking-[0.06em] ${statusText(row.status)}`}
                >
                  <span
                    className={`size-1.5 flex-none rounded-full ${statusDot(row.status)}`}
                  />
                  {row.status}
                </span>
                <span className="font-sans text-caption leading-[1.35] text-primary wrap-anywhere">
                  {row.text}
                </span>
              </span>
              <span className="text-right font-mono text-caption text-primary">
                {row.cosine.toFixed(3)}
              </span>
              <span className="text-right font-mono text-caption text-primary">
                {row.decay.toFixed(3)}
              </span>
              <span className="text-right font-mono text-caption font-bold text-ink">
                {row.score.toFixed(3)}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Reply({ p }: { p: ReplyPayload }) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>Memories Fed To Reply</span>
        {p.used_memory_ids.length === 0 ? (
          <span className={EMPTY_NOTE}>NONE</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {p.used_memory_ids.map((id) => (
              <button
                className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-label text-primary transition-colors duration-150 ease-nothing cursor-pointer hover:border-ink hover:text-ink"
                key={id}
                title={`Highlight ${id} in the memory inspector`}
                onClick={() => store.highlightMemory(id)}
              >
                {shortId(id)}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>Reply Preview</span>
        <span className="font-sans text-body-sm leading-[1.4] text-primary">
          {p.reply_preview}
        </span>
      </div>
      <LlmLine llm={p.llm} />
    </>
  );
}

function StageBlock({ stage, trace }: { stage: TraceStage; trace?: Trace }) {
  const Icon = STAGE_ICON[stage];
  const headName =
    "inline-flex items-center gap-1.5 font-mono text-caption uppercase tracking-[0.1em] font-bold text-ink [&_svg]:size-[13px] [&_svg]:text-muted";

  if (!trace) {
    return (
      <div className="border-b border-border animate-fade">
        <div className="flex items-center gap-2 bg-raised px-6 py-3">
          <span className="font-mono text-label text-faint">
            {STAGE_ORDER.indexOf(stage) + 1}
          </span>
          <span className={headName}>
            <Icon strokeWidth={1.5} />
            {stage}
          </span>
          <span className="ml-auto font-mono text-label tracking-[0.06em] text-faint">
            SKIPPED
          </span>
        </div>
      </div>
    );
  }

  let body: ReactNode = null;
  switch (stage) {
    case "extract":
      body = <Extract p={trace.payload as ExtractPayload} />;
      break;
    case "dedup":
      body = <Dedup p={trace.payload as DedupPayload} />;
      break;
    case "conflict":
      body = <Conflict p={trace.payload as ConflictPayload} />;
      break;
    case "retrieve":
      body = <Retrieve p={trace.payload as RetrievePayload} />;
      break;
    case "reply":
      body = <Reply p={trace.payload as ReplyPayload} />;
      break;
  }

  return (
    <div className="border-b border-border animate-fade">
      <div className="flex items-center gap-2 border-b border-border bg-raised px-6 py-3">
        <span className="font-mono text-label text-faint">
          {STAGE_ORDER.indexOf(stage) + 1}
        </span>
        <span className={headName}>
          <Icon strokeWidth={1.5} />
          {stage}
        </span>
      </div>
      <div className="flex flex-col gap-4 px-6 py-4 bg-surface">{body}</div>
    </div>
  );
}

export function TraceDrawer() {
  const selected = useSelectedMessageId();
  const turnSeq = useTurnSeq();
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) {
      setTraces([]);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    getTraces(selected)
      .then((t) => live && setTraces(t))
      .catch(
        (e: unknown) =>
          live && setError(e instanceof Error ? e.message : "failed to load trace"),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [selected, turnSeq]);

  const byStage = new Map<TraceStage, Trace>();
  for (const t of traces) byStage.set(t.stage, t);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-raised">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-ink tracking-[-0.01em] [&_svg]:size-4.5 [&_svg]:text-ink">
          <Workflow strokeWidth={2.25} />
          Pipeline Trace
        </span>
        <span className="font-mono text-label uppercase text-faint">
          {selected ? shortId(selected) : "NO TURN"}
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-slim">
        {!selected ? (
          <div className="px-6 py-4 font-mono text-body-sm tracking-[0.06em] text-faint">
            [NO TURN SELECTED] — send a message or click a [MEMORIES USED] badge.
          </div>
        ) : error ? (
          <div className="px-6 py-4 font-mono text-body-sm tracking-[0.06em] text-accent">
            [TRACE UNAVAILABLE: {error}]
          </div>
        ) : loading && traces.length === 0 ? (
          <div className="px-6 py-4 font-mono text-body-sm tracking-[0.06em] text-faint">
            [LOADING TRACE...]
          </div>
        ) : (
          STAGE_ORDER.map((stage) => (
            <StageBlock key={stage} stage={stage} trace={byStage.get(stage)} />
          ))
        )}
      </div>
    </div>
  );
}
