import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, Brain } from "lucide-react";
import { store, useSelectedMessageId } from "../store";
import type { TurnMeta } from "../types";

function MarkdownText() {
  return <MarkdownTextPrimitive className="msg-body" />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg user">
      <div className="msg-role">YOU</div>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    </MessagePrimitive.Root>
  );
}

function Thinking() {
  const running = useMessage((m) => m.status?.type === "running");
  const hasText = useMessage((m) =>
    m.content.some((p) => p.type === "text" && p.text.length > 0),
  );
  if (!running || hasText) return null;
  return <div className="thinking">[THINKING...]</div>;
}

function MemoryBadge() {
  const selected = useSelectedMessageId();
  const meta = useMessage(
    (m) => m.metadata?.custom as unknown as TurnMeta | undefined,
  );
  const running = useMessage((m) => m.status?.type === "running");
  if (running || !meta) return null;

  const n = meta.retrieved.length;
  const isSel = selected === meta.message_id;
  return (
    <button
      className={`mem-badge${isSel ? " selected" : ""}${n === 0 ? " zero" : ""}`}
      onClick={() => store.selectMessage(meta.message_id)}
      title="Show this turn's pipeline trace"
    >
      <Brain strokeWidth={1.5} />
      {n} {n === 1 ? "MEMORY" : "MEMORIES"} USED
    </button>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="msg assistant">
      <div className="msg-role">ASSISTANT</div>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      <Thinking />
      <MemoryBadge />
    </MessagePrimitive.Root>
  );
}

export function ChatPane() {
  return (
    <section className="pane">
      <header className="pane-head">
        <span className="pane-title">Chat</span>
        <span className="pane-sub">Inspectable Memory</span>
      </header>
      <ThreadPrimitive.Root className="thread-root">
        <ThreadPrimitive.Viewport className="thread-viewport">
          <ThreadPrimitive.Empty>
            <div className="thread-empty">
              <div className="big">Talk to a model that remembers.</div>
              <div>
                Tell it facts, preferences, or who you are. Watch memories form,
                update, and supersede in real time.
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder="Send a message..."
            autoFocus
            rows={1}
          />
          <ComposerPrimitive.Send className="composer-send">
            SEND
            <ArrowUp strokeWidth={1.5} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </section>
  );
}
