import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useStore } from "../store.js";
import { loadSessionHistoryPage } from "../ws.js";
import type { ChatMessage, ProposePlanInteractionRequest } from "../types.js";
import { TimelineRailScope } from "./TimelineRail.js";
import { TimelinePlanNode } from "./TimelinePlanNode.js";
import {
  createTimelineRenderContext,
  TimelineEntries,
  type TimelineDisclosureController,
} from "./TimelineFeed.js";
import { buildFeedDisplayItems } from "./chat-work-groups.js";
import {
  buildFeedLayoutRows,
  findFeedLayoutRowIndexByMessageId,
  MESSAGE_FEED_PAGE_SIZE,
  MESSAGE_FEED_TURN_GAP_PX,
  sliceFeedLayoutRows,
  type FeedLayoutRow,
} from "./message-feed-layout.js";
import { useMessageFeedVirtualizer } from "./use-message-feed-virtualizer.js";
import { CodexArrowIcon } from "./CodexIcons.js";
import { AgentThinking } from "./AgentThinking.js";
import { createActiveTocStore, deriveMessageTocItems, MessageToc } from "./MessageToc.js";
import { uiCopy } from "../ui-copy.js";
import { WORKBENCH_GEOMETRY } from "../workbench-geometry.js";

const SCROLL_TOP_PREFETCH_PX = 120;
const DEFAULT_COMPOSER_BOTTOM_INSET_PX = WORKBENCH_GEOMETRY.composerBottomInsetPx;
const SCROLL_BUTTON_COMPOSER_OFFSET_PX = 8;
const MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX = 24;
const MESSAGE_TOC_SCROLLBAR_SAFE_GAP_PX = 8;
const MESSAGE_TOC_TICK_RIGHT_PAD_PX = 2;
const MESSAGE_TOC_TICK_BASE_WIDTH_PX = 6;
const MESSAGE_TOC_TICK_MAX_WIDTH_PX = 30;
const MESSAGE_TOC_MIN_INTERACTIVE_WIDTH_PX =
  MESSAGE_TOC_TICK_MAX_WIDTH_PX + MESSAGE_TOC_TICK_RIGHT_PAD_PX * 2;
const MESSAGE_TOC_REST_MESSAGE_GAP_PX = 8;
const MESSAGE_FEED_EDGE_INSET_PX = 14;

const EMPTY_MESSAGES: ChatMessage[] = [];

interface FeedGeometry {
  contentWidth: number;
  messageTocRail: { left: number; width: number } | null;
  scrollMargin: number;
  scrollbarGutter: number;
  viewportHeight: number;
}

const DEFAULT_GEOMETRY: FeedGeometry = {
  contentWidth: WORKBENCH_GEOMETRY.composerWidthPx,
  messageTocRail: null,
  scrollMargin: MESSAGE_FEED_EDGE_INSET_PX,
  scrollbarGutter: 0,
  viewportHeight: 800,
};

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function areRailsEqual(
  left: FeedGeometry["messageTocRail"],
  right: FeedGeometry["messageTocRail"],
): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left.left - right.left) < 0.5 && Math.abs(left.width - right.width) < 0.5;
}

function areGeometriesEqual(left: FeedGeometry, right: FeedGeometry): boolean {
  return (
    Math.abs(left.contentWidth - right.contentWidth) < 1 &&
    Math.abs(left.scrollMargin - right.scrollMargin) < 1 &&
    Math.abs(left.scrollbarGutter - right.scrollbarGutter) < 1 &&
    Math.abs(left.viewportHeight - right.viewportHeight) < 1 &&
    areRailsEqual(left.messageTocRail, right.messageTocRail)
  );
}

function getMessageTocRail(
  root: HTMLElement,
  content: HTMLElement,
): FeedGeometry["messageTocRail"] {
  const rootRect = root.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const rootWidth = Math.max(0, rootRect.width);
  const safeRight = Math.max(0, rootWidth - MESSAGE_TOC_SCROLLBAR_SAFE_GAP_PX);

  if (rootWidth <= 0 || contentRect.width <= 0) {
    return {
      left: Math.max(0, safeRight - MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX),
      width: MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX,
    };
  }

  const contentRight = clampNumber(contentRect.right - rootRect.left, 0, safeRight);
  const gutterWidth = Math.max(0, safeRight - contentRight);
  const minRailWidth = MESSAGE_TOC_TICK_RIGHT_PAD_PX + MESSAGE_TOC_TICK_BASE_WIDTH_PX;
  const tickRightEdge =
    gutterWidth > 0
      ? clampNumber(
          contentRight + MESSAGE_TOC_REST_MESSAGE_GAP_PX + MESSAGE_TOC_TICK_BASE_WIDTH_PX,
          Math.min(safeRight, contentRight + MESSAGE_TOC_TICK_BASE_WIDTH_PX),
          safeRight,
        )
      : safeRight;
  const desiredLeft =
    gutterWidth > 0 ? contentRight : Math.max(0, safeRight - MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX);
  const width = clampNumber(
    tickRightEdge + MESSAGE_TOC_TICK_RIGHT_PAD_PX - desiredLeft,
    minRailWidth,
    MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX,
  );
  return {
    left:
      Math.round(
        clampNumber(
          tickRightEdge + MESSAGE_TOC_TICK_RIGHT_PAD_PX - width,
          0,
          Math.max(0, safeRight - width),
        ) * 100,
      ) / 100,
    width: Math.round(width * 100) / 100,
  };
}

function applyMessageTocRailGeometry(
  element: HTMLElement | null,
  rail: FeedGeometry["messageTocRail"],
): void {
  if (!element || !rail) return;
  const effectiveWidth = Math.max(rail.width, MESSAGE_TOC_MIN_INTERACTIVE_WIDTH_PX);
  const left = `${Math.max(0, rail.left - (effectiveWidth - rail.width))}px`;
  const width = `${effectiveWidth}px`;
  if (element.style.left !== left) element.style.left = left;
  if (element.style.right) element.style.right = "";
  if (element.style.width !== width) element.style.width = width;
}

export function MessageFeed(props: {
  sessionId: string;
  suppressScrollToBottom?: boolean;
  bottomInsetPx?: number;
  hasUserSpace?: boolean;
  onOpenWorkspace?: () => void;
  onPrefillComposer?: (text: string) => void;
}) {
  return <MessageFeedSession key={props.sessionId} {...props} />;
}

function MessageFeedSession({
  sessionId,
  suppressScrollToBottom = false,
  bottomInsetPx,
}: {
  sessionId: string;
  suppressScrollToBottom?: boolean;
  bottomInsetPx?: number;
  hasUserSpace?: boolean;
  onOpenWorkspace?: () => void;
  onPrefillComposer?: (text: string) => void;
}) {
  const storedMessages = useStore((state) => state.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const runState = useStore((state) => state.runStates.get(sessionId));
  const runActive = useStore((state) => Boolean(state.runActive.get(sessionId)));
  const toolProgress = useStore((state) => state.toolProgress.get(sessionId));
  const toolActivity = useStore((state) => state.toolActivity.get(sessionId));
  const pendingInteractionsForSession = useStore((state) =>
    state.pendingInteractions.get(sessionId),
  );

  const feedRootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const historyHeaderRef = useRef<HTMLDivElement>(null);
  const virtualListRef = useRef<HTMLDivElement>(null);
  const messageTocElementRef = useRef<HTMLElement>(null);
  const previousTailRowKeyRef = useRef<string | null>(null);
  const previousLastStoredMessageIdRef = useRef(storedMessages[storedMessages.length - 1]?.id);
  const geometryRef = useRef(DEFAULT_GEOMETRY);
  const messageTocStoreRef = useRef<ReturnType<typeof createActiveTocStore> | null>(null);
  const [visibleEntryBudget, setVisibleEntryBudget] = useState(MESSAGE_FEED_PAGE_SIZE);
  const [sessionHistoryHasMore, setSessionHistoryHasMore] = useState(false);
  const [sessionHistoryLoaded, setSessionHistoryLoaded] = useState(false);
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const [sessionHistoryError, setSessionHistoryError] = useState("");
  const [timelineDisclosureOpenById, setTimelineDisclosureOpenById] = useState<
    Map<string, boolean>
  >(() => new Map());
  const [geometry, setGeometry] = useState(DEFAULT_GEOMETRY);

  if (messageTocStoreRef.current === null) {
    messageTocStoreRef.current = createActiveTocStore();
  }
  const messageTocStore = messageTocStoreRef.current;

  const messages = useMemo(
    () => (runActive ? storedMessages : storedMessages.filter((message) => !message.isStreaming)),
    [runActive, storedMessages],
  );
  const persistedPlanTexts = useMemo(() => collectPersistedPlanTexts(messages), [messages]);
  const pendingPlanInteractions = useMemo(() => {
    if (!pendingInteractionsForSession) return [];
    return Array.from(pendingInteractionsForSession.values()).filter(
      (interaction): interaction is ProposePlanInteractionRequest =>
        interaction.kind === "propose_plan" &&
        interaction.plan.trim().length > 0 &&
        !persistedPlanTexts.has(interaction.plan.trim()),
    );
  }, [pendingInteractionsForSession, persistedPlanTexts]);
  const hasInlineInteractionCard = Boolean(pendingInteractionsForSession?.size);

  const groupedEntries = useMemo(() => buildFeedDisplayItems(messages), [messages]);
  const allRows = useMemo(() => buildFeedLayoutRows(groupedEntries), [groupedEntries]);
  const layoutWindow = useMemo(
    () => sliceFeedLayoutRows(allRows, visibleEntryBudget),
    [allRows, visibleEntryBudget],
  );
  const rows = useMemo<FeedLayoutRow[]>(() => {
    if (layoutWindow.rows.length > 0) return layoutWindow.rows;
    if (!hasInlineInteractionCard && runState !== "compacting" && !runActive) {
      return [];
    }
    return [
      {
        key: `tail:${sessionId}`,
        kind: "prelude",
        entries: [],
        entryCount: 0,
        userMessageId: null,
      },
    ];
  }, [runActive, layoutWindow.rows, hasInlineInteractionCard, sessionId, runState]);
  const timelineRenderContext = useMemo(
    () => createTimelineRenderContext(layoutWindow.entries),
    [layoutWindow.entries],
  );
  const messageTocItems = useMemo(
    () => deriveMessageTocItems(layoutWindow.entries),
    [layoutWindow.entries],
  );

  const completedToolUseIds = useMemo(() => collectCompletedToolUseIds(messages), [messages]);
  const awaitingToolIds = useMemo(() => {
    const ids = new Set<string>();
    if (!pendingInteractionsForSession) return ids;
    for (const interaction of pendingInteractionsForSession.values()) {
      if (interaction.toolCallId) ids.add(interaction.toolCallId);
    }
    return ids;
  }, [pendingInteractionsForSession]);
  const runningToolIds = useMemo(
    () =>
      new Set(
        toolProgress
          ? Array.from(toolProgress.keys()).filter(
              (toolUseId) =>
                !completedToolUseIds.has(toolUseId) &&
                !isComposerPendingToolName(toolProgress.get(toolUseId)?.toolName) &&
                !isImplicitlyCompletedControlTool(
                  toolUseId,
                  toolProgress.get(toolUseId)?.toolName,
                  awaitingToolIds,
                ),
            )
          : [],
      ),
    [awaitingToolIds, completedToolUseIds, toolProgress],
  );
  const activeToolProgress = useMemo(() => {
    if (!toolProgress) return [];
    return Array.from(toolProgress.entries())
      .filter(
        ([toolUseId, value]) =>
          !awaitingToolIds.has(toolUseId) &&
          !completedToolUseIds.has(toolUseId) &&
          !isComposerPendingToolName(value.toolName) &&
          !isImplicitlyCompletedControlTool(toolUseId, value.toolName, awaitingToolIds),
      )
      .map(([, value]) => value);
  }, [awaitingToolIds, completedToolUseIds, toolProgress]);

  const showBottomWorkingIndicator =
    !hasInlineInteractionCard && !suppressScrollToBottom && runActive;
  const bottomWorkingLabel = activeToolProgress.length > 0 ? uiCopy.toolBlock.working : undefined;
  const effectiveBottomInsetPx = Math.max(
    0,
    Math.round(bottomInsetPx ?? DEFAULT_COMPOSER_BOTTOM_INSET_PX),
  );
  const scrollButtonBottomPx = Math.max(
    0,
    effectiveBottomInsetPx - SCROLL_BUTTON_COMPOSER_OFFSET_PX,
  );
  const lastRowMinimumHeight = Math.max(
    0,
    geometry.viewportHeight -
      effectiveBottomInsetPx -
      (rows.length === 1 ? MESSAGE_FEED_EDGE_INSET_PX : 0),
  );

  const handleVirtualRangeChange = useCallback(
    (indexes: number[], pinned: boolean) => {
      const visibleIds = indexes
        .map((index) => rows[index]?.userMessageId)
        .filter((id): id is string => Boolean(id));
      let currentId = pinned
        ? (visibleIds[visibleIds.length - 1] ?? null)
        : (visibleIds[0] ?? null);
      if (!currentId && indexes.length > 0) {
        const start = indexes[0] ?? 0;
        for (let index = start; index >= 0; index -= 1) {
          const id = rows[index]?.userMessageId;
          if (id) {
            currentId = id;
            break;
          }
        }
      }
      messageTocStore.set({ currentId, visibleIds });
    },
    [messageTocStore, rows],
  );

  const {
    beginManualScroll,
    cancelAnchorRestore,
    isPinned,
    remeasureRowNow,
    relayoutForGeometry,
    scrollToEnd,
    scrollToRowStart,
    syncScrollState,
    virtualItems,
    virtualizer,
  } = useMessageFeedVirtualizer({
    containerRef,
    estimateWidth: geometry.contentWidth,
    rows,
    scrollMargin: geometry.scrollMargin,
    topInset: MESSAGE_FEED_EDGE_INSET_PX,
    sessionId,
    onRangeChange: handleVirtualRangeChange,
  });

  const lastStoredMessage = storedMessages[storedMessages.length - 1];
  useLayoutEffect(() => {
    const previousId = previousLastStoredMessageIdRef.current;
    previousLastStoredMessageIdRef.current = lastStoredMessage?.id;
    if (
      !lastStoredMessage ||
      lastStoredMessage.id === previousId ||
      lastStoredMessage.role !== "user"
    ) {
      return;
    }
    scrollToEnd();
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
    const frame = requestAnimationFrame(() => {
      scrollToEnd();
      const settledContainer = containerRef.current;
      if (settledContainer) settledContainer.scrollTop = settledContainer.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [lastStoredMessage, scrollToEnd]);

  const tailRowKey = rows[rows.length - 1]?.key ?? null;
  useLayoutEffect(() => {
    const previousTailRowKey = previousTailRowKeyRef.current;
    previousTailRowKeyRef.current = tailRowKey;
    if (previousTailRowKey && previousTailRowKey !== tailRowKey) {
      // The former tail loses its viewport-sized min-block-size in this commit.
      // Measure it synchronously so a missed ResizeObserver delivery cannot
      // leave the next turn positioned after the former minimum height.
      remeasureRowNow(previousTailRowKey);
    }
    // The new tail receives the viewport minimum in the same commit. Keep its
    // cached size aligned even when the observer coalesces the handoff.
    if (tailRowKey) remeasureRowNow(tailRowKey);
  }, [lastRowMinimumHeight, remeasureRowNow, tailRowKey]);

  const setVirtualListElement = useCallback(
    (element: HTMLDivElement | null) => {
      virtualListRef.current = element;
      virtualizer.containerRef(element);
    },
    [virtualizer],
  );

  const setMessageTocElement = useCallback((element: HTMLElement | null) => {
    messageTocElementRef.current = element;
  }, []);

  const updateGeometry = useCallback(() => {
    const root = feedRootRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    const virtualList = virtualListRef.current;
    if (!root || !container || !content || !virtualList) return;

    const containerRect = container.getBoundingClientRect();
    const listRect = virtualList.getBoundingClientRect();
    const next: FeedGeometry = {
      contentWidth: Math.max(
        1,
        content.clientWidth || content.getBoundingClientRect().width || 736,
      ),
      messageTocRail: getMessageTocRail(root, content),
      scrollMargin: Math.max(0, listRect.top - containerRect.top + container.scrollTop),
      scrollbarGutter: Math.max(0, Math.ceil(container.offsetWidth - container.clientWidth)),
      viewportHeight: Math.max(0, container.clientHeight || containerRect.height),
    };
    // ResizeObserver already runs in the browser's layout phase. Move the
    // lightweight TOC rail immediately instead of making it wait for the full
    // message feed React render triggered by the shared geometry state.
    applyMessageTocRailGeometry(messageTocElementRef.current, next.messageTocRail);
    if (areGeometriesEqual(geometryRef.current, next)) return;
    geometryRef.current = next;
    relayoutForGeometry(next.contentWidth);
    setGeometry(next);
  }, [relayoutForGeometry]);

  const hasFeedContent = rows.length > 0;
  useLayoutEffect(() => {
    if (!hasFeedContent) return;
    updateGeometry();
    const root = feedRootRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    const historyHeader = historyHeaderRef.current;
    const virtualList = virtualListRef.current;
    const targets = [root, container, content, historyHeader, virtualList].filter(
      (target): target is HTMLDivElement => Boolean(target),
    );
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateGeometry);
      return () => window.removeEventListener("resize", updateGeometry);
    }
    const observer = new ResizeObserver(updateGeometry);
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [hasFeedContent, updateGeometry]);

  useEffect(() => {
    messageTocStore.set(null);
  }, [messageTocStore]);

  useEffect(() => {
    let cancelled = false;
    const loadInitialHistory = async () => {
      setSessionHistoryLoading(true);
      setSessionHistoryError("");
      const result = await loadSessionHistoryPage(sessionId, { reset: true });
      if (cancelled) return;
      setSessionHistoryLoading(false);
      setSessionHistoryLoaded(result.loaded);
      setSessionHistoryHasMore(result.hasMore);
      setSessionHistoryError(result.error || "");
    };
    void loadInitialHistory();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loadOlderSessionHistory = useCallback(async () => {
    if (sessionHistoryLoading || !sessionHistoryHasMore) return;
    setSessionHistoryLoading(true);
    setSessionHistoryError("");
    const result = await loadSessionHistoryPage(sessionId);
    setSessionHistoryLoading(false);
    setSessionHistoryLoaded(result.loaded);
    setSessionHistoryHasMore(result.hasMore);
    setSessionHistoryError(result.error || "");
    const received = result.received || 0;
    if (!result.error && received > 0) {
      setVisibleEntryBudget((count) => count + received);
    }
  }, [sessionHistoryHasMore, sessionHistoryLoading, sessionId]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    syncScrollState();
    if (
      sessionHistoryLoaded &&
      sessionHistoryHasMore &&
      !sessionHistoryLoading &&
      container.scrollTop <= SCROLL_TOP_PREFETCH_PX &&
      !layoutWindow.hasMore
    ) {
      void loadOlderSessionHistory();
    }
  }, [
    layoutWindow.hasMore,
    loadOlderSessionHistory,
    sessionHistoryHasMore,
    sessionHistoryLoaded,
    sessionHistoryLoading,
    syncScrollState,
  ]);

  const timelineDisclosureController = useMemo<TimelineDisclosureController>(
    () => ({
      isOpen: (id, defaultOpen) => timelineDisclosureOpenById.get(id) ?? defaultOpen,
      onOpenChange: (id, open, defaultOpen) => {
        const currentOpen = timelineDisclosureOpenById.get(id) ?? defaultOpen;
        if (currentOpen === open) return;
        setTimelineDisclosureOpenById((current) => {
          const next = new Map(current);
          if (open === defaultOpen) next.delete(id);
          else next.set(id, open);
          return next;
        });
      },
    }),
    [timelineDisclosureOpenById],
  );

  const scrollToTocMessage = useCallback(
    (messageId: string) => {
      if (messageTocStore.get().currentId === messageId) return;
      const index = findFeedLayoutRowIndexByMessageId(rows, messageId);
      if (index < 0) return;
      cancelAnchorRestore();
      const rowKey = rows[index]?.key;
      if (!rowKey) return;
      scrollToRowStart(rowKey, index);
      messageTocStore.set({
        currentId: messageId,
        visibleIds: messageTocStore.get().visibleIds,
      });
      requestAnimationFrame(syncScrollState);
    },
    [cancelAnchorRestore, messageTocStore, rows, scrollToRowStart, syncScrollState],
  );

  if (messages.length === 0 && runState !== "compacting" && !runActive) {
    if (sessionHistoryError) {
      return (
        <div className="flex-1 flex items-center justify-center px-6">
          <button
            onClick={() => {
              setSessionHistoryError("");
              setSessionHistoryLoading(true);
              void loadSessionHistoryPage(sessionId, { reset: true }).then((result) => {
                setSessionHistoryLoading(false);
                setSessionHistoryLoaded(result.loaded);
                setSessionHistoryHasMore(result.hasMore);
                setSessionHistoryError(result.error || "");
              });
            }}
            className="inline-flex items-center rounded-[var(--piwork-control-radius)] border border-border bg-card px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-accent"
          >
            {uiCopy.messageFeed.reloadSessionHistory}
          </button>
        </div>
      );
    }
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-12"
        data-testid="empty-chat-space"
      >
        <section
          className="w-full max-w-[var(--piwork-composer-width)] text-center"
          aria-labelledby={`empty-chat-title-${sessionId}`}
        >
          <h2
            id={`empty-chat-title-${sessionId}`}
            className="mx-auto max-w-xl text-2xl font-normal leading-8 tracking-tight text-foreground sm:text-3xl sm:leading-10"
          >
            {uiCopy.chat.emptyState.title}
          </h2>
        </section>
      </div>
    );
  }

  const scrollContainerStyle = {
    paddingTop: `${MESSAGE_FEED_EDGE_INSET_PX}px`,
    paddingBottom: `${effectiveBottomInsetPx}px`,
    "--piwork-message-feed-edge-inset": `${MESSAGE_FEED_EDGE_INSET_PX}px`,
    "--piwork-message-scrollbar-gutter": `${geometry.scrollbarGutter}px`,
  } as CSSProperties;
  return (
    <div
      ref={feedRootRef}
      data-testid="message-feed-root"
      className="flex-1 min-h-0 relative overflow-hidden"
    >
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={beginManualScroll}
        onTouchMove={beginManualScroll}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) beginManualScroll();
        }}
        onKeyDown={(event) => {
          if (
            ["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)
          ) {
            beginManualScroll();
          }
        }}
        data-message-feed-scroll-container
        className="message-feed-scroll h-full overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 sm:px-6"
        style={scrollContainerStyle}
      >
        <div
          data-testid="message-feed-aligner"
          className="w-[calc(100%+var(--piwork-message-scrollbar-gutter,0px))]"
        >
          <div
            ref={contentRef}
            data-testid="message-feed-content"
            className="mx-auto w-full max-w-[var(--piwork-composer-width)]"
          >
            <div ref={historyHeaderRef} data-testid="message-feed-history-header">
              {layoutWindow.hasMore && (
                <div className="flex justify-center pb-3">
                  <button
                    onClick={() => setVisibleEntryBudget((count) => count + MESSAGE_FEED_PAGE_SIZE)}
                    className="flex cursor-pointer items-center gap-2 rounded-[var(--piwork-control-radius)] border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground transition-all hover:border-primary/20 hover:bg-accent hover:text-foreground"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="h-3.5 w-3.5"
                    >
                      <path d="M8 3v10M3 8l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {uiCopy.messageFeed.loadMore(
                      Math.min(MESSAGE_FEED_PAGE_SIZE, layoutWindow.hiddenEntryCount),
                    )}
                    <span className="tabular-nums text-muted-foreground/50">
                      {uiCopy.messageFeed.hiddenCount(layoutWindow.hiddenEntryCount)}
                    </span>
                  </button>
                </div>
              )}
              {sessionHistoryLoaded && sessionHistoryHasMore && !layoutWindow.hasMore && (
                <div className="flex justify-center pb-3">
                  <button
                    onClick={() => void loadOlderSessionHistory()}
                    disabled={sessionHistoryLoading}
                    className="px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sessionHistoryLoading
                      ? uiCopy.messageFeed.loadingOlder
                      : uiCopy.messageFeed.loadOlder}
                  </button>
                </div>
              )}
              {sessionHistoryError && (
                <div className="flex justify-center pb-3">
                  <button
                    onClick={() => void loadOlderSessionHistory()}
                    className="px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:text-foreground"
                  >
                    {uiCopy.messageFeed.sessionHistoryLoadFailedRetry}
                  </button>
                </div>
              )}
            </div>

            <div ref={setVirtualListElement} className="relative w-full">
              {virtualItems.map((virtualRow: (typeof virtualItems)[number]) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                const isLastRow = virtualRow.index === rows.length - 1;
                const hasPreviousRow = virtualRow.index > 0;
                return (
                  <div
                    key={row.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    data-feed-row-key={row.key}
                    className="absolute left-0 top-0 w-full"
                    style={{
                      minBlockSize:
                        isLastRow && row.kind === "turn" ? `${lastRowMinimumHeight}px` : undefined,
                      paddingTop:
                        hasPreviousRow && row.kind === "turn"
                          ? `${MESSAGE_FEED_TURN_GAP_PX}px`
                          : undefined,
                    }}
                  >
                    <TimelineRailScope className="timeline-feed-scope">
                      <TimelineEntries
                        entries={row.entries}
                        sessionId={sessionId}
                        toolActivity={toolActivity}
                        runningToolIds={runningToolIds}
                        awaitingToolIds={awaitingToolIds}
                        renderContext={timelineRenderContext}
                        disclosureController={timelineDisclosureController}
                      />
                      {isLastRow &&
                        pendingPlanInteractions.map((interaction) => (
                          <TimelinePlanNode
                            key={interaction.id}
                            id={interaction.id}
                            plan={interaction.plan}
                            tone="warning"
                          />
                        ))}
                    </TimelineRailScope>

                    {isLastRow && runState === "compacting" && (
                      <div className="flex items-center gap-2 py-1 pl-10 text-xs text-warning">
                        <svg
                          className="h-3.5 w-3.5 shrink-0 animate-spin"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="8" cy="8" r="6" opacity="0.2" />
                          <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
                        </svg>
                        <span>{uiCopy.messageFeed.contextOrganizing}</span>
                      </div>
                    )}

                    {isLastRow && showBottomWorkingIndicator && (
                      <div
                        data-testid="streaming-status-line"
                        role="status"
                        aria-label={
                          activeToolProgress.length > 0
                            ? uiCopy.messageFeed.workStepsRunning(activeToolProgress.length)
                            : uiCopy.messageFeed.assistantStreaming
                        }
                        className="mt-2 flex min-h-6 items-center pl-8"
                      >
                        <AgentThinking label={bottomWorkingLabel} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <MessageToc
        items={messageTocItems}
        activeStore={messageTocStore}
        onSelect={scrollToTocMessage}
        onRailElementChange={setMessageTocElement}
        railLeftPx={geometry.messageTocRail?.left ?? null}
        railRightPx={geometry.messageTocRail ? null : MESSAGE_TOC_SCROLLBAR_SAFE_GAP_PX}
        railWidthPx={geometry.messageTocRail?.width ?? MESSAGE_TOC_RIGHT_RAIL_WIDTH_PX}
        side="right"
      />

      {!isPinned && !hasInlineInteractionCard && !suppressScrollToBottom && (
        <div
          data-testid="scroll-to-bottom-aligner"
          className="pointer-events-none absolute left-0 right-0 z-30 px-3 sm:px-6"
          style={{ bottom: `${scrollButtonBottomPx}px` }}
        >
          <div className="mx-auto flex w-full max-w-[var(--piwork-composer-width)] justify-center">
            <button
              type="button"
              onClick={scrollToEnd}
              aria-label={uiCopy.messageFeed.scrollToBottom}
              className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card bg-clip-padding p-0 text-primary hover:bg-accent"
            >
              <CodexArrowIcon className="h-5 w-5" down />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function collectCompletedToolUseIds(messages: ChatMessage[]): Set<string> {
  const completed = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const execution of message.toolExecutions || []) {
      if (["completed", "failed", "cancelled"].includes(execution.status)) {
        completed.add(execution.toolCallId);
      }
    }
  }
  return completed;
}

function collectPersistedPlanTexts(messages: ChatMessage[]): Set<string> {
  const plans = new Set<string>();
  for (const message of messages) {
    for (const execution of message.toolExecutions ?? []) {
      if (execution.toolName !== "propose_plan") continue;
      const plan = typeof execution.input?.plan === "string" ? execution.input.plan.trim() : "";
      if (plan) plans.add(plan);
    }
  }
  return plans;
}

function isImplicitlyCompletedControlTool(
  toolUseId: string,
  toolName: string | undefined,
  awaitingToolIds: Set<string>,
): boolean {
  return !awaitingToolIds.has(toolUseId) && (toolName === "propose_plan" || toolName === "ask");
}

function isComposerPendingToolName(toolName: string | undefined): boolean {
  return toolName === "ask" || toolName === "propose_plan";
}
