import type {
  AgentMode,
  PiModelRef,
  ThinkingLevel,
  UserSpaceMount,
} from "../shared/pi-browser-protocol.js";
import type { SessionTitleGenerator } from "./auto-namer.js";
import type { PiLaunchOptions, PiLauncher, PiSessionInfo } from "./pi-launcher.js";
import type { SessionNameStore } from "./session-names.js";
import type { SessionStore, PersistedSession } from "./session-store.js";
import type { SessionRuntimeSnapshot } from "./session-runtime-state.js";
import type { CreationStepId } from "./session-types.js";
import type { WsBridge } from "./ws-bridge.js";
import type { ResolvedSessionLaunch, SessionAuthoritySnapshot } from "./control-plane-types.js";

/** The exact immutable control-plane policy materialized for one Pi launch. */
export type ResolvedPiSandbox = ResolvedSessionLaunch;

export interface CreateSessionRequest {
  backend?: "pi";
  agentId?: string;
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
  resumeSessionAt?: string;
  userSpace?: Omit<UserSpaceMount, "status"> & { status?: UserSpaceMount["status"] };
  /** Server-only pinned Agent authority. Public request sanitization removes it. */
  authority?: SessionAuthoritySnapshot;
  /** Server-resolved Agent policy; browser routes strip any client-provided value. */
  resolvedSandbox?: ResolvedPiSandbox;
}

export interface SessionLaunchContext {
  request: CreateSessionRequest;
  persisted?: PersistedSession;
}

export interface SessionOrchestratorDeps {
  launcher: PiLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  buildLaunchOptions(
    sessionId: string,
    generation: number,
    context: SessionLaunchContext,
  ): Promise<PiLaunchOptions>;
  sessionNameStore?: SessionNameStore;
  sessionTitleGenerator?: SessionTitleGenerator;
  browserSessionCleanup?: (sessionId: string) => Promise<void>;
  onRuntimeStopped?: (
    sessionId: string,
    generation: number,
    reason: "exit" | "kill" | "delete" | "shutdown",
  ) => void | Promise<void>;
}

export type CreateSessionResult =
  { ok: true; session: PiSessionInfo } | { ok: false; error: string; status: number };

export type SessionLifecycleState = "enabled" | "closed";

export type ActivateSessionResult =
  | {
      ok: true;
      session: PiSessionInfo & { lifecycleState: SessionLifecycleState };
      lifecycleState: SessionLifecycleState;
      phase: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
      lifecycleState?: SessionLifecycleState;
      phase?: string | null;
    };

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface ArchiveSessionResult {
  ok: boolean;
  error?: string;
}

export interface DeleteSessionResult {
  ok: boolean;
  error?: string;
  removedSessionDir?: boolean;
  removedRecordings?: number;
}

export interface SessionRuntimeStateProvider {
  getRuntimeState(sessionId: string): SessionRuntimeSnapshot | null;
  listRuntimeStates(): SessionRuntimeSnapshot[];
}
