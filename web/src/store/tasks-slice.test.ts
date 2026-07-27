// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store.js";

vi.hoisted(() => {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

beforeEach(() => useStore.getState().reset());

describe("Pi task and tool projections", () => {
  it("fully replaces todos", () => {
    useStore
      .getState()
      .setTasks("session-1", [
        { id: "todo-1", subject: "Inspect", description: "", status: "in_progress" },
      ]);
    useStore
      .getState()
      .setTasks("session-1", [
        { id: "todo-2", subject: "Implement", description: "", status: "pending" },
      ]);
    expect(
      useStore
        .getState()
        .sessionTasks.get("session-1")
        ?.map((task) => task.id),
    ).toEqual(["todo-2"]);
  });

  it("upserts foreground and background task processes by task id", () => {
    useStore.getState().upsertProcess("session-1", {
      taskId: "task-1",
      toolCallId: "tool-1",
      name: "Inspect",
      description: "",
      execution: "background",
      depth: 1,
      status: "running",
      startedAt: 1,
    });
    useStore.getState().updateProcess("session-1", "task-1", {
      status: "completed",
      completedAt: 2,
    });
    expect(useStore.getState().sessionProcesses.get("session-1")?.[0]).toMatchObject({
      taskId: "task-1",
      execution: "background",
      status: "completed",
    });
    useStore.getState().setProcesses("session-1", []);
    expect(useStore.getState().sessionProcesses.has("session-1")).toBe(false);
  });

  it("updates tool activity by toolCallId", () => {
    useStore.getState().upsertToolActivity("session-1", {
      toolCallId: "tool-1",
      toolName: "read",
      status: "started",
      preview: "README.md",
      startedAt: 1,
      elapsedSeconds: 0,
    });
    useStore.getState().updateToolActivity("session-1", "tool-1", {
      status: "completed",
      output: "done",
    });
    expect(useStore.getState().toolActivity.get("session-1")?.[0]).toMatchObject({
      toolCallId: "tool-1",
      status: "completed",
      output: "done",
    });
  });

  it("tracks and clears native Pi tool progress independently", () => {
    useStore.getState().setToolProgress("session-1", "tool-1", {
      toolName: "read",
      elapsedSeconds: 1,
      text: "Reading",
    });
    useStore.getState().setToolProgress("session-1", "tool-2", {
      toolName: "task",
      elapsedSeconds: 2,
    });

    useStore.getState().clearToolProgress("session-1", "tool-1");
    expect(useStore.getState().toolProgress.get("session-1")?.has("tool-1")).toBe(false);
    expect(useStore.getState().toolProgress.get("session-1")?.has("tool-2")).toBe(true);

    useStore.getState().clearToolProgress("session-1", "tool-2");
    expect(useStore.getState().toolProgress.has("session-1")).toBe(false);

    useStore.getState().setToolProgress("session-2", "tool-3", {
      toolName: "bash",
      elapsedSeconds: 3,
    });
    useStore.getState().clearToolProgress("session-2");
    expect(useStore.getState().toolProgress.has("session-2")).toBe(false);
  });
});
