import { EventEmitter } from "node:events";
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumePiBootstrap,
  isMcpBootstrap,
  isPiBootstrapPayload,
  isProviderModelBootstrap,
  PiBootstrapError,
  PiBootstrapServer,
  type PiBootstrapPayload,
} from "./pi-bootstrap-channel.js";

const roots: string[] = [];

function unavailableUnixSocket(error: unknown): boolean {
  const isBun = "bun" in process.versions;
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const value = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (
      value.code === "EPERM" ||
      value.code === "EACCES" ||
      value.code === "EOPNOTSUPP" ||
      value.code === "ENOSYS"
    ) {
      return true;
    }
    if (
      typeof value.message === "string" &&
      (/operation not permitted|permission denied/iu.test(value.message) ||
        (isBun && /failed to listen|could not listen/iu.test(value.message)))
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function payload(root: string): PiBootstrapPayload {
  return {
    version: 1,
    sessionId: "session-a",
    generation: 4,
    authorizedRoots: [{ path: join(root, "workspace"), access: "write" }],
    mode: "plan",
    providers: [
      {
        name: "managed",
        config: {
          api: "openai-completions",
          apiKey: "sk-bootstrap-canary",
          models: [{ id: "model-a", name: "Model A" }],
        },
      },
    ],
    managedSkills: [{ path: join(root, "skills", "SKILL.md"), name: "managed" }],
    mcp: [
      {
        name: "docs",
        enabled: true,
        status: "connected",
        transport: "streamable-http",
        tools: [{ name: "search", readOnly: true }],
      },
    ],
    taskPolicy: {
      depth: 0,
      maxDepth: 2,
      maxParallel: 4,
      brokerSocket: join(root, "task.sock"),
      capability: "task-capability",
    },
    productTools: {
      userSpaceCapability: "user-space-capability",
    },
    mcpBroker: {
      socketPath: join(root, "mcp.sock"),
      capability: "mcp-capability",
    },
  };
}

async function serverFixture(options: { ttlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "piwork-bootstrap-"));
  roots.push(root);
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  const socketDir = join(root, "ipc");
  await mkdir(socketDir, { mode: 0o700 });
  const server = new PiBootstrapServer({
    socketPath: join(socketDir, "bootstrap.sock"),
    payload: payload(root),
    ttlMs: options.ttlMs,
  });
  try {
    await server.start();
    return { root, server };
  } catch (error) {
    await server.dispose();
    if (error instanceof PiBootstrapError && unavailableUnixSocket(error)) return null;
    throw error;
  }
}

function rawRequest(socketPath: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.once("error", rejectResponse);
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    socket.once("end", () => {
      try {
        resolveResponse(JSON.parse(output.trim()) as Record<string, unknown>);
      } catch (error) {
        rejectResponse(error);
      }
    });
    socket.once("connect", () => socket.end(`${JSON.stringify(value)}\n`));
  });
}

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  timeoutMs: number | null = null;
  destroyed = false;

  setTimeout(timeoutMs: number): this {
    this.timeoutMs = timeoutMs;
    return this;
  }

  write(frame: string | Uint8Array): boolean {
    this.writes.push(Buffer.from(frame));
    return true;
  }

  end(frame?: string | Uint8Array, callback?: () => void): this {
    if (frame !== undefined) this.writes.push(Buffer.from(frame));
    callback?.();
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  response(): Record<string, unknown> {
    return JSON.parse(Buffer.concat(this.writes).toString("utf8").trim()) as Record<
      string,
      unknown
    >;
  }
}

interface BootstrapServerInternals {
  handleConnection(socket: never): void;
}

function connectFake(server: PiBootstrapServer): FakeSocket {
  const socket = new FakeSocket();
  (server as unknown as BootstrapServerInternals).handleConnection(socket as never);
  return socket;
}

function consumeFrame(sessionId = "session-a", generation = 4): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: "pi_bootstrap_consume",
      version: 1,
      sessionId,
      generation,
    })}\n`,
  );
}

describe("Pi one-shot bootstrap channel", () => {
  it("uses a 0600 socket, binds session+generation, and consumes exactly once", async () => {
    const fixture = await serverFixture();
    if (!fixture) return;
    const { server } = fixture;
    expect((await lstat(server.socketPath)).mode & 0o777).toBe(0o600);

    const rejected = await rawRequest(server.socketPath, {
      type: "pi_bootstrap_consume",
      version: 1,
      sessionId: "other",
      generation: 4,
    });
    expect(rejected).toMatchObject({ type: "pi_bootstrap_error", code: "binding_mismatch" });
    expect(server.consumed).toBe(false);

    const consumed = consumePiBootstrap({
      socketPath: server.socketPath,
      sessionId: "session-a",
      generation: 4,
    });
    await expect(consumed).resolves.toMatchObject({
      sessionId: "session-a",
      generation: 4,
      mode: "plan",
      providers: [{ name: "managed" }],
      productTools: { userSpaceCapability: "user-space-capability" },
    });
    await expect(server.waitForConsumption()).resolves.toBeUndefined();
    expect(server.consumed).toBe(true);
    await expect(lstat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects occupied paths and broad socket-parent permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-bootstrap-invalid-"));
    roots.push(root);
    const broad = join(root, "broad");
    await mkdir(broad, { mode: 0o777 });
    const original = process.umask(0);
    try {
      await rm(broad, { recursive: true });
      await mkdir(broad, { mode: 0o777 });
    } finally {
      process.umask(original);
    }
    const server = new PiBootstrapServer({
      socketPath: join(broad, "bootstrap.sock"),
      payload: payload(root),
    });
    await expect(server.start()).rejects.toThrow(/permissions/);
    await server.dispose();
  });

  it("expires without returning secrets and rejects invalid policy payloads", async () => {
    const fixture = await serverFixture({ ttlMs: 10 });
    if (!fixture) return;
    const waiting = fixture.server.waitForConsumption();
    await expect(waiting).rejects.toMatchObject({ code: "expired" });
    await expect(lstat(fixture.server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

    const root = await mkdtemp(join(tmpdir(), "piwork-bootstrap-schema-"));
    roots.push(root);
    expect(
      () =>
        new PiBootstrapServer({
          socketPath: join(root, "b.sock"),
          payload: {
            ...payload(root),
            taskPolicy: { depth: 3, maxDepth: 2, maxParallel: 5 },
          },
        }),
    ).toThrow(/schema/);
    expect(
      () =>
        new PiBootstrapServer({
          socketPath: join(root, "credential.sock"),
          payload: {
            ...payload(root),
            mcp: [
              {
                ...payload(root).mcp[0]!,
                headers: { Authorization: "Bearer mcp-canary" },
              },
            ],
          } as unknown as PiBootstrapPayload,
        }),
    ).toThrow(/schema/);
  });

  it("does not include credential material in rejection errors", async () => {
    await expect(
      consumePiBootstrap({
        socketPath: join(tmpdir(), "missing-piwork-bootstrap.sock"),
        sessionId: "session-a",
        generation: 4,
        timeoutMs: 50,
      }),
    ).rejects.not.toThrow(/sk-bootstrap-canary|mcp-canary/);
  });

  it("validates complete provider model metadata and rejects unsafe provider shapes", () => {
    const valid = {
      id: "model-a",
      name: "Model A",
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 8_192,
      headers: { "X-Tenant": "tenant-a" },
      input: ["text", "image"],
      thinkingLevelMap: { off: null, high: "high" },
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 0.2,
        tiers: [
          {
            input: 2,
            output: 4,
            cacheRead: 0.2,
            cacheWrite: 0.4,
            inputTokensAbove: 100_000,
          },
        ],
      },
      compat: {
        supportsReasoningEffort: true,
        chatTemplateKwargs: { nested: ["safe", 1, null] },
      },
    };
    expect(isProviderModelBootstrap(valid)).toBe(true);

    for (const baseUrl of [
      "ftp://models.example.test",
      "https://user:pass@models.example.test",
      "https://models.example.test/v1?apiKey=secret",
      "https://models.example.test/v1#secret",
      "not a url",
    ]) {
      expect(isProviderModelBootstrap({ ...valid, baseUrl })).toBe(false);
    }
    expect(isProviderModelBootstrap({ ...valid, unexpected: true })).toBe(false);
    expect(isProviderModelBootstrap({ ...valid, headers: { "": "value" } })).toBe(false);
    expect(isProviderModelBootstrap({ ...valid, input: ["audio"] })).toBe(false);
    expect(isProviderModelBootstrap({ ...valid, contextWindow: 0 })).toBe(false);
    expect(isProviderModelBootstrap({ ...valid, maxTokens: Number.NaN })).toBe(false);
    expect(
      isProviderModelBootstrap({
        ...valid,
        thinkingLevelMap: { impossible: "value" },
      }),
    ).toBe(false);
    expect(
      isProviderModelBootstrap({
        ...valid,
        cost: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBe(false);
    expect(
      isProviderModelBootstrap({
        ...valid,
        cost: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [
            {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              inputTokensAbove: 0,
            },
          ],
        },
      }),
    ).toBe(false);
    expect(isProviderModelBootstrap({ ...valid, compat: { apiKey: "forbidden" } })).toBe(false);

    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth < 20; depth++) tooDeep = { nested: tooDeep };
    expect(
      isProviderModelBootstrap({
        ...valid,
        compat: { chatTemplateKwargs: tooDeep },
      }),
    ).toBe(false);
  });

  it("validates all managed MCP transports and fail-closed read-only metadata", () => {
    const base = {
      name: "docs",
      enabled: true,
      status: "connected",
      tools: [
        {
          name: "search",
          description: "Search managed docs",
          inputSchema: { type: "object" },
          readOnly: true,
        },
      ],
      readOnlyTools: ["search"],
    } as const;

    expect(isMcpBootstrap({ ...base, transport: "stdio" })).toBe(true);
    expect(isMcpBootstrap({ ...base, status: "connecting", transport: "sse" })).toBe(true);
    expect(isMcpBootstrap({ ...base, status: "failed", transport: "streamable-http" })).toBe(true);
    expect(
      isMcpBootstrap({
        ...base,
        enabled: false,
        status: "disabled",
        transport: "stdio",
      }),
    ).toBe(true);
    expect(isMcpBootstrap({ ...base, transport: "sdk" })).toBe(false);
    expect(isMcpBootstrap({ ...base, enabled: false, transport: "stdio" })).toBe(false);
    expect(isMcpBootstrap({ ...base, status: "disabled", transport: "streamable-http" })).toBe(
      false,
    );
    expect(
      isMcpBootstrap({
        ...base,
        transport: "stdio",
        tools: [{ name: "write", readOnly: "yes" }],
      }),
    ).toBe(false);
    expect(isMcpBootstrap({ ...base, transport: "stdio", readOnlyTools: [""] })).toBe(false);
  });

  it("rejects malformed authority, capability, skill, task, and secret payload fields", () => {
    const root = join(tmpdir(), "piwork-bootstrap-validation");
    const valid = payload(root);
    expect(
      isPiBootstrapPayload({
        ...valid,
        mode: "agent",
        instructions: "Server-governed instructions",
        authorizedRoots: [
          { path: join(root, "workspace"), access: "write" },
          { path: join(root, "knowledge"), access: "read" },
        ],
        managedSkills: [
          {
            path: join(root, "skills", "SKILL.md"),
            name: "managed",
            sha256: "a".repeat(64),
          },
        ],
        taskPolicy: { ...valid.taskPolicy, readOnly: true },
      }),
    ).toBe(true);

    const invalid: unknown[] = [
      { ...valid, extra: "field" },
      { ...valid, sessionId: "bad\0session" },
      { ...valid, generation: -1 },
      { ...valid, mode: "claude" },
      { ...valid, instructions: "bad\0instruction" },
      { ...valid, authorizedRoots: [{ path: "relative", access: "write" }] },
      { ...valid, authorizedRoots: [{ path: root, access: "admin" }] },
      {
        ...valid,
        providers: [{ ...valid.providers[0], config: { api: "x", apiKey: "", models: [] } }],
      },
      { ...valid, managedSkills: [{ path: "relative" }] },
      { ...valid, managedSkills: [{ path: root, sha256: "not-a-digest" }] },
      { ...valid, taskPolicy: { depth: 0, maxDepth: 3, maxParallel: 4 } },
      { ...valid, taskPolicy: { depth: 2, maxDepth: 1, maxParallel: 4 } },
      { ...valid, taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 0 } },
      { ...valid, taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 5 } },
      { ...valid, taskPolicy: { ...valid.taskPolicy, brokerSocket: "relative" } },
      { ...valid, taskPolicy: { ...valid.taskPolicy, capability: "" } },
      { ...valid, productTools: { userSpaceCapability: "" } },
      { ...valid, productTools: { userSpaceCapability: "ok", unexpected: true } },
      { ...valid, mcpBroker: { socketPath: "relative", capability: "capability" } },
      { ...valid, mcpBroker: { socketPath: join(root, "mcp.sock"), capability: "" } },
    ];
    for (const value of invalid) expect(isPiBootstrapPayload(value)).toBe(false);

    const throwingJson = payload(root) as PiBootstrapPayload & {
      toJSON?: () => never;
    };
    Object.defineProperty(throwingJson, "toJSON", {
      enumerable: false,
      value: () => {
        throw new Error("must not serialize");
      },
    });
    expect(isPiBootstrapPayload(throwingJson)).toBe(false);
  });

  it("enforces socket and timeout constructor bounds before opening a channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-bootstrap-bounds-"));
    roots.push(root);
    expect(
      () => new PiBootstrapServer({ socketPath: "relative.sock", payload: payload(root) }),
    ).toThrow(/socket path/);
    expect(
      () =>
        new PiBootstrapServer({
          socketPath: `/${"x".repeat(101)}`,
          payload: payload(root),
        }),
    ).toThrow(/socket path/);
    for (const options of [{ ttlMs: 0 }, { requestTimeoutMs: 0 }, { maxResponseFrameBytes: 0 }]) {
      expect(
        () =>
          new PiBootstrapServer({
            socketPath: join(root, `${Object.keys(options)[0]}.sock`),
            payload: payload(root),
            ...options,
          }),
      ).toThrow(/positive safe integer/);
    }
    await expect(
      consumePiBootstrap({
        socketPath: join(root, "unused.sock"),
        sessionId: "",
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(
      consumePiBootstrap({
        socketPath: join(root, "unused.sock"),
        sessionId: "session",
        generation: -1,
      }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(
      consumePiBootstrap({
        socketPath: join(root, "unused.sock"),
        sessionId: "session",
        generation: 1,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/positive safe integer/);
  });

  it("rejects untrusted socket parents and occupied socket paths before listen", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-bootstrap-parent-"));
    roots.push(root);
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    const linkedServer = new PiBootstrapServer({
      socketPath: join(linked, "bootstrap.sock"),
      payload: payload(root),
    });
    await expect(linkedServer.start()).rejects.toThrow(/trusted directory/);
    await linkedServer.dispose();

    const occupiedDir = join(root, "occupied");
    await mkdir(occupiedDir, { mode: 0o700 });
    const occupiedPath = join(occupiedDir, "bootstrap.sock");
    await writeFile(occupiedPath, "not a socket", { mode: 0o600 });
    const occupiedServer = new PiBootstrapServer({
      socketPath: occupiedPath,
      payload: payload(root),
    });
    await expect(occupiedServer.start()).rejects.toThrow(/already occupied/);
    await occupiedServer.dispose();
  });

  it("handles fragmented requests, consumes once, and clears in-memory capabilities", async () => {
    const root = join(tmpdir(), "piwork-bootstrap-fake");
    const original = payload(root);
    const server = new PiBootstrapServer({
      socketPath: join(root, "bootstrap.sock"),
      payload: original,
    });
    const waiting = server.waitForConsumption();
    const socket = connectFake(server);
    const frame = consumeFrame();
    socket.emit("data", frame.subarray(0, 8));
    expect(socket.writes).toHaveLength(0);
    socket.emit("data", frame.subarray(8));
    await expect(waiting).resolves.toBeUndefined();
    expect(server.consumed).toBe(true);
    expect(socket.timeoutMs).toBe(5_000);
    expect(socket.response()).toMatchObject({
      type: "pi_bootstrap_payload",
      sessionId: "session-a",
      generation: 4,
      payload: {
        providers: [{ config: { apiKey: "sk-bootstrap-canary" } }],
        mcpBroker: { capability: "mcp-capability" },
      },
    });
    expect(original.providers[0]?.config.apiKey).toBe("sk-bootstrap-canary");
    await expect(server.waitForConsumption()).resolves.toBeUndefined();

    const replay = connectFake(server);
    replay.emit("data", consumeFrame());
    expect(replay.response()).toEqual({
      type: "pi_bootstrap_error",
      version: 1,
      code: "consumed",
    });
    expect(JSON.stringify(replay.response())).not.toContain("sk-bootstrap-canary");
    await server.dispose();
    await server.dispose();
  });

  it("fails closed for invalid, oversized, coalesced, timed-out, and mismatched requests", () => {
    const root = join(tmpdir(), "piwork-bootstrap-fail-closed");
    const cases: Array<{ chunks?: Buffer[]; event?: "timeout" | "end"; code: string }> = [
      { chunks: [Buffer.from("not-json\n")], code: "invalid_request" },
      { chunks: [Buffer.from("{}\n")], code: "invalid_request" },
      {
        chunks: [Buffer.concat([consumeFrame(), consumeFrame()])],
        code: "invalid_request",
      },
      { chunks: [Buffer.from(`${"x".repeat(16 * 1024 + 1)}\n`)], code: "invalid_request" },
      { chunks: [consumeFrame("other", 4)], code: "binding_mismatch" },
      { chunks: [consumeFrame("session-a", 5)], code: "binding_mismatch" },
      { event: "timeout", code: "invalid_request" },
      { chunks: [Buffer.from('{"type":')], event: "end", code: "invalid_request" },
    ];

    for (const scenario of cases) {
      const server = new PiBootstrapServer({
        socketPath: join(root, `${Math.random()}.sock`),
        payload: payload(root),
      });
      const socket = connectFake(server);
      for (const chunk of scenario.chunks ?? []) socket.emit("data", chunk);
      if (scenario.event) socket.emit(scenario.event);
      expect(socket.response()).toMatchObject({
        type: "pi_bootstrap_error",
        code: scenario.code,
      });
      expect(JSON.stringify(socket.response())).not.toContain("sk-bootstrap-canary");
    }
  });

  it("destroys pending sockets and rejects waiters with the disposal reason", async () => {
    const root = join(tmpdir(), "piwork-bootstrap-dispose");
    const server = new PiBootstrapServer({
      socketPath: join(root, "bootstrap.sock"),
      payload: payload(root),
    });
    const socket = connectFake(server);
    const waiting = server.waitForConsumption();
    const reason = new PiBootstrapError("expired", "capability expired");
    await server.dispose(reason);
    expect(socket.destroyed).toBe(true);
    await expect(waiting).rejects.toBe(reason);
    await expect(server.waitForConsumption()).rejects.toMatchObject({ code: "unavailable" });
    await expect(server.start()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("uses independent one-shot channels for child agents", async () => {
    const root = join(tmpdir(), "piwork-bootstrap-child");
    const childPayload: PiBootstrapPayload = {
      ...payload(root),
      sessionId: "child-session",
      generation: 9,
      providers: [
        {
          ...payload(root).providers[0]!,
          config: {
            ...payload(root).providers[0]!.config,
            apiKey: "sk-child-one-shot",
          },
        },
      ],
      taskPolicy: {
        depth: 1,
        maxDepth: 2,
        maxParallel: 4,
        readOnly: true,
        brokerSocket: join(root, "child-task.sock"),
        capability: "child-task-capability",
      },
      productTools: { userSpaceCapability: "child-user-space-capability" },
      mcpBroker: {
        socketPath: join(root, "child-mcp.sock"),
        capability: "child-mcp-capability",
      },
    };
    const parent = new PiBootstrapServer({
      socketPath: join(root, "parent.sock"),
      payload: payload(root),
    });
    const child = new PiBootstrapServer({
      socketPath: join(root, "child.sock"),
      payload: childPayload,
    });
    const parentSocket = connectFake(parent);
    const childSocket = connectFake(child);
    parentSocket.emit("data", consumeFrame("session-a", 4));
    childSocket.emit("data", consumeFrame("child-session", 9));
    await Promise.all([parent.waitForConsumption(), child.waitForConsumption()]);

    const parentText = JSON.stringify(parentSocket.response());
    const childText = JSON.stringify(childSocket.response());
    expect(parentText).toContain("task-capability");
    expect(parentText).not.toContain("sk-child-one-shot");
    expect(childText).toContain("sk-child-one-shot");
    expect(childText).toContain("child-task-capability");
    expect(childText).not.toContain("sk-bootstrap-canary");
  });
});
