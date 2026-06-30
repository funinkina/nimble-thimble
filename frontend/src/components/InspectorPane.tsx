import { Gauge } from "lucide-react";
import { MetricsBar } from "./MetricsBar";
import { TraceDrawer } from "./TraceDrawer";

export function InspectorPane() {
  return (
    <section className="flex flex-col min-h-0 min-w-0 bg-page">
      <header className="flex-none flex items-baseline justify-between gap-4 px-6 py-4 border-b border-border bg-gray-900">
        <span className="inline-flex items-center gap-2 font-sans font-bold text-subheading text-surface tracking-[-0.01em] [&_svg]:size-[18px] [&_svg]:text-surface">
          <Gauge strokeWidth={2.25} />
          Inspector
        </span>
        <span className="font-mono text-label uppercase text-surface/50">
          Metrics &amp; Trace
        </span>
      </header>
      <MetricsBar />
      <TraceDrawer />
    </section>
  );
}
