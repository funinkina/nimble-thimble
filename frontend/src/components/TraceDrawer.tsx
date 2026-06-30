import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  GitMerge,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react";
import { getTraces } from "../api";
import { useSelectedMessageId, useTurnSeq } from "../store";
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
          <div className={Q}>vs &ldquo;{d.neighbour}&rdquo;</div>
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

function Retrieve({ p }: { p: RetrievePayload }) {
  const cell = "grid grid-cols-[22px_1fr_56px_52px_52px] gap-2 items-center px-2 py-1.5";
  return (
    <>
      <div className={Q}>
        threshold {p.threshold} &middot; ranked by cosine &times; decay
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
            <div className={`${cell} border-b border-border last:border-b-0`} key={row.memory_id}>
              <span className="font-mono text-label text-faint">{row.rank}</span>
              <span className="font-sans text-caption leading-[1.35] text-primary [overflow-wrap:anywhere]">
                {row.text}
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
            </div>
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
              <span
                className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-label text-primary"
                key={id}
              >
                {shortId(id)}
              </span>
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
      <div className="rounded-lg border border-border bg-surface overflow-hidden animate-fade">
        <div className="flex items-center gap-2 border-b border-border bg-raised px-4 py-2">
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
    <div className="rounded-lg border border-line bg-surface overflow-hidden animate-fade">
      <div className="flex items-center gap-2 border-b border-border bg-raised px-4 py-2">
        <span className="font-mono text-label text-faint">
          {STAGE_ORDER.indexOf(stage) + 1}
        </span>
        <span className={headName}>
          <Icon strokeWidth={1.5} />
          {stage}
        </span>
        <ArrowDownToLine strokeWidth={1.5} className="ml-auto size-3 text-faint" />
      </div>
      <div className="flex flex-col gap-4 p-4">{body}</div>
    </div>
  );
}

export function TraceDrawer() {
  const selected = useSelectedMessageId();
  const turnSeq = useTurnSeq();
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) {
      setTraces([]);
      return;
    }
    let live = true;
    setLoading(true);
    getTraces(selected)
      .then((t) => live && setTraces(t))
      .catch(() => live && setTraces([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [selected, turnSeq]);

  const byStage = new Map<TraceStage, Trace>();
  for (const t of traces) byStage.set(t.stage, t);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col gap-4 p-6">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-sans text-body font-bold tracking-[-0.01em] text-ink">
          Pipeline Trace
        </span>
        <span className="font-mono text-label uppercase text-faint">
          {selected ? shortId(selected) : "NO TURN"}
        </span>
      </div>

      {!selected ? (
        <div className="my-4 font-mono text-body-sm tracking-[0.06em] text-faint">
          [NO TURN SELECTED] — send a message or click a [MEMORIES USED] badge.
        </div>
      ) : loading && traces.length === 0 ? (
        <div className="my-4 font-mono text-body-sm tracking-[0.06em] text-faint">
          [LOADING TRACE...]
        </div>
      ) : (
        STAGE_ORDER.map((stage) => (
          <StageBlock key={stage} stage={stage} trace={byStage.get(stage)} />
        ))
      )}
    </div>
  );
}
