import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ChatMessage } from "../types.js";
import type { FeedDisplayItem } from "./chat-work-groups.js";
import { buildFeedLayoutRows } from "./message-feed-layout.js";
import {
  MAX_SAVED_MESSAGE_FEED_STATES,
  MessageFeedStateLruCache,
  findSavedFeedAnchorIndex,
  getMessageFeedNearBottomThreshold,
  getSavedFeedAnchorScrollOffset,
  getTocRowOffsetWithinRow,
} from "./use-message-feed-virtualizer.js";

function message(id: string, role: ChatMessage["role"]): FeedDisplayItem {
  return { kind: "message", msg: { id, role, content: id, timestamp: 1 } };
}

describe("message feed scroll anchoring", () => {
  it("uses one dynamic measurement source for width reflow", () => {
    const source = readFileSync(
      new URL("./use-message-feed-virtualizer.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("virtualizer.measureElement(element)");
    expect(source).not.toContain(".resizeItem(");
    expect(source).not.toContain(".measure();");
    expect(source).toContain("item.end > viewportStart + 0.5");
    expect(source).toContain("const scrollToRowStart = useCallback");
    expect(source).toContain("geometryAnchorRef.current = anchor");
  });

  it("keeps TOC-aligned messages below the title bar inset", () => {
    const source = readFileSync(new URL("./MessageFeed.tsx", import.meta.url), "utf8");

    expect(source).toContain("topInset: MESSAGE_FEED_EDGE_INSET_PX");
    expect(source).not.toContain("scrollPaddingStart: MESSAGE_FEED_EDGE_INSET_PX");
    expect(source).toContain("messageTocStore.get().currentId === messageId");
    expect(source).toContain("scrollToRowStart(rowKey, index)");
    expect(source).not.toContain('virtualizer.scrollToIndex(index, { align: "start"');
  });

  it("subtracts the later turn's internal gap when aligning a TOC target", () => {
    const rows = buildFeedLayoutRows([
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
    ]);

    expect(getTocRowOffsetWithinRow(rows, 0, 14)).toBe(-14);
    expect(getTocRowOffsetWithinRow(rows, 1, 14)).toBe(0);
  });

  it("uses the existing adaptive near-bottom threshold", () => {
    expect(getMessageFeedNearBottomThreshold(0)).toBe(0);
    expect(getMessageFeedNearBottomThreshold(2)).toBe(1);
    expect(getMessageFeedNearBottomThreshold(100)).toBe(35);
    expect(getMessageFeedNearBottomThreshold(1000)).toBe(120);
  });

  it("restores a logical row by stable key after prepend", () => {
    const before = buildFeedLayoutRows([
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
    ]);
    const anchor = { key: before[1]!.key, offsetWithinRow: 24 };
    const after = buildFeedLayoutRows([
      message("user-0", "user"),
      message("assistant-0", "assistant"),
      ...before.flatMap((row) => row.entries),
    ]);

    expect(findSavedFeedAnchorIndex(after, anchor)).toBe(2);
    expect(findSavedFeedAnchorIndex(after, { key: "missing", offsetWithinRow: 0 })).toBe(-1);
  });

  it("keeps the same viewport-relative row offset across repeated width cycles", () => {
    const anchor = { key: "turn:user-10", offsetWithinRow: 82 };
    const rowStarts = [1093, 1118, 1093, 1118, 1093, 1118];

    const viewportTops = rowStarts.map(
      (rowStart) => rowStart - getSavedFeedAnchorScrollOffset(rowStart, anchor),
    );

    expect(viewportTops).toEqual([-82, -82, -82, -82, -82, -82]);
  });
});

describe("message feed saved-state cache", () => {
  it("evicts the least recently used session at a small fixed limit", () => {
    expect(MAX_SAVED_MESSAGE_FEED_STATES).toBe(16);

    const cache = new MessageFeedStateLruCache<string>(3);
    cache.set("session-a", "a");
    cache.set("session-b", "b");
    cache.set("session-c", "c");

    expect(cache.get("session-a")).toBe("a");
    cache.set("session-d", "d");

    expect(cache.size).toBe(3);
    expect(cache.has("session-a")).toBe(true);
    expect(cache.has("session-b")).toBe(false);
    expect(cache.has("session-c")).toBe(true);
    expect(cache.has("session-d")).toBe(true);
  });

  it("treats an overwritten session as most recently used", () => {
    const cache = new MessageFeedStateLruCache<string>(2);
    cache.set("session-a", "old-a");
    cache.set("session-b", "b");
    cache.set("session-a", "new-a");
    cache.set("session-c", "c");

    expect(cache.get("session-a")).toBe("new-a");
    expect(cache.has("session-b")).toBe(false);
    expect(cache.has("session-c")).toBe(true);
  });

  it("clears one session or the entire cache", () => {
    const cache = new MessageFeedStateLruCache<string>(3);
    cache.set("session-a", "a");
    cache.set("session-b", "b");
    cache.delete("session-a");

    expect(cache.has("session-a")).toBe(false);
    expect(cache.has("session-b")).toBe(true);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
