import { describe, expect, it } from "vitest";
import {
  isPiExtensionUiResponse,
  isPiRpcCommand,
  isPiRpcOutput,
  isPiRpcResponse,
  isPiRpcSessionState,
  parsePiRpcCommand,
  parsePiRpcOutput,
  parsePiRpcOutputJson,
  serializePiRpcInput,
} from "./pi-rpc-contract.js";

const state = {
  sessionId: "pi-session",
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

describe("Pi 0.82.1 RPC contract", () => {
  it("accepts pinned commands and rejects unknown or extra keys", () => {
    expect(isPiRpcCommand({ type: "get_state", id: "r1" })).toBe(true);
    expect(
      isPiRpcCommand({
        type: "prompt",
        message: "hello",
        streamingBehavior: "followUp",
      }),
    ).toBe(true);
    expect(isPiRpcCommand({ type: "login" })).toBe(false);
    expect(isPiRpcCommand({ type: "get_state", secret: "unexpected" })).toBe(false);
    expect(isPiRpcCommand({ type: "set_thinking_level", level: "ultra" })).toBe(false);
  });

  it("serializes only valid inputs with one LF terminator", () => {
    expect(serializePiRpcInput({ type: "abort", id: "r1" })).toBe('{"type":"abort","id":"r1"}\n');
    expect(() => serializePiRpcInput({ type: "get_state", extra: true } as never)).toThrow(
      /pinned/,
    );
  });

  it("validates correlated responses and extension UI requests", () => {
    expect(
      isPiRpcOutput({
        id: "r1",
        type: "response",
        command: "get_state",
        success: true,
        data: state,
      }),
    ).toBe(true);
    expect(
      isPiRpcOutput({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Choose",
        options: ["a", "b"],
      }),
    ).toBe(true);
    expect(
      isPiRpcOutput({
        id: "r1",
        type: "response",
        command: "get_state",
        success: true,
        data: { ...state, unknown: true },
      }),
    ).toBe(false);
  });

  it("parses U+2028 as ordinary JSON data and rejects malformed output", () => {
    expect(
      parsePiRpcOutputJson(
        '{"type":"extension_error","extensionPath":"x","event":"e","error":"left right"}',
      ),
    ).toMatchObject({ error: "left right" });
    expect(() => parsePiRpcOutputJson("{")).toThrow(/invalid JSON/);
    expect(() => parsePiRpcOutputJson('{"type":"claude_event"}')).toThrow(/0.82.1/);
  });

  it("accepts every pinned command shape and rejects malformed arguments", () => {
    const commands: unknown[] = [
      {
        type: "prompt",
        message: "",
        images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      },
      { type: "steer", message: "left", images: [] },
      { type: "follow_up", message: "right" },
      { type: "new_session" },
      { type: "new_session", parentSession: "parent.jsonl" },
      { type: "set_model", provider: "openai", modelId: "gpt-5" },
      { type: "set_thinking_level", level: "max" },
      { type: "set_steering_mode", mode: "one-at-a-time" },
      { type: "set_follow_up_mode", mode: "all" },
      { type: "compact" },
      { type: "compact", customInstructions: "" },
      { type: "set_auto_compaction", enabled: false },
      { type: "set_auto_retry", enabled: true },
      { type: "bash", command: "pwd", excludeFromContext: true },
      { type: "export_html" },
      { type: "export_html", outputPath: "transcript.html" },
      { type: "switch_session", sessionPath: "session.jsonl" },
      { type: "fork", entryId: "entry-1" },
      { type: "get_entries" },
      { type: "get_entries", since: "entry-1" },
      { type: "set_session_name", name: "Named" },
    ];
    const noArgumentCommands = [
      "abort",
      "get_state",
      "cycle_model",
      "get_available_models",
      "cycle_thinking_level",
      "get_available_thinking_levels",
      "abort_retry",
      "abort_bash",
      "get_session_stats",
      "clone",
      "get_fork_messages",
      "get_tree",
      "get_last_assistant_text",
      "get_messages",
      "get_commands",
    ].map((type) => ({ type }));

    for (const command of [...commands, ...noArgumentCommands]) {
      expect(isPiRpcCommand(command), JSON.stringify(command)).toBe(true);
      expect(parsePiRpcCommand(command)).toBe(command);
    }

    for (const invalid of [
      null,
      [],
      { type: "" },
      { type: "get_state", id: "" },
      { type: "prompt", message: 1 },
      { type: "prompt", message: "x", images: [{ type: "image", data: "", mimeType: "x" }] },
      { type: "prompt", message: "x", streamingBehavior: "later" },
      { type: "steer", message: "x", images: [{}] },
      { type: "new_session", parentSession: "" },
      { type: "set_model", provider: "", modelId: "x" },
      { type: "set_thinking_level", level: "ultra" },
      { type: "set_steering_mode", mode: "some" },
      { type: "compact", customInstructions: 1 },
      { type: "set_auto_retry", enabled: "yes" },
      { type: "bash", command: 1 },
      { type: "export_html", outputPath: "" },
      { type: "switch_session", sessionPath: "" },
      { type: "fork", entryId: "" },
      { type: "get_entries", since: "" },
      { type: "set_session_name", name: "" },
      { type: "not_real" },
    ]) {
      expect(isPiRpcCommand(invalid), JSON.stringify(invalid)).toBe(false);
    }
    expect(() => parsePiRpcCommand({ type: "not_real" })).toThrow(/pinned/);
  });

  it("validates every extension response and UI request shape", () => {
    for (const response of [
      { type: "extension_ui_response", id: "ui-1", value: "" },
      { type: "extension_ui_response", id: "ui-1", confirmed: false },
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
    ]) {
      expect(isPiExtensionUiResponse(response)).toBe(true);
      expect(serializePiRpcInput(response as never)).toBe(`${JSON.stringify(response)}\n`);
    }
    for (const invalid of [
      { type: "extension_ui_response", id: "", value: "x" },
      { type: "extension_ui_response", id: "ui-1", confirmed: "yes" },
      { type: "extension_ui_response", id: "ui-1", cancelled: false },
      { type: "extension_ui_response", id: "ui-1", value: "x", extra: true },
    ]) {
      expect(isPiExtensionUiResponse(invalid)).toBe(false);
    }

    const requests = [
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Choose",
        options: ["a"],
        timeout: 1,
      },
      {
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Confirm",
        message: "Proceed?",
        timeout: 2,
      },
      {
        type: "extension_ui_request",
        id: "ui-3",
        method: "input",
        title: "Input",
        placeholder: "value",
      },
      {
        type: "extension_ui_request",
        id: "ui-4",
        method: "editor",
        title: "Edit",
        prefill: "draft",
      },
      {
        type: "extension_ui_request",
        id: "ui-5",
        method: "notify",
        message: "Done",
        notifyType: "warning",
      },
      {
        type: "extension_ui_request",
        id: "ui-6",
        method: "setStatus",
        statusKey: "piwork.extension",
        statusText: "ready",
      },
      {
        type: "extension_ui_request",
        id: "ui-7",
        method: "setWidget",
        widgetKey: "todo",
        widgetLines: ["one"],
        widgetPlacement: "belowEditor",
      },
      { type: "extension_ui_request", id: "ui-8", method: "setTitle", title: "Title" },
      { type: "extension_ui_request", id: "ui-9", method: "set_editor_text", text: "Text" },
    ];
    for (const request of requests)
      expect(isPiRpcOutput(request), JSON.stringify(request)).toBe(true);

    for (const invalid of [
      { type: "extension_ui_request", id: "", method: "select", title: "", options: [] },
      { type: "extension_ui_request", id: "x", method: "unknown" },
      {
        type: "extension_ui_request",
        id: "x",
        method: "select",
        title: "",
        options: [1],
      },
      {
        type: "extension_ui_request",
        id: "x",
        method: "confirm",
        title: "",
        message: "",
        timeout: 0,
      },
      { type: "extension_ui_request", id: "x", method: "input", title: "", placeholder: 1 },
      { type: "extension_ui_request", id: "x", method: "editor", title: "", prefill: 1 },
      { type: "extension_ui_request", id: "x", method: "notify", message: "", notifyType: "fatal" },
      { type: "extension_ui_request", id: "x", method: "setStatus", statusKey: "" },
      {
        type: "extension_ui_request",
        id: "x",
        method: "setWidget",
        widgetKey: "",
        widgetPlacement: "middle",
      },
      { type: "extension_ui_request", id: "x", method: "setTitle", title: 1 },
      { type: "extension_ui_request", id: "x", method: "set_editor_text", text: 1 },
    ]) {
      expect(isPiRpcOutput(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("validates all successful and failed response payloads", () => {
    expect(isPiRpcSessionState(state)).toBe(true);
    expect(isPiRpcSessionState({ ...state, messageCount: -1 })).toBe(false);
    const model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
    const successes: Array<[string, unknown, boolean?]> = [
      ["get_state", state],
      ["get_available_models", { models: [model] }],
      ["get_available_thinking_levels", { levels: ["off", "xhigh"] }],
      ["get_entries", { entries: [{ type: "message" }], leafId: null }],
      ["get_messages", { messages: [{ role: "user" }] }],
      ["get_commands", { commands: [{ name: "piwork-plan" }] }],
      ["get_last_assistant_text", { text: null }],
      ["get_fork_messages", { messages: [{ entryId: "one", text: "" }] }],
      ["new_session", { cancelled: false }],
      ["switch_session", { cancelled: true }],
      ["clone", { cancelled: false }],
      ["fork", { text: "forked", cancelled: false }],
      ["cycle_model", { model, thinkingLevel: "high", isScoped: true }],
      ["cycle_thinking_level", { level: "minimal" }],
      ["set_model", model],
      ["export_html", { path: "out.html" }],
      ["get_tree", { tree: [], leafId: "leaf" }],
      ["compact", {}],
      ["bash", { output: "ok" }],
      ["get_session_stats", { tokens: 1 }],
    ];
    for (const [command, data] of successes) {
      expect(
        isPiRpcResponse({ id: "r", type: "response", command, success: true, data }),
        command,
      ).toBe(true);
    }
    expect(
      isPiRpcResponse({ type: "response", command: "cycle_model", success: true, data: null }),
    ).toBe(true);
    expect(
      isPiRpcResponse({
        type: "response",
        command: "cycle_thinking_level",
        success: true,
        data: null,
      }),
    ).toBe(true);
    for (const command of [
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "set_thinking_level",
      "set_steering_mode",
      "set_follow_up_mode",
      "set_auto_compaction",
      "set_auto_retry",
      "abort_retry",
      "abort_bash",
      "set_session_name",
    ]) {
      expect(isPiRpcResponse({ type: "response", command, success: true }), command).toBe(true);
    }
    expect(
      isPiRpcResponse({
        id: "r",
        type: "response",
        command: "anything",
        success: false,
        error: "failed",
      }),
    ).toBe(true);

    for (const invalid of [
      null,
      { type: "response", command: "get_state", success: "yes" },
      { type: "response", command: "", success: false, error: "" },
      { type: "response", command: "unknown", success: true },
      { type: "response", command: "get_state", success: true, data: {} },
      { type: "response", command: "get_messages", success: true, data: { messages: [1] } },
      { type: "response", command: "get_fork_messages", success: true, data: { messages: [{}] } },
      { type: "response", command: "fork", success: true, data: { cancelled: false } },
      { type: "response", command: "cycle_model", success: true, data: {} },
      { type: "response", command: "get_tree", success: true, data: { tree: [], leafId: "" } },
      { type: "response", command: "abort", success: true, data: {} },
    ]) {
      expect(isPiRpcResponse(invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  it("validates the complete pinned notification event surface", () => {
    const events = [
      { type: "agent_start" },
      { type: "agent_settled" },
      { type: "turn_start" },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "turn_end", message: {}, toolResults: [] },
      { type: "message_start", message: {} },
      { type: "message_end", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta" },
      },
      { type: "bash_execution_update", delta: "chunk" },
      { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} },
      {
        type: "tool_execution_update",
        toolCallId: "t",
        toolName: "read",
        args: {},
        partialResult: {},
      },
      {
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "read",
        result: {},
        isError: false,
      },
      { type: "queue_update", steering: [], followUp: ["next"] },
      { type: "compaction_start", reason: "threshold" },
      { type: "entry_appended", entry: {} },
      { type: "session_info_changed" },
      { type: "thinking_level_changed", level: "low" },
      {
        type: "compaction_end",
        reason: "overflow",
        result: {},
        aborted: false,
        willRetry: true,
        errorMessage: "",
      },
      {
        type: "auto_retry_start",
        attempt: 0,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: "retry",
      },
      { type: "auto_retry_end", success: true, attempt: 1 },
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1,
        errorMessage: "retry",
      },
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      { type: "summarization_retry_attempt_start", source: "compaction", reason: "manual" },
      { type: "summarization_retry_finished" },
      { type: "extension_error", extensionPath: "trusted", event: "load", error: "" },
    ];
    for (const event of events) {
      expect(isPiRpcOutput(event), JSON.stringify(event)).toBe(true);
      expect(parsePiRpcOutput(event)).toBe(event);
    }

    for (const invalid of [
      { type: "agent_start", extra: true },
      { type: "agent_end", messages: {}, willRetry: false },
      { type: "turn_end", message: [], toolResults: [] },
      { type: "message_update", message: {}, assistantMessageEvent: {} },
      { type: "bash_execution_update", id: "", delta: "" },
      { type: "tool_execution_start", toolCallId: "", toolName: "read", args: {} },
      { type: "queue_update", steering: [1], followUp: [] },
      { type: "compaction_start", reason: "other" },
      { type: "auto_retry_start", attempt: -1, maxAttempts: 1, delayMs: 1, errorMessage: "" },
      { type: "auto_retry_end", success: true, attempt: -1 },
      { type: "summarization_retry_attempt_start", source: "compaction", reason: "other" },
      { type: "extension_error", extensionPath: "", event: "load", error: "" },
    ]) {
      expect(isPiRpcOutput(invalid), JSON.stringify(invalid)).toBe(false);
    }
    expect(() => parsePiRpcOutput({ type: "unknown" })).toThrow(/pinned/);
  });
});
