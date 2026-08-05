import { describe, expect, it } from "vitest";
import type { Recording } from "../replay.js";
import { compareRecordings, validateRecording } from "./compat-validator.js";

function makeRecording(browserMessages: Record<string, unknown>[]): Recording {
  return {
    header: {
      _header: true,
      version: 2,
      session_id: "test",
      backend_type: "pi",
      transport: "pi-rpc",
      started_at: 0,
      cwd: "/",
    },
    entries: browserMessages.map((message, index) => ({
      ts: index * 100,
      dir: "out",
      raw: JSON.stringify(message),
      ch: "browser",
    })),
  };
}

const validEvents = [
  {
    type: "session_init",
    session: {
      sessionId: "test",
      backendType: "pi",
      transport: "pi-rpc",
      piVersion: "0.82.1",
      model: {
        key: "provider/model",
        provider: "provider",
        modelId: "model",
      },
      thinkingLevel: "medium",
      mode: "agent",
      cwd: "/",
      tools: ["read"],
      commands: [],
      skills: [],
      mcpServers: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      runState: "ready",
      isCompacting: false,
      generation: 2,
    },
  },
  {
    type: "agent_message",
    generation: 2,
    message: {
      id: "message-1",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      timestamp: 100,
    },
  },
  {
    type: "tool_execution",
    generation: 2,
    toolCallId: "tool-1",
    toolName: "read",
    status: "completed",
    timestamp: 200,
  },
  {
    type: "interaction_request",
    generation: 2,
    request: {
      id: "ask-1",
      kind: "ask",
      toolCallId: "tool-2",
      prompt: "Choose",
    },
    timestamp: 300,
  },
  {
    type: "run_state",
    generation: 2,
    state: "stopped",
    timestamp: 400,
  },
];

describe("Pi recording compatibility validator", () => {
  it("accepts the Pi browser core event schema", () => {
    const result = validateRecording(makeRecording(validEvents));
    expect(result).toMatchObject({
      compatible: true,
      backendType: "pi",
      totalMessages: 5,
    });
    expect(result.diffs).toEqual([]);
    expect(result.messageTypeBreakdown.agent_message.count).toBe(1);
  });

  it("accepts the native agent_end settling run state", () => {
    const result = validateRecording(
      makeRecording([{ type: "run_state", generation: 1, state: "settling", timestamp: 1 }]),
    );
    expect(result.compatible).toBe(true);
  });

  it("rejects missing Pi core fields", () => {
    const result = validateRecording(
      makeRecording([
        {
          type: "agent_message",
          generation: 1,
          message: { role: "assistant", content: [] },
        },
        { type: "run_state", state: "ready" },
      ]),
    );

    expect(result.compatible).toBe(false);
    expect(result.diffs.map((diff) => diff.details).join("\n")).toContain(
      "agent_message requires generation",
    );
    expect(result.diffs.map((diff) => diff.details).join("\n")).toContain(
      "run_state requires generation",
    );
  });

  it.each([
    "agent_output",
    "final_result",
    "approval_prompt",
    "runtime_connected",
    "runtime_disconnected",
  ])("rejects legacy browser event %s", (type) => {
    const result = validateRecording(makeRecording([{ type }]));
    expect(result.compatible).toBe(false);
    expect(result.diffs[0]).toMatchObject({ kind: "type_mismatch" });
    expect(result.diffs[0]?.details).toContain("non-Pi browser message type");
  });

  it("requires Pi authority in session_init", () => {
    const result = validateRecording(
      makeRecording([
        {
          type: "session_init",
          session: { backendType: "other", transport: "other" },
        },
      ]),
    );
    expect(result.compatible).toBe(false);
    expect(result.diffs[0]?.details).toContain("native-Pi SessionState");
  });

  it("validates every structured Pi browser event family", () => {
    const result = validateRecording(
      makeRecording([
        { type: "session_update", session: { mode: "plan" } },
        {
          type: "message_delta",
          generation: 2,
          messageId: "message-1",
          role: "assistant",
          delta: { kind: "thinking", contentIndex: 1, delta: "reason" },
        },
        {
          type: "interaction_response",
          generation: 2,
          requestId: "ask-1",
          kind: "ask",
          status: "submitted",
        },
        {
          type: "history_snapshot",
          generation: 2,
          entries: [],
          total: 0,
          cursor: 0,
          nextCursor: 0,
          hasMore: false,
          reason: "recovery",
        },
        { type: "mcp_status", servers: [] },
        {
          type: "pi_queue",
          generation: 2,
          steering: ["now"],
          followUp: ["later"],
          timestamp: 1,
        },
        {
          type: "pi_extension_event",
          generation: 2,
          event: "status",
          payload: { key: "value" },
          timestamp: 1,
        },
        { type: "event_replay", events: [] },
        { type: "error", code: "test", message: "error" },
        { type: "session_name_update", name: "Name" },
        { type: "session_lifecycle_update", sessionId: "test", lifecycleState: "closed" },
        { type: "user_space_request", request_id: "request", operation: "read_file", input: {} },
        {
          type: "onlyoffice_request",
          request_id: "office",
          operation: { type: "get_document_text" },
        },
      ]),
    );

    expect(result.compatible).toBe(true);
    expect(result.totalMessages).toBe(13);
    expect(result.diffs).toEqual([]);
  });

  it("reports malformed JSON, missing types, and invalid fields for every guarded family", () => {
    const recording = makeRecording([
      {},
      { type: "session_init" },
      { type: "session_update" },
      { type: "message_delta", generation: 1 },
      { type: "tool_execution", generation: 1 },
      { type: "interaction_request", generation: 1 },
      { type: "interaction_response", generation: 1 },
      { type: "history_snapshot", generation: 1 },
      { type: "mcp_status" },
      { type: "pi_queue", generation: 1, steering: [1], followUp: [], timestamp: 1 },
      { type: "pi_extension_event", generation: 1, event: "", payload: [], timestamp: 1 },
      { type: "event_replay" },
    ]);
    recording.entries.unshift({
      ts: 0,
      dir: "out",
      raw: "not-json",
      ch: "browser",
    });
    recording.entries.unshift({
      ts: 0,
      dir: "out",
      raw: "[]",
      ch: "browser",
    });

    const result = validateRecording(recording);
    expect(result.compatible).toBe(false);
    expect(result.totalMessages).toBe(14);
    expect(result.diffs.filter((diff) => diff.kind === "missing")).toHaveLength(2);
    expect(result.messageTypeBreakdown.unknown).toEqual({ count: 1, issues: 1 });
    expect(result.diffs.map((diff) => diff.details).join("\n")).toEqual(
      expect.stringContaining("history_snapshot requires generation"),
    );
    expect(result.diffs.map((diff) => diff.details).join("\n")).toEqual(
      expect.stringContaining("mcp_status missing 'servers' array"),
    );
    expect(result.diffs.map((diff) => diff.details).join("\n")).toEqual(
      expect.stringContaining("pi_queue requires generation"),
    );
    expect(result.diffs.map((diff) => diff.details).join("\n")).toEqual(
      expect.stringContaining("pi_extension_event requires generation"),
    );
  });

  it("compares structural fields while tolerating sequence and elapsed time", () => {
    const expected = makeRecording([
      {
        type: "tool_execution",
        generation: 1,
        toolCallId: "tool-a",
        toolName: "read",
        status: "completed",
        timestamp: 10,
        elapsedMs: 5,
        seq: 4,
      },
    ]);
    const actual = [
      {
        type: "tool_execution",
        generation: 9,
        toolCallId: "tool-b",
        toolName: "read",
        status: "completed",
        timestamp: 99,
        elapsedMs: 50,
        seq: 40,
      },
    ];
    expect(compareRecordings(expected, actual)).toEqual([]);
  });

  it("reports missing, extra, type, and field drift", () => {
    const expected = makeRecording([
      { type: "run_state", generation: 1, state: "ready", timestamp: 1 },
      {
        type: "tool_execution",
        generation: 1,
        toolCallId: "tool-1",
        toolName: "read",
        status: "started",
        timestamp: 2,
        progress: "opening",
      },
    ]);

    expect(compareRecordings(expected, [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "missing" })]),
    );
    expect(
      compareRecordings(expected, [
        { type: "agent_message" },
        {
          type: "tool_execution",
          generation: 1,
          toolCallId: "tool-1",
          toolName: "read",
          status: "started",
          timestamp: 2,
        },
        { type: "run_state" },
      ]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "type_mismatch" }),
        expect.objectContaining({
          kind: "field_mismatch",
          details: expect.stringContaining("missing field 'progress'"),
        }),
        expect.objectContaining({ kind: "extra" }),
      ]),
    );
  });

  it("handles unparseable expected recordings and reports newly added fields", () => {
    const expected = makeRecording([{ type: "run_state", generation: 1 }]);
    expected.entries[0]!.raw = "not-json";
    expect(compareRecordings(expected, [])).toEqual([
      expect.objectContaining({
        kind: "missing",
        expected: { type: "unparseable" },
      }),
    ]);
    expect(compareRecordings(expected, [{ type: "run_state" }])).toEqual([
      expect.objectContaining({
        kind: "field_mismatch",
        details: expect.stringContaining("unparseable JSON"),
      }),
    ]);

    const structural = makeRecording([{ type: "run_state", generation: 1 }]);
    expect(
      compareRecordings(structural, [{ type: "run_state", generation: 1, detail: "new" }]),
    ).toEqual([
      expect.objectContaining({
        kind: "field_mismatch",
        details: expect.stringContaining("new field 'detail'"),
      }),
    ]);
  });
});
