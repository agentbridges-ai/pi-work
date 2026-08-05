import { describe, expect, it } from "vitest";
import type { ChatMessage, PiMessagePart, ToolExecutionEvent } from "./types.js";
import {
  extractTextFromParts,
  mergeAgentMessage,
  mergeChronologicalMessages,
  mergeMessageParts,
} from "./ws-message-history.js";

function assistant(id: string, text: string, timestamp: number): ChatMessage {
  return {
    id,
    role: "assistant",
    content: text,
    contentParts: [{ type: "text", text }],
    timestamp,
  };
}

describe("Pi message history helpers", () => {
  it("extracts text and thinking while excluding image bytes", () => {
    expect(
      extractTextFromParts([
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
        { type: "image", mediaType: "image/png", data: "bytes" },
      ]),
    ).toBe("reasoning\nanswer");
  });

  it("deduplicates stable Pi parts", () => {
    const part: PiMessagePart = { type: "text", text: "same" };
    expect(mergeMessageParts([part], [part])).toEqual([part]);
  });

  it("updates tool executions by toolCallId", () => {
    const started: ToolExecutionEvent = {
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-1",
      toolName: "read",
      status: "started",
      timestamp: 10,
    };
    const completed: ToolExecutionEvent = {
      ...started,
      status: "completed",
      timestamp: 20,
      output: "done",
    };
    const merged = mergeAgentMessage(
      { ...assistant("tool-message", "", 10), toolExecutions: [started] },
      { ...assistant("tool-message", "", 20), toolExecutions: [completed] },
    );
    expect(merged.timestamp).toBe(10);
    expect(merged.toolExecutions).toEqual([completed]);
  });

  it("retains a task parent across terminal lifecycle updates", () => {
    const started: ToolExecutionEvent = {
      type: "tool_execution",
      generation: 1,
      toolCallId: "child-tool",
      toolName: "read",
      status: "started",
      timestamp: 10,
      parentToolCallId: "task-call",
    };
    const completed: ToolExecutionEvent = {
      ...started,
      status: "completed",
      timestamp: 20,
      parentToolCallId: undefined,
    };
    const merged = mergeAgentMessage(
      { ...assistant("tool-message", "", 10), toolExecutions: [started] },
      { ...assistant("tool-message", "", 20), toolExecutions: [completed] },
    );

    expect(merged.toolExecutions?.[0]?.parentToolCallId).toBe("task-call");
  });

  it("retains a provider error while merging duplicate assistant entries", () => {
    const merged = mergeAgentMessage(
      { ...assistant("assistant-error", "", 10), error: "Provider failed" },
      assistant("assistant-error", "", 20),
    );
    expect(merged.error).toBe("Provider failed");
  });

  it("merges chronological pages by durable message id", () => {
    const merged = mergeChronologicalMessages(
      [assistant("assistant-1", "first", 10)],
      [assistant("assistant-1", "second", 20), assistant("assistant-2", "third", 30)],
    );
    expect(merged.map((message) => message.id)).toEqual(["assistant-1", "assistant-2"]);
    expect(merged[0]?.content).toBe("first\nsecond");
  });
});
