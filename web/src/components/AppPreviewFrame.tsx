import { useEffect, useMemo, useState } from "react";
import { Alert } from "./ui/index.js";
import { uiCopy } from "../ui-copy.js";

export function isIndependentAppUrl(
  rawUrl: string,
  piworkOrigin = typeof window === "undefined" ? "" : window.location.origin,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (piworkOrigin && url.origin === piworkOrigin) return false;
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface AppPreviewFrameProps {
  appName: string;
  className?: string;
  url: string;
}

export function AppPreviewFrame({ appName, className = "", url }: AppPreviewFrameProps) {
  const [loaded, setLoaded] = useState(false);
  const allowed = useMemo(() => isIndependentAppUrl(url), [url]);

  useEffect(() => setLoaded(false), [url]);

  if (!allowed) {
    return <Alert status="danger" title={uiCopy.apps.previewUnsafe} />;
  }

  return (
    <div
      aria-busy={!loaded}
      className={`relative min-h-72 overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border bg-card ${className}`}
      data-testid="app-preview-frame"
    >
      {!loaded ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-card text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {uiCopy.apps.previewLoading}
        </div>
      ) : null}
      <iframe
        className="h-full min-h-72 w-full border-0 bg-background"
        onLoad={() => setLoaded(true)}
        referrerPolicy="no-referrer"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        src={url}
        title={uiCopy.apps.previewTitle(appName)}
      />
    </div>
  );
}
