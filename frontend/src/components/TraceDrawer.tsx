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

function shortId(id: string): string {
  return id.slice(0, 8);
}

function LlmLine({ llm }: { llm: LlmMeta | undefined }) {
  if (!llm) return null;
  return (
    <div className="llm-line">
      <span>
        <b>MODEL</b> {llm.model}
      </span>
      <span>
        <b>IN</b> {llm.input_tokens}
      </span>
      <span>
        <b>OUT</b> {llm.output_tokens}
      </span>
      <span>
        <b>LAT</b> {llm.latency_ms}MS
      </span>
    </div>
  );
}

function Extract({ p }: { p: ExtractPayload }) {
  return (
    <>
      {p.candidates.length === 0 ? (
        <div className="empty-note">NO CANDIDATES — TREATED AS CHIT-CHAT</div>
      ) : (
        p.candidates.map((c, i) => (
          <div className="cand" key={i}>
            <div className="cand-text">{c.text}</div>
            <div className="cand-meta">
              <span className="relation">{c.scope.replace("_", " ")}</span>
              <span className="kv-line q">
                conf {c.confidence.toFixed(2)}
              </span>
            </div>
            <div className="kv-line q">&ldquo;{c.source_excerpt}&rdquo;</div>
          </div>
        ))
      )}
      {p.forget_request && (
        <div className="kv">
          <span className="label">Forget Request</span>
          <span className="kv-line">{p.forget_request}</span>
          {p.forget_resolution && (
            <span className="reason">{p.forget_resolution}</span>
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
        <div className="cand" key={i}>
          <div className="cand-text">{d.candidate}</div>
          <div className="cand-meta">
            <span className="relation rel-duplicate">DUPLICATE</span>
            <span className="kv-line q">cos {d.cosine.toFixed(4)}</span>
          </div>
          <div className="kv-line q">vs &ldquo;{d.neighbour}&rdquo;</div>
          <div className="reason">{d.reason}</div>
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
        <div className="cand" key={i}>
          <div className="cand-text">{r.candidate}</div>
          <div className="cand-meta">
            <span className={`relation rel-${r.relation}`}>{r.relation}</span>
            <span className={`relation act-${r.action}`}>{r.action}</span>
            {r.cosine != null && (
              <span className="kv-line q">cos {r.cosine.toFixed(4)}</span>
            )}
          </div>
          {r.neighbour && (
            <div className="kv-line q">
              vs &ldquo;{r.neighbour}&rdquo;
              {r.neighbour_id ? ` (${shortId(r.neighbour_id)})` : ""}
            </div>
          )}
          {r.reason && <div className="reason">{r.reason}</div>}
          <LlmLine llm={r.llm} />
        </div>
      ))}
    </>
  );
}

function Retrieve({ p }: { p: RetrievePayload }) {
  return (
    <>
      <div className="kv-line q">
        threshold {p.threshold} &middot; ranked by cosine &times; decay
      </div>
      {p.retrieved.length === 0 ? (
        <div className="empty-note">NOTHING ABOVE THRESHOLD</div>
      ) : (
        <div className="rtable">
          <div className="rtable-head">
            <span>#</span>
            <span>MEMORY</span>
            <span className="rt-head-num">COS</span>
            <span className="rt-head-num">DECAY</span>
            <span className="rt-head-num">SCORE</span>
          </div>
          {p.retrieved.map((row) => (
            <div className="rtable-row" key={row.memory_id}>
              <span className="rt-rank">{row.rank}</span>
              <span className="rt-text">{row.text}</span>
              <span className="rt-num">{row.cosine.toFixed(3)}</span>
              <span className="rt-num">{row.decay.toFixed(3)}</span>
              <span className="rt-num score">{row.score.toFixed(3)}</span>
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
      <div className="kv">
        <span className="label">Memories Fed To Reply</span>
        {p.used_memory_ids.length === 0 ? (
          <span className="empty-note">NONE</span>
        ) : (
          <span className="idlist">
            {p.used_memory_ids.map((id) => (
              <span className="idchip" key={id}>
                {shortId(id)}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="kv">
        <span className="label">Reply Preview</span>
        <span className="kv-line">{p.reply_preview}</span>
      </div>
      <LlmLine llm={p.llm} />
    </>
  );
}

function StageBlock({ stage, trace }: { stage: TraceStage; trace?: Trace }) {
  const Icon = STAGE_ICON[stage];
  if (!trace) {
    return (
      <div className="stage">
        <div className="stage-head">
          <span className="stage-idx">
            {STAGE_ORDER.indexOf(stage) + 1}
          </span>
          <span className="stage-name">
            <Icon strokeWidth={1.5} />
            {stage}
          </span>
          <span className="stage-meta">SKIPPED</span>
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
    <div className="stage hot">
      <div className="stage-head">
        <span className="stage-idx">{STAGE_ORDER.indexOf(stage) + 1}</span>
        <span className="stage-name">
          <Icon strokeWidth={1.5} />
          {stage}
        </span>
        <ArrowDownToLine
          strokeWidth={1.5}
          style={{ width: 12, height: 12, color: "var(--text-disabled)" }}
        />
      </div>
      <div className="stage-body">{body}</div>
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
    <div className="trace">
      <div className="pane-head" style={{ padding: 0, border: "none" }}>
        <span className="pane-title" style={{ fontSize: "var(--fs-body)" }}>
          Pipeline Trace
        </span>
        <span className="pane-sub">
          {selected ? shortId(selected) : "NO TURN"}
        </span>
      </div>

      {!selected ? (
        <div className="trace-empty">
          [NO TURN SELECTED] — send a message or click a [MEMORIES USED] badge.
        </div>
      ) : loading && traces.length === 0 ? (
        <div className="trace-empty">[LOADING TRACE...]</div>
      ) : (
        STAGE_ORDER.map((stage) => (
          <StageBlock key={stage} stage={stage} trace={byStage.get(stage)} />
        ))
      )}
    </div>
  );
}
