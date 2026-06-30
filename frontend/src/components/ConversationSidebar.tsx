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

const ICON_BTN =
  "inline-flex items-center justify-center w-[26px] h-[26px] rounded-full border bg-surface transition-colors duration-150 ease-nothing [&_svg]:size-[15px]";
const ICON_BTN_IDLE = "border-line text-muted hover:border-ink hover:text-ink";
const ICON_BTN_ACTIVE = "bg-surface border-ink text-ink font-bold";

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
    refresh().catch(() => { });
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
      <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
        <header className="flex-none flex items-center justify-center py-4 border-b border-border">
          <button
            className={`${ICON_BTN} ${ICON_BTN_IDLE}`}
            onClick={onToggleCollapse}
            title="Expand chats"
          >
            <PanelLeftOpen strokeWidth={1.5} />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col items-center gap-2 py-2">
          {conversations.map((c, i) => (
            <button
              key={c.id}
              className={`${ICON_BTN} ${selected === c.id ? ICON_BTN_ACTIVE : ICON_BTN_IDLE} font-mono text-body-sm`}
              onClick={() => store.selectConversation(c.id)}
              title={c.title || "New chat"}
            >
              {i + 1}
            </button>
          ))}
          <button
            className={`${ICON_BTN} ${ICON_BTN_IDLE}`}
            onClick={newChat}
            title="New chat"
          >
            <Plus strokeWidth={1.5} />
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border">
        <span className="font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
          Chats
        </span>
        <span className="inline-flex items-center gap-2">
          <button
            className={`${ICON_BTN} ${ICON_BTN_IDLE}`}
            onClick={newChat}
            title="New chat"
          >
            <Plus strokeWidth={1.5} />
          </button>
          <button
            className={`${ICON_BTN} ${ICON_BTN_IDLE}`}
            onClick={onToggleCollapse}
            title="Collapse chats"
          >
            <PanelLeftClose strokeWidth={1.5} />
          </button>
        </span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col p-2 gap-1">
        {conversations.length === 0 ? (
          <div className="font-mono text-body-sm tracking-[0.06em] text-faint">
            [NO CHATS]
          </div>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-2 rounded-lg border px-4 py-2 cursor-pointer transition-colors duration-150 ease-nothing ${selected === c.id
                  ? "bg-surface border-line"
                  : "border-transparent hover:bg-raised"
                }`}
              onClick={() => store.selectConversation(c.id)}
            >
              <span className="flex-1 min-w-0 truncate font-sans text-body-sm text-primary">
                {c.title || "New chat"}
              </span>
              <button
                className="flex-none inline-flex items-center text-faint opacity-0 transition-opacity duration-150 ease-nothing group-hover:opacity-100 hover:text-accent [&_svg]:size-[14px]"
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
