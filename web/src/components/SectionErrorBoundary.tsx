import { Component, type ReactNode } from "react";
import { captureException } from "../analytics.js";
import { uiCopy } from "../ui-copy.js";

interface Props {
  children: ReactNode;
  /** Optional label shown in the error UI (e.g. section name) */
  label?: string;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render errors within a section and displays a compact fallback,
 * preventing a single broken section from crashing the entire app.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    captureException(error, { section: this.props.label });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-danger">
              {uiCopy.appError.sectionLoadFailed(this.props.label)}
            </span>
            <button
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded bg-muted cursor-pointer"
              onClick={() => this.setState({ hasError: false })}
            >
              {uiCopy.common.retry}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
