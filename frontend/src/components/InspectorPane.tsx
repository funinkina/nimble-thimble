import { Gauge } from "lucide-react";
import { MetricsBar } from "./MetricsBar";
import { TraceDrawer } from "./TraceDrawer";

export function InspectorPane() {
  return (
    <section className="flex flex-col min-h-0 min-w-0 bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-raised">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-ink tracking-[-0.01em] [&_svg]:size-[18px] [&_svg]:text-ink">
          <Gauge strokeWidth={2.25} />
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
