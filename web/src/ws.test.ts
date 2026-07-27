// @vitest-environment jsdom
import type { SessionState } from "./types.js";

let wsModule: typeof import("./ws.js");
let useStore: typeof import("./store.js").useStore;
let lastSocket: MockWebSocket;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(url: string) {
    this.url = url;
    lastSocket = this;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });

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

const model = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };

function makeSession(generation = 1): SessionState {
  return {
    sessionId: "s1",
    backendType: "pi",
    transport: "pi-rpc",
    piVersion: "0.82.1",
    model,
    thinkingLevel: "high",
    mode: "agent",
    cwd: "/workspace",
    tools: ["read", "write", "edit", "bash"],
    commands: [],
    skills: [],
    mcpServers: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    runState: "ready",
    isCompacting: false,
    generation,
  };
}

function fireMessage(message: Record<string, unknown>): void {
  lastSocket.onmessage?.({ data: JSON.stringify(message) });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const storeModule = await import("./store.js");
  useStore = storeModule.useStore;
  useStore.getState().reset();
  localStorage.clear();
  wsModule = await import("./ws.js");
  wsModule.connectSession("s1");
});

afterEach(() => {
  wsModule.disconnectAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Pi WebSocket transport", () => {
  it("connects only to the browser Pi endpoint and subscribes with lastSeq", () => {
    expect(lastSocket.url).toBe("ws://localhost:3456/ws/browser/s1");
    lastSocket.onopen?.(new Event("open"));
    expect(lastSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_subscribe", lastSeq: 0 }),
    );
  });

  it("adds a client message id and sends the native agent_message shape", () => {
    const sent = wsModule.sendToSession("s1", {
      type: "agent_message",
      generation: 1,
      message: {
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
    });
    expect(sent).toBe(true);
    const payload = JSON.parse(lastSocket.send.mock.calls.at(-1)?.[0] as string);
    expect(payload).toMatchObject({
      type: "agent_message",
      generation: 1,
      message: { role: "user" },
    });
    expect(payload.clientMsgId).toMatch(/^cmsg-/);
    expect(useStore.getState().runStates.get("s1")).toBe("running");
  });

  it("projects Pi messages, deltas and tool execution into the browser store", () => {
    fireMessage({ type: "session_init", session: makeSession(), seq: 1 });
    fireMessage({
      type: "agent_message",
      generation: 1,
      message: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Inspect" }],
        timestamp: 10,
      },
      seq: 2,
    });
    fireMessage({
      type: "message_delta",
      generation: 1,
      messageId: "assistant-1",
      role: "assistant",
      delta: { kind: "thinking", contentIndex: 0, delta: "Checking" },
      timestamp: 11,
      seq: 3,
    });
    fireMessage({
      type: "message_delta",
      generation: 1,
      messageId: "assistant-1",
      role: "assistant",
      delta: { kind: "text", contentIndex: 1, delta: "Done" },
      timestamp: 12,
      seq: 4,
    });
    fireMessage({
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-1",
      toolName: "read",
      status: "completed",
      input: { path: "README.md" },
      output: "contents",
      timestamp: 13,
      seq: 5,
    });

    const messages = useStore.getState().messages.get("s1") ?? [];
    expect(messages.find((message) => message.id === "user-1")?.content).toBe("Inspect");
    expect(
      messages
        .find((message) => message.id === "assistant-1")
        ?.contentParts?.map((part) => part.type),
    ).toEqual(["thinking", "text"]);
    expect(
      messages.find((message) => message.id === "tool:tool-1")?.toolExecutions?.[0],
    ).toMatchObject({ toolName: "read", status: "completed" });
  });

  it("tracks ask interactions and submitted responses", () => {
    fireMessage({ type: "session_init", session: makeSession(), seq: 1 });
    fireMessage({
      type: "interaction_request",
      generation: 1,
      request: {
        id: "ask-1",
        kind: "ask",
        toolCallId: "tool-ask",
        questions: [
          {
            id: "question-0",
            question: "Choose",
            options: [],
            allowMultiple: false,
            allowFreeText: true,
          },
        ],
      },
      timestamp: 10,
      seq: 2,
    });
    expect(useStore.getState().pendingInteractions.get("s1")?.has("ask-1")).toBe(true);
    expect(useStore.getState().runStates.get("s1")).toBe("awaiting_interaction");

    fireMessage({
      type: "interaction_response",
      generation: 1,
      requestId: "ask-1",
      kind: "ask",
      status: "submitted",
      answers: [
        {
          questionId: "question-0",
          selectedOptionIds: [],
          freeText: "Answer",
        },
      ],
      timestamp: 11,
      seq: 3,
    });
    expect(useStore.getState().pendingInteractions.has("s1")).toBe(false);
    expect(useStore.getState().completedInteractions.get("s1")).toHaveLength(1);
  });

  it("rebuilds pending interactions from a reset Pi history snapshot", () => {
    fireMessage({ type: "session_init", session: makeSession(), seq: 1 });
    useStore.getState().addInteraction("s1", {
      id: "stale",
      kind: "ask",
      toolCallId: "stale-tool",
      questions: [
        {
          id: "question-0",
          question: "stale",
          options: [],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    });
    fireMessage({
      type: "history_snapshot",
      generation: 1,
      entries: [
        {
          id: "entry-1",
          timestamp: 10,
          event: {
            type: "interaction_request",
            generation: 1,
            request: {
              id: "current",
              kind: "ask",
              toolCallId: "current-tool",
              questions: [
                {
                  id: "question-0",
                  question: "current",
                  options: [],
                  allowMultiple: false,
                  allowFreeText: true,
                },
              ],
            },
            timestamp: 10,
          },
        },
      ],
      total: 1,
      cursor: 0,
      nextCursor: 1,
      hasMore: false,
      reason: "recovery",
      seq: 2,
    });
    expect([...useStore.getState().pendingInteractions.get("s1")!.keys()]).toEqual(["current"]);
  });

  it("drops late events from an older process generation", () => {
    fireMessage({ type: "session_init", session: makeSession(3), seq: 1 });
    fireMessage({
      type: "agent_message",
      generation: 2,
      message: {
        id: "late",
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        timestamp: 1,
      },
      seq: 2,
    });
    expect(useStore.getState().messages.get("s1") ?? []).toHaveLength(0);
  });

  it("rejects the removed browser protocol instead of decoding it", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireMessage({ type: "user_message", content: "legacy", timestamp: 1 });
    fireMessage({ type: "permission_request", request_id: "legacy" });
    expect(useStore.getState().messages.get("s1") ?? []).toHaveLength(0);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("queues idempotent Pi settings but fails closed for offline interactions", () => {
    lastSocket.readyState = MockWebSocket.CLOSED;
    expect(wsModule.sendToSession("s1", { type: "set_mode", mode: "plan" })).toBe(true);
    expect(
      wsModule.sendToSession("s1", {
        type: "interaction_response",
        generation: 1,
        requestId: "ask-1",
        kind: "ask",
        status: "cancelled",
      }),
    ).toBe(false);
  });

  it("projects running todo/task tools and clears progress for terminal run states", () => {
    fireMessage({ type: "session_init", session: makeSession(), seq: 1 });
    fireMessage({
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-read",
      toolName: "read",
      status: "running",
      input: { path: "README.md" },
      progress: "Reading",
      elapsedMs: 1_500,
      timestamp: 10,
      seq: 2,
    });
    fireMessage({
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-todo",
      toolName: "todo_write",
      status: "running",
      todos: [
        {
          id: "todo-1",
          content: "Inspect transport",
          activeForm: "Inspecting transport",
          status: "in_progress",
        },
      ],
      timestamp: 11,
      seq: 3,
    });
    fireMessage({
      type: "tool_execution",
      generation: 1,
      toolCallId: "tool-task",
      toolName: "task",
      status: "running",
      task: {
        taskId: "task-1",
        name: "Read-only audit",
        description: "Inspect the Pi protocol",
        execution: "background",
        status: "running",
        depth: 1,
        progress: "Auditing",
      },
      timestamp: 12,
      seq: 4,
    });

    expect(useStore.getState().toolProgress.get("s1")?.get("tool-read")).toMatchObject({
      toolName: "read",
      elapsedSeconds: 1.5,
      text: "Reading",
    });
    expect(useStore.getState().sessionTasks.get("s1")?.[0]).toMatchObject({
      id: "todo-1",
      subject: "Inspect transport",
      status: "in_progress",
    });
    expect(useStore.getState().sessionProcesses.get("s1")?.[0]).toMatchObject({
      taskId: "task-1",
      execution: "background",
      status: "running",
    });

    fireMessage({
      type: "run_state",
      generation: 1,
      state: "reconnecting",
      timestamp: 13,
      seq: 5,
    });
    expect(useStore.getState().runtimeReconnecting.get("s1")).toBe(true);
    expect(useStore.getState().runActive.has("s1")).toBe(false);
    expect(useStore.getState().toolProgress.has("s1")).toBe(false);

    fireMessage({
      type: "run_state",
      generation: 1,
      state: "stopped",
      timestamp: 14,
      seq: 6,
    });
    expect(useStore.getState().runtimeConnected.get("s1")).toBe(false);
    expect(useStore.getState().runtimeReconnecting.has("s1")).toBe(false);
    expect(useStore.getState().sessions.get("s1")).toMatchObject({
      runState: "stopped",
      isCompacting: false,
    });
  });

  it("loads a native Pi history page and merges tool and interaction events", async () => {
    const apiModule = await import("./api.js");
    const historySpy = vi.spyOn(apiModule.api, "getSessionMessageHistory").mockResolvedValue({
      sessionId: "s1",
      totalEntries: 2,
      nextCursor: "entry-interaction",
      hasMore: false,
      entries: [
        {
          id: "entry-tool",
          timestamp: 2,
          event: {
            type: "tool_execution",
            generation: 1,
            toolCallId: "history-tool",
            toolName: "read",
            status: "completed",
            input: { path: "AGENTS.md" },
            output: "rules",
            timestamp: 2,
          },
        },
        {
          id: "entry-response",
          timestamp: 3,
          event: {
            type: "interaction_response",
            generation: 1,
            requestId: "ask-history",
            kind: "ask",
            status: "submitted",
            answers: [
              {
                questionId: "question-0",
                selectedOptionIds: ["yes"],
              },
            ],
            timestamp: 3,
          },
        },
      ],
    });
    const store = useStore.getState();
    store.setMessages("s1", [{ id: "existing", role: "user", content: "Earlier", timestamp: 1 }]);
    store.addInteraction("s1", {
      id: "ask-history",
      kind: "ask",
      toolCallId: "ask-tool",
      questions: [
        {
          id: "question-0",
          question: "Continue?",
          options: [{ id: "yes", label: "Yes" }],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    });

    const result = await wsModule.loadSessionHistoryPage("s1", { limit: 10 });

    expect(historySpy).toHaveBeenCalledWith(
      "s1",
      { cursor: undefined, limit: 10 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({
      cursor: "entry-interaction",
      hasMore: false,
      loaded: true,
      loading: false,
      total: 2,
      received: 2,
    });
    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((message) => message.id),
    ).toEqual(["existing", "tool:history-tool"]);
    expect(useStore.getState().completedInteractions.get("s1")).toHaveLength(1);
  });

  it("returns a stable history state when a Pi history page fails", async () => {
    const apiModule = await import("./api.js");
    vi.spyOn(apiModule.api, "getSessionMessageHistory").mockRejectedValue(
      new Error("history unavailable"),
    );

    const result = await wsModule.loadSessionHistoryPage("s1", { reset: true, limit: 10 });

    expect(result).toMatchObject({
      cursor: undefined,
      hasMore: false,
      loaded: false,
      loading: false,
      error: "history unavailable",
    });
    expect(wsModule.getSessionHistoryLoadState("s1")).toEqual(result);
  });

  it("applies Pi metadata, lifecycle and replay events with strict seq ACKs", () => {
    fireMessage({ type: "session_init", session: makeSession(), seq: 1 });
    useStore.getState().setRuntimeSessions([
      {
        sessionId: "s1",
        state: "connected",
        transport: "pi-rpc",
        cwd: "/workspace",
        createdAt: 1,
        backendType: "pi",
      },
      {
        sessionId: "other",
        state: "connected",
        transport: "pi-rpc",
        cwd: "/workspace",
        createdAt: 2,
        backendType: "pi",
      },
    ]);
    fireMessage({ type: "session_update", session: { mode: "plan" }, seq: 2 });
    fireMessage({ type: "session_name_update", name: "Native Pi topic", seq: 3 });
    fireMessage({
      type: "session_lifecycle_update",
      sessionId: "s1",
      lifecycleState: "closed",
      seq: 4,
    });
    fireMessage({
      type: "mcp_status",
      servers: [
        {
          name: "docs",
          enabled: true,
          status: "connected",
          scope: "agent",
          config: { type: "sse", url: "https://example.test/sse" },
        },
      ],
      seq: 5,
    });
    fireMessage({
      type: "event_replay",
      events: [
        { seq: 4, message: { type: "error", message: "stale" } },
        { seq: 8, message: { type: "error", message: "replayed" } },
      ],
    });

    const store = useStore.getState();
    expect(store.sessions.get("s1")?.mode).toBe("plan");
    expect(store.sessionNames.get("s1")).toBe("Native Pi topic");
    expect(store.recentlyRenamed.has("s1")).toBe(true);
    expect(store.runtimeSessions.find((session) => session.sessionId === "s1")).toMatchObject({
      lifecycleState: "closed",
      state: "exited",
    });
    expect(store.runStates.get("s1")).toBe("stopped");
    expect(store.mcpServers.get("s1")?.[0]?.name).toBe("docs");
    expect(store.messages.get("s1")?.map((message) => message.content)).toContain("replayed");
    expect(store.messages.get("s1")?.map((message) => message.content)).not.toContain("stale");
    expect(lastSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", lastSeq: 8 }),
    );
  });

  it("rejects non-text WebSocket frames before protocol decoding", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    lastSocket.onmessage?.({ data: null as unknown as string });
    expect(warning).toHaveBeenCalledWith("[ws] Ignored malformed incoming message for session s1");
  });

  it("reconnects a bound Pi session after the active socket closes", async () => {
    useStore.getState().setRuntimeSessions([
      {
        sessionId: "s1",
        state: "connected",
        transport: "pi-rpc",
        cwd: "/workspace",
        createdAt: 1,
        backendType: "pi",
      },
    ]);
    useStore.getState().setCurrentSession("s1");
    const closedSocket = lastSocket;
    closedSocket.onopen?.(new Event("open"));

    closedSocket.onclose?.();
    expect(useStore.getState().connectionStatus.get("s1")).toBe("disconnected");
    expect(useStore.getState().runtimeConnected.get("s1")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastSocket).not.toBe(closedSocket);
    expect(lastSocket.url).toBe("ws://localhost:3456/ws/browser/s1");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
  });
});
