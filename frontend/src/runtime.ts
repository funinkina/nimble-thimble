// Local-runtime ChatModelAdapter for assistant-ui (v0.11.x).
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

// Reveal speed for the typewriter pacer. Groq emits hundreds of chars in a few
// bursts; ~0.45 chars/ms (~450 cps) types a typical reply out over ~1-2s, fast
// enough to feel responsive, slow enough to read. Backlog adds a catch-up term so
// a long reply never lags far behind, and we drain at full speed once the stream
// has closed.
const REVEAL_CPMS = 0.45;
const DRAIN_MS = 1200; // a backlog this-or-larger clears within ~this window
const TICK_MS = 16; // ~60fps pacing loop

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

    let target = ""; // authoritative text received so far
    let meta: TurnMeta | undefined;
    let metaSeen = false; // a meta event arrived; surface the badge
    let streamDone = false;
    let streamErr: unknown;

    // Background pump: read SSE frames, grow `target`, capture meta. Decoupled from
    // the paced reveal below so network bursts don't drive render cadence.
    const pump = (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (; ;) {
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
            let ev: StreamEvent;
            try {
              ev = JSON.parse(line.slice(5).trim()) as StreamEvent;
            } catch {
              continue; // skip a malformed/partial frame instead of killing the run
            }

            if (ev.type === "meta") {
              meta = {
                message_id: ev.message_id,
                retrieved: ev.retrieved,
                memory_events: ev.memory_events,
              };
              metaSeen = true;
              // Stages 1-5 are committed: select the turn + flash touched cards and
              // make the memory/metrics panes refetch right away.
              store.pushTurn({
                reply: "",
                message_id: ev.message_id,
                retrieved: ev.retrieved,
                memory_events: ev.memory_events,
              });
            } else if (ev.type === "delta") {
              target += ev.text;
            } else if (ev.type === "done") {
              // Authoritative final text — covers the degrade path where no deltas
              // streamed. Never let it shrink what already arrived. Then refetch so
              // metrics pick up the reply's LLM call.
              if (ev.reply && ev.reply.length >= target.length) target = ev.reply;
              store.bumpTurn();
            }
          }
        }
        decoder.decode(); // flush any trailing multibyte char
      } catch (e) {
        streamErr = e;
      } finally {
        streamDone = true;
      }
    })();

    let acc = "";
    let last = performance.now();
    const emit = (): ChatModelRunResult => ({
      content: [{ type: "text", text: acc }],
      ...(meta
        ? { metadata: { custom: meta as unknown as Record<string, unknown> } }
        : {}),
    });

    // Paced reveal: walk `acc` toward `target` at REVEAL_CPMS (+ a backlog catch-up
    // term, full speed once the stream is done), yielding once per tick.
    for (; ;) {
      if (acc.length < target.length) {
        const now = performance.now();
        const backlog = target.length - acc.length;
        const rate = streamDone
          ? backlog
          : Math.max(REVEAL_CPMS, backlog / DRAIN_MS);
        const step = Math.max(1, Math.floor((now - last) * rate));
        last = now;
        acc = target.slice(0, Math.min(target.length, acc.length + step));
        yield emit();
      } else if (streamDone) {
        break;
      } else if (metaSeen) {
        metaSeen = false; // show the [N MEMORIES USED] badge before deltas land
        yield emit();
      } else {
        last = performance.now();
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }

    acc = target; // guarantee the full authoritative text on the final frame
    yield emit();
    await pump;
    if (streamErr && !acc) throw streamErr;
  },
};
