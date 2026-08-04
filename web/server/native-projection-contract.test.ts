import { describe, expect, it } from "vitest";
import {
  NATIVE_PROJECTION_CONTRACT_VERSION,
  nativeTimestamp,
  normalizeNativeParts,
  normalizeNativeUsage,
  projectManagedTaskEvent,
  projectNativeMessage,
  projectNativeToolExecution,
  projectNativeTodos,
} from "./native-projection-contract.js";

describe("native projection contract", () => {
  it("is explicitly versioned and keeps numeric fallback timestamps", () => {
    expect(NATIVE_PROJECTION_CONTRACT_VERSION).toBe(1);
    expect(nativeTimestamp(undefined, 42)).toBe(42);
    expect(nativeTimestamp(undefined, "2026-01-01T00:00:00.000Z")).toBe(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
  });

  it("normalizes only supported message parts and preserves native model/error metadata", () => {
    expect(
      projectNativeMessage(
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "thinking", thinking: "reason" },
            { type: "image", data: "bytes", mediaType: "image/webp" },
            { type: "unknown", value: "must not render" },
          ],
          provider: "openai",
          modelId: "gpt-5",
          errorMessage: "provider failed",
        },
        { id: "m-1", parentId: "p-1", timestamp: 9, generation: 2 },
      ),
    ).toEqual({
      type: "agent_message",
      generation: 2,
      message: {
        id: "m-1",
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "reason" },
          { type: "image", data: "bytes", mediaType: "image/webp" },
        ],
        timestamp: 9,
        model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
        stopReason: null,
        error: "provider failed",
      },
    });
    expect(
      projectNativeMessage(
        { role: "system", content: "not a transcript message" },
        { id: "system", parentId: null, timestamp: 1, generation: 2 },
      ),
    ).toBeNull();
    expect(
      projectNativeMessage(
        {
          role: "user",
          content:
            '[Piwork managed task notification]\n--- BEGIN MANAGED TASK PAYLOAD ---\n{"type":"piwork_managed_task_result"}',
        },
        { id: "managed", parentId: null, timestamp: 1, generation: 2 },
      ),
    ).toBeNull();
  });

  it("projects tool lifecycles, task cards and todo cards fail-closed", () => {
    const start = projectNativeToolExecution(
      {
        phase: "start",
        tool_call_id: "tool-1",
        tool_name: "task",
        args: { prompt: "inspect" },
      },
      { generation: 3, timestamp: 100, startedAt: 90 },
    );
    expect(start).toMatchObject({
      type: "tool_execution",
      status: "started",
      toolCallId: "tool-1",
      elapsedMs: 10,
    });
    const task = projectNativeToolExecution(
      {
        phase: "end",
        tool_call_id: "tool-1",
        tool_name: "task",
        result: {
          details: {
            taskId: "child-1",
            name: "Inspect",
            execution: "background",
            status: "completed",
            depth: 1,
            progress: "done",
          },
        },
        is_error: false,
      },
      { generation: 3, timestamp: 120, startedAt: 90 },
    );
    expect(task).toMatchObject({
      status: "completed",
      task: {
        taskId: "child-1",
        execution: "background",
        status: "completed",
        depth: 1,
      },
    });
    const todo = projectNativeToolExecution(
      {
        phase: "end",
        tool_call_id: "todo-1",
        tool_name: "todo_write",
        result: {
          details: {
            todos: [
              { id: "todo-1", content: "Ship", status: "in_progress", activeForm: "Shipping" },
            ],
          },
        },
        is_error: false,
      },
      { generation: 3, timestamp: 121 },
    );
    expect(todo?.todos).toEqual([
      { id: "todo-1", content: "Ship", status: "in_progress", activeForm: "Shipping" },
    ]);
    expect(
      projectNativeToolExecution(
        { phase: "end", tool_call_id: "", tool_name: "bash", is_error: false },
        { generation: 3, timestamp: 1 },
      ),
    ).toBeNull();
    expect(
      projectNativeToolExecution(
        { phase: "end", tool_call_id: "tool-1", tool_name: "bash", is_error: "yes" },
        { generation: 3, timestamp: 1 },
      ),
    ).toBeNull();
  });

  it("projects managed task events without exposing the envelope as chat", () => {
    expect(
      projectManagedTaskEvent(
        { taskId: "task-1", status: "starting", background: true, depth: 2 },
        { generation: 4, timestamp: 7 },
      ),
    ).toMatchObject({
      type: "tool_execution",
      toolCallId: "task:task-1",
      status: "running",
      task: { taskId: "task-1", status: "running", execution: "background", depth: 2 },
    });
    expect(
      projectManagedTaskEvent(
        { taskId: "task-1", status: "unknown" },
        { generation: 4, timestamp: 7 },
      ),
    ).toBeNull();
  });

  it("normalizes compatible usage and todo aliases", () => {
    expect(normalizeNativeUsage({ inputTokens: 2, output_tokens: 3, cache_read: 4 })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
    expect(normalizeNativeParts({ nope: true })).toEqual([]);
    expect(
      projectNativeTodos([{ id: "t", content: "Work", status: "pending", activeForm: "Working" }]),
    ).toEqual([{ id: "t", content: "Work", status: "pending", activeForm: "Working" }]);
    expect(projectNativeTodos([{ id: "t", text: "Work", status: "invalid" }])).toBeNull();
  });
});
