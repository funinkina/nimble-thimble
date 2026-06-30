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
      memory_events: [],
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

function ChatColumn({ conversationId }: { conversationId: string }) {
  const [initial, setInitial] = useState<ThreadMessageLike[] | null>(null);

  useEffect(() => {
    let live = true;
    setInitial(null);
    getConversationMessages(conversationId)
      .then((msgs) => live && setInitial(msgs.map(toThreadMessage)))
      .catch(() => live && setInitial([]));
    return () => {
      live = false;
    };
  }, [conversationId]);

  if (initial === null) {
    return (
      <section className="pane">
        <div className="trace-empty">[LOADING CHAT...]</div>
      </section>
    );
  }
  return <ChatRuntime key={conversationId} initialMessages={initial} />;
}

export default function App() {
  const conversationId = useSelectedConversationId();

  return (
    <div className="app">
      <ConversationSidebar />
      {conversationId ? (
        <ChatColumn key={conversationId} conversationId={conversationId} />
      ) : (
        <section className="pane">
          <div className="trace-empty">[LOADING...]</div>
        </section>
      )}
      <MemoryPanel />
      <InspectorPane />
    </div>
  );
}
