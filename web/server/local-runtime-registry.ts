import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { McpServerDetail } from "../shared/pi-browser-protocol.js";
import type { AuthenticatedUser } from "./auth-types.js";
import type {
  AgentBrowserBridgeService,
  AgentBrowserControlEvent,
} from "./agent-browser-bridge-service.js";
import { agentBrowserSessionName } from "./agent-browser-runtime.js";
import { BrowserControlCoordinator } from "./browser-control-session.js";
import { createBrowserControlRuntime } from "./browser-control-runtime.js";
import type { ControlPlaneService } from "./control-plane-service.js";
import { ENV, environment } from "./environment.js";
import {
  getLocalDataRoot,
  getSessionDir,
  getTenantDataRoot,
  getTenantSessionDir,
  getTenantUserDataRoot,
  getTenantUserPiSkillsRoot,
  getTenantsDataRoot,
  getUserDataRoot,
  getUserPiSkillsRoot,
  getUserSpaceStatePath,
} from "./local-paths.js";
import {
  PiLaunchOptionsBuilder,
  type ProtectedInternalTransport,
} from "./pi-launch-options-builder.js";
import { PiLauncher } from "./pi-launcher.js";
import { PiProviderVault } from "./pi-provider-vault.js";
import { createPiRecordingObserver } from "./pi-recording-observer.js";
import { OnlyOfficeBroker, registerOnlyOfficeInternalRoutes } from "./onlyoffice-broker.js";
import { RecorderManager } from "./recorder.js";
import { registerRequestContext } from "./request-context.js";
import {
  DEFAULT_USER_RESOURCE_LIMITS,
  type ResourceLease,
  UserResourceGovernor,
} from "./resource-governor.js";
import type { RbacService } from "./rbac-service.js";
import { createRoutes } from "./routes.js";
import { SessionNameStore } from "./session-names.js";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { SessionStore } from "./session-store.js";
import type { TenantRuntimeDriver } from "./tenant-runtime-driver.js";
import { UserDataReconciler } from "./user-data-reconciler.js";
import { UserSpaceBroker, registerUserSpaceInternalTransferRoutes } from "./user-space-broker.js";
import {
  DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES,
  DEFAULT_USER_DISK_MONITOR_INTERVAL_MS,
  DEFAULT_USER_DISK_QUOTA_BYTES,
  type DiskQuotaMonitor,
  type DiskUsageSnapshot,
  UserDiskQuota,
} from "./user-disk-quota.js";
import { WorkspaceStateStore } from "./workspace-state-store.js";
import { WsBridge, type PiBridgeControlMessage } from "./ws-bridge.js";

export interface LocalRuntime {
  user: AuthenticatedUser & { uuid: string };
  api: Hono;
  internal: Hono;
  wsBridge: WsBridge;
  launcher: PiLauncher;
  launchBuilder: PiLaunchOptionsBuilder;
  sessionStore: SessionStore;
  recorder: RecorderManager;
  browserControl: BrowserControlCoordinator;
  dispose(): Promise<void>;
}

export interface LocalRuntimeLease {
  readonly runtime: LocalRuntime;
  readonly principalKey: string;
  readonly epoch: number;
  release(): void;
}

export interface LocalRuntimeRegistryOptions {
  providerVault?: PiProviderVault;
  internalTransport?: ProtectedInternalTransport;
  dataRoot?: string;
}

interface PrincipalGate {
  epoch: number;
  open: boolean;
  tombstoned: boolean;
  inFlight: number;
  drainWaiters: Set<() => void>;
  revocation: Promise<void> | null;
}

interface RuntimeDisposalComponents {
  orchestrator: Pick<SessionOrchestrator, "shutdown">;
  launcher: Pick<PiLauncher, "killAll">;
  launchBuilder: Pick<PiLaunchOptionsBuilder, "dispose">;
  userSpaceBroker: Pick<UserSpaceBroker, "dispose">;
  onlyOfficeBroker: Pick<OnlyOfficeBroker, "dispose">;
  wsBridge: Pick<WsBridge, "dispose">;
  sessionStore: Pick<SessionStore, "dispose">;
  recorder: Pick<RecorderManager, "dispose">;
  browserSessions?: { closeAll(): Promise<void> };
}

/**
 * Runtime teardown first prevents new generations, then drains Pi/SRT process
 * trees and their brokers before releasing browser-backed file capabilities.
 */
export async function disposeLocalRuntimeComponents(
  components: RuntimeDisposalComponents,
): Promise<void> {
  const failures: unknown[] = [];
  const captureSync = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      failures.push(error);
    }
  };
  const captureAsync = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  captureSync(() => components.orchestrator.shutdown());
  await captureAsync(() => components.launcher.killAll());
  if (components.browserSessions) {
    await captureAsync(() => components.browserSessions!.closeAll());
  }
  await captureAsync(() => components.launchBuilder.dispose());
  captureSync(() => components.userSpaceBroker.dispose());
  captureSync(() => components.onlyOfficeBroker.dispose());
  await captureAsync(() => components.wsBridge.dispose());
  captureSync(() => components.sessionStore.dispose());
  captureSync(() => components.recorder.dispose());
  if (failures.length > 0) {
    throw new AggregateError(failures, "Local Pi runtime disposal did not complete cleanly");
  }
}

interface UserRuntimeResources {
  governor: UserResourceGovernor;
  diskQuota: UserDiskQuota;
  monitor: DiskQuotaMonitor | null;
  stoppingForQuota: Promise<void> | null;
}

function uuidFromUser(user: AuthenticatedUser): string {
  const uuid = user.uuid?.trim();
  if (!uuid) throw new Error("Authenticated user is missing uuid");
  return uuid;
}

function runtimeKey(user: AuthenticatedUser): string {
  const uuid = uuidFromUser(user);
  return user.tenantId ? `${user.tenantId}:${uuid}` : uuid;
}

function publicMcpDetails(
  details: ReturnType<PiLaunchOptionsBuilder["mcpDetails"]>,
): McpServerDetail[] {
  return details.map((server) => ({
    name: server.name,
    enabled: server.enabled,
    status: server.status,
    ...(server.serverInfo ? { serverInfo: server.serverInfo } : {}),
    ...(server.error ? { error: server.error } : {}),
    config: {
      type: server.config.transport,
      ...(server.config.command ? { command: server.config.command } : {}),
      ...(server.config.args ? { args: [...server.config.args] } : {}),
      ...(server.config.url ? { url: server.config.url } : {}),
    },
    scope: "agent",
    tools: server.tools.map((tool) => ({
      name: tool.name,
      annotations: { readOnly: tool.readOnly },
    })),
  }));
}

export class LocalRuntimeRegistry {
  private readonly runtimes = new Map<string, LocalRuntime>();
  private readonly sessionToUser = new Map<string, string>();
  private readonly principalGates = new Map<string, PrincipalGate>();
  private readonly resourcesByUser = new Map<string, UserRuntimeResources>();
  private readonly providerVault: PiProviderVault;
  private readonly internalTransport?: ProtectedInternalTransport;
  private readonly dataRoot: string;

  constructor(
    private readonly _port: number,
    private readonly rbac?: RbacService,
    private readonly controlPlane?: ControlPlaneService,
    private readonly runtimeDriver?: TenantRuntimeDriver,
    private readonly agentBrowserBridge?: AgentBrowserBridgeService,
    options: LocalRuntimeRegistryOptions = {},
  ) {
    this.providerVault = options.providerVault ?? new PiProviderVault([]);
    this.internalTransport = options.internalTransport;
    this.dataRoot = options.dataRoot ?? getLocalDataRoot();
  }

  private gateFor(principalKey: string): PrincipalGate {
    let gate = this.principalGates.get(principalKey);
    if (!gate) {
      gate = {
        epoch: 0,
        open: true,
        tombstoned: false,
        inFlight: 0,
        drainWaiters: new Set(),
        revocation: null,
      };
      this.principalGates.set(principalKey, gate);
    }
    return gate;
  }

  private releaseGate(gate: PrincipalGate): void {
    if (gate.inFlight <= 0) return;
    gate.inFlight -= 1;
    if (gate.inFlight !== 0) return;
    for (const resolve of gate.drainWaiters) resolve();
    gate.drainWaiters.clear();
  }

  private waitForGateDrain(gate: PrincipalGate): Promise<void> {
    if (gate.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => gate.drainWaiters.add(resolve));
  }

  private createLease(principalKey: string, runtime: LocalRuntime): LocalRuntimeLease | null {
    const gate = this.gateFor(principalKey);
    if (!gate.open || gate.tombstoned) return null;
    gate.inFlight += 1;
    const epoch = gate.epoch;
    let released = false;
    return {
      runtime,
      principalKey,
      epoch,
      release: () => {
        if (released) return;
        released = true;
        this.releaseGate(gate);
      },
    };
  }

  bindSession(principalKey: string, sessionId: string): void {
    const gate = this.principalGates.get(principalKey);
    if (gate && (!gate.open || gate.tombstoned)) return;
    this.sessionToUser.set(sessionId, principalKey);
  }

  async handleAgentBrowserControlEvent(event: AgentBrowserControlEvent): Promise<boolean> {
    for (const [sessionId, principalKey] of this.sessionToUser) {
      if (agentBrowserSessionName(sessionId) !== event.ownerSessionId) continue;
      const runtime = this.runtimes.get(principalKey);
      if (!runtime) return false;
      if (event.action === "takeover") {
        await runtime.browserControl.takeOver(sessionId, event.pendingActionRisk);
      } else {
        await runtime.browserControl.stop(sessionId);
      }
      return true;
    }
    return false;
  }

  private addKnownUserRoots(uuid: string, quota: UserDiskQuota, currentRoot: string): void {
    quota.addRoot(getUserDataRoot(uuid));
    quota.addRoot(currentRoot);
    const tenantsRoot = getTenantsDataRoot();
    for (const tenant of readdirSync(tenantsRoot, { withFileTypes: true })) {
      if (!tenant.isDirectory() || tenant.isSymbolicLink()) continue;
      const candidate = join(tenantsRoot, tenant.name, "users", uuid);
      if (!existsSync(candidate)) continue;
      try {
        const info = lstatSync(candidate);
        if (info.isDirectory() && !info.isSymbolicLink()) quota.addRoot(candidate);
      } catch {}
    }
  }

  private getUserResources(uuid: string, currentRoot: string): UserRuntimeResources {
    const existing = this.resourcesByUser.get(uuid);
    if (existing) {
      existing.diskQuota.addRoot(currentRoot);
      void existing.monitor?.checkNow().catch(() => undefined);
      return existing;
    }
    const diskQuota = new UserDiskQuota({
      maxBytes: environment.number(ENV.PIWORK_USER_DISK_QUOTA_BYTES, DEFAULT_USER_DISK_QUOTA_BYTES),
      reservedHeadroomBytes: environment.number(
        ENV.PIWORK_USER_DISK_LAUNCH_HEADROOM_BYTES,
        DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES,
      ),
    });
    this.addKnownUserRoots(uuid, diskQuota, currentRoot);
    const resources: UserRuntimeResources = {
      governor: new UserResourceGovernor({
        maxConcurrentSessions: environment.number(
          ENV.PIWORK_MAX_CONCURRENT_SESSIONS,
          DEFAULT_USER_RESOURCE_LIMITS.maxConcurrentSessions,
        ),
        maxManagedProcesses: environment.number(
          ENV.PIWORK_MAX_MANAGED_PROCESSES,
          DEFAULT_USER_RESOURCE_LIMITS.maxManagedProcesses,
        ),
      }),
      diskQuota,
      monitor: null,
      stoppingForQuota: null,
    };
    this.resourcesByUser.set(uuid, resources);
    resources.monitor = diskQuota.startMonitoring(
      (snapshot) => this.stopUserManagedProcessesForQuota(uuid, snapshot),
      environment.number(
        ENV.PIWORK_USER_DISK_MONITOR_INTERVAL_MS,
        DEFAULT_USER_DISK_MONITOR_INTERVAL_MS,
      ),
    );
    return resources;
  }

  private stopUserManagedProcessesForQuota(
    uuid: string,
    snapshot: DiskUsageSnapshot,
  ): Promise<void> {
    const resources = this.resourcesByUser.get(uuid);
    if (!resources) return Promise.resolve();
    if (resources.stoppingForQuota) return resources.stoppingForQuota;
    const runtimes = [...this.runtimes.values()].filter((runtime) => runtime.user.uuid === uuid);
    console.error(
      `[local-runtime] Disk quota exceeded for ${uuid} ` +
        `(${snapshot.usedBytes + snapshot.reservedBytes}/${snapshot.maxBytes}); ` +
        "stopping managed Pi processes.",
    );
    const stopping = Promise.allSettled(
      runtimes.map((runtime) => runtime.launcher.killAll({ shutdown: false })),
    )
      .then(() => undefined)
      .finally(() => {
        if (resources.stoppingForQuota === stopping) {
          resources.stoppingForQuota = null;
        }
      });
    resources.stoppingForQuota = stopping;
    return stopping;
  }

  private getOrCreateRuntime(user: AuthenticatedUser): LocalRuntime {
    const uuid = uuidFromUser(user);
    const key = runtimeKey(user);
    const userRoot = user.tenantId
      ? getTenantUserDataRoot(user.tenantId, uuid)
      : getUserDataRoot(uuid);
    const userResources = this.getUserResources(uuid, userRoot);
    const existing = this.runtimes.get(key);
    if (existing) {
      existing.user = { ...user, uuid };
      return existing;
    }
    if (!this.internalTransport?.unixSocketPath && !this.internalTransport?.tls) {
      throw new Error("Protected internal file transport is unavailable");
    }

    const fullUser = { ...user, uuid };
    let runtimeRef: LocalRuntime | null = null;
    const profileRoot = user.tenantId ? join(userRoot, "profile") : userRoot;
    const sessionsRoot = user.tenantId ? join(userRoot, "sessions") : userRoot;
    const tenantRoot = user.tenantId ? getTenantDataRoot(user.tenantId) : userRoot;
    const sessionDirFor = (sessionId: string) =>
      user.tenantId
        ? getTenantSessionDir(user.tenantId, uuid, sessionId)
        : getSessionDir(uuid, sessionId);
    const userSkillsRoot = user.tenantId
      ? getTenantUserPiSkillsRoot(user.tenantId, uuid)
      : getUserPiSkillsRoot(uuid);
    try {
      new UserDataReconciler(sessionsRoot).reconcile();
    } catch (error) {
      console.error("[local-runtime] User data reconciliation failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }

    const sessionStore = new SessionStore(sessionsRoot, {
      layout: "session-dir",
    });
    const wsBridge = new WsBridge();
    const launcher = new PiLauncher();
    const recorder = new RecorderManager({
      recordingsDir: sessionsRoot,
      recordingsDirForSession: (sessionId) => join(sessionDirFor(sessionId), "recordings"),
      diskQuota: userResources.diskQuota,
    });
    const userSpaceBroker = new UserSpaceBroker(
      (sessionId) => join(sessionDirFor(sessionId), "user-space-checkouts"),
      (sessionId) => launcher.getSandboxedGeneration(sessionId),
      userResources.diskQuota,
    );
    const onlyOfficeBroker = new OnlyOfficeBroker();
    const workspaceStateStore = new WorkspaceStateStore(
      user.tenantId ? join(profileRoot, "workspace-state.json") : getUserSpaceStatePath(uuid),
    );
    const sessionNameStore = new SessionNameStore(
      join(profileRoot, "session-names.json"),
      userResources.diskQuota,
    );
    const launchBuilder = new PiLaunchOptionsBuilder({
      dataRoot: this.dataRoot,
      tenantRoot,
      sessionDirFor,
      migratedUserSkillsRoot: userSkillsRoot,
      internalTransport: this.internalTransport,
      providerVault: this.providerVault,
      issueUserSpaceCapability: (sessionId) => userSpaceBroker.issueInternalCapability(sessionId),
      controlPlane: this.controlPlane,
      runtimeObserverForSession: ({ recordingSessionId, cwd }) =>
        createPiRecordingObserver({
          recorder,
          recordingSessionId,
          cwd,
        }),
      registerRecordingSensitiveValues: (recordingSessionId, values) =>
        recorder.addSensitiveValues(recordingSessionId, values),
      onTaskEvent: (sessionId, event) => {
        const status =
          event.status === "completed"
            ? "completed"
            : event.status === "failed"
              ? "failed"
              : event.status === "stopped"
                ? "cancelled"
                : "running";
        wsBridge.broadcastToSession(sessionId, {
          type: "tool_execution",
          generation: typeof event.generation === "number" ? event.generation : 0,
          toolCallId: String(event.originToolCallId || event.taskId || "unknown"),
          toolName: "task",
          status,
          timestamp: Date.now(),
          progress: typeof event.progress === "string" ? event.progress : undefined,
          task: {
            taskId: String(event.taskId || ""),
            ...(typeof event.originToolCallId === "string"
              ? { originatingToolCallId: event.originToolCallId }
              : {}),
            name: "Managed Pi task",
            ...(typeof event.description === "string" ? { description: event.description } : {}),
            execution: event.background ? "background" : "foreground",
            status:
              event.status === "starting"
                ? "running"
                : (event.status as "running" | "completed" | "failed" | "stopped"),
            depth: typeof event.depth === "number" ? event.depth : 1,
            progress: typeof event.progress === "string" ? event.progress : undefined,
            ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
            ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
          },
        });
      },
    });

    wsBridge.setStore(sessionStore);
    wsBridge.setRecorder(recorder);
    wsBridge.setUserSpaceBroker(userSpaceBroker);
    wsBridge.setOnlyOfficeBroker(onlyOfficeBroker);
    wsBridge.setCurrentWorkspaceSessionResolver(
      () => workspaceStateStore.get().currentSessionId ?? null,
    );

    const browserControl = createBrowserControlRuntime({
      agentBrowserBridge: this.agentBrowserBridge,
      messageBridge: wsBridge,
      sessionDirFor,
    });
    const resourceLeases = new Map<string, ResourceLease>();
    const orchestrator = new SessionOrchestrator({
      launcher,
      wsBridge,
      sessionStore,
      sessionNameStore,
      browserSessionCleanup: (sessionId) => browserControl.stop(sessionId).then(() => undefined),
      onRuntimeStopped: async (sessionId) => {
        resourceLeases.get(sessionId)?.release();
        resourceLeases.delete(sessionId);
        await Promise.all([
          userSpaceBroker.revokeRuntimeGeneration(sessionId, "pi_runtime_stopped"),
          onlyOfficeBroker.revokeRuntimeGeneration(sessionId),
        ]);
      },
      buildLaunchOptions: async (sessionId, generation, context) => {
        userResources.diskQuota.assertLaunchAllowed();
        const lease = userResources.governor.reservePiProcess(
          sessionId,
          `${sessionId}:${generation}`,
        );
        try {
          const options = await launchBuilder.build(sessionId, generation, context);
          const previousExit = options.onExit;
          options.onExit = (info) => {
            previousExit?.(info);
            resourceLeases.get(sessionId)?.release();
            resourceLeases.delete(sessionId);
            void userSpaceBroker.revokeRuntimeGeneration(sessionId, "pi_process_exit");
            void onlyOfficeBroker.revokeRuntimeGeneration(sessionId);
          };
          resourceLeases.get(sessionId)?.release();
          resourceLeases.set(sessionId, lease);
          return options;
        } catch (error) {
          lease.release();
          throw error;
        }
      },
    });
    const publishMcpStatus = (sessionId: string): void => {
      wsBridge.broadcastToSession(sessionId, {
        type: "mcp_status",
        servers: publicMcpDetails(launchBuilder.mcpDetails(sessionId)),
      });
    };
    wsBridge.setControlHandler(
      async (sessionId: string, message: PiBridgeControlMessage): Promise<boolean> => {
        switch (message.type) {
          case "set_model": {
            if (!launchBuilder.isModelEffective(sessionId, message.model)) {
              return false;
            }
            return (
              wsBridge.getSession(sessionId)?.piAdapter?.send({
                type: "set_model",
                model: {
                  provider: message.model.provider,
                  modelId: message.model.modelId,
                },
              }) ?? false
            );
          }
          case "retry": {
            const transport = launcher.getTransport(sessionId);
            if (!transport) return false;
            await transport.retry();
            return true;
          }
          case "set_mode": {
            const transport = launcher.getTransport(sessionId);
            if (!transport) return false;
            await transport.prompt(`/piwork-${message.mode}`);
            return true;
          }
          case "mcp_get_status":
            publishMcpStatus(sessionId);
            return true;
          case "mcp_toggle":
            await launchBuilder.setMcpEnabled(sessionId, message.serverName, message.enabled);
            publishMcpStatus(sessionId);
            return true;
          case "mcp_reconnect":
            await launchBuilder.reconnectMcp(sessionId, message.serverName);
            publishMcpStatus(sessionId);
            return true;
          case "stop_task":
            await launchBuilder.stopTask(sessionId, message.taskId);
            return true;
          case "end_session":
            return (await orchestrator.killSession(sessionId)).ok;
        }
      },
    );
    orchestrator.initialize();
    for (const session of launcher.listSessions()) {
      this.bindSession(key, session.sessionId);
    }

    const api = new Hono();
    registerRequestContext(api, {
      getUserId: () => runtimeRef?.user.uuid || fullUser.uuid,
    });
    api.route(
      "/api",
      createRoutes(
        orchestrator,
        launcher,
        wsBridge,
        recorder,
        this._port,
        userSpaceBroker,
        workspaceStateStore,
        sessionNameStore,
        {
          getCurrentUser: () => runtimeRef?.user || fullUser,
          rbac: this.rbac,
          controlPlane: this.controlPlane,
          runtimeDriver: this.runtimeDriver,
          diskQuota: userResources.diskQuota,
          agentBrowserBridge: this.agentBrowserBridge,
          browserControl,
          providerVault: this.providerVault,
          launchBuilder,
          onSessionBound: (sessionId) => this.bindSession(key, sessionId),
        },
      ),
    );

    const internal = new Hono();
    registerUserSpaceInternalTransferRoutes(internal, userSpaceBroker);
    registerOnlyOfficeInternalRoutes(internal, onlyOfficeBroker, userSpaceBroker);
    const agentBrowserBridge = this.agentBrowserBridge;
    let disposePromise: Promise<void> | null = null;
    const runtime: LocalRuntime = {
      user: fullUser,
      api,
      internal,
      wsBridge,
      launcher,
      launchBuilder,
      sessionStore,
      recorder,
      browserControl,
      async dispose() {
        disposePromise ??= disposeLocalRuntimeComponents({
          orchestrator,
          launcher,
          launchBuilder,
          userSpaceBroker,
          onlyOfficeBroker,
          wsBridge,
          sessionStore,
          recorder,
          browserSessions: agentBrowserBridge
            ? {
                closeAll: async () => {
                  await Promise.all(
                    launcher
                      .listSessions()
                      .map((session) =>
                        browserControl.stop(session.sessionId).then(() => undefined),
                      ),
                  );
                },
              }
            : undefined,
        }).finally(() => {
          for (const lease of resourceLeases.values()) lease.release();
          resourceLeases.clear();
        });
        return disposePromise;
      },
    };
    runtimeRef = runtime;
    this.runtimes.set(key, runtime);
    console.log(`[local-runtime] Native Pi ready for ${fullUser.username} (${uuid})`);
    return runtime;
  }

  acquirePrincipal(user: AuthenticatedUser): LocalRuntimeLease | null {
    const key = runtimeKey(user);
    const gate = this.gateFor(key);
    if (!gate.open || gate.tombstoned) return null;
    return this.createLease(key, this.getOrCreateRuntime(user));
  }

  acquireSession(sessionId: string): LocalRuntimeLease | null {
    const key = this.sessionToUser.get(sessionId);
    if (!key) return null;
    const runtime = this.runtimes.get(key);
    return runtime ? this.createLease(key, runtime) : null;
  }

  getRuntimeForSession(sessionId: string): LocalRuntime | null {
    const key = this.sessionToUser.get(sessionId);
    if (!key) return null;
    const gate = this.principalGates.get(key);
    if (gate && (!gate.open || gate.tombstoned)) return null;
    return this.runtimes.get(key) || null;
  }

  async revokePrincipal(tenantId: string, uuid: string): Promise<void> {
    const key = `${tenantId}:${uuid}`;
    const gate = this.gateFor(key);
    if (gate.revocation) return gate.revocation;
    if (gate.tombstoned && !gate.open) return;
    gate.open = false;
    gate.tombstoned = true;
    gate.epoch += 1;
    const runtime = this.runtimes.get(key);
    this.runtimes.delete(key);
    for (const [sessionId, ownerKey] of this.sessionToUser) {
      if (ownerKey === key) this.sessionToUser.delete(sessionId);
    }
    const revocation =
      gate.inFlight === 0
        ? runtime?.dispose() || Promise.resolve()
        : (async () => {
            await this.waitForGateDrain(gate);
            if (runtime) await runtime.dispose();
          })();
    gate.revocation = revocation;
    try {
      await revocation;
    } finally {
      if (gate.revocation === revocation) gate.revocation = null;
    }
  }

  async activatePrincipal(tenantId: string, uuid: string): Promise<void> {
    const gate = this.gateFor(`${tenantId}:${uuid}`);
    if (gate.revocation) await gate.revocation;
    if (!gate.tombstoned && gate.open) return;
    gate.epoch += 1;
    gate.tombstoned = false;
    gate.open = true;
  }

  async dispose(): Promise<void> {
    const runtimeEntries = [...this.runtimes.entries()];
    const pendingRevocations = [...this.principalGates.values()]
      .map((gate) => gate.revocation)
      .filter((promise): promise is Promise<void> => promise !== null);
    const resources = [...this.resourcesByUser.values()];
    for (const resource of resources) resource.monitor?.stop();
    for (const [key] of runtimeEntries) {
      const gate = this.gateFor(key);
      gate.open = false;
      gate.tombstoned = true;
      gate.epoch += 1;
    }
    this.runtimes.clear();
    this.sessionToUser.clear();
    this.resourcesByUser.clear();
    const settled = await Promise.allSettled([
      ...pendingRevocations,
      ...runtimeEntries.map(async ([key, runtime]) => {
        await this.waitForGateDrain(this.gateFor(key));
        await runtime.dispose();
      }),
      ...resources
        .map((resource) => resource.stoppingForQuota)
        .filter((promise): promise is Promise<void> => promise !== null),
    ]);
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Local Pi runtime registry disposal did not complete cleanly",
      );
    }
  }
}
