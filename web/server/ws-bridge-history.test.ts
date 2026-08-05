import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";
import {
  piSessionEntriesToHistory,
  piSessionEntryToHistoryEntry,
  sumHistoryUsage,
  usageFromPiMessage,
} from "./ws-bridge-history.js";
import { WsBridge } from "./ws-bridge.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi JSONL browser history", () => {
  it("converts native messages, tool results, todos, and plan decisions", () => {
    const entries = piSessionEntriesToHistory(
      [
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "user",
            content: "hello",
            timestamp: 1,
          },
        },
        {
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 2,
          },
        },
        {
          type: "custom",
          id: "m3",
          parentId: "m2",
          timestamp: "2026-01-01T00:00:02.000Z",
          customType: "piwork.todo",
          data: {
            todos: [{ id: "t1", text: "Work", status: "in_progress" }],
          },
        },
        {
          type: "custom",
          id: "m4",
          parentId: "m3",
          timestamp: "2026-01-01T00:00:03.000Z",
          customType: "piwork.plan",
          data: { decision: "refine", refinement: "Add validation" },
        },
      ],
      6,
    );
    expect(entries.map((entry) => entry.event.type)).toEqual([
      "agent_message",
      "tool_execution",
      "tool_execution",
      "interaction_response",
    ]);
    expect(entries[2]?.event).toMatchObject({
      type: "tool_execution",
      toolName: "todo_write",
      todos: [{ id: "t1", content: "Work", status: "in_progress" }],
    });
    expect(entries[3]?.event).toMatchObject({
      type: "interaction_response",
      decision: "refine",
      refinement: "Add validation",
    });
    expect(JSON.stringify(entries).toLowerCase().includes("claude")).toBe(false);
  });

  it("retains tool-call inputs and assistant provider errors from Pi JSONL", () => {
    const entries = piSessionEntriesToHistory(
      [
        {
          type: "message",
          id: "assistant",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
            ],
            errorMessage: "provider timeout",
          },
        },
        {
          type: "message",
          id: "result",
          parentId: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "ok" },
        },
      ],
      1,
    );
    expect(entries[0]?.event).toMatchObject({
      type: "agent_message",
      message: { error: "provider timeout" },
    });
    expect(entries[1]?.event).toMatchObject({
      type: "tool_execution",
      input: { path: "a.txt" },
    });
  });

  it("projects only the ancestry of Pi's active history leaf", () => {
    const entries = piSessionEntriesToHistory(
      [
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "root" },
        },
        {
          type: "message",
          id: "old",
          parentId: "root",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "assistant", content: "old" },
        },
        {
          type: "message",
          id: "active",
          parentId: "root",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", content: "active" },
        },
      ],
      1,
      "active",
    );
    expect(entries.map((entry) => entry.id)).toEqual(["root", "active"]);
  });

  it("ignores non-display state entries that are not browser history", () => {
    expect(
      piSessionEntryToHistoryEntry(
        {
          type: "model_change",
          id: "m1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          provider: "openai",
          modelId: "gpt-5",
        },
        1,
      ),
    ).toBeNull();
  });

  it("normalizes display summaries, assistant metadata, errors, and malformed records", () => {
    const entries = piSessionEntriesToHistory(
      [
        {
          type: "message",
          id: "assistant",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reason" },
              { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
              { type: "unknown", value: "ignored" },
            ],
            provider: "openai",
            model: "gpt-5",
            stopReason: "stop",
          },
        },
        {
          type: "message",
          id: "failed-tool",
          parentId: "assistant",
          timestamp: "invalid",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "bash",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
            ],
            isError: true,
          },
        },
        {
          type: "custom_message",
          id: "custom-message",
          parentId: "failed-tool",
          timestamp: "2026-01-01T00:00:02.000Z",
          display: true,
          content: "Visible extension note",
        },
        {
          type: "compaction",
          id: "compaction",
          parentId: "custom-message",
          timestamp: "2026-01-01T00:00:03.000Z",
          summary: "Compacted context",
        },
        {
          type: "branch_summary",
          id: "branch",
          parentId: "compaction",
          timestamp: "2026-01-01T00:00:04.000Z",
          summary: [{ type: "text", text: "Branch context" }],
        },
      ],
      7,
    );

    expect(entries).toHaveLength(5);
    expect(entries[0]?.event).toMatchObject({
      type: "agent_message",
      message: {
        role: "assistant",
        model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        ],
      },
    });
    expect(entries[1]?.event).toMatchObject({
      type: "tool_execution",
      status: "failed",
      error: "line one\nline two",
      timestamp: 0,
    });
    expect(entries.slice(2).map((entry) => entry.event.type)).toEqual([
      "agent_message",
      "agent_message",
      "agent_message",
    ]);

    for (const invalid of [
      null,
      {},
      { type: "message", id: "missing-time" },
      {
        type: "message",
        id: "bad-role",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "system", content: "ignored" },
      },
      {
        type: "message",
        id: "bad-tool",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "toolResult", content: "ignored" },
      },
      {
        type: "custom",
        id: "bad-todo",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "piwork.todo",
        data: { todos: [{ id: "todo", text: "Work", status: "unknown" }] },
      },
      {
        type: "custom",
        id: "bad-plan",
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "piwork.plan",
        data: { decision: "refine", refinement: " " },
      },
    ]) {
      expect(piSessionEntryToHistoryEntry(invalid as never, 1)).toBeNull();
    }
  });

  it("normalizes Pi usage and sums only durable run-state history entries", () => {
    expect(
      usageFromPiMessage({
        input: 4,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
      }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
    expect(usageFromPiMessage("invalid")).toBeUndefined();
    expect(
      usageFromPiMessage({
        input: -1,
        output: Number.NaN,
        cacheRead: "3",
        cacheWrite: null,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(
      sumHistoryUsage([
        {
          id: "run-1",
          timestamp: 1,
          event: {
            type: "run_state",
            state: "ready",
            generation: 1,
            timestamp: 1,
            usage: {
              inputTokens: 4,
              outputTokens: 2,
              cacheReadTokens: 3,
              cacheWriteTokens: 1,
            },
          },
        },
        {
          id: "message",
          timestamp: 2,
          event: {
            type: "agent_message",
            generation: 1,
            message: {
              id: "message",
              role: "user",
              content: [{ type: "text", text: "ignored" }],
              timestamp: 2,
            },
          },
        },
        {
          id: "run-2",
          timestamp: 3,
          event: {
            type: "run_state",
            state: "ready",
            generation: 1,
            timestamp: 3,
            usage: { inputTokens: 5, outputTokens: 6 },
          },
        },
      ]),
    ).toEqual({
      inputTokens: 9,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    });
  });

  it("paginates by reading the exact current-session Pi JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-ws-history-"));
    roots.push(root);
    const sessionDir = join(root, "session-1");
    const piDir = join(sessionDir, "pi-sessions");
    const workspace = join(sessionDir, "workspace");
    await mkdir(piDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const records = [
      {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: workspace,
      },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "one", timestamp: 1 },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "two" }],
          provider: "openai",
          model: "gpt-5",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
          },
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: "three", timestamp: 3 },
      },
    ];
    await writeFile(
      join(piDir, "session.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const bridge = new WsBridge();
    bridge.setStore(new SessionStore(root, { layout: "session-dir" }));
    const session = bridge.restoreSession(
      {
        sessionId: "session-1",
        state: "exited",
        thinkingLevel: "off",
        mode: "agent",
        cwd: workspace,
        createdAt: 1,
        backendType: "pi",
        transport: "pi-rpc",
        generation: 2,
        piVersion: "0.82.1",
        piSessionRelativePath: "pi-sessions/session.jsonl",
      },
      {
        id: "session-1",
        piSessionRelativePath: "pi-sessions/session.jsonl",
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    );
    session.historyLeafId = "m2";
    const internal = bridge as unknown as {
      handlePiAdapterMessage(
        target: typeof session,
        message: { type: "history_leaf"; leaf_id: string },
      ): void;
    };
    internal.handlePiAdapterMessage(session, { type: "history_leaf", leaf_id: "m3" });
    const first = await bridge.getMessageHistoryPage("session-1", {
      cursor: 0,
      limit: 1,
    });
    expect(first).toMatchObject({
      total: 3,
      cursor: 0,
      nextCursor: 1,
      hasMore: true,
    });
    expect(first?.entries[0]?.event).toMatchObject({
      type: "agent_message",
      message: { role: "user", content: [{ type: "text", text: "one" }] },
    });
    const all = await bridge.getMessageHistoryPage("session-1", { cursor: 0, limit: 10 });
    expect(all?.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });
});
