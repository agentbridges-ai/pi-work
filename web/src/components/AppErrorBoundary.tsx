import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { captureException } from "../analytics.js";
import { uiCopy } from "../ui-copy.js";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureException(error, {
      source: "react_error_boundary",
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-[100dvh] flex items-center justify-center bg-background text-foreground px-4">
          <div className="piwork-superellipse-panel max-w-md w-full rounded-xl border border-border bg-card p-5">
            <h1 className="text-base font-semibold">{uiCopy.appError.runtimeErrorTitle}</h1>
            <p className="text-sm text-muted-foreground mt-2">
              {uiCopy.appError.recoverPageDescription}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex items-center rounded-[var(--piwork-control-radius)] bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 cursor-pointer"
            >
              {uiCopy.common.reload}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
