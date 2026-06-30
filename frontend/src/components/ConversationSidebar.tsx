import { useEffect } from "react";
import { PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import {
  createConversation,
  deleteConversation,
  listConversations,
} from "../api";
import {
  store,
  useConversations,
  useSelectedConversationId,
  useTurnSeq,
} from "../store";

async function refresh() {
  store.setConversations(await listConversations());
}

export function ConversationSidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const conversations = useConversations();
  const selected = useSelectedConversationId();
  const turnSeq = useTurnSeq();

  // Bootstrap: load the list, create the first chat if the DB is empty, and
  // select one if nothing is selected yet.
  useEffect(() => {
    let live = true;
    (async () => {
      let list = await listConversations();
      if (!live) return;
      if (list.length === 0) list = [await createConversation()];
      if (!live) return;
      store.setConversations(list);
      if (!store.getState().selectedConversationId) {
        store.selectConversation(list[0].id);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Refresh titles/order after every turn (the first user message names the chat).
  useEffect(() => {
    refresh().catch(() => {});
  }, [turnSeq]);

  async function newChat() {
    const c = await createConversation();
    await refresh();
    store.selectConversation(c.id);
  }

  async function del(id: string) {
    await deleteConversation(id);
    const list = await listConversations();
    store.setConversations(list);
    if (store.getState().selectedConversationId === id) {
      const next = list[0] ?? (await createConversation());
      if (!list[0]) store.setConversations([next]);
      store.selectConversation(next.id);
    }
  }

  if (collapsed) {
    return (
      <section className="pane conv-sidebar collapsed">
        <header className="pane-head">
          <button
            className="conv-icon-btn"
            onClick={onToggleCollapse}
            title="Expand chats"
          >
            <PanelLeftOpen strokeWidth={1.5} />
          </button>
        </header>
        <button className="conv-icon-btn rail-new" onClick={newChat} title="New chat">
          <Plus strokeWidth={1.5} />
        </button>
      </section>
    );
  }

  return (
    <section className="pane conv-sidebar">
      <header className="pane-head">
        <span className="pane-title">Chats</span>
        <span className="conv-head-actions">
          <button className="conv-icon-btn" onClick={newChat} title="New chat">
            <Plus strokeWidth={1.5} />
          </button>
          <button
            className="conv-icon-btn"
            onClick={onToggleCollapse}
            title="Collapse chats"
          >
            <PanelLeftClose strokeWidth={1.5} />
          </button>
        </span>
      </header>
      <div className="pane-body conv-list">
        {conversations.length === 0 ? (
          <div className="trace-empty">[NO CHATS]</div>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item${selected === c.id ? " active" : ""}`}
              onClick={() => store.selectConversation(c.id)}
            >
              <span className="conv-title">{c.title || "New chat"}</span>
              <button
                className="conv-del"
                title="Delete chat"
                onClick={(e) => {
                  e.stopPropagation();
                  void del(c.id);
                }}
              >
                <Trash2 strokeWidth={1.5} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
