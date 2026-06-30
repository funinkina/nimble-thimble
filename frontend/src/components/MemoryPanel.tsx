import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { getMemories } from "../api";
import {
  useHighlightedMemoryId,
  useHighlightNonce,
  useSelectedConversationId,
  useTurnSeq,
} from "../store";
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

const SELECT =
  "w-full appearance-none cursor-pointer bg-surface px-4 py-3 pr-9 font-mono text-label uppercase text-muted outline-none transition-colors duration-150 ease-nothing hover:text-primary focus:text-ink [&>option]:bg-surface [&>option]:text-ink";
const FILTER_NAME =
  "flex items-center border-r border-border px-6 py-3 font-mono text-label uppercase text-ink";
const EMPTY = "font-mono text-body-sm tracking-[0.06em] text-faint";

export function MemoryPanel() {
  const turnSeq = useTurnSeq();
  const conversationId = useSelectedConversationId();
  const highlightedId = useHighlightedMemoryId();
  const highlightNonce = useHighlightNonce();
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [scope, setScope] = useState<Scope | "all">("all");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // When a trace id is *clicked* (nonce bumps), if the target card is hidden by a
  // filter, drop the filters so it renders. Gated on the nonce so it fires only on
  // the click itself — never when the user later narrows a filter to empty results.
  const lastHighlight = useRef(highlightNonce);
  useEffect(() => {
    if (highlightNonce === lastHighlight.current) return;
    lastHighlight.current = highlightNonce;
    if (!highlightedId || memories.some((m) => m.id === highlightedId)) return;
    setStatus("all");
    setScope("all");
  }, [highlightNonce, highlightedId, memories]);

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
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-gray-900">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-surface tracking-[-0.01em] [&_svg]:size-[18px] [&_svg]:text-surface">
          <Brain strokeWidth={2.25} />
          Memory
        </span>
        <span className="font-mono text-label uppercase text-surface/50">
          {memories.length} SHOWN
        </span>
      </header>

      <div className="grid grid-cols-[auto_1fr_auto_1fr] border-b border-border">
        <span className={FILTER_NAME}>Status</span>
        <div className="relative border-r border-border">
          <select
            className={SELECT}
            value={status}
            onChange={(e) => setStatus(e.target.value as MemoryStatus | "all")}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <ChevronDown
            strokeWidth={1.5}
            className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-faint"
          />
        </div>
        <span className={FILTER_NAME}>Scope</span>
        <div className="relative">
          <select
            className={SELECT}
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope | "all")}
          >
            {SCOPE_FILTERS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <ChevronDown
            strokeWidth={1.5}
            className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-faint"
          />
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
            <div className={EMPTY}>
              {status !== "all" || scope !== "all"
                ? "[NO MATCHES] — no memory matches this filter."
                : "[NO MEMORIES] — start chatting to build some."}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {memories.map((m) => (
              <MemoryCard key={m.id} mem={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
