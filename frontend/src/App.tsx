import { useEffect, useState } from "react";
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

const COLS_EXPANDED =
  "grid-cols-[minmax(200px,0.6fr)_minmax(360px,1.1fr)_minmax(420px,1.4fr)_minmax(380px,1fr)]";
const COLS_COLLAPSED =
  "grid-cols-[52px_minmax(360px,1.1fr)_minmax(420px,1.4fr)_minmax(380px,1fr)]";

export default function App() {
  const conversationId = useSelectedConversationId();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "1",
  );

  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <div
      className={`grid h-screen w-screen overflow-hidden ${collapsed ? COLS_COLLAPSED : COLS_EXPANDED}`}
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
    </div>
  );
}
