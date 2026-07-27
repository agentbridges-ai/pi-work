import { describe, expect, it, vi } from "vitest";
import type { PiSessionInfo } from "./pi-launcher.js";
import { SessionOrchestrator } from "./session-orchestrator.js";

const MODEL = { key: "managed/model", provider: "managed", modelId: "model" };

function sessionInfo(sessionId: string, generation = 1): PiSessionInfo {
  return {
    sessionId,
    state: "running",
    lifecycleState: "enabled",
    cwd: `/tmp/${sessionId}/workspace`,
    createdAt: 1,
    backendType: "pi",
    transport: "pi-rpc",
    generation,
    piVersion: "0.82.1",
    model: MODEL,
    thinkingLevel: "medium",
    mode: "agent",
    piSessionRelativePath: "pi-sessions/conversation.jsonl",
  };
}

function fixture() {
  const persisted = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, ReturnType<typeof sessionInfo>>();
  const transports = new Map<string, Record<string, unknown>>();
  const phases = new Map<string, string>();
  let capturedOptions: Record<string, unknown> | undefined;
  const store = {
    saveSync: vi.fn((value: Record<string, unknown>) => persisted.set(String(value.id), value)),
    load: vi.fn((id: string) => persisted.get(id) ?? null),
    loadAll: vi.fn(() => [...persisted.values()]),
    getSessionDirectory: vi.fn((id: string) => (persisted.has(id) ? `/tmp/sessions/${id}` : null)),
    removeSessionDirectory: vi.fn((id: string) => persisted.delete(id)),
    remove: vi.fn(),
    hasSessionData: vi.fn((id: string) => persisted.has(id)),
    setPiSessionRelativePath: vi.fn(),
    drainOffline: vi.fn(() => [{ message: "queued prompt" }]),
    setAuthority: vi.fn(() => true),
    setArchived: vi.fn((id: string, archived: boolean) => {
      const value = persisted.get(id);
      if (!value) return false;
      value.archived = archived;
      return true;
    }),
  };
  const launcher = {
    nextLaunchGeneration: vi.fn((id: string) => (sessions.get(id)?.generation ?? 0) + 1),
    launch: vi.fn(async (options: Record<string, unknown>) => {
      capturedOptions = options;
      const info = sessionInfo(String(options.sessionId), Number(options.generation ?? 1));
      sessions.set(info.sessionId, info);
      transports.set(info.sessionId, {
        isClosed: false,
        dispose: vi.fn(async () => undefined),
      });
      return info;
    }),
    getTransport: vi.fn((id: string) => transports.get(id)),
    getReadiness: vi.fn(() => Promise.resolve({})),
    getSession: vi.fn((id: string) => sessions.get(id)),
    isAlive: vi.fn((id: string) => sessions.get(id)?.state !== "exited"),
    kill: vi.fn(async (id: string) => {
      const info = sessions.get(id);
      if (!info) return false;
      info.state = "exited";
      return true;
    }),
    removeSession: vi.fn((id: string) => sessions.delete(id)),
    setArchived: vi.fn((id: string, archived: boolean) => {
      const info = sessions.get(id);
      if (info) info.archived = archived;
    }),
    restoreSession: vi.fn(),
  };
  const bridge = {
    attachPiAdapter: vi.fn(),
    detachPiAdapter: vi.fn(() => true),
    broadcastLifecycleUpdate: vi.fn(),
    injectUserMessage: vi.fn(),
    setSessionAuthority: vi.fn(() => true),
    setSessionNameSource: vi.fn(() => true),
    getSessionPhase: vi.fn((id: string) => phases.get(id) ?? null),
    closeSession: vi.fn(),
    firstUserMessage: vi.fn(async () => "first user request"),
    broadcastNameUpdate: vi.fn(),
  };
  const buildLaunchOptions = vi.fn(async (id: string, generation: number) => ({
    sessionId: id,
    generation,
    onNotification: vi.fn(),
    onExit: vi.fn(),
  }));
  const cleanup = vi.fn(async () => undefined);
  const stopped = vi.fn(async () => undefined);
  const title = { generate: vi.fn(async () => "Generated title") };
  const names = {
    setName: vi.fn(),
    removeNameAfterSpaceRelease: vi.fn(async () => undefined),
  };
  const orchestrator = new SessionOrchestrator({
    launcher: launcher as never,
    wsBridge: bridge as never,
    sessionStore: store as never,
    buildLaunchOptions: buildLaunchOptions as never,
    browserSessionCleanup: cleanup,
    onRuntimeStopped: stopped,
    sessionTitleGenerator: title as never,
    sessionNameStore: names as never,
  });
  return {
    orchestrator,
    persisted,
    sessions,
    transports,
    store,
    launcher,
    bridge,
    buildLaunchOptions,
    cleanup,
    stopped,
    title,
    names,
    captured: () => capturedOptions,
  };
}

describe("SessionOrchestrator native Pi lifecycle", () => {
  it("validates creation, launches a generation, restores the queue, and ignores stale exits", async () => {
    const value = fixture();
    await expect(value.orchestrator.createSession({ backend: "other" as "pi" })).resolves.toEqual({
      ok: false,
      error: "Only the native Pi backend is supported",
      status: 400,
    });
    await expect(value.orchestrator.createSession({ backend: "pi" })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    const progress = vi.fn(async () => undefined);
    const result = await value.orchestrator.createSessionStreaming(
      { backend: "pi", model: MODEL },
      progress,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const id = result.session.sessionId;
    expect(value.bridge.attachPiAdapter).toHaveBeenCalledOnce();
    expect(value.bridge.injectUserMessage).toHaveBeenCalledWith(id, "queued prompt");
    expect(value.store.setPiSessionRelativePath).toHaveBeenCalledWith(
      id,
      "pi-sessions/conversation.jsonl",
    );
    expect(value.orchestrator.getRuntimeState(id)?.state).toBe("ready");
    expect(progress).toHaveBeenCalledWith("waiting_for_ready", "Session ready", "done");

    const options = value.captured()!;
    (options.onNotification as (event: unknown, info: unknown) => void)(
      { type: "agent_start" },
      result.session,
    );
    (options.onExit as (info: PiSessionInfo) => void)({
      ...result.session,
      generation: result.session.generation + 1,
    });
    expect(value.stopped).not.toHaveBeenCalled();
    (options.onExit as (info: PiSessionInfo) => void)(result.session);
    expect(value.stopped).toHaveBeenCalledWith(id, 1, "exit");
  });

  it("cleans failed creation and preserves resource admission status", async () => {
    const value = fixture();
    value.buildLaunchOptions.mockRejectedValueOnce(
      Object.assign(new Error("disk quota exceeded"), { status: 507 }),
    );
    const result = await value.orchestrator.createSession({ backend: "pi", model: MODEL });
    expect(result).toMatchObject({ ok: false, status: 507, error: "disk quota exceeded" });
    expect(value.store.removeSessionDirectory).toHaveBeenCalledOnce();
    expect(value.orchestrator.listRuntimeStates()).toEqual([]);
  });

  it("serializes kill/relaunch/activate and rejects missing or archived authority", async () => {
    const value = fixture();
    expect(await value.orchestrator.killSession("missing")).toEqual({ ok: false });
    expect(value.cleanup).toHaveBeenCalledWith("missing");

    value.persisted.set("s1", {
      id: "s1",
      offlineQueue: [],
      processedClientMessageIds: [],
    });
    value.sessions.set("s1", sessionInfo("s1", 3));
    expect(await value.orchestrator.killSession("s1")).toEqual({ ok: true });
    expect(value.stopped).toHaveBeenCalledWith("s1", 3, "kill");
    expect(value.bridge.broadcastLifecycleUpdate).toHaveBeenCalledWith("s1", "closed");

    expect(await value.orchestrator.relaunchSession("missing")).toMatchObject({ ok: false });
    value.persisted.get("s1")!.archived = true;
    expect(await value.orchestrator.relaunchSession("s1")).toMatchObject({
      ok: false,
      error: "Session is archived",
    });
    expect(await value.orchestrator.activateSession("missing")).toMatchObject({
      ok: false,
      status: 404,
    });
    value.sessions.get("s1")!.archived = true;
    value.bridge.getSessionPhase.mockReturnValueOnce("closed");
    expect(await value.orchestrator.activateSession("s1")).toMatchObject({
      ok: false,
      status: 409,
      phase: "closed",
    });

    value.sessions.get("s1")!.archived = false;
    value.persisted.get("s1")!.archived = false;
    value.sessions.get("s1")!.state = "running";
    expect(await value.orchestrator.activateSession("s1")).toMatchObject({
      ok: true,
      lifecycleState: "enabled",
    });
    value.sessions.get("s1")!.state = "exited";
    expect(await value.orchestrator.relaunchSession("s1")).toEqual({ ok: true });
  });

  it("archives, deletes, unarchives, names, and exposes persisted authority", async () => {
    const value = fixture();
    value.persisted.set("s2", {
      id: "s2",
      offlineQueue: [],
      processedClientMessageIds: [],
    });
    value.sessions.set("s2", sessionInfo("s2"));

    expect(value.orchestrator.hasSessionData("s2")).toBe(true);
    expect(value.orchestrator.getPersistedSession("s2")).toMatchObject({ id: "s2" });
    expect(value.orchestrator.getSessionDirectory("s2")).toBe("/tmp/sessions/s2");
    expect(value.orchestrator.getSession("s2")?.sessionId).toBe("s2");
    expect(value.orchestrator.getLifecycleState("s2")).toBe("enabled");
    expect(
      value.orchestrator.pinSessionAuthority("s2", {
        tenantId: "tenant",
        agentId: "agent",
      } as never),
    ).toBe(true);
    expect(value.orchestrator.markSessionNameManual("s2")).toBe(true);

    expect(await value.orchestrator.generateSessionName("s2")).toBe("Generated title");
    expect(value.names.setName).toHaveBeenCalledWith("s2", "Generated title");
    expect(await value.orchestrator.archiveSession("s2")).toEqual({ ok: true });
    expect(value.orchestrator.unarchiveSession("s2")).toEqual({ ok: true });
    expect(await value.orchestrator.hardDeleteSession("s2")).toMatchObject({
      ok: true,
      removedSessionDir: true,
      removedRecordings: 1,
    });
    expect(value.bridge.closeSession).toHaveBeenCalledWith("s2");
    expect(value.names.removeNameAfterSpaceRelease).toHaveBeenCalledWith("s2");
  });

  it("fails safely when transport disappears and shutdown blocks new generations", async () => {
    const value = fixture();
    value.launcher.launch.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const info = sessionInfo(String(options.sessionId), Number(options.generation ?? 1));
      value.sessions.set(info.sessionId, info);
      return info;
    });
    await expect(
      value.orchestrator.createSession({ backend: "pi", model: MODEL }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Native Pi transport disappeared before attachment",
    });
    value.orchestrator.shutdown();
    await expect(
      value.orchestrator.createSession({ backend: "pi", model: MODEL }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Native Pi runtime is shutting down",
    });
  });
});
