/**
 * Strict boundary contract for @earendil-works/pi-coding-agent 0.82.1 RPC mode.
 *
 * Pi RPC is LF-delimited JSON, not JSON-RPC. Commands may carry an id and
 * responses echo it; streamed agent and extension UI events are uncorrelated.
 * Keep this module independent from the package's implementation types so an
 * unexpected upgrade or malformed child cannot widen the server boundary.
 */

export const PI_CODING_AGENT_VERSION = "0.82.1" as const;

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  [key: string]: unknown;
}

interface PiCommandBase {
  id?: string;
}

export type PiRpcCommand =
  | (PiCommandBase & {
      type: "prompt";
      message: string;
      images?: PiImageContent[];
      streamingBehavior?: "steer" | "followUp";
    })
  | (PiCommandBase & { type: "steer"; message: string; images?: PiImageContent[] })
  | (PiCommandBase & { type: "follow_up"; message: string; images?: PiImageContent[] })
  | (PiCommandBase & { type: "abort" })
  | (PiCommandBase & { type: "new_session"; parentSession?: string })
  | (PiCommandBase & { type: "get_state" })
  | (PiCommandBase & { type: "set_model"; provider: string; modelId: string })
  | (PiCommandBase & { type: "cycle_model" })
  | (PiCommandBase & { type: "get_available_models" })
  | (PiCommandBase & { type: "set_thinking_level"; level: PiThinkingLevel })
  | (PiCommandBase & { type: "cycle_thinking_level" })
  | (PiCommandBase & { type: "get_available_thinking_levels" })
  | (PiCommandBase & { type: "set_steering_mode"; mode: "all" | "one-at-a-time" })
  | (PiCommandBase & { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" })
  | (PiCommandBase & { type: "compact"; customInstructions?: string })
  | (PiCommandBase & { type: "set_auto_compaction"; enabled: boolean })
  | (PiCommandBase & { type: "set_auto_retry"; enabled: boolean })
  | (PiCommandBase & { type: "abort_retry" })
  | (PiCommandBase & { type: "bash"; command: string; excludeFromContext?: boolean })
  | (PiCommandBase & { type: "abort_bash" })
  | (PiCommandBase & { type: "get_session_stats" })
  | (PiCommandBase & { type: "export_html"; outputPath?: string })
  | (PiCommandBase & { type: "switch_session"; sessionPath: string })
  | (PiCommandBase & { type: "fork"; entryId: string })
  | (PiCommandBase & { type: "clone" })
  | (PiCommandBase & { type: "get_fork_messages" })
  | (PiCommandBase & { type: "get_entries"; since?: string })
  | (PiCommandBase & { type: "get_tree" })
  | (PiCommandBase & { type: "get_last_assistant_text" })
  | (PiCommandBase & { type: "set_session_name"; name: string })
  | (PiCommandBase & { type: "get_messages" })
  | (PiCommandBase & { type: "get_commands" });

export type PiRpcCommandType = PiRpcCommand["type"];

export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type PiRpcInput = PiRpcCommand | PiExtensionUiResponse;

export interface PiRpcSessionState {
  model?: PiModel;
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiRpcSuccessResponse {
  id?: string;
  type: "response";
  command: PiRpcCommandType;
  success: true;
  data?: unknown;
}

export interface PiRpcErrorResponse {
  id?: string;
  type: "response";
  command: string;
  success: false;
  error: string;
}

export type PiRpcResponse = PiRpcSuccessResponse | PiRpcErrorResponse;

export type PiExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/**
 * AgentSession events are emitted directly by rpc-mode. Event-specific fields
 * below are the stable 0.82.1 discriminators; object payloads intentionally
 * remain opaque and are normalized by PiAdapter.
 */
export type PiRpcEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: Record<string, unknown>; toolResults: unknown[] }
  | { type: "message_start"; message: Record<string, unknown> }
  | {
      type: "message_update";
      message: Record<string, unknown>;
      assistantMessageEvent: Record<string, unknown> & { type: string };
    }
  | { type: "message_end"; message: Record<string, unknown> }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: Record<string, unknown>;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: Record<string, unknown>;
      isError: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "entry_appended"; entry: Record<string, unknown> }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: PiThinkingLevel }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: Record<string, unknown>;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "summarization_retry_scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "summarization_retry_attempt_start";
      source: "branchSummary";
    }
  | {
      type: "summarization_retry_attempt_start";
      source: "compaction";
      reason: "manual" | "threshold" | "overflow";
    }
  | { type: "summarization_retry_finished" }
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    };

export type PiRpcNotification = PiRpcEvent | PiExtensionUiRequest;
export type PiRpcOutput = PiRpcResponse | PiRpcNotification;

export type PiRpcContractErrorCode =
  "invalid_command" | "invalid_input" | "invalid_output" | "invalid_json";

export class PiRpcContractError extends Error {
  readonly code: PiRpcContractErrorCode;

  constructor(code: PiRpcContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiRpcContractError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0 && !value.includes("\0");
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasValidOptionalId(value: Record<string, unknown>): boolean {
  return value.id === undefined || isNonEmptyString(value.id);
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return isString(value) && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isImage(value: unknown): value is PiImageContent {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["type", "data", "mimeType"]) &&
    value.type === "image" &&
    isNonEmptyString(value.data) &&
    isNonEmptyString(value.mimeType)
  );
}

export function isPiModel(value: unknown): value is PiModel {
  return isRecord(value) && isNonEmptyString(value.provider) && isNonEmptyString(value.id);
}

export function isPiRpcSessionState(value: unknown): value is PiRpcSessionState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "model",
      "thinkingLevel",
      "isStreaming",
      "isCompacting",
      "steeringMode",
      "followUpMode",
      "sessionFile",
      "sessionId",
      "sessionName",
      "autoCompactionEnabled",
      "messageCount",
      "pendingMessageCount",
    ]) &&
    (value.model === undefined || isPiModel(value.model)) &&
    isThinkingLevel(value.thinkingLevel) &&
    isBoolean(value.isStreaming) &&
    isBoolean(value.isCompacting) &&
    (value.steeringMode === "all" || value.steeringMode === "one-at-a-time") &&
    (value.followUpMode === "all" || value.followUpMode === "one-at-a-time") &&
    isOptionalNonEmptyString(value.sessionFile) &&
    isNonEmptyString(value.sessionId) &&
    isOptionalNonEmptyString(value.sessionName) &&
    isBoolean(value.autoCompactionEnabled) &&
    isNonNegativeInteger(value.messageCount) &&
    isNonNegativeInteger(value.pendingMessageCount)
  );
}

const NO_ARGUMENT_COMMANDS = new Set<PiRpcCommandType>([
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
]);

export function isPiRpcCommand(value: unknown): value is PiRpcCommand {
  if (!isRecord(value) || !isNonEmptyString(value.type) || !hasValidOptionalId(value)) {
    return false;
  }
  const baseKeys = ["id", "type"];
  if (NO_ARGUMENT_COMMANDS.has(value.type as PiRpcCommandType)) {
    return hasOnlyKeys(value, baseKeys);
  }
  switch (value.type) {
    case "prompt":
      return (
        hasOnlyKeys(value, [...baseKeys, "message", "images", "streamingBehavior"]) &&
        isString(value.message) &&
        (value.images === undefined ||
          (Array.isArray(value.images) && value.images.every(isImage))) &&
        (value.streamingBehavior === undefined ||
          value.streamingBehavior === "steer" ||
          value.streamingBehavior === "followUp")
      );
    case "steer":
    case "follow_up":
      return (
        hasOnlyKeys(value, [...baseKeys, "message", "images"]) &&
        isString(value.message) &&
        (value.images === undefined || (Array.isArray(value.images) && value.images.every(isImage)))
      );
    case "new_session":
      return (
        hasOnlyKeys(value, [...baseKeys, "parentSession"]) &&
        isOptionalNonEmptyString(value.parentSession)
      );
    case "set_model":
      return (
        hasOnlyKeys(value, [...baseKeys, "provider", "modelId"]) &&
        isNonEmptyString(value.provider) &&
        isNonEmptyString(value.modelId)
      );
    case "set_thinking_level":
      return hasOnlyKeys(value, [...baseKeys, "level"]) && isThinkingLevel(value.level);
    case "set_steering_mode":
    case "set_follow_up_mode":
      return (
        hasOnlyKeys(value, [...baseKeys, "mode"]) &&
        (value.mode === "all" || value.mode === "one-at-a-time")
      );
    case "compact":
      return (
        hasOnlyKeys(value, [...baseKeys, "customInstructions"]) &&
        (value.customInstructions === undefined || isString(value.customInstructions))
      );
    case "set_auto_compaction":
    case "set_auto_retry":
      return hasOnlyKeys(value, [...baseKeys, "enabled"]) && isBoolean(value.enabled);
    case "bash":
      return (
        hasOnlyKeys(value, [...baseKeys, "command", "excludeFromContext"]) &&
        isString(value.command) &&
        (value.excludeFromContext === undefined || isBoolean(value.excludeFromContext))
      );
    case "export_html":
      return (
        hasOnlyKeys(value, [...baseKeys, "outputPath"]) &&
        isOptionalNonEmptyString(value.outputPath)
      );
    case "switch_session":
      return (
        hasOnlyKeys(value, [...baseKeys, "sessionPath"]) && isNonEmptyString(value.sessionPath)
      );
    case "fork":
      return hasOnlyKeys(value, [...baseKeys, "entryId"]) && isNonEmptyString(value.entryId);
    case "get_entries":
      return hasOnlyKeys(value, [...baseKeys, "since"]) && isOptionalNonEmptyString(value.since);
    case "set_session_name":
      return hasOnlyKeys(value, [...baseKeys, "name"]) && isNonEmptyString(value.name);
    default:
      return false;
  }
}

export function parsePiRpcCommand(value: unknown): PiRpcCommand {
  if (!isPiRpcCommand(value)) {
    throw new PiRpcContractError(
      "invalid_command",
      "Pi RPC command does not match the pinned 0.82.1 contract.",
    );
  }
  return value;
}

export function isPiExtensionUiResponse(value: unknown): value is PiExtensionUiResponse {
  if (!isRecord(value) || value.type !== "extension_ui_response" || !isNonEmptyString(value.id)) {
    return false;
  }
  if (hasOnlyKeys(value, ["type", "id", "value"]) && isString(value.value)) return true;
  if (hasOnlyKeys(value, ["type", "id", "confirmed"]) && isBoolean(value.confirmed)) {
    return true;
  }
  return hasOnlyKeys(value, ["type", "id", "cancelled"]) && value.cancelled === true;
}

const NO_DATA_SUCCESS_COMMANDS = new Set<PiRpcCommandType>([
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
]);

function hasValidSuccessData(command: PiRpcCommandType, data: unknown): boolean {
  if (NO_DATA_SUCCESS_COMMANDS.has(command)) return data === undefined;
  switch (command) {
    case "get_state":
      return isPiRpcSessionState(data);
    case "get_available_models":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["models"]) &&
        Array.isArray(data.models) &&
        data.models.every(isPiModel)
      );
    case "get_available_thinking_levels":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["levels"]) &&
        Array.isArray(data.levels) &&
        data.levels.every(isThinkingLevel)
      );
    case "get_entries":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["entries", "leafId"]) &&
        isRecordArray(data.entries) &&
        (data.leafId === null || isNonEmptyString(data.leafId))
      );
    case "get_messages":
      return isRecord(data) && hasOnlyKeys(data, ["messages"]) && isRecordArray(data.messages);
    case "get_commands":
      return isRecord(data) && hasOnlyKeys(data, ["commands"]) && isRecordArray(data.commands);
    case "get_last_assistant_text":
      return (
        isRecord(data) && hasOnlyKeys(data, ["text"]) && (data.text === null || isString(data.text))
      );
    case "get_fork_messages":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["messages"]) &&
        Array.isArray(data.messages) &&
        data.messages.every(
          (message) =>
            isRecord(message) &&
            hasOnlyKeys(message, ["entryId", "text"]) &&
            isNonEmptyString(message.entryId) &&
            isString(message.text),
        )
      );
    case "new_session":
    case "switch_session":
    case "clone":
      return isRecord(data) && hasOnlyKeys(data, ["cancelled"]) && isBoolean(data.cancelled);
    case "fork":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["text", "cancelled"]) &&
        isString(data.text) &&
        isBoolean(data.cancelled)
      );
    case "cycle_model":
      return (
        data === null ||
        (isRecord(data) &&
          hasOnlyKeys(data, ["model", "thinkingLevel", "isScoped"]) &&
          isPiModel(data.model) &&
          isThinkingLevel(data.thinkingLevel) &&
          isBoolean(data.isScoped))
      );
    case "cycle_thinking_level":
      return (
        data === null ||
        (isRecord(data) && hasOnlyKeys(data, ["level"]) && isThinkingLevel(data.level))
      );
    case "set_model":
      return isPiModel(data);
    case "export_html":
      return isRecord(data) && hasOnlyKeys(data, ["path"]) && isNonEmptyString(data.path);
    case "get_tree":
      return (
        isRecord(data) &&
        hasOnlyKeys(data, ["tree", "leafId"]) &&
        Array.isArray(data.tree) &&
        (data.leafId === null || isNonEmptyString(data.leafId))
      );
    case "compact":
    case "bash":
    case "get_session_stats":
      return isRecord(data);
    default:
      return false;
  }
}

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  if (
    !isRecord(value) ||
    value.type !== "response" ||
    !hasValidOptionalId(value) ||
    !isNonEmptyString(value.command) ||
    !isBoolean(value.success)
  ) {
    return false;
  }
  if (value.success === false) {
    return (
      hasOnlyKeys(value, ["id", "type", "command", "success", "error"]) && isString(value.error)
    );
  }
  if (!isPiRpcCommand({ type: value.command })) {
    // Commands with arguments cannot be validated by the synthetic object.
    if (
      ![
        "prompt",
        "steer",
        "follow_up",
        "new_session",
        "set_model",
        "set_thinking_level",
        "set_steering_mode",
        "set_follow_up_mode",
        "compact",
        "set_auto_compaction",
        "set_auto_retry",
        "bash",
        "export_html",
        "switch_session",
        "fork",
        "get_entries",
        "set_session_name",
      ].includes(value.command)
    ) {
      return false;
    }
  }
  const command = value.command as PiRpcCommandType;
  const hasData = Object.prototype.hasOwnProperty.call(value, "data");
  return (
    hasOnlyKeys(value, ["id", "type", "command", "success", "data"]) &&
    hasValidSuccessData(command, hasData ? value.data : undefined)
  );
}

const SIMPLE_EVENT_TYPES = new Set(["agent_start", "agent_settled", "turn_start"]);

function isPiRpcEvent(value: unknown): value is PiRpcEvent {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  if (SIMPLE_EVENT_TYPES.has(value.type)) return hasOnlyKeys(value, ["type"]);
  switch (value.type) {
    case "agent_end":
      return Array.isArray(value.messages) && isBoolean(value.willRetry);
    case "turn_end":
      return isRecord(value.message) && Array.isArray(value.toolResults);
    case "message_start":
    case "message_end":
      return isRecord(value.message);
    case "message_update":
      return (
        isRecord(value.message) &&
        isRecord(value.assistantMessageEvent) &&
        isNonEmptyString(value.assistantMessageEvent.type)
      );
    case "bash_execution_update":
      return (value.id === undefined || isNonEmptyString(value.id)) && isString(value.delta);
    case "tool_execution_start":
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        isRecord(value.args)
      );
    case "tool_execution_update":
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        isRecord(value.args) &&
        isRecord(value.partialResult)
      );
    case "tool_execution_end":
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        isRecord(value.result) &&
        isBoolean(value.isError)
      );
    case "queue_update":
      return isStringArray(value.steering) && isStringArray(value.followUp);
    case "compaction_start":
      return (
        value.reason === "manual" || value.reason === "threshold" || value.reason === "overflow"
      );
    case "entry_appended":
      return isRecord(value.entry);
    case "session_info_changed":
      return value.name === undefined || isString(value.name);
    case "thinking_level_changed":
      return isThinkingLevel(value.level);
    case "compaction_end":
      return (
        (value.reason === "manual" ||
          value.reason === "threshold" ||
          value.reason === "overflow") &&
        (value.result === undefined || isRecord(value.result)) &&
        isBoolean(value.aborted) &&
        isBoolean(value.willRetry) &&
        (value.errorMessage === undefined || isString(value.errorMessage))
      );
    case "auto_retry_start":
      return (
        isNonNegativeInteger(value.attempt) &&
        isNonNegativeInteger(value.maxAttempts) &&
        isNonNegativeInteger(value.delayMs) &&
        isString(value.errorMessage)
      );
    case "auto_retry_end":
      return (
        isBoolean(value.success) &&
        isNonNegativeInteger(value.attempt) &&
        (value.finalError === undefined || isString(value.finalError))
      );
    case "summarization_retry_scheduled":
      return (
        isNonNegativeInteger(value.attempt) &&
        isNonNegativeInteger(value.maxAttempts) &&
        isNonNegativeInteger(value.delayMs) &&
        isString(value.errorMessage)
      );
    case "summarization_retry_attempt_start":
      return (
        value.source === "branchSummary" ||
        (value.source === "compaction" &&
          (value.reason === "manual" ||
            value.reason === "threshold" ||
            value.reason === "overflow"))
      );
    case "summarization_retry_finished":
      return true;
    case "extension_error":
      return (
        isNonEmptyString(value.extensionPath) &&
        isNonEmptyString(value.event) &&
        isString(value.error)
      );
    default:
      return false;
  }
}

const EXTENSION_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

function isOptionalTimeout(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isPiExtensionUiRequest(value: unknown): value is PiExtensionUiRequest {
  if (
    !isRecord(value) ||
    value.type !== "extension_ui_request" ||
    !isNonEmptyString(value.id) ||
    !isString(value.method) ||
    !EXTENSION_UI_METHODS.has(value.method)
  ) {
    return false;
  }
  switch (value.method) {
    case "select":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "title", "options", "timeout"]) &&
        isString(value.title) &&
        isStringArray(value.options) &&
        isOptionalTimeout(value.timeout)
      );
    case "confirm":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "title", "message", "timeout"]) &&
        isString(value.title) &&
        isString(value.message) &&
        isOptionalTimeout(value.timeout)
      );
    case "input":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "title", "placeholder", "timeout"]) &&
        isString(value.title) &&
        (value.placeholder === undefined || isString(value.placeholder)) &&
        isOptionalTimeout(value.timeout)
      );
    case "editor":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "title", "prefill"]) &&
        isString(value.title) &&
        (value.prefill === undefined || isString(value.prefill))
      );
    case "notify":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "message", "notifyType"]) &&
        isString(value.message) &&
        (value.notifyType === undefined ||
          value.notifyType === "info" ||
          value.notifyType === "warning" ||
          value.notifyType === "error")
      );
    case "setStatus":
      return (
        hasOnlyKeys(value, ["type", "id", "method", "statusKey", "statusText"]) &&
        isNonEmptyString(value.statusKey) &&
        (value.statusText === undefined || isString(value.statusText))
      );
    case "setWidget":
      return (
        hasOnlyKeys(value, [
          "type",
          "id",
          "method",
          "widgetKey",
          "widgetLines",
          "widgetPlacement",
        ]) &&
        isNonEmptyString(value.widgetKey) &&
        (value.widgetLines === undefined || isStringArray(value.widgetLines)) &&
        (value.widgetPlacement === undefined ||
          value.widgetPlacement === "aboveEditor" ||
          value.widgetPlacement === "belowEditor")
      );
    case "setTitle":
      return hasOnlyKeys(value, ["type", "id", "method", "title"]) && isString(value.title);
    case "set_editor_text":
      return hasOnlyKeys(value, ["type", "id", "method", "text"]) && isString(value.text);
    default:
      return false;
  }
}

export function isPiRpcOutput(value: unknown): value is PiRpcOutput {
  return isPiRpcResponse(value) || isPiExtensionUiRequest(value) || isPiRpcEvent(value);
}

export function parsePiRpcOutput(value: unknown): PiRpcOutput {
  if (!isPiRpcOutput(value)) {
    throw new PiRpcContractError(
      "invalid_output",
      "Pi RPC output does not match the pinned 0.82.1 contract.",
    );
  }
  return value;
}

export function parsePiRpcOutputJson(line: string): PiRpcOutput {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new PiRpcContractError("invalid_json", "Pi RPC emitted invalid JSON.", {
      cause: error,
    });
  }
  return parsePiRpcOutput(value);
}

export function serializePiRpcInput(input: PiRpcInput): string {
  if (!isPiRpcCommand(input) && !isPiExtensionUiResponse(input)) {
    throw new PiRpcContractError(
      "invalid_input",
      "Pi RPC input does not match the pinned 0.82.1 contract.",
    );
  }
  return `${JSON.stringify(input)}\n`;
}
