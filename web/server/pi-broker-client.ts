import { randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_PATH_BYTES = 100;

export interface PiBrokerEndpoint {
  socketPath: string;
  capability: string;
}

export interface PiBrokerRequestOptions {
  endpoint: PiBrokerEndpoint;
  sessionId: string;
  generation: number;
  operation: string;
  payload?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxFrameBytes?: number;
  onProgress?: (progress: unknown) => void;
}

export type PiBrokerErrorCode =
  "aborted" | "invalid_endpoint" | "invalid_response" | "remote_error" | "timeout" | "unavailable";

export class PiBrokerError extends Error {
  readonly code: PiBrokerErrorCode;

  constructor(code: PiBrokerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiBrokerError";
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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validateOptions(options: PiBrokerRequestOptions): void {
  if (
    !isAbsolute(options.endpoint.socketPath) ||
    Buffer.byteLength(options.endpoint.socketPath, "utf8") > MAX_SOCKET_PATH_BYTES ||
    !nonEmpty(options.endpoint.capability) ||
    !nonEmpty(options.sessionId) ||
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    !/^[A-Za-z0-9_.-]+$/u.test(options.operation)
  ) {
    throw new PiBrokerError("invalid_endpoint", "Managed Pi broker endpoint is invalid.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Constant-time helper shared with the server. Different lengths are rejected
 * without exposing either capability.
 */
export function equalPiBrokerCapability(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function requestPiBroker(options: PiBrokerRequestOptions): Promise<unknown> {
  validateOptions(options);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxFrameBytes = positiveInteger(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  if (options.signal?.aborted) {
    return Promise.reject(new PiBrokerError("aborted", "Managed Pi broker request was aborted."));
  }
  const id = randomUUID();
  const request = {
    type: "pi_broker_request",
    version: 1,
    id,
    sessionId: options.sessionId,
    generation: options.generation,
    capability: options.endpoint.capability,
    operation: options.operation,
    payload: options.payload,
  };
  let frame: Buffer;
  try {
    frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  } catch (error) {
    return Promise.reject(
      new PiBrokerError("invalid_endpoint", "Managed Pi broker request is not serializable.", {
        cause: error,
      }),
    );
  }
  if (frame.length - 1 > maxFrameBytes) {
    frame.fill(0);
    return Promise.reject(
      new PiBrokerError("invalid_endpoint", "Managed Pi broker request exceeds its frame limit."),
    );
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(options.endpoint.socketPath);
    const decoder = new StrictLfJsonlDecoder(maxFrameBytes);
    let settled = false;
    const finish = (error: PiBrokerError | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      frame.fill(0);
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const onAbort = (): void =>
      finish(new PiBrokerError("aborted", "Managed Pi broker request was aborted."));
    const timer = setTimeout(
      () => finish(new PiBrokerError("timeout", "Managed Pi broker request timed out.")),
      timeoutMs,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) =>
      finish(
        new PiBrokerError("unavailable", "Managed Pi broker is unavailable.", {
          cause: error,
        }),
      ),
    );
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        finish(
          new PiBrokerError("invalid_response", "Managed Pi broker framing is invalid.", {
            cause: error,
          }),
        );
        return;
      }
      for (const line of lines) {
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch (error) {
          finish(
            new PiBrokerError("invalid_response", "Managed Pi broker emitted invalid JSON.", {
              cause: error,
            }),
          );
          return;
        }
        if (
          !isRecord(value) ||
          value.version !== 1 ||
          value.id !== id ||
          typeof value.type !== "string"
        ) {
          finish(
            new PiBrokerError("invalid_response", "Managed Pi broker response binding is invalid."),
          );
          return;
        }
        if (value.type === "pi_broker_progress") {
          options.onProgress?.(value.progress);
          continue;
        }
        if (value.type !== "pi_broker_result" || typeof value.ok !== "boolean") {
          finish(
            new PiBrokerError("invalid_response", "Managed Pi broker response type is invalid."),
          );
          return;
        }
        if (value.ok) {
          finish(null, value.value);
        } else {
          finish(
            new PiBrokerError(
              "remote_error",
              typeof value.error === "string" ? value.error : "Managed Pi broker operation failed.",
            ),
          );
        }
      }
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        decoder.end();
      } catch (error) {
        finish(
          new PiBrokerError("invalid_response", "Managed Pi broker response is incomplete.", {
            cause: error,
          }),
        );
        return;
      }
      finish(new PiBrokerError("unavailable", "Managed Pi broker closed without a final result."));
    });
  });
}
