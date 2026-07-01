import { useEffect, useRef, useState } from "react";
import { getMetrics } from "../api";
import { useSelectedConversationId, useTurnSeq } from "../store";
import type { Metrics } from "../types";

// The count fields we annotate with a per-turn delta.
const DELTA_KEYS = [
  "active",
  "superseded",
  "updated",
  "dedup",
  "forgotten",
  "llm_calls",
] as const;
type DeltaKey = (typeof DELTA_KEYS)[number];
type Deltas = Partial<Record<DeltaKey, number>>;

// Pull the annotated counts out of a /metrics payload into one flat shape. Each
// key reads the exact field its cell displays, so the delta matches the number.
function countsOf(m: Metrics): Record<DeltaKey, number> {
  return {
    active: m.memories_by_status.active ?? 0,
    superseded: m.supersede_count,
    updated: m.update_count,
    dedup: m.dedup_count,
    forgotten: m.forgotten_count,
    llm_calls: m.llm_calls,
  };
}

// Resting states only. No row ever rests in "updated" (update folds in place and
// stays active), so the bar omits it — the UPDATES *count* lives in the grid
// below as a transition counter. Keeps bar + grid from contradicting.
const STATUS_ORDER = ["active", "superseded", "forgotten"];
const SCOPE_ORDER = ["user_profile", "preference", "fact", "context"];

const LABEL = "font-mono text-label uppercase text-muted";
const TONE = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
} as const;

function distFill(k: string): string {
  if (k === "active") return "bg-success";
  if (k === "updated") return "bg-warning";
  if (k === "superseded" || k === "forgotten") return "bg-accent";
  return "bg-primary";
}

function Dist({
  title,
  data,
  order,
  colorByKey,
  exclude,
}: {
  title: string;
  data: Record<string, number>;
  order: string[];
  colorByKey?: boolean;
  // Keys to drop even if the backend reports them (e.g. "updated" — not a resting
  // state). Restricts both the legend and the max normalization.
  exclude?: string[];
}) {
  const drop = new Set(exclude);
  const keys = order
    .filter((k) => !drop.has(k) && k in data)
    .concat(Object.keys(data).filter((k) => !order.includes(k) && !drop.has(k)));
  const max = Math.max(1, ...keys.map((k) => data[k] ?? 0));
  return (
    <div className="flex flex-col gap-2">
      <span className="font-sans font-bold text-label uppercase tracking-[0.08em] text-ink">
        {title}
      </span>
      {keys.length === 0 ? (
        <span className="font-mono text-caption tracking-[0.04em] text-faint">
          NONE YET
        </span>
      ) : (
        keys.map((k) => {
          const n = data[k] ?? 0;
          // Non-zero but tiny segments would round to 0% against a big max; floor
          // them at a visible sliver so present-but-small statuses stay legible.
          const pct = n === 0 ? 0 : Math.max(6, Math.round((n / max) * 100));
          return (
            <div className="flex items-center gap-2" key={k}>
              <span className="w-24 flex-none font-mono text-label uppercase text-muted">
                {k.replace("_", " ")}
              </span>
              <span className="flex-1 h-1.5 overflow-hidden rounded-full bg-raised">
                <span
                  className={`block h-full ${colorByKey ? distFill(k) : "bg-primary"}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-7 flex-none text-right font-mono text-label text-primary">
                {n}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  delta,
}: {
  label: string;
  value: string | number;
  tone?: "accent" | "success" | "warning";
  // Change since the previous turn. Rendered as a small signed annotation; only
  // shown when non-zero (and absent on first load — no prior snapshot).
  delta?: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1.25">
      <span className={LABEL}>{label}</span>
      <span className="inline-flex items-baseline gap-1.5">
        {delta != null && delta !== 0 && (
          <span
            className={`font-mono text-label tracking-[0.04em] ${delta > 0 ? "text-success" : "text-accent"}`}
            title="Change since last turn"
          >
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
        <span
          className={`font-mono text-body-sm tracking-[0.03em] ${tone ? TONE[tone] : "text-primary"}`}
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function MetricsBar() {
  const turnSeq = useTurnSeq();
  const conversationId = useSelectedConversationId();
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deltas, setDeltas] = useState<Deltas>({});
  // Previous turn's counts, for delta annotations. Per conversation — reset on
  // switch so a new chat doesn't inherit the old one's baseline.
  const prevCounts = useRef<Record<DeltaKey, number> | null>(null);

  useEffect(() => {
    prevCounts.current = null;
    setDeltas({});
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    getMetrics(conversationId)
      .then((data) => {
        if (!live) return;
        const next = countsOf(data);
        const prev = prevCounts.current;
        // First load (no prior snapshot) annotates nothing; otherwise diff this
        // turn against the last, reflecting only the most recent change.
        if (prev) {
          const d: Deltas = {};
          for (const k of DELTA_KEYS) d[k] = next[k] - prev[k];
          setDeltas(d);
        } else {
          setDeltas({});
        }
        prevCounts.current = next;
        setM(data);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "failed");
      });
    return () => {
      live = false;
    };
  }, [turnSeq, conversationId]);

  const active = m?.memories_by_status.active ?? 0;

  return (
    <div className="flex-[0_1_auto] max-h-[48vh] overflow-y-auto scroll-slim flex flex-col gap-6 border-b border-border bg-surface p-6">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
        <div className="flex flex-none flex-col gap-1">
          <span className="inline-flex items-baseline gap-2">
            <span className="font-display text-hero font-bold text-ink">
              {m ? active : "--"}
            </span>
            {deltas.active != null && deltas.active !== 0 && (
              <span
                className={`font-mono text-body-sm tracking-[0.04em] ${deltas.active > 0 ? "text-success" : "text-accent"}`}
                title="Change since last turn"
              >
                {deltas.active > 0 ? `+${deltas.active}` : deltas.active}
              </span>
            )}
          </span>
          <span className="font-mono text-label uppercase tracking-widest text-muted">
            ACTIVE MEMORIES
          </span>
        </div>
        {m && (
          <div className="flex flex-1 min-w-50 flex-col gap-4">
            <Dist
              title="BY STATUS"
              data={m.memories_by_status}
              order={STATUS_ORDER}
              colorByKey
              exclude={["updated"]}
            />
            <Dist title="BY SCOPE" data={m.memories_by_scope} order={SCOPE_ORDER} />
          </div>
        )}
      </div>

      {error ? (
        <div className="font-mono text-caption tracking-[0.04em] text-faint">
          [METRICS ERROR: {error}]
        </div>
      ) : !m ? (
        <div className="font-mono text-caption tracking-[0.04em] text-faint">
          [LOADING...]
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Metric label="MESSAGES" value={m.total_user_messages} />
          <Metric label="CANDIDATES" value={m.total_candidates} />
          <Metric
            label="UPDATES"
            value={m.update_count}
            tone={m.update_count ? "warning" : undefined}
            delta={deltas.updated}
          />
          <Metric
            label="SUPERSEDES"
            value={m.supersede_count}
            tone={m.supersede_count ? "accent" : undefined}
            delta={deltas.superseded}
          />
          <Metric label="DEDUPED" value={m.dedup_count} delta={deltas.dedup} />
          <Metric
            label="FORGOTTEN"
            value={m.forgotten_count}
            tone={m.forgotten_count ? "accent" : undefined}
            delta={deltas.forgotten}
          />
          <Metric label="LLM CALLS" value={m.llm_calls} delta={deltas.llm_calls} />
          <Metric label="AVG COSINE" value={m.avg_retrieval_cosine.toFixed(3)} />
          <Metric
            label="TOK IN/OUT"
            value={`${m.llm_input_tokens}/${m.llm_output_tokens}`}
          />
          <Metric label="AVG LAT" value={`${m.avg_llm_latency_ms}MS`} />
        </div>
      )}
    </div>
  );
}
