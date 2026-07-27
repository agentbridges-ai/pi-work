import { memo, useCallback, useEffect, useRef, type HTMLAttributes } from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
  type ReactZoomPanPinchState,
} from "react-zoom-pan-pinch";
import type { UiLanguage } from "../../store/ui-slice.js";
import { uiCopy } from "../../ui-copy.js";
import type { ReadyPreviewState } from "../user-space-explorer/model.js";
import {
  IMAGE_PREVIEW_MAX_SCALE,
  IMAGE_PREVIEW_MIN_SCALE,
  IMAGE_PREVIEW_SCALE_STEP,
  ImagePreviewZoomControls,
} from "./ImagePreviewZoomControls.js";

type ImagePreviewState = ReadyPreviewState & { kind: "image" };
type MediaPreviewState = ReadyPreviewState & { kind: "audio" | "video" };

const IMAGE_PREVIEW_BUTTON_ZOOM_STEP = Math.log(IMAGE_PREVIEW_SCALE_STEP);
const IMAGE_PREVIEW_WHEEL_SENSITIVITY = 0.018;
const workspaceCopy = uiCopy.userSpace;

export const ImageViewer = memo(function ImageViewer({
  preview,
  scale,
  showControls = true,
  onScaleChange,
}: {
  preview: ImagePreviewState;
  scale: number;
  showControls?: boolean;
  onScaleChange: (scale: number) => void;
}) {
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);

  useEffect(() => {
    const transform = transformRef.current;
    if (!transform || Math.abs(transform.state.scale - scale) < 0.001) return;
    transform.centerView(scale, 0);
  }, [scale]);

  const handleTransform = useCallback(
    (_ref: ReactZoomPanPinchRef, state: Pick<ReactZoomPanPinchState, "scale">) => {
      onScaleChange(state.scale);
    },
    [onScaleChange],
  );

  const scalePercent = Math.round(scale * 100);

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-background"
      data-testid={`image-preview-${preview.path}`}
    >
      <TransformWrapper
        ref={transformRef}
        key={preview.objectUrl}
        initialScale={scale}
        minScale={IMAGE_PREVIEW_MIN_SCALE}
        maxScale={IMAGE_PREVIEW_MAX_SCALE}
        centerOnInit
        centerZoomedOut
        limitToBounds
        wheel={{
          step: IMAGE_PREVIEW_WHEEL_SENSITIVITY,
          wheelDisabled: true,
          touchPadDisabled: false,
        }}
        trackPadPanning={{ disabled: false, velocityDisabled: true }}
        pinch={{ step: 5, allowPanning: true }}
        panning={{ velocityDisabled: true }}
        doubleClick={{ mode: "toggle", step: Math.log(2), animationTime: 120 }}
        zoomAnimation={{ animationTime: 120, size: 0.2 }}
        velocityAnimation={{ disabled: true }}
        onTransform={handleTransform}
      >
        {({ centerView, zoomIn, zoomOut }) => (
          <>
            {showControls && (
              <ImagePreviewZoomControls
                path={preview.path}
                scalePercent={scalePercent}
                onZoomOut={() => zoomOut(IMAGE_PREVIEW_BUTTON_ZOOM_STEP, 120)}
                onZoomIn={() => zoomIn(IMAGE_PREVIEW_BUTTON_ZOOM_STEP, 120)}
                onReset={() => {
                  onScaleChange(1);
                  centerView(1, 120);
                }}
              />
            )}
            <TransformComponent
              wrapperClass="h-full w-full cursor-grab active:cursor-grabbing"
              contentClass="h-full w-full"
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                willChange: "transform",
              }}
              contentProps={
                {
                  "data-testid": `image-preview-transform-${preview.path}`,
                } as HTMLAttributes<HTMLDivElement>
              }
            >
              <div className="flex h-full w-full touch-none select-none items-center justify-center px-4 py-3">
                <img
                  src={preview.objectUrl}
                  alt={preview.name}
                  className="max-h-full max-w-full object-contain"
                  draggable={false}
                  data-testid={`image-preview-img-${preview.path}`}
                />
              </div>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
});

export const MediaPreview = memo(function MediaPreview({
  preview,
}: {
  uiLanguage: UiLanguage;
  preview: MediaPreviewState;
}) {
  if (preview.kind === "video") {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background p-3">
        <video
          title={workspaceCopy.videoPreviewTitle(preview.name)}
          src={preview.objectUrl}
          controls
          preload="metadata"
          className="max-h-full max-w-full bg-background"
          data-testid={`video-preview-${preview.path}`}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <audio
        title={workspaceCopy.audioPreviewTitle(preview.name)}
        src={preview.objectUrl}
        controls
        preload="metadata"
        className="w-full max-w-xl"
        data-testid={`audio-preview-${preview.path}`}
      />
    </div>
  );
});
