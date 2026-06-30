import { useEffect, useState } from "react";
import {
  BookOpen,
  ExternalLink,
  FileText,
  Github,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
} from "lucide-react";
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
import { DocsModal, type DocView } from "./DocsModal";

const REPO_URL = "https://github.com/funinkina/nimble-thimble";

type FootItem = {
  key: DocView | "github";
  label: string;
  icon: typeof FileText;
  href?: string;
};

const FOOT_ITEMS: FootItem[] = [
  { key: "design", label: "Design", icon: FileText },
  { key: "readme", label: "Readme", icon: BookOpen },
  { key: "github", label: "GitHub", icon: Github, href: REPO_URL },
  { key: "about", label: "About", icon: Info },
];

const FOOT_BTN =
  "flex w-full items-center gap-2.5 border-b border-white/10 px-4 py-2.5 font-mono text-label uppercase bg-slate-700 text-surface transition-colors duration-150 ease-nothing hover:bg-primary [&_svg]:size-[15px]";
const FOOT_BTN_COLLAPSED =
  "flex w-full items-center justify-center border-b border-white/10 py-3 bg-slate-700 text-surface transition-colors duration-150 ease-nothing hover:bg-primary [&_svg]:size-[16px]";

async function refresh() {
  store.setConversations(await listConversations());
}

// Shared header height so the sidebar lines up with the Chat/Memory/Inspector
// headers (px-?+py-4 over an 18px/1.3 title ≈ 57px).
const HDR = "flex-none flex h-[57px] border-b border-border";
// Full-height square header button — fills the cell, padding inside, divider on
// the left (mirrors the status/scope filter cells).
const HDR_BTN =
  "flex items-center justify-center px-4 border-l border-border text-muted transition-colors duration-150 ease-nothing hover:bg-raised hover:text-ink [&_svg]:size-[16px]";
// Full-width, square chat row — shared by collapsed + expanded lists. The 4px
// left border is the selected indicator (transparent when idle).
const CELL =
  "flex w-full items-center gap-2 border-b border-border border-l-4 border-l-transparent px-4 py-3 cursor-pointer text-muted transition-colors duration-150 ease-nothing hover:bg-raised hover:text-ink";
const CELL_ACTIVE = "bg-surface !border-l-black text-ink";

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
  const [doc, setDoc] = useState<DocView>(null);

  function openFoot(it: FootItem) {
    if (it.href) window.open(it.href, "_blank", "noopener,noreferrer");
    else setDoc(it.key as DocView);
  }

  const footer = (compact: boolean) => (
    <footer className="flex-none flex flex-col border-t border-border">
      {FOOT_ITEMS.map((it) => {
        const Icon = it.icon;
        return (
          <button
            key={it.key}
            className={compact ? FOOT_BTN_COLLAPSED : FOOT_BTN}
            onClick={() => openFoot(it)}
            title={it.label}
          >
            <Icon strokeWidth={1.5} />
            {!compact && it.label}
            {!compact && it.href && (
              <ExternalLink
                strokeWidth={1.5}
                className="ml-auto size-3 text-surface/50"
              />
            )}
          </button>
        );
      })}
    </footer>
  );

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
        <header className={HDR}>
          <button
            className={`${HDR_BTN} w-full border-l-0`}
            onClick={onToggleCollapse}
            title="Expand chats"
          >
            <PanelLeftOpen strokeWidth={1.5} />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col">
          {conversations.map((c, i) => (
            <button
              key={c.id}
              className={`${CELL} justify-center font-mono text-body-sm ${selected === c.id ? `${CELL_ACTIVE} font-bold` : ""}`}
              onClick={() => store.selectConversation(c.id)}
              title={c.title || "New chat"}
            >
              {i + 1}
            </button>
          ))}
          <button
            className={`${CELL} justify-center [&_svg]:size-[15px]`}
            onClick={newChat}
            title="New chat"
          >
            <Plus strokeWidth={1.5} />
          </button>
        </div>
        {footer(true)}
        <DocsModal view={doc} onClose={() => setDoc(null)} />
      </section>
    );
  }

  return (
    <section className="flex flex-col min-h-0 min-w-0 border-r border-line bg-page">
      <header className={`${HDR} items-stretch justify-between`}>
        <span className="flex items-center px-4 font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
          Chats
        </span>
        <div className="flex items-stretch">
          <button className={HDR_BTN} onClick={newChat} title="New chat">
            <Plus strokeWidth={1.5} />
          </button>
          <button
            className={HDR_BTN}
            onClick={onToggleCollapse}
            title="Collapse chats"
          >
            <PanelLeftClose strokeWidth={1.5} />
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-slim flex flex-col">
        {conversations.length === 0 ? (
          <div className="px-4 py-3 font-mono text-body-sm tracking-[0.06em] text-faint">
            [NO CHATS]
          </div>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={`group ${CELL} ${selected === c.id ? CELL_ACTIVE : ""}`}
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
      {footer(false)}
      <DocsModal view={doc} onClose={() => setDoc(null)} />
    </section>
  );
}
