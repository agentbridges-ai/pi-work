import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import type { PiLaunchOptions, PiSessionInfo } from "./pi-launcher.js";
import { RemotePiRuntimeBackend } from "./remote-pi-runtime.js";
import { RuntimeControlAuthenticator, type RuntimeScope } from "./runtime-control-protocol.js";
import { RuntimeControlServer } from "./runtime-control-server.js";

const scope: RuntimeScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-remote-runtime-"));
  roots.push(root);
  const sessionRoot = join(
    root,
    "tenants",
    scope.tenantId,
    "users",
    scope.userId,
    "sessions",
    scope.sessionId,
  );
  const resourceRoot = join(sessionRoot, "pi-config", "piwork-resources");
  const skillPath = join(resourceRoot, "skills", "managed");
  const workspace = join(sessionRoot, "workspace");
  const piSessions = join(sessionRoot, "pi-sessions");
  await mkdir(skillPath, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(piSessions, { recursive: true });
  await writeFile(join(piSessions, "resume.jsonl"), "");
  const keyPath = join(root, "runtime-control.key");
  await writeFile(keyPath, randomBytes(32));
  const bootstrapPayload: PiBootstrapPayload = {
    version: 1,
    sessionId: scope.sessionId,
    generation: scope.generation,
    authorizedRoots: [{ path: workspace, access: "write" }],
    mode: "agent",
    instructions: "Use the managed Runtime.",
    providers: [],
    managedSkills: [{ path: skillPath, name: "managed" }],
    mcp: [],
    taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 1 },
  };
  const options = {
    sessionId: scope.sessionId,
    runtimeScope: scope,
    sessionRoot,
    workingDirectory: workspace,
    trustedExtensionPath: join(root, "trusted-extension.ts"),
    managedSkillPaths: [skillPath],
    bootstrapPayload,
    sandbox: {
      settings: {
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["blocked.example.com"],
          allowUnixSockets: [],
        },
      },
      managedResourcesDir: resourceRoot,
    },
    model: { provider: "openai", id: "model" },
    thinkingLevel: "medium",
    mode: "agent",
    resumeSessionFile: join(sessionRoot, "pi-sessions", "resume.jsonl"),
    onNotification: vi.fn(),
    onExit: vi.fn(),
  } as unknown as PiLaunchOptions;
  return { root, keyPath, options, bootstrapPayload };
}

function sessionInfo(overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
  return {
    sessionId: scope.sessionId,
    state: "ready",
    thinkingLevel: "medium",
    mode: "agent",
    cwd: "/workspace",
    createdAt: Date.now(),
    backendType: "pi",
    transport: "pi-rpc",
    generation: scope.generation,
    piVersion: "0.82.1",
    ...overrides,
  };
}

describe("Remote Pi Runtime backend", () => {
  it("launches through the authenticated Runtime channel and exposes the Pi transport contract", async () => {
    const input = await fixture();
    (input.options.sandbox as { toolEnvironment?: Record<string, string> }).toolEnvironment = {
      PIWORK_APP_BUILDER: "/usr/local/bin/bun",
    };
    const authenticator = new RuntimeControlAuthenticator(await readFile(input.keyPath));
    const socketPath = join(input.root, "runtime.sock");
    const events: string[] = [];
    let preparePayload: Record<string, unknown> | undefined;
    const server = new RuntimeControlServer({
      socketPath,
      authenticator,
      handler: async (request, connection) => {
        if (request.operation === "launch.prepare") {
          preparePayload = request.payload as Record<string, unknown>;
          return { nonce: "nonce-1" };
        }
        if (request.operation === "launch.bootstrap") return sessionInfo();
        if (request.operation === "kill") return { killed: true };
        if (request.operation === "shutdown") return { stopped: true };
        if (request.operation === "request") {
          const payload = request.payload as { input?: { type?: string } };
          await connection.sendEvent("pi.notification", request.scope, { type: "agent_end" });
          switch (payload.input?.type) {
            case "get_available_models":
              return { success: true, data: { models: [{ provider: "openai", id: "model" }] } };
            case "get_available_thinking_levels":
              return { success: true, data: { levels: ["medium"] } };
            case "get_entries":
              return { success: true, data: { entries: [] } };
            case "get_messages":
              return { success: true, data: { messages: [] } };
            case "get_commands":
              return { success: true, data: { commands: [] } };
            case "get_session_stats":
              return { success: true, data: { tokens: 0 } };
            case "set_model":
              return { success: true, data: { provider: "openai", id: "model" } };
            case "get_state":
              return { success: true, data: { type: "state" } };
            default:
              return { success: true, data: {} };
          }
        }
        throw new Error(`unexpected operation ${request.operation}`);
      },
    });
    await server.start();
    const backend = new RemotePiRuntimeBackend({
      socketPath,
      controlKeyPath: input.keyPath,
      dataRoot: input.root,
    });
    const launched = await backend.launch(input.options);
    expect(launched).toMatchObject({ sessionId: scope.sessionId, generation: 1 });
    expect(preparePayload).toMatchObject({
      toolEnvironment: { PIWORK_APP_BUILDER: "/usr/local/bin/bun" },
    });
    expect(backend.nextLaunchGeneration(scope.sessionId)).toBe(2);
    expect(backend.getSession(scope.sessionId)).toMatchObject({ sessionId: scope.sessionId });
    const transport = backend.getTransport(scope.sessionId)!;
    const remoteTransport = transport as unknown as {
      setNotificationHandler(handler: (notification: { type: string }) => void): void;
    };
    remoteTransport.setNotificationHandler((notification) => events.push(notification.type));
    await transport.sendInput({ type: "prompt", message: "hello" });
    await transport.sendExtensionUiResponse({
      type: "extension_ui_response",
      id: "ui-1",
      value: "ok",
    } as never);
    await transport.prompt("hello", { streamingBehavior: "steer" });
    await transport.steer("steer");
    await transport.followUp("follow up");
    await transport.abort();
    await expect(transport.getState()).resolves.toEqual({ type: "state" });
    await expect(transport.getAvailableModels()).resolves.toHaveLength(1);
    await expect(transport.setModel("openai", "model")).resolves.toMatchObject({ id: "model" });
    await transport.setThinkingLevel("medium");
    await expect(transport.getAvailableThinkingLevels()).resolves.toEqual(["medium"]);
    await expect(transport.compact("keep context")).resolves.toEqual({});
    await transport.setAutoRetry(true);
    await transport.retry();
    await transport.abortRetry();
    await expect(transport.getEntries()).resolves.toEqual({ entries: [] });
    await expect(transport.replayHistory()).resolves.toEqual({ entries: [] });
    await expect(transport.getMessages()).resolves.toEqual([]);
    await expect(transport.getCommands()).resolves.toEqual([]);
    await expect(transport.getSessionStats()).resolves.toEqual({ tokens: 0 });
    expect(events).toContain("agent_end");
    expect(transport.pendingRequestCount).toBe(0);
    expect(transport.getStderr()).toBe("");
    expect(backend.isAlive(scope.sessionId)).toBe(true);
    expect(backend.validateLaunchGeneration(scope.sessionId, 1)).toBe(true);
    expect(backend.getSandboxedGeneration(scope.sessionId)).toBe(1);
    expect(backend.getReadiness(scope.sessionId)).toBeUndefined();
    expect(backend.listSessions()).toHaveLength(1);
    backend.setArchived(scope.sessionId, true);
    expect(backend.getSession(scope.sessionId)?.archived).toBe(true);
    backend.setArchived(scope.sessionId, false);
    expect(backend.getSession(scope.sessionId)?.archived).toBe(false);
    expect(await backend.kill(scope.sessionId)).toBe(true);
    expect(backend.isAlive(scope.sessionId)).toBe(false);
    await backend.killAll();
    await server.close();
  });

  it("adopts an already-running Runtime session after a Web restart", async () => {
    const input = await fixture();
    const authenticator = new RuntimeControlAuthenticator(await readFile(input.keyPath));
    const socketPath = join(input.root, "runtime-adopt.sock");
    let statusCalls = 0;
    let prepareCalls = 0;
    const server = new RuntimeControlServer({
      socketPath,
      authenticator,
      handler: async (request) => {
        if (request.operation === "status") {
          statusCalls += 1;
          return { alive: true, session: sessionInfo() };
        }
        if (request.operation === "launch.prepare") {
          prepareCalls += 1;
          return { nonce: "unexpected" };
        }
        if (request.operation === "kill") return { killed: true };
        throw new Error(`unexpected adoption operation ${request.operation}`);
      },
    });
    await server.start();
    const backend = new RemotePiRuntimeBackend({
      socketPath,
      controlKeyPath: input.keyPath,
      dataRoot: input.root,
    });

    await expect(backend.launch(input.options)).resolves.toMatchObject({
      sessionId: scope.sessionId,
      generation: scope.generation,
    });
    expect(statusCalls).toBe(1);
    expect(prepareCalls).toBe(0);
    expect(backend.isAlive(scope.sessionId)).toBe(true);
    await expect(backend.kill(scope.sessionId)).resolves.toBe(true);
    await server.close();
  });

  it("fences stale transports, restores exited sessions, and rejects unavailable relaunch authority", async () => {
    const input = await fixture();
    const backend = new RemotePiRuntimeBackend({
      socketPath: join(input.root, "missing.sock"),
      controlKeyPath: input.keyPath,
      dataRoot: input.root,
    });
    expect(backend.getSession("missing")).toBeUndefined();
    expect(backend.getTransport("missing")).toBeUndefined();
    expect(await backend.kill("missing")).toBe(true);
    await expect(backend.relaunch("missing")).rejects.toThrow(/authority is unavailable/);
    const restored = sessionInfo({
      sessionId: "22222222-2222-4222-8222-222222222222",
      generation: 4,
    });
    backend.restoreSession(restored);
    expect(backend.getSession(restored.sessionId)).toMatchObject({
      state: "exited",
      pid: undefined,
    });
    expect(backend.validateLaunchGeneration(restored.sessionId, 4)).toBe(false);
    backend.removeSession(restored.sessionId);
    expect(backend.getSession(restored.sessionId)).toBeUndefined();
    await backend.killAll({ shutdown: false });
  });
});
