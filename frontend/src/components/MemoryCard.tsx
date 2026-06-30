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

function decayClass(d: number): string {
  if (d > 0.6) return "high";
  if (d >= 0.3) return "mid";
  return "low";
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
    <article className="card">
      <div className="card-top">
        {editing ? (
          <div className="card-text editing">
            <textarea
              className="edit-area"
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
          </div>
        ) : (
          <div className="card-text">{mem.text}</div>
        )}
      </div>

      <div className="card-chips">
        <span className="tag">{mem.scope.replace("_", " ")}</span>
        <span className={`tag status-${mem.status}`}>{mem.status}</span>
      </div>

      {mem.source_excerpt && (
        <div className="field evidence">
          <span className="label">Evidence</span>
          <span className="field-val">&ldquo;{mem.source_excerpt}&rdquo;</span>
        </div>
      )}

      {mem.reason && (
        <div className="field">
          <span className="label">Why</span>
          <span className="field-val">{mem.reason}</span>
        </div>
      )}

      {(mem.supersedes_id || mem.superseded_by) && (
        <div className="field">
          {mem.superseded_by && (
            <div className="lineage superseded">
              <GitBranch strokeWidth={1.5} />
              REPLACED BY{" "}
              <span className="ref">{shortId(mem.superseded_by)}</span>
            </div>
          )}
          {mem.supersedes_id && (
            <div className="lineage">
              <GitBranch strokeWidth={1.5} />
              REPLACES <span className="ref">{shortId(mem.supersedes_id)}</span>
            </div>
          )}
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <span className="label">Confidence</span>
          <span className="confidence-bar">
            <span className="conf-track">
              <span
                className="conf-fill"
                style={{ width: `${Math.round(mem.confidence * 100)}%` }}
              />
            </span>
            <span className="stat-val">{mem.confidence.toFixed(2)}</span>
          </span>
        </div>
        <div className="stat">
          <span className="label">Used</span>
          <span className="stat-val">{mem.use_count}&times;</span>
        </div>
      </div>

      <div className="decay">
        <div className="decay-head">
          <span className="label">Decay</span>
          <span className="decay-val">{decay.toFixed(3)}</span>
        </div>
        <div className="decay-track">
          <div
            className={`decay-fill ${decayClass(decay)}`}
            style={{ width: `${Math.round(decay * 100)}%` }}
          />
        </div>
      </div>

      <div className="card-actions">
        {editing ? (
          <>
            <button className="act" onClick={saveEdit} disabled={busy}>
              <Check strokeWidth={1.5} />
              SAVE
            </button>
            <button
              className="act"
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
              className="act"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <Pencil strokeWidth={1.5} />
              EDIT
            </button>
            {mem.status !== "forgotten" && (
              <button className="act" onClick={forget} disabled={busy}>
                <EyeOff strokeWidth={1.5} />
                FORGET
              </button>
            )}
            <button className="act danger" onClick={remove} disabled={busy}>
              <Trash2 strokeWidth={1.5} />
              DELETE
            </button>
          </>
        )}
        {action.kind === "busy" && (
          <span className="act-status busy">[{action.label}...]</span>
        )}
        {action.kind === "ok" && (
          <span className="act-status ok">[{action.label}]</span>
        )}
        {action.kind === "err" && (
          <span className="act-status err">[{action.label}]</span>
        )}
      </div>
    </article>
  );
}
