import { useState } from "react";
import { Check, GitBranch, Pencil, Trash2, X, EyeOff } from "lucide-react";
import { deleteMemory, patchMemory } from "../api";
import { store } from "../store";
import type { Memory } from "../types";

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
const ACT = "inline-flex items-center gap-[5px] font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing disabled:cursor-default disabled:text-faint [&_svg]:size-[13px]";
const ACT_STATUS_TONE = { busy: "text-faint", ok: "text-success", err: "text-accent" };

function decayFill(d: number): string {
  if (d > 0.6) return "bg-success";
  if (d >= 0.3) return "bg-warning";
  return "bg-accent";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function MemoryCard({ mem }: { mem: Memory }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mem.text);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

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
    <article className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 animate-fade">
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
          <div className="font-sans text-body font-medium leading-[1.45] text-ink">
            {mem.text}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={`${TAG} border-line text-muted`}>
          {mem.scope.replace("_", " ")}
        </span>
        <span className={`${TAG} ${STATUS_TAG[mem.status] ?? "border-line text-muted"}`}>
          {mem.status}
        </span>
      </div>

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

      {(mem.supersedes_id || mem.superseded_by) && (
        <div className="flex flex-col gap-[3px]">
          {mem.superseded_by && (
            <div className="flex items-center gap-1.5 font-mono text-label tracking-[0.06em] text-muted [&_svg]:size-3 [&_svg]:text-faint">
              <GitBranch strokeWidth={1.5} />
              REPLACED BY{" "}
              <span className="text-accent">{shortId(mem.superseded_by)}</span>
            </div>
          )}
          {mem.supersedes_id && (
            <div className="flex items-center gap-1.5 font-mono text-label tracking-[0.06em] text-muted [&_svg]:size-3 [&_svg]:text-faint">
              <GitBranch strokeWidth={1.5} />
              REPLACES <span className="text-primary">{shortId(mem.supersedes_id)}</span>
            </div>
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

      <div className="flex items-center gap-4 border-t border-border pt-2">
        {editing ? (
          <>
            <button className={`${ACT} hover:text-primary`} onClick={saveEdit} disabled={busy}>
              <Check strokeWidth={1.5} />
              SAVE
            </button>
            <button
              className={`${ACT} hover:text-primary`}
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
              className={`${ACT} hover:text-primary`}
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <Pencil strokeWidth={1.5} />
              EDIT
            </button>
            {mem.status !== "forgotten" && (
              <button className={`${ACT} hover:text-primary`} onClick={forget} disabled={busy}>
                <EyeOff strokeWidth={1.5} />
                FORGET
              </button>
            )}
            <button className={`${ACT} hover:text-accent`} onClick={remove} disabled={busy}>
              <Trash2 strokeWidth={1.5} />
              DELETE
            </button>
          </>
        )}
        {action.kind !== "idle" && (
          <span
            className={`ml-auto font-mono text-label uppercase animate-fade ${ACT_STATUS_TONE[action.kind]}`}
          >
            [{action.label}
            {action.kind === "busy" ? "..." : ""}]
          </span>
        )}
      </div>
    </article>
  );
}
