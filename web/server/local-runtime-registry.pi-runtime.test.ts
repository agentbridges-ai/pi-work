import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "./auth-types.js";

const fakes = vi.hoisted(() => ({
  root: `/tmp/piwork-local-runtime-registry-${process.pid}`,
  launchers: [] as Array<Record<string, unknown>>,
  bridges: [] as Array<Record<string, unknown>>,
  builders: [] as Array<Record<string, unknown>>,
  orchestrators: [] as Array<Record<string, unknown>>,
  userSpaceBrokers: [] as Array<Record<string, unknown>>,
  onlyOfficeBrokers: [] as Array<Record<string, unknown>>,
  governors: [] as Array<Record<string, unknown>>,
  quotas: [] as Array<Record<string, unknown>>,
}));

vi.mock("./local-paths.js", () => ({
  getLocalDataRoot: () => fakes.root,
  getTenantsDataRoot: () => `${fakes.root}/tenants`,
  getTenantDataRoot: (tenantId: string) => `${fakes.root}/tenants/${tenantId}`,
  getTenantUserDataRoot: (tenantId: string, uuid: string) =>
    `${fakes.root}/tenants/${tenantId}/users/${uuid}`,
  getTenantUserPiSkillsRoot: (tenantId: string, uuid: string) =>
    `${fakes.root}/tenants/${tenantId}/users/${uuid}/pi-resources/skills`,
  getTenantSessionDir: (tenantId: string, uuid: string, sessionId: string) =>
    `${fakes.root}/tenants/${tenantId}/users/${uuid}/sessions/${sessionId}`,
  getUserDataRoot: (uuid: string) => `${fakes.root}/users/${uuid}`,
  getUserPiSkillsRoot: (uuid: string) => `${fakes.root}/users/${uuid}/pi-resources/skills`,
  getSessionDir: (uuid: string, sessionId: string) => `${fakes.root}/users/${uuid}/${sessionId}`,
  getUserSpaceStatePath: (uuid: string) => `${fakes.root}/users/${uuid}/workspace-state.json`,
}));

vi.mock("./resource-governor.js", () => ({
  DEFAULT_USER_RESOURCE_LIMITS: {
    maxConcurrentSessions: 4,
    maxManagedProcesses: 16,
  },
  UserResourceGovernor: class {
    reservePiProcess = vi.fn(() => ({ release: vi.fn() }));

    constructor(options: unknown) {
      Object.assign(this, { options });
      fakes.governors.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./user-disk-quota.js", () => ({
  DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES: 1024,
  DEFAULT_USER_DISK_MONITOR_INTERVAL_MS: 1000,
  DEFAULT_USER_DISK_QUOTA_BYTES: 1024 * 1024,
  UserDiskQuota: class {
    roots: string[] = [];
    monitor = { stop: vi.fn(), checkNow: vi.fn(async () => undefined) };
    addRoot = vi.fn((root: string) => this.roots.push(root));
    assertLaunchAllowed = vi.fn();
    startMonitoring = vi.fn((callback: (snapshot: unknown) => Promise<void>, interval: number) => {
      Object.assign(this, { callback, interval });
      return this.monitor;
    });

    constructor(options: unknown) {
      Object.assign(this, { options });
      fakes.quotas.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./pi-launcher.js", () => ({
  PiLauncher: class {
    transports = new Map<string, unknown>();
    listSessions = vi.fn(() => []);
    getTransport = vi.fn((sessionId: string) => this.transports.get(sessionId));
    getSandboxedGeneration = vi.fn(() => 1);
    killAll = vi.fn(async () => undefined);

    constructor() {
      fakes.launchers.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./ws-bridge.js", () => ({
  WsBridge: class {
    controlHandler?: (sessionId: string, message: Record<string, unknown>) => Promise<boolean>;
    session: unknown;
    setStore = vi.fn();
    setRecorder = vi.fn();
    setUserSpaceBroker = vi.fn();
    setOnlyOfficeBroker = vi.fn();
    setCurrentWorkspaceSessionResolver = vi.fn();
    setControlHandler = vi.fn(
      (handler: (sessionId: string, message: Record<string, unknown>) => Promise<boolean>) => {
        this.controlHandler = handler;
      },
    );
    broadcastToSession = vi.fn();
    getSession = vi.fn(() => this.session);
    dispose = vi.fn(async () => undefined);

    constructor() {
      fakes.bridges.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./pi-launch-options-builder.js", () => ({
  PiLaunchOptionsBuilder: class {
    options: Record<string, unknown>;
    nextBuild: Record<string, unknown> | (() => Promise<Record<string, unknown>>) | undefined;
    details: unknown[] = [];
    effective = true;
    build = vi.fn(async () => {
      if (typeof this.nextBuild === "function") return this.nextBuild();
      return (
        this.nextBuild ?? {
          sessionId: "session-1",
          onExit: vi.fn(),
        }
      );
    });
    mcpDetails = vi.fn(() => this.details);
    isModelEffective = vi.fn(() => this.effective);
    setMcpEnabled = vi.fn(async () => undefined);
    reconnectMcp = vi.fn(async () => undefined);
    stopTask = vi.fn(async () => undefined);
    dispose = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakes.builders.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./session-orchestrator.js", () => ({
  SessionOrchestrator: class {
    options: Record<string, unknown>;
    initialize = vi.fn();
    shutdown = vi.fn();
    killSession = vi.fn(async () => ({ ok: true }));
    getLifecycleState = vi.fn(() => "enabled");
    getRuntimeState = vi.fn(() => ({ state: "ready" }));
    hasSessionData = vi.fn(() => false);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakes.orchestrators.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock("./session-store.js", () => ({
  SessionStore: class {
    dispose = vi.fn();
  },
}));

vi.mock("./recorder.js", () => ({
  RecorderManager: class {
    addSensitiveValues = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("./user-space-broker.js", () => ({
  UserSpaceBroker: class {
    issueInternalCapability = vi.fn(() => "user-space-capability");
    revokeRuntimeGeneration = vi.fn(async () => undefined);
    dispose = vi.fn();

    constructor() {
      fakes.userSpaceBrokers.push(this as unknown as Record<string, unknown>);
    }
  },
  registerUserSpaceInternalTransferRoutes: vi.fn(),
  registerUserSpaceTransferRoutes: vi.fn(),
}));

vi.mock("./onlyoffice-broker.js", () => ({
  OnlyOfficeBroker: class {
    revokeRuntimeGeneration = vi.fn(async () => undefined);
    dispose = vi.fn();

    constructor() {
      fakes.onlyOfficeBrokers.push(this as unknown as Record<string, unknown>);
    }
  },
  registerOnlyOfficeInternalRoutes: vi.fn(),
}));

vi.mock("./workspace-state-store.js", () => ({
  WorkspaceStateStore: class {
    get = vi.fn(() => ({
      selectedAgentId: "agent",
      currentSessionId: null,
      agentSessionIds: {},
      agentSessionHistoryIds: {},
      agentUserSpaces: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
  },
}));

vi.mock("./session-names.js", () => ({
  SessionNameStore: class {
    getAllNames = vi.fn(() => ({}));
  },
}));

vi.mock("./user-data-reconciler.js", () => ({
  UserDataReconciler: class {
    reconcile = vi.fn();
  },
}));

vi.mock("./browser-control-runtime.js", () => ({
  createBrowserControlRuntime: vi.fn(() => ({
    takeOver: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  })),
}));

vi.mock("./pi-recording-observer.js", () => ({
  createPiRecordingObserver: vi.fn(() => ({ record: vi.fn() })),
}));

import { LocalRuntimeRegistry } from "./local-runtime-registry.js";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: "user-1",
    uuid: "user-uuid",
    username: "alice",
    displayName: "Alice",
    orgId: "tenant-1",
    orgName: "Tenant",
    tenantId: "tenant-1",
    roles: [],
    permissions: [],
    departments: [],
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(`${fakes.root}/tenants`, { recursive: true });
});

afterEach(() => {
  for (const list of [
    fakes.launchers,
    fakes.bridges,
    fakes.builders,
    fakes.orchestrators,
    fakes.userSpaceBrokers,
    fakes.onlyOfficeBrokers,
    fakes.governors,
    fakes.quotas,
  ]) {
    list.splice(0);
  }
  rmSync(fakes.root, { recursive: true, force: true });
});

describe("LocalRuntimeRegistry native Pi runtime", () => {
  it("requires an authenticated uuid and protected internal transport", async () => {
    const registry = new LocalRuntimeRegistry(3456);
    expect(() => registry.acquirePrincipal(user({ uuid: " " }))).toThrow(
      "Authenticated user is missing uuid",
    );
    expect(() => registry.acquirePrincipal(user())).toThrow(
      "Protected internal file transport is unavailable",
    );
    await registry.dispose();
    expect(
      (fakes.quotas[0]!.monitor as { stop: ReturnType<typeof vi.fn> }).stop,
    ).toHaveBeenCalled();
  });

  it("creates one tenant Pi runtime and reuses it under the active principal gate", async () => {
    const registry = new LocalRuntimeRegistry(3456, undefined, undefined, undefined, undefined, {
      internalTransport: { unixSocketPath: "/tmp/internal.sock" },
      dataRoot: fakes.root,
    });
    const first = registry.acquirePrincipal(user());
    expect(first).not.toBeNull();
    expect(first!.runtime).toMatchObject({
      user: { uuid: "user-uuid", tenantId: "tenant-1" },
      launcher: fakes.launchers[0],
      launchBuilder: fakes.builders[0],
    });
    expect(fakes.orchestrators[0]!.initialize).toHaveBeenCalledOnce();
    expect(fakes.builders[0]!.options).toMatchObject({
      dataRoot: fakes.root,
      tenantRoot: `${fakes.root}/tenants/tenant-1`,
      internalTransport: { unixSocketPath: "/tmp/internal.sock" },
    });

    first!.release();
    const second = registry.acquirePrincipal(user({ displayName: "Alice Updated" }));
    expect(second!.runtime).toBe(first!.runtime);
    expect(second!.runtime.user.displayName).toBe("Alice Updated");
    expect(fakes.builders).toHaveLength(1);
    expect(
      (fakes.quotas[0]!.monitor as { checkNow: ReturnType<typeof vi.fn> }).checkNow,
    ).toHaveBeenCalled();
    second!.release();
    await registry.dispose();
  });

  it("stops managed processes when the user disk quota monitor reports an overage", async () => {
    const registry = new LocalRuntimeRegistry(3456, undefined, undefined, undefined, undefined, {
      internalTransport: { unixSocketPath: "/tmp/internal.sock" },
      dataRoot: fakes.root,
    });
    const principal = registry.acquirePrincipal(user())!;
    const quota = fakes.quotas[0] as {
      callback: (snapshot: unknown) => Promise<void>;
    };

    await quota.callback({
      usedBytes: 2_048,
      reservedBytes: 0,
      maxBytes: 1_024,
    });

    expect(
      (fakes.launchers[0] as { killAll: ReturnType<typeof vi.fn> }).killAll,
    ).toHaveBeenCalledWith({ shutdown: false });
    principal.release();
    await registry.dispose();
  });

  it("reserves one process lease per generation and releases it on every terminal path", async () => {
    const registry = new LocalRuntimeRegistry(3456, undefined, undefined, undefined, undefined, {
      internalTransport: { unixSocketPath: "/tmp/internal.sock" },
      dataRoot: fakes.root,
    });
    const principal = registry.acquirePrincipal(user())!;
    const orchestratorOptions = fakes.orchestrators[0]!.options as Record<string, unknown>;
    const build = orchestratorOptions.buildLaunchOptions as (
      sessionId: string,
      generation: number,
      context: unknown,
    ) => Promise<{ onExit?: (info: unknown) => void }>;
    const governor = fakes.governors[0] as {
      reservePiProcess: ReturnType<typeof vi.fn>;
    };

    const firstLease = { release: vi.fn() };
    governor.reservePiProcess.mockReturnValueOnce(firstLease);
    const originalExit = vi.fn();
    fakes.builders[0]!.nextBuild = { sessionId: "session-1", onExit: originalExit };
    const launch = await build("session-1", 7, {});
    expect(governor.reservePiProcess).toHaveBeenCalledWith("session-1", "session-1:7");
    launch.onExit?.({});
    expect(originalExit).toHaveBeenCalledOnce();
    expect(firstLease.release).toHaveBeenCalledOnce();
    expect(fakes.userSpaceBrokers[0]!.revokeRuntimeGeneration).toHaveBeenCalledWith(
      "session-1",
      "pi_process_exit",
    );

    const failedLease = { release: vi.fn() };
    governor.reservePiProcess.mockReturnValueOnce(failedLease);
    fakes.builders[0]!.nextBuild = async () => {
      throw new Error("build failed");
    };
    await expect(build("session-2", 1, {})).rejects.toThrow("build failed");
    expect(failedLease.release).toHaveBeenCalledOnce();

    const stoppedLease = { release: vi.fn() };
    governor.reservePiProcess.mockReturnValueOnce(stoppedLease);
    fakes.builders[0]!.nextBuild = { sessionId: "session-3" };
    await build("session-3", 1, {});
    await (orchestratorOptions.onRuntimeStopped as (sessionId: string) => Promise<void>)(
      "session-3",
    );
    expect(stoppedLease.release).toHaveBeenCalledOnce();
    expect(fakes.onlyOfficeBrokers[0]!.revokeRuntimeGeneration).toHaveBeenCalledWith("session-3");

    principal.release();
    await registry.dispose();
  });

  it("translates task events and handles every native Pi control message fail closed", async () => {
    const registry = new LocalRuntimeRegistry(3456, undefined, undefined, undefined, undefined, {
      internalTransport: { unixSocketPath: "/tmp/internal.sock" },
      dataRoot: fakes.root,
    });
    const principal = registry.acquirePrincipal(user())!;
    const builder = fakes.builders[0] as {
      options: Record<string, unknown>;
      details: unknown[];
      effective: boolean;
      setMcpEnabled: ReturnType<typeof vi.fn>;
      reconnectMcp: ReturnType<typeof vi.fn>;
      stopTask: ReturnType<typeof vi.fn>;
    };
    const bridge = fakes.bridges[0] as {
      controlHandler: (sessionId: string, message: Record<string, unknown>) => Promise<boolean>;
      broadcastToSession: ReturnType<typeof vi.fn>;
      session: unknown;
    };
    const launcher = fakes.launchers[0] as {
      transports: Map<string, unknown>;
    };
    const onTaskEvent = builder.options.onTaskEvent as (
      sessionId: string,
      event: Record<string, unknown>,
    ) => void;
    for (const status of ["starting", "completed", "failed", "stopped", "running"]) {
      onTaskEvent("session-1", {
        status,
        taskId: "task-1",
        generation: 3,
        background: true,
        depth: 2,
        progress: "halfway",
      });
    }
    expect(bridge.broadcastToSession).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        type: "tool_execution",
        generation: 3,
        task: expect.objectContaining({
          execution: "background",
          depth: 2,
          progress: "halfway",
        }),
      }),
    );

    const handler = bridge.controlHandler;
    const model = { key: "openai/model", provider: "openai", modelId: "model" };
    builder.effective = false;
    await expect(handler("session-1", { type: "set_model", model })).resolves.toBe(false);
    const send = vi.fn(() => true);
    builder.effective = true;
    bridge.session = { piAdapter: { send } };
    await expect(handler("session-1", { type: "set_model", model })).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: "set_model",
      model: { provider: "openai", modelId: "model" },
    });

    await expect(handler("session-1", { type: "retry" })).resolves.toBe(false);
    const retry = vi.fn(async () => undefined);
    const prompt = vi.fn(async () => undefined);
    launcher.transports.set("session-1", { retry, prompt });
    await expect(handler("session-1", { type: "retry" })).resolves.toBe(true);
    await expect(handler("session-1", { type: "set_mode", mode: "plan" })).resolves.toBe(true);
    expect(retry).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("/piwork-plan");

    builder.details = [
      {
        name: "docs",
        enabled: true,
        status: "connected",
        serverInfo: { name: "docs", version: "1" },
        error: "last reconnect failed",
        config: {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.js"],
          url: "https://mcp.example.com",
        },
        tools: [{ name: "search", readOnly: true }],
      },
    ];
    await expect(handler("session-1", { type: "mcp_get_status" })).resolves.toBe(true);
    await expect(
      handler("session-1", {
        type: "mcp_toggle",
        serverName: "docs",
        enabled: false,
      }),
    ).resolves.toBe(true);
    await expect(handler("session-1", { type: "mcp_reconnect", serverName: "docs" })).resolves.toBe(
      true,
    );
    await expect(handler("session-1", { type: "stop_task", taskId: "task-1" })).resolves.toBe(true);
    await expect(handler("session-1", { type: "end_session" })).resolves.toBe(true);
    expect(builder.setMcpEnabled).toHaveBeenCalledWith("session-1", "docs", false);
    expect(builder.reconnectMcp).toHaveBeenCalledWith("session-1", "docs");
    expect(builder.stopTask).toHaveBeenCalledWith("session-1", "task-1");
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "mcp_status",
        servers: [
          expect.objectContaining({
            name: "docs",
            config: {
              type: "stdio",
              command: "/usr/bin/node",
              args: ["server.js"],
              url: "https://mcp.example.com",
            },
            tools: [{ name: "search", annotations: { readOnly: true } }],
          }),
        ],
      }),
    );

    principal.release();
    await registry.dispose();
  });
});
