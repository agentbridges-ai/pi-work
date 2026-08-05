import type {
  BrowserIncomingMessage,
  InteractionRequest,
  PiHistoryEvent,
  PiModelRef,
  PiRunState,
  SessionState,
  ThinkingLevel,
  UserSpaceOperation,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const RUN_STATES = new Set<PiRunState>([
  "starting",
  "ready",
  "running",
  "awaiting_interaction",
  "compacting",
  "reconnecting",
  "disconnected",
  "stopped",
  "error",
]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const USER_SPACE_OPERATIONS = new Set<UserSpaceOperation>([
  "list_mounts",
  "list_dir",
  "read_file",
  "search_paths",
  "search",
  "glob",
  "shell_exec",
  "create_entry",
  "rename_entry",
  "copy_entry",
  "copy_entries",
  "duplicate_entry",
  "move_entries",
  "write_file",
  "replace_text",
  "delete_entry",
]);
const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPiModelRef(value: unknown): value is PiModelRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["key", "provider", "modelId"])) &&
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.modelId)
  );
}

function isMcpServer(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.name) ||
    typeof value.enabled !== "boolean" ||
    !["connected", "failed", "disabled", "connecting"].includes(String(value.status)) ||
    !isRecord(value.config) ||
    !["stdio", "sse", "streamable-http"].includes(String(value.config.type)) ||
    !isString(value.scope)
  ) {
    return false;
  }
  if (!hasOnlyKeys(value.config, new Set(["type", "command", "args", "url", "timeout"]))) {
    return false;
  }
  if (value.config.type === "stdio") {
    if (!isNonEmptyString(value.config.command)) return false;
    if (value.config.args !== undefined && !isStringArray(value.config.args)) return false;
  } else if (!isNonEmptyString(value.config.url)) {
    return false;
  }
  if (
    value.config.timeout !== undefined &&
    (typeof value.config.timeout !== "number" ||
      !Number.isFinite(value.config.timeout) ||
      value.config.timeout < 0)
  ) {
    return false;
  }
  return (
    (value.error === undefined || isString(value.error)) &&
    (value.tools === undefined ||
      (Array.isArray(value.tools) &&
        value.tools.every(
          (tool) =>
            isRecord(tool) &&
            isNonEmptyString(tool.name) &&
            isRecord(tool.annotations) &&
            typeof tool.annotations.readOnly === "boolean",
        )))
  );
}

function isPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return isString(value.text);
  if (value.type === "thinking") return isString(value.thinking);
  return value.type === "image" && isNonEmptyString(value.mediaType) && isString(value.data);
}

function isAgentMessage(value: Record<string, unknown>): boolean {
  if (
    !isGeneration(value.generation) ||
    !isRecord(value.message) ||
    !isNonEmptyString(value.message.id) ||
    !["user", "assistant", "system"].includes(String(value.message.role)) ||
    !Array.isArray(value.message.content) ||
    !value.message.content.every(isPart) ||
    typeof value.message.timestamp !== "number"
  )
    return false;
  return (
    (value.message.displayContent === undefined ||
      (Array.isArray(value.message.displayContent) &&
        value.message.displayContent.every(isPart))) &&
    (value.message.model === undefined || isPiModelRef(value.message.model))
  );
}

function isDelta(value: Record<string, unknown>): boolean {
  return (
    isGeneration(value.generation) &&
    isNonEmptyString(value.messageId) &&
    value.role === "assistant" &&
    isRecord(value.delta) &&
    ["text", "thinking", "tool_arguments"].includes(String(value.delta.kind)) &&
    isGeneration(value.delta.contentIndex) &&
    isString(value.delta.delta) &&
    (value.delta.toolCallId === undefined || isNonEmptyString(value.delta.toolCallId))
  );
}

function isTodoEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, new Set(["id", "content", "status", "activeForm"])) &&
    isNonEmptyString(value.id) &&
    isString(value.content) &&
    ["pending", "in_progress", "completed"].includes(String(value.status)) &&
    (value.activeForm === undefined || isString(value.activeForm))
  );
}

function isTaskExecution(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set(["taskId", "name", "description", "execution", "status", "depth", "progress"]),
    ) &&
    isNonEmptyString(value.taskId) &&
    isNonEmptyString(value.name) &&
    (value.description === undefined || isString(value.description)) &&
    (value.execution === "foreground" || value.execution === "background") &&
    ["running", "completed", "failed", "stopped"].includes(String(value.status)) &&
    isGeneration(value.depth) &&
    (value.progress === undefined || isString(value.progress))
  );
}

function isToolExecution(value: Record<string, unknown>): boolean {
  return (
    isGeneration(value.generation) &&
    isNonEmptyString(value.toolCallId) &&
    isNonEmptyString(value.toolName) &&
    ["started", "running", "completed", "failed", "cancelled"].includes(String(value.status)) &&
    typeof value.timestamp === "number" &&
    (value.input === undefined || isRecord(value.input)) &&
    (value.error === undefined || isString(value.error)) &&
    (value.elapsedMs === undefined ||
      (typeof value.elapsedMs === "number" && value.elapsedMs >= 0)) &&
    (value.progress === undefined || isString(value.progress)) &&
    (value.todos === undefined || (Array.isArray(value.todos) && value.todos.every(isTodoEntry))) &&
    (value.task === undefined || isTaskExecution(value.task))
  );
}

function isInteractionRequest(value: unknown): value is InteractionRequest {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.toolCallId))
    return false;
  if (value.kind === "ask") {
    return (
      Array.isArray(value.questions) &&
      value.questions.length > 0 &&
      value.questions.length <= 4 &&
      value.questions.every(
        (question) =>
          isRecord(question) &&
          isNonEmptyString(question.id) &&
          isNonEmptyString(question.question) &&
          (question.header === undefined || isString(question.header)) &&
          typeof question.allowMultiple === "boolean" &&
          typeof question.allowFreeText === "boolean" &&
          Array.isArray(question.options) &&
          question.options.length <= 4 &&
          question.options.every(
            (option) =>
              isRecord(option) &&
              isNonEmptyString(option.id) &&
              isString(option.label) &&
              (option.description === undefined || isString(option.description)),
          ),
      )
    );
  }
  return value.kind === "propose_plan" && isString(value.plan);
}

function isInteractionResponse(value: Record<string, unknown>): boolean {
  if (
    !isGeneration(value.generation) ||
    !isNonEmptyString(value.requestId) ||
    !["ask", "propose_plan"].includes(String(value.kind)) ||
    !["submitted", "cancelled", "timed_out"].includes(String(value.status))
  )
    return false;
  if (value.kind === "ask") {
    return (
      value.answers === undefined ||
      (Array.isArray(value.answers) &&
        value.answers.length <= 4 &&
        value.answers.every(
          (answer) =>
            isRecord(answer) &&
            isNonEmptyString(answer.questionId) &&
            Array.isArray(answer.selectedOptionIds) &&
            answer.selectedOptionIds.length <= 4 &&
            answer.selectedOptionIds.every(isString) &&
            (answer.freeText === undefined || isString(answer.freeText)),
        ))
    );
  }
  return (
    (value.decision === undefined ||
      ["execute", "continue_planning", "refine"].includes(String(value.decision))) &&
    (value.refinement === undefined || isString(value.refinement))
  );
}

function isRunState(value: Record<string, unknown>): boolean {
  return (
    isGeneration(value.generation) &&
    RUN_STATES.has(value.state as PiRunState) &&
    typeof value.timestamp === "number"
  );
}

function isHistoryEvent(value: unknown): value is PiHistoryEvent {
  if (!isRecord(value)) return false;
  if (value.type === "agent_message") return isAgentMessage(value);
  if (value.type === "tool_execution") return isToolExecution(value);
  if (value.type === "interaction_request")
    return (
      isGeneration(value.generation) &&
      isInteractionRequest(value.request) &&
      typeof value.timestamp === "number"
    );
  if (value.type === "interaction_response") return isInteractionResponse(value);
  return value.type === "run_state" && isRunState(value);
}

function isSnapshot(value: Record<string, unknown>): boolean {
  return (
    isGeneration(value.generation) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        isNonEmptyString(entry.id) &&
        typeof entry.timestamp === "number" &&
        (entry.parentId === undefined || entry.parentId === null || isString(entry.parentId)) &&
        isHistoryEvent(entry.event),
    ) &&
    isGeneration(value.total) &&
    isGeneration(value.cursor) &&
    isGeneration(value.nextCursor) &&
    typeof value.hasMore === "boolean" &&
    ["initial", "page", "gap", "recovery"].includes(String(value.reason))
  );
}

function isSessionState(value: unknown): value is SessionState {
  return (
    isRecord(value) &&
    hasOnlyKeys(
      value,
      new Set([
        "sessionId",
        "backendType",
        "transport",
        "piVersion",
        "model",
        "thinkingLevel",
        "mode",
        "cwd",
        "tools",
        "commands",
        "skills",
        "mcpServers",
        "usage",
        "runState",
        "isCompacting",
        "generation",
        "userSpace",
        "userSpaces",
      ]),
    ) &&
    isNonEmptyString(value.sessionId) &&
    value.backendType === "pi" &&
    value.transport === "pi-rpc" &&
    isNonEmptyString(value.piVersion) &&
    isPiModelRef(value.model) &&
    THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel) &&
    (value.mode === "agent" || value.mode === "plan") &&
    isString(value.cwd) &&
    isStringArray(value.tools) &&
    isStringArray(value.commands) &&
    isStringArray(value.skills) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(isMcpServer) &&
    isRecord(value.usage) &&
    RUN_STATES.has(value.runState as PiRunState) &&
    typeof value.isCompacting === "boolean" &&
    isGeneration(value.generation)
  );
}

const SESSION_UPDATE_KEYS = new Set([
  "piVersion",
  "model",
  "thinkingLevel",
  "mode",
  "cwd",
  "tools",
  "commands",
  "skills",
  "mcpServers",
  "usage",
  "runState",
  "isCompacting",
  "generation",
  "userSpace",
  "userSpaces",
]);

function isSessionUpdate(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, SESSION_UPDATE_KEYS)) return false;
  return (
    (value.piVersion === undefined || isNonEmptyString(value.piVersion)) &&
    (value.model === undefined || isPiModelRef(value.model)) &&
    (value.thinkingLevel === undefined ||
      THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel)) &&
    (value.mode === undefined || value.mode === "agent" || value.mode === "plan") &&
    (value.cwd === undefined || isString(value.cwd)) &&
    (value.tools === undefined || isStringArray(value.tools)) &&
    (value.commands === undefined || isStringArray(value.commands)) &&
    (value.skills === undefined || isStringArray(value.skills)) &&
    (value.mcpServers === undefined ||
      (Array.isArray(value.mcpServers) && value.mcpServers.every(isMcpServer))) &&
    (value.usage === undefined || isRecord(value.usage)) &&
    (value.runState === undefined || RUN_STATES.has(value.runState as PiRunState)) &&
    (value.isCompacting === undefined || typeof value.isCompacting === "boolean") &&
    (value.generation === undefined || isGeneration(value.generation)) &&
    (value.userSpace === undefined || value.userSpace === null || isRecord(value.userSpace)) &&
    (value.userSpaces === undefined || Array.isArray(value.userSpaces))
  );
}

export function isBrowserIncomingMessage(
  value: unknown,
  allowReplay = true,
): value is BrowserIncomingMessage {
  if (
    !isRecord(value) ||
    !isString(value.type) ||
    (value.seq !== undefined && !isGeneration(value.seq))
  )
    return false;
  switch (value.type) {
    case "session_init":
      return isSessionState(value.session);
    case "session_update":
      return isSessionUpdate(value.session);
    case "agent_message":
      return isAgentMessage(value);
    case "agent_message_accepted":
      return isGeneration(value.generation) && isNonEmptyString(value.clientMsgId);
    case "message_delta":
      return isDelta(value);
    case "tool_execution":
      return isToolExecution(value);
    case "interaction_request":
      return (
        isGeneration(value.generation) &&
        isInteractionRequest(value.request) &&
        typeof value.timestamp === "number"
      );
    case "interaction_snapshot":
      return (
        isGeneration(value.generation) &&
        Array.isArray(value.requests) &&
        value.requests.every(isInteractionRequest)
      );
    case "interaction_response":
      return isInteractionResponse(value);
    case "run_state":
      return isRunState(value);
    case "history_snapshot":
      return isSnapshot(value);
    case "error":
      return isString(value.message);
    case "event_replay":
      return (
        allowReplay &&
        Array.isArray(value.events) &&
        value.events.every(
          (event) =>
            isRecord(event) &&
            isGeneration(event.seq) &&
            isBrowserIncomingMessage(event.message, false),
        )
      );
    case "session_name_update":
      return isString(value.name);
    case "session_lifecycle_update":
      return (
        isNonEmptyString(value.sessionId) &&
        (value.lifecycleState === "enabled" || value.lifecycleState === "closed")
      );
    case "mcp_status":
      return Array.isArray(value.servers) && value.servers.every(isMcpServer);
    case "user_space_request":
    case "user_space_mutation_request":
      return (
        isNonEmptyString(value.request_id) &&
        USER_SPACE_OPERATIONS.has(value.operation as UserSpaceOperation) &&
        isRecord(value.input) &&
        (value.type === "user_space_mutation_request"
          ? value.requires_commit === true
          : value.requires_commit === undefined || typeof value.requires_commit === "boolean")
      );
    case "user_space_mutation_authorization":
      return (
        isNonEmptyString(value.request_id) &&
        typeof value.ok === "boolean" &&
        (value.commit_lease === undefined || isString(value.commit_lease)) &&
        (value.runtime_epoch === undefined || isString(value.runtime_epoch)) &&
        (value.error === undefined || isString(value.error))
      );
    case "user_space_blob_checkout_request":
      return (
        isNonEmptyString(value.transfer_id) &&
        isNonEmptyString(value.mountId) &&
        isString(value.path) &&
        isNonEmptyString(value.uploadUrl) &&
        isNonEmptyString(value.completeUrl) &&
        typeof value.maxBytes === "number"
      );
    case "user_space_blob_checkin_request":
      return (
        isNonEmptyString(value.transfer_id) &&
        isNonEmptyString(value.mountId) &&
        isString(value.path) &&
        typeof value.size === "number" &&
        isString(value.hash) &&
        isNonEmptyString(value.downloadUrl) &&
        isNonEmptyString(value.commitUrl) &&
        isNonEmptyString(value.completeUrl)
      );
    case "onlyoffice_request":
      return (
        isNonEmptyString(value.request_id) &&
        isRecord(value.operation) &&
        isNonEmptyString(value.operation.type) &&
        (value.target === undefined || isRecord(value.target))
      );
    default:
      return false;
  }
}
