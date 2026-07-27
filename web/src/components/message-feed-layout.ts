import type { FeedDisplayItem } from "./chat-work-groups.js";

export const MESSAGE_FEED_PAGE_SIZE = 100;
export const MESSAGE_FEED_TURN_GAP_PX = 14;

export interface FeedLayoutRow {
  key: string;
  kind: "prelude" | "turn";
  entries: FeedDisplayItem[];
  entryCount: number;
  userMessageId: string | null;
}

export interface FeedLayoutWindow {
  rows: FeedLayoutRow[];
  entries: FeedDisplayItem[];
  hiddenEntryCount: number;
  hasMore: boolean;
}

/**
 * Returns the durable identity already carried by the protocol/store model.
 * An array position is deliberately never part of the key: prepend and
 * streaming replacement must not invalidate measurements.
 */
export function getFeedDisplayItemKey(entry: FeedDisplayItem): string {
  if (entry.kind === "message") return `message:${entry.msg.id}`;
  if (entry.kind === "work_group") return `work:${entry.id || entry.firstId}`;
  return `subagent:${entry.taskToolUseId}`;
}

/** Build complete conversational turns before applying the visible budget. */
export function buildFeedLayoutRows(entries: readonly FeedDisplayItem[]): FeedLayoutRow[] {
  const rows: FeedLayoutRow[] = [];
  let current: FeedLayoutRow | null = null;

  for (const entry of entries) {
    const startsTurn = entry.kind === "message" && entry.msg.role === "user";
    if (startsTurn) {
      current = {
        key: `turn:${entry.msg.id}`,
        kind: "turn",
        entries: [],
        entryCount: 0,
        userMessageId: entry.msg.id,
      };
      rows.push(current);
    } else if (current === null) {
      current = {
        key: `prelude:${getFeedDisplayItemKey(entry)}`,
        kind: "prelude",
        entries: [],
        entryCount: 0,
        userMessageId: null,
      };
      rows.push(current);
    }

    current.entries.push(entry);
    current.entryCount += 1;
  }

  return rows;
}

/**
 * Select a tail window at row boundaries. The UI keeps the exact number of
 * hidden protocol/display entries even when one turn exceeds the budget.
 */
export function sliceFeedLayoutRows(
  rows: readonly FeedLayoutRow[],
  minimumVisibleEntries = MESSAGE_FEED_PAGE_SIZE,
): FeedLayoutWindow {
  const totalEntries = rows.reduce((sum, row) => sum + row.entryCount, 0);
  const budget = Math.max(1, Math.floor(minimumVisibleEntries));
  let firstVisibleRow = rows.length;
  let visibleEntryCount = 0;

  while (firstVisibleRow > 0 && visibleEntryCount < budget) {
    firstVisibleRow -= 1;
    visibleEntryCount += rows[firstVisibleRow]?.entryCount ?? 0;
  }

  const visibleRows = rows.slice(firstVisibleRow);
  return {
    rows: visibleRows,
    entries: visibleRows.flatMap((row) => row.entries),
    hiddenEntryCount: Math.max(0, totalEntries - visibleEntryCount),
    hasMore: firstVisibleRow > 0,
  };
}

export function findFeedLayoutRowIndexByMessageId(
  rows: readonly FeedLayoutRow[],
  messageId: string,
): number {
  return rows.findIndex((row) => row.userMessageId === messageId);
}
