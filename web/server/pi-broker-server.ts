import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { equalPiBrokerCapability, type PiBrokerEndpoint } from "./pi-broker-client.js";
import { StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60_000;
const MAX_SOCKET_PATH_BYTES = 100;

export interface PiBrokerRequest {
  id: string;
  sessionId: string;
  generation: number;
  operation: string;
  payload?: unknown;
}

export interface PiBrokerRequestContext {
  signal: AbortSignal;
  onProgress(progress: unknown): void;
}

export interface PiBrokerServerOptions {
  socketPath: string;
  /** Resolve the current one-time/session capability; undefined rejects. */
  resolveCapability(sessionId: string, generation: number): string | undefined;
  handle(request: PiBrokerRequest, context: PiBrokerRequestContext): Promise<unknown>;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxConcurrent?: number;
}

export class PiBrokerServerError extends Error {
  readonly code: "invalid_socket" | "occupied" | "unavailable";

  constructor(code: PiBrokerServerError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiBrokerServerError";
    this.code = code;
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return result;
}

function socketPath(path: string): string {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES
  ) {
    throw new PiBrokerServerError("invalid_socket", "Managed Pi broker socket is invalid.");
  }
  return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function parseRequest(value: unknown): (PiBrokerRequest & { capability: string }) | null {
  if (
    !isRecord(value) ||
    value.type !== "pi_broker_request" ||
    value.version !== 1 ||
    !nonEmpty(value.id) ||
    !nonEmpty(value.sessionId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !nonEmpty(value.capability) ||
    !nonEmpty(value.operation) ||
    !/^[A-Za-z0-9_.-]+$/u.test(value.operation)
  ) {
    return null;
  }
  return {
    id: value.id,
    sessionId: value.sessionId,
    generation: value.generation as number,
    capability: value.capability,
    operation: value.operation,
    payload: value.payload,
  };
}

function sameSocket(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isSocket();
}

export class PiBrokerServer {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxConcurrent: number;
  private readonly options: PiBrokerServerOptions;
  private server: Server | null = null;
  private identity: Stats | null = null;
  private sockets = new Set<Socket>();
  private controllers = new Set<AbortController>();
  private active = 0;
  private disposed = false;

  constructor(options: PiBrokerServerOptions) {
    if (process.platform === "win32") {
      throw new PiBrokerServerError("invalid_socket", "Managed Pi broker requires Unix sockets.");
    }
    this.options = options;
    this.socketPath = socketPath(options.socketPath);
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 16, "maxConcurrent");
  }

  endpoint(capability: string): PiBrokerEndpoint {
    if (!nonEmpty(capability)) throw new TypeError("capability is required.");
    return { socketPath: this.socketPath, capability };
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.disposed) {
      throw new PiBrokerServerError("unavailable", "Managed Pi broker is disposed.");
    }
    const parent = dirname(this.socketPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await lstat(parent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (parentStat.mode & 0o022) !== 0
    ) {
      throw new PiBrokerServerError(
        "invalid_socket",
        "Managed Pi broker socket parent is not private.",
      );
    }
    try {
      await lstat(this.socketPath);
      throw new PiBrokerServerError("occupied", "Managed Pi broker socket path is occupied.");
    } catch (error) {
      if (error instanceof PiBrokerServerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectStart(
          new PiBrokerServerError("unavailable", "Managed Pi broker could not listen.", {
            cause: error,
          }),
        );
      };
      const onListening = () => {
        server.off("error", onError);
        resolveStart();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    try {
      await chmod(this.socketPath, 0o600);
      const identity = await lstat(this.socketPath);
      this.identity = identity;
      if (!identity.isSocket() || (identity.mode & 0o777) !== 0o600) {
        throw new PiBrokerServerError("invalid_socket", "Managed Pi broker socket is not private.");
      }
      this.server = server;
    } catch (error) {
      try {
        server.close();
      } catch {}
      await this.unlinkOwnedSocket();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.requestTimeoutMs);
    const decoder = new StrictLfJsonlDecoder(this.maxFrameBytes);
    const controller = new AbortController();
    this.controllers.add(controller);
    let handled = false;
    const cleanup = (): void => {
      this.sockets.delete(socket);
      this.controllers.delete(controller);
      controller.abort();
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    socket.once("timeout", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      if (lines.length === 0) return;
      if (lines.length !== 1) {
        socket.destroy();
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(lines[0]!) as unknown;
      } catch {
        socket.destroy();
        return;
      }
      const request = parseRequest(value);
      if (!request) {
        handled = true;
        this.result(socket, "invalid", false, undefined, "Managed Pi broker request is invalid.");
        return;
      }
      handled = true;
      void this.execute(socket, request, controller);
    });
  }

  private async execute(
    socket: Socket,
    request: PiBrokerRequest & { capability: string },
    controller: AbortController,
  ): Promise<void> {
    const expected = this.options.resolveCapability(request.sessionId, request.generation);
    if (!expected || !equalPiBrokerCapability(expected, request.capability)) {
      this.result(socket, request.id, false, undefined, "Managed Pi broker request was rejected.");
      return;
    }
    if (this.active >= this.maxConcurrent) {
      this.result(socket, request.id, false, undefined, "Managed Pi broker is busy.");
      return;
    }
    this.active += 1;
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref?.();
    try {
      const value = await this.options.handle(
        {
          id: request.id,
          sessionId: request.sessionId,
          generation: request.generation,
          operation: request.operation,
          payload: request.payload,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted && !socket.destroyed) {
              this.write(socket, {
                type: "pi_broker_progress",
                version: 1,
                id: request.id,
                progress,
              });
            }
          },
        },
      );
      if (controller.signal.aborted) {
        this.result(socket, request.id, false, undefined, "Managed Pi broker request was aborted.");
      } else {
        this.result(socket, request.id, true, value);
      }
    } catch {
      this.result(socket, request.id, false, undefined, "Managed Pi broker operation failed.");
    } finally {
      clearTimeout(timer);
      this.active -= 1;
    }
  }

  private write(socket: Socket, value: unknown, final = false): void {
    let frame: Buffer;
    try {
      frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      if (frame.length - 1 > this.maxFrameBytes) throw new Error("frame too large");
    } catch {
      socket.destroy();
      return;
    }
    if (final) socket.end(frame, () => frame.fill(0));
    else socket.write(frame, () => frame.fill(0));
  }

  private result(socket: Socket, id: string, ok: boolean, value?: unknown, error?: string): void {
    this.write(
      socket,
      ok
        ? { type: "pi_broker_result", version: 1, id, ok: true, value }
        : { type: "pi_broker_result", version: 1, id, ok: false, error },
      true,
    );
  }

  private async unlinkOwnedSocket(): Promise<void> {
    const expected = this.identity;
    this.identity = null;
    if (!expected) return;
    try {
      const current = await lstat(this.socketPath);
      if (sameSocket(expected, current)) await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const server = this.server;
    this.server = null;
    if (server) {
      try {
        server.close();
      } catch {}
    }
    for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.controllers.clear();
    this.sockets.clear();
    await this.unlinkOwnedSocket().catch(() => undefined);
  }
}
