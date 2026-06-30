import { useEffect, useState } from "react";
import { getMetrics } from "../api";
import { useSelectedConversationId, useTurnSeq } from "../store";
import type { Metrics } from "../types";

const STATUS_ORDER = ["active", "updated", "superseded", "forgotten"];
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
}: {
  title: string;
  data: Record<string, number>;
  order: string[];
  colorByKey?: boolean;
}) {
  const keys = order
    .filter((k) => k in data)
    .concat(Object.keys(data).filter((k) => !order.includes(k)));
  const max = Math.max(1, ...keys.map((k) => data[k] ?? 0));
  return (
    <div className="flex flex-col gap-2">
      <span className={LABEL}>{title}</span>
      {keys.length === 0 ? (
        <span className="font-mono text-caption tracking-[0.04em] text-faint">
          NONE YET
        </span>
      ) : (
        keys.map((k) => {
          const n = data[k] ?? 0;
          return (
            <div className="flex items-center gap-2" key={k}>
              <span className="w-24 flex-none font-mono text-label uppercase text-muted">
                {k.replace("_", " ")}
              </span>
              <span className="flex-1 h-1.5 overflow-hidden rounded-full bg-raised">
                <span
                  className={`block h-full ${colorByKey ? distFill(k) : "bg-primary"}`}
                  style={{ width: `${Math.round((n / max) * 100)}%` }}
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
}: {
  label: string;
  value: string | number;
  tone?: "accent" | "success" | "warning";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border pb-[5px]">
      <span className={LABEL}>{label}</span>
      <span
        className={`font-mono text-body-sm tracking-[0.03em] ${tone ? TONE[tone] : "text-primary"}`}
      >
        {value}
      </span>
    </div>
  );
}

export function MetricsBar() {
  const turnSeq = useTurnSeq();
  const conversationId = useSelectedConversationId();
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    let live = true;
    getMetrics(conversationId)
      .then((data) => {
        if (!live) return;
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
      <div className="flex flex-col gap-1">
        <span className="font-display text-hero font-bold text-ink">
          {m ? active : "--"}
        </span>
        <span className="font-mono text-label uppercase tracking-[0.1em] text-muted">
          ACTIVE MEMORIES
        </span>
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
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <Metric label="MESSAGES" value={m.total_user_messages} />
            <Metric label="CANDIDATES" value={m.total_candidates} />
            <Metric
              label="UPDATES"
              value={m.update_count}
              tone={m.update_count ? "warning" : undefined}
            />
            <Metric
              label="SUPERSEDES"
              value={m.supersede_count}
              tone={m.supersede_count ? "accent" : undefined}
            />
            <Metric label="DEDUPED" value={m.dedup_count} />
            <Metric
              label="FORGOTTEN"
              value={m.forgotten_count}
              tone={m.forgotten_count ? "accent" : undefined}
            />
            <Metric label="LLM CALLS" value={m.llm_calls} />
            <Metric label="AVG COSINE" value={m.avg_retrieval_cosine.toFixed(3)} />
            <Metric
              label="TOK IN/OUT"
              value={`${m.llm_input_tokens}/${m.llm_output_tokens}`}
            />
            <Metric label="AVG LAT" value={`${m.avg_llm_latency_ms}MS`} />
          </div>

          <Dist
            title="BY STATUS"
            data={m.memories_by_status}
            order={STATUS_ORDER}
            colorByKey
          />
          <Dist title="BY SCOPE" data={m.memories_by_scope} order={SCOPE_ORDER} />
        </>
      )}
    </div>
  );
}
