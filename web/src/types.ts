import type {
  AgentMessage,
  AgentMode,
  AgentTransport,
  BackendType,
  InteractionRequest,
  InteractionResponse,
  PiMessagePart,
  PiModelRef,
  PiRunState,
  PiUsage,
  ThinkingLevel,
  ToolExecutionEvent,
} from "../shared/pi-browser-protocol.js";

export type {
  ActiveUserSpace,
  AgentMessage,
  AgentMode,
  AgentTransport,
  AskInteractionOption,
  AskInteractionQuestion,
  AskInteractionRequest,
  AskInteractionResponse,
  BackendType,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BufferedBrowserEvent,
  CreationProgressEvent,
  HistorySnapshotEvent,
  InteractionRequest,
  InteractionRequestEvent,
  InteractionResponse,
  InteractionResponseEvent,
  McpServerConfig,
  McpServerDetail,
  MessageDeltaEvent,
  PiHistoryEntry,
  PiHistoryEvent,
  PiMessagePart,
  PiModelRef,
  PiRunState,
  PiUsage,
  ProposePlanInteractionRequest,
  ProposePlanInteractionResponse,
  RunStateEvent,
  SessionMessageHistoryPage,
  SessionState,
  ThinkingLevel,
  TodoEntry,
  ToolExecutionEvent,
  ToolExecutionStatus,
  UserSpaceAccess,
  UserSpaceMount,
  UserSpaceOperation,
} from "../shared/pi-browser-protocol.js";

export type AgentBrowserBridgePhase =
  "unavailable" | "stopped" | "starting" | "waiting_for_extension" | "connected" | "error";

export interface AgentBrowserBridgeStatus {
  schemaVersion: 1;
  phase: AgentBrowserBridgePhase;
  runtime: {
    ready: boolean;
    version: string | null;
    sourceCommit: string | null;
    missing: string[];
  };
  daemon: {
    state: "offline" | "online";
    port: number;
    version: string | null;
    protocolVersion: number | null;
    sessionCount: number;
  };
  extension: {
    connected: boolean;
    path: string;
    profiles: Array<{
      profileId: string;
      chromeVersion: string | null;
      tabCount: number;
    }>;
  };
  error?: string;
}

export interface AgentBrowserVerification {
  ok: true;
  durationMs: number;
  probe: "active_tab_url";
  status: AgentBrowserBridgeStatus;
}

export type BrowserControlPhase =
  "agent" | "takeover_pending" | "human" | "resuming" | "stopping" | "stopped" | "uncertain";

export interface BrowserControlState {
  schemaVersion: 1;
  sessionId: string;
  phase: BrowserControlPhase;
  epoch: number;
  updatedAt: number;
  reason: string;
  pendingActionRisk: boolean;
  lastHandoff?: {
    summary: string;
    resumedAt: number;
  };
}

/** Browser-memory projection; Pi JSONL remains the transcript source of truth. */
export interface ChatMessage {
  id: string;
  role: AgentMessage["role"];
  content: string;
  contentParts?: PiMessagePart[];
  toolExecutions?: ToolExecutionEvent[];
  images?: { mediaType: string; data: string }[];
  timestamp: number;
  parentToolCallId?: string | null;
  isStreaming?: boolean;
  streamingPhase?: "thinking" | "text";
  model?: PiModelRef;
  stopReason?: string | null;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

export type ProcessStatus = "running" | "completed" | "failed" | "stopped";

export interface ProcessItem {
  taskId: string;
  toolCallId: string;
  name: string;
  description: string;
  execution: "foreground" | "background";
  depth: number;
  status: ProcessStatus;
  startedAt: number;
  completedAt?: number;
  progress?: string;
  summary?: string;
}

export interface PiSessionInfo {
  sessionId: string;
  state: "starting" | "connected" | "running" | "exited";
  lifecycleState?: "enabled" | "closed";
  transport: AgentTransport;
  exitCode?: number | null;
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
  runState?: PiRunState;
  usage?: PiUsage;
  generation?: number;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  archivedAt?: number;
  name?: string;
  backendType: BackendType;
}

export interface CompletedInteraction {
  request: InteractionRequest;
  response: InteractionResponse;
  timestamp: number;
}
