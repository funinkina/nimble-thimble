// Local-runtime ChatModelAdapter for assistant-ui (v0.11.x).
// run() pulls the latest user text out of the thread messages, POSTs it to the
// backend /chat, pushes the full response into the shared store (so the other
// panes refetch + select the turn), and returns the reply as a single text part
// with the turn meta on metadata.custom so the assistant message can render its
// [N MEMORIES USED] badge.
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
} from "@assistant-ui/react";
import { postChat } from "./api";
import { store } from "./store";
import type { TurnMeta } from "./types";

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

export const chatAdapter: ChatModelAdapter = {
  async run({ messages, abortSignal }: ChatModelRunOptions): Promise<ChatModelRunResult> {
    const text = lastUserText(messages);
    const res = await postChat(text, abortSignal);
    store.pushTurn(res);

    const meta: TurnMeta = {
      message_id: res.message_id,
      retrieved: res.retrieved,
      memory_events: res.memory_events,
    };

    return {
      content: [{ type: "text", text: res.reply }],
      metadata: { custom: meta as unknown as Record<string, unknown> },
    };
  },
};
