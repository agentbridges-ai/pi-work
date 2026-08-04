import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import { createRoutes } from "../routes.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MODEL = { key: "managed/model", provider: "managed", modelId: "model" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    state: "connected",
    cwd: "/tmp/session/workspace",
    createdAt: 2,
    backendType: "pi",
    transport: "pi-rpc",
    generation: 1,
    piVersion: "0.82.1",
    model: MODEL,
    thinkingLevel: "medium",
    mode: "agent",
    ...overrides,
  };
}

function currentUser(tenantId?: string): AuthenticatedUser {
  return {
    userId: "user-1",
    uuid: "user-uuid",
    username: "user",
    displayName: "User",
    orgId: "org-1",
    orgName: "Org",
    tenantId,
    roles: ["member"],
    permissions: [],
    departments: [],
  };
}

function fixture(
  options: {
    tenantId?: string;
    governed?: boolean;
    streamFailure?: boolean;
    withProbe?: boolean;
  } = {},
) {
  const authority = {
    tenantId: "tenant-1",
    userId: "user-1",
    agentDefinitionId: "agent-1",
    agentVersionId: "version-1",
    effectivePolicyHash: "a".repeat(64),
  };
  const resolvedSandbox = { mode: "agent", networkPolicy: "managed" };
  const createSession = vi.fn(async (_body: unknown) => ({
    ok: true as const,
    session: session(),
  }));
  const createSessionStreaming = vi.fn(
    async (
      _body: unknown,
      progress: (
        step: string,
        label: string,
        status: "pending" | "active" | "done" | "error",
        detail?: string,
      ) => Promise<void>,
    ) => {
      await progress("starting_runtime", "Starting Pi", "active", "generation 1");
      return options.streamFailure
        ? ({ ok: false as const, error: "runtime failed", status: 503 as const } as const)
        : ({ ok: true as const, session: session() } as const);
    },
  );
  const pinSessionAuthority = vi.fn();
  const orchestrator = {
    createSession,
    createSessionStreaming,
    pinSessionAuthority,
    getLifecycleState: vi.fn(() => "enabled"),
    getRuntimeState: vi.fn(() => ({ state: "ready" })),
    hasSessionData: vi.fn(() => false),
    getPersistedSession: vi.fn<(id: string) => unknown>(() => null),
    getSessionDirectory: vi.fn<(id: string) => string | null>(() => null),
  };
  const sessions = [
    session(),
    session({
      sessionId: "22222222-2222-4222-8222-222222222222",
      createdAt: 1,
      archived: true,
    }),
  ];
  const launcher = {
    listSessions: vi.fn(() => sessions),
    getSession: vi.fn((id: string) => sessions.find((value) => value.sessionId === id)),
  };
  const wsBridge = {
    getSession: vi.fn(() => undefined),
    setUserSpaces: vi.fn(),
  };
  const workspaceState = {
    selectedAgentId: "agent-1",
    currentSessionId: SESSION_ID,
    agentSessionIds: { "agent-1": SESSION_ID },
    agentSessionHistoryIds: { "agent-1": [SESSION_ID] },
    agentUserSpaces: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const workspaceStateStore = {
    get: vi.fn(() => workspaceState),
    put: vi.fn((next: unknown) => ({ ...workspaceState, ...(next as object) })),
    bindSession: vi.fn(() => workspaceState),
  };
  const resolveSessionAuthority = vi.fn(async () => ({
    authority,
    launch: resolvedSandbox,
  }));
  const controlPlane = { resolveSessionAuthority };
  const probeModels = vi.fn(async () => ({
    models: [
      {
        ...MODEL,
        name: "Managed Model",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      },
      {
        key: "managed/reasoning",
        provider: "managed",
        modelId: "reasoning",
        reasoning: true,
      },
      {
        key: "managed/plain",
        provider: "managed",
        modelId: "plain",
        reasoning: false,
      },
    ],
    defaultModel: {
      key: "managed/reasoning",
      provider: "managed",
      modelId: "reasoning",
    },
    defaultThinkingLevel: "high" as const,
  }));
  const launchBuilder = { probeModels };
  const providerVault = {
    modelCandidates: vi.fn(() => (options.withProbe ? [MODEL] : [])),
  };
  const onSessionBound = vi.fn();
  const app = new Hono();
  app.route(
    "/api",
    createRoutes(
      orchestrator as never,
      launcher as never,
      wsBridge as never,
      undefined,
      undefined,
      undefined,
      workspaceStateStore as never,
      undefined,
      {
        getCurrentUser: () => currentUser(options.tenantId),
        controlPlane: options.governed ? (controlPlane as never) : undefined,
        launchBuilder: options.withProbe ? (launchBuilder as never) : undefined,
        providerVault: providerVault as never,
        onSessionBound,
      },
    ),
  );
  return {
    app,
    authority,
    resolvedSandbox,
    createSession,
    createSessionStreaming,
    pinSessionAuthority,
    workspaceStateStore,
    resolveSessionAuthority,
    probeModels,
    onSessionBound,
    orchestrator,
    launcher,
  };
}

describe("native Pi routes", () => {
  it("rejects legacy backends before session creation", async () => {
    const value = fixture();
    for (const path of ["/api/sessions/create", "/api/sessions/create-stream"]) {
      const response = await value.app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "claude" }),
      });
      expect(response.status).toBe(400);
    }
    expect(value.createSession).not.toHaveBeenCalled();
    expect(value.createSessionStreaming).not.toHaveBeenCalled();
  });

  it("injects governed Pi authority, binds the session, and emits native SSE fields", async () => {
    const value = fixture({ tenantId: "tenant-1", governed: true });
    const response = await value.app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "pi",
        agentId: "agent-1",
        model: MODEL,
        authority: { injected: true },
      }),
    });
    expect(response.status).toBe(200);
    expect(value.resolveSessionAuthority).toHaveBeenCalledWith("user-1", "tenant-1", "agent-1");
    expect(value.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "pi",
        authority: value.authority,
        resolvedSandbox: value.resolvedSandbox,
      }),
    );
    expect(value.createSession.mock.calls[0]![0]).toHaveProperty("agentId", "agent-1");
    expect(value.onSessionBound).toHaveBeenCalledWith(SESSION_ID);
    expect(value.workspaceStateStore.bindSession).toHaveBeenCalledWith("agent-1", SESSION_ID);
    expect(value.pinSessionAuthority).toHaveBeenCalledWith(SESSION_ID, value.authority);

    const stream = await value.app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "pi", agentId: "agent-1" }),
    });
    expect(stream.status).toBe(200);
    const text = await stream.text();
    expect(text).toContain("event: progress");
    expect(text).toContain("event: done");
    expect(text).toContain('"transport":"pi-rpc"');
    expect(text).toContain('"thinkingLevel":"medium"');
  });

  it("reports governed and streaming failures without binding a session", async () => {
    const denied = fixture({ tenantId: "tenant-1", governed: true });
    denied.resolveSessionAuthority.mockRejectedValueOnce(new Error("agent denied"));
    const forbidden = await denied.app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "pi", agentId: "agent-1" }),
    });
    expect(forbidden.status).toBe(403);

    const failed = fixture({ streamFailure: true });
    const response = await failed.app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "pi" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: error\ndata: {"error":"runtime failed"}');
    expect(failed.onSessionBound).not.toHaveBeenCalled();
  });

  it("pages active and archived Pi sessions and returns workspace bootstrap state", async () => {
    const value = fixture();
    const bootstrap = await value.app.request("/api/workspace/bootstrap");
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      sessionsTotal: 1,
      sessionsHasMore: false,
      workspaceState: { currentSessionId: SESSION_ID },
    });

    const active = await value.app.request(
      "/api/sessions?agentId=agent-1&cursor=invalid&limit=invalid",
    );
    await expect(active.json()).resolves.toMatchObject({
      total: 1,
      cursor: 0,
      hasMore: false,
      agentId: "agent-1",
    });
    const archived = await value.app.request("/api/sessions/archived?limit=1");
    await expect(archived.json()).resolves.toMatchObject({
      total: 1,
      sessions: [{ archived: true }],
    });
  });

  it("serves only exact Pi JSONL history and maps cursor/schema failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-route-history-"));
    roots.push(root);
    await mkdir(join(root, "workspace"), { recursive: true });
    await mkdir(join(root, "pi-sessions"), { recursive: true });
    const records = [
      {
        type: "session",
        version: 3,
        id: SESSION_ID,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: join(root, "workspace"),
      },
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
    ];
    await writeFile(
      join(root, "pi-sessions", "conversation.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const value = fixture();
    value.orchestrator.getPersistedSession.mockReturnValue({
      piSessionRelativePath: "pi-sessions/conversation.jsonl",
    });
    value.orchestrator.getSessionDirectory.mockReturnValue(root);

    const history = await value.app.request(`/api/sessions/${SESSION_ID}/history?limit=1`);
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      sessionId: SESSION_ID,
      totalEntries: 1,
      entries: [{ id: "entry-1" }],
    });

    const cursor = await value.app.request(`/api/sessions/${SESSION_ID}/history?cursor=missing`);
    expect(cursor.status).toBe(400);
    await expect(cursor.json()).resolves.toMatchObject({ code: "invalid_cursor" });

    value.orchestrator.getPersistedSession.mockReturnValueOnce(null);
    const absent = await value.app.request(`/api/sessions/${SESSION_ID}/history`);
    expect(absent.status).toBe(404);

    value.orchestrator.getPersistedSession.mockReturnValue({
      piSessionRelativePath: "pi-sessions/other.jsonl",
    });
    const missingFile = await value.app.request(`/api/sessions/${SESSION_ID}/history`);
    expect(missingFile.status).toBe(404);
    await expect(missingFile.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("advertises only Pi and probes the policy-intersected model set", async () => {
    const unavailable = fixture();
    await expect((await unavailable.app.request("/api/backends")).json()).resolves.toEqual([
      { id: "pi", name: "Pi Agent", available: false },
    ]);
    expect((await unavailable.app.request("/api/backends/pi/models")).status).toBe(400);
    expect((await unavailable.app.request("/api/backends/pi/models?agentId=agent-1")).status).toBe(
      503,
    );

    const unbound = fixture({ governed: true, withProbe: true });
    expect((await unbound.app.request("/api/backends/pi/models?agentId=agent-1")).status).toBe(400);

    const value = fixture({
      tenantId: "tenant-1",
      governed: true,
      withProbe: true,
    });
    const response = await value.app.request("/api/backends/pi/models?agentId=agent-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        model: {
          key: "managed/reasoning",
          provider: "managed",
          modelId: "reasoning",
        },
        label: "managed/reasoning",
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      },
      {
        model: MODEL,
        label: "Managed Model",
        thinkingLevels: ["high", "max"],
      },
      {
        model: { key: "managed/plain", provider: "managed", modelId: "plain" },
        label: "managed/plain",
        thinkingLevels: ["off"],
      },
    ]);
    expect(value.probeModels).toHaveBeenCalledWith(
      "agent-1",
      value.resolvedSandbox,
      expect.any(AbortSignal),
    );

    value.resolveSessionAuthority.mockResolvedValueOnce({
      authority: { ...value.authority, agentDefinitionId: "general-membership-1" },
      launch: value.resolvedSandbox,
    });
    const legacyAlias = await value.app.request("/api/backends/pi/models?agentId=agent");
    expect(legacyAlias.status).toBe(200);
    expect(value.probeModels).toHaveBeenLastCalledWith(
      "general-membership-1",
      value.resolvedSandbox,
      expect.any(AbortSignal),
    );

    value.probeModels.mockRejectedValueOnce(new Error("probe denied"));
    const denied = await value.app.request("/api/backends/pi/models?agentId=agent-1");
    expect(denied.status).toBe(403);
  });
});
