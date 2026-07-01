import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Save, X } from "lucide-react";
import { getSettings, patchSettings, resetSettings } from "../api";
import type { SettingSpec, SettingValue, SettingsResponse } from "../types";

// Runtime config editor. Reads config.SETTINGS_SPEC from the backend and renders a
// grouped form; only changed fields are PATCHed. Changes persist server-side and
// take effect on the next pipeline call — no restart.
export function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    getSettings()
      .then((d) => {
        if (!live) return;
        setData(d);
        setDraft({ ...d.values });
      })
      .catch(
        (e: unknown) =>
          live && setError(e instanceof Error ? e.message : "failed to load settings"),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button, textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open, onClose]);

  const groups = useMemo(() => {
    if (!data) return [] as [string, SettingSpec[]][];
    const g: Record<string, SettingSpec[]> = {};
    for (const s of data.spec) (g[s.group] ??= []).push(s);
    return Object.entries(g);
  }, [data]);

  const dirty = useMemo(() => {
    const out: Record<string, SettingValue> = {};
    if (!data) return out;
    for (const s of data.spec)
      if (draft[s.key] !== data.values[s.key]) out[s.key] = draft[s.key];
    return out;
  }, [draft, data]);
  const dirtyCount = Object.keys(dirty).length;

  const isDefault = useMemo(() => {
    if (!data) return true;
    return data.spec.every((s) => data.values[s.key] === data.defaults[s.key]);
  }, [data]);

  function setNum(s: SettingSpec, raw: string) {
    if (raw === "") return; // ignore transient empty; keep last valid
    const v = s.type === "int" ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isNaN(v)) setDraft((d) => ({ ...d, [s.key]: v }));
    setSaved(false);
  }

  async function commit(fn: () => Promise<Record<string, SettingValue>>) {
    setBusy(true);
    setError(null);
    try {
      const values = await fn();
      setData((d) => (d ? { ...d, values } : d));
      setDraft({ ...values });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const LABEL = "font-mono text-label uppercase text-muted";
  const NUM_INPUT =
    "w-24 border border-border bg-raised px-2 py-1 text-right font-mono text-body-sm text-ink outline-none focus:border-muted disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 animate-fade"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="flex max-h-[82vh] w-full max-w-170 flex-col border border-border bg-surface shadow-lg outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex-none flex items-stretch justify-between border-b border-border">
          <span className="flex items-center gap-3 px-6 py-4 font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
            Settings
            {dirtyCount > 0 && (
              <span className="rounded border border-warning px-1.5 py-0.5 font-mono text-label uppercase text-warning">
                {dirtyCount} unsaved
              </span>
            )}
          </span>
          <button
            className="flex items-center justify-center self-stretch border-l border-border px-5 text-muted transition-colors duration-150 ease-nothing hover:bg-accent hover:text-surface [&_svg]:size-4.5"
            onClick={onClose}
            title="Close"
          >
            <X strokeWidth={1.5} />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto scroll-slim px-6 py-5">
          {loading && !data ? (
            <div className={`${LABEL} inline-flex items-center gap-2`}>
              <Loader2 strokeWidth={1.5} className="size-3.5 animate-spin" />
              LOADING…
            </div>
          ) : error && !data ? (
            <div className="font-mono text-body-sm text-accent">[ERROR: {error}]</div>
          ) : data ? (
            <div className="flex flex-col gap-6">
              {groups.map(([group, specs]) => (
                <section key={group} className="flex flex-col">
                  <h3 className="mb-2 border-b border-border pb-1 font-mono text-label uppercase tracking-[0.06em] text-faint">
                    {group}
                  </h3>
                  <div className="flex flex-col">
                    {specs.map((s) => (
                      <div
                        key={s.key}
                        className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0"
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="font-sans text-body-sm font-medium text-ink">
                            {s.label}
                          </span>
                          <span className="font-sans text-caption leading-[1.35] text-muted">
                            {s.help}
                          </span>
                        </div>
                        {s.type === "bool" ? (
                          <button
                            role="switch"
                            aria-checked={draft[s.key] === true}
                            aria-label={s.label}
                            disabled={busy}
                            onClick={() => {
                              setDraft((d) => ({ ...d, [s.key]: !d[s.key] }));
                              setSaved(false);
                            }}
                            className={`flex-none rounded border px-3 py-1 font-mono text-label uppercase transition-colors duration-150 ease-nothing disabled:opacity-50 ${draft[s.key]
                              ? "border-success text-success"
                              : "border-line text-faint"
                              }`}
                          >
                            {draft[s.key] ? "ON" : "OFF"}
                          </button>
                        ) : (
                          <input
                            type="number"
                            aria-label={s.label}
                            className={NUM_INPUT}
                            value={String(draft[s.key] ?? "")}
                            min={s.min}
                            max={s.max}
                            step={s.step}
                            disabled={busy}
                            onChange={(e) => setNum(s, e.target.value)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}

              {data.info.length > 0 && (
                <section className="flex flex-col">
                  <h3 className="mb-2 border-b border-border pb-1 font-mono text-label uppercase tracking-[0.06em] text-faint">
                    Fixed
                  </h3>
                  <div className="flex flex-col">
                    {data.info.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0"
                      >
                        <span className="font-sans text-body-sm text-muted">
                          {f.label}
                        </span>
                        <span className="font-mono text-body-sm text-faint wrap-anywhere">
                          {f.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : null}
        </div>

        <footer className="flex-none flex items-center justify-between gap-4 border-t border-border px-6 py-3">
          <div className="min-w-0 font-mono text-label uppercase">
            {error && data ? (
              <span className="text-accent wrap-anywhere">{error}</span>
            ) : saved && dirtyCount === 0 ? (
              <span className="text-success">Saved</span>
            ) : (
              <span className="text-faint">Applies on the next turn</span>
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            <button
              onClick={() => commit(resetSettings)}
              disabled={busy || !data || isDefault}
              className="inline-flex items-center gap-1.5 border border-border px-3 py-1.5 font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing hover:bg-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3"
              title="Restore code defaults"
            >
              <RotateCcw strokeWidth={1.5} />
              Reset
            </button>
            <button
              onClick={() => commit(() => patchSettings(dirty))}
              disabled={busy || dirtyCount === 0}
              className="inline-flex items-center gap-1.5 bg-ink px-4 py-1.5 font-mono text-label uppercase text-surface transition-opacity duration-150 ease-nothing hover:opacity-80 disabled:cursor-default disabled:bg-raised disabled:text-faint [&_svg]:size-3"
            >
              {busy ? (
                <Loader2 strokeWidth={1.5} className="size-3 animate-spin" />
              ) : (
                <Save strokeWidth={1.5} />
              )}
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
