import { useEffect, useState } from "react";
import { getMetrics } from "../api";
import { useTurnSeq } from "../store";
import type { Metrics } from "../types";

const STATUS_ORDER = ["active", "updated", "superseded", "forgotten"];
const SCOPE_ORDER = ["user_profile", "preference", "fact", "context"];

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
  const keys = order.filter((k) => k in data).concat(
    Object.keys(data).filter((k) => !order.includes(k)),
  );
  const max = Math.max(1, ...keys.map((k) => data[k] ?? 0));
  return (
    <div className="dist">
      <span className="label">{title}</span>
      {keys.length === 0 ? (
        <span className="empty-note">NONE YET</span>
      ) : (
        keys.map((k) => {
          const n = data[k] ?? 0;
          return (
            <div className="dist-row" key={k}>
              <span className="dist-key">{k.replace("_", " ")}</span>
              <span className="dist-track">
                <span
                  className={`dist-fill${colorByKey ? ` status-${k}` : ""}`}
                  style={{ width: `${Math.round((n / max) * 100)}%` }}
                />
              </span>
              <span className="dist-n">{n}</span>
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
    <div className="metric">
      <span className="label">{label}</span>
      <span className={`metric-val${tone ? ` ${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export function MetricsBar() {
  const turnSeq = useTurnSeq();
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getMetrics()
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
  }, [turnSeq]);

  const active = m?.memories_by_status.active ?? 0;

  return (
    <div className="metrics">
      <div className="hero">
        <span className="hero-num">{m ? active : "--"}</span>
        <span className="hero-label">ACTIVE MEMORIES</span>
      </div>

      {error ? (
        <div className="empty-note">[METRICS ERROR: {error}]</div>
      ) : !m ? (
        <div className="empty-note">[LOADING...]</div>
      ) : (
        <>
          <div className="stat-grid">
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
            <Metric
              label="AVG COSINE"
              value={m.avg_retrieval_cosine.toFixed(3)}
            />
            <Metric
              label="TOK IN/OUT"
              value={`${m.llm_input_tokens}/${m.llm_output_tokens}`}
            />
            <Metric
              label="AVG LAT"
              value={`${m.avg_llm_latency_ms}MS`}
            />
          </div>

          <Dist
            title="BY STATUS"
            data={m.memories_by_status}
            order={STATUS_ORDER}
            colorByKey
          />
          <Dist
            title="BY SCOPE"
            data={m.memories_by_scope}
            order={SCOPE_ORDER}
          />
        </>
      )}
    </div>
  );
}
