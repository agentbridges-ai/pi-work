import { describe, expect, it, vi } from "vitest";
import type { BrowserOutgoingMessage } from "../shared/pi-browser-protocol.js";
import {
  BROWSER_WS_MAX_MESSAGE_BYTES,
  browserMessageByteLength,
  deduplicateBrowserMessage,
  IDEMPOTENT_BROWSER_MESSAGE_TYPES,
  isBrowserMessageWithinLimit,
  isUserMessageContentWithinLimit,
  parseBrowserMessage,
  USER_MESSAGE_MAX_BYTES,
} from "./ws-bridge-browser-ingest.js";
import { WsBridge } from "./ws-bridge.js";

const context = {
  protocolVersion: 1 as const,
  contextEpoch: 7,
  contextId: "0123456789abcdef0123456789abcdef",
};

function envelope(payload: BrowserOutgoingMessage, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...context,
    eventId: "event-1",
    kind: payload.type,
    payload,
    ...overrides,
  });
}

function info(generation = 3) {
  return {
    sessionId: "session-1",
    state: "exited" as const,
    lifecycleState: "enabled" as const,
    thinkingLevel: "medium" as const,
    mode: "agent" as const,
    cwd: "/tmp/session-1/workspace",
    createdAt: 1,
    backendType: "pi" as const,
    transport: "pi-rpc" as const,
    generation,
    piVersion: "0.82.1" as const,
  };
}

describe("Pi browser ingest", () => {
  it("accepts a Pi user message only inside the matching context envelope", () => {
    const message: BrowserOutgoingMessage = {
      type: "agent_message",
      generation: 3,
      clientMsgId: "client-1",
      message: {
        id: "client-1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
    };
    expect(parseBrowserMessage(envelope(message), context)).toEqual(message);
    expect(parseBrowserMessage(JSON.stringify(message), context)).toBeNull();
    expect(
      parseBrowserMessage(
        envelope(message, {
          contextId: "ffffffffffffffffffffffffffffffff",
        }),
        context,
      ),
    ).toBeNull();
    expect(parseBrowserMessage(envelope(message, { kind: "abort" }), context)).toBeNull();
  });

  it("rejects legacy-shaped, malformed, stale-schema, and oversized events", () => {
    expect(
      parseBrowserMessage(
        JSON.stringify({
          ...context,
          eventId: "event-1",
          kind: "user_message",
          payload: { type: "user_message", content: "legacy" },
        }),
        context,
      ),
    ).toBeNull();
    expect(parseBrowserMessage("{", context)).toBeNull();
    expect(parseBrowserMessage("x".repeat(BROWSER_WS_MAX_MESSAGE_BYTES + 1), context)).toBeNull();
  });

  it("validates the complete native control vocabulary", () => {
    const messages: BrowserOutgoingMessage[] = [
      { type: "session_subscribe", lastSeq: 0 },
      { type: "session_ack", lastSeq: 4 },
      { type: "abort", generation: 3, clientMsgId: "abort-1" },
      { type: "retry", messageId: "message-1", clientMsgId: "retry-1" },
      { type: "compact", clientMsgId: "compact-1" },
      {
        type: "set_model",
        model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
        clientMsgId: "model-1",
      },
      {
        type: "set_thinking_level",
        thinkingLevel: "xhigh",
        clientMsgId: "thinking-1",
      },
      { type: "set_mode", mode: "plan", clientMsgId: "mode-1" },
      { type: "mcp_get_status", clientMsgId: "mcp-1" },
      {
        type: "mcp_toggle",
        serverName: "docs",
        enabled: false,
        clientMsgId: "mcp-2",
      },
      {
        type: "mcp_reconnect",
        serverName: "docs",
        clientMsgId: "mcp-3",
      },
    ];
    for (const message of messages) {
      expect(parseBrowserMessage(envelope(message), context)).toEqual(message);
    }
  });

  it("strictly validates native interactions, Agent messages, and byte budgets", () => {
    const messages: BrowserOutgoingMessage[] = [
      {
        type: "agent_message",
        generation: 3,
        message: {
          id: "message-1",
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", mediaType: "image/png", data: "base64-data" },
          ],
          displayContent: [{ type: "text", text: "visible text" }],
          timestamp: 10,
        },
      },
      {
        type: "interaction_response",
        generation: 3,
        requestId: "ask-1",
        kind: "ask",
        status: "submitted",
        answers: [
          {
            questionId: "question-0",
            selectedOptionIds: ["option-1"],
            freeText: "",
          },
        ],
        timestamp: 11,
      },
      {
        type: "interaction_response",
        generation: 3,
        requestId: "plan-1",
        kind: "propose_plan",
        status: "submitted",
        decision: "refine",
        refinement: "add validation",
      },
    ];
    for (const message of messages) {
      expect(parseBrowserMessage(Buffer.from(envelope(message)), context)).toEqual(message);
    }

    const invalidPayloads = [
      {
        type: "agent_message",
        generation: 3,
        message: {
          id: "message-1",
          role: "user",
          content: [{ type: "thinking", thinking: "browser must not send this" }],
          timestamp: 1,
        },
      },
      {
        type: "agent_message",
        generation: 3,
        message: {
          id: "message-1",
          role: "user",
          content: [{ type: "text", text: "x".repeat(USER_MESSAGE_MAX_BYTES) }],
          displayContent: [{ type: "text", text: "overflow" }],
          timestamp: 1,
        },
      },
      {
        type: "interaction_response",
        generation: -1,
        requestId: "ask-1",
        kind: "ask",
        status: "submitted",
      },
      {
        type: "interaction_response",
        generation: 3,
        requestId: "ask-1",
        kind: "ask",
        status: "submitted",
        answers: [
          {
            questionId: "question-0",
            selectedOptionIds: ["invalid option id"],
          },
        ],
      },
      {
        type: "interaction_response",
        generation: 3,
        requestId: "plan-1",
        kind: "propose_plan",
        status: "submitted",
        decision: "execute-now",
      },
    ];
    for (const payload of invalidPayloads) {
      expect(parseBrowserMessage(envelope(payload as never), context)).toBeNull();
    }

    expect(browserMessageByteLength("界")).toBe(3);
    expect(isBrowserMessageWithinLimit(Buffer.alloc(BROWSER_WS_MAX_MESSAGE_BYTES))).toBe(true);
    expect(isUserMessageContentWithinLimit("x".repeat(USER_MESSAGE_MAX_BYTES))).toBe(true);
    expect(isUserMessageContentWithinLimit(`界${"x".repeat(USER_MESSAGE_MAX_BYTES)}`)).toBe(false);
  });

  it("accepts bounded User Space and OnlyOffice replies and rejects malformed fields", () => {
    const mount = {
      mountId: "mount-1",
      name: "Documents",
      rootName: "documents",
      status: "mounted" as const,
      access: "readwrite" as const,
      canRead: true,
      canWrite: true,
      permissionState: "granted" as const,
      includeHidden: true as const,
    };
    const messages: BrowserOutgoingMessage[] = [
      { type: "end_session", reason: "", clientMsgId: "end-1" },
      { type: "stop_task", taskId: "task-1", clientMsgId: "stop-1" },
      {
        type: "user_space_mount",
        user_space: null,
        mounts: [mount],
        clientMsgId: "mount-1",
      },
      { type: "user_space_unmount", mountId: "mount-1", clientMsgId: "unmount-1" },
      { type: "user_space_mutation_authorize", request_id: "request-1" },
      {
        type: "user_space_response",
        request_id: "request-1",
        ok: false,
        error: "",
        commit_lease: "lease-1",
        runtime_epoch: "epoch-1",
        clientMsgId: "response-1",
      },
      {
        type: "user_space_status",
        user_space: null,
        mounts: [mount],
        clientMsgId: "status-1",
      },
      {
        type: "user_space_index_update",
        mountId: "mount-1",
        fileCount: 4,
        lastIndexedAt: 20,
        clientMsgId: "index-1",
      },
      { type: "onlyoffice_status", document: null, client_msg_id: "office-status-1" },
      {
        type: "onlyoffice_response",
        request_id: "office-1",
        ok: false,
        error: "",
        client_msg_id: "office-response-1",
      },
    ];
    for (const message of messages) {
      expect(parseBrowserMessage(envelope(message), context)).toEqual(message);
    }

    const invalidPayloads = [
      { type: "end_session", reason: "\0" },
      { type: "stop_task", taskId: "invalid task" },
      { type: "user_space_unmount", mountId: "" },
      { type: "user_space_mutation_authorize", request_id: "" },
      {
        type: "user_space_index_update",
        fileCount: -1,
        lastIndexedAt: Number.NaN,
      },
      { type: "onlyoffice_status", document: "not-an-object" },
      { type: "onlyoffice_response", request_id: "", ok: "yes" },
    ];
    for (const payload of invalidPayloads) {
      expect(parseBrowserMessage(envelope(payload as never), context)).toBeNull();
    }
  });

  it("deduplicates only persisted client message ids", () => {
    const bridge = new WsBridge();
    const session = bridge.restoreSession(info(), {
      id: "session-1",
      offlineQueue: [],
      processedClientMessageIds: [],
    });
    const persist = vi.fn();
    const message: BrowserOutgoingMessage = {
      type: "abort",
      generation: 3,
      clientMsgId: "abort-1",
    };
    expect(
      deduplicateBrowserMessage(message, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 10, persist),
    ).toBe(false);
    expect(
      deduplicateBrowserMessage(message, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 10, persist),
    ).toBe(true);
    expect(session.processedClientMessageIds).toEqual(["abort-1"]);
    expect(persist).toHaveBeenCalledTimes(1);

    const withoutId: BrowserOutgoingMessage = { type: "compact" };
    expect(
      deduplicateBrowserMessage(withoutId, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 10, persist),
    ).toBe(false);
    const office: BrowserOutgoingMessage = {
      type: "onlyoffice_response",
      request_id: "office-1",
      ok: true,
      client_msg_id: "office-client-1",
    };
    expect(
      deduplicateBrowserMessage(office, IDEMPOTENT_BROWSER_MESSAGE_TYPES, session, 10, persist),
    ).toBe(false);
    expect(session.processedClientMessageIds).toContain("office-client-1");
  });
});
