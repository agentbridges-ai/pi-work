import { describe, expect, it, vi } from "vitest";
import { PiAdapter, type PiBrowserIncomingMessage } from "./pi-adapter.js";
import { PiRpcRemoteError, type PiRpcTransport } from "./pi-rpc-transport.js";

function fixture() {
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
    getState: vi.fn(async () => ({
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "minimal",
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    })),
    replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
    sendExtensionUiResponse: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as PiRpcTransport;
  const adapter = new PiAdapter({
    transport,
    sessionId: "session-1",
    generation: 3,
  });
  const messages: PiBrowserIncomingMessage[] = [];
  adapter.onBrowserMessage((message) => messages.push(message));
  return { adapter, transport, messages };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PiAdapter", () => {
  it("normalizes Pi message deltas and final messages", () => {
    const value = fixture();
    value.adapter.handleNotification({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    value.adapter.handleNotification({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
    value.adapter.handleNotification({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        provider: "openai",
        model: "gpt-5",
        timestamp: 1,
      },
    });
    expect(value.messages).toEqual([
      {
        type: "message_delta",
        message_id: "pi-3-message-1",
        content_index: 0,
        delta_kind: "text",
        delta: "hello",
      },
      {
        type: "agent_message",
        message: {
          id: "pi-3-message-1",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
          provider: "openai",
          modelId: "gpt-5",
        },
      },
    ]);
  });

  it("routes extension UI through interaction request/response", () => {
    const value = fixture();
    value.adapter.handleNotification({
      type: "extension_ui_request",
      id: "ask-1",
      method: "select",
      title: "Choose",
      options: ["a", "b"],
      timeout: 1_000,
    });
    expect(value.messages[0]).toEqual({
      type: "interaction_request",
      request_id: "ask-1",
      method: "select",
      title: "Choose",
      options: ["a", "b"],
      timeout_ms: 1_000,
    });
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "ask-1",
        value: "b",
      }),
    ).toBe(true);
    expect(value.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask-1",
      value: "b",
    });
  });

  it("maps tools and run state without Claude-shaped events", () => {
    const value = fixture();
    value.adapter.handleNotification({ type: "agent_start" });
    value.adapter.handleNotification({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/workspace/a" },
    });
    value.adapter.handleNotification({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "a" }] },
      isError: false,
    });
    value.adapter.handleNotification({ type: "agent_settled" });
    expect(value.messages.map((message) => message.type)).toEqual([
      "run_state",
      "tool_execution",
      "tool_execution",
      "run_state",
    ]);
    expect(JSON.stringify(value.messages)).not.toMatch(/claude|sdk_message/iu);
  });

  it("routes every browser command and publishes resulting Pi state", async () => {
    const value = fixture();
    const sessionMeta = vi.fn();
    value.adapter.onSessionMeta(sessionMeta);

    expect(
      value.adapter.send({
        type: "agent_message",
        content: "prompt",
        images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }),
    ).toBe(true);
    expect(value.adapter.send({ type: "agent_message", content: "steer", delivery: "steer" })).toBe(
      true,
    );
    expect(
      value.adapter.send({ type: "agent_message", content: "follow", delivery: "follow_up" }),
    ).toBe(true);
    expect(value.adapter.send({ type: "abort" })).toBe(true);
    expect(value.adapter.send({ type: "retry_abort" })).toBe(true);
    expect(value.adapter.send({ type: "compact", instructions: "shorten" })).toBe(true);
    expect(
      value.adapter.send({
        type: "set_model",
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ).toBe(true);
    expect(value.adapter.send({ type: "set_thinking", level: "xhigh" })).toBe(true);
    expect(value.adapter.send({ type: "history_request", since: "entry-1" })).toBe(true);
    expect(value.adapter.send({ type: "unknown" } as never)).toBe(false);
    await vi.waitFor(() => expect(value.transport.setThinkingLevel).toHaveBeenCalledWith("xhigh"));

    expect(value.transport.prompt).toHaveBeenCalledWith("prompt", {
      images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    });
    expect(value.transport.steer).toHaveBeenCalledWith("steer");
    expect(value.transport.followUp).toHaveBeenCalledWith("follow");
    expect(value.transport.abort).toHaveBeenCalledOnce();
    expect(value.transport.abortRetry).toHaveBeenCalledOnce();
    expect(value.transport.compact).toHaveBeenCalledWith("shorten");
    expect(value.transport.replayHistory).toHaveBeenCalledWith("entry-1");
    expect(sessionMeta).toHaveBeenCalledWith({
      model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
    });
    expect(value.messages).toContainEqual({
      type: "pi_state",
      model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "minimal",
    });
    expect(value.messages).not.toContainEqual({
      type: "pi_state",
      thinkingLevel: "xhigh",
    });
    expect(value.messages).toContainEqual({
      type: "history_snapshot",
      entries: [],
      leaf_id: null,
    });
  });

  it("fails a rejected browser command without leaking the transport error", async () => {
    const value = fixture();
    const initError = vi.fn();
    value.adapter.onInitError(initError);
    vi.mocked(value.transport.prompt).mockRejectedValueOnce(new Error("secret provider failure"));

    expect(value.adapter.send({ type: "agent_message", content: "fail" })).toBe(true);
    await flush();
    expect(value.messages).toContainEqual({
      type: "run_state",
      state: "error",
      detail: "Pi RPC command failed.",
    });
    expect(initError).toHaveBeenCalledWith("Pi RPC command failed.");
  });

  it("reports stock Pi prompt acceptance instead of optimistic dispatch", async () => {
    const value = fixture();
    vi.mocked(value.transport.prompt).mockRejectedValueOnce(
      new PiRpcRemoteError("prompt", "preflight rejected"),
    );
    await expect(
      value.adapter.sendAgentMessage({ type: "agent_message", content: "fail" }),
    ).resolves.toBe("rejected");

    expect(value.messages).toContainEqual({
      type: "run_state",
      state: "error",
      detail: "Pi RPC command failed.",
    });
  });

  it("does not turn an uncorrelated transport failure into a definitive rejection", async () => {
    const value = fixture();
    vi.mocked(value.transport.prompt).mockRejectedValueOnce(new Error("response lost"));

    await expect(
      value.adapter.sendAgentMessage({ type: "agent_message", content: "maybe delivered" }),
    ).resolves.toBe("unknown");
  });

  it("distinguishes settled, busy, and unavailable stock Pi state", async () => {
    const value = fixture();
    await expect(value.adapter.settlementStatus()).resolves.toBe("settled");

    vi.mocked(value.transport.getState).mockResolvedValueOnce({
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "minimal",
      isStreaming: true,
      isCompacting: false,
      pendingMessageCount: 0,
    } as never);
    await expect(value.adapter.settlementStatus()).resolves.toBe("busy");

    vi.mocked(value.transport.getState).mockRejectedValueOnce(new Error("temporarily down"));
    await expect(value.adapter.settlementStatus()).resolves.toBe("unavailable");
  });

  it("reconciles the previous stock Pi state after a rejected model change", async () => {
    const value = fixture();
    vi.mocked(value.transport.setModel).mockRejectedValueOnce(new Error("model unavailable"));

    expect(
      value.adapter.send({
        type: "set_model",
        model: { provider: "openai", modelId: "missing" },
      }),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(value.messages).toContainEqual({
        type: "run_state",
        state: "error",
        detail: "Pi RPC command failed.",
      });
    });

    expect(value.messages).toContainEqual({
      type: "pi_state",
      model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "minimal",
    });
  });

  it("uses the stock set_model result when get_state reconciliation is unavailable", async () => {
    const value = fixture();
    const sessionMeta = vi.fn();
    value.adapter.onSessionMeta(sessionMeta);
    vi.mocked(value.transport.getState).mockRejectedValueOnce(new Error("state unavailable"));

    expect(
      value.adapter.send({
        type: "set_model",
        model: { provider: "openai", modelId: "gpt-5-mini" },
      }),
    ).toBe(true);
    await flush();

    const model = {
      key: "openai/gpt-5-mini",
      provider: "openai",
      modelId: "gpt-5-mini",
    };
    expect(sessionMeta).toHaveBeenCalledWith({ model });
    expect(value.messages).toContainEqual({ type: "pi_state", model });
  });

  it("serializes model and thinking mutations through one stock Pi state lane", async () => {
    const value = fixture();
    let releaseModel!: () => void;
    vi.mocked(value.transport.setModel).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      return { provider: "openai", id: "gpt-5-mini" } as never;
    });

    expect(
      value.adapter.send({
        type: "set_model",
        model: { provider: "openai", modelId: "gpt-5-mini" },
      }),
    ).toBe(true);
    expect(value.adapter.send({ type: "set_thinking", level: "high" })).toBe(true);
    await Promise.resolve();

    expect(value.transport.setModel).toHaveBeenCalledOnce();
    expect(value.transport.setThinkingLevel).not.toHaveBeenCalled();

    releaseModel();
    await vi.waitFor(() => expect(value.transport.setThinkingLevel).toHaveBeenCalledOnce());
  });

  it("validates confirm, value, cancellation, and stale interaction responses", () => {
    const value = fixture();
    const requests = [
      {
        type: "extension_ui_request" as const,
        id: "confirm",
        method: "confirm" as const,
        title: "Confirm",
        message: "Proceed?",
      },
      {
        type: "extension_ui_request" as const,
        id: "input",
        method: "input" as const,
        title: "Input",
      },
      {
        type: "extension_ui_request" as const,
        id: "editor",
        method: "editor" as const,
        title: "Editor",
      },
    ];
    for (const request of requests) value.adapter.handleNotification(request);

    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "confirm",
        confirmed: false,
      }),
    ).toBe(true);
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "input",
        cancelled: true,
      }),
    ).toBe(true);
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "editor",
        value: "updated",
      }),
    ).toBe(true);
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "missing",
        value: "ignored",
      }),
    ).toBe(false);

    value.adapter.handleNotification({
      type: "extension_ui_request",
      id: "bad-confirm",
      method: "confirm",
      title: "Confirm",
      message: "Proceed?",
    });
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "bad-confirm",
        value: "yes",
      }),
    ).toBe(false);
    value.adapter.handleNotification({
      type: "extension_ui_request",
      id: "bad-value",
      method: "select",
      title: "Choose",
      options: [],
    });
    expect(
      value.adapter.send({
        type: "interaction_response",
        request_id: "bad-value",
        confirmed: true,
      }),
    ).toBe(false);

    expect(value.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "confirm",
      confirmed: false,
    });
    expect(value.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "input",
      cancelled: true,
    });
    expect(value.transport.sendExtensionUiResponse).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "editor",
      value: "updated",
    });
  });

  it("normalizes every extension UI event and guards extension status parsing", () => {
    const value = fixture();
    const extensionStatus = vi.fn();
    value.adapter.onExtensionStatus(extensionStatus);
    const notifications = [
      {
        type: "extension_ui_request" as const,
        id: "confirm",
        method: "confirm" as const,
        title: "Confirm",
        message: "Proceed?",
        timeout: 5,
      },
      {
        type: "extension_ui_request" as const,
        id: "input",
        method: "input" as const,
        title: "Input",
        placeholder: "value",
        timeout: 6,
      },
      {
        type: "extension_ui_request" as const,
        id: "editor",
        method: "editor" as const,
        title: "Editor",
        prefill: "draft",
      },
      {
        type: "extension_ui_request" as const,
        id: "status",
        method: "setStatus" as const,
        statusKey: "piwork.extension",
        statusText: '{"mode":"plan"}',
      },
      {
        type: "extension_ui_request" as const,
        id: "bad-status",
        method: "setStatus" as const,
        statusKey: "piwork.extension",
        statusText: "{",
      },
      {
        type: "extension_ui_request" as const,
        id: "plain-status",
        method: "setStatus" as const,
        statusKey: "other",
        statusText: "plain",
      },
      {
        type: "extension_ui_request" as const,
        id: "notify",
        method: "notify" as const,
        message: "done",
      },
      {
        type: "extension_ui_request" as const,
        id: "widget",
        method: "setWidget" as const,
        widgetKey: "todo",
        widgetLines: ["one"],
      },
      {
        type: "extension_ui_request" as const,
        id: "title",
        method: "setTitle" as const,
        title: "Title",
      },
      {
        type: "extension_ui_request" as const,
        id: "text",
        method: "set_editor_text" as const,
        text: "draft",
      },
    ];
    for (const notification of notifications) value.adapter.handleNotification(notification);

    expect(extensionStatus).toHaveBeenNthCalledWith(1, { mode: "plan" });
    expect(extensionStatus).toHaveBeenNthCalledWith(2, undefined);
    expect(value.messages.filter((message) => message.type === "interaction_request")).toHaveLength(
      3,
    );
    expect(
      value.messages
        .filter((message) => message.type === "extension_event")
        .map((message) => message.event),
    ).toEqual(["status", "status", "status", "notify", "widget", "title", "editor_text"]);
  });

  it("maps streaming, retry, compaction, state, and extension error notifications", () => {
    const value = fixture();
    const notifications = [
      { type: "agent_end" as const, messages: [], willRetry: true },
      { type: "agent_end" as const, messages: [], willRetry: false },
      {
        type: "message_update" as const,
        message: {},
        assistantMessageEvent: { type: "thinking_delta", delta: "thought" },
      },
      {
        type: "message_update" as const,
        message: {},
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "args" },
      },
      {
        type: "message_update" as const,
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: 1 },
      },
      {
        type: "message_end" as const,
        message: {
          role: 1,
          content: [],
          stopReason: "stop",
          errorMessage: "error",
          usage: { input: 1 },
        },
      },
      {
        type: "tool_execution_update" as const,
        toolCallId: "tool",
        toolName: "read",
        args: { path: "a" },
        partialResult: { text: "partial" },
      },
      { type: "compaction_start" as const, reason: "manual" as const },
      {
        type: "compaction_end" as const,
        reason: "manual" as const,
        aborted: true,
        willRetry: false,
        errorMessage: "cancelled",
      },
      {
        type: "auto_retry_start" as const,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "retry",
      },
      { type: "auto_retry_end" as const, success: true, attempt: 1 },
      { type: "auto_retry_end" as const, success: false, attempt: 2 },
      { type: "thinking_level_changed" as const, level: "minimal" as const },
      { type: "extension_error" as const, extensionPath: "trusted", event: "load", error: "bad" },
      { type: "session_info_changed" as const, name: "name" },
      { type: "entry_appended" as const, entry: {} },
      { type: "queue_update" as const, steering: [], followUp: [] },
      { type: "turn_start" as const },
      { type: "turn_end" as const, message: {}, toolResults: [] },
      { type: "bash_execution_update" as const, delta: "" },
      {
        type: "summarization_retry_scheduled" as const,
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: "",
      },
      { type: "summarization_retry_attempt_start" as const, source: "branchSummary" as const },
      { type: "summarization_retry_finished" as const },
    ];
    for (const notification of notifications) value.adapter.handleNotification(notification);

    expect(value.messages).toContainEqual({ type: "run_state", state: "retrying" });
    expect(value.messages).toContainEqual({
      type: "message_delta",
      message_id: "pi-3-message-1",
      delta_kind: "thinking",
      delta: "thought",
    });
    expect(value.messages).toContainEqual({
      type: "message_delta",
      message_id: "pi-3-message-1",
      content_index: 2,
      delta_kind: "tool_call",
      delta: "args",
    });
    expect(value.messages).toContainEqual({
      type: "pi_state",
      thinkingLevel: "minimal",
    });
    expect(value.messages).toContainEqual({
      type: "extension_event",
      event: "error",
      payload: { event: "load", error: "bad" },
    });
  });

  it("uses stock Pi's distinct manual and automatic compaction boundaries", () => {
    const manual = fixture();
    manual.adapter.handleNotification({ type: "compaction_start", reason: "manual" });
    manual.adapter.handleNotification({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: false,
    });
    expect(manual.messages.at(-1)).toEqual({
      type: "run_state",
      state: "idle",
      detail: { reason: "manual", error: undefined },
    });

    const automatic = fixture();
    automatic.adapter.handleNotification({ type: "compaction_start", reason: "threshold" });
    automatic.adapter.handleNotification({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
    expect(automatic.messages).toEqual([
      {
        type: "run_state",
        state: "compacting",
        detail: { reason: "threshold" },
      },
    ]);

    automatic.adapter.handleNotification({ type: "agent_settled" });
    expect(automatic.messages.at(-1)).toEqual({ type: "run_state", state: "idle" });
  });

  it("replays history and disconnects exactly once for local or transport closure", async () => {
    const value = fixture();
    const disconnected = vi.fn();
    value.adapter.onDisconnect(disconnected);
    expect(value.adapter.isConnected()).toBe(true);
    await value.adapter.replayHistory("entry-1");
    expect(value.messages).toContainEqual({
      type: "history_snapshot",
      entries: [],
      leaf_id: null,
    });
    await value.adapter.disconnect();
    await value.adapter.disconnect();
    expect(value.transport.dispose).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(value.adapter.isConnected()).toBe(false);
    expect(value.adapter.send({ type: "abort" })).toBe(false);

    const closed = fixture();
    const closedHandler = vi.fn();
    closed.adapter.onDisconnect(closedHandler);
    closed.adapter.handleTransportClose();
    closed.adapter.handleTransportClose();
    expect(closedHandler).toHaveBeenCalledOnce();
  });
});
