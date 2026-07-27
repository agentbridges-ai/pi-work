import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentMessage,
  BrowserOutgoingMessage,
  UserSpaceMount,
} from "../shared/pi-browser-protocol.js";
import {
  encodePiAskBatchResponse,
  encodePiAskBatchTitle,
  PI_ASK_BATCH_OPTION,
} from "./pi-ask-interaction.js";
import { encodePiPlanRequestTitle, PI_PLAN_OPTIONS } from "./pi-plan-interaction.js";
import { PiAdapter, type PiBrowserIncomingMessage } from "./pi-adapter.js";
import type { PiReadinessResult } from "./pi-readiness.js";
import type { PiRpcTransport } from "./pi-rpc-transport.js";
import type { BrowserSocketData, Session } from "./ws-bridge-types.js";
import { serializeForStore } from "./ws-bridge-persist.js";
import { WsBridge } from "./ws-bridge.js";

const context = {
  protocolVersion: 1 as const,
  contextEpoch: 9,
  contextId: "0123456789abcdef0123456789abcdef",
};

function info(generation = 3) {
  return {
    sessionId: "session-1",
    state: "ready" as const,
    lifecycleState: "enabled" as const,
    model: {
      key: "openai/gpt-5",
      provider: "openai",
      modelId: "gpt-5",
    },
    thinkingLevel: "high" as const,
    mode: "agent" as const,
    cwd: "/tmp/session-1/workspace",
    createdAt: 1,
    backendType: "pi" as const,
    transport: "pi-rpc" as const,
    generation,
    piVersion: "0.82.1" as const,
    piSessionRelativePath: "pi-sessions/session.jsonl",
  };
}

function readiness(): PiReadinessResult {
  return {
    state: {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: "/tmp/session-1/pi-sessions/session.jsonl",
      sessionId: "session-1",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
    models: [{ provider: "openai", id: "gpt-5" }],
    history: { entries: [], leafId: null },
    commands: [{ name: "piwork-plan" }],
    extension: { version: 1, mode: "agent", mcp: [] },
    mcp: [],
  };
}

function adapterFixture(generation = 3) {
  const transport = {
    isClosed: false,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    abortRetry: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({})),
    setModel: vi.fn(async (provider: string, modelId: string) => ({
      provider,
      id: modelId,
    })),
    setThinkingLevel: vi.fn(async () => undefined),
    replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
    sendExtensionUiResponse: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as PiRpcTransport;
  return {
    transport,
    adapter: new PiAdapter({
      transport,
      sessionId: "session-1",
      generation,
    }),
  };
}

function socket() {
  return {
    data: {
      kind: "browser",
      sessionId: "session-1",
      ...context,
    },
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as ServerWebSocket<BrowserSocketData>;
}

function envelope(message: BrowserOutgoingMessage, eventId = "event-1") {
  return JSON.stringify({
    ...context,
    eventId,
    kind: message.type,
    payload: message,
  });
}

function payloads(ws: ServerWebSocket<BrowserSocketData>) {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
    ([raw]) => JSON.parse(raw as string).payload,
  );
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Pi-only WsBridge", () => {
  it("builds SessionState from launcher readiness and routes user prompts", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    const session = bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    expect(session.state).toMatchObject({
      backendType: "pi",
      transport: "pi-rpc",
      piVersion: "0.82.1",
      model: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      thinkingLevel: "high",
      mode: "agent",
      commands: ["piwork-plan"],
      generation: 3,
      runState: "ready",
    });

    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    bridge.handleBrowserMessage(
      ws,
      envelope({
        type: "agent_message",
        generation: 3,
        clientMsgId: "client-1",
        message: {
          id: "client-1",
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
          ],
          timestamp: 2,
        },
      }),
    );
    expect(runtime.transport.prompt).toHaveBeenCalledWith("hello", {
      images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(payloads(ws).map((message) => message.type)).toEqual(
      expect.arrayContaining(["session_init", "agent_message", "run_state"]),
    );
    expect(session.offlineQueue).toEqual([]);
  });

  it("drops stale generations before de-duplication or Pi delivery", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    const session = bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    bridge.handleBrowserMessage(
      ws,
      envelope({
        type: "agent_message",
        generation: 2,
        clientMsgId: "stale-1",
        message: {
          id: "stale-1",
          role: "user",
          content: [{ type: "text", text: "stale" }],
          timestamp: 2,
        },
      }),
    );
    expect(runtime.transport.prompt).toHaveBeenCalledTimes(0);
    expect(session.processedClientMessageIds).toEqual([]);
    expect(
      payloads(ws).some(
        (message) => message.type === "error" && message.code === "stale_generation",
      ),
    ).toBe(true);
  });

  it("maps trusted extension interactions to the structured browser protocol", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    runtime.adapter.handleNotification({
      type: "extension_ui_request",
      id: "ask-1",
      method: "select",
      title: encodePiAskBatchTitle("tool-ask-1", [
        {
          header: "Style",
          question: "Choose a style",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
          multiSelect: false,
        },
        {
          header: "Scope",
          question: "Choose scope",
          options: [
            { label: "Frontend", description: "UI only" },
            { label: "Full stack", description: "UI and server" },
          ],
          multiSelect: true,
        },
      ]),
      options: [PI_ASK_BATCH_OPTION],
      timeout: 1_000,
    });
    const request = payloads(ws).find((message) => message.type === "interaction_request");
    expect(request).toMatchObject({
      type: "interaction_request",
      generation: 3,
      request: {
        id: "ask-1",
        kind: "ask",
        toolCallId: "tool-ask-1",
        questions: [
          {
            id: "question-0",
            question: "Choose a style",
            options: [
              { id: "question-0-option-0", label: "A", description: "Option A" },
              { id: "question-0-option-1", label: "B", description: "Option B" },
            ],
          },
          {
            id: "question-1",
            question: "Choose scope",
            allowMultiple: true,
          },
        ],
      },
    });
    bridge.handleBrowserMessage(
      ws,
      envelope(
        {
          type: "interaction_response",
          generation: 3,
          requestId: "ask-1",
          kind: "ask",
          status: "submitted",
          answers: [
            {
              questionId: "question-0",
              selectedOptionIds: ["question-0-option-1"],
            },
            {
              questionId: "question-1",
              selectedOptionIds: ["question-1-option-0"],
              freeText: "API",
            },
          ],
          timestamp: 3,
          clientMsgId: "answer-1",
        },
        "event-2",
      ),
    );
    expect(runtime.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask-1",
      value: encodePiAskBatchResponse([
        { question: "Choose a style", answer: "B" },
        { question: "Choose scope", answer: ["Frontend", "API"] },
      ]),
    });
  });

  it("preserves plan refinement text in the trusted extension response", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    runtime.adapter.handleNotification({
      type: "extension_ui_request",
      id: "plan-1",
      method: "select",
      title: encodePiPlanRequestTitle("tool-plan-1", "1. Draft"),
      options: [...PI_PLAN_OPTIONS],
    });
    expect(
      payloads(ws).find(
        (message) => message.type === "interaction_request" && message.request?.id === "plan-1",
      ),
    ).toMatchObject({
      request: {
        kind: "propose_plan",
        toolCallId: "tool-plan-1",
        plan: "1. Draft",
      },
    });

    bridge.handleBrowserMessage(
      ws,
      envelope({
        type: "interaction_response",
        generation: 3,
        requestId: "plan-1",
        kind: "propose_plan",
        status: "submitted",
        decision: "refine",
        refinement: "  Add validation  ",
        timestamp: 3,
        clientMsgId: "plan-answer-1",
      }),
    );

    expect(runtime.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "plan-1",
      value: JSON.stringify({ decision: "refine", refinement: "Add validation" }),
    });
  });

  it("keeps the trusted batch transport marker out of visible browser copy", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    runtime.adapter.handleNotification({
      type: "extension_ui_request",
      id: "ask-actions",
      method: "select",
      title: encodePiAskBatchTitle("tool-ask-actions", [
        {
          header: "Choice",
          question: "Choose",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
          multiSelect: false,
        },
      ]),
      options: [PI_ASK_BATCH_OPTION],
    });

    const request = payloads(ws).find(
      (message) => message.type === "interaction_request" && message.request?.id === "ask-actions",
    );
    expect(request?.request.questions).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain(PI_ASK_BATCH_OPTION);
  });

  it("queues only user messages while Pi is offline and flushes them on attach", () => {
    const bridge = new WsBridge();
    const session = bridge.restoreSession(
      { ...info(0), state: "exited", generation: 0 },
      {
        id: "session-1",
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    );
    expect(bridge.injectUserMessage("session-1", "queued while offline")).toBe(true);
    expect(session.offlineQueue).toHaveLength(1);
    const stored = serializeForStore(session) as unknown as Record<string, unknown>;
    expect(stored.offlineQueue).toBeDefined();
    expect(stored.messageHistory).toBeUndefined();
    expect(stored.pendingPermissions).toBeUndefined();

    const runtime = adapterFixture(1);
    bridge.attachPiAdapter({ ...info(1), generation: 1 }, runtime.adapter, undefined, readiness());
    expect(runtime.transport.prompt).toHaveBeenCalledWith("queued while offline", { images: [] });
    expect(session.offlineQueue).toEqual([]);
  });

  it("ignores late adapter events after the generation is detached", () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    const session = bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    expect(bridge.detachPiAdapter("session-1", 2)).toBe(false);
    expect(bridge.detachPiAdapter("session-1", 3)).toBe(true);
    const before = payloads(ws).length;
    runtime.adapter.handleNotification({ type: "agent_start" });
    expect(payloads(ws)).toHaveLength(before);
    expect(session.state.runState).toBe("disconnected");
  });

  it("disposes adapters and sockets without deleting persisted authority", async () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    await bridge.dispose();
    expect(runtime.transport.dispose).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(bridge.getSession("session-1")).toBeUndefined();
  });

  it("restores Pi readiness, usage, MCP state, authority, and generation in place", () => {
    const bridge = new WsBridge();
    const save = vi.fn();
    bridge.setStore({
      getSessionDirectory: vi.fn(() => "/tmp/session-1"),
      save,
    } as never);
    const ready = readiness();
    ready.state.isStreaming = true;
    ready.history.entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: "done",
          usage: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
          },
        },
      },
      { type: "message", message: { role: "assistant", content: "no usage" } },
      { type: "model_change", provider: "openai", modelId: "gpt-5" },
    ];
    ready.mcp = [{ name: "docs", status: "connected" }];
    const session = bridge.restoreSession(
      { ...info(), readiness: ready },
      {
        id: "session-1",
        authority: {
          tenantId: "tenant-1",
          userId: "user-1",
          agentDefinitionId: "agent-1",
          agentVersionId: "revision-1",
          effectivePolicyHash: "policy-1",
        },
        offlineQueue: [],
        processedClientMessageIds: ["seen"],
      },
    );

    expect(session.state).toMatchObject({
      runState: "running",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        turns: 1,
      },
      mcpServers: [
        {
          name: "docs",
          enabled: true,
          status: "connected",
          config: { type: "stdio" },
          scope: "agent",
        },
      ],
    });
    expect(bridge.getSessionPhase("session-1")).toBe("streaming");
    expect(bridge.getSessionPhases().get("session-1")).toBe("streaming");
    expect(bridge.getAllSessions()).toHaveLength(1);
    expect(bridge.getSessionMemoryStats()).toEqual([
      {
        id: "session-1",
        browsers: 0,
        historyLen: 0,
        eventBufferLen: 0,
        pendingMsgs: 0,
      },
    ]);
    expect(
      bridge.setSessionAuthority("missing", {
        tenantId: "tenant-1",
        userId: "user-1",
        agentDefinitionId: "agent-1",
        agentVersionId: "revision-1",
        effectivePolicyHash: "policy-1",
      }),
    ).toBe(false);
    expect(
      bridge.setSessionAuthority("session-1", {
        tenantId: "tenant-2",
        userId: "user-2",
        agentDefinitionId: "agent-2",
        agentVersionId: "revision-2",
        effectivePolicyHash: "policy-2",
      }),
    ).toBe(true);
    expect(bridge.setSessionNameSource("missing", "manual")).toBe(false);
    expect(bridge.setSessionNameSource("session-1", "generated")).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);

    const compacting = readiness();
    compacting.state.isCompacting = true;
    const restored = bridge.restoreSession(
      {
        ...info(4),
        state: "starting",
        generation: 4,
        readiness: compacting,
      },
      {
        id: "session-1",
        archived: true,
        archivedAt: 20,
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    );
    expect(restored).toBe(session);
    expect(restored.state.runState).toBe("compacting");
    expect(restored.archived).toBe(true);
    expect(restored.archivedAt).toBe(20);
  });

  it("projects every Pi adapter event into Pi-shaped browser state", async () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    const session = bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");

    runtime.adapter.handleNotification({
      type: "extension_ui_request",
      id: "extension-status",
      method: "setStatus",
      statusKey: "piwork.extension",
      statusText: JSON.stringify({
        mode: "plan",
        mcp: [{ name: "docs", enabled: false }],
      }),
    });
    runtime.adapter.handleNotification({ type: "message_start", message: {} });
    runtime.adapter.handleNotification({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" },
    });
    runtime.adapter.handleNotification({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' },
    });
    runtime.adapter.handleNotification({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "reason" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "unknown" },
        ],
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        timestamp: 5,
        usage: { input: 4, output: 2 },
      },
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_start",
      toolCallId: "todo-1",
      toolName: "todo_write",
      args: { todos: [] },
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_update",
      toolCallId: "todo-1",
      toolName: "todo_write",
      args: { todos: [] },
      partialResult: { details: { progress: "half" } },
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_end",
      toolCallId: "todo-1",
      toolName: "todo_write",
      result: {
        details: {
          todos: [
            {
              id: "todo-a",
              text: "Ship",
              status: "in_progress",
              activeForm: "Shipping",
            },
          ],
        },
      },
      isError: false,
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { prompt: "inspect" },
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      result: {
        details: {
          taskId: "child-1",
          name: "Inspect",
          description: "Read files",
          execution: "background",
          status: "completed",
          depth: 1,
          progress: "done",
        },
      },
      isError: false,
    });
    runtime.adapter.handleNotification({
      type: "tool_execution_end",
      toolCallId: "bash-1",
      toolName: "bash",
      result: { message: "failed" },
      isError: true,
    });
    runtime.adapter.handleNotification({
      type: "compaction_start",
      reason: "threshold",
    });
    runtime.adapter.handleNotification({
      type: "compaction_end",
      aborted: true,
      willRetry: false,
      reason: "manual",
    });
    runtime.adapter.handleNotification({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "retry",
    });
    runtime.adapter.handleNotification({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "failed",
    });
    runtime.adapter.handleNotification({
      type: "thinking_level_changed",
      level: "xhigh",
    });
    runtime.adapter.handleNotification({
      type: "extension_error",
      extensionPath: "/trusted/pi-trusted-extension.ts",
      event: "tool_call",
      error: "extension failed",
    });
    runtime.adapter.handleNotification({ type: "agent_settled" });
    await runtime.adapter.replayHistory();

    const output = payloads(ws);
    expect(session.state.mode).toBe("plan");
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message_delta",
          delta: expect.objectContaining({ kind: "thinking" }),
        }),
        expect.objectContaining({
          type: "message_delta",
          delta: expect.objectContaining({ kind: "tool_arguments" }),
        }),
        expect.objectContaining({
          type: "agent_message",
          message: expect.objectContaining({
            role: "assistant",
            model: {
              key: "openai/gpt-5",
              provider: "openai",
              modelId: "gpt-5",
            },
          }),
        }),
        expect.objectContaining({
          type: "tool_execution",
          toolCallId: "todo-1",
          todos: [
            {
              id: "todo-a",
              content: "Ship",
              status: "in_progress",
              activeForm: "Shipping",
            },
          ],
        }),
        expect.objectContaining({
          type: "tool_execution",
          toolCallId: "task-1",
          task: expect.objectContaining({
            taskId: "child-1",
            execution: "background",
            status: "completed",
          }),
        }),
        expect.objectContaining({
          type: "error",
          code: "pi_extension_error",
          message: "extension failed",
        }),
        expect.objectContaining({ type: "history_snapshot", reason: "recovery" }),
      ]),
    );

    runtime.adapter.send({
      type: "set_model",
      model: { provider: "openai", modelId: "gpt-5-mini" },
    });
    await settle();
    expect(session.state.model).toEqual({
      key: "openai/gpt-5-mini",
      provider: "openai",
      modelId: "gpt-5-mini",
    });

    const internal = bridge as unknown as {
      handlePiAdapterMessage(target: Session, message: PiBrowserIncomingMessage): void;
    };
    internal.handlePiAdapterMessage(session, {
      type: "pi_state",
      sessionId: "wrong-session",
    });
    expect(payloads(ws)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", code: "pi_session_mismatch" }),
      ]),
    );
  });

  it("routes controls and browser-owned User Space and OnlyOffice messages", async () => {
    const bridge = new WsBridge();
    const runtime = adapterFixture();
    const session = bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    const mount: UserSpaceMount = {
      mountId: "mount-1",
      name: "Documents",
      rootName: "Documents",
      status: "mounted",
      access: "readwrite",
      includeHidden: true,
    };
    const sender = vi.fn();
    const userSpace = {
      setSender: vi.fn((value) => sender.mockImplementation(value)),
      updateMounts: vi.fn(() => [mount]),
      getActiveUserSpace: vi.fn(() => ({
        name: "Documents",
        rootName: "Documents",
        status: "mounted",
        access: "readwrite",
        includeHidden: true,
      })),
      authorizeMutationCommit: vi.fn(() => ({
        commitLease: "lease-1",
        runtimeEpoch: "epoch-1",
      })),
      unmount: vi.fn(() => []),
      updateIndex: vi.fn(() => [{ ...mount, fileCount: 12, lastIndexedAt: 10 }]),
      handleResponse: vi.fn(),
      markOffline: vi.fn(() => [{ ...mount, status: "offline" }]),
      removeSession: vi.fn(),
    };
    bridge.setUserSpaceBroker(userSpace as never);
    const onlyOffice = {
      setSender: vi.fn(),
      updateStatus: vi.fn(),
      resolveResponse: vi.fn(),
      removeSocket: vi.fn(),
    };
    bridge.setOnlyOfficeBroker(onlyOffice as never);
    const control = vi.fn(async (_sessionId: string, message: BrowserOutgoingMessage) => {
      return message.type !== "set_model";
    });
    bridge.setControlHandler(control);

    const messages: BrowserOutgoingMessage[] = [
      { type: "session_subscribe", lastSeq: 0 },
      { type: "session_ack", lastSeq: 8 },
      { type: "user_space_mount", mounts: [mount] },
      {
        type: "user_space_mutation_authorize",
        request_id: "mutation-1",
      },
      {
        type: "user_space_index_update",
        mountId: "mount-1",
        fileCount: 12,
        lastIndexedAt: 10,
      },
      {
        type: "user_space_response",
        request_id: "request-1",
        ok: true,
        result: { path: "report.md" },
        commit_lease: "lease-1",
        runtime_epoch: "epoch-1",
      },
      { type: "user_space_unmount", mountId: "mount-1" },
      { type: "onlyoffice_status", document: null },
      {
        type: "onlyoffice_response",
        request_id: "office-1",
        ok: true,
        result: { saved: true },
      },
      { type: "abort", generation: 3, clientMsgId: "abort-1" },
      { type: "compact", clientMsgId: "compact-1" },
      {
        type: "set_thinking_level",
        thinkingLevel: "low",
        clientMsgId: "thinking-1",
      },
      {
        type: "set_model",
        model: {
          key: "openai/gpt-5-mini",
          provider: "openai",
          modelId: "gpt-5-mini",
        },
        clientMsgId: "model-1",
      },
      { type: "set_mode", mode: "plan", clientMsgId: "mode-1" },
    ];
    for (const [index, message] of messages.entries()) {
      bridge.handleBrowserMessage(ws, envelope(message, `control-${index}`));
      await settle();
    }

    expect(userSpace.updateMounts).toHaveBeenCalled();
    expect(userSpace.authorizeMutationCommit).toHaveBeenCalledWith("session-1", "mutation-1", ws);
    expect(userSpace.handleResponse).toHaveBeenCalled();
    expect(onlyOffice.updateStatus).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "onlyoffice_status" }),
      ws,
    );
    expect(onlyOffice.resolveResponse).toHaveBeenCalled();
    expect(runtime.transport.abort).toHaveBeenCalled();
    expect(runtime.transport.compact).toHaveBeenCalled();
    expect(runtime.transport.setThinkingLevel).toHaveBeenCalledWith("low");
    expect(control).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "set_model" }),
    );
    expect(control).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "set_mode" }),
    );
    expect(session.lastAckSeq).toBe(8);
    expect(payloads(ws)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user_space_mutation_authorization",
          ok: true,
          commit_lease: "lease-1",
        }),
        expect.objectContaining({ type: "error", code: "model_policy_denied" }),
      ]),
    );
  });

  it("fails closed for stale interactions, disconnected controls, invalid input, and full queues", async () => {
    const bridge = new WsBridge();
    const session = bridge.restoreSession(
      { ...info(0), state: "exited", generation: 0 },
      { id: "session-1", offlineQueue: [], processedClientMessageIds: [] },
    );
    const ws = socket();
    ws.data.sessionId = "session-1";
    bridge.handleBrowserOpen(ws, "session-1");

    expect(
      bridge.injectUserMessage("session-1", {
        id: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "not a user message" }],
        timestamp: 1,
      }),
    ).toBe(false);
    expect(bridge.interruptSession("session-1")).toBe(false);
    for (let index = 0; index < 100; index += 1) {
      expect(bridge.injectUserMessage("session-1", `queued-${index}`)).toBe(true);
    }
    expect(bridge.injectUserMessage("session-1", "overflow")).toBe(false);

    const controls: BrowserOutgoingMessage[] = [
      { type: "abort", generation: 0, clientMsgId: "abort-offline" },
      { type: "compact", clientMsgId: "compact-offline" },
      {
        type: "set_thinking_level",
        thinkingLevel: "medium",
        clientMsgId: "thinking-offline",
      },
      {
        type: "interaction_response",
        generation: 0,
        requestId: "missing",
        kind: "ask",
        status: "submitted",
        answers: [
          {
            questionId: "question-0",
            selectedOptionIds: [],
            freeText: "answer",
          },
        ],
        clientMsgId: "interaction-stale",
      },
      { type: "retry", clientMsgId: "unsupported" },
    ];
    for (const [index, message] of controls.entries()) {
      bridge.handleBrowserMessage(ws, envelope(message, `failure-${index}`));
      await settle();
    }
    expect(payloads(ws)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", code: "offline_queue_full" }),
        expect.objectContaining({ type: "error", code: "pi_not_connected" }),
        expect.objectContaining({ type: "error", code: "stale_interaction" }),
        expect.objectContaining({ type: "error", code: "unsupported_pi_control" }),
      ]),
    );
    expect(session.offlineQueue).toHaveLength(100);
  });

  it("closes unknown and oversized sockets and cleans every session integration", async () => {
    const bridge = new WsBridge();
    const unknown = socket();
    unknown.data.sessionId = "missing";
    bridge.handleBrowserOpen(unknown, "missing");
    expect(unknown.close).toHaveBeenCalledWith(1008, "Unknown session");

    const runtime = adapterFixture();
    bridge.attachPiAdapter(info(), runtime.adapter, undefined, readiness());
    const ws = socket();
    bridge.handleBrowserOpen(ws, "session-1");
    bridge.handleBrowserMessage(ws, Buffer.alloc(2 * 1024 * 1024));
    expect(ws.close).toHaveBeenCalledWith(1009, expect.stringContaining("byte limit"));

    const remove = vi.fn();
    bridge.setStore({ save: vi.fn(), remove } as never);
    const stopRecording = vi.fn();
    bridge.setRecorder({ record: vi.fn(), recordEvent: vi.fn(), stopRecording } as never);
    const removeSession = vi.fn();
    const markOffline = vi.fn(() => []);
    bridge.setUserSpaceBroker({
      setSender: vi.fn(),
      markOffline,
      getActiveUserSpace: vi.fn(() => null),
      removeSession,
    } as never);
    const removeSocket = vi.fn();
    bridge.setOnlyOfficeBroker({ setSender: vi.fn(), removeSocket } as never);

    bridge.handleBrowserClose(ws);
    expect(removeSocket).toHaveBeenCalledWith("session-1", ws);
    expect(markOffline).toHaveBeenCalledWith("session-1");
    bridge.closeSession("session-1");
    await settle();
    expect(removeSession).toHaveBeenCalledWith("session-1");
    expect(stopRecording).toHaveBeenCalledWith("session-1");
    expect(remove).toHaveBeenCalledWith("session-1");
    expect(runtime.transport.dispose).toHaveBeenCalled();
    expect(bridge.getSession("session-1")).toBeUndefined();
  });
});
