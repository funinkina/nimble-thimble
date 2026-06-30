import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowUp, Bot, Brain, MessageSquare, User } from "lucide-react";
import { store, useSelectedMessageId } from "../store";
import type { TurnMeta } from "../types";

// Color is set on the message Root and inherited; this only shapes the
// markdown-rendered HTML (paragraphs, lists, code, links) via child variants.
const MARKDOWN =
  "text-body leading-[1.55] [&_p]:m-0 [&_p]:mb-2 [&_p:last-child]:mb-0 " +
  "[&_ul]:my-2 [&_ol]:my-2 [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-0.5 " +
  "[&_code]:font-mono [&_code]:text-body-sm [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:rounded " +
  "[&_pre]:bg-raised [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md [&_pre]:p-4 [&_pre]:overflow-x-auto " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_a]:text-interactive [&_a]:no-underline [&_a:hover]:underline";

const ROLE_LABEL =
  "inline-flex items-center gap-1.5 font-mono text-label uppercase [&_svg]:size-3";

function MarkdownText() {
  return <MarkdownTextPrimitive className={MARKDOWN} />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-2 border-b border-border bg-page px-6 py-4 animate-fade text-ink">
      <div className={`${ROLE_LABEL} text-muted`}>
        <User strokeWidth={1.5} />
        YOU
      </div>
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
  return (
    <div className="font-mono text-body-sm tracking-[0.08em] text-faint animate-pulse-soft">
      [THINKING...]
    </div>
  );
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
  const tone = isSel
    ? "border-ink text-ink"
    : `border-line ${n === 0 ? "text-faint" : "text-muted"} hover:border-muted hover:text-primary`;
  return (
    <button
      className={`inline-flex flex-none items-center gap-1.5 rounded border bg-surface px-2 py-[3px] font-mono text-label cursor-pointer uppercase transition-colors duration-150 ease-nothing [&_svg]:size-3 ${tone}`}
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
    <MessagePrimitive.Root className="flex flex-col gap-2 border-b border-border bg-surface px-6 py-4 animate-fade text-primary">
      <div className="flex items-center justify-between gap-3">
        <div className={`${ROLE_LABEL} text-faint`}>ASSISTANT</div>
        <MemoryBadge />
      </div>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      <Thinking />
    </MessagePrimitive.Root>
  );
}

export function ChatPane() {
  return (
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border">
        <span className="font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
          Chat
        </span>
        <span className="font-mono text-label uppercase text-faint">
          Inspectable Memory
        </span>
      </header>
      <ThreadPrimitive.Root className="flex flex-col h-full min-h-0">
        <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col">
          <ThreadPrimitive.Empty>
            <div className="m-auto max-w-[320px] p-6 text-center text-faint">
              <div className="mb-2 font-sans text-heading font-bold tracking-[-0.01em] text-muted">
                Talk to a model that remembers.
              </div>
              <div className="text-body">
                Tell it facts, preferences, or who you are. Watch memories form,
                update, and supersede in real time.
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="flex-none flex items-end gap-4 border-t border-border bg-surface px-6 py-4">
          <ComposerPrimitive.Input
            className="flex-1 resize-none border-none bg-transparent font-sans text-body leading-normal text-primary outline-none max-h-40 min-h-6 placeholder:text-faint"
            placeholder="Send a message..."
            autoFocus
            rows={1}
          />
          <ComposerPrimitive.Send className="flex-none inline-flex items-center gap-1.5 rounded-md bg-ink px-4 py-2 font-mono text-label uppercase text-surface transition-opacity duration-150 ease-nothing hover:opacity-80 disabled:cursor-default disabled:bg-raised disabled:text-faint [&_svg]:size-[13px]">
            SEND
            <ArrowUp strokeWidth={1.5} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </section>
  );
}
