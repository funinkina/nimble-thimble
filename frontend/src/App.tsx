import { useEffect, useRef, useState } from "react";
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { chatAdapter } from "./runtime";
import { getConversationMessages } from "./api";
import { useSelectedConversationId } from "./store";
import { ChatPane } from "./components/ChatPane";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { MemoryPanel } from "./components/MemoryPanel";
import { InspectorPane } from "./components/InspectorPane";
import type { RestoredMessage, TurnMeta } from "./types";

function toThreadMessage(m: RestoredMessage): ThreadMessageLike {
  if (m.role === "assistant" && m.turn_message_id) {
    const meta: TurnMeta = {
      message_id: m.turn_message_id,
      retrieved: m.retrieved,
      memory_events: m.memory_events ?? [],
    };
    return {
      role: "assistant",
      content: [{ type: "text", text: m.content }],
      id: m.id,
      metadata: { custom: meta as unknown as Record<string, unknown> },
    };
  }
  return { role: m.role, content: [{ type: "text", text: m.content }], id: m.id };
}

// Owns the assistant-ui runtime for one conversation. Seeded with the restored
// history via initialMessages; remounted (keyed by id in App) on chat switch.
function ChatRuntime({ initialMessages }: { initialMessages: ThreadMessageLike[] }) {
  const runtime = useLocalRuntime(chatAdapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatPane />
    </AssistantRuntimeProvider>
  );
}

const PANE_PLACEHOLDER = "flex flex-col min-h-0 min-w-0 border-r border-line bg-page";
const PLACEHOLDER_TEXT = "m-4 font-mono text-body-sm tracking-[0.06em] text-faint";

function ChatColumn({ conversationId }: { conversationId: string }) {
  const [initial, setInitial] = useState<ThreadMessageLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setInitial(null);
    setError(null);
    getConversationMessages(conversationId)
      .then((msgs) => live && setInitial(msgs.map(toThreadMessage)))
      .catch(
        (e: unknown) =>
          live && setError(e instanceof Error ? e.message : "failed to load chat"),
      );
    return () => {
      live = false;
    };
  }, [conversationId, attempt]);

  if (error !== null) {
    return (
      <section className={PANE_PLACEHOLDER}>
        <div className="m-4 flex flex-col items-start gap-3">
          <div className={PLACEHOLDER_TEXT}>[COULD NOT LOAD CHAT: {error}]</div>
          <button
            className="border border-border px-3 py-1.5 font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing hover:bg-raised hover:text-ink"
            onClick={() => setAttempt((a) => a + 1)}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (initial === null) {
    return (
      <section className={PANE_PLACEHOLDER}>
        <div className={PLACEHOLDER_TEXT}>[LOADING CHAT...]</div>
      </section>
    );
  }
  return <ChatRuntime key={conversationId} initialMessages={initial} />;
}

// Sidebar is fixed (collapsible); chat + memory carry user-set pixel widths and the
// inspector flexes to fill the rest. Interior drag handles resize the two boundaries.
const SIDEBAR_W = 240; // expanded
const COLLAPSED_W = 52;
const INSPECTOR_MIN = 360;
const LIMITS = { chat: [320, 720], memory: [340, 780] } as const;
const DEFAULT_WIDTHS = { chat: 440, memory: 540 };

type Widths = { chat: number; memory: number };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

function loadWidths(): Widths {
  try {
    const s = JSON.parse(localStorage.getItem("paneWidths") ?? "");
    if (s && typeof s.chat === "number" && typeof s.memory === "number") {
      return { chat: s.chat, memory: s.memory };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_WIDTHS };
}

function ResizeHandle({
  x,
  onDown,
  label,
}: {
  x: number;
  onDown: (e: React.PointerEvent) => void;
  label: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onDown}
      className="group absolute top-0 bottom-0 z-30 flex w-2 -translate-x-1/2 cursor-col-resize touch-none justify-center"
      style={{ left: x }}
    >
      <div className="h-full w-px bg-transparent transition-colors duration-150 ease-nothing group-hover:bg-interactive group-active:bg-interactive" />
    </div>
  );
}

export default function App() {
  const conversationId = useSelectedConversationId();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );
  const [widths, setWidths] = useState<Widths>(loadWidths);
  const gridRef = useRef<HTMLDivElement>(null);
  const sidebarW = collapsed ? COLLAPSED_W : SIDEBAR_W;

  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem("paneWidths", JSON.stringify(widths));
  }, [widths]);

  useEffect(() => {
    const fit = () => {
      const total = gridRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const avail = total - sidebarW - INSPECTOR_MIN;
      setWidths((w) => {
        let chat = Math.min(w.chat, LIMITS.chat[1]);
        let memory = Math.min(w.memory, LIMITS.memory[1]);
        if (chat + memory > avail) {
          memory = Math.max(LIMITS.memory[0], avail - chat);
          if (chat + memory > avail) chat = Math.max(LIMITS.chat[0], avail - memory);
        }
        return chat === w.chat && memory === w.memory ? w : { chat, memory };
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [sidebarW]);

  function startDrag(which: "chat" | "memory", e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const start = { ...widths };
    const total = gridRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      setWidths(() => {
        if (which === "chat") {
          const hi = Math.min(LIMITS.chat[1], total - sidebarW - start.memory - INSPECTOR_MIN);
          return { ...start, chat: clamp(start.chat + delta, LIMITS.chat[0], hi) };
        }
        const hi = Math.min(LIMITS.memory[1], total - sidebarW - start.chat - INSPECTOR_MIN);
        return { ...start, memory: clamp(start.memory + delta, LIMITS.memory[0], hi) };
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const template = `${sidebarW}px ${widths.chat}px ${widths.memory}px minmax(${INSPECTOR_MIN}px, 1fr)`;

  return (
    <div
      ref={gridRef}
      className="relative grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: template }}
    >
      <ConversationSidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />
      {conversationId ? (
        <ChatColumn key={conversationId} conversationId={conversationId} />
      ) : (
        <section className={PANE_PLACEHOLDER}>
          <div className={PLACEHOLDER_TEXT}>[LOADING...]</div>
        </section>
      )}
      <MemoryPanel />
      <InspectorPane />

      <ResizeHandle
        x={sidebarW + widths.chat}
        onDown={(e) => startDrag("chat", e)}
        label="Resize chat pane"
      />
      <ResizeHandle
        x={sidebarW + widths.chat + widths.memory}
        onDown={(e) => startDrag("memory", e)}
        label="Resize memory pane"
      />
    </div>
  );
}
