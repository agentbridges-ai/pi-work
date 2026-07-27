import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  defaultRangeExtractor,
  measureElement,
  observeElementRect,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import { MESSAGE_FEED_TURN_GAP_PX, type FeedLayoutRow } from "./message-feed-layout.js";
import { estimateFeedLayoutRowHeight } from "./message-feed-estimator.js";

export interface SavedFeedAnchor {
  key: string;
  offsetWithinRow: number;
}

interface SavedFeedState {
  anchor: SavedFeedAnchor | null;
  isPinned: boolean;
  measurements: VirtualItem[];
  rowKeys: string[];
  scrollOffset: number;
  width: number;
}

interface UseMessageFeedVirtualizerOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  estimateWidth: number;
  rows: FeedLayoutRow[];
  scrollMargin: number;
  topInset?: number;
  sessionId: string;
  onRangeChange?: (indexes: number[], pinned: boolean) => void;
}

export const MAX_SAVED_MESSAGE_FEED_STATES = 16;

export class MessageFeedStateLruCache<State> {
  private readonly states = new Map<string, State>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Message feed state cache limit must be a positive integer");
    }
  }

  get size(): number {
    return this.states.size;
  }

  get(sessionId: string): State | undefined {
    if (!this.states.has(sessionId)) return undefined;
    const state = this.states.get(sessionId)!;
    this.states.delete(sessionId);
    this.states.set(sessionId, state);
    return state;
  }

  set(sessionId: string, state: State): void {
    this.states.delete(sessionId);
    this.states.set(sessionId, state);
    while (this.states.size > this.limit) {
      const oldest = this.states.keys().next();
      if (oldest.done) return;
      this.states.delete(oldest.value);
    }
  }

  has(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }

  clear(): void {
    this.states.clear();
  }
}

const savedFeedStateBySession = new MessageFeedStateLruCache<SavedFeedState>(
  MAX_SAVED_MESSAGE_FEED_STATES,
);

export function clearSavedMessageFeedState(sessionId: string): void {
  savedFeedStateBySession.delete(sessionId);
}

export function clearAllSavedMessageFeedStates(): void {
  savedFeedStateBySession.clear();
}

export function getMessageFeedNearBottomThreshold(scrollRange: number): number {
  if (!Number.isFinite(scrollRange) || scrollRange <= 0) return 0;
  return Math.min(120, Math.max(1, scrollRange * 0.35));
}

export function captureFeedAnchor(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  rows: readonly FeedLayoutRow[],
  scrollOffset: number,
  container?: HTMLDivElement | null,
): SavedFeedAnchor | null {
  if (rows.length === 0) return null;
  if (container) {
    const containerRect = container.getBoundingClientRect();
    const firstVisibleElement = Array.from(
      container.querySelectorAll<HTMLElement>("[data-feed-row-key]"),
    )
      .filter((element) => element.getBoundingClientRect().bottom > containerRect.top)
      .sort(
        (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
      )[0];
    const key = firstVisibleElement?.dataset.feedRowKey;
    if (firstVisibleElement && key && rows.some((row) => row.key === key)) {
      return {
        key,
        offsetWithinRow: containerRect.top - firstVisibleElement.getBoundingClientRect().top,
      };
    }
  }
  const item = virtualizer.getVirtualItemForOffset(Math.max(0, scrollOffset));
  const row = item ? rows[item.index] : undefined;
  if (!item || !row) return null;
  return {
    key: row.key,
    offsetWithinRow: scrollOffset - item.start,
  };
}

export function findSavedFeedAnchorIndex(
  rows: readonly FeedLayoutRow[],
  anchor: SavedFeedAnchor | null,
): number {
  if (!anchor) return -1;
  return rows.findIndex((row) => row.key === anchor.key);
}

export function getSavedFeedAnchorScrollOffset(rowStart: number, anchor: SavedFeedAnchor): number {
  // TanStack measurements already include scrollMargin in rowStart. Adding it
  // again shifts the row by the feed's 14px top inset on every new baseline.
  return rowStart + anchor.offsetWithinRow;
}

export function getTocRowOffsetWithinRow(
  rows: readonly FeedLayoutRow[],
  index: number,
  topInset: number,
): number {
  const row = rows[index];
  const rowContentInset = index > 0 && row?.kind === "turn" ? MESSAGE_FEED_TURN_GAP_PX : 0;
  return rowContentInset - topInset;
}

function haveSameRowKeys(
  rows: readonly FeedLayoutRow[],
  saved: SavedFeedState | undefined,
): boolean {
  if (!saved || rows.length !== saved.rowKeys.length) return false;
  return rows.every((row, index) => row.key === saved.rowKeys[index]);
}

function getVisibleRangeIndexes(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  topInset: number,
): number[] {
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  const viewportStart = scrollOffset + topInset;
  const viewportEnd = scrollOffset + viewportHeight - virtualizer.options.scrollPaddingEnd;
  const measuredVisibleIndexes = virtualizer
    .getVirtualItems()
    .filter((item) => item.end > viewportStart + 0.5 && item.start < viewportEnd - 0.5)
    .map((item) => item.index);
  if (measuredVisibleIndexes.length > 0) return measuredVisibleIndexes;

  const range = virtualizer.range;
  if (!range) return [];
  return Array.from(
    { length: range.endIndex - range.startIndex + 1 },
    (_, offset) => range.startIndex + offset,
  );
}

export function useMessageFeedVirtualizer({
  containerRef,
  estimateWidth,
  rows,
  scrollMargin,
  topInset = 0,
  sessionId,
  onRangeChange,
}: UseMessageFeedVirtualizerOptions) {
  const initialSavedStateRef = useRef(savedFeedStateBySession.get(sessionId));
  const compatibleInitialState =
    haveSameRowKeys(rows, initialSavedStateRef.current) &&
    Math.abs((initialSavedStateRef.current?.width ?? estimateWidth) - estimateWidth) < 1
      ? initialSavedStateRef.current
      : undefined;
  const rowsRef = useRef(rows);
  const widthRef = useRef(estimateWidth);
  const pinnedRef = useRef(compatibleInitialState?.isPinned ?? true);
  const onRangeChangeRef = useRef(onRangeChange);
  const restoredRef = useRef(false);
  const geometryAnchorRef = useRef<SavedFeedAnchor | null>(null);
  const applyingGeometryScrollRef = useRef(false);
  const anchorRestoreFrameRef = useRef<number | null>(null);
  const activeAnchorRef = useRef<SavedFeedAnchor | null>(null);
  const readingAnchorRef = useRef<SavedFeedAnchor | null>(null);
  const manualScrollRef = useRef(false);
  const [isPinned, setIsPinned] = useState(pinnedRef.current);
  const [scrollEndThreshold, setScrollEndThreshold] = useState(1);

  rowsRef.current = rows;
  onRangeChangeRef.current = onRangeChange;

  const getItemKey = useCallback(
    (index: number) => rowsRef.current[index]?.key ?? `missing-row:${index}`,
    [],
  );
  const estimateSize = useCallback((index: number) => {
    const row = rowsRef.current[index];
    if (!row) return 96;
    return estimateFeedLayoutRowHeight(row, widthRef.current, index > 0);
  }, []);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    const anchorIndex = findSavedFeedAnchorIndex(rowsRef.current, geometryAnchorRef.current);
    if (anchorIndex < 0 || indexes.includes(anchorIndex)) return indexes;
    return [...indexes, anchorIndex].sort((left, right) => left - right);
  }, []);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    getItemKey,
    estimateSize,
    measureElement: (element, entry, instance) => {
      const measured = measureElement(element, entry, instance);
      if (measured > 0) return measured;
      const index = Number(element.getAttribute(instance.options.indexAttribute));
      return Number.isFinite(index) ? instance.options.estimateSize(index) : 96;
    },
    rangeExtractor,
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) => {
        callback({
          width: rect.width > 0 ? rect.width : estimateWidth || 736,
          height: rect.height > 0 ? rect.height : 800,
        });
      }),
    overscan: 6,
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold,
    scrollMargin,
    useAnimationFrameWithResizeObserver: false,
    initialMeasurementsCache: compatibleInitialState?.measurements,
    initialOffset: compatibleInitialState?.scrollOffset ?? 0,
    initialRect: { width: estimateWidth || 736, height: 800 },
    directDomUpdates: true,
    directDomUpdatesMode: "transform",
    onChange: (instance, sync) => {
      const container = containerRef.current;
      if (!container) return;
      let geometryAnchor = geometryAnchorRef.current;
      const geometryAnchorIndex = findSavedFeedAnchorIndex(rowsRef.current, geometryAnchor);
      if (geometryAnchor && geometryAnchorIndex < 0) {
        geometryAnchorRef.current = null;
        geometryAnchor = null;
      }
      if (!sync && geometryAnchor && !applyingGeometryScrollRef.current) {
        const offsetInfo = instance.getOffsetForIndex(geometryAnchorIndex, "start");
        if (offsetInfo) {
          const targetOffset = getSavedFeedAnchorScrollOffset(offsetInfo[0], geometryAnchor);
          if (Math.abs(container.scrollTop - targetOffset) > 0.5) {
            applyingGeometryScrollRef.current = true;
            instance.scrollToOffset(targetOffset, { align: "start", behavior: "auto" });
            applyingGeometryScrollRef.current = false;
          }
        }
      }
      const scrollRange = Math.max(0, container.scrollHeight - container.clientHeight);
      const threshold = getMessageFeedNearBottomThreshold(scrollRange);
      const distanceFromEnd = Math.max(0, scrollRange - container.scrollTop);
      const nextPinned = geometryAnchor
        ? false
        : scrollRange <= 0 || distanceFromEnd <= (manualScrollRef.current ? 1 : threshold);
      if (nextPinned) manualScrollRef.current = false;
      // A dynamic row can outgrow the old inner-container height in the same
      // ResizeObserver delivery. The core applies its delta before React's
      // adapter publishes the new total height, so the browser may clamp that
      // write to the previous maximum. The adapter has updated the height by
      // the time this callback runs; finish the same pinned resize transaction.
      if (!sync && pinnedRef.current && nextPinned && distanceFromEnd > 1) {
        instance.scrollToEnd({ behavior: "auto" });
      }
      if (nextPinned) {
        readingAnchorRef.current = null;
      } else if (sync && !activeAnchorRef.current) {
        readingAnchorRef.current = captureFeedAnchor(
          instance,
          rowsRef.current,
          container.scrollTop,
          container,
        );
      }
      if (nextPinned !== pinnedRef.current) {
        pinnedRef.current = nextPinned;
        setIsPinned(nextPinned);
      }
      onRangeChangeRef.current?.(getVisibleRangeIndexes(instance, topInset), nextPinned);
    },
  });

  const syncScrollState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollRange = Math.max(0, container.scrollHeight - container.clientHeight);
    const threshold = getMessageFeedNearBottomThreshold(scrollRange);
    const distanceFromEnd = Math.max(0, scrollRange - container.scrollTop);
    const manualScrollActive = manualScrollRef.current;
    const nextPinned = geometryAnchorRef.current
      ? false
      : scrollRange <= 0 || distanceFromEnd <= (manualScrollActive ? 1 : threshold);
    if (nextPinned) manualScrollRef.current = false;
    const nextScrollEndThreshold = manualScrollActive && !nextPinned ? 1 : threshold;
    setScrollEndThreshold((current) =>
      Math.abs(current - nextScrollEndThreshold) < 0.5 ? current : nextScrollEndThreshold,
    );
    if (nextPinned !== pinnedRef.current) {
      pinnedRef.current = nextPinned;
      setIsPinned(nextPinned);
    }
    if (nextPinned) {
      readingAnchorRef.current = null;
    } else if (!activeAnchorRef.current) {
      readingAnchorRef.current = captureFeedAnchor(
        virtualizer,
        rowsRef.current,
        container.scrollTop,
        container,
      );
    }
    onRangeChangeRef.current?.(getVisibleRangeIndexes(virtualizer, topInset), nextPinned);
  }, [containerRef, topInset, virtualizer]);

  const scrollToEnd = useCallback(() => {
    activeAnchorRef.current = null;
    readingAnchorRef.current = null;
    geometryAnchorRef.current = null;
    if (anchorRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorRestoreFrameRef.current);
      anchorRestoreFrameRef.current = null;
    }
    manualScrollRef.current = false;
    pinnedRef.current = true;
    setIsPinned(true);
    virtualizer.scrollToEnd({ behavior: "auto" });
  }, [virtualizer]);

  const scheduleActiveAnchorCorrection = useCallback(() => {
    if (anchorRestoreFrameRef.current !== null) return;
    anchorRestoreFrameRef.current = requestAnimationFrame(() => {
      anchorRestoreFrameRef.current = null;
      const anchor = activeAnchorRef.current;
      if (!anchor) return;
      const container = containerRef.current;
      const rowElement = Array.from(
        container?.querySelectorAll<HTMLElement>("[data-feed-row-key]") || [],
      ).find((element) => element.dataset.feedRowKey === anchor.key);
      if (!container || !rowElement) return;
      const delta =
        rowElement.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        anchor.offsetWithinRow;
      if (Math.abs(delta) > 0.5) {
        virtualizer.scrollToOffset(container.scrollTop + delta, {
          align: "start",
          behavior: "auto",
        });
      }
      activeAnchorRef.current = null;
    });
  }, [containerRef, virtualizer]);

  const restoreAnchor = useCallback(
    (anchor: SavedFeedAnchor | null): boolean => {
      if (!anchor) return false;
      const index = findSavedFeedAnchorIndex(rowsRef.current, anchor);
      if (index < 0) return false;
      activeAnchorRef.current = anchor;
      readingAnchorRef.current = anchor;
      if (anchorRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorRestoreFrameRef.current);
        anchorRestoreFrameRef.current = null;
      }
      const container = containerRef.current;
      const mountedRow = Array.from(
        container?.querySelectorAll<HTMLElement>("[data-feed-row-key]") || [],
      ).find((element) => element.dataset.feedRowKey === anchor.key);
      if (container && mountedRow) {
        // Geometry reflow keeps the visible anchor mounted. Restore from its
        // actual DOM position in one write; scrollToIndex would first jump to a
        // stale/estimated offset and only return on the following frame.
        const delta =
          mountedRow.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          anchor.offsetWithinRow;
        if (Math.abs(delta) > 0.5) {
          virtualizer.scrollToOffset(container.scrollTop + delta, {
            align: "start",
            behavior: "auto",
          });
        }
      } else {
        virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
      }
      scheduleActiveAnchorCorrection();
      return true;
    },
    [containerRef, scheduleActiveAnchorCorrection, virtualizer],
  );

  const cancelAnchorRestore = useCallback(() => {
    activeAnchorRef.current = null;
    readingAnchorRef.current = null;
    geometryAnchorRef.current = null;
    if (anchorRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorRestoreFrameRef.current);
      anchorRestoreFrameRef.current = null;
    }
  }, []);

  const beginManualScroll = useCallback(() => {
    cancelAnchorRestore();
    manualScrollRef.current = true;
    setScrollEndThreshold(1);
    if (pinnedRef.current) {
      pinnedRef.current = false;
      setIsPinned(false);
    }
  }, [cancelAnchorRestore]);

  const scrollToRowStart = useCallback(
    (key: string, index: number) => {
      // Later turn rows carry the inter-turn gap as padding inside the measured
      // row. Align the user message inside that padding, not the row border;
      // otherwise every TOC target after the first lands one extra gap too low.
      const anchor = {
        key,
        offsetWithinRow: getTocRowOffsetWithinRow(rowsRef.current, index, topInset),
      };
      manualScrollRef.current = false;
      activeAnchorRef.current = null;
      readingAnchorRef.current = anchor;
      geometryAnchorRef.current = anchor;
      pinnedRef.current = false;
      setIsPinned(false);

      const container = containerRef.current;
      const mountedRow = Array.from(
        container?.querySelectorAll<HTMLElement>("[data-feed-row-key]") || [],
      ).find((element) => element.dataset.feedRowKey === key);
      if (container && mountedRow) {
        const messageAnchor = mountedRow.querySelector<HTMLElement>(
          '[data-message-anchor-role="user"]',
        );
        const targetOffset = Math.max(
          0,
          container.scrollTop +
            ((messageAnchor || mountedRow).getBoundingClientRect().top -
              container.getBoundingClientRect().top -
              topInset),
        );
        virtualizer.scrollToOffset(targetOffset, { align: "start", behavior: "auto" });
        return;
      }
      const offsetInfo = virtualizer.getOffsetForIndex(index, "start");
      if (offsetInfo) {
        virtualizer.scrollToOffset(Math.max(0, offsetInfo[0] + anchor.offsetWithinRow), {
          align: "start",
          behavior: "auto",
        });
      }
    },
    [containerRef, topInset, virtualizer],
  );

  const relayoutForGeometry = useCallback(
    (nextWidth: number) => {
      if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
      const widthChanged = Math.abs(widthRef.current - nextWidth) >= 1;
      if (widthChanged && !pinnedRef.current && !geometryAnchorRef.current) {
        const container = containerRef.current;
        // Keep this logical row and its viewport-relative offset until the user
        // explicitly changes the reading position. A time-based "resize ended"
        // guess lets late ResizeObserver/scroll deliveries become a new baseline
        // and accumulates drift over repeated width round trips.
        geometryAnchorRef.current =
          readingAnchorRef.current ||
          (container
            ? captureFeedAnchor(virtualizer, rowsRef.current, container.scrollTop, container)
            : null);
      }
      // Mounted rows are width-observed by measureElement. Updating this ref is
      // enough for rows first rendered after the resize; do not mix resizeItem
      // or measure() into the same measurement path.
      widthRef.current = nextWidth;
    },
    [containerRef, virtualizer],
  );

  const remeasureRowNow = useCallback(
    (key: string): boolean => {
      const index = rowsRef.current.findIndex((row) => row.key === key);
      if (index < 0) return false;
      const container = containerRef.current;
      const element = Array.from(
        container?.querySelectorAll<HTMLDivElement>("[data-feed-row-key]") || [],
      ).find((candidate) => candidate.dataset.feedRowKey === key);
      if (!element) return false;
      virtualizer.measureElement(element);
      return true;
    },
    [containerRef, virtualizer],
  );

  useLayoutEffect(() => {
    if (restoredRef.current || rows.length === 0) return;
    restoredRef.current = true;
    const saved = initialSavedStateRef.current;
    if (saved && !saved.isPinned && restoreAnchor(saved.anchor)) {
      pinnedRef.current = false;
      setIsPinned(false);
      return;
    }
    scrollToEnd();
  }, [restoreAnchor, rows.length, scrollToEnd]);

  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (anchorRestoreFrameRef.current !== null) {
        cancelAnimationFrame(anchorRestoreFrameRef.current);
        anchorRestoreFrameRef.current = null;
      }
      const currentRows = rowsRef.current;
      if (!container) return;
      savedFeedStateBySession.set(sessionId, {
        anchor: captureFeedAnchor(virtualizer, currentRows, container.scrollTop, container),
        isPinned: pinnedRef.current,
        measurements: virtualizer.takeSnapshot(),
        rowKeys: currentRows.map((row) => row.key),
        scrollOffset: container.scrollTop,
        width: widthRef.current,
      });
    };
  }, [containerRef, sessionId, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return useMemo(
    () => ({
      cancelAnchorRestore,
      beginManualScroll,
      isPinned,
      remeasureRowNow,
      relayoutForGeometry,
      restoreAnchor,
      scrollToRowStart,
      scrollToEnd,
      syncScrollState,
      totalSize,
      virtualItems,
      virtualizer,
    }),
    [
      cancelAnchorRestore,
      beginManualScroll,
      isPinned,
      remeasureRowNow,
      relayoutForGeometry,
      restoreAnchor,
      scrollToRowStart,
      scrollToEnd,
      syncScrollState,
      totalSize,
      virtualItems,
      virtualizer,
    ],
  );
}
