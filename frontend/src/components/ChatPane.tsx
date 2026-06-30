import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Bot, Brain, MessageSquare, User } from "lucide-react";
import { store, useSelectedMessageId } from "../store";
import type { MemoryEventType, TurnMeta } from "../types";

// Color is set on the message Root and inherited; this only shapes the
// markdown-rendered HTML (paragraphs, lists, code, links) via child variants.
const MARKDOWN =
  "text-body leading-[1.55] [&_p]:m-0 [&_p]:mb-2 [&_p:last-child]:mb-0 " +
  "[&_ul]:my-2 [&_ol]:my-2 [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-0.5 " +
  "[&_code]:font-mono [&_code]:text-body-sm [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:rounded " +
  "[&_pre]:bg-raised [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md [&_pre]:p-4 [&_pre]:overflow-x-auto " +
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_a]:text-interactive [&_a]:no-underline [&_a:hover]:underline " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-body-sm " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-raised [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-bold " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_blockquote]:my-2";

const ROLE_LABEL =
  "inline-flex items-center gap-1.5 font-mono text-label uppercase [&_svg]:size-3";

function MarkdownText() {
  return (
    <MarkdownTextPrimitive className={MARKDOWN} remarkPlugins={[remarkGfm]} />
  );
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

// Per-turn memory changes, surfaced inline so you see what a message DID to
// memory without opening any pane. Order + tone match the inspector.
const EVENT_TONE: Record<MemoryEventType, string> = {
  created: "border-success text-success",
  updated: "border-warning text-warning",
  superseded: "border-accent text-accent",
  duplicate: "border-line text-muted",
  forgotten: "border-line text-faint",
};
const EVENT_ORDER: MemoryEventType[] = [
  "created",
  "updated",
  "superseded",
  "duplicate",
  "forgotten",
];

function EventChips({ meta }: { meta: TurnMeta }) {
  const counts = new Map<MemoryEventType, number>();
  const firstId = new Map<MemoryEventType, string>();
  for (const e of meta.memory_events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    if (!firstId.has(e.type)) firstId.set(e.type, e.memory_id);
  }
  if (counts.size === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {EVENT_ORDER.filter((t) => counts.has(t)).map((t) => (
        <button
          key={t}
          className={`inline-flex items-center gap-1 rounded border bg-surface px-1.5 py-0.5 font-mono text-label uppercase cursor-pointer transition-opacity duration-150 ease-nothing hover:opacity-70 ${EVENT_TONE[t]}`}
          title={`Highlight a ${t} memory from this turn`}
          onClick={() => store.highlightMemory(firstId.get(t)!)}
        >
          {counts.get(t)} {t}
        </button>
      ))}
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
    <div className="relative flex-none group">
      <button
        className={`inline-flex items-center gap-1.5 rounded border bg-surface px-2 py-[3px] font-mono text-label cursor-pointer uppercase transition-colors duration-150 ease-nothing [&_svg]:size-3 ${tone}`}
        onClick={() => store.selectMessage(meta.message_id)}
        title="Show this turn's pipeline trace"
      >
        <Brain strokeWidth={1.5} />
        {n} {n === 1 ? "MEMORY" : "MEMORIES"} USED
      </button>
      {n > 0 && (
        // Provenance popover: the actual memories behind this reply, no pane hop.
        <div className="absolute right-0 top-full z-10 mt-1 hidden w-[300px] flex-col gap-1 rounded-md border border-line bg-surface p-2 shadow-[0_4px_16px_rgba(0,0,0,0.08)] group-hover:flex">
          <div className="px-1 pb-1 font-mono text-label uppercase text-faint">
            Memories behind this reply
          </div>
          {meta.retrieved.map((r) => (
            <button
              key={r.memory_id}
              className="flex items-start gap-2 rounded px-1 py-1 text-left transition-colors duration-150 ease-nothing hover:bg-raised"
              onClick={() => store.highlightMemory(r.memory_id)}
              title="Highlight in the memory inspector"
            >
              <span className="font-mono text-label text-faint">{r.rank}</span>
              <span className="flex-1 font-sans text-caption leading-[1.35] text-primary [overflow-wrap:anywhere]">
                {r.text}
              </span>
              <span className="font-mono text-label text-muted">
                {r.score.toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnEvents() {
  const meta = useMessage(
    (m) => m.metadata?.custom as unknown as TurnMeta | undefined,
  );
  const running = useMessage((m) => m.status?.type === "running");
  if (running || !meta) return null;
  return <EventChips meta={meta} />;
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col gap-2 border-b border-border bg-surface px-6 py-4 animate-fade text-primary">
      <div className="flex items-center justify-between gap-3">
        <div className={`${ROLE_LABEL} text-faint`}>
          <Bot strokeWidth={1.5} />
          ASSISTANT
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <TurnEvents />
          <MemoryBadge />
        </div>
      </div>
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      <Thinking />
    </MessagePrimitive.Root>
  );
}

export function ChatPane() {
  return (
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-raised">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-ink tracking-[-0.01em] [&_svg]:size-[18px] [&_svg]:text-ink">
          <MessageSquare strokeWidth={2.25} />
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
        <ComposerPrimitive.Root className="flex-none flex items-stretch gap-4 border-t border-border bg-surface pl-6">
          <ComposerPrimitive.Input
            className="flex-1 resize-none border-none bg-transparent py-4 font-sans text-body leading-normal text-primary outline-none max-h-40 min-h-6 placeholder:text-faint"
            placeholder="Send a message..."
            autoFocus
            rows={1}
          />
          <ComposerPrimitive.Send className="flex-none inline-flex items-center gap-1.5 rounded-none bg-ink px-6 font-mono text-label uppercase text-surface transition-opacity duration-150 ease-nothing hover:opacity-80 disabled:cursor-default disabled:bg-raised disabled:text-faint [&_svg]:size-[13px]">
            SEND
            <ArrowUp strokeWidth={1.5} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </section>
  );
}
