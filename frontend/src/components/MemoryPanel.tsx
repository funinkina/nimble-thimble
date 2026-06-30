import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, ChevronDown, Loader2, Search, X } from "lucide-react";
import { getMemories, searchMemories } from "../api";
import {
  store,
  useHighlightedMemoryId,
  useHighlightNonce,
  useLastEvents,
  useSelectedConversationId,
  useTouchedIds,
  useTurnSeq,
} from "../store";
import type { Memory, MemoryEventType, MemoryStatus, Scope } from "../types";
import { MemoryCard } from "./MemoryCard";

// "What changed this turn" strip: one row per memory_event. Glyph + colored
// label + truncated detail, clickable to flash the card. Mono labels, thin
// tick, no filled blocks — colour rides the text/border per Nothing tokens.
const EVENT_GLYPH: Record<MemoryEventType, string> = {
  created: "+",
  updated: "~",
  superseded: "!",
  duplicate: "=",
  forgotten: "x",
};
const EVENT_STRIP_TONE: Record<MemoryEventType, string> = {
  created: "border-l-success text-success",
  updated: "border-l-warning text-warning",
  superseded: "border-l-accent text-accent",
  duplicate: "border-l-line text-muted",
  forgotten: "border-l-faint text-faint",
};

function ChangedStrip() {
  const events = useLastEvents();
  if (events.length === 0) return null;
  return (
    <div className="flex-none flex flex-col border-b border-border bg-surface animate-fade">
      <span className="px-6 pt-3 pb-1 font-mono text-label uppercase text-faint">
        Changed this turn ({events.length})
      </span>
      <div className="flex flex-col">
        {events.map((e, i) => (
          <button
            key={`${e.memory_id}-${i}`}
            className={`flex items-baseline border-l-2 px-6 py-1.5 text-left transition-colors duration-150 ease-nothing cursor-pointer hover:bg-raised ${EVENT_STRIP_TONE[e.type]}`}
            title={`Highlight ${e.memory_id.slice(0, 8)} in the inspector`}
            onClick={() => store.highlightMemory(e.memory_id)}
          >
            <span className="w-3 flex-none text-center font-mono text-body-sm">
              {EVENT_GLYPH[e.type]}
            </span>
            <span className="w-[84px] flex-none font-mono text-label uppercase">
              {e.type}
            </span>
            <span className="min-w-0 flex-1 truncate font-sans text-body-sm leading-[1.4] text-muted">
              {e.detail}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
  const touchedIds = useTouchedIds();
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [scope, setScope] = useState<Scope | "all">("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searching = query.trim().length > 0;
  // A debounce is pending when the typed query hasn't reached the effect yet; a
  // search is "busy" while typing OR while its request is in flight. We never show
  // "no results" until it's fully settled, so partial-word states don't flash empty.
  const pending = query.trim() !== debounced.trim();
  const searchBusy = searching && (pending || loading);

  // Debounce the search box so each keystroke doesn't fire a request.
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query), 180);
    return () => window.clearTimeout(t);
  }, [query]);

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
    const q = debounced.trim();
    const started = performance.now();
    // Keep the search spinner up for at least this long so a fast response can't
    // flash "no results" before the eye registers it was even searching.
    const minMs = q ? 300 : 0;
    const load = q
      ? searchMemories(conversationId, q)
      : getMemories(
        conversationId,
        status === "all" ? undefined : status,
        scope === "all" ? undefined : scope,
      );
    load
      .then((m) => {
        if (!live) return;
        setMemories(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => {
        if (!live) return;
        const wait = Math.max(0, minMs - (performance.now() - started));
        window.setTimeout(() => live && setLoading(false), wait);
      });
    return () => {
      live = false;
    };
  }, [status, scope, debounced, turnSeq, conversationId]);

  // Float cards touched this turn to the top; stable within each group so the
  // server's existing order is otherwise preserved.
  const ordered = useMemo(() => {
    if (touchedIds.size === 0) return memories;
    const hit: Memory[] = [];
    const rest: Memory[] = [];
    for (const m of memories) (touchedIds.has(m.id) ? hit : rest).push(m);
    return hit.length ? [...hit, ...rest] : memories;
  }, [memories, touchedIds]);

  return (
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-raised">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-ink tracking-[-0.01em] [&_svg]:size-[18px] [&_svg]:text-ink">
          <Brain strokeWidth={2.25} />
          Memory
        </span>
        <span className="font-mono text-label uppercase text-faint">
          {memories.length} SHOWN
        </span>
      </header>

      <div className="flex items-center gap-2 border-b border-border bg-surface px-6 py-2.5">
        <Search strokeWidth={1.5} className="size-3.5 flex-none text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all memories…"
          className="min-w-0 flex-1 bg-transparent font-sans text-body-sm text-ink outline-none placeholder:text-faint"
        />
        {searchBusy ? (
          <Loader2
            strokeWidth={1.5}
            className="size-3.5 flex-none animate-spin text-muted"
          />
        ) : query ? (
          <button
            onClick={() => setQuery("")}
            title="Clear search"
            className="flex-none text-faint transition-colors duration-150 ease-nothing hover:text-primary [&_svg]:size-3.5"
          >
            <X strokeWidth={1.5} />
          </button>
        ) : null}
      </div>

      <div
        className={`grid grid-cols-[auto_1fr_auto_1fr] border-b border-border transition-opacity duration-150 ${searching ? "pointer-events-none opacity-40" : ""
          }`}
        title={searching ? "Filters are ignored while searching" : undefined}
      >
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

      <ChangedStrip />

      <div className="flex-1 min-h-0 overflow-y-auto scroll-slim">
        {error ? (
          <div className="p-6">
            <div className={EMPTY}>[ERROR: {error}]</div>
          </div>
        ) : searchBusy && memories.length === 0 ? (
          <div className="p-6">
            <div className={`${EMPTY} inline-flex items-center gap-2`}>
              <Loader2 strokeWidth={1.5} className="size-3.5 animate-spin" />
              [SEARCHING...]
            </div>
          </div>
        ) : loading && memories.length === 0 ? (
          <div className="p-6">
            <div className={EMPTY}>[LOADING...]</div>
          </div>
        ) : memories.length === 0 ? (
          <div className="p-6">
            <div className={EMPTY}>
              {searching
                ? `[NO MATCHES] — nothing matches “${debounced.trim()}”.`
                : status !== "all" || scope !== "all"
                  ? "[NO MATCHES] — no memory matches this filter."
                  : "[NO MEMORIES] — start chatting to build some."}
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {ordered.map((m) => (
              <MemoryCard key={m.id} mem={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
