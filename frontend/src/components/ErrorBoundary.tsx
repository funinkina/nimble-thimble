import { Component, type ErrorInfo, type ReactNode } from "react";

// Last line of defense: a render-time throw anywhere below turns into a readable
// panel with a reload, instead of a blank white screen.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-page p-8 text-center">
        <div className="font-sans text-heading font-bold text-ink">
          Something broke.
        </div>
        <div className="max-w-[520px] font-mono text-body-sm text-muted [overflow-wrap:anywhere]">
          {this.state.error.message}
        </div>
        <button
          className="border border-border px-4 py-2 font-mono text-label uppercase text-muted transition-colors duration-150 ease-nothing hover:bg-raised hover:text-ink"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
