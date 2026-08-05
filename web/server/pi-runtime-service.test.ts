import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRpcTransportLike } from "./pi-rpc-transport.js";
import {
  PiRuntimeService,
  type RuntimeBootstrapEnvelope,
  type RuntimeLaunchPreparePayload,
} from "./pi-runtime-service.js";
import { preparePiSessionLayout } from "./pi-session-layout.js";
import type { RuntimeControlConnection } from "./runtime-control-server.js";
import type { RuntimeScope } from "./runtime-control-protocol.js";

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

function connection(): RuntimeControlConnection {
  return {
    remoteAddress: "unix",
    sendEvent: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

function fakeTransport(): PiRpcTransportLike {
  return {
    sessionId: scope.sessionId,
    generation: scope.generation,
    isClosed: false,
    pendingRequestCount: 0,
    getStderr: () => "",
    waitForClose: () => new Promise(() => undefined),
    invalidateGeneration: vi.fn(),
    dispose: vi.fn(),
    sendInput: vi.fn(async () => undefined),
    sendExtensionUiResponse: vi.fn(async () => undefined),
    request: vi.fn(async (command) => ({ success: true, command, data: {} })),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ type: "state" })),
    getAvailableModels: vi.fn(async () => []),
    setModel: vi.fn(async () => ({ provider: "openai", id: "model" })),
    setThinkingLevel: vi.fn(async () => undefined),
    getAvailableThinkingLevels: vi.fn(async () => []),
    compact: vi.fn(async () => ({})),
    setAutoRetry: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    abortRetry: vi.fn(async () => undefined),
    getEntries: vi.fn(async () => ({ entries: [] })),
    replayHistory: vi.fn(async () => ({ entries: [] })),
    getMessages: vi.fn(async () => []),
    getCommands: vi.fn(async () => []),
    getSessionStats: vi.fn(async () => ({})),
  } as unknown as PiRpcTransportLike;
}

function preparePayload(): RuntimeLaunchPreparePayload {
  return {
    version: 1,
    mode: "agent",
    network: { allowedDomains: [], deniedDomains: [] },
    managedSkillPaths: [],
    unixSocketPaths: [],
  };
}

function bootstrapPayload(nonce: string): RuntimeBootstrapEnvelope {
  return {
    version: 1,
    nonce,
    providers: [],
    mcp: [],
    authorizedRoots: [
      {
        relativePath:
          "tenants/tenant-a/users/user-a/sessions/11111111-1111-4111-8111-111111111111/workspace",
        access: "write",
      },
    ],
    managedSkills: [],
    taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 1 },
  };
}

describe("Pi Runtime service", () => {
  it("binds launch materialization to the complete scope and consumes the nonce", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-"));
    const dataRoot = realpathSync(requestedRoot);
    roots.push(requestedRoot);
    const launch = vi.fn(async (options: any) => ({
      sessionId: options.sessionId,
      state: "ready",
      thinkingLevel: "off",
      mode: "agent",
      cwd: options.workingDirectory,
      createdAt: Date.now(),
      backendType: "pi",
      transport: "pi-rpc",
      generation: options.runtimeScope.generation,
      piVersion: "0.82.1",
    }));
    const transport = fakeTransport();
    const launcher = {
      launch,
      getTransport: vi.fn(() => transport),
      validateLaunchGeneration: vi.fn(() => true),
      getSession: vi.fn(() => undefined),
      isAlive: vi.fn(() => true),
      kill: vi.fn(async () => true),
      killAll: vi.fn(async () => undefined),
    };
    const trustedExtensionPath = fileURLToPath(
      new URL("./pi-trusted-extension.ts", import.meta.url),
    );
    const service = new PiRuntimeService({
      dataRoot,
      trustedExtensionPath,
      executionMode: "native",
      launcher: launcher as never,
    });
    const handle = service.handler();
    const peer = connection();
    const prepared = (await handle(
      {
        version: 1,
        kind: "request",
        id: "prepare",
        operation: "launch.prepare",
        scope,
        payload: preparePayload(),
        mac: "test",
      },
      peer,
    )) as { nonce: string };
    const info = await handle(
      {
        version: 1,
        kind: "request",
        id: "bootstrap",
        operation: "launch.bootstrap",
        scope,
        payload: bootstrapPayload(prepared.nonce),
        mac: "test",
      },
      peer,
    );
    expect(info).toMatchObject({ sessionId: scope.sessionId, generation: 1 });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      runtimeScope: scope,
      runtimeMode: "native",
      sessionRoot: join(
        dataRoot,
        "tenants",
        "tenant-a",
        "users",
        "user-a",
        "sessions",
        scope.sessionId,
      ),
    });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "bootstrap-again",
          operation: "launch.bootstrap",
          scope,
          payload: bootstrapPayload(prepared.nonce),
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("preparation");
  });

  it("rejects a bootstrap from another membership even when session and generation match", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-"));
    roots.push(requestedRoot);
    const dataRoot = realpathSync(requestedRoot);
    const service = new PiRuntimeService({
      dataRoot,
      trustedExtensionPath: fileURLToPath(new URL("./pi-trusted-extension.ts", import.meta.url)),
      executionMode: "native",
      launcher: { killAll: vi.fn(async () => undefined) } as never,
    });
    const peer = connection();
    const handle = service.handler();
    const prepared = (await handle(
      {
        version: 1,
        kind: "request",
        id: "prepare",
        operation: "launch.prepare",
        scope,
        payload: preparePayload(),
        mac: "test",
      },
      peer,
    )) as { nonce: string };
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "bootstrap-other-scope",
          operation: "launch.bootstrap",
          scope: { ...scope, membershipId: "other-membership" },
          payload: bootstrapPayload(prepared.nonce),
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("preparation");
  });

  it("validates optional launch authorities and forwards every Runtime operation", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-rich-"));
    roots.push(requestedRoot);
    const dataRoot = realpathSync(requestedRoot);
    const sessionRoot = join(
      dataRoot,
      "tenants",
      scope.tenantId,
      "users",
      scope.userId,
      "sessions",
      scope.sessionId,
    );
    const layout = preparePiSessionLayout(sessionRoot);
    const skillDir = join(layout.managedSkillsDir, "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Demo\n");
    await mkdir(join(dataRoot, "tenants", scope.tenantId, "knowledge"), { recursive: true });
    await mkdir(join(dataRoot, "broker"), { recursive: true });
    await writeFile(join(layout.piSessionsDir, "resume.jsonl"), "{}\n");

    const transport = fakeTransport();
    const launch = vi.fn(async (options: any) => {
      options.onNotification({ type: "agent_start" });
      options.onExit({ reason: "completed" });
      return {
        sessionId: options.sessionId,
        state: "ready",
        thinkingLevel: "high",
        mode: "agent",
        cwd: options.workingDirectory,
        createdAt: Date.now(),
        backendType: "pi",
        transport: "pi-rpc",
        generation: options.runtimeScope.generation,
        piVersion: "0.82.1",
      };
    });
    const launcher = {
      launch,
      getTransport: vi.fn(() => transport),
      validateLaunchGeneration: vi.fn(() => true),
      getSession: vi.fn(() => ({ sessionId: scope.sessionId })),
      isAlive: vi.fn(() => true),
      kill: vi.fn(async () => true),
      killAll: vi.fn(async () => undefined),
    };
    const service = new PiRuntimeService({
      dataRoot,
      trustedExtensionPath: fileURLToPath(new URL("./pi-trusted-extension.ts", import.meta.url)),
      executionMode: "native",
      launcher: launcher as never,
    });
    const handle = service.handler();
    const peer = connection();
    const prepared = (await handle(
      {
        version: 1,
        kind: "request",
        id: "prepare-rich",
        operation: "launch.prepare",
        scope,
        payload: {
          ...preparePayload(),
          model: { provider: "openai", modelId: "gpt-5" },
          thinkingLevel: "high",
          managedSkillPaths: ["pi-config/piwork-resources/skills/demo"],
          resumeSessionPath: "pi-sessions/resume.jsonl",
          unixSocketPaths: ["broker/mcp.sock"],
        },
        mac: "test",
      },
      peer,
    )) as { nonce: string };
    const info = await handle(
      {
        version: 1,
        kind: "request",
        id: "bootstrap-rich",
        operation: "launch.bootstrap",
        scope,
        payload: {
          version: 1,
          nonce: prepared.nonce,
          instructions: "Use the managed skill.",
          providers: [],
          mcp: [],
          authorizedRoots: [
            {
              relativePath: `tenants/${scope.tenantId}/users/${scope.userId}/sessions/${scope.sessionId}/workspace`,
              access: "write",
            },
            { relativePath: `tenants/${scope.tenantId}/knowledge`, access: "read" },
          ],
          managedSkills: [
            {
              relativePath: "demo",
              name: "demo",
              sha256: "a".repeat(64),
            },
          ],
          taskPolicy: {
            depth: 1,
            maxDepth: 2,
            maxParallel: 2,
            readOnly: false,
            brokerSocketRelative: "broker/task.sock",
            capability: "broker-capability",
          },
          productTools: { userSpaceCapability: "user-space-capability" },
          mcpBroker: { socketRelative: "broker/mcp.sock", capability: "mcp-capability" },
        },
        mac: "test",
      },
      peer,
    );
    expect(info).toMatchObject({ sessionId: scope.sessionId, mode: "agent" });
    expect(launch.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "high",
      resumeSessionFile: join(layout.piSessionsDir, "resume.jsonl"),
    });
    await handle(
      {
        version: 1,
        kind: "request",
        id: "prompt",
        operation: "request",
        scope,
        payload: { input: { type: "prompt", message: "hello" }, awaitResponse: true },
        mac: "test",
      },
      peer,
    );
    await handle(
      {
        version: 1,
        kind: "request",
        id: "extension-response",
        operation: "request",
        scope,
        payload: {
          input: { type: "extension_ui_response", id: "ui-1", value: "ok" },
        },
        mac: "test",
      },
      peer,
    );
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "interrupt",
          operation: "interrupt",
          scope,
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).resolves.toEqual({ interrupted: true });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "status",
          operation: "status",
          scope,
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).resolves.toMatchObject({ alive: true });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "kill",
          operation: "kill",
          scope,
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).resolves.toEqual({ killed: true });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "shutdown",
          operation: "shutdown",
          scope,
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).resolves.toEqual({ stopped: true });
    expect(transport.request).toHaveBeenCalledOnce();
    expect(transport.sendInput).toHaveBeenCalledOnce();
    expect(transport.abort).toHaveBeenCalledOnce();
    expect(peer.sendEvent).toHaveBeenCalledWith("pi.notification", scope, { type: "agent_start" });
    expect(peer.sendEvent).toHaveBeenCalledWith("lifecycle", scope, { reason: "completed" });
  });

  it("rejects malformed launch and bootstrap authority before touching Pi", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-invalid-"));
    roots.push(requestedRoot);
    const dataRoot = realpathSync(requestedRoot);
    const service = new PiRuntimeService({
      dataRoot,
      trustedExtensionPath: fileURLToPath(new URL("./pi-trusted-extension.ts", import.meta.url)),
      executionMode: "native",
      launcher: { killAll: vi.fn(async () => undefined) } as never,
    });
    const handle = service.handler();
    const peer = connection();
    const request = (payload: unknown) =>
      handle(
        {
          version: 1,
          kind: "request",
          id: "invalid",
          operation: "launch.prepare",
          scope,
          payload,
          mac: "test",
        },
        peer,
      );
    await expect(request(null)).rejects.toThrow("launch.prepare payload");
    await expect(request({ ...preparePayload(), mode: "bad" })).rejects.toThrow("Agent mode");
    await expect(
      request({ ...preparePayload(), network: { allowedDomains: [1], deniedDomains: [] } }),
    ).rejects.toThrow("network policy");
    await expect(
      request({ ...preparePayload(), managedSkillPaths: ["workspace"] }),
    ).rejects.toThrow("Managed Skill");
    await expect(request({ ...preparePayload(), model: { provider: "openai" } })).rejects.toThrow(
      "model policy",
    );
    await expect(request({ ...preparePayload(), thinkingLevel: "invalid" })).rejects.toThrow(
      "thinking level",
    );

    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "invalid-bootstrap",
          operation: "launch.bootstrap",
          scope,
          payload: { version: 1, nonce: "nonce" },
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("preparation");
  });
});
