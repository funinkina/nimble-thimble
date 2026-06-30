import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Pencil,
  Trash2,
  X,
  EyeOff,
} from "lucide-react";
import { deleteMemory, getMemoryRevisions, patchMemory } from "../api";
import {
  store,
  useHighlightedMemoryId,
  useHighlightNonce,
  useLastEvents,
  useTouchedIds,
} from "../store";
import type { Memory, MemoryEventType, MemoryRevision } from "../types";

type ActionState =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "ok"; label: string }
  | { kind: "err"; label: string };

const LABEL = "font-mono text-label uppercase text-muted";
const TAG = "rounded border bg-surface px-2 py-[3px] font-mono text-label uppercase whitespace-nowrap";
const STATUS_TAG: Record<string, string> = {
  active: "border-success text-success",
  updated: "border-warning text-warning",
  superseded: "border-accent text-accent",
  forgotten: "border-line text-faint",
};
const CHANGE_TAG: Record<string, string> = {
  created: "border-success text-success",
  refined: "border-warning text-warning",
  superseded: "border-accent text-accent",
  reinforced: "border-line text-muted",
  edited: "border-line text-muted",
  forgotten: "border-line text-faint",
};
const ACT_STATUS_TONE = { busy: "text-faint", ok: "text-success", err: "text-accent" };
// Per-event marking for cards touched this turn: a left border + a chip, in the
// event's color. Matches the inspector/chip palette elsewhere.
const EVENT_BORDER: Record<MemoryEventType, string> = {
  created: "border-l-success",
  updated: "border-l-warning",
  superseded: "border-l-accent",
  duplicate: "border-l-line",
  forgotten: "border-l-faint",
};
const EVENT_CHIP: Record<MemoryEventType, string> = {
  created: "border-success text-success",
  updated: "border-warning text-warning",
  superseded: "border-accent text-accent",
  duplicate: "border-line text-muted",
  forgotten: "border-line text-faint",
};
// Full-width, equal-thirds action buttons. border-r divides them; last has none.
const BTN = "flex items-center justify-center gap-1.5 py-3 font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing border-r border-border last:border-r-0 hover:bg-raised hover:text-primary disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent disabled:hover:text-faint [&_svg]:size-[13px]";

function decayFill(d: number): string {
  if (d > 0.6) return "bg-success";
  if (d >= 0.3) return "bg-warning";
  return "bg-accent";
}

function fmtConf(c: number | null): string {
  return c == null ? "—" : c.toFixed(2);
}

export function MemoryCard({ mem }: { mem: Memory }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mem.text);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<MemoryRevision[] | null>(null);
  const [flashing, setFlashing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const highlightedId = useHighlightedMemoryId();
  const highlightNonce = useHighlightNonce();
  const touchedIds = useTouchedIds();
  const lastEvents = useLastEvents();
  const touched = touchedIds.has(mem.id);
  // The event that touched this card this turn (latest wins if several share id).
  let touchedEvent: MemoryEventType | null = null;
  if (touched) {
    for (let i = lastEvents.length - 1; i >= 0; i--) {
      if (lastEvents[i].memory_id === mem.id) {
        touchedEvent = lastEvents[i].type;
        break;
      }
    }
  }

  useEffect(() => {
    if (highlightedId !== mem.id) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), 700);
    return () => window.clearTimeout(t);
  }, [highlightedId, highlightNonce, mem.id]);

  // Flash once when this card first becomes touched by a new turn. Keyed on the
  // identity of touchedIds (a fresh Set per pushTurn), so it re-fires each turn.
  useEffect(() => {
    if (!touched) return;
    setFlashing(true);
    const t = window.setTimeout(() => setFlashing(false), 700);
    return () => window.clearTimeout(t);
  }, [touchedIds, touched]);

  useEffect(() => {
    if (!showHistory || revisions) return;
    let live = true;
    getMemoryRevisions(mem.id)
      .then((r) => live && setRevisions(r))
      .catch(() => live && setRevisions([]));
    return () => {
      live = false;
    };
  }, [showHistory, revisions, mem.id]);

  // a new write bumps revision_count; drop the cache so the timeline refetches
  useEffect(() => {
    setRevisions(null);
  }, [mem.revision_count]);

  const flash = (kind: "ok" | "err", label: string) => {
    setAction({ kind, label });
    window.setTimeout(() => setAction({ kind: "idle" }), 1800);
  };

  async function saveEdit() {
    const next = draft.trim();
    if (!next || next === mem.text) {
      setEditing(false);
      setDraft(mem.text);
      return;
    }
    setAction({ kind: "busy", label: "SAVING" });
    try {
      await patchMemory(mem.id, { text: next });
      setEditing(false);
      store.bumpTurn();
      flash("ok", "SAVED");
    } catch {
      flash("err", "ERROR");
    }
  }

  async function forget() {
    setAction({ kind: "busy", label: "FORGETTING" });
    try {
      await patchMemory(mem.id, { forget: true });
      store.bumpTurn();
      flash("ok", "FORGOTTEN");
    } catch {
      flash("err", "ERROR");
    }
  }

  async function remove() {
    setAction({ kind: "busy", label: "DELETING" });
    try {
      await deleteMemory(mem.id);
      store.bumpTurn();
      // card disappears on the parent's refetch; show nothing further
    } catch {
      flash("err", "ERROR");
    }
  }

  const decay = mem.decay_score;
  const busy = action.kind === "busy";

  return (
    <article
      ref={ref}
      className={`flex flex-col border-b border-border bg-surface animate-fade transition-colors duration-300 ease-nothing ${touchedEvent ? `border-l-2 ${EVENT_BORDER[touchedEvent]}` : ""
        } ${flashing ? "bg-raised ring-2 ring-inset ring-accent" : ""}`}
    >
      <div className="flex flex-col gap-4 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          {editing ? (
            <textarea
              className="w-full resize-y rounded-md border border-line bg-raised p-2 font-sans text-body leading-[1.45] text-ink outline-none min-h-[60px] focus:border-muted"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(mem.text);
                }
              }}
            />
          ) : (
            <>
              <div className="flex-1 font-sans text-body font-medium leading-[1.45] text-ink">
                {mem.text}
              </div>
              <div className="flex flex-none flex-wrap items-center justify-end gap-2">
                {touchedEvent && (
                  <span
                    className={`${TAG} ${EVENT_CHIP[touchedEvent]}`}
                    title="Changed by the latest turn"
                  >
                    {touchedEvent}
                  </span>
                )}
                <span className={`${TAG} border-line text-muted`}>
                  {mem.scope.replace("_", " ")}
                </span>
                <span
                  className={`${TAG} ${STATUS_TAG[mem.status] ?? "border-line text-muted"}`}
                >
                  {mem.status}
                </span>
              </div>
            </>
          )}
        </div>

        {(mem.supersedes_id || mem.superseded_by) && (
          <div className="flex flex-wrap items-center gap-2">
            {mem.supersedes_id && (
              <button
                className="inline-flex items-center gap-1 rounded border border-line bg-raised px-2 py-[3px] font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing cursor-pointer hover:border-ink hover:text-ink"
                onClick={() => store.highlightMemory(mem.supersedes_id!)}
                title="Jump to the memory this one replaced"
              >
                ← replaces {mem.supersedes_id.slice(0, 8)}
              </button>
            )}
            {mem.superseded_by && (
              <button
                className="inline-flex items-center gap-1 rounded border border-accent bg-raised px-2 py-[3px] font-mono text-label uppercase text-accent transition-colors duration-150 ease-nothing cursor-pointer hover:opacity-70"
                onClick={() => store.highlightMemory(mem.superseded_by!)}
                title="Jump to the memory that replaced this one"
              >
                replaced by {mem.superseded_by.slice(0, 8)} →
              </button>
            )}
          </div>
        )}

        {mem.source_excerpt && (
          <div className="flex flex-col gap-[3px]">
            <span className={LABEL}>Evidence</span>
            <span className="border-l-2 border-line pl-2 font-mono text-caption text-primary">
              &ldquo;{mem.source_excerpt}&rdquo;
            </span>
          </div>
        )}

        {mem.reason && (
          <div className="flex flex-col gap-[3px]">
            <span className={LABEL}>Why</span>
            <span className="font-sans text-body-sm leading-[1.45] text-muted">
              {mem.reason}
            </span>
          </div>
        )}

        {mem.revision_count > 1 && (
          <div className="flex flex-col gap-2">
            <button
              className={`inline-flex items-center cursor-pointer gap-1.5 self-start rounded border px-2.5 py-1 font-mono text-label uppercase transition-colors duration-150 ease-nothing [&_svg]:size-[13px] ${showHistory
                ? "border-ink bg-raised text-primary"
                : "border-line bg-raised text-primary hover:border-ink hover:bg-surface hover:text-ink"
                }`}
              onClick={() => setShowHistory((s) => !s)}
            >
              {showHistory ? (
                <ChevronDown strokeWidth={1.5} />
              ) : (
                <ChevronRight strokeWidth={1.5} />
              )}
              <History strokeWidth={1.5} />
              HISTORY ({mem.revision_count})
            </button>
            {showHistory && (
              <ol className="flex flex-col gap-2 border-l border-line pl-3">
                {revisions === null ? (
                  <li className="font-mono text-label uppercase text-faint">Loading…</li>
                ) : (
                  [...revisions].reverse().map((rev) => (
                    <li key={rev.id} className="flex flex-col gap-1 animate-fade">
                      <div className="flex items-center gap-2">
                        <span
                          className={`${TAG} ${CHANGE_TAG[rev.change_type] ?? "border-line text-muted"}`}
                        >
                          {rev.change_type}
                        </span>
                        <span className="font-mono text-label text-faint">
                          {new Date(rev.created_at).toLocaleString()}
                        </span>
                      </div>
                      {rev.old_text && rev.old_text !== rev.new_text && (
                        <div className="font-sans text-body-sm leading-[1.4] text-faint line-through">
                          {rev.old_text}
                        </div>
                      )}
                      {rev.new_text && (
                        <div className="font-sans text-body-sm leading-[1.4] text-muted">
                          {rev.new_text}
                        </div>
                      )}
                      {rev.old_confidence !== rev.new_confidence && (
                        <div className="font-mono text-label text-faint">
                          conf {fmtConf(rev.old_confidence)} → {fmtConf(rev.new_confidence)}
                        </div>
                      )}
                    </li>
                  ))
                )}
              </ol>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-6">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-label uppercase text-faint">Confidence</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-raised">
                <span
                  className="block h-full bg-muted"
                  style={{ width: `${Math.round(mem.confidence * 100)}%` }}
                />
              </span>
              <span className="font-mono text-body-sm tracking-[0.04em] text-primary">
                {mem.confidence.toFixed(2)}
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-label uppercase text-faint">Used</span>
            <span className="font-mono text-body-sm tracking-[0.04em] text-primary">
              {mem.use_count}&times;
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-[5px]">
          <div className="flex items-baseline justify-between">
            <span className={LABEL}>Decay</span>
            <span className="font-mono text-label text-muted">{decay.toFixed(3)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className={`h-full rounded-full transition-[width] duration-[250ms] ease-nothing ${decayFill(decay)}`}
              style={{ width: `${Math.round(decay * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {action.kind !== "idle" && (
        <div
          className={`flex justify-end px-6 py-1.5 font-mono text-label uppercase animate-fade ${ACT_STATUS_TONE[action.kind]}`}
        >
          [{action.label}
          {action.kind === "busy" ? "..." : ""}]
        </div>
      )}

      <div className="grid grid-flow-col auto-cols-fr border-t border-border">
        {editing ? (
          <>
            <button className={BTN} onClick={saveEdit} disabled={busy}>
              <Check strokeWidth={1.5} />
              SAVE
            </button>
            <button
              className={BTN}
              onClick={() => {
                setEditing(false);
                setDraft(mem.text);
              }}
              disabled={busy}
            >
              <X strokeWidth={1.5} />
              CANCEL
            </button>
          </>
        ) : (
          <>
            <button
              className={`${BTN} hover:cursor-pointer`}
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <Pencil strokeWidth={1.5} />
              EDIT
            </button>
            {mem.status !== "forgotten" && (
              <button className={`${BTN} hover:cursor-pointer`} onClick={forget} disabled={busy}>
                <EyeOff strokeWidth={1.5} />
                FORGET
              </button>
            )}
            <button
              className={`${BTN} hover:text-accent hover:bg-red-400 hover:cursor-pointer`}
              onClick={remove}
              disabled={busy}
            >
              <Trash2 strokeWidth={1.5} />
              DELETE
            </button>
          </>
        )}
      </div>
    </article>
  );
}
