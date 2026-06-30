// Local-runtime ChatModelAdapter for assistant-ui (v0.11.x).
// run() is an async generator: it POSTs the latest user text to the backend
// /chat/stream SSE endpoint and yields the reply as it streams in, so the
// assistant bubble fills token-by-token. The first SSE event ("meta") carries the
// stages-1-5 result (message_id, retrieved, memory_events) — we push it into the
// shared store immediately so the memory + trace panes update the moment
// extraction finishes, well before the reply is done. The final yield attaches the
// turn meta to metadata.custom so the assistant message renders its
// [N MEMORIES USED] badge.
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { postChatStream } from "./api";
import { store } from "./store";
import type { MemoryEvent, RetrievedRef, TurnMeta } from "./types";

function lastUserText(messages: ChatModelRunOptions["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

type StreamEvent =
  | {
      type: "meta";
      message_id: string;
      retrieved: RetrievedRef[];
      memory_events: MemoryEvent[];
    }
  | { type: "delta"; text: string }
  | { type: "done"; reply: string };

export const chatAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }: ChatModelRunOptions) {
    const text = lastUserText(messages);
    const conversationId = store.getState().selectedConversationId;
    if (!conversationId) throw new Error("no conversation selected");

    const res = await postChatStream(text, conversationId, abortSignal);
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    let meta: TurnMeta | undefined;

    const emit = (): ChatModelRunResult => ({
      content: [{ type: "text", text: acc }],
      ...(meta
        ? { metadata: { custom: meta as unknown as Record<string, unknown> } }
        : {}),
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const ev = JSON.parse(line.slice(5).trim()) as StreamEvent;

        if (ev.type === "meta") {
          meta = {
            message_id: ev.message_id,
            retrieved: ev.retrieved,
            memory_events: ev.memory_events,
          };
          // Stages 1-5 are committed: select the turn + flash touched cards and
          // make the memory/metrics panes refetch right away.
          store.pushTurn({
            reply: "",
            message_id: ev.message_id,
            retrieved: ev.retrieved,
            memory_events: ev.memory_events,
          });
          yield emit();
        } else if (ev.type === "delta") {
          acc += ev.text;
          yield emit();
        } else if (ev.type === "done") {
          // Authoritative final text — covers the degrade path where no deltas
          // streamed. Then refetch so metrics pick up the reply's LLM call.
          if (ev.reply) acc = ev.reply;
          store.bumpTurn();
          yield emit();
        }
      }
    }
    yield emit();
  },
};
