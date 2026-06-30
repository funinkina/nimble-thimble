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

const CHIP =
  "rounded-full border px-2 py-1 font-mono text-label uppercase transition-colors duration-150 ease-nothing";
const CHIP_IDLE = "border-line bg-surface text-muted hover:border-muted hover:text-primary";
const CHIP_ACTIVE = "border-ink bg-ink text-surface";
const FILTER_LABEL = "mr-1 font-mono text-label uppercase text-muted";
const EMPTY = "font-mono text-body-sm tracking-[0.06em] text-faint";

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
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border">
        <span className="font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
          Memory
        </span>
        <span className="font-mono text-label uppercase text-faint">
          {memories.length} SHOWN
        </span>
      </header>

      <div className="flex flex-col gap-2 px-6 py-4 border-b border-border bg-page">
        <div className="flex flex-wrap items-center gap-2">
          <span className={FILTER_LABEL}>Status</span>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${CHIP} ${status === f.key ? CHIP_ACTIVE : CHIP_IDLE}`}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={FILTER_LABEL}>Scope</span>
          {SCOPE_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${CHIP} ${scope === f.key ? CHIP_ACTIVE : CHIP_IDLE}`}
              onClick={() => setScope(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-slim">
        {error ? (
          <div className="p-6">
            <div className={EMPTY}>[ERROR: {error}]</div>
          </div>
        ) : loading && memories.length === 0 ? (
          <div className="p-6">
            <div className={EMPTY}>[LOADING...]</div>
          </div>
        ) : memories.length === 0 ? (
          <div className="p-6">
            <div className={EMPTY}>[NO MEMORIES] — start chatting to build some.</div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-6">
            {memories.map((m) => (
              <MemoryCard key={m.id} mem={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
