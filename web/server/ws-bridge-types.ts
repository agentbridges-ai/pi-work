import type { ServerWebSocket } from "bun";
import type {
  AskInteractionQuestion,
  BufferedBrowserEvent,
  SessionState,
} from "../shared/pi-browser-protocol.js";
import type { SessionAuthoritySnapshot } from "./control-plane-types.js";
import type { PiAdapter } from "./pi-adapter.js";
import type { PiSessionInfo } from "./pi-launcher.js";
import type { PiReadinessResult } from "./pi-readiness.js";
import type { OfflineQueueEntry, PersistedSession } from "./session-store.js";
import type { SessionStateMachine } from "./session-state-machine.js";

/**
 * The only WebSocket accepted by the Agent bridge. Runtime RPC stays on the
 * server-side child process pipes and is never upgraded into a public socket.
 */
export interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  authCookie?: string;
  authAuthorization?: string;
  authUserId?: string;
  authTenantId?: string;
  authValidatedAt?: number;
  protocolVersion: 1;
  contextEpoch: number;
  contextId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
}

export type SocketData = BrowserSocketData;

export interface Session {
  id: string;
  authority?: SessionAuthoritySnapshot;
  nameSource?: "manual" | "generated";
  piAdapter: PiAdapter | null;
  adapterGeneration?: number;
  browserSockets: Set<ServerWebSocket<BrowserSocketData>>;
  state: SessionState;

  /** Product delivery state. These are the only message-shaped fields persisted. */
  offlineQueue: OfflineQueueEntry[];
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;

  /** Ephemeral browser replay state. Pi JSONL owns durable history. */
  nextEventSeq: number;
  eventBuffer: BufferedBrowserEvent[];
  lastAckSeq: number;

  piSessionRelativePath?: string;
  sessionDir?: string;
  archived?: boolean;
  archivedAt?: number;

  /** Adapter event correlation owned by the current process generation. */
  interactionKinds: Map<
    string,
    {
      kind: "ask" | "propose_plan";
      method: "select" | "confirm" | "input" | "editor";
      optionValues: Map<string, string>;
      askQuestions?: AskInteractionQuestion[];
      askBatch?: boolean;
    }
  >;
  toolStarts: Map<
    string,
    {
      toolName: string;
      input?: Record<string, unknown>;
      startedAt: number;
    }
  >;
  firstUserPromptSeen: boolean;

  /** Kept as the server lifecycle projection used by routes and metrics. */
  stateMachine: SessionStateMachine;
  unsubscribeStateMachine?: () => void;
}

export interface AttachPiSessionInfo extends PiSessionInfo {
  readiness?: PiReadinessResult;
}

export interface RestorePiSessionInfo extends PiSessionInfo {
  readiness?: PiReadinessResult;
}

export type PersistedPiSession = PersistedSession;

export function makeDefaultState(
  sessionId: string,
  overrides: Partial<SessionState> = {},
): SessionState {
  const state: SessionState = {
    sessionId,
    backendType: "pi",
    transport: "pi-rpc",
    piVersion: "0.82.1",
    model: {
      key: "unconfigured/unconfigured",
      provider: "unconfigured",
      modelId: "unconfigured",
    },
    thinkingLevel: "off",
    mode: "agent",
    cwd: "",
    tools: [],
    commands: [],
    skills: [],
    mcpServers: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
    runState: "starting",
    isCompacting: false,
    generation: 0,
    userSpace: null,
    userSpaces: [],
    ...overrides,
  };
  state.sessionId = sessionId;
  state.backendType = "pi";
  state.transport = "pi-rpc";
  state.piVersion = "0.82.1";
  return state;
}
