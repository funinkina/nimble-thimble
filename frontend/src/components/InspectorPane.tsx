import { MetricsBar } from "./MetricsBar";
import { TraceDrawer } from "./TraceDrawer";

export function InspectorPane() {
  return (
    <section className="flex flex-col min-h-0 min-w-0 bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border">
        <span className="font-sans font-bold text-subheading text-ink tracking-[-0.01em]">
          Inspector
        </span>
        <span className="font-mono text-label uppercase text-faint">
          Metrics &amp; Trace
        </span>
      </header>
      <MetricsBar />
      <TraceDrawer />
    </section>
  );
}
