// Tiny observable shared across the three panes. No deps beyond React's
// useSyncExternalStore. The chat adapter pushes each /chat response here;
// the memory + metrics panes subscribe to `turnSeq` to know when to refetch,
// and `selectedMessageId` drives the trace pane.
import { useSyncExternalStore } from "react";
import type { ChatResponse, Conversation, MemoryEvent } from "./types";

interface State {
  selectedMessageId: string | null;
  // Bumped after every completed turn so panes refetch their endpoints.
  turnSeq: number;
  lastResponse: ChatResponse | null;
  // Multi-chat: the active conversation and the sidebar list.
  selectedConversationId: string | null;
  conversations: Conversation[];
  // Memory card to flash/scroll-to (driven by clicking ids in the trace pane).
  // The nonce re-fires the effect when the same id is clicked twice.
  highlightedMemoryId: string | null;
  highlightNonce: number;
  // Memory ids touched by the latest turn (created/updated/superseded/etc), kept
  // until the next pushTurn replaces them. Cards in this set float + get marked.
  touchedIds: Set<string>;
  // The latest turn's events, for the "what changed this turn" strip. Cleared on
  // conversation switch.
  lastEvents: MemoryEvent[];
}

const EMPTY_TOUCHED: Set<string> = new Set();

let state: State = {
  selectedMessageId: null,
  turnSeq: 0,
  lastResponse: null,
  selectedConversationId: null,
  conversations: [],
  highlightedMemoryId: null,
  highlightNonce: 0,
  touchedIds: EMPTY_TOUCHED,
  lastEvents: [],
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export const store = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getState() {
    return state;
  },
  // Called by the chat adapter once a turn resolves. Selects the new turn for
  // the trace pane and bumps turnSeq so memory + metrics refetch. Also records
  // the touched ids + events for this turn (replacing the previous turn's).
  pushTurn(res: ChatResponse) {
    const events = res.memory_events ?? [];
    set({
      lastResponse: res,
      selectedMessageId: res.message_id,
      turnSeq: state.turnSeq + 1,
      touchedIds: events.length
        ? new Set(events.map((e) => e.memory_id))
        : EMPTY_TOUCHED,
      lastEvents: events,
    });
  },
  selectMessage(messageId: string) {
    if (state.selectedMessageId === messageId) return;
    set({ selectedMessageId: messageId });
  },
  // Flash + scroll the memory card with this id in the inspector.
  highlightMemory(memoryId: string) {
    set({
      highlightedMemoryId: memoryId,
      highlightNonce: state.highlightNonce + 1,
    });
  },
  // Bump after a memory mutation (edit/forget/delete) so metrics + trace stay live.
  bumpTurn() {
    set({ turnSeq: state.turnSeq + 1 });
  },
  setConversations(conversations: Conversation[]) {
    set({ conversations });
  },
  // Switch chats: drop the selected turn and bump so every pane refetches for
  // the new conversation.
  selectConversation(id: string | null) {
    if (state.selectedConversationId === id) return;
    set({
      selectedConversationId: id,
      selectedMessageId: null,
      turnSeq: state.turnSeq + 1,
      touchedIds: EMPTY_TOUCHED,
      lastEvents: [],
    });
  },
};

function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export const useSelectedMessageId = () =>
  useStore((s) => s.selectedMessageId);
export const useTurnSeq = () => useStore((s) => s.turnSeq);
export const useSelectedConversationId = () =>
  useStore((s) => s.selectedConversationId);
export const useConversations = () => useStore((s) => s.conversations);
export const useHighlightedMemoryId = () =>
  useStore((s) => s.highlightedMemoryId);
export const useHighlightNonce = () => useStore((s) => s.highlightNonce);
export const useTouchedIds = () => useStore((s) => s.touchedIds);
export const useLastEvents = () => useStore((s) => s.lastEvents);
