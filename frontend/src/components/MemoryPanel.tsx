import { useEffect, useState } from "react";
import { getMemories } from "../api";
import { useSelectedConversationId, useTurnSeq } from "../store";
import type { Memory, MemoryStatus, Scope } from "../types";
import { MemoryCard } from "./MemoryCard";

const STATUS_FILTERS: { key: MemoryStatus | "all"; label: string }[] = [
  { key: "all", label: "ALL" },
  { key: "active", label: "ACTIVE" },
  { key: "updated", label: "UPDATED" },
  { key: "superseded", label: "SUPERSEDED" },
  { key: "forgotten", label: "FORGOTTEN" },
];

const SCOPE_FILTERS: { key: Scope | "all"; label: string }[] = [
  { key: "all", label: "ALL" },
  { key: "user_profile", label: "PROFILE" },
  { key: "preference", label: "PREFERENCE" },
  { key: "fact", label: "FACT" },
  { key: "context", label: "CONTEXT" },
];

export function MemoryPanel() {
  const turnSeq = useTurnSeq();
  const conversationId = useSelectedConversationId();
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [scope, setScope] = useState<Scope | "all">("all");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setMemories([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    getMemories(
      conversationId,
      status === "all" ? undefined : status,
      scope === "all" ? undefined : scope,
    )
      .then((m) => {
        if (!live) return;
        setMemories(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [status, scope, turnSeq, conversationId]);

  return (
    <section className="pane">
      <header className="pane-head">
        <span className="pane-title">Memory</span>
        <span className="pane-sub">{memories.length} SHOWN</span>
      </header>

      <div className="filters">
        <div className="chip-row">
          <span className="label">Status</span>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip${status === f.key ? " active" : ""}`}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="chip-row">
          <span className="label">Scope</span>
          {SCOPE_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip${scope === f.key ? " active" : ""}`}
              onClick={() => setScope(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="pane-body">
        {error ? (
          <div className="card-list">
            <div className="trace-empty">[ERROR: {error}]</div>
          </div>
        ) : loading && memories.length === 0 ? (
          <div className="card-list">
            <div className="trace-empty">[LOADING...]</div>
          </div>
        ) : memories.length === 0 ? (
          <div className="card-list">
            <div className="trace-empty">
              [NO MEMORIES] — start chatting to build some.
            </div>
          </div>
        ) : (
          <div className="card-list">
            {memories.map((m) => (
              <MemoryCard key={m.id} mem={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
