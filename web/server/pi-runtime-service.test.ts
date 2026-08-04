import { mkdtemp, rm } from "node:fs/promises";
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

  it("routes requests through the scoped transport and rejects malformed authority", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-"));
    roots.push(requestedRoot);
    const dataRoot = realpathSync(requestedRoot);
    const transport = fakeTransport();
    const launcher = {
      launch: vi.fn(async (options: any) => ({
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
      })),
      getTransport: vi.fn(() => transport),
      validateLaunchGeneration: vi.fn(() => true),
      getSession: vi.fn(() => ({ sessionId: scope.sessionId, generation: scope.generation })),
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
        id: "prepare",
        operation: "launch.prepare",
        scope,
        payload: preparePayload(),
        mac: "test",
      },
      peer,
    )) as { nonce: string };
    await handle(
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
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "rpc",
          operation: "request",
          scope,
          payload: { input: { type: "get_state" }, awaitResponse: true },
          mac: "test",
        },
        peer,
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "input",
          operation: "request",
          scope,
          payload: { input: { type: "prompt", message: "hello" } },
          mac: "test",
        },
        peer,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "stale-request",
          operation: "request",
          scope: { ...scope, generation: 2 },
          payload: { input: { type: "get_state" }, awaitResponse: true },
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("scope is stale");
    launcher.validateLaunchGeneration.mockReturnValueOnce(false);
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "unavailable-request",
          operation: "request",
          scope,
          payload: { input: { type: "get_state" }, awaitResponse: true },
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("transport is unavailable");
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "stale-status-active",
          operation: "status",
          scope: { ...scope, generation: 2 },
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("status scope is stale");
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
    expect(transport.abort).toHaveBeenCalledOnce();
    expect(transport.sendInput).toHaveBeenCalledOnce();
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "missing-input",
          operation: "request",
          scope,
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow("input is required");
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "stale-status",
          operation: "status",
          scope: { ...scope, generation: 2 },
          payload: {},
          mac: "test",
        },
        peer,
      ),
    ).resolves.toMatchObject({ alive: true });
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(launcher.killAll).toHaveBeenCalledOnce();
  });

  it("fails closed for invalid launch and bootstrap policies", async () => {
    const requestedRoot = await mkdtemp(join(tmpdir(), "piwork-runtime-service-"));
    roots.push(requestedRoot);
    const service = new PiRuntimeService({
      dataRoot: realpathSync(requestedRoot),
      trustedExtensionPath: fileURLToPath(new URL("./pi-trusted-extension.ts", import.meta.url)),
      executionMode: "native",
      launcher: { killAll: vi.fn(async () => undefined) } as never,
    });
    const handle = service.handler();
    const peer = connection();
    const base = preparePayload();
    for (const payload of [
      null,
      { ...base, version: 2 },
      { ...base, mode: "invalid" },
      { ...base, network: { allowedDomains: "bad", deniedDomains: [] } },
      { ...base, managedSkillPaths: "bad" },
      { ...base, model: { provider: "openai" } },
      { ...base, thinkingLevel: "invalid" },
      { ...base, resumeSessionPath: "../escape" },
    ]) {
      await expect(
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
        ),
      ).rejects.toThrow();
    }
    const prepared = (await handle(
      {
        version: 1,
        kind: "request",
        id: "prepare",
        operation: "launch.prepare",
        scope,
        payload: base,
        mac: "test",
      },
      peer,
    )) as { nonce: string };
    await expect(
      handle(
        {
          version: 1,
          kind: "request",
          id: "invalid-bootstrap",
          operation: "launch.bootstrap",
          scope,
          payload: { ...bootstrapPayload(prepared.nonce), taskPolicy: { depth: "bad" } },
          mac: "test",
        },
        peer,
      ),
    ).rejects.toThrow(/task policy/);
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
  });
});
