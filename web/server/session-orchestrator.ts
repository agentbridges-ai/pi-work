import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DeterministicSessionTitleGenerator } from "./auto-namer.js";
import { log } from "./logger.js";
import { metricsCollector } from "./metrics-collector.js";
import { PiAdapter } from "./pi-adapter.js";
import type { PiSessionInfo } from "./pi-launcher.js";
import { readPiSessionDocumentSync, restoredPiSessionState } from "./pi-session-history.js";
import { SessionNameStore } from "./session-names.js";
import {
  SessionRuntimeStateRegistry,
  type SessionRuntimeSnapshot,
} from "./session-runtime-state.js";
import type { PersistedSession } from "./session-store.js";
import type {
  ActivateSessionResult,
  ArchiveSessionResult,
  CreateSessionRequest,
  CreateSessionResult,
  DeleteSessionResult,
  ProgressCallback,
  SessionLifecycleState,
  SessionOrchestratorDeps,
} from "./session-orchestrator-contract.js";

export type {
  ActivateSessionResult,
  ArchiveSessionResult,
  CreateSessionRequest,
  CreateSessionResult,
  DeleteSessionResult,
  ProgressCallback,
  SessionLifecycleState,
  SessionOrchestratorDeps,
} from "./session-orchestrator-contract.js";

function resourceStatus(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    ((error as { status?: unknown }).status === 429 ||
      (error as { status?: unknown }).status === 507)
  ) {
    return (error as { status: number }).status;
  }
  return 503;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function placeholderInfo(session: PersistedSession, sessionDir: string): PiSessionInfo {
  let createdAt = Date.now();
  try {
    createdAt = statSync(join(sessionDir, "session.json")).birthtimeMs || createdAt;
  } catch {}
  const workspace = join(sessionDir, "workspace");
  const restored = session.piSessionRelativePath
    ? restoredPiSessionState(
        readPiSessionDocumentSync({
          sessionDir,
          piSessionRelativePath: session.piSessionRelativePath,
          expectedPiSessionId: session.id,
          expectedCwd: workspace,
        }).entries,
      )
    : {};
  return {
    sessionId: session.id,
    state: "exited",
    lifecycleState: session.archived ? "closed" : "enabled",
    exitCode: 0,
    ...(restored.model ? { model: restored.model } : {}),
    thinkingLevel: restored.thinkingLevel ?? "off",
    mode: restored.mode ?? "agent",
    cwd: workspace,
    createdAt,
    backendType: "pi",
    transport: "pi-rpc",
    generation: 0,
    piVersion: "0.82.1",
    piSessionRelativePath: session.piSessionRelativePath,
    archived: session.archived,
    archivedAt: session.archivedAt,
  };
}

/**
 * Serializes native Pi process generations and product authority. PiLauncher
 * owns exactly one SRT/rpc-entry child per live session; WsBridge owns only the
 * browser protocol and never acts as a second backend transport.
 */
export class SessionOrchestrator {
  private readonly launcher: SessionOrchestratorDeps["launcher"];
  private readonly wsBridge: SessionOrchestratorDeps["wsBridge"];
  private readonly sessionStore: SessionOrchestratorDeps["sessionStore"];
  private readonly buildLaunchOptions: SessionOrchestratorDeps["buildLaunchOptions"];
  private readonly sessionNameStore: SessionNameStore;
  private readonly sessionTitleGenerator;
  private readonly browserSessionCleanup: NonNullable<
    SessionOrchestratorDeps["browserSessionCleanup"]
  >;
  private readonly onRuntimeStopped: NonNullable<SessionOrchestratorDeps["onRuntimeStopped"]>;
  private readonly runtimeStates = new SessionRuntimeStateRegistry();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly intentionalStops = new Set<string>();
  private initialized = false;
  private shuttingDown = false;

  constructor(deps: SessionOrchestratorDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.sessionStore = deps.sessionStore;
    this.buildLaunchOptions = deps.buildLaunchOptions;
    this.sessionNameStore = deps.sessionNameStore || new SessionNameStore();
    this.sessionTitleGenerator =
      deps.sessionTitleGenerator || new DeterministicSessionTitleGenerator();
    this.browserSessionCleanup = deps.browserSessionCleanup || (async () => undefined);
    this.onRuntimeStopped = deps.onRuntimeStopped || (async () => undefined);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const persisted of this.sessionStore.loadAll()) {
      const directory = this.sessionStore.getSessionDirectory(persisted.id);
      if (!directory) continue;
      try {
        const info = placeholderInfo(persisted, directory);
        this.launcher.restoreSession(info);
        this.wsBridge.restoreSession?.(info, persisted);
        this.runtimeStates.ensure(persisted.id, {
          state: "stopped",
          generation: info.generation,
          reason: "restored_from_pi_authority",
        });
      } catch (error) {
        this.runtimeStates.ensure(persisted.id, {
          state: "failed",
          generation: 0,
          reason: "invalid_pi_session_history",
        });
        log.warn("orchestrator", "Rejected invalid Pi session history", {
          sessionId: persisted.id,
          error: error instanceof Error ? error.name : "InvalidPiSessionHistory",
        });
      }
    }
  }

  private serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(sessionId, next);
    void next
      .finally(() => {
        if (this.operations.get(sessionId) === next) {
          this.operations.delete(sessionId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  async createSession(body: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.create(body);
  }

  async createSessionStreaming(
    body: CreateSessionRequest,
    onProgress: ProgressCallback,
  ): Promise<CreateSessionResult> {
    return this.create(body, onProgress);
  }

  private async create(
    body: CreateSessionRequest,
    onProgress?: ProgressCallback,
  ): Promise<CreateSessionResult> {
    if (body.backend !== undefined && body.backend !== "pi") {
      return { ok: false, error: "Only the native Pi backend is supported", status: 400 };
    }
    if (!body.model) {
      return { ok: false, error: "A governed Pi model is required", status: 400 };
    }
    const sessionId = randomUUID();
    const persisted: PersistedSession = {
      id: sessionId,
      ...(body.authority ? { authority: body.authority } : {}),
      offlineQueue: [],
      processedClientMessageIds: [],
    };
    try {
      await onProgress?.("resolving_env", "Resolving Pi authority", "in_progress");
      this.sessionStore.saveSync(persisted);
      await onProgress?.("resolving_env", "Pi authority resolved", "done");
      const session = await this.serialize(sessionId, () =>
        this.launchSession(sessionId, { request: body, persisted }, onProgress),
      );
      metricsCollector.recordSessionCreated("pi");
      metricsCollector.recordSessionSpawned(sessionId);
      return { ok: true, session };
    } catch (error) {
      this.runtimeStates.remove(sessionId);
      this.sessionStore.removeSessionDirectory(sessionId);
      const message = errorMessage(error);
      log.error("orchestrator", "Native Pi session creation failed", {
        sessionId,
        error: message,
      });
      return { ok: false, error: message, status: resourceStatus(error) };
    }
  }

  private async launchSession(
    sessionId: string,
    context: {
      request: CreateSessionRequest;
      persisted?: PersistedSession;
    },
    onProgress?: ProgressCallback,
  ): Promise<PiSessionInfo> {
    if (this.shuttingDown) throw new Error("Native Pi runtime is shutting down");
    const generation = this.launcher.nextLaunchGeneration(sessionId);
    this.runtimeStates.begin(sessionId, generation, "preparing", "launch_requested");
    await onProgress?.("launching_pi", "Starting native Pi", "in_progress");
    const options = await this.buildLaunchOptions(sessionId, generation, context);
    let adapter: PiAdapter | undefined;
    const callerNotification = options.onNotification;
    options.onNotification = (notification, info) => {
      callerNotification?.(notification, info);
      adapter?.handleNotification(notification);
    };
    const callerExit = options.onExit;
    options.onExit = (info) => {
      callerExit?.(info);
      if (info.generation !== generation) return;
      this.wsBridge.detachPiAdapter?.(sessionId, generation);
      const state = this.intentionalStops.has(sessionId) ? "stopped" : "failed";
      this.runtimeStates.transition(
        sessionId,
        generation,
        state,
        this.intentionalStops.has(sessionId) ? "intentional_stop" : "pi_process_exit",
      );
      void this.onRuntimeStopped(sessionId, generation, "exit");
    };
    this.runtimeStates.transition(sessionId, generation, "starting", "srt_spawn_requested");
    const info = await this.launcher.launch(options);
    this.runtimeStates.transition(sessionId, generation, "connecting", "pi_rpc_connected");
    const transport = this.launcher.getTransport(sessionId);
    if (!transport) throw new Error("Native Pi transport disappeared before attachment");
    adapter = new PiAdapter({ transport, sessionId, generation });
    this.wsBridge.attachPiAdapter?.(
      info,
      adapter,
      context.persisted,
      this.launcher.getReadiness(sessionId),
    );
    if (info.piSessionRelativePath) {
      this.sessionStore.setPiSessionRelativePath(sessionId, info.piSessionRelativePath);
    }
    this.runtimeStates.transition(sessionId, generation, "ready", "pi_readiness_complete");
    this.intentionalStops.delete(sessionId);
    await onProgress?.("launching_pi", "Native Pi started", "done");
    await onProgress?.("restoring_history", "Pi history restored", "done");
    await onProgress?.("waiting_for_ready", "Session ready", "done");
    this.wsBridge.broadcastLifecycleUpdate(sessionId, "enabled");
    for (const queued of this.sessionStore.drainOffline(sessionId)) {
      this.wsBridge.injectUserMessage(sessionId, queued.message);
    }
    return info;
  }

  pinSessionAuthority(
    sessionId: string,
    authority: import("./control-plane-types.js").SessionAuthoritySnapshot,
  ): boolean {
    const persisted = this.sessionStore.setAuthority(sessionId, authority);
    return this.wsBridge.setSessionAuthority(sessionId, authority) && persisted;
  }

  markSessionNameManual(sessionId: string): boolean {
    return this.wsBridge.setSessionNameSource(sessionId, "manual");
  }

  async killSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.serialize(sessionId, async () => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.state === "exited") {
        await this.cleanupBrowserSession(sessionId);
        return { ok: false };
      }
      const generation = Math.max(
        info.generation + 1,
        (this.runtimeStates.get(sessionId)?.generation || 0) + 1,
      );
      this.runtimeStates.begin(sessionId, generation, "stopping", "kill_requested");
      this.intentionalStops.add(sessionId);
      const killed = await this.launcher.kill(sessionId);
      await this.onRuntimeStopped(sessionId, info.generation, "kill");
      await this.cleanupBrowserSession(sessionId);
      if (!killed) return { ok: false };
      this.runtimeStates.transition(sessionId, generation, "stopped", "kill_complete");
      this.wsBridge.detachPiAdapter?.(sessionId, info.generation);
      this.wsBridge.broadcastLifecycleUpdate(sessionId, "closed");
      return { ok: true };
    });
  }

  async relaunchSession(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
      await this.serialize(sessionId, async () => {
        const persisted = this.sessionStore.load(sessionId);
        if (!persisted) throw new Error("Session not found");
        if (persisted.archived) throw new Error("Session is archived");
        await this.launcher.kill(sessionId);
        await this.launchSession(sessionId, {
          request: { backend: "pi", resumeSessionAt: persisted.piSessionRelativePath },
          persisted,
        });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error), status: resourceStatus(error) };
    }
  }

  async activateSession(sessionId: string): Promise<ActivateSessionResult> {
    const current = this.launcher.getSession(sessionId);
    if (!current) {
      return { ok: false, error: "Session not found", status: 404, phase: null };
    }
    if (current.archived) {
      return {
        ok: false,
        error: "Session is archived and cannot be activated",
        status: 409,
        lifecycleState: "closed",
        phase: this.wsBridge.getSessionPhase(sessionId),
      };
    }
    if (this.launcher.isAlive(sessionId) && current.state !== "exited") {
      return {
        ok: true,
        session: { ...current, lifecycleState: "enabled" },
        lifecycleState: "enabled",
        phase: this.wsBridge.getSessionPhase(sessionId) || "ready",
      };
    }
    try {
      const session = await this.serialize(sessionId, async () => {
        const persisted = this.sessionStore.load(sessionId);
        if (!persisted) throw new Error("Session not found");
        return this.launchSession(sessionId, {
          request: { backend: "pi", resumeSessionAt: persisted.piSessionRelativePath },
          persisted,
        });
      });
      return {
        ok: true,
        session: { ...session, lifecycleState: "enabled" },
        lifecycleState: "enabled",
        phase: "ready",
      };
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error),
        status: resourceStatus(error),
        lifecycleState: "closed",
        phase: this.wsBridge.getSessionPhase(sessionId),
      };
    }
  }

  getLifecycleState(sessionId: string): SessionLifecycleState {
    const session = this.launcher.getSession(sessionId);
    return session && !session.archived && this.launcher.isAlive(sessionId) ? "enabled" : "closed";
  }

  hasSessionData(sessionId: string): boolean {
    return this.sessionStore.hasSessionData(sessionId);
  }

  getPersistedSession(sessionId: string): PersistedSession | null {
    return this.sessionStore.load(sessionId);
  }

  getSessionDirectory(sessionId: string): string | null {
    return this.sessionStore.getSessionDirectory(sessionId);
  }

  async archiveSession(sessionId: string): Promise<ArchiveSessionResult> {
    const stopped = await this.killSession(sessionId);
    const info = this.launcher.getSession(sessionId);
    if (info && info.state !== "exited" && !stopped.ok) {
      return { ok: false, error: "Native Pi process tree could not be drained safely" };
    }
    this.launcher.setArchived(sessionId, true);
    if (!this.sessionStore.setArchived(sessionId, true)) {
      return { ok: false, error: "Session authority could not be archived" };
    }
    return { ok: true };
  }

  async hardDeleteSession(sessionId: string): Promise<DeleteSessionResult> {
    const info = this.launcher.getSession(sessionId);
    if (info && info.state !== "exited") {
      const stopped = await this.killSession(sessionId);
      if (!stopped.ok) {
        return { ok: false, error: "Native Pi process tree could not be drained safely" };
      }
    }
    await this.cleanupBrowserSession(sessionId);
    this.launcher.removeSession(sessionId);
    this.wsBridge.closeSession(sessionId);
    this.sessionStore.remove(sessionId);
    const removedSessionDir = this.sessionStore.removeSessionDirectory(sessionId);
    await this.sessionNameStore.removeNameAfterSpaceRelease(sessionId);
    this.runtimeStates.remove(sessionId);
    this.intentionalStops.delete(sessionId);
    return {
      ok: true,
      removedSessionDir,
      removedRecordings: removedSessionDir ? 1 : 0,
    };
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    return this.hardDeleteSession(sessionId);
  }

  unarchiveSession(sessionId: string): { ok: boolean } {
    this.launcher.setArchived(sessionId, false);
    return { ok: this.sessionStore.setArchived(sessionId, false) };
  }

  getSession(sessionId: string): PiSessionInfo | undefined {
    return this.launcher.getSession(sessionId);
  }

  getRuntimeState(sessionId: string): SessionRuntimeSnapshot | null {
    return this.runtimeStates.get(sessionId);
  }

  listRuntimeStates(): SessionRuntimeSnapshot[] {
    return this.runtimeStates.list();
  }

  async generateSessionName(sessionId: string): Promise<string | null> {
    const firstUserMessage = await this.wsBridge.firstUserMessage?.(sessionId);
    if (!firstUserMessage) return null;
    const sessionDir = this.sessionStore.getSessionDirectory(sessionId);
    if (!sessionDir) return null;
    const name = await this.sessionTitleGenerator.generate({
      sessionId,
      firstUserMessage,
      sessionDir,
    });
    if (!name) return null;
    this.sessionNameStore.setName(sessionId, name);
    this.wsBridge.setSessionNameSource(sessionId, "generated");
    this.wsBridge.broadcastNameUpdate(sessionId, name);
    return name;
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.initialized = false;
  }

  private async cleanupBrowserSession(sessionId: string): Promise<void> {
    try {
      await this.browserSessionCleanup(sessionId);
    } catch (error) {
      log.warn("orchestrator", "Browser session cleanup failed", {
        sessionId,
        error: errorMessage(error),
      });
    }
  }
}
