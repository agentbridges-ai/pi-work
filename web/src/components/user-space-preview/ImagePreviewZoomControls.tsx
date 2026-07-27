import { useEffect, useRef, type ReactNode } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { uiCopy } from "../../ui-copy.js";

export const IMAGE_PREVIEW_MIN_SCALE = 0.25;
export const IMAGE_PREVIEW_MAX_SCALE = 6;
export const IMAGE_PREVIEW_SCALE_STEP = 1.2;

export function ImagePreviewZoomControls({
  path,
  scalePercent,
  onZoomOut,
  onZoomIn,
  onReset,
}: {
  path: string;
  scalePercent: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
}) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const imageCopy = uiCopy.userSpace.imagePreview;

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return undefined;
    const handleClick = (event: MouseEvent) => {
      const action = (event.target as Element | null)?.closest?.<HTMLElement>(
        "[data-image-preview-action]",
      )?.dataset.imagePreviewAction;
      if (!action) return;
      event.preventDefault();
      if (action === "zoom-out") onZoomOut();
      else if (action === "zoom-in") onZoomIn();
      else if (action === "reset") onReset();
    };
    controls.addEventListener("click", handleClick);
    return () => controls.removeEventListener("click", handleClick);
  }, [onReset, onZoomIn, onZoomOut]);

  return (
    <div
      ref={controlsRef}
      className="piwork-superellipse-panel absolute right-4 top-3 z-10 flex items-center gap-1 rounded-[var(--piwork-panel-radius)] border border-border bg-card p-1"
      data-testid={`image-preview-zoom-controls-${path}`}
    >
      <IconToolButton label={imageCopy.zoomOut} title={imageCopy.zoomOut} action="zoom-out">
        <ZoomOut className="h-4 w-4" aria-hidden="true" />
      </IconToolButton>
      <span
        className="min-w-10 text-center text-xs font-semibold text-muted-foreground"
        data-testid={`image-preview-scale-${path}`}
      >
        {scalePercent}%
      </span>
      <IconToolButton label={imageCopy.zoomIn} title={imageCopy.zoomIn} action="zoom-in">
        <ZoomIn className="h-4 w-4" aria-hidden="true" />
      </IconToolButton>
      <IconToolButton label={imageCopy.reset} title={imageCopy.reset} action="reset">
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
      </IconToolButton>
    </div>
  );
}

function IconToolButton({
  label,
  title,
  action,
  children,
}: {
  label: string;
  title: string;
  action: "zoom-out" | "zoom-in" | "reset";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      data-image-preview-action={action}
      className="piwork-superellipse flex h-7 w-7 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
