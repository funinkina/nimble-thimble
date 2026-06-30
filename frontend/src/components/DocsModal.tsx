import { useEffect } from "react";
import { Github, Globe, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import designMd from "../../../DESIGN.md?raw";
import readmeMd from "../../../README.md?raw";

export type DocView = "design" | "readme" | "about" | null;

const REPO = "https://github.com/funinkina/nimble-thimble";
const PROFILE = "https://github.com/funinkina";
const SITE = "https://funinkina.co.in";

const TITLES: Record<NonNullable<DocView>, string> = {
  design: "DESIGN.md",
  readme: "README.md",
  about: "About the author",
};

const PROSE =
  "text-body leading-[1.6] text-primary " +
  "[&_h1]:font-sans [&_h1]:text-heading [&_h1]:font-bold [&_h1]:text-ink [&_h1]:mt-0 [&_h1]:mb-3 " +
  "[&_h2]:font-sans [&_h2]:text-subheading [&_h2]:font-bold [&_h2]:text-ink [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-t [&_h2]:border-border [&_h2]:pt-4 " +
  "[&_h3]:font-sans [&_h3]:text-body [&_h3]:font-bold [&_h3]:text-ink [&_h3]:mt-4 [&_h3]:mb-1.5 " +
  "[&_p]:my-2 " +
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 " +
  "[&_a]:text-interactive [&_a]:underline hover:[&_a]:no-underline " +
  "[&_strong]:font-bold [&_strong]:text-ink " +
  "[&_code]:font-mono [&_code]:text-body-sm [&_code]:bg-raised [&_code]:px-[5px] [&_code]:py-px [&_code]:rounded " +
  "[&_pre]:bg-raised [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md [&_pre]:p-4 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-caption [&_pre]:leading-[1.5] " +
  "[&_pre_code]:whitespace-pre [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-mono [&_pre_code]:text-caption " +
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted " +
  "[&_hr]:my-5 [&_hr]:border-border " +
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-body-sm " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-raised [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-bold " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top";

function About() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="font-sans text-heading font-bold text-ink">
          Aryan Kushwaha
        </span>
        <span className="font-mono text-label uppercase tracking-[0.06em] text-muted">
          Author of nimble-thimble
        </span>
      </div>
      <p className="text-body leading-[1.6] text-primary">
        I'm a recent graduate, with ~2 years of experience engineering backend & systems at production level, working in Go, Python, and C/C++. I like building systems that are fast, boring to operate, and interesting to build, and most of my time goes writing code and shipping straight to production.
        <br />
        Lately that means real-time LLM infrastructure and voice agent backends, though I'm just as comfortable low in the stack with device drivers and Linux kernel work, including a patch merged into mainline. Along the way: an 80% cut in voice latency, a 5x inference speedup, and 60% in cost savings.
        <br />
        When I'm not shipping, I write about Linux, open source, and computer science for 1000+ readers a month.
      </p>
      <div className="flex flex-col gap-2">
        <a
          href={SITE}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 font-mono text-label uppercase text-interactive hover:underline [&_svg]:size-[15px]"
        >
          <Globe strokeWidth={1.5} /> funinkina.co.in
        </a>
        <a
          href={PROFILE}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 font-mono text-label uppercase text-interactive hover:underline [&_svg]:size-[15px]"
        >
          <Github strokeWidth={1.5} /> github.com/funinkina
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 font-mono text-label uppercase text-interactive hover:underline [&_svg]:size-[15px]"
        >
          <Github strokeWidth={1.5} /> nimble-thimble repo
        </a>
      </div>
    </div>
  );
}

export function DocsModal({
  view,
  onClose,
}: {
  view: DocView;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onClose]);

  if (!view) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 animate-fade"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[760px] flex-col border border-border bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex-none flex items-stretch justify-between border-b border-border">
          <span className="flex items-center px-6 py-4 font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
            {TITLES[view]}
          </span>
          <button
            className="flex items-center justify-center self-stretch border-l border-border px-5 text-muted transition-colors duration-150 ease-nothing hover:bg-accent hover:text-surface [&_svg]:size-[18px]"
            onClick={onClose}
            title="Close"
          >
            <X strokeWidth={1.5} />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-slim px-6 py-5">
          {view === "about" ? (
            <About />
          ) : (
            <div className={PROSE}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {view === "design" ? designMd : readmeMd}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
