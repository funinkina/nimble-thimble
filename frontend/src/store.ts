// Tiny observable shared across the three panes. No deps beyond React's
// useSyncExternalStore. The chat adapter pushes each /chat response here;
// the memory + metrics panes subscribe to `turnSeq` to know when to refetch,
// and `selectedMessageId` drives the trace pane.
import { useSyncExternalStore } from "react";
import type { ChatResponse } from "./types";

interface State {
  selectedMessageId: string | null;
  // Bumped after every completed turn so panes refetch their endpoints.
  turnSeq: number;
  lastResponse: ChatResponse | null;
}

let state: State = {
  selectedMessageId: null,
  turnSeq: 0,
  lastResponse: null,
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
  // the trace pane and bumps turnSeq so memory + metrics refetch.
  pushTurn(res: ChatResponse) {
    set({
      lastResponse: res,
      selectedMessageId: res.message_id,
      turnSeq: state.turnSeq + 1,
    });
  },
  selectMessage(messageId: string) {
    if (state.selectedMessageId === messageId) return;
    set({ selectedMessageId: messageId });
  },
  // Bump after a memory mutation (edit/forget/delete) so metrics + trace stay live.
  bumpTurn() {
    set({ turnSeq: state.turnSeq + 1 });
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
