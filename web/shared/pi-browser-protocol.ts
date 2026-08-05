import type {
  OnlyOfficeBrowserRequest,
  OnlyOfficeBrowserResponse,
  OnlyOfficeBrowserStatus,
} from "./onlyoffice.js";

/** Pi RPC terminates server-side; browsers receive only this product protocol. */
export type BackendType = "pi";
export type AgentTransport = "pi-rpc";

export interface PiModelRef {
  key: string;
  provider: string;
  modelId: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentMode = "agent" | "plan";

export interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  turns?: number;
}

export type PiRunState =
  | "starting"
  | "ready"
  | "running"
  | "settling"
  | "awaiting_interaction"
  | "compacting"
  | "reconnecting"
  | "disconnected"
  | "stopped"
  | "error";

export interface McpServerConfig {
  type: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  timeout?: number;
}

export interface McpServerDetail {
  name: string;
  enabled: boolean;
  status: "connected" | "failed" | "disabled" | "connecting";
  serverInfo?: unknown;
  error?: string;
  config: McpServerConfig;
  scope: string;
  tools?: Array<{
    name: string;
    annotations: {
      readOnly: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }>;
}

export interface SessionState {
  sessionId: string;
  backendType: BackendType;
  transport: AgentTransport;
  piVersion: string;
  model: PiModelRef;
  thinkingLevel: ThinkingLevel;
  mode: AgentMode;
  cwd: string;
  tools: string[];
  commands: string[];
  skills: string[];
  mcpServers: McpServerDetail[];
  usage: PiUsage;
  runState: PiRunState;
  isCompacting: boolean;
  generation: number;
  userSpace?: ActiveUserSpace | null;
  userSpaces?: UserSpaceMount[];
}

export interface PiTextPart {
  type: "text";
  text: string;
}
export interface PiThinkingPart {
  type: "thinking";
  thinking: string;
}
export interface PiImagePart {
  type: "image";
  mediaType: string;
  data: string;
}
export type PiMessagePart = PiTextPart | PiThinkingPart | PiImagePart;

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: PiMessagePart[];
  displayContent?: PiMessagePart[];
  timestamp: number;
  model?: PiModelRef;
  parentToolCallId?: string | null;
  stopReason?: string | null;
  /** Provider/runtime error attached to a terminal assistant message. */
  error?: string;
}

export interface AgentMessageEvent {
  type: "agent_message";
  generation: number;
  message: AgentMessage;
}

export interface AgentMessageAcceptedEvent {
  type: "agent_message_accepted";
  generation: number;
  clientMsgId: string;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  generation: number;
  messageId: string;
  role: "assistant";
  delta: {
    kind: "text" | "thinking" | "tool_arguments";
    contentIndex: number;
    delta: string;
    toolCallId?: string;
  };
  usage?: Partial<PiUsage>;
  parentToolCallId?: string | null;
  timestamp?: number;
}

export type ToolExecutionStatus = "started" | "running" | "completed" | "failed" | "cancelled";

export interface TodoEntry {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface TaskExecution {
  taskId: string;
  /** The task tool invocation that originated this task, never its parent nesting id. */
  originatingToolCallId?: string;
  name: string;
  description?: string;
  execution: "foreground" | "background";
  status: "running" | "completed" | "failed" | "stopped";
  depth: number;
  progress?: string;
  durationMs?: number;
  summary?: string;
}

export interface ToolExecutionEvent {
  type: "tool_execution";
  generation: number;
  toolCallId: string;
  toolName: string;
  status: ToolExecutionStatus;
  timestamp: number;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  elapsedMs?: number;
  progress?: string;
  parentToolCallId?: string | null;
  todos?: TodoEntry[];
  task?: TaskExecution;
}

export interface AskInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskInteractionQuestion {
  id: string;
  header?: string;
  question: string;
  options: AskInteractionOption[];
  allowMultiple: boolean;
  allowFreeText: boolean;
}

export interface AskInteractionRequest {
  id: string;
  kind: "ask";
  toolCallId: string;
  title?: string;
  questions: AskInteractionQuestion[];
  timeoutAt?: number;
}

export interface ProposePlanInteractionRequest {
  id: string;
  kind: "propose_plan";
  toolCallId: string;
  title?: string;
  plan: string;
  timeoutAt?: number;
}

export type InteractionRequest = AskInteractionRequest | ProposePlanInteractionRequest;

export interface InteractionRequestEvent {
  type: "interaction_request";
  generation: number;
  request: InteractionRequest;
  timestamp: number;
}

export interface InteractionSnapshotEvent {
  type: "interaction_snapshot";
  generation: number;
  requests: InteractionRequest[];
}

export interface AskInteractionResponse {
  requestId: string;
  kind: "ask";
  status: "submitted" | "cancelled" | "timed_out";
  answers?: Array<{
    questionId: string;
    selectedOptionIds: string[];
    freeText?: string;
  }>;
}

export interface ProposePlanInteractionResponse {
  requestId: string;
  kind: "propose_plan";
  status: "submitted" | "cancelled" | "timed_out";
  decision?: "execute" | "continue_planning" | "refine";
  refinement?: string;
}

export type InteractionResponse = AskInteractionResponse | ProposePlanInteractionResponse;
export type InteractionResponseEvent = InteractionResponse & {
  type: "interaction_response";
  generation: number;
  timestamp?: number;
  clientMsgId?: string;
};

export interface RunStateEvent {
  type: "run_state";
  state: PiRunState;
  generation: number;
  timestamp: number;
  reason?: string;
  /** Structured runtime progress; distinct from a Pi child-process reconnect. */
  detail?:
    | {
        kind: "provider_retry";
        phase: "start";
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        error: string;
      }
    | {
        kind: "provider_retry";
        phase: "end";
        attempt: number;
        success: boolean;
        cancelled?: boolean;
        error?: string;
      }
    | {
        kind: "compaction";
        reason: "manual" | "threshold" | "overflow";
        phase: "start" | "end";
        aborted?: boolean;
        willRetry?: boolean;
        error?: string;
      }
    | {
        kind: "summarization_retry";
        phase: "scheduled" | "attempt" | "finished";
        source?: "branchSummary" | "compaction";
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        error?: string;
      };
  usage?: PiUsage;
}

export type PiHistoryEvent =
  | AgentMessageEvent
  | ToolExecutionEvent
  | InteractionRequestEvent
  | InteractionResponseEvent
  | RunStateEvent;

export interface PiHistoryEntry {
  id: string;
  parentId?: string | null;
  timestamp: number;
  event: PiHistoryEvent;
}

export interface HistorySnapshotEvent {
  type: "history_snapshot";
  generation: number;
  entries: PiHistoryEntry[];
  total: number;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  reason: "initial" | "page" | "gap" | "recovery";
}

export type UserSpaceStatus = "expected" | "mounted" | "offline";
export type UserSpaceAccess = "readonly" | "readwrite";
export type UserSpacePermissionState = "granted" | "denied" | "prompt" | "unknown";

export interface UserSpaceMount {
  mountId: string;
  name: string;
  rootName: string;
  status: UserSpaceStatus;
  access: UserSpaceAccess;
  canRead?: boolean;
  canWrite?: boolean;
  permissionState?: UserSpacePermissionState;
  lastPermissionCheckedAt?: number;
  includeHidden: true;
  fileCount?: number;
  lastIndexedAt?: number;
}

export interface ActiveUserSpace {
  name: string;
  rootName: string;
  status: UserSpaceStatus;
  access: UserSpaceAccess;
  canRead?: boolean;
  canWrite?: boolean;
  permissionState?: UserSpacePermissionState;
  lastPermissionCheckedAt?: number;
  includeHidden: true;
  fileCount?: number;
  lastIndexedAt?: number;
}

export type UserSpaceOperation =
  | "list_mounts"
  | "list_dir"
  | "read_file"
  | "search_paths"
  | "search"
  | "glob"
  | "shell_exec"
  | "create_entry"
  | "rename_entry"
  | "copy_entry"
  | "copy_entries"
  | "duplicate_entry"
  | "move_entries"
  | "write_file"
  | "replace_text"
  | "delete_entry";

type ClientMessageId = { clientMsgId?: string };

export type BrowserOutgoingMessage =
  | (AgentMessageEvent & ClientMessageId)
  | InteractionResponseEvent
  | { type: "session_subscribe"; lastSeq: number }
  | { type: "session_ack"; lastSeq: number }
  | ({ type: "abort"; generation?: number } & ClientMessageId)
  | ({ type: "retry"; messageId?: string } & ClientMessageId)
  | ({ type: "compact" } & ClientMessageId)
  | ({ type: "set_model"; model: PiModelRef } & ClientMessageId)
  | ({ type: "set_thinking_level"; thinkingLevel: ThinkingLevel } & ClientMessageId)
  | ({ type: "set_mode"; mode: AgentMode } & ClientMessageId)
  | ({ type: "mcp_get_status" } & ClientMessageId)
  | ({ type: "mcp_toggle"; serverName: string; enabled: boolean } & ClientMessageId)
  | ({ type: "mcp_reconnect"; serverName: string } & ClientMessageId)
  | ({ type: "end_session"; reason?: string } & ClientMessageId)
  | ({ type: "stop_task"; taskId: string } & ClientMessageId)
  | ({
      type: "user_space_mount";
      user_space?: ActiveUserSpace | null;
      mounts?: UserSpaceMount[];
    } & ClientMessageId)
  | ({ type: "user_space_unmount"; mountId: string } & ClientMessageId)
  | { type: "user_space_mutation_authorize"; request_id: string }
  | ({
      type: "user_space_response";
      request_id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
      commit_lease?: string;
      runtime_epoch?: string;
    } & ClientMessageId)
  | ({
      type: "user_space_status";
      user_space?: ActiveUserSpace | null;
      mounts?: UserSpaceMount[];
    } & ClientMessageId)
  | ({
      type: "user_space_index_update";
      mountId?: string;
      fileCount: number;
      lastIndexedAt: number;
    } & ClientMessageId)
  | OnlyOfficeBrowserResponse
  | OnlyOfficeBrowserStatus;

export type BrowserIncomingMessageBase =
  | { type: "session_init"; session: SessionState }
  | { type: "session_update"; session: Partial<SessionState> }
  | AgentMessageEvent
  | AgentMessageAcceptedEvent
  | MessageDeltaEvent
  | ToolExecutionEvent
  | InteractionRequestEvent
  | InteractionSnapshotEvent
  | InteractionResponseEvent
  | RunStateEvent
  | HistorySnapshotEvent
  | { type: "error"; message: string; code?: string; retryable?: boolean }
  | { type: "event_replay"; events: BufferedBrowserEvent[] }
  | { type: "session_name_update"; name: string }
  | { type: "session_lifecycle_update"; sessionId: string; lifecycleState: "enabled" | "closed" }
  | { type: "mcp_status"; servers: McpServerDetail[] }
  | {
      type: "pi_queue";
      generation: number;
      steering: string[];
      followUp: string[];
      timestamp: number;
    }
  | {
      type: "pi_extension_event";
      generation: number;
      event: string;
      payload: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "user_space_request";
      request_id: string;
      operation: UserSpaceOperation;
      input: Record<string, unknown>;
      requires_commit?: boolean;
    }
  | {
      type: "user_space_mutation_request";
      request_id: string;
      operation: UserSpaceOperation;
      input: Record<string, unknown>;
      requires_commit: true;
    }
  | {
      type: "user_space_mutation_authorization";
      request_id: string;
      ok: boolean;
      commit_lease?: string;
      runtime_epoch?: string;
      error?: string;
    }
  | {
      type: "user_space_blob_checkout_request";
      transfer_id: string;
      mountId: string;
      path: string;
      uploadUrl: string;
      completeUrl: string;
      maxBytes: number;
    }
  | {
      type: "user_space_blob_checkin_request";
      transfer_id: string;
      mountId: string;
      path: string;
      baseHash?: string;
      baseMtime?: number;
      create?: boolean;
      size: number;
      hash: string;
      downloadUrl: string;
      commitUrl: string;
      completeUrl: string;
    }
  | OnlyOfficeBrowserRequest;

export type BrowserIncomingMessage = BrowserIncomingMessageBase & { seq?: number };
export type ReplayableBrowserIncomingMessage = Exclude<
  BrowserIncomingMessageBase,
  { type: "event_replay" }
>;
export interface BufferedBrowserEvent {
  seq: number;
  message: ReplayableBrowserIncomingMessage;
}

export interface SessionMessageHistoryPage {
  sessionId: string;
  total: number;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  start: number;
  end: number;
  entries: PiHistoryEntry[];
}

export type CreationStepId =
  "resolving_env" | "launching_pi" | "restoring_history" | "waiting_for_ready";
export interface CreationProgressEvent {
  step: CreationStepId;
  label: string;
  status: "in_progress" | "done" | "error";
  detail?: string;
}
