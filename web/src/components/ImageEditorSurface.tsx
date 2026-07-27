import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { DropdownMotion } from "./ui/index.js";
import Konva from "konva";
import {
  Arrow,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
} from "react-konva";
import {
  Check,
  Circle,
  Crop,
  MoveUpRight,
  PenLine,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-react";
import {
  IMAGE_PREVIEW_MAX_SCALE,
  IMAGE_PREVIEW_MIN_SCALE,
  IMAGE_PREVIEW_SCALE_STEP,
  ImagePreviewZoomControls,
} from "./user-space-preview/ImagePreviewZoomControls.js";

export type ImageEditorTool = "crop" | "pen" | "arrow" | "rect" | "ellipse" | "text";

type Point = { x: number; y: number };
type CropBox = Point & { width: number; height: number };
type Annotation =
  | { id: string; type: "pen"; points: number[]; color: string; width: number }
  | {
      id: string;
      type: "arrow";
      points: [number, number, number, number];
      color: string;
      width: number;
    }
  | {
      id: string;
      type: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "ellipse";
      x: number;
      y: number;
      radiusX: number;
      radiusY: number;
      color: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "text";
      x: number;
      y: number;
      text: string;
      color: string;
      fontSize: number;
    };

type EditorState = { crop: CropBox; annotations: Annotation[] };

export type ImageEditorLabels = {
  toolbar: string;
  select: string;
  crop: string;
  pen: string;
  arrow: string;
  rectangle: string;
  ellipse: string;
  text: string;
  undo: string;
  redo: string;
  color: string;
  customColor: string;
  strokeWidth: string;
  applyCrop: string;
  textPlaceholder: string;
  loading: string;
  loadFailed: string;
};

export type ImageEditorSurfaceHandle = {
  exportFile: () => Promise<File>;
};

type ImageEditorSurfaceProps = {
  source: string;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  labels: ImageEditorLabels;
  onDirtyChange: (dirty: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
  onZoomScaleChange?: (scale: number) => void;
  toolbarPortalId?: string;
  zoomScale?: number;
};

// theme-guard: allow-content-palette-start
// These colors are authored into image pixels and canvas chrome; they are not business UI theme colors.
const IMAGE_EDITOR_CONTENT_COLORS = {
  annotationSwatches: ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#111827", "#f8fafc"],
  cropMask: "rgba(15,23,42,.48)",
  cropHandle: "#f8fafc",
};
// theme-guard: allow-content-palette-end

const COLORS = IMAGE_EDITOR_CONTENT_COLORS.annotationSwatches;

export const ImageEditorSurface = memo(
  forwardRef<ImageEditorSurfaceHandle, ImageEditorSurfaceProps>(function ImageEditorSurface(
    {
      source,
      fileName,
      mimeType,
      labels,
      onDirtyChange,
      onReadyChange,
      onZoomScaleChange,
      toolbarPortalId,
      zoomScale: controlledZoomScale,
    },
    forwardedRef,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const colorButtonRef = useRef<HTMLButtonElement | null>(null);
    const colorPanelRef = useRef<HTMLDivElement | null>(null);
    const stageRef = useRef<Konva.Stage | null>(null);
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [tool, setTool] = useState<ImageEditorTool>("arrow");
    const [color, setColor] = useState(COLORS[0]);
    const [strokeWidth, setStrokeWidth] = useState(4);
    const [internalZoomScale, setInternalZoomScale] = useState(1);
    const [colorPanelPosition, setColorPanelPosition] = useState<{
      top: number;
      left: number;
    } | null>(null);
    const lastColorPanelPositionRef = useRef(colorPanelPosition);
    if (colorPanelPosition) lastColorPanelPositionRef.current = colorPanelPosition;
    const [state, setState] = useState<EditorState | null>(null);
    const [past, setPast] = useState<EditorState[]>([]);
    const [future, setFuture] = useState<EditorState[]>([]);
    const [cropDraft, setCropDraft] = useState<CropBox | null>(null);
    const [textDraft, setTextDraft] = useState<(Point & { value: string }) | null>(null);
    const [toolbarPortalTarget, setToolbarPortalTarget] = useState<HTMLElement | null>(null);
    const initialStateRef = useRef<EditorState | null>(null);
    const gestureStartRef = useRef<EditorState | null>(null);
    const gestureOriginRef = useRef<Point | null>(null);
    const drawingIdRef = useRef(0);

    useLayoutEffect(() => {
      if (!toolbarPortalId) {
        setToolbarPortalTarget(null);
        return;
      }
      const ownerDocument = hostRef.current?.ownerDocument;
      if (!ownerDocument) return;
      const syncTarget = () =>
        setToolbarPortalTarget(ownerDocument.getElementById(toolbarPortalId));
      syncTarget();
      const observer = new MutationObserver(syncTarget);
      observer.observe(ownerDocument.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, [toolbarPortalId]);

    useEffect(() => {
      const nextImage = new window.Image();
      nextImage.onload = () => {
        const nextState: EditorState = {
          crop: { x: 0, y: 0, width: nextImage.naturalWidth, height: nextImage.naturalHeight },
          annotations: [],
        };
        initialStateRef.current = nextState;
        setState(nextState);
        setImage(nextImage);
        setPast([]);
        setFuture([]);
        setLoadFailed(false);
      };
      nextImage.onerror = () => setLoadFailed(true);
      nextImage.src = source;
      setInternalZoomScale(1);
      return () => {
        nextImage.onload = null;
        nextImage.onerror = null;
      };
    }, [source]);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;
      const update = () => setViewport({ width: host.clientWidth, height: host.clientHeight });
      update();
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
      observer?.observe(host);
      window.addEventListener("resize", update);
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", update);
      };
    }, []);

    const isDirty = useMemo(
      () =>
        Boolean(
          state &&
          initialStateRef.current &&
          JSON.stringify(state) !== JSON.stringify(initialStateRef.current),
        ),
      [state],
    );

    useEffect(() => onDirtyChange(isDirty), [isDirty, onDirtyChange]);
    useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

    const zoomScale = controlledZoomScale ?? internalZoomScale;

    useEffect(() => {
      if (!colorPanelPosition) return undefined;
      const ownerDocument = colorButtonRef.current?.ownerDocument || document;
      const closeOnOutsidePointer = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (!colorButtonRef.current?.contains(target) && !colorPanelRef.current?.contains(target))
          setColorPanelPosition(null);
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") setColorPanelPosition(null);
      };
      ownerDocument.addEventListener("pointerdown", closeOnOutsidePointer);
      ownerDocument.addEventListener("keydown", closeOnEscape);
      return () => {
        ownerDocument.removeEventListener("pointerdown", closeOnOutsidePointer);
        ownerDocument.removeEventListener("keydown", closeOnEscape);
      };
    }, [colorPanelPosition]);

    const layout = useMemo(() => {
      if (!state || viewport.width <= 0 || viewport.height <= 0) return null;
      const padding = 12;
      const fittedScale = Math.min(
        Math.max(1, viewport.width - padding * 2) / state.crop.width,
        Math.max(1, viewport.height - padding * 2) / state.crop.height,
        1,
      );
      const scale = fittedScale * zoomScale;
      const width = state.crop.width * scale;
      const height = state.crop.height * scale;
      return {
        scale,
        width,
        height,
        x: (viewport.width - width) / 2,
        y: (viewport.height - height) / 2,
      };
    }, [state, viewport, zoomScale]);

    const ready = Boolean(image && state && layout);
    useEffect(() => onReadyChange?.(ready), [onReadyChange, ready]);
    useEffect(() => () => onReadyChange?.(false), [onReadyChange]);

    const updateZoomScale = useCallback(
      (nextScale: number) => {
        if (controlledZoomScale === undefined) setInternalZoomScale(nextScale);
        onZoomScaleChange?.(nextScale);
      },
      [controlledZoomScale, onZoomScaleChange],
    );

    const zoomOut = useCallback(
      () =>
        updateZoomScale(Math.max(IMAGE_PREVIEW_MIN_SCALE, zoomScale / IMAGE_PREVIEW_SCALE_STEP)),
      [updateZoomScale, zoomScale],
    );
    const zoomIn = useCallback(
      () =>
        updateZoomScale(Math.min(IMAGE_PREVIEW_MAX_SCALE, zoomScale * IMAGE_PREVIEW_SCALE_STEP)),
      [updateZoomScale, zoomScale],
    );
    const resetZoom = useCallback(() => updateZoomScale(1), [updateZoomScale]);

    const commit = useCallback(
      (next: EditorState) => {
        if (!state) return;
        setPast([...past, state]);
        setState(next);
        setFuture([]);
      },
      [past, state],
    );

    const undo = useCallback(() => {
      const previous = past.at(-1);
      if (!state || !previous) return;
      setPast(past.slice(0, -1));
      setFuture([state, ...future]);
      setState(previous);
      setCropDraft(null);
      setTextDraft(null);
    }, [future, past, state]);

    const redo = useCallback(() => {
      const next = future[0];
      if (!state || !next) return;
      setPast([...past, state]);
      setFuture(future.slice(1));
      setState(next);
    }, [future, past, state]);

    const selectTool = useCallback((nextTool: ImageEditorTool) => {
      if (nextTool !== "crop") {
        setCropDraft(null);
        gestureOriginRef.current = null;
      }
      if (nextTool !== "text") setTextDraft(null);
      setTool(nextTool);
    }, []);

    const toggleColorPanel = useCallback(() => {
      if (colorPanelPosition) {
        setColorPanelPosition(null);
        return;
      }
      const rect = colorButtonRef.current?.getBoundingClientRect();
      const ownerWindow = colorButtonRef.current?.ownerDocument.defaultView || window;
      if (!rect) return;
      const panelWidth = 224;
      const panelHeight = 126;
      setColorPanelPosition({
        left: clamp(rect.left, 8, Math.max(8, ownerWindow.innerWidth - panelWidth - 8)),
        top:
          rect.bottom + 6 + panelHeight <= ownerWindow.innerHeight
            ? rect.bottom + 6
            : Math.max(8, rect.top - panelHeight - 6),
      });
    }, [colorPanelPosition]);

    const imagePointAt = useCallback(
      (clientX: number, clientY: number): Point | null => {
        if (!layout || !state || !hostRef.current) return null;
        const hostBounds = hostRef.current.getBoundingClientRect();
        const pointer = { x: clientX - hostBounds.left, y: clientY - hostBounds.top };
        return {
          x: clamp(
            (pointer.x - layout.x) / layout.scale + state.crop.x,
            state.crop.x,
            state.crop.x + state.crop.width,
          ),
          y: clamp(
            (pointer.y - layout.y) / layout.scale + state.crop.y,
            state.crop.y,
            state.crop.y + state.crop.height,
          ),
        };
      },
      [layout, state],
    );

    const startDrawing = useCallback(
      (point: Point) => {
        if (!state || tool === "text") return;
        gestureOriginRef.current = point;
        if (tool === "crop") {
          setCropDraft({ ...point, width: 0, height: 0 });
          return;
        }
        gestureStartRef.current = state;
        const id = `annotation-${++drawingIdRef.current}`;
        const annotation: Annotation =
          tool === "pen"
            ? { id, type: "pen", points: [point.x, point.y], color, width: strokeWidth }
            : tool === "arrow"
              ? {
                  id,
                  type: "arrow",
                  points: [point.x, point.y, point.x, point.y],
                  color,
                  width: strokeWidth,
                }
              : tool === "rect"
                ? {
                    id,
                    type: "rect",
                    x: point.x,
                    y: point.y,
                    width: 0,
                    height: 0,
                    color,
                    strokeWidth,
                  }
                : {
                    id,
                    type: "ellipse",
                    x: point.x,
                    y: point.y,
                    radiusX: 0,
                    radiusY: 0,
                    color,
                    strokeWidth,
                  };
        setState({ ...state, annotations: [...state.annotations, annotation] });
      },
      [color, state, strokeWidth, tool],
    );

    const continueDrawing = useCallback(
      (point: Point | null) => {
        if (!point || !state) return;
        const origin = gestureOriginRef.current;
        if (tool === "crop" && cropDraft && origin) {
          setCropDraft(normalizeBox(origin.x, origin.y, point.x, point.y));
          return;
        }
        if (!gestureStartRef.current) return;
        setState((current) => {
          if (!current) return current;
          const annotations = [...current.annotations];
          const item = annotations.at(-1);
          if (!item) return current;
          if (item.type === "pen")
            annotations[annotations.length - 1] = {
              ...item,
              points: [...item.points, point.x, point.y],
            };
          else if (item.type === "arrow")
            annotations[annotations.length - 1] = {
              ...item,
              points: [item.points[0], item.points[1], point.x, point.y],
            };
          else if (item.type === "rect" && origin) {
            const box = normalizeBox(origin.x, origin.y, point.x, point.y);
            annotations[annotations.length - 1] = { ...item, ...box };
          } else if (item.type === "ellipse" && origin) {
            annotations[annotations.length - 1] = {
              ...item,
              x: (origin.x + point.x) / 2,
              y: (origin.y + point.y) / 2,
              radiusX: Math.abs(point.x - origin.x) / 2,
              radiusY: Math.abs(point.y - origin.y) / 2,
            };
          }
          return { ...current, annotations };
        });
      },
      [cropDraft, state, tool],
    );

    const finishDrawing = useCallback(() => {
      if (tool === "crop") {
        gestureOriginRef.current = null;
        return;
      }
      if (!gestureStartRef.current) return;
      const previous = gestureStartRef.current;
      gestureStartRef.current = null;
      gestureOriginRef.current = null;
      setPast((items) => [...items, previous]);
      setFuture([]);
    }, [tool]);

    const handleInteractionPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || tool === "text") return;
        const point = imagePointAt(event.clientX, event.clientY);
        if (!point) return;
        startDrawing(point);
      },
      [imagePointAt, startDrawing, tool],
    );

    const handleInteractionPointerMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        continueDrawing(imagePointAt(event.clientX, event.clientY));
      },
      [continueDrawing, imagePointAt],
    );

    const handleInteractionClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (tool !== "text") return;
        const point = imagePointAt(event.clientX, event.clientY);
        if (point) setTextDraft({ ...point, value: "" });
      },
      [imagePointAt, tool],
    );

    const applyCrop = useCallback(() => {
      if (!state || !cropDraft || cropDraft.width < 2 || cropDraft.height < 2) return;
      commit({ ...state, crop: cropDraft });
      setCropDraft(null);
      gestureOriginRef.current = null;
      setTool("arrow");
    }, [commit, cropDraft, state]);

    const commitText = useCallback(() => {
      if (!state || !textDraft) return;
      const value = textDraft.value.trim();
      if (value) {
        commit({
          ...state,
          annotations: [
            ...state.annotations,
            {
              id: `annotation-${++drawingIdRef.current}`,
              type: "text",
              x: textDraft.x,
              y: textDraft.y,
              text: value,
              color,
              fontSize: Math.max(16, strokeWidth * 6),
            },
          ],
        });
      }
      setTextDraft(null);
    }, [color, commit, state, strokeWidth, textDraft]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        exportFile: async () => {
          if (!image || !state) throw new Error(labels.loadFailed);
          const exportStage = new Konva.Stage({
            container: document.createElement("div"),
            width: state.crop.width,
            height: state.crop.height,
          });
          const layer = new Konva.Layer();
          exportStage.add(layer);
          layer.add(new Konva.Image({ image, x: -state.crop.x, y: -state.crop.y }));
          for (const annotation of state.annotations)
            layer.add(annotationNode(annotation, state.crop));
          layer.draw();
          const canvas = exportStage.toCanvas({ pixelRatio: 1 });
          const blob = await canvasToBlob(canvas, mimeType);
          exportStage.destroy();
          return new File([blob], fileName, { type: mimeType });
        },
      }),
      [fileName, image, labels.loadFailed, mimeType, state],
    );

    return (
      <div
        className="flex h-full min-h-0 flex-col bg-background"
        data-testid="image-editor-surface"
      >
        {(() => {
          const toolbar = (
            <div
              className="piwork-scrollbar-hidden flex min-h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/70 px-2 py-1.5"
              role="toolbar"
              aria-label={labels.toolbar}
            >
              <button
                type="button"
                className={toolbarButtonClass(false)}
                disabled={past.length === 0}
                onClick={undo}
                aria-label={labels.undo}
                title={labels.undo}
              >
                <Undo2 />
              </button>
              <button
                type="button"
                className={toolbarButtonClass(false)}
                disabled={future.length === 0}
                onClick={redo}
                aria-label={labels.redo}
                title={labels.redo}
              >
                <Redo2 />
              </button>
              <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
              <ToolButton tool="crop" activeTool={tool} label={labels.crop} onSelect={selectTool}>
                <Crop />
              </ToolButton>
              <ToolButton tool="pen" activeTool={tool} label={labels.pen} onSelect={selectTool}>
                <PenLine />
              </ToolButton>
              <ToolButton tool="arrow" activeTool={tool} label={labels.arrow} onSelect={selectTool}>
                <MoveUpRight />
              </ToolButton>
              <ToolButton
                tool="rect"
                activeTool={tool}
                label={labels.rectangle}
                onSelect={selectTool}
              >
                <Square />
              </ToolButton>
              <ToolButton
                tool="ellipse"
                activeTool={tool}
                label={labels.ellipse}
                onSelect={selectTool}
              >
                <Circle />
              </ToolButton>
              <ToolButton tool="text" activeTool={tool} label={labels.text} onSelect={selectTool}>
                <Type />
              </ToolButton>
              <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
              <button
                ref={colorButtonRef}
                type="button"
                className={toolbarButtonClass(Boolean(colorPanelPosition))}
                onClick={toggleColorPanel}
                aria-label={labels.color}
                title={labels.color}
                aria-expanded={Boolean(colorPanelPosition)}
              >
                <span
                  className="h-4 w-4 rounded-full border border-border"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
              </button>
              <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
              <div className="flex shrink-0 items-center gap-2 px-1">
                <input
                  type="range"
                  min="1"
                  max="24"
                  step="1"
                  value={strokeWidth}
                  onChange={(event) => setStrokeWidth(Number(event.target.value))}
                  aria-label={labels.strokeWidth}
                  className="h-1.5 w-24 cursor-pointer accent-primary"
                />
                <output className="w-8 text-right text-xs tabular-nums text-[var(--piwork-editor-foreground)]">
                  {strokeWidth}px
                </output>
              </div>
              {tool === "crop" && cropDraft && cropDraft.width >= 2 && cropDraft.height >= 2 && (
                <button
                  type="button"
                  onClick={applyCrop}
                  className="ml-1 flex h-8 shrink-0 items-center gap-1 rounded-[var(--piwork-control-radius)] bg-primary px-2.5 text-xs font-semibold text-primary-foreground"
                  aria-label={labels.applyCrop}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {labels.applyCrop}
                </button>
              )}
            </div>
          );
          if (toolbarPortalTarget) return createPortal(toolbar, toolbarPortalTarget);
          return toolbarPortalId ? null : toolbar;
        })()}
        {createPortal(
          <DropdownMotion
            open={Boolean(colorPanelPosition)}
            ref={colorPanelRef}
            role="dialog"
            aria-label={labels.color}
            className="fixed z-[var(--piwork-z-popover)] w-56 rounded-[var(--piwork-panel-radius)] border border-border bg-popover p-3 text-popover-foreground"
            style={colorPanelPosition || lastColorPanelPositionRef.current || undefined}
          >
            <div className="flex flex-wrap gap-2">
              {COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={`${labels.color} ${item}`}
                  title={`${labels.color} ${item}`}
                  onClick={() => {
                    setColor(item);
                    setColorPanelPosition(null);
                  }}
                  className={`h-7 w-7 rounded-full border transition-colors ${color === item ? "border-foreground ring-1 ring-foreground/30" : "border-border"}`}
                  style={{ backgroundColor: item }}
                />
              ))}
            </div>
            <label className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>{labels.customColor}</span>
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  setColorPanelPosition(null);
                }}
                aria-label={labels.customColor}
                className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
            </label>
          </DropdownMotion>,
          colorButtonRef.current?.ownerDocument.body || document.body,
        )}
        <div
          ref={hostRef}
          className={`relative min-h-0 flex-1 overflow-hidden bg-background ${tool === "text" ? "cursor-text" : "cursor-crosshair"}`}
          data-testid="image-editor-canvas"
        >
          {!image && !loadFailed && (
            <div
              className="flex h-full items-center justify-center text-sm text-muted-foreground"
              aria-busy="true"
            >
              {labels.loading}
            </div>
          )}
          {loadFailed && (
            <div
              className="flex h-full items-center justify-center text-sm text-danger"
              role="alert"
            >
              {labels.loadFailed}
            </div>
          )}
          {image && state && layout && (
            <Stage ref={stageRef} width={viewport.width} height={viewport.height}>
              <Layer>
                <Group
                  x={layout.x}
                  y={layout.y}
                  scaleX={layout.scale}
                  scaleY={layout.scale}
                  clipX={0}
                  clipY={0}
                  clipWidth={state.crop.width}
                  clipHeight={state.crop.height}
                >
                  <KonvaImage image={image} x={-state.crop.x} y={-state.crop.y} listening={false} />
                  {state.annotations.map((annotation) => (
                    <AnnotationShape
                      key={annotation.id}
                      annotation={annotation}
                      crop={state.crop}
                    />
                  ))}
                </Group>
                {cropDraft && (
                  <>
                    <Rect
                      x={0}
                      y={0}
                      width={viewport.width}
                      height={viewport.height}
                      fill={IMAGE_EDITOR_CONTENT_COLORS.cropMask}
                      listening={false}
                    />
                    <Group
                      clipX={layout.x + (cropDraft.x - state.crop.x) * layout.scale}
                      clipY={layout.y + (cropDraft.y - state.crop.y) * layout.scale}
                      clipWidth={cropDraft.width * layout.scale}
                      clipHeight={cropDraft.height * layout.scale}
                      listening={false}
                    >
                      <Group x={layout.x} y={layout.y} scaleX={layout.scale} scaleY={layout.scale}>
                        <KonvaImage
                          image={image}
                          x={-state.crop.x}
                          y={-state.crop.y}
                          listening={false}
                        />
                        {state.annotations.map((annotation) => (
                          <AnnotationShape
                            key={`crop-${annotation.id}`}
                            annotation={annotation}
                            crop={state.crop}
                          />
                        ))}
                      </Group>
                    </Group>
                    <Rect
                      x={layout.x + (cropDraft.x - state.crop.x) * layout.scale}
                      y={layout.y + (cropDraft.y - state.crop.y) * layout.scale}
                      width={cropDraft.width * layout.scale}
                      height={cropDraft.height * layout.scale}
                      stroke={IMAGE_EDITOR_CONTENT_COLORS.cropHandle}
                      dash={[6, 4]}
                      strokeWidth={1}
                      listening={false}
                    />
                  </>
                )}
              </Layer>
            </Stage>
          )}
          {image && state && layout && (
            <div
              className="absolute inset-0 z-10 touch-none"
              data-testid="image-editor-interaction-layer"
              onClick={handleInteractionClick}
              onPointerDown={handleInteractionPointerDown}
              onPointerMove={handleInteractionPointerMove}
              onPointerUp={finishDrawing}
              onPointerCancel={finishDrawing}
              onPointerLeave={finishDrawing}
            />
          )}
          {image && state && layout && textDraft && (
            <input
              autoFocus
              value={textDraft.value}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitText();
                }
                if (event.key === "Escape") setTextDraft(null);
              }}
              onBlur={commitText}
              placeholder={labels.textPlaceholder}
              aria-label={labels.textPlaceholder}
              className="absolute z-10 min-w-32 border-0 border-b-2 bg-card px-1.5 py-1 text-sm font-semibold text-foreground outline-none"
              style={{
                left: layout.x + (textDraft.x - state.crop.x) * layout.scale,
                top: layout.y + (textDraft.y - state.crop.y) * layout.scale,
                borderColor: color,
              }}
            />
          )}
          <ImagePreviewZoomControls
            path={fileName}
            scalePercent={Math.round(zoomScale * 100)}
            onZoomOut={zoomOut}
            onZoomIn={zoomIn}
            onReset={resetZoom}
          />
        </div>
      </div>
    );
  }),
);

function ToolButton({
  tool,
  activeTool,
  label,
  onSelect,
  children,
}: {
  tool: ImageEditorTool;
  activeTool: ImageEditorTool;
  label: string;
  onSelect: (tool: ImageEditorTool) => void;
  children: React.ReactElement;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tool)}
      aria-label={label}
      title={label}
      aria-pressed={activeTool === tool}
      className={toolbarButtonClass(activeTool === tool)}
    >
      {children}
    </button>
  );
}

function toolbarButtonClass(active: boolean): string {
  return `flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-[var(--piwork-editor-foreground)] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35 [&>svg]:h-4 [&>svg]:w-4 ${active ? "bg-accent" : ""}`;
}

function AnnotationShape({ annotation, crop }: { annotation: Annotation; crop: CropBox }) {
  const common = { stroke: annotation.color, listening: false };
  if (annotation.type === "pen")
    return (
      <Line
        {...common}
        points={shiftPoints(annotation.points, crop)}
        strokeWidth={annotation.width}
        lineCap="round"
        lineJoin="round"
        tension={0.15}
      />
    );
  if (annotation.type === "arrow")
    return (
      <Arrow
        {...common}
        points={shiftPoints(annotation.points, crop)}
        strokeWidth={annotation.width}
        pointerLength={annotation.width * 3.5}
        pointerWidth={annotation.width * 3.5}
        lineCap="round"
        lineJoin="round"
      />
    );
  if (annotation.type === "rect")
    return (
      <Rect
        {...common}
        x={annotation.x - crop.x}
        y={annotation.y - crop.y}
        width={annotation.width}
        height={annotation.height}
        strokeWidth={annotation.strokeWidth}
      />
    );
  if (annotation.type === "ellipse")
    return (
      <Ellipse
        {...common}
        x={annotation.x - crop.x}
        y={annotation.y - crop.y}
        radiusX={annotation.radiusX}
        radiusY={annotation.radiusY}
        strokeWidth={annotation.strokeWidth}
      />
    );
  return (
    <Text
      x={annotation.x - crop.x}
      y={annotation.y - crop.y}
      text={annotation.text}
      fill={annotation.color}
      fontSize={annotation.fontSize}
      fontStyle="bold"
      listening={false}
    />
  );
}

function annotationNode(annotation: Annotation, crop: CropBox): Konva.Shape {
  if (annotation.type === "pen")
    return new Konva.Line({
      points: shiftPoints(annotation.points, crop),
      stroke: annotation.color,
      strokeWidth: annotation.width,
      lineCap: "round",
      lineJoin: "round",
      tension: 0.15,
    });
  if (annotation.type === "arrow")
    return new Konva.Arrow({
      points: shiftPoints(annotation.points, crop),
      stroke: annotation.color,
      fill: annotation.color,
      strokeWidth: annotation.width,
      pointerLength: annotation.width * 3.5,
      pointerWidth: annotation.width * 3.5,
      lineCap: "round",
      lineJoin: "round",
    });
  if (annotation.type === "rect")
    return new Konva.Rect({
      x: annotation.x - crop.x,
      y: annotation.y - crop.y,
      width: annotation.width,
      height: annotation.height,
      stroke: annotation.color,
      strokeWidth: annotation.strokeWidth,
    });
  if (annotation.type === "ellipse")
    return new Konva.Ellipse({
      x: annotation.x - crop.x,
      y: annotation.y - crop.y,
      radiusX: annotation.radiusX,
      radiusY: annotation.radiusY,
      stroke: annotation.color,
      strokeWidth: annotation.strokeWidth,
    });
  return new Konva.Text({
    x: annotation.x - crop.x,
    y: annotation.y - crop.y,
    text: annotation.text,
    fill: annotation.color,
    fontSize: annotation.fontSize,
    fontStyle: "bold",
  });
}

function shiftPoints(points: number[], crop: CropBox): number[] {
  return points.map((value, index) => value - (index % 2 === 0 ? crop.x : crop.y));
}

function normalizeBox(startX: number, startY: number, endX: number, endY: number): CropBox {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: ImageEditorSurfaceProps["mimeType"],
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))),
      mimeType,
      mimeType === "image/jpeg" ? 0.92 : undefined,
    );
  });
}
