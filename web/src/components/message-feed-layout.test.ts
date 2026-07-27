import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import type { FeedDisplayItem } from "./chat-work-groups.js";
import {
  buildFeedLayoutRows,
  findFeedLayoutRowIndexByMessageId,
  getFeedDisplayItemKey,
  sliceFeedLayoutRows,
} from "./message-feed-layout.js";
import { estimateFeedLayoutRowHeight } from "./message-feed-estimator.js";

function message(id: string, role: ChatMessage["role"], content = id): FeedDisplayItem {
  return {
    kind: "message",
    msg: { id, role, content, timestamp: 1 },
  };
}

describe("message feed turn layout", () => {
  it("groups prelude content and complete user turns", () => {
    const rows = buildFeedLayoutRows([
      message("system", "system"),
      message("assistant-prelude", "assistant"),
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
      message("assistant-2", "assistant"),
    ]);

    expect(
      rows.map((row) => ({
        key: row.key,
        kind: row.kind,
        ids: row.entries.map((entry) => (entry.kind === "message" ? entry.msg.id : entry.kind)),
      })),
    ).toEqual([
      { key: "prelude:message:system", kind: "prelude", ids: ["system", "assistant-prelude"] },
      { key: "turn:user-1", kind: "turn", ids: ["user-1", "assistant-1"] },
      { key: "turn:user-2", kind: "turn", ids: ["user-2", "assistant-2"] },
    ]);
  });

  it("uses durable item identities and never indexes", () => {
    const work: FeedDisplayItem = {
      kind: "work_group",
      id: "work-id",
      firstId: "source-id",
      steps: [],
    };
    const subagent: FeedDisplayItem = {
      kind: "subagent",
      taskToolUseId: "task-id",
      description: "task",
      children: [],
    };

    expect(getFeedDisplayItemKey(message("m1", "assistant"))).toBe("message:m1");
    expect(getFeedDisplayItemKey(work)).toBe("work:work-id");
    expect(getFeedDisplayItemKey(subagent)).toBe("subagent:task-id");
  });

  it("applies the entry budget only at complete-turn boundaries", () => {
    const entries: FeedDisplayItem[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      entries.push(message(`user-${turn}`, "user"));
      for (let reply = 0; reply < 3; reply += 1) {
        entries.push(message(`assistant-${turn}-${reply}`, "assistant"));
      }
    }

    const window = sliceFeedLayoutRows(buildFeedLayoutRows(entries), 6);
    expect(window.rows.map((row) => row.userMessageId)).toEqual(["user-2", "user-3"]);
    expect(window.entries).toHaveLength(8);
    expect(window.hiddenEntryCount).toBe(8);
    expect(window.hasMore).toBe(true);
  });

  it("maps TOC ids to turn indexes", () => {
    const rows = buildFeedLayoutRows([
      message("user-1", "user"),
      message("assistant-1", "assistant"),
      message("user-2", "user"),
    ]);
    expect(findFeedLayoutRowIndexByMessageId(rows, "user-2")).toBe(1);
    expect(findFeedLayoutRowIndexByMessageId(rows, "missing")).toBe(-1);
  });

  it("estimates a whole row from its entries, internal gaps, and turn gap", () => {
    const [row] = buildFeedLayoutRows([
      message("user-1", "user", "short"),
      message("assistant-1", "assistant", "short"),
    ]);
    expect(row).toBeTruthy();
    const firstEstimate = estimateFeedLayoutRowHeight(row!, 736, false);
    const laterEstimate = estimateFeedLayoutRowHeight(row!, 736, true);
    expect(firstEstimate).toBeGreaterThan(72);
    expect(laterEstimate - firstEstimate).toBe(14);
  });

  it("estimates native Pi text parts as plain message text", () => {
    const [row] = buildFeedLayoutRows([
      {
        kind: "message",
        msg: {
          id: "parts",
          role: "assistant",
          content: "",
          contentParts: [
            { type: "text", text: "first paragraph" },
            { type: "text", text: "second paragraph" },
          ],
          timestamp: 1,
        },
      },
    ]);

    expect(estimateFeedLayoutRowHeight(row!, 736, false)).toBeGreaterThan(72);
  });
});
