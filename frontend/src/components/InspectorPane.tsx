import { MetricsBar } from "./MetricsBar";
import { TraceDrawer } from "./TraceDrawer";

export function InspectorPane() {
  return (
    <section className="pane">
      <header className="pane-head">
        <span className="pane-title">Inspector</span>
        <span className="pane-sub">Metrics &amp; Trace</span>
      </header>
      <MetricsBar />
      <TraceDrawer />
    </section>
  );
}
