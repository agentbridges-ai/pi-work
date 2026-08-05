import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  encodeRuntimeControlFrame,
  isRuntimeRequest,
  RuntimeControlAuthenticator,
  RuntimeControlDecoder,
  type RuntimeControlFrame,
  type RuntimeEventFrame,
  type RuntimeRequestFrame,
  type RuntimeScope,
} from "./runtime-control-protocol.js";

export interface RuntimeControlConnection {
  readonly remoteAddress: string;
  sendEvent(
    event: RuntimeEventFrame["event"],
    scope: RuntimeScope,
    payload: unknown,
  ): Promise<void>;
  close(): void;
}

export type RuntimeControlHandler = (
  request: RuntimeRequestFrame,
  connection: RuntimeControlConnection,
) => Promise<unknown>;

export interface RuntimeControlServerOptions {
  socketPath: string;
  authenticator: RuntimeControlAuthenticator;
  handler: RuntimeControlHandler;
  maxInFlight?: number;
  socketMode?: number;
}

const DEFAULT_MAX_IN_FLIGHT = 64;
const DEFAULT_SOCKET_MODE = 0o660;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message && !/[\r\n]/u.test(error.message)) {
    return error.message.slice(0, 4_096);
  }
  return "Runtime request failed";
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) {
    throw new Error("Runtime control socket path must be absolute");
  }
  const path = resolve(socketPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error("Runtime control path is not a Unix socket");
    await unlink(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  await chmod(dirname(path), 0o750);
}

export class RuntimeControlServer {
  private readonly server: Server;
  private readonly clients = new Set<Socket>();
  private readonly options: Required<
    Pick<RuntimeControlServerOptions, "maxInFlight" | "socketMode">
  >;
  private started = false;

  constructor(private readonly input: RuntimeControlServerOptions) {
    if (
      !Number.isSafeInteger(input.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT) ||
      (input.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT) < 1
    ) {
      throw new Error("Runtime control maxInFlight must be positive");
    }
    this.options = {
      maxInFlight: input.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
      socketMode: input.socketMode ?? DEFAULT_SOCKET_MODE,
    };
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await prepareSocketPath(this.input.socketPath);
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolveStart();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.input.socketPath);
    });
    await chmod(this.input.socketPath, this.options.socketMode);
    this.started = true;
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    if (!this.started) return;
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
    this.started = false;
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.setNoDelay(true);
    socket.once("close", () => this.clients.delete(socket));
    void this.serve(socket).catch(() => socket.destroy());
  }

  private async serve(socket: Socket): Promise<void> {
    const decoder = new RuntimeControlDecoder();
    let inFlight = 0;
    const pending = new Set<Promise<void>>();
    let closed = false;
    let writeTail: Promise<void> = Promise.resolve();

    const write = (
      frame: Omit<RuntimeControlFrame, "mac"> | RuntimeControlFrame,
    ): Promise<void> => {
      const bytes = encodeRuntimeControlFrame(frame, this.input.authenticator);
      const operation = writeTail.then(
        () =>
          new Promise<void>((resolveWrite, rejectWrite) => {
            if (closed || socket.destroyed) {
              rejectWrite(new Error("Runtime control socket is closed"));
              return;
            }
            let callbackDone = false;
            let drainDone = false;
            let settled = false;
            const cleanup = () => {
              socket.off("error", onError);
              socket.off("close", onClose);
              socket.off("drain", onDrain);
            };
            const settle = () => {
              if (settled || !callbackDone || !drainDone) return;
              settled = true;
              cleanup();
              resolveWrite();
            };
            const fail = (error: Error) => {
              if (settled) return;
              settled = true;
              cleanup();
              rejectWrite(error);
            };
            const onError = () => fail(new Error("Runtime control socket write failed"));
            const onClose = () => fail(new Error("Runtime control socket closed"));
            const onDrain = () => {
              drainDone = true;
              settle();
            };
            socket.once("error", onError);
            socket.once("close", onClose);
            const accepted = socket.write(bytes, (error?: Error | null) => {
              if (error) {
                fail(error);
                return;
              }
              callbackDone = true;
              settle();
            });
            drainDone = accepted;
            if (!accepted) socket.once("drain", onDrain);
            settle();
          }),
      );
      writeTail = operation.catch(() => undefined);
      return operation;
    };

    const connection: RuntimeControlConnection = {
      remoteAddress: socket.remoteAddress || "unix",
      sendEvent: (event, scope, payload) =>
        write({ version: 1, kind: "event", event, scope, payload }),
      close: () => socket.destroy(),
    };

    const respond = async (request: RuntimeRequestFrame): Promise<void> => {
      try {
        const data = await this.input.handler(request, connection);
        await write({
          version: 1,
          kind: "response",
          id: request.id,
          ok: true,
          scope: request.scope,
          data,
        });
      } catch (error) {
        await write({
          version: 1,
          kind: "response",
          id: request.id,
          ok: false,
          scope: request.scope,
          error: errorText(error),
        });
      } finally {
        inFlight -= 1;
      }
    };

    const onData = (chunk: Buffer) => {
      if (closed) return;
      let frames: RuntimeControlFrame[];
      try {
        frames = decoder.push(chunk, this.input.authenticator);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (!isRuntimeRequest(frame) || inFlight >= this.options.maxInFlight) {
          socket.destroy();
          return;
        }
        inFlight += 1;
        const work = respond(frame).catch(() => {
          socket.destroy();
        });
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => undefined);
      }
    };
    socket.on("data", onData);
    await new Promise<void>((resolveServe) => {
      socket.once("close", () => {
        closed = true;
        socket.off("data", onData);
        resolveServe();
      });
      socket.once("error", () => {
        closed = true;
        socket.off("data", onData);
        resolveServe();
      });
    });
    await Promise.allSettled([...pending]);
    try {
      decoder.end();
    } catch {}
  }
}

export interface RuntimeControlClientOptions {
  socketPath: string;
  authenticator: RuntimeControlAuthenticator;
  connectTimeoutMs?: number;
}

export class RuntimeControlClient {
  private socket?: Socket;
  private decoder = new RuntimeControlDecoder();
  private counter = 0;
  private readonly pending = new Map<
    string,
    {
      scope: RuntimeScope;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly eventHandlers = new Set<(event: RuntimeEventFrame) => void>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeControlClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (!isAbsolute(this.options.socketPath))
      throw new Error("Runtime control socket path must be absolute");
    const socket = createConnection(this.options.socketPath);
    this.socket = socket;
    this.decoder = new RuntimeControlDecoder();
    this.writeTail = Promise.resolve();
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.once("error", (error) => this.fail(error));
    socket.once("close", () => this.fail(new Error("Runtime control socket closed")));
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const timer = setTimeout(() => {
        socket.destroy();
        rejectConnect(new Error("Runtime control socket connection timed out"));
      }, this.options.connectTimeoutMs ?? 5_000);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolveConnect();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectConnect(error);
      });
    });
  }

  onEvent(handler: (event: RuntimeEventFrame) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async request(
    scope: RuntimeScope,
    operation: RuntimeRequestFrame["operation"],
    payload?: unknown,
  ): Promise<unknown> {
    await this.connect();
    const id = `runtime-${++this.counter}`;
    const frame = {
      version: 1 as const,
      kind: "request" as const,
      id,
      operation,
      scope,
      ...(payload === undefined ? {} : { payload }),
    };
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { scope, resolve: resolveRequest, reject: rejectRequest });
      void this.write(frame).catch((error: unknown) => {
        this.pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async close(): Promise<void> {
    this.fail(new Error("Runtime control client closed"));
    this.socket?.destroy();
    this.socket = undefined;
  }

  private write(frame: Omit<RuntimeControlFrame, "mac">): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Runtime control socket is closed"));
    const bytes = encodeRuntimeControlFrame(frame, this.options.authenticator);
    const operation = this.writeTail.then(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          let callbackDone = false;
          let drainDone = false;
          let settled = false;
          const cleanup = () => {
            socket.off("error", onError);
            socket.off("close", onClose);
            socket.off("drain", onDrain);
          };
          const settle = () => {
            if (settled || !callbackDone || !drainDone) return;
            settled = true;
            cleanup();
            resolveWrite();
          };
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectWrite(error);
          };
          const onError = () => fail(new Error("Runtime control socket write failed"));
          const onClose = () => fail(new Error("Runtime control socket closed"));
          const onDrain = () => {
            drainDone = true;
            settle();
          };
          socket.once("error", onError);
          socket.once("close", onClose);
          const accepted = socket.write(bytes, (error?: Error | null) => {
            if (error) {
              fail(error);
              return;
            }
            callbackDone = true;
            settle();
          });
          drainDone = accepted;
          if (!accepted) {
            socket.once("drain", onDrain);
          }
          settle();
        }),
    );
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk, this.options.authenticator)) {
        if (frame.kind === "event") {
          for (const handler of this.eventHandlers) handler(frame);
          continue;
        }
        if (frame.kind !== "response") continue;
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        if (!sameRuntimeScope(pending.scope, frame.scope)) {
          pending.reject(new Error("Runtime response scope does not match its request"));
          this.fail(new Error("Runtime response scope does not match its request"));
          this.socket?.destroy();
          return;
        }
        if (frame.ok) pending.resolve(frame.data);
        else pending.reject(new Error(frame.error || "Runtime request failed"));
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.socket?.destroy();
    }
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function sameRuntimeScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.membershipId === right.membershipId &&
    left.orgNodeId === right.orgNodeId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation
  );
}
