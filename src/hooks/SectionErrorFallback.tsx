import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  sectionKey: string;
  fallback?: ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Per-section error boundary that prevents a single broken section
 * from crashing the entire page.
 *
 * In development, shows the error message + stack trace.
 * In production, renders a silent empty placeholder.
 */
export class SectionErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[CMS] Section "${this.props.sectionKey}" crashed:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <DefaultSectionErrorFallback error={this.state.error} sectionKey={this.props.sectionKey} />
      );
    }
    return this.props.children;
  }
}

function DefaultSectionErrorFallback({ error, sectionKey }: { error: Error; sectionKey: string }) {
  const isDev = typeof process !== "undefined" && process.env.NODE_ENV === "development";

  if (!isDev) {
    return <div data-section-error={sectionKey} className="hidden" />;
  }

  return (
    <div
      data-section-error={sectionKey}
      style={{
        padding: "16px",
        margin: "8px 0",
        border: "2px solid #ef4444",
        borderRadius: "8px",
        background: "#fef2f2",
        fontFamily: "monospace",
        fontSize: "13px",
      }}
    >
      <div style={{ fontWeight: "bold", color: "#dc2626", marginBottom: "8px" }}>
        Section Error: {sectionKey}
      </div>
      <div style={{ color: "#991b1b" }}>{error.message}</div>
      {error.stack && (
        <pre
          style={{
            marginTop: "8px",
            fontSize: "11px",
            color: "#6b7280",
            whiteSpace: "pre-wrap",
            overflow: "auto",
            maxHeight: "200px",
          }}
        >
          {error.stack}
        </pre>
      )}
    </div>
  );
}
