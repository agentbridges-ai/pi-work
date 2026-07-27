import type { FeedDisplayItem } from "./chat-work-groups.js";
import type { FeedLayoutRow } from "./message-feed-layout.js";
import { MESSAGE_FEED_TURN_GAP_PX } from "./message-feed-layout.js";

const ASSISTANT_ROW_CHROME_Y = 42;
const USER_ROW_CHROME_Y = 50;
const USER_BUBBLE_MAX_RATIO = 0.86;
const USER_BUBBLE_PADDING_X = 16;
const MIN_TEXT_WIDTH = 120;
const MIN_ENTRY_HEIGHT = 72;
const BODY_LINE_HEIGHT = 24.375;
const HEADING_ONE_LINE_HEIGHT = 25;
const HEADING_TWO_LINE_HEIGHT = 23;
const CODE_LINE_HEIGHT = 21.125;
const TABLE_ROW_HEIGHT = 30;
const TABLE_HEADER_EXTRA = 6;

export function estimateFeedEntryHeight(entry: FeedDisplayItem, width: number): number {
  const text = plainTextForEntry(entry);
  if (!text) return complexEntryEstimate(entry);

  const maxWidth = Math.max(280, Math.min(736, width || 736));
  const role = entry.kind === "message" ? entry.msg.role : "assistant";
  const contentWidth =
    role === "user"
      ? Math.max(
          MIN_TEXT_WIDTH,
          Math.floor(maxWidth * USER_BUBBLE_MAX_RATIO) - USER_BUBBLE_PADDING_X,
        )
      : maxWidth;
  const chromeY = role === "user" ? USER_ROW_CHROME_Y : ASSISTANT_ROW_CHROME_Y;

  return Math.max(
    MIN_ENTRY_HEIGHT,
    estimateMarkdownLikeTextHeight(text, contentWidth, role) + chromeY,
  );
}

export function estimateFeedLayoutRowHeight(
  row: FeedLayoutRow,
  width: number,
  hasPreviousRow: boolean,
): number {
  const entryHeights = row.entries.reduce(
    (total, entry) => total + estimateFeedEntryHeight(entry, width),
    0,
  );
  const internalGaps = Math.max(0, row.entries.length - 1) * 8;
  const turnGap = hasPreviousRow && row.kind === "turn" ? MESSAGE_FEED_TURN_GAP_PX : 0;
  return Math.max(MIN_ENTRY_HEIGHT, entryHeights + internalGaps + turnGap);
}

function plainTextForEntry(entry: FeedDisplayItem): string {
  if (entry.kind !== "message") return "";
  const message = entry.msg;
  if (message.images?.length) return "";
  if (message.contentParts?.some((part) => part.type !== "text")) return "";
  if (message.contentParts?.length) {
    return message.contentParts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n\n")
      .trim();
  }
  return message.content.trim();
}

function complexEntryEstimate(entry: FeedDisplayItem): number {
  if (entry.kind === "work_group") return Math.max(96, 54 + entry.steps.length * 42);
  if (entry.kind === "subagent") return Math.max(110, 70 + entry.children.length * 36);
  return 120;
}

function estimateMarkdownLikeTextHeight(text: string, width: number, role: string): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const textWidth = Math.max(MIN_TEXT_WIDTH, width);
  const paragraphLines: string[] = [];
  let height = 0;
  let codeFence: string | null = null;
  let codeLineCount = 0;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const paragraph = normalizeInlineMarkdown(paragraphLines.join(role === "user" ? "\n" : " "));
    paragraphLines.length = 0;
    if (!paragraph.trim()) return;
    height += wrappedLineCount(paragraph, textWidth, 7.5) * BODY_LINE_HEIGHT;
    if (role !== "user") height += 12;
  };

  const flushCode = () => {
    height += Math.max(1, codeLineCount) * CODE_LINE_HEIGHT + 20;
    codeLineCount = 0;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (codeFence) {
      if (fence && fence[1]?.startsWith(codeFence)) {
        flushCode();
        codeFence = null;
      } else {
        codeLineCount += Math.max(1, wrappedLineCount(line, textWidth - 32, 7.25));
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      codeFence = fence[1][0] ?? "`";
      codeLineCount = 0;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const tableLineCount = tableRowCount(lines, index);
    if (tableLineCount > 0) {
      flushParagraph();
      height += tableLineCount * TABLE_ROW_HEIGHT + TABLE_HEADER_EXTRA + 16;
      index += tableLineCount - 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      height += 33;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const depth = heading[1]?.length ?? 3;
      const lineHeight = depth === 1 ? HEADING_ONE_LINE_HEIGHT : HEADING_TWO_LINE_HEIGHT;
      height +=
        wrappedLineCount(
          normalizeInlineMarkdown(heading[2] ?? ""),
          textWidth,
          depth === 1 ? 9.5 : 8.6,
        ) * lineHeight;
      height += depth === 1 ? 24 : 20;
      continue;
    }

    const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      height +=
        wrappedLineCount(normalizeInlineMarkdown(listItem[1] ?? ""), textWidth - 20, 7.5) *
          BODY_LINE_HEIGHT +
        4;
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      height +=
        wrappedLineCount(normalizeInlineMarkdown(quote[1] ?? ""), textWidth - 14, 7.5) *
          BODY_LINE_HEIGHT +
        16;
      continue;
    }

    paragraphLines.push(line);
  }

  if (codeFence) flushCode();
  flushParagraph();
  return Math.max(MIN_ENTRY_HEIGHT, height);
}

function wrappedLineCount(text: string, width: number, averageGlyphWidth: number): number {
  const charsPerLine = Math.max(
    18,
    Math.floor(Math.max(MIN_TEXT_WIDTH, width) / averageGlyphWidth),
  );
  return text.split("\n").reduce((count, line) => {
    return count + Math.max(1, Math.ceil(line.length / charsPerLine));
  }, 0);
}

function tableRowCount(lines: string[], start: number): number {
  const current = lines[start] || "";
  const next = lines[start + 1] || "";
  if (
    !isPipeTableRow(current) ||
    !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(next)
  ) {
    return 0;
  }
  let count = 2;
  for (let index = start + 2; index < lines.length; index++) {
    if (!isPipeTableRow(lines[index] || "")) break;
    count++;
  }
  return count;
}

function isPipeTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}
