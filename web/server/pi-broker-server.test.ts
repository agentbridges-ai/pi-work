import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPiBroker } from "./pi-broker-client.js";
import {
  PiBrokerServer,
  PiBrokerServerError,
  type PiBrokerRequest,
  type PiBrokerRequestContext,
} from "./pi-broker-server.js";

const roots: string[] = [];

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly writes: Buffer[] = [];
  readonly ends: Buffer[] = [];
  readonly setTimeout = vi.fn((_timeoutMs: number) => this);
  readonly destroy = vi.fn(() => {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
    return this;
  });

  write(chunk: Uint8Array, callback?: () => void): boolean {
    this.writes.push(Buffer.from(chunk));
    callback?.();
    return true;
  }

  end(chunk?: Uint8Array, callback?: () => void): this {
    if (chunk) this.ends.push(Buffer.from(chunk));
    callback?.();
    return this;
  }

  data(chunk: string | Uint8Array): void {
    this.emit("data", Buffer.from(chunk));
  }

  timeout(): void {
    this.emit("timeout");
  }
}

interface TestablePiBrokerServer {
  accept(socket: Socket): void;
  identity: Stats | null;
}

function accept(server: PiBrokerServer, socket: FakeSocket): void {
  (server as unknown as TestablePiBrokerServer).accept(socket as unknown as Socket);
}

function requestFrame(
  overrides: Partial<{
    type: string;
    version: number;
    id: string;
    sessionId: string;
    generation: number;
    capability: string;
    operation: string;
    payload: unknown;
  }> = {},
): string {
  return `${JSON.stringify({
    type: "pi_broker_request",
    version: 1,
    id: "request-1",
    sessionId: "s1",
    generation: 2,
    capability: "cap-secret",
    operation: "task.run",
    payload: { prompt: "inspect" },
    ...overrides,
  })}\n`;
}

function frames(socket: FakeSocket): unknown[] {
  return [...socket.writes, ...socket.ends].map(
    (frame) => JSON.parse(frame.toString("utf8")) as unknown,
  );
}

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

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-pi-broker-"));
  roots.push(root);
  const ipc = join(root, "ipc");
  await mkdir(ipc, { mode: 0o700 });
  const handle = vi.fn(async (request: PiBrokerRequest, context: PiBrokerRequestContext) => {
    context.onProgress({ step: 1 });
    return { operation: request.operation, payload: request.payload };
  });
  const server = new PiBrokerServer({
    socketPath: join(ipc, "broker.sock"),
    resolveCapability: (sessionId, generation) =>
      sessionId === "s1" && generation === 2 ? "cap-secret" : undefined,
    handle,
  });
  try {
    await server.start();
    return { server, handle };
  } catch (error) {
    await server.dispose();
    if (error instanceof PiBrokerServerError && unavailableUnixSocket(error)) return null;
    throw error;
  }
}

describe("managed Pi broker", () => {
  it("validates socket paths, numeric limits, and endpoint capabilities", () => {
    const options = {
      socketPath: "/tmp/piwork-broker.sock",
      resolveCapability: () => "cap-secret",
      handle: vi.fn(async () => null),
    };
    const server = new PiBrokerServer(options);

    expect(server.socketPath).toBe(options.socketPath);
    expect(server.requestTimeoutMs).toBe(30 * 60_000);
    expect(server.maxFrameBytes).toBe(8 * 1024 * 1024);
    expect(server.maxConcurrent).toBe(16);
    expect(server.endpoint("cap-secret")).toEqual({
      socketPath: options.socketPath,
      capability: "cap-secret",
    });
    expect(() => server.endpoint("")).toThrow("capability is required");
    expect(() => server.endpoint("bad\0capability")).toThrow("capability is required");

    for (const socketPath of [
      "relative/broker.sock",
      "/tmp/broker\0.sock",
      `/${"a".repeat(101)}`,
    ]) {
      expect(() => new PiBrokerServer({ ...options, socketPath })).toThrowError(
        expect.objectContaining({ code: "invalid_socket" }),
      );
    }
    for (const [name, value] of [
      ["requestTimeoutMs", 0],
      ["maxFrameBytes", -1],
      ["maxConcurrent", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(() => new PiBrokerServer({ ...options, [name]: value })).toThrow(
        `${name} must be a positive safe integer`,
      );
    }
  });

  it("rejects unsafe socket parents and occupied socket paths before listening", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-pi-broker-validation-"));
    roots.push(root);
    const unsafeParent = join(root, "unsafe");
    await mkdir(unsafeParent, { mode: 0o700 });
    await chmod(unsafeParent, 0o777);
    const unsafe = new PiBrokerServer({
      socketPath: join(unsafeParent, "broker.sock"),
      resolveCapability: () => "cap",
      handle: async () => null,
    });
    await expect(unsafe.start()).rejects.toMatchObject({ code: "invalid_socket" });
    await unsafe.dispose();

    const privateParent = join(root, "private");
    await mkdir(privateParent, { mode: 0o700 });
    const occupiedPath = join(privateParent, "broker.sock");
    await writeFile(occupiedPath, "occupied", { mode: 0o600 });
    const occupied = new PiBrokerServer({
      socketPath: occupiedPath,
      resolveCapability: () => "cap",
      handle: async () => null,
    });
    await expect(occupied.start()).rejects.toMatchObject({ code: "occupied" });
    await occupied.dispose();
  });

  it("decodes fragmented strict LF JSONL and emits bound progress and result frames", async () => {
    const handle = vi.fn(async (request: PiBrokerRequest, context: PiBrokerRequestContext) => {
      context.onProgress({ step: 1 });
      return { operation: request.operation, payload: request.payload };
    });
    const server = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-fragmented.sock",
      resolveCapability: (sessionId, generation) =>
        sessionId === "s1" && generation === 2 ? "cap-secret" : undefined,
      handle,
      requestTimeoutMs: 50,
    });
    const socket = new FakeSocket();
    accept(server, socket);
    const frame = requestFrame();

    socket.data(frame.slice(0, 19));
    expect(handle).not.toHaveBeenCalled();
    socket.data(frame.slice(19));
    await eventually(() => expect(socket.ends).toHaveLength(1));

    expect(socket.setTimeout).toHaveBeenCalledWith(50);
    expect(handle).toHaveBeenCalledWith(
      {
        id: "request-1",
        sessionId: "s1",
        generation: 2,
        operation: "task.run",
        payload: { prompt: "inspect" },
      },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
    expect(frames(socket)).toEqual([
      {
        type: "pi_broker_progress",
        version: 1,
        id: "request-1",
        progress: { step: 1 },
      },
      {
        type: "pi_broker_result",
        version: 1,
        id: "request-1",
        ok: true,
        value: { operation: "task.run", payload: { prompt: "inspect" } },
      },
    ]);

    socket.data(requestFrame({ id: "request-2" }));
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    await server.dispose();
  });

  it("fail-closes malformed, coalesced, CRLF, and oversized input frames", async () => {
    const handle = vi.fn(async () => null);
    const server = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-framing.sock",
      resolveCapability: () => "cap-secret",
      handle,
      maxFrameBytes: 256,
    });

    const malformedJson = new FakeSocket();
    accept(server, malformedJson);
    malformedJson.data("{not-json}\n");
    expect(malformedJson.destroy).toHaveBeenCalledTimes(1);

    const coalesced = new FakeSocket();
    accept(server, coalesced);
    coalesced.data(`${requestFrame()}${requestFrame({ id: "request-2" })}`);
    expect(coalesced.destroy).toHaveBeenCalledTimes(1);

    const crlf = new FakeSocket();
    accept(server, crlf);
    crlf.data(requestFrame().replace(/\n$/u, "\r\n"));
    expect(crlf.destroy).toHaveBeenCalledTimes(1);

    const oversized = new FakeSocket();
    accept(server, oversized);
    oversized.data("x".repeat(257));
    expect(oversized.destroy).toHaveBeenCalledTimes(1);

    const timeout = new FakeSocket();
    accept(server, timeout);
    timeout.timeout();
    expect(timeout.destroy).toHaveBeenCalledTimes(1);

    expect(handle).not.toHaveBeenCalled();
    await server.dispose();
  });

  it("returns a terminal invalid response for every malformed request shape", async () => {
    const handle = vi.fn(async () => null);
    const server = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-invalid-requests.sock",
      resolveCapability: () => "cap-secret",
      handle,
    });
    const malformedRequests: unknown[] = [
      null,
      [],
      {},
      { type: "other", version: 1 },
      { type: "pi_broker_request", version: 2 },
      { type: "pi_broker_request", version: 1, id: "" },
      {
        type: "pi_broker_request",
        version: 1,
        id: "id",
        sessionId: "",
        generation: 2,
        capability: "cap-secret",
        operation: "task.run",
      },
      {
        type: "pi_broker_request",
        version: 1,
        id: "id",
        sessionId: "s1",
        generation: -1,
        capability: "cap-secret",
        operation: "task.run",
      },
      {
        type: "pi_broker_request",
        version: 1,
        id: "id",
        sessionId: "s1",
        generation: 2,
        capability: "",
        operation: "task.run",
      },
      {
        type: "pi_broker_request",
        version: 1,
        id: "id",
        sessionId: "s1",
        generation: 2,
        capability: "cap-secret",
        operation: "task/run",
      },
    ];

    for (const malformed of malformedRequests) {
      const socket = new FakeSocket();
      accept(server, socket);
      socket.data(`${JSON.stringify(malformed)}\n`);
      expect(frames(socket)).toEqual([
        {
          type: "pi_broker_result",
          version: 1,
          id: "invalid",
          ok: false,
          error: "Managed Pi broker request is invalid.",
        },
      ]);
    }
    expect(handle).not.toHaveBeenCalled();
    await server.dispose();
  });

  it("enforces capability generations and the concurrency limit", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const handle = vi.fn((request: PiBrokerRequest) =>
      request.id === "request-1"
        ? new Promise<unknown>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve("unexpected"),
    );
    const server = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-authority.sock",
      resolveCapability: (sessionId, generation) =>
        sessionId === "s1" && generation === 2 ? "cap-secret" : undefined,
      handle,
      maxConcurrent: 1,
    });

    const rejected = new FakeSocket();
    accept(server, rejected);
    rejected.data(requestFrame({ capability: "wrong" }));
    expect(frames(rejected)).toEqual([
      expect.objectContaining({
        id: "request-1",
        ok: false,
        error: "Managed Pi broker request was rejected.",
      }),
    ]);

    const stale = new FakeSocket();
    accept(server, stale);
    stale.data(requestFrame({ generation: 3 }));
    expect(frames(stale)).toEqual([
      expect.objectContaining({
        id: "request-1",
        ok: false,
        error: "Managed Pi broker request was rejected.",
      }),
    ]);

    const first = new FakeSocket();
    accept(server, first);
    first.data(requestFrame());
    await eventually(() => expect(resolveFirst).toBeDefined());

    const busy = new FakeSocket();
    accept(server, busy);
    busy.data(requestFrame({ id: "request-2" }));
    expect(frames(busy)).toEqual([
      expect.objectContaining({
        id: "request-2",
        ok: false,
        error: "Managed Pi broker is busy.",
      }),
    ]);

    resolveFirst?.({ finished: true });
    await eventually(() => expect(first.ends).toHaveLength(1));
    expect(frames(first)).toEqual([
      expect.objectContaining({
        id: "request-1",
        ok: true,
        value: { finished: true },
      }),
    ]);
    expect(handle).toHaveBeenCalledTimes(1);
    await server.dispose();
  });

  it("reports handler failures and aborts in-flight work when clients close", async () => {
    const failed = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-failure.sock",
      resolveCapability: () => "cap-secret",
      handle: async () => {
        throw new Error("sensitive failure");
      },
    });
    const failedSocket = new FakeSocket();
    accept(failed, failedSocket);
    failedSocket.data(requestFrame());
    await eventually(() => expect(failedSocket.ends).toHaveLength(1));
    expect(frames(failedSocket)).toEqual([
      expect.objectContaining({
        id: "request-1",
        ok: false,
        error: "Managed Pi broker operation failed.",
      }),
    ]);
    await failed.dispose();

    let context: PiBrokerRequestContext | undefined;
    const aborted = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-aborted.sock",
      resolveCapability: () => "cap-secret",
      handle: async (_request, nextContext) => {
        context = nextContext;
        await new Promise<void>((resolve) =>
          nextContext.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        nextContext.onProgress({ hidden: true });
        return "late";
      },
    });
    const abortedSocket = new FakeSocket();
    accept(aborted, abortedSocket);
    abortedSocket.data(requestFrame());
    await eventually(() => expect(context).toBeDefined());
    abortedSocket.destroyed = true;
    abortedSocket.emit("close");
    await eventually(() => expect(abortedSocket.ends).toHaveLength(1));

    expect(context?.signal.aborted).toBe(true);
    expect(abortedSocket.writes).toHaveLength(0);
    expect(frames(abortedSocket)).toEqual([
      expect.objectContaining({
        id: "request-1",
        ok: false,
        error: "Managed Pi broker request was aborted.",
      }),
    ]);
    await aborted.dispose();
  });

  it("destroys sockets when progress or result serialization exceeds the frame limit", async () => {
    const progressServer = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-large-progress.sock",
      resolveCapability: () => "cap-secret",
      handle: async (_request, context) => {
        context.onProgress({ value: "x".repeat(300) });
        return null;
      },
      maxFrameBytes: 256,
    });
    const progressSocket = new FakeSocket();
    accept(progressServer, progressSocket);
    progressSocket.data(requestFrame());
    await eventually(() => expect(progressSocket.destroy).toHaveBeenCalled());
    await progressServer.dispose();

    const resultServer = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-large-result.sock",
      resolveCapability: () => "cap-secret",
      handle: async () => ({ value: "x".repeat(300) }),
      maxFrameBytes: 256,
    });
    const resultSocket = new FakeSocket();
    accept(resultServer, resultSocket);
    resultSocket.data(requestFrame());
    await eventually(() => expect(resultSocket.destroy).toHaveBeenCalled());
    await resultServer.dispose();

    const unserializable = new PiBrokerServer({
      socketPath: "/tmp/piwork-broker-unserializable.sock",
      resolveCapability: () => "cap-secret",
      handle: async () => 1n,
    });
    const unserializableSocket = new FakeSocket();
    accept(unserializable, unserializableSocket);
    unserializableSocket.data(requestFrame());
    await eventually(() => expect(unserializableSocket.destroy).toHaveBeenCalled());
    await unserializable.dispose();
  });

  it("aborts tracked controllers, destroys sockets, and only unlinks owned sockets", async () => {
    let context: PiBrokerRequestContext | undefined;
    const root = await mkdtemp(join(tmpdir(), "piwork-pi-broker-dispose-"));
    roots.push(root);
    const existingPath = join(root, "broker.sock");
    await writeFile(existingPath, "replacement", { mode: 0o600 });
    const server = new PiBrokerServer({
      socketPath: existingPath,
      resolveCapability: () => "cap-secret",
      handle: async (_request, nextContext) => {
        context = nextContext;
        return await new Promise<never>(() => undefined);
      },
    });
    const socket = new FakeSocket();
    accept(server, socket);
    socket.data(requestFrame());
    await eventually(() => expect(context).toBeDefined());
    (server as unknown as TestablePiBrokerServer).identity = await lstat(existingPath);

    await server.dispose();
    await server.dispose();

    expect(context?.signal.aborted).toBe(true);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    await expect(lstat(existingPath)).resolves.toMatchObject({
      size: Buffer.byteLength("replacement"),
    });
    await expect(server.start()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("binds capability/session/generation and streams progress", async () => {
    const value = await fixture();
    if (!value) return;
    const progress = vi.fn();
    await expect(
      requestPiBroker({
        endpoint: value.server.endpoint("cap-secret"),
        sessionId: "s1",
        generation: 2,
        operation: "task.run",
        payload: { prompt: "inspect" },
        onProgress: progress,
      }),
    ).resolves.toEqual({
      operation: "task.run",
      payload: { prompt: "inspect" },
    });
    expect(progress).toHaveBeenCalledWith({ step: 1 });
    expect(value.handle).toHaveBeenCalledTimes(1);
    await value.server.dispose();
  });

  it("rejects wrong capabilities and stale generations without invoking handlers", async () => {
    const value = await fixture();
    if (!value) return;
    await expect(
      requestPiBroker({
        endpoint: value.server.endpoint("wrong"),
        sessionId: "s1",
        generation: 2,
        operation: "mcp.call",
      }),
    ).rejects.toMatchObject({ code: "remote_error" });
    await expect(
      requestPiBroker({
        endpoint: value.server.endpoint("cap-secret"),
        sessionId: "s1",
        generation: 1,
        operation: "mcp.call",
      }),
    ).rejects.toMatchObject({ code: "remote_error" });
    expect(value.handle).not.toHaveBeenCalled();
    await value.server.dispose();
  });

  it("propagates AbortSignal by closing and cancelling server work", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-pi-broker-abort-"));
    roots.push(root);
    await mkdir(join(root, "ipc"), { mode: 0o700 });
    let serverSignal: AbortSignal | undefined;
    const server = new PiBrokerServer({
      socketPath: join(root, "ipc", "broker.sock"),
      resolveCapability: () => "cap",
      handle: async (_request, context) => {
        serverSignal = context.signal;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("cancelled");
      },
    });
    try {
      await server.start();
    } catch (error) {
      await server.dispose();
      if (error instanceof PiBrokerServerError && unavailableUnixSocket(error)) return;
      throw error;
    }
    const controller = new AbortController();
    const request = requestPiBroker({
      endpoint: server.endpoint("cap"),
      sessionId: "s",
      generation: 1,
      operation: "task.run",
      signal: controller.signal,
    });
    await eventually(() => expect(serverSignal).toBeDefined());
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "aborted" });
    await eventually(() => expect(serverSignal?.aborted).toBe(true));
    await server.dispose();
  });
});
