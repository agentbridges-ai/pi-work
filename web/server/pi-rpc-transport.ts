import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import {
  isPiRpcResponse,
  parsePiRpcOutputJson,
  serializePiRpcInput,
  type PiExtensionUiResponse,
  type PiModel,
  type PiRpcCommand,
  type PiRpcCommandType,
  type PiRpcInput,
  type PiRpcNotification,
  type PiRpcOutput,
  type PiRpcResponse,
  type PiRpcSessionState,
  type PiThinkingLevel,
} from "./pi-rpc-contract.js";
import { observePiRpcFrame, type PiRuntimeObserver } from "./pi-runtime-observer.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export type PiJsonlFrameErrorCode =
  "frame_too_large" | "incomplete_frame" | "invalid_frame" | "invalid_utf8";

export class PiJsonlFrameError extends Error {
  readonly code: PiJsonlFrameErrorCode;

  constructor(code: PiJsonlFrameErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiJsonlFrameError";
    this.code = code;
  }
}

/**
 * Strict LF JSONL decoder. It supports arbitrary stream fragmentation and
 * coalescing. CRLF is rejected rather than normalized; U+2028/U+2029 remain
 * ordinary JSON string data and never act as framing.
 */
export class StrictLfJsonlDecoder {
  private buffered = Buffer.alloc(0);
  private ended = false;

  constructor(readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new TypeError("maxFrameBytes must be a positive safe integer.");
    }
  }

  push(chunk: string | Uint8Array): string[] {
    if (this.ended) {
      throw new PiJsonlFrameError(
        "invalid_frame",
        "Cannot append data after the JSONL stream ended.",
      );
    }
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (next.length === 0) return [];
    this.buffered =
      this.buffered.length === 0
        ? next
        : Buffer.concat([this.buffered, next], this.buffered.length + next.length);

    const lines: string[] = [];
    while (true) {
      const lf = this.buffered.indexOf(0x0a);
      if (lf < 0) break;
      if (lf > this.maxFrameBytes) {
        throw new PiJsonlFrameError(
          "frame_too_large",
          "Pi RPC JSONL frame exceeds the configured byte limit.",
        );
      }
      const frame = this.buffered.subarray(0, lf);
      this.buffered = this.buffered.subarray(lf + 1);
      if (frame.length > 0 && frame[frame.length - 1] === 0x0d) {
        throw new PiJsonlFrameError(
          "invalid_frame",
          "Pi RPC JSONL requires LF framing and does not accept CRLF.",
        );
      }
      if (frame.length === 0) {
        throw new PiJsonlFrameError("invalid_frame", "Pi RPC JSONL does not permit empty records.");
      }
      lines.push(decodeUtf8(frame));
    }

    if (this.buffered.length > this.maxFrameBytes) {
      throw new PiJsonlFrameError(
        "frame_too_large",
        "Pi RPC JSONL frame exceeds the configured byte limit.",
      );
    }
    return lines;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.buffered.length !== 0) {
      throw new PiJsonlFrameError(
        "incomplete_frame",
        "Pi RPC stdout ended with an unterminated JSONL record.",
      );
    }
  }

  get bufferedBytes(): number {
    return this.buffered.length;
  }
}

function decodeUtf8(frame: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch (error) {
    throw new PiJsonlFrameError("invalid_utf8", "Pi RPC JSONL frame is not valid UTF-8.", {
      cause: error,
    });
  }
}

export interface PiRpcProcessEvents {
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export type PiRpcTransportErrorCode =
  | PiJsonlFrameErrorCode
  | "aborted"
  | "child_error"
  | "child_exit"
  | "closed"
  | "protocol_error"
  | "request_timeout"
  | "stale_generation"
  | "stdout_eof"
  | "write_failed";

export class PiRpcTransportError extends Error {
  readonly code: PiRpcTransportErrorCode;
  readonly sessionId: string;
  readonly generation: number;

  constructor(
    code: PiRpcTransportErrorCode,
    message: string,
    context: { sessionId: string; generation: number },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PiRpcTransportError";
    this.code = code;
    this.sessionId = context.sessionId;
    this.generation = context.generation;
  }
}

export class PiRpcRemoteError extends Error {
  readonly command: PiRpcCommandType;

  constructor(command: PiRpcCommandType, message: string) {
    super(message);
    this.name = "PiRpcRemoteError";
    this.command = command;
  }
}

export interface PiRpcTransportOptions {
  sessionId: string;
  generation: number;
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable | null;
  process?: PiRpcProcessEvents;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxStderrBytes?: number;
  sensitiveValues?: readonly string[];
  observer?: PiRuntimeObserver;
  isGenerationCurrent?: (sessionId: string, generation: number) => boolean;
  onNotification?: (
    notification: PiRpcNotification,
    context: { sessionId: string; generation: number },
  ) => void;
  onLateResponse?: (
    response: PiRpcResponse,
    context: { sessionId: string; generation: number },
  ) => void;
  onProtocolError?: (
    error: PiRpcTransportError,
    context: { sessionId: string; generation: number },
  ) => void;
  onLifecycle?: (
    event:
      | { type: "closed"; code: PiRpcTransportErrorCode }
      | { type: "child_exit"; exitCode: number | null; signal: string | null },
    context: { sessionId: string; generation: number },
  ) => void;
}

export interface PiRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  abortRemoteOnSignal?: boolean;
}

interface PendingRequest {
  command: PiRpcCommandType;
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface PiRpcEntriesResult {
  entries: Record<string, unknown>[];
  leafId: string | null;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Defense-in-depth diagnostics redaction; credentials should never reach stderr. */
export function redactPiSensitiveText(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let result = text;
  for (const value of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
  }
  return result
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|oauth[_ -]?token|authorization|password|secret|capability)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|tok|key|cap)-[A-Za-z0-9._~+/=-]{6,}\b/g, "[REDACTED]");
}

function frameErrorCode(error: PiJsonlFrameError): PiRpcTransportErrorCode {
  return error.code;
}

/**
 * Generation-bound transport for one native Pi rpc-entry child. A transport
 * exclusively owns stdin/stdout; multiple writers would break correlation.
 */
export class PiRpcTransport {
  readonly sessionId: string;
  readonly generation: number;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxStderrBytes: number;

  private readonly stdin: Writable;
  private readonly stdout: Readable;
  private readonly stderr?: Readable | null;
  private readonly process?: PiRpcProcessEvents;
  private readonly decoder: StrictLfJsonlDecoder;
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sensitiveValues: readonly string[];
  private readonly observer?: PiRuntimeObserver;
  private readonly isGenerationCurrent?: PiRpcTransportOptions["isGenerationCurrent"];
  private readonly onNotification?: PiRpcTransportOptions["onNotification"];
  private readonly onLateResponse?: PiRpcTransportOptions["onLateResponse"];
  private readonly onProtocolError?: PiRpcTransportOptions["onProtocolError"];
  private readonly onLifecycle?: PiRpcTransportOptions["onLifecycle"];
  private requestCounter = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private stderrPrefix = "";
  private stderrBytes = 0;
  private stderrTruncated = false;
  private closedError: PiRpcTransportError | null = null;
  private readonly closedPromise: Promise<PiRpcTransportError>;
  private resolveClosed!: (error: PiRpcTransportError) => void;

  constructor(options: PiRpcTransportOptions) {
    if (!options.sessionId) throw new TypeError("sessionId is required.");
    if (!Number.isSafeInteger(options.generation) || options.generation < 0) {
      throw new TypeError("generation must be a non-negative safe integer.");
    }
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.process = options.process;
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
    this.maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    );
    this.decoder = new StrictLfJsonlDecoder(this.maxFrameBytes);
    this.sensitiveValues = options.sensitiveValues ?? [];
    this.observer = options.observer;
    this.isGenerationCurrent = options.isGenerationCurrent;
    this.onNotification = options.onNotification;
    this.onLateResponse = options.onLateResponse;
    this.onProtocolError = options.onProtocolError;
    this.onLifecycle = options.onLifecycle;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.attach();
  }

  private readonly handleStdoutData = (chunk: string | Buffer): void => {
    if (this.closedError) return;
    if (!this.generationIsCurrent()) {
      this.finish("stale_generation", "Pi RPC output belongs to a stale process generation.");
      return;
    }
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      if (error instanceof PiJsonlFrameError) {
        this.failProtocol(frameErrorCode(error), error.message, error);
      } else {
        this.failProtocol("protocol_error", "Pi RPC stdout framing failed.", error);
      }
      return;
    }
    for (const line of lines) {
      if (this.closedError) break;
      this.handleLine(line);
    }
  };

  private readonly handleStdoutEnd = (): void => {
    if (this.closedError) return;
    try {
      this.decoder.end();
    } catch (error) {
      if (error instanceof PiJsonlFrameError) {
        this.failProtocol(frameErrorCode(error), error.message, error);
        return;
      }
    }
    this.finish("stdout_eof", "Pi RPC stdout ended.");
  };

  private readonly handleStdoutError = (): void => {
    this.finish("closed", "Pi RPC stdout failed.");
  };

  private readonly handleStdinError = (): void => {
    this.finish("write_failed", "Pi RPC stdin failed.");
  };

  private readonly handleStdinClose = (): void => {
    if (!this.closedError) this.finish("write_failed", "Pi RPC stdin closed.");
  };

  private readonly handleStderrData = (chunk: string | Buffer): void => {
    if (this.stderrBytes >= this.maxStderrBytes) {
      this.stderrTruncated = true;
      return;
    }
    const decoded = typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
    const remaining = this.maxStderrBytes - this.stderrBytes;
    const prefix = truncateUtf8Prefix(decoded, remaining);
    this.stderrPrefix += prefix;
    this.stderrBytes = Buffer.byteLength(this.stderrPrefix, "utf8");
    if (Buffer.byteLength(decoded, "utf8") > Buffer.byteLength(prefix, "utf8")) {
      this.stderrTruncated = true;
    }
  };

  private readonly handleStderrEnd = (): void => {
    if (this.stderrBytes >= this.maxStderrBytes) return;
    const tail = this.stderrDecoder.end();
    const remaining = this.maxStderrBytes - this.stderrBytes;
    const prefix = truncateUtf8Prefix(tail, remaining);
    this.stderrPrefix += prefix;
    this.stderrBytes = Buffer.byteLength(this.stderrPrefix, "utf8");
    if (Buffer.byteLength(tail, "utf8") > Buffer.byteLength(prefix, "utf8")) {
      this.stderrTruncated = true;
    }
  };

  private readonly handleChildExit = (exitCode: number | null, signal: string | null): void => {
    this.onLifecycle?.({ type: "child_exit", exitCode, signal }, this.context());
    this.finish(
      "child_exit",
      `Pi rpc-entry exited (code=${exitCode ?? "null"}, signal=${signal ?? "null"}).`,
    );
  };

  private readonly handleChildError = (): void => {
    this.finish("child_error", "Pi rpc-entry emitted a process error.");
  };

  private attach(): void {
    this.stdout.on("data", this.handleStdoutData);
    this.stdout.once("end", this.handleStdoutEnd);
    this.stdout.once("error", this.handleStdoutError);
    this.stdin.once("error", this.handleStdinError);
    this.stdin.once("close", this.handleStdinClose);
    this.stderr?.on("data", this.handleStderrData);
    this.stderr?.once("end", this.handleStderrEnd);
    this.process?.once("exit", this.handleChildExit);
    this.process?.once("error", this.handleChildError);
  }

  private detach(): void {
    this.stdout.off("data", this.handleStdoutData);
    this.stdout.off("end", this.handleStdoutEnd);
    this.stdout.off("error", this.handleStdoutError);
    this.stdin.off("error", this.handleStdinError);
    this.stdin.off("close", this.handleStdinClose);
    this.stderr?.off("data", this.handleStderrData);
    this.stderr?.off("end", this.handleStderrEnd);
    this.process?.off("exit", this.handleChildExit);
    this.process?.off("error", this.handleChildError);
  }

  private context(): { sessionId: string; generation: number } {
    return { sessionId: this.sessionId, generation: this.generation };
  }

  private generationIsCurrent(): boolean {
    return this.isGenerationCurrent?.(this.sessionId, this.generation) ?? true;
  }

  private assertUsable(): void {
    if (this.closedError) throw this.closedError;
    if (!this.generationIsCurrent()) {
      throw this.finish("stale_generation", "Pi RPC process generation is stale.");
    }
  }

  private handleLine(line: string): void {
    let output: PiRpcOutput;
    try {
      output = parsePiRpcOutputJson(line);
    } catch (error) {
      this.failProtocol("protocol_error", "Pi RPC emitted an invalid protocol record.", error);
      return;
    }
    observePiRpcFrame(this.observer, { direction: "in", raw: line, value: output }, this.context());
    if (!isPiRpcResponse(output)) {
      this.onNotification?.(output, this.context());
      return;
    }
    if (!output.id) {
      this.failProtocol("protocol_error", "Pi RPC emitted an uncorrelated response.");
      return;
    }
    const pending = this.pending.get(output.id);
    if (!pending) {
      this.onLateResponse?.(output, this.context());
      return;
    }
    if (pending.command !== output.command) {
      this.failProtocol("protocol_error", "Pi RPC response command does not match its request id.");
      return;
    }
    this.pending.delete(output.id);
    this.cleanupPending(pending);
    pending.resolve(output);
  }

  private failProtocol(
    code: PiRpcTransportErrorCode,
    message: string,
    cause?: unknown,
  ): PiRpcTransportError {
    const error = this.finish(code, message, cause);
    this.onProtocolError?.(error, this.context());
    return error;
  }

  private finish(
    code: PiRpcTransportErrorCode,
    message: string,
    cause?: unknown,
  ): PiRpcTransportError {
    if (this.closedError) return this.closedError;
    const error = new PiRpcTransportError(code, message, this.context(), { cause });
    this.closedError = error;
    this.detach();
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
    this.resolveClosed(error);
    this.onLifecycle?.({ type: "closed", code }, this.context());
    return error;
  }

  private cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `pi-${this.generation}-${this.requestCounter}`;
  }

  private enqueueWrite(input: PiRpcInput, shouldWrite?: () => boolean): Promise<void> {
    let serialized: string;
    let encoded: Buffer;
    try {
      serialized = serializePiRpcInput(input);
      encoded = Buffer.from(serialized, "utf8");
    } catch (error) {
      return Promise.reject(error);
    }
    if (encoded.length - 1 > this.maxFrameBytes) {
      return Promise.reject(
        new PiRpcTransportError(
          "frame_too_large",
          "Outbound Pi RPC frame exceeds the configured byte limit.",
          this.context(),
        ),
      );
    }
    const operation = this.writeTail.then(async () => {
      this.assertUsable();
      // A request can expire or be aborted while it is waiting behind a
      // backpressured write. Check its pending identity immediately before
      // handing the frame to Node's Writable; once write() is called the bytes
      // cannot be recalled safely.
      if (shouldWrite && !shouldWrite()) return;
      await this.writeWithBackpressure(encoded);
      observePiRpcFrame(
        this.observer,
        {
          direction: "out",
          raw: serialized.slice(0, -1),
          value: input,
        },
        this.context(),
      );
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private writeWithBackpressure(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stdin.destroyed || !this.stdin.writable || this.stdin.writableEnded) {
        reject(this.finish("write_failed", "Pi RPC stdin is not writable."));
        return;
      }
      let callbackDone = false;
      let drainDone = false;
      let settled = false;
      const cleanup = (): void => {
        this.stdin.off("error", onError);
        this.stdin.off("close", onClose);
        this.stdin.off("drain", onDrain);
      };
      const settle = (): void => {
        if (settled || !callbackDone || !drainDone) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.finish("write_failed", "Failed to write Pi RPC stdin."));
      };
      const onError = (): void => fail();
      const onClose = (): void => fail();
      const onDrain = (): void => {
        drainDone = true;
        settle();
      };
      this.stdin.once("error", onError);
      this.stdin.once("close", onClose);
      let accepted: boolean;
      try {
        accepted = this.stdin.write(frame, (error?: Error | null) => {
          if (error) {
            fail();
            return;
          }
          callbackDone = true;
          settle();
        });
      } catch {
        fail();
        return;
      }
      drainDone = accepted;
      if (!accepted) this.stdin.once("drain", onDrain);
      settle();
    });
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  getStderr(): string {
    const redacted = redactPiSensitiveText(this.stderrPrefix, this.sensitiveValues);
    if (!this.stderrTruncated) return redacted;
    return truncateUtf8Prefix(`[stderr truncated]\n${redacted}`, this.maxStderrBytes);
  }

  waitForClose(): Promise<PiRpcTransportError> {
    return this.closedPromise;
  }

  invalidateGeneration(): void {
    this.finish("stale_generation", "Pi RPC process generation was invalidated.");
  }

  dispose(): void {
    this.finish("closed", "Pi RPC transport was disposed.");
  }

  async sendInput(input: PiRpcInput): Promise<void> {
    await this.enqueueWrite(input);
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.sendInput(response);
  }

  request(command: PiRpcCommand, options: PiRpcRequestOptions = {}): Promise<PiRpcResponse> {
    this.assertUsable();
    const id = command.id ?? this.nextRequestId();
    if (this.pending.has(id)) {
      return Promise.reject(
        new PiRpcTransportError(
          "protocol_error",
          "Pi RPC request id is already pending.",
          this.context(),
        ),
      );
    }
    const timeoutMs = positiveInteger(options.timeoutMs, this.requestTimeoutMs, "timeoutMs");
    const correlated = { ...command, id } as PiRpcCommand;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.cleanupPending(pending);
        reject(
          new PiRpcTransportError(
            "request_timeout",
            `Pi RPC request "${command.type}" timed out.`,
            this.context(),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = {
        command: command.type,
        resolve,
        reject,
        timer,
        signal: options.signal,
      };
      this.pending.set(id, pending);
      if (options.signal) {
        pending.onAbort = () => {
          if (!this.pending.delete(id)) return;
          this.cleanupPending(pending);
          reject(
            new PiRpcTransportError(
              "aborted",
              `Pi RPC request "${command.type}" was aborted.`,
              this.context(),
            ),
          );
          if (options.abortRemoteOnSignal && command.type !== "abort") {
            void this.request({ type: "abort" }).catch(() => undefined);
          }
        };
        options.signal.addEventListener("abort", pending.onAbort, { once: true });
        if (options.signal.aborted) {
          pending.onAbort();
          return;
        }
      }
      void this.enqueueWrite(correlated, () => this.pending.get(id) === pending).catch(
        (error: unknown) => {
          if (!this.pending.delete(id)) return;
          this.cleanupPending(pending);
          reject(
            error instanceof Error
              ? error
              : new PiRpcTransportError(
                  "write_failed",
                  "Failed to write Pi RPC request.",
                  this.context(),
                ),
          );
        },
      );
    });
  }

  private async successData<T>(command: PiRpcCommand, options?: PiRpcRequestOptions): Promise<T> {
    const response = await this.request(command, options);
    if (!response.success) {
      throw new PiRpcRemoteError(
        command.type,
        redactPiSensitiveText(response.error, this.sensitiveValues),
      );
    }
    return response.data as T;
  }

  async prompt(
    message: string,
    options: PiRpcRequestOptions & {
      images?: { type: "image"; data: string; mimeType: string }[];
      streamingBehavior?: "steer" | "followUp";
    } = {},
  ): Promise<void> {
    const { images, streamingBehavior, ...requestOptions } = options;
    await this.successData<void>(
      { type: "prompt", message, images, streamingBehavior },
      requestOptions,
    );
  }

  async steer(message: string, options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "steer", message }, options);
  }

  async followUp(message: string, options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "follow_up", message }, options);
  }

  async abort(options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "abort" }, options);
  }

  async getState(options?: PiRpcRequestOptions): Promise<PiRpcSessionState> {
    return this.successData<PiRpcSessionState>({ type: "get_state" }, options);
  }

  async getAvailableModels(options?: PiRpcRequestOptions): Promise<PiModel[]> {
    const data = await this.successData<{ models: PiModel[] }>(
      { type: "get_available_models" },
      options,
    );
    return data.models;
  }

  async setModel(
    provider: string,
    modelId: string,
    options?: PiRpcRequestOptions,
  ): Promise<PiModel> {
    return this.successData<PiModel>({ type: "set_model", provider, modelId }, options);
  }

  async setThinkingLevel(level: PiThinkingLevel, options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "set_thinking_level", level }, options);
  }

  async getAvailableThinkingLevels(options?: PiRpcRequestOptions): Promise<PiThinkingLevel[]> {
    const data = await this.successData<{ levels: PiThinkingLevel[] }>(
      { type: "get_available_thinking_levels" },
      options,
    );
    return data.levels;
  }

  async compact(
    customInstructions?: string,
    options?: PiRpcRequestOptions,
  ): Promise<Record<string, unknown>> {
    return this.successData<Record<string, unknown>>(
      { type: "compact", customInstructions },
      options,
    );
  }

  async setAutoRetry(enabled: boolean, options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "set_auto_retry", enabled }, options);
  }

  async retry(options?: PiRpcRequestOptions): Promise<void> {
    await this.setAutoRetry(true, options);
  }

  async abortRetry(options?: PiRpcRequestOptions): Promise<void> {
    await this.successData<void>({ type: "abort_retry" }, options);
  }

  async getEntries(since?: string, options?: PiRpcRequestOptions): Promise<PiRpcEntriesResult> {
    return this.successData<PiRpcEntriesResult>({ type: "get_entries", since }, options);
  }

  async replayHistory(since?: string, options?: PiRpcRequestOptions): Promise<PiRpcEntriesResult> {
    return this.getEntries(since, options);
  }

  async getMessages(options?: PiRpcRequestOptions): Promise<Record<string, unknown>[]> {
    const data = await this.successData<{ messages: Record<string, unknown>[] }>(
      { type: "get_messages" },
      options,
    );
    return data.messages;
  }

  async getCommands(options?: PiRpcRequestOptions): Promise<Record<string, unknown>[]> {
    const data = await this.successData<{ commands: Record<string, unknown>[] }>(
      { type: "get_commands" },
      options,
    );
    return data.commands;
  }

  async getSessionStats(options?: PiRpcRequestOptions): Promise<Record<string, unknown>> {
    return this.successData<Record<string, unknown>>({ type: "get_session_stats" }, options);
  }
}
