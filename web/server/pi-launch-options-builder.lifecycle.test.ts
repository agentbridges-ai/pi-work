import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderBootstrap } from "./pi-bootstrap-channel.js";
import type { ResolvedPiSandbox, SessionLaunchContext } from "./session-orchestrator-contract.js";

const fakes = vi.hoisted(() => ({
  brokerInstances: [] as Array<{
    options: Record<string, unknown>;
    start: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    details: ReturnType<typeof vi.fn>;
    setMcpEnabled: ReturnType<typeof vi.fn>;
    reconnectMcp: ReturnType<typeof vi.fn>;
    capability: string;
    mcpState: ReturnType<typeof vi.fn>;
    taskEndpoint: ReturnType<typeof vi.fn>;
    mcpEndpoint: ReturnType<typeof vi.fn>;
    sensitiveValuesForRedaction: ReturnType<typeof vi.fn>;
  }>,
  taskInstances: [] as Array<{
    options: Record<string, unknown>;
    handle: ReturnType<typeof vi.fn>;
    setRootMode: ReturnType<typeof vi.fn>;
    stopTask: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  prepare: vi.fn(),
}));

vi.mock("./pi-session-preparer.js", () => ({
  PiSessionPreparer: class {
    prepare = fakes.prepare;
  },
}));

vi.mock("./pi-runtime-brokers.js", () => ({
  PiRuntimeBrokers: class {
    options: Record<string, unknown>;
    start = vi.fn(async () => undefined);
    dispose = vi.fn(async () => undefined);
    details = vi.fn(() => [{ name: "docs", state: "connected" }]);
    setMcpEnabled = vi.fn(async () => undefined);
    reconnectMcp = vi.fn(async () => undefined);
    capability = "broker-capability";
    mcpState = vi.fn(() => [{ name: "docs", transport: "stdio", enabled: true }]);
    taskEndpoint = vi.fn(() => ({ socketPath: "/tmp/task.sock", capability: "task-cap" }));
    mcpEndpoint = vi.fn(() => ({ socketPath: "/tmp/mcp.sock", capability: "mcp-cap" }));
    sensitiveValuesForRedaction = vi.fn(() => ["broker-secret"]);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakes.brokerInstances.push(this);
    }
  },
}));

vi.mock("./pi-task-manager.js", () => ({
  PiTaskManager: class {
    options: Record<string, unknown>;
    handle = vi.fn(async () => ({ ok: true }));
    setRootMode = vi.fn();
    stopTask = vi.fn(async () => undefined);
    dispose = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakes.taskInstances.push(this);
    }
  },
}));

vi.mock("./local-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-paths.js")>()),
  resolveTenantKnowledgePath: (tenantId: string, path: string) =>
    `/managed-knowledge/${tenantId}/${path}`,
}));

import { PiLaunchOptionsBuilder } from "./pi-launch-options-builder.js";
import { PiProviderVault } from "./pi-provider-vault.js";
import { ensurePiRuntimeLayout } from "./pi-runtime-layout.js";
import { ENV } from "./environment.js";
import { nativeHelperService } from "./native-helper.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MODEL = { key: "openai/model", provider: "openai", modelId: "model" };
const roots: string[] = [];

afterEach(async () => {
  fakes.brokerInstances.splice(0);
  fakes.taskInstances.splice(0);
  fakes.prepare.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function provider(): ProviderBootstrap {
  return {
    name: "openai",
    config: {
      apiKey: "provider-secret",
      api: "openai-completions",
      models: [
        { id: "model", name: "Model", reasoning: true },
        { id: "other", name: "Other", reasoning: false },
      ],
    },
  };
}

function sandbox(overrides: Partial<ResolvedPiSandbox> = {}): ResolvedPiSandbox {
  return {
    instructions: "Use managed policy.",
    knowledgeRelativePaths: [],
    domainLayer: null,
    skillFiles: [],
    modelPolicy: {
      modelAllowlist: ["openai/model"],
      defaultModel: MODEL,
      defaultThinkingLevel: "high",
    },
    managedMcpServers: [],
    ...overrides,
  };
}

async function fixture(
  controlPlane?: { resolvePinnedSessionAuthority: ReturnType<typeof vi.fn> },
  overrides: {
    handleApp?: NonNullable<ConstructorParameters<typeof PiLaunchOptionsBuilder>[0]["handleApp"]>;
  } = {},
) {
  const dataRoot = realpathSync(await mkdtemp(join(tmpdir(), "piwork-pi-builder-")));
  roots.push(dataRoot);
  ensurePiRuntimeLayout(dataRoot);
  const tenantRoot = join(dataRoot, "tenants", "tenant-1");
  const sessionRoot = join(tenantRoot, "users", "user-1", "sessions", SESSION_ID);
  await mkdir(sessionRoot, { recursive: true });
  const registerSecrets = vi.fn();
  const onTaskEvent = vi.fn();
  const deliverTaskResult = vi.fn(async () => undefined);
  const handleApp = vi.fn(async (_request: unknown, _context: unknown, scope: unknown) => ({
    ok: true,
    scope,
  }));
  const observer = { record: vi.fn() };
  const runtimeObserverForSession = vi.fn(() => observer);
  fakes.prepare.mockImplementation(({ sessionRoot: root }: { sessionRoot: string }) => ({
    layout: {
      sessionRoot: root,
      workspaceDir: join(root, "workspace"),
      homeDir: join(root, "home"),
      tmpDir: join(root, "tmp"),
      piRuntimeConfigDir: join(root, "pi-config"),
      piSessionsDir: join(root, "pi-sessions"),
      piResourcesDir: join(root, "pi-resources"),
      recordingsDir: join(root, "recordings"),
      userSpaceCheckoutsDir: join(root, "user-space-checkouts"),
    },
    sandboxSettings: { filesystem: { deny: ["/etc"] } },
    managedSkillPaths: [join(root, "pi-resources", "skills", "managed", "SKILL.md")],
    managedSkills: [{ name: "managed", path: "skills/managed/SKILL.md" }],
    taskReadOnlyPaths: [join(root, "pi-resources")],
    userSpaceCapability: "user-space-capability",
    toolEnvironment: {
      PATH: join(root, "bin"),
      PIWORK_INTERNAL_AUTH_TOKEN: "tool-secret",
    },
    sessionBinDir: join(root, "bin"),
  }));
  const builder = new PiLaunchOptionsBuilder({
    dataRoot,
    tenantRoot,
    sessionDirFor: () => sessionRoot,
    internalTransport: { unixSocketPath: "/tmp/internal.sock" },
    providerVault: new PiProviderVault([provider()]),
    issueUserSpaceCapability: () => "issued-user-space-capability",
    nativeHelperOwnerKey: "native-owner",
    controlPlane: controlPlane as never,
    handleApp: overrides.handleApp ?? handleApp,
    registerRecordingSensitiveValues: registerSecrets,
    onTaskEvent,
    deliverTaskResult,
    runtimeObserverForSession: runtimeObserverForSession as never,
  });
  return {
    builder,
    dataRoot,
    tenantRoot,
    sessionRoot,
    registerSecrets,
    onTaskEvent,
    deliverTaskResult,
    handleApp,
    observer,
    runtimeObserverForSession,
  };
}

describe("PiLaunchOptionsBuilder lifecycle", () => {
  it("materializes a native Pi generation and keeps credentials out of launch surfaces", async () => {
    const value = await fixture();
    const context: SessionLaunchContext = {
      request: { model: MODEL, thinkingLevel: "xhigh", mode: "plan", resolvedSandbox: sandbox() },
    };
    const launch = await value.builder.build(SESSION_ID, 4, context);
    expect(launch).toMatchObject({
      sessionId: SESSION_ID,
      sessionRoot: value.sessionRoot,
      workingDirectory: join(value.sessionRoot, "workspace"),
      model: MODEL,
      thinkingLevel: "xhigh",
      mode: "plan",
      bootstrapPayload: {
        version: 1,
        sessionId: SESSION_ID,
        generation: 4,
        mode: "plan",
        instructions: "Use managed policy.",
        managedSkills: [{ name: "managed", path: "skills/managed/SKILL.md" }],
        authorizedRoots: [{ path: join(value.sessionRoot, "workspace"), access: "write" }],
        taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 4 },
      },
    });
    expect(launch.managedSkillPaths).toEqual([
      join(value.sessionRoot, "pi-resources", "skills", "managed", "SKILL.md"),
    ]);
    expect(fakes.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        managedSkillFiles: [],
      }),
    );
    expect(launch.bootstrapPayload.providers[0]?.config.apiKey).toBe("provider-secret");
    expect(launch.sandbox.toolEnvironment).not.toHaveProperty("PIWORK_PI_PROVIDER_KEY");
    expect(JSON.stringify(launch.sandbox)).not.toContain("provider-secret");
    expect(value.runtimeObserverForSession).toHaveBeenCalledWith({
      recordingSessionId: SESSION_ID,
      cwd: join(value.sessionRoot, "workspace"),
    });
    expect(value.registerSecrets).toHaveBeenCalledWith(
      SESSION_ID,
      expect.arrayContaining([
        "provider-secret",
        "broker-secret",
        "broker-capability",
        "user-space-capability",
        "tool-secret",
      ]),
    );
    expect(fakes.brokerInstances[0]!.start).toHaveBeenCalledOnce();
    expect(fakes.taskInstances[0]!.options).toMatchObject({
      rootSessionId: SESSION_ID,
      rootGeneration: 4,
      rootMode: "plan",
      rootModel: MODEL,
      managedSkillPaths: launch.managedSkillPaths,
      managedSkills: launch.bootstrapPayload.managedSkills,
      deliverTaskResult: value.deliverTaskResult,
    });

    const brokerOptions = fakes.brokerInstances[0]!.options;
    expect(() =>
      (brokerOptions.authorizeRemoteUrl as (url: URL) => void)(
        new URL("https://api.openai.com/mcp"),
      ),
    ).not.toThrow();
    expect(() =>
      (brokerOptions.authorizeRemoteUrl as (url: URL) => void)(
        new URL("http://api.openai.com/mcp"),
      ),
    ).toThrow("denied by network policy");
    expect(() =>
      (brokerOptions.authorizeStdio as (config: { command: string }) => void)({
        command: "node",
      }),
    ).toThrow("absolute approved path");
    await expect(
      (brokerOptions.handleTask as (request: unknown, context: unknown) => Promise<unknown>)(
        { prompt: "inspect" },
        {},
      ),
    ).resolves.toEqual({ ok: true });
    (brokerOptions.onModeChange as (mode: string) => void)("agent");
    expect(fakes.taskInstances[0]!.setRootMode).toHaveBeenCalledWith("agent");
    (fakes.taskInstances[0]!.options.onTaskEvent as (event: unknown) => void)({
      type: "task_progress",
    });
    expect(value.onTaskEvent).toHaveBeenCalledWith(SESSION_ID, {
      type: "task_progress",
    });
  });

  it("requires compose authority and forwards App/native-file broker requests", async () => {
    vi.stubEnv(ENV.PIWORK_RUNTIME_MODE, "compose");
    const composeValue = await fixture();
    await expect(
      composeValue.builder.build(SESSION_ID, 1, {
        request: { resolvedSandbox: sandbox() },
      }),
    ).rejects.toThrow("Compose Pi Runtime requires a tenant-scoped Agent authority");
    vi.unstubAllEnvs();

    const value = await fixture();
    const authority = {
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      effectivePolicyHash: "a".repeat(64),
    };
    const context: SessionLaunchContext = {
      request: { resolvedSandbox: sandbox() },
      persisted: {
        id: SESSION_ID,
        authority,
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    };
    const launch = await value.builder.build(SESSION_ID, 5, context);
    expect(launch.runtimeScope).toEqual({
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      sessionId: SESSION_ID,
      generation: 5,
    });
    const brokerOptions = fakes.brokerInstances.at(-1)!.options;
    await expect(
      (brokerOptions.handleApp as (request: unknown, brokerContext: unknown) => Promise<unknown>)(
        { operation: "app.list" },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ ok: true, scope: { generation: 5, sessionId: SESSION_ID } });
    expect(value.handleApp).toHaveBeenCalledWith(
      { operation: "app.list" },
      { signal: expect.any(AbortSignal) },
      expect.objectContaining({ workspaceDir: join(value.sessionRoot, "workspace") }),
    );

    await expect(
      (brokerOptions.handleNativeFile as (request: unknown) => Promise<unknown>)({ payload: null }),
    ).rejects.toThrow("Native file action payload is invalid");
    await expect(
      (brokerOptions.handleNativeFile as (request: unknown) => Promise<unknown>)({
        payload: { action: "file.quickLook", path: "../outside.txt" },
      }),
    ).rejects.toThrow("outside Agent Space");

    const workspaceDir = join(value.sessionRoot, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(join(workspaceDir, "report.txt"), "hello");
    const createFileAction = vi.spyOn(nativeHelperService, "createFileAction").mockResolvedValue({
      id: "native-operation-1",
      action: "file.quickLook",
      state: "completed",
    } as never);
    await expect(
      (brokerOptions.handleNativeFile as (request: unknown) => Promise<unknown>)({
        payload: { action: "file.quickLook", path: "report.txt" },
      }),
    ).resolves.toEqual({
      operationId: "native-operation-1",
      action: "file.quickLook",
      state: "completed",
    });
    expect(createFileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: "native-owner",
        sessionId: SESSION_ID,
        filename: "report.txt",
        source: expect.objectContaining({ path: "report.txt", space: "agent" }),
      }),
    );
    createFileAction.mockRestore();
    launch.onExit?.(sessionInfo(5));
  });

  it("restores Pi state, resolves pinned authority, and disposes superseded generations", async () => {
    const resolvePinnedSessionAuthority = vi.fn(async () => ({
      launch: sandbox({ knowledgeRelativePaths: ["docs"] }),
    }));
    const value = await fixture({ resolvePinnedSessionAuthority });
    await mkdir(join(value.sessionRoot, "workspace"), { recursive: true });
    await mkdir(join(value.sessionRoot, "pi-sessions"), { recursive: true });
    const records = [
      {
        type: "session",
        version: 3,
        id: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: join(value.sessionRoot, "workspace"),
      },
      {
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "openai",
        modelId: "model",
      },
      {
        type: "thinking_level_change",
        id: "thinking-1",
        parentId: "model-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        thinkingLevel: "low",
      },
      {
        type: "custom",
        id: "mode-1",
        parentId: "thinking-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "piwork.mode",
        data: { mode: "plan" },
      },
    ];
    await writeFile(
      join(value.sessionRoot, "pi-sessions", "conversation.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const authority = {
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      effectivePolicyHash: "hash",
    };
    const context: SessionLaunchContext = {
      request: {},
      persisted: {
        id: SESSION_ID,
        authority,
        piSessionRelativePath: "pi-sessions/conversation.jsonl",
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    };
    const first = await value.builder.build(SESSION_ID, 1, context);
    expect(resolvePinnedSessionAuthority).toHaveBeenCalledWith(authority);
    expect(first).toMatchObject({
      model: MODEL,
      thinkingLevel: "low",
      mode: "plan",
      resumeSessionFile: join(value.sessionRoot, "pi-sessions", "conversation.jsonl"),
      bootstrapPayload: {
        authorizedRoots: [
          { path: join(value.sessionRoot, "workspace"), access: "write" },
          { path: "/managed-knowledge/tenant-1/docs", access: "read" },
        ],
      },
    });

    const second = await value.builder.build(SESSION_ID, 2, context);
    expect(fakes.taskInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(fakes.brokerInstances[0]!.dispose).toHaveBeenCalledOnce();
    first.onExit?.(sessionInfo(1));
    expect(fakes.brokerInstances[1]!.dispose).not.toHaveBeenCalled();
    second.onExit?.(sessionInfo(2));
    await vi.waitFor(() => expect(fakes.brokerInstances[1]!.dispose).toHaveBeenCalledOnce());
  });

  it("fails closed for unresolved authority, ineffective models, and inactive controls", async () => {
    const value = await fixture();
    const authority = {
      tenantId: "tenant-1",
      userId: "user-1",
      membershipId: "membership-1",
      orgNodeId: "org-root",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      effectivePolicyHash: "hash",
    };
    await expect(
      value.builder.build(SESSION_ID, 1, {
        request: {},
        persisted: {
          id: SESSION_ID,
          authority,
          offlineQueue: [],
          processedClientMessageIds: [],
        },
      }),
    ).rejects.toThrow("Pinned Pi Agent authority cannot be resolved");
    await expect(
      value.builder.build(SESSION_ID, 1, {
        request: {
          resolvedSandbox: sandbox({
            modelPolicy: {
              modelAllowlist: ["other/*"],
              defaultThinkingLevel: "medium",
            },
          }),
          model: MODEL,
        },
      }),
    ).rejects.toThrow("Requested Pi model is not effective");
    await expect(value.builder.setMcpEnabled(SESSION_ID, "docs", true)).rejects.toThrow(
      "Pi runtime is not active",
    );
    await expect(value.builder.reconnectMcp(SESSION_ID, "docs")).rejects.toThrow(
      "Pi runtime is not active",
    );
    await expect(value.builder.stopTask(SESSION_ID, "task-1")).rejects.toThrow(
      "Pi runtime is not active",
    );
    expect(value.builder.mcpDetails(SESSION_ID)).toEqual([]);
    expect(value.builder.isModelEffective(SESSION_ID, MODEL)).toBe(false);
  });

  it("probes, caches, filters, and controls an active model/MCP/task runtime", async () => {
    const value = await fixture();
    const runModelProbe = vi.fn(async () => [
      { ...MODEL, name: "Model", reasoning: true },
      { key: "openai/other", provider: "openai", modelId: "other", name: "Other" },
    ]);
    (value.builder as unknown as { runModelProbe: typeof runModelProbe }).runModelProbe =
      runModelProbe;
    const first = await value.builder.probeModels("agent-1", sandbox());
    const second = await value.builder.probeModels("agent-1", sandbox());
    expect(first).toMatchObject({
      models: [MODEL],
      defaultModel: MODEL,
      defaultThinkingLevel: "high",
    });
    expect(second).toEqual(first);
    expect(runModelProbe).toHaveBeenCalledOnce();

    const launch = await value.builder.build(SESSION_ID, 1, {
      request: { resolvedSandbox: sandbox() },
    });
    expect(value.builder.mcpDetails(SESSION_ID)).toEqual([{ name: "docs", state: "connected" }]);
    expect(value.builder.isModelEffective(SESSION_ID, MODEL)).toBe(true);
    await value.builder.setMcpEnabled(SESSION_ID, "docs", false);
    await value.builder.reconnectMcp(SESSION_ID, "docs");
    await value.builder.stopTask(SESSION_ID, "task-1");
    expect(fakes.brokerInstances[0]!.setMcpEnabled).toHaveBeenCalledWith("docs", false);
    expect(fakes.brokerInstances[0]!.reconnectMcp).toHaveBeenCalledWith("docs");
    expect(fakes.taskInstances[0]!.stopTask).toHaveBeenCalledWith("task-1");

    await value.builder.dispose();
    expect(fakes.taskInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(fakes.brokerInstances[0]!.dispose).toHaveBeenCalledOnce();
    expect(value.builder.mcpDetails(SESSION_ID)).toEqual([]);
    launch.onExit?.(sessionInfo(1));
    expect(fakes.brokerInstances[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("requires Compose authority and exercises the native file and App broker handlers", async () => {
    const handleApp = vi.fn(async () => ({ ok: true }));
    const value = await fixture(undefined, { handleApp });
    const previousMode = process.env.PIWORK_RUNTIME_MODE;
    process.env.PIWORK_RUNTIME_MODE = "compose";
    try {
      await expect(
        value.builder.build(SESSION_ID, 1, { request: { resolvedSandbox: sandbox() } }),
      ).rejects.toThrow("tenant-scoped Agent authority");
    } finally {
      if (previousMode === undefined) delete process.env.PIWORK_RUNTIME_MODE;
      else process.env.PIWORK_RUNTIME_MODE = previousMode;
    }

    await mkdir(join(value.sessionRoot, "workspace"), { recursive: true });
    await writeFile(join(value.sessionRoot, "workspace", "report.txt"), "report");
    const createFileAction = vi.spyOn(nativeHelperService, "createFileAction").mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      action: "file.quickLook",
      state: "staged",
    } as never);
    const launch = await value.builder.build(SESSION_ID, 2, {
      request: { resolvedSandbox: sandbox() },
    });
    const brokerOptions = fakes.brokerInstances.at(-1)!.options;
    const handleAppRequest = brokerOptions.handleApp as (
      request: unknown,
      context: unknown,
    ) => Promise<unknown>;
    await expect(handleAppRequest({ operation: "app.list" }, {})).resolves.toEqual({ ok: true });
    expect(handleApp).toHaveBeenCalledOnce();

    const handleNativeFile = brokerOptions.handleNativeFile as (
      request: { payload?: unknown },
      context: unknown,
    ) => Promise<unknown>;
    await expect(handleNativeFile({ payload: [] }, {})).rejects.toThrow(
      "Native file action payload is invalid",
    );
    await expect(
      handleNativeFile({ payload: { action: "not-allowed", path: "report.txt" } }, {}),
    ).rejects.toThrow("Native file action payload is invalid");
    await expect(
      handleNativeFile({ payload: { action: "file.quickLook", path: "report.txt" } }, {}),
    ).resolves.toMatchObject({ operationId: "11111111-1111-4111-8111-111111111111" });
    expect(createFileAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "file.quickLook", filename: "report.txt" }),
    );
    launch.onExit?.(sessionInfo(2));
    await value.builder.dispose();
  });
});

function sessionInfo(generation: number) {
  return {
    sessionId: SESSION_ID,
    state: "exited" as const,
    cwd: "/tmp/workspace",
    createdAt: 1,
    backendType: "pi" as const,
    transport: "pi-rpc" as const,
    generation,
    piVersion: "0.82.1" as const,
    thinkingLevel: "medium" as const,
    mode: "agent" as const,
  };
}
