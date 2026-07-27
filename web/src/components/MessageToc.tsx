import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChatMessage } from "../types.js";
import { uiCopy } from "../ui-copy.js";
import type { FeedDisplayItem } from "./chat-work-groups.js";

export interface MessageTocItem {
  id: string;
  ordinal: number;
  preview: string;
  responsePreview: string;
  imageCount: number;
}

export interface ActiveTocSnapshot {
  currentId: string | null;
  visibleIds: readonly string[];
}

export interface ActiveTocStore {
  get: () => ActiveTocSnapshot;
  set: (value: ActiveTocSnapshot | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export interface TocGeometry {
  startY: number;
  spacing: number;
  centerYs: number[];
  contentHeight: number;
}

export interface TickStyle {
  width: number;
  opacity: number;
}

const EMPTY_ACTIVE_TOC_SNAPSHOT: ActiveTocSnapshot = {
  currentId: null,
  visibleIds: [],
};

const MAX_PREVIEW_LENGTH = 280;
const RAIL_WIDTH_PX = 56;
const RAIL_EDGE_INSET_PX = 24;
const RAIL_MAX_HEIGHT_RATIO = 0.8;
const TICK_LEFT_PAD_PX = 14;
const TICK_RIGHT_PAD_PX = 2;
const TICK_HEIGHT_PX = 2;
const TICK_BASE_W = 6;
const TICK_MAX_W = 30;
const TICK_SPACING_PX = 10;
const TICK_REST_OPACITY = 0.2;
const TICK_ANCHOR_OPACITY = 0.9;
const TICK_FOCUS_OPACITY = 1;
const TOOLTIP_ESTIMATED_H_PX = 56;
const TOOLTIP_OFFSET_X_PX = 8;

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(Date.now()), 16);
}

function cancelFrameId(frameId: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frameId);
    return;
  }
  window.clearTimeout(frameId);
}

function normalizePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > MAX_PREVIEW_LENGTH
    ? `${collapsed.slice(0, MAX_PREVIEW_LENGTH).trimEnd()}…`
    : collapsed;
}

function getMessageTextPreview(message: ChatMessage): string {
  const content = normalizePreview(message.content);
  if (content) return content;
  const textParts = message.contentParts
    ?.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      return "";
    })
    .join("\n");
  return normalizePreview(textParts || "");
}

function areStringListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function areActiveTocSnapshotsEqual(a: ActiveTocSnapshot, b: ActiveTocSnapshot): boolean {
  return a.currentId === b.currentId && areStringListsEqual(a.visibleIds, b.visibleIds);
}

export function createActiveTocStore(): ActiveTocStore {
  let current: ActiveTocSnapshot = EMPTY_ACTIVE_TOC_SNAPSHOT;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      const next = value ?? EMPTY_ACTIVE_TOC_SNAPSHOT;
      if (areActiveTocSnapshotsEqual(next, current)) return;
      current = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function deriveMessageTocItems(entries: readonly FeedDisplayItem[]): MessageTocItem[] {
  const items: MessageTocItem[] = [];
  let currentTurnIndex = -1;

  for (const entry of entries) {
    if (entry.kind !== "message") continue;

    const { msg } = entry;
    if (msg.role === "user") {
      const imageCount = msg.images?.length ?? 0;
      items.push({
        id: msg.id,
        ordinal: items.length + 1,
        preview:
          getMessageTextPreview(msg) ||
          (imageCount > 0 ? uiCopy.messageToc.imageMessage : uiCopy.messageToc.emptyMessage),
        responsePreview: "",
        imageCount,
      });
      currentTurnIndex = items.length - 1;
      continue;
    }

    if (msg.role === "assistant" && currentTurnIndex >= 0) {
      const responsePreview = getMessageTextPreview(msg);
      if (responsePreview) {
        items[currentTurnIndex]!.responsePreview = responsePreview;
      }
    }
  }

  return items;
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

export function computeTocGeometry(input: {
  count: number;
  spacingPx?: number;
  paddingPx?: number;
}): TocGeometry | null {
  const { count } = input;
  if (count <= 0) return null;
  const spacing = count <= 1 ? 0 : (input.spacingPx ?? TICK_SPACING_PX);
  const padding = input.paddingPx ?? 12;
  const centerYs = Array.from({ length: count }, (_value, index) => padding + index * spacing);
  return {
    startY: padding,
    spacing,
    centerYs,
    contentHeight: 2 * padding + (count - 1) * spacing,
  };
}

export function computeSigma(spacing: number): number {
  return clampNumber(spacing * 1.5, Math.min(spacing * 2, 8), 22);
}

export function computeGaussianWeights(
  centerYs: readonly number[],
  pointerY: number,
  sigma: number,
): number[] {
  if (sigma <= 0) {
    return centerYs.map((centerY) => (centerY === pointerY ? 1 : 0));
  }
  const twoSigmaSquared = 2 * sigma * sigma;
  return centerYs.map((centerY) => {
    const distance = centerY - pointerY;
    return Math.exp(-(distance * distance) / twoSigmaSquared);
  });
}

export function computeTickStyles(
  weights: readonly number[],
  currentAnchorIndex: number | null,
  baseW: number,
  maxW: number,
  restOpacity: number,
  anchorOpacity: number,
): TickStyle[] {
  return weights.map((weight, index) => ({
    width: baseW + (maxW - baseW) * weight,
    opacity: index === currentAnchorIndex ? anchorOpacity : restOpacity,
  }));
}

export function computeRestStyles(
  count: number,
  currentAnchorIndex: number | null,
  baseW: number,
  restOpacity: number,
  anchorOpacity: number,
): TickStyle[] {
  return Array.from({ length: count }, (_value, index) => ({
    width: baseW,
    opacity: index === currentAnchorIndex ? anchorOpacity : restOpacity,
  }));
}

export function computeFocusedIndex(pointerY: number, geometry: TocGeometry): number {
  const count = geometry.centerYs.length;
  if (count <= 1 || geometry.spacing === 0) return 0;
  if (!Number.isFinite(pointerY)) return 0;
  const endY = geometry.startY + (count - 1) * geometry.spacing;
  const clampedY = clampNumber(pointerY, geometry.startY, endY);
  return clampNumber(Math.round((clampedY - geometry.startY) / geometry.spacing), 0, count - 1);
}

export function clampTooltipTop(
  centerY: number,
  tooltipH: number,
  railH: number,
  margin = 4,
): number {
  const half = tooltipH / 2 + margin;
  return clampNumber(centerY, half, Math.max(half, railH - half));
}

export function MessageToc({
  items,
  activeStore,
  onSelect,
  onRailElementChange,
  railLeftPx: providedRailLeftPx,
  railRightPx,
  railWidthPx,
  side = "left",
}: {
  items: readonly MessageTocItem[];
  activeStore: ActiveTocStore;
  onSelect: (id: string) => void;
  onRailElementChange?: (element: HTMLElement | null) => void;
  railLeftPx?: number | null;
  railRightPx?: number | null;
  railWidthPx?: number | null;
  side?: "left" | "right";
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipMessageRef = useRef<HTMLDivElement | null>(null);
  const tooltipResponseRef = useRef<HTMLDivElement | null>(null);
  const tickRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tooltipId = useId();
  const setRootElement = useCallback(
    (element: HTMLElement | null) => {
      rootRef.current = element;
      onRailElementChange?.(element);
    },
    [onRailElementChange],
  );

  const [rovingIndex, setRovingIndex] = useState(0);
  const trailSnapshot = useSyncExternalStore(
    activeStore.subscribe,
    activeStore.get,
    activeStore.get,
  );
  const anchorIndex = useMemo(
    () => items.findIndex((item) => item.id === trailSnapshot.currentId),
    [items, trailSnapshot.currentId],
  );
  const visible = items.length > 1;
  const geometry = useMemo(
    () => computeTocGeometry({ count: items.length, spacingPx: TICK_SPACING_PX }),
    [items.length],
  );

  const rafIdRef = useRef<number | null>(null);
  const latestPointerClientYRef = useRef<number | null>(null);
  const focusOverrideIndexRef = useRef<number | null>(null);
  const geometryRef = useRef<TocGeometry | null>(geometry);
  geometryRef.current = geometry;
  const viewportTopRef = useRef(0);
  const tooltipIndexRef = useRef(-1);
  const reducedMotionRef = useRef(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const anchorIndexRef = useRef(anchorIndex);
  anchorIndexRef.current = anchorIndex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const requestedRailWidthPx =
    typeof railWidthPx === "number" ? Math.max(1, railWidthPx) : RAIL_WIDTH_PX;
  const effectiveRailWidthPx =
    side === "right"
      ? Math.max(requestedRailWidthPx, TICK_MAX_W + TICK_RIGHT_PAD_PX * 2)
      : requestedRailWidthPx;
  const rightRailLeftAdjustmentPx =
    side === "right" && typeof railRightPx !== "number"
      ? effectiveRailWidthPx - requestedRailWidthPx
      : 0;
  const railLeftPx =
    typeof providedRailLeftPx === "number"
      ? Math.max(0, providedRailLeftPx - rightRailLeftAdjustmentPx)
      : RAIL_EDGE_INSET_PX;
  const railPositionStyle =
    typeof railRightPx === "number"
      ? { right: Math.max(0, railRightPx), width: effectiveRailWidthPx }
      : { left: railLeftPx, width: effectiveRailWidthPx };
  const maxTickWidthPx = TICK_MAX_W;

  if (tickRefs.current.length !== items.length) {
    tickRefs.current = Array.from<HTMLButtonElement | null>({ length: items.length }).fill(null);
  }

  const writeStyles = useCallback((styles: readonly TickStyle[]) => {
    const refs = tickRefs.current;
    for (let index = 0; index < styles.length; index += 1) {
      const el = refs[index];
      if (!el) continue;
      el.style.width = `${styles[index]!.width}px`;
      el.style.opacity = `${styles[index]!.opacity}`;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    tooltipIndexRef.current = -1;
    const tip = tooltipRef.current;
    if (tip) tip.style.visibility = "hidden";
  }, []);

  const showTooltip = useCallback((index: number, geometryValue: TocGeometry) => {
    const tip = tooltipRef.current;
    const item = itemsRef.current[index];
    if (!tip || !item) return;

    if (tooltipIndexRef.current !== index) {
      tooltipIndexRef.current = index;
      if (tooltipMessageRef.current) {
        tooltipMessageRef.current.textContent = item.preview;
      }
      if (tooltipResponseRef.current) {
        tooltipResponseRef.current.textContent = item.responsePreview;
        tooltipResponseRef.current.style.display = item.responsePreview ? "" : "none";
      }
    }

    const viewport = viewportRef.current;
    const viewportHeight = viewport?.clientHeight ?? 0;
    const tooltipHeight = tip.offsetHeight || TOOLTIP_ESTIMATED_H_PX;
    const centerY = geometryValue.centerYs[index] ?? viewportHeight / 2;
    const visibleY = centerY - (viewport?.scrollTop ?? 0);
    const offsetTop = viewport?.offsetTop ?? 0;
    tip.style.top = `${offsetTop + clampTooltipTop(visibleY, tooltipHeight, viewportHeight)}px`;
    tip.style.visibility = "visible";
  }, []);

  const applyRest = useCallback(() => {
    const styles = computeRestStyles(
      itemsRef.current.length,
      anchorIndexRef.current,
      TICK_BASE_W,
      TICK_REST_OPACITY,
      TICK_ANCHOR_OPACITY,
    );
    writeStyles(styles);
    hideTooltip();
  }, [hideTooltip, writeStyles]);

  const layoutTicks = useCallback(() => {
    const geometryValue = geometryRef.current;
    if (!geometryValue) return;
    const refs = tickRefs.current;
    for (let index = 0; index < refs.length; index += 1) {
      const el = refs[index];
      if (!el) continue;
      const centerY = geometryValue.centerYs[index] ?? 0;
      el.style.top = `${centerY - TICK_HEIGHT_PX / 2}px`;
    }
    if (latestPointerClientYRef.current === null && focusOverrideIndexRef.current === null) {
      applyRest();
    }
  }, [applyRest]);

  const renderFrame = useCallback(() => {
    rafIdRef.current = null;
    const geometryValue = geometryRef.current;
    if (!geometryValue || !visibleRef.current) return;

    const count = itemsRef.current.length;
    let activeY: number | null = null;
    const rawPointerY = latestPointerClientYRef.current;
    if (rawPointerY !== null) {
      activeY = rawPointerY + (viewportRef.current?.scrollTop ?? 0);
    } else if (focusOverrideIndexRef.current !== null) {
      activeY = geometryValue.centerYs[focusOverrideIndexRef.current] ?? null;
    }
    if (activeY === null) {
      applyRest();
      return;
    }

    const focusedIndex = computeFocusedIndex(activeY, geometryValue);
    let styles: TickStyle[];
    if (geometryValue.spacing === 0 || reducedMotionRef.current) {
      styles = computeRestStyles(count, null, TICK_BASE_W, TICK_REST_OPACITY, TICK_ANCHOR_OPACITY);
      const focusedStyle = styles[focusedIndex];
      if (focusedStyle) focusedStyle.width = maxTickWidthPx;
    } else {
      const weights = computeGaussianWeights(
        geometryValue.centerYs,
        activeY,
        computeSigma(geometryValue.spacing),
      );
      styles = computeTickStyles(
        weights,
        null,
        TICK_BASE_W,
        maxTickWidthPx,
        TICK_REST_OPACITY,
        TICK_ANCHOR_OPACITY,
      );
    }
    const focusedStyle = styles[focusedIndex];
    if (focusedStyle) focusedStyle.opacity = TICK_FOCUS_OPACITY;
    writeStyles(styles);
    showTooltip(focusedIndex, geometryValue);
  }, [applyRest, maxTickWidthPx, showTooltip, writeStyles]);

  const scheduleFrame = useCallback(() => {
    if (rafIdRef.current === null) {
      rafIdRef.current = requestFrame(renderFrame);
    }
  }, [renderFrame]);

  const cancelScheduledFrame = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelFrameId(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    layoutTicks();
  }, [geometry, layoutTicks]);

  useEffect(() => {
    if (latestPointerClientYRef.current === null && focusOverrideIndexRef.current === null) {
      applyRest();
    }
  }, [anchorIndex, applyRest]);

  useEffect(() => {
    reducedMotionRef.current =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
  }, []);

  useEffect(() => {
    if (!visible) {
      cancelScheduledFrame();
      latestPointerClientYRef.current = null;
      focusOverrideIndexRef.current = null;
      hideTooltip();
    }
  }, [cancelScheduledFrame, hideTooltip, visible]);

  useEffect(() => cancelScheduledFrame, [cancelScheduledFrame]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch" || !visibleRef.current) return;
      latestPointerClientYRef.current = event.clientY - viewportTopRef.current;
      scheduleFrame();
    },
    [scheduleFrame],
  );

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch" || !visibleRef.current) return;
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) viewportTopRef.current = rect.top;
      latestPointerClientYRef.current = event.clientY - viewportTopRef.current;
      scheduleFrame();
    },
    [scheduleFrame],
  );

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") return;
      latestPointerClientYRef.current = null;
      cancelScheduledFrame();
      if (focusOverrideIndexRef.current !== null) {
        scheduleFrame();
      } else {
        applyRest();
      }
    },
    [applyRest, cancelScheduledFrame, scheduleFrame],
  );

  const handleRailScroll = useCallback(() => {
    if (latestPointerClientYRef.current !== null || focusOverrideIndexRef.current !== null) {
      scheduleFrame();
    }
  }, [scheduleFrame]);

  const handleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const geometryValue = geometryRef.current;
    const viewport = viewportRef.current;
    if (!geometryValue || !viewport) return;
    const contentY = event.clientY - viewport.getBoundingClientRect().top + viewport.scrollTop;
    const item = itemsRef.current[computeFocusedIndex(contentY, geometryValue)];
    if (item) onSelectRef.current(item.id);
  }, []);

  const focusTick = useCallback((index: number) => {
    setRovingIndex(index);
    tickRefs.current[index]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const count = itemsRef.current.length;
      if (count === 0) return;
      const current = clampNumber(rovingIndex, 0, count - 1);
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusTick(Math.min(count - 1, current + 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          focusTick(Math.max(0, current - 1));
          break;
        case "Home":
          event.preventDefault();
          focusTick(0);
          break;
        case "End":
          event.preventDefault();
          focusTick(count - 1);
          break;
        case "Enter":
        case " ": {
          event.preventDefault();
          const item = itemsRef.current[current];
          if (item) onSelectRef.current(item.id);
          break;
        }
        case "Escape":
          tickRefs.current[current]?.blur();
          break;
        default:
          break;
      }
    },
    [focusTick, rovingIndex],
  );

  const handleTickFocus = useCallback(
    (index: number) => {
      focusOverrideIndexRef.current = index;
      const geometryValue = geometryRef.current;
      if (geometryValue) showTooltip(index, geometryValue);
      scheduleFrame();
    },
    [scheduleFrame, showTooltip],
  );

  const handleRailBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      const root = rootRef.current;
      if (root && event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
        return;
      }
      focusOverrideIndexRef.current = null;
      if (latestPointerClientYRef.current === null) applyRest();
    },
    [applyRest],
  );

  const tabStop = clampNumber(rovingIndex, 0, Math.max(0, items.length - 1));

  return (
    <nav
      ref={setRootElement}
      aria-label={uiCopy.messageToc.label}
      aria-hidden={!visible}
      data-testid="message-toc"
      onKeyDown={handleKeyDown}
      onBlur={handleRailBlur}
      className={cx(
        "absolute inset-y-0 z-20 hidden flex-col justify-center sm:flex",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      style={railPositionStyle}
    >
      <div
        data-testid="message-toc-viewport"
        ref={viewportRef}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onScroll={handleRailScroll}
        onClick={handleClick}
        className={cx(
          "relative w-full overflow-y-auto overscroll-contain [contain:layout] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          visible ? "pointer-events-auto" : "pointer-events-none",
        )}
        style={{ maxHeight: `${RAIL_MAX_HEIGHT_RATIO * 100}%` }}
      >
        <div className="relative w-full" style={{ height: geometry?.contentHeight }}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(el) => {
                tickRefs.current[index] = el;
              }}
              type="button"
              tabIndex={visible && index === tabStop ? 0 : -1}
              aria-label={uiCopy.messageToc.jumpToMessage(item.ordinal, item.preview.slice(0, 60))}
              aria-describedby={tooltipId}
              aria-current={index === anchorIndex ? "location" : undefined}
              onClick={(event) => {
                // Focusing a tick can scroll the narrow rail before the click
                // bubbles. Select by the tick's stable identity instead of
                // asking the rail to reconstruct it from now-stale geometry.
                event.stopPropagation();
                onSelectRef.current(item.id);
              }}
              onFocus={() => handleTickFocus(index)}
              className="absolute rounded-full bg-foreground outline-none transition-[width] duration-[90ms] ease-out will-change-[width] focus-visible:ring-2 focus-visible:ring-border motion-reduce:transition-none"
              style={{
                ...(side === "right" ? { right: TICK_RIGHT_PAD_PX } : { left: TICK_LEFT_PAD_PX }),
                height: TICK_HEIGHT_PX,
                width: TICK_BASE_W,
                opacity: index === anchorIndex ? TICK_ANCHOR_OPACITY : TICK_REST_OPACITY,
              }}
            />
          ))}
        </div>
      </div>
      <div
        data-testid="message-toc-tooltip"
        ref={tooltipRef}
        role="tooltip"
        id={tooltipId}
        className="piwork-superellipse-panel pointer-events-none invisible absolute z-30 w-64 -translate-y-1/2 rounded-xl border border-border bg-popover p-2 text-left text-foreground [corner-shape:superellipse(1.5)]"
        style={
          side === "right"
            ? { right: effectiveRailWidthPx + TOOLTIP_OFFSET_X_PX, top: 0 }
            : { left: effectiveRailWidthPx + TOOLTIP_OFFSET_X_PX, top: 0 }
        }
      >
        <div
          ref={tooltipMessageRef}
          className="line-clamp-2 text-xs font-medium leading-snug text-foreground"
        />
        <div
          ref={tooltipResponseRef}
          className="mt-1 line-clamp-3 text-xs leading-snug text-muted-foreground"
        />
      </div>
    </nav>
  );
}
