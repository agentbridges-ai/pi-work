import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { buildFeedDisplayItems, getWorkStepToolUseId } from "./chat-work-groups.js";

describe("Pi chat work groups", () => {
  it("groups thinking and tool-only assistant events", () => {
    const messages: ChatMessage[] = [
      {
        id: "thinking-1",
        role: "assistant",
        content: "",
        contentParts: [{ type: "thinking", thinking: "Inspecting" }],
        timestamp: 1,
      },
      {
        id: "tool:read-1",
        role: "assistant",
        content: "",
        toolExecutions: [
          {
            type: "tool_execution",
            generation: 1,
            toolCallId: "read-1",
            toolName: "read",
            status: "completed",
            timestamp: 2,
            input: { path: "README.md" },
            output: "ok",
          },
        ],
        timestamp: 2,
      },
    ];
    const entries = buildFeedDisplayItems(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("work_group");
    if (entries[0]?.kind !== "work_group") return;
    expect(entries[0].steps.map((step) => step.kind)).toEqual(["thinking", "tool", "result"]);
    expect(getWorkStepToolUseId(entries[0].steps[1]!)).toBe("read-1");
  });

  it("nests child messages under task tool calls", () => {
    const messages: ChatMessage[] = [
      {
        id: "task-event",
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          {
            type: "tool_execution",
            generation: 1,
            toolCallId: "task-1",
            toolName: "task",
            status: "running",
            timestamp: 1,
            input: { description: "Inspect tests" },
          },
        ],
      },
      {
        id: "child",
        role: "assistant",
        content: "done",
        parentToolCallId: "task-1",
        timestamp: 2,
      },
    ];
    expect(buildFeedDisplayItems(messages).some((entry) => entry.kind === "subagent")).toBe(true);
  });
});
