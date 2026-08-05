import { describe, expect, it } from "vitest";
import { isBrowserIncomingMessage, isRecord } from "./ws-message-validation.js";

const model = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };

const session = {
  sessionId: "session-1",
  backendType: "pi",
  transport: "pi-rpc",
  piVersion: "0.82.1",
  model,
  thinkingLevel: "high",
  mode: "agent",
  cwd: "/workspace",
  tools: ["read", "write", "edit", "bash"],
  commands: [],
  skills: ["product"],
  mcpServers: [
    {
      name: "docs",
      enabled: true,
      status: "connected",
      scope: "agent",
      config: { type: "streamable-http", url: "https://example.test/mcp" },
      tools: [{ name: "lookup", annotations: { readOnly: true } }],
    },
  ],
  usage: { inputTokens: 0, outputTokens: 0 },
  runState: "ready",
  isCompacting: false,
  generation: 1,
};

describe("Pi browser message validation", () => {
  it("accepts native Pi session and message events", () => {
    expect(isBrowserIncomingMessage({ type: "session_init", session, seq: 1 })).toBe(true);
    expect(
      isBrowserIncomingMessage({
        type: "agent_message",
        generation: 1,
        message: {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
        seq: 2,
      }),
    ).toBe(true);
  });

  it("rejects legacy message names and Claude-shaped session fields", () => {
    expect(isBrowserIncomingMessage({ type: "user_message", content: "hello" })).toBe(false);
    expect(
      isBrowserIncomingMessage({
        type: "session_update",
        session: { permissionMode: "bypassPermissions" },
      }),
    ).toBe(false);
    expect(
      isBrowserIncomingMessage({
        type: "session_init",
        session: { ...session, transport: "sdk", sdkSessionId: "legacy" },
      }),
    ).toBe(false);
  });

  it("accepts stdio, SSE and Streamable HTTP MCP, but rejects SDK and secret config", () => {
    for (const config of [
      { type: "stdio", command: "node", args: ["server.js"] },
      { type: "sse", url: "https://example.test/sse" },
      { type: "streamable-http", url: "https://example.test/mcp" },
    ]) {
      expect(
        isBrowserIncomingMessage({
          type: "mcp_status",
          servers: [
            {
              name: "managed",
              enabled: true,
              status: "connected",
              scope: "agent",
              config,
            },
          ],
        }),
      ).toBe(true);
    }
    expect(
      isBrowserIncomingMessage({
        type: "mcp_status",
        servers: [
          {
            name: "legacy",
            enabled: true,
            status: "connected",
            scope: "agent",
            config: { type: "sdk" },
          },
        ],
      }),
    ).toBe(false);
    for (const secretConfig of [
      {
        type: "stdio",
        command: "node",
        env: { API_KEY: "must-not-reach-browser" },
      },
      {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: { Authorization: "must-not-reach-browser" },
      },
    ]) {
      expect(
        isBrowserIncomingMessage({
          type: "mcp_status",
          servers: [
            {
              name: "secret-bearing",
              enabled: true,
              status: "connected",
              scope: "agent",
              config: secretConfig,
            },
          ],
        }),
      ).toBe(false);
    }
    expect(
      isBrowserIncomingMessage({
        type: "mcp_status",
        servers: [
          {
            name: "invalid-timeout",
            enabled: true,
            status: "connected",
            scope: "agent",
            config: { type: "stdio", command: "node", timeout: -1 },
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires native todo and task payloads", () => {
    const base = {
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-1",
      toolName: "task",
      status: "running",
      timestamp: 1,
    };
    expect(
      isBrowserIncomingMessage({
        ...base,
        todos: [{ id: "todo-1", content: "Inspect", status: "in_progress" }],
        task: {
          taskId: "task-1",
          name: "Inspect",
          execution: "background",
          status: "running",
          depth: 1,
          progress: "Reading",
        },
      }),
    ).toBe(true);
    expect(
      isBrowserIncomingMessage({
        ...base,
        todos: [{ content: "legacy", status: "pending" }],
      }),
    ).toBe(false);
    expect(
      isBrowserIncomingMessage({
        ...base,
        task: {
          task_id: "legacy",
          name: "Legacy",
          execution: "background",
          status: "running",
          depth: 1,
        },
      }),
    ).toBe(false);
  });

  it("accepts generation-bound pending interaction snapshots", () => {
    expect(
      isBrowserIncomingMessage({
        type: "interaction_snapshot",
        generation: 2,
        requests: [
          {
            id: "ask-1",
            kind: "ask",
            toolCallId: "tool-1",
            questions: [
              {
                id: "question-1",
                question: "Continue?",
                options: [],
                allowMultiple: false,
                allowFreeText: true,
              },
            ],
          },
        ],
      }),
    ).toBe(true);
    expect(
      isBrowserIncomingMessage({
        type: "interaction_snapshot",
        generation: 2,
        requests: [{ id: "ask-1" }],
      }),
    ).toBe(false);
  });

  it("accepts only canonical user-prompt acceptance ids", () => {
    expect(
      isBrowserIncomingMessage({
        type: "agent_message_accepted",
        generation: 2,
        clientMsgId: "client-1",
      }),
    ).toBe(true);
    expect(
      isBrowserIncomingMessage({
        type: "agent_message_accepted",
        generation: 2,
        clientMsgId: "",
      }),
    ).toBe(false);
  });

  it("validates replay framing and disallows nested replay", () => {
    expect(
      isBrowserIncomingMessage({
        type: "event_replay",
        events: [
          {
            seq: 1,
            message: {
              type: "run_state",
              generation: 1,
              state: "ready",
              timestamp: 1,
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      isBrowserIncomingMessage({
        type: "event_replay",
        events: [{ seq: 1, message: { type: "event_replay", events: [] } }],
      }),
    ).toBe(false);
  });

  it("accepts the native settling run state", () => {
    expect(
      isBrowserIncomingMessage({
        type: "run_state",
        generation: 1,
        state: "settling",
        timestamp: 1,
      }),
    ).toBe(true);
  });

  it("keeps the two-phase User Space mutation contract", () => {
    expect(
      isBrowserIncomingMessage({
        type: "user_space_mutation_request",
        request_id: "request-1",
        operation: "write_file",
        input: { path: "notes.txt" },
        requires_commit: true,
      }),
    ).toBe(true);
    expect(
      isBrowserIncomingMessage({
        type: "user_space_mutation_authorization",
        request_id: "request-1",
        ok: true,
        commit_lease: "lease-1",
        runtime_epoch: "epoch-1",
      }),
    ).toBe(true);
  });

  it("recognizes records but not arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
