import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

/** The versioned protocol spoken only on the Web ↔ Runtime Unix socket. */
export const PIWORK_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const PIWORK_RUNTIME_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const PIWORK_RUNTIME_MAX_ID_BYTES = 256;

export type RuntimeOperation =
  "launch.prepare" | "launch.bootstrap" | "request" | "interrupt" | "kill" | "status" | "shutdown";

export interface RuntimeScope {
  tenantId: string;
  userId: string;
  membershipId: string;
  orgNodeId: string;
  sessionId: string;
  generation: number;
}

export interface RuntimeRequestFrame {
  version: typeof PIWORK_RUNTIME_PROTOCOL_VERSION;
  kind: "request";
  id: string;
  operation: RuntimeOperation;
  scope: RuntimeScope;
  payload?: unknown;
  mac: string;
}

export interface RuntimeResponseFrame {
  version: typeof PIWORK_RUNTIME_PROTOCOL_VERSION;
  kind: "response";
  id: string;
  ok: boolean;
  scope: RuntimeScope;
  data?: unknown;
  error?: string;
  mac: string;
}

export interface RuntimeEventFrame {
  version: typeof PIWORK_RUNTIME_PROTOCOL_VERSION;
  kind: "event";
  event: "lifecycle" | "pi.notification" | "runtime.warning";
  scope: RuntimeScope;
  payload: unknown;
  mac: string;
}

export type RuntimeControlFrame = RuntimeRequestFrame | RuntimeResponseFrame | RuntimeEventFrame;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const OPERATIONS = new Set<RuntimeOperation>([
  "launch.prepare",
  "launch.bootstrap",
  "request",
  "interrupt",
  "kill",
  "status",
  "shutdown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function unsignedFrame(frame: Omit<RuntimeControlFrame, "mac">): string {
  return JSON.stringify(canonicalize(frame));
}

function macFor(frame: Omit<RuntimeControlFrame, "mac">, key: Buffer): string {
  return createHmac("sha256", key).update(unsignedFrame(frame), "utf8").digest("base64url");
}

function requireString(value: unknown, label: string, maxBytes = 512): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`Invalid runtime ${label}`);
  }
  return value;
}

function requireSafeId(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SAFE_ID.test(result)) throw new Error(`Invalid runtime ${label}`);
  return result;
}

export function assertRuntimeScope(value: unknown): RuntimeScope {
  if (!isRecord(value)) throw new Error("Runtime scope is required");
  const generation = value.generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Invalid runtime generation");
  }
  return {
    tenantId: requireSafeId(value.tenantId, "tenant id"),
    userId: requireSafeId(value.userId, "user id"),
    membershipId: requireSafeId(value.membershipId, "membership id"),
    orgNodeId: requireSafeId(value.orgNodeId, "org node id"),
    sessionId: requireSafeId(value.sessionId, "session id"),
    generation,
  };
}

export function assertRuntimeOperation(value: unknown): RuntimeOperation {
  if (typeof value !== "string" || !OPERATIONS.has(value as RuntimeOperation)) {
    throw new Error("Unsupported runtime operation");
  }
  return value as RuntimeOperation;
}

export function assertRuntimeFrame(value: unknown): RuntimeControlFrame {
  if (!isRecord(value) || value.version !== PIWORK_RUNTIME_PROTOCOL_VERSION) {
    throw new Error("Unsupported Piwork Runtime protocol version");
  }
  const kind = value.kind;
  if (kind === "request") {
    if (
      typeof value.id !== "string" ||
      !value.id ||
      Buffer.byteLength(value.id) > PIWORK_RUNTIME_MAX_ID_BYTES
    ) {
      throw new Error("Invalid runtime request id");
    }
    if (value.id.includes("\0")) throw new Error("Invalid runtime request id");
    return {
      version: 1,
      kind,
      id: value.id,
      operation: assertRuntimeOperation(value.operation),
      scope: assertRuntimeScope(value.scope),
      ...(value.payload === undefined ? {} : { payload: value.payload }),
      mac: requireString(value.mac, "message authentication code", 256),
    };
  }
  if (kind === "response") {
    if (
      typeof value.id !== "string" ||
      !value.id ||
      Buffer.byteLength(value.id) > PIWORK_RUNTIME_MAX_ID_BYTES
    ) {
      throw new Error("Invalid runtime response id");
    }
    if (typeof value.ok !== "boolean") throw new Error("Invalid runtime response status");
    return {
      version: 1,
      kind,
      id: value.id,
      ok: value.ok,
      scope: assertRuntimeScope(value.scope),
      ...(value.data === undefined ? {} : { data: value.data }),
      ...(value.error === undefined ? {} : { error: requireString(value.error, "error", 4_096) }),
      mac: requireString(value.mac, "message authentication code", 256),
    };
  }
  if (kind === "event") {
    if (
      value.event !== "lifecycle" &&
      value.event !== "pi.notification" &&
      value.event !== "runtime.warning"
    ) {
      throw new Error("Invalid runtime event type");
    }
    return {
      version: 1,
      kind,
      event: value.event,
      scope: assertRuntimeScope(value.scope),
      payload: value.payload,
      mac: requireString(value.mac, "message authentication code", 256),
    };
  }
  throw new Error("Invalid runtime frame kind");
}

export class RuntimeControlAuthenticator {
  private readonly key: Buffer;

  constructor(key: Buffer | Uint8Array | string) {
    this.key = Buffer.from(key);
    if (this.key.length < 32) throw new Error("Runtime control key must be at least 32 bytes");
  }

  sign<T extends Omit<RuntimeControlFrame, "mac">>(frame: T): T & { mac: string } {
    return { ...frame, mac: macFor(frame, this.key) };
  }

  verify(frame: RuntimeControlFrame): void {
    const { mac, ...unsigned } = frame;
    const expected = Buffer.from(macFor(unsigned, this.key), "utf8");
    const actual = Buffer.from(mac, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Runtime control message authentication failed");
    }
  }
}

export function encodeRuntimeControlFrame(
  frame: Omit<RuntimeControlFrame, "mac"> | RuntimeControlFrame,
  authenticator: RuntimeControlAuthenticator,
): Buffer {
  const signed = "mac" in frame ? frame : authenticator.sign(frame);
  const normalized = assertRuntimeFrame(signed);
  authenticator.verify(normalized);
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8");
  if (encoded.length > PIWORK_RUNTIME_MAX_FRAME_BYTES) {
    throw new Error("Runtime control frame exceeds the 8 MiB limit");
  }
  return Buffer.concat([encoded, Buffer.from("\n")]);
}

export class RuntimeControlDecoder {
  private readonly decoder = new StrictLfJsonlDecoder(PIWORK_RUNTIME_MAX_FRAME_BYTES);

  push(
    chunk: string | Uint8Array,
    authenticator: RuntimeControlAuthenticator,
  ): RuntimeControlFrame[] {
    return this.decoder.push(chunk).map((line) => {
      const frame = assertRuntimeFrame(JSON.parse(line));
      authenticator.verify(frame);
      return frame;
    });
  }

  end(): void {
    this.decoder.end();
  }
}

export function makeRuntimeRequest(
  operation: RuntimeOperation,
  scope: RuntimeScope,
  payload?: unknown,
  id: string = randomUUID(),
): Omit<RuntimeRequestFrame, "mac"> {
  return {
    version: 1,
    kind: "request",
    id: requireString(id, "request id", PIWORK_RUNTIME_MAX_ID_BYTES),
    operation,
    scope: assertRuntimeScope(scope),
    ...(payload === undefined ? {} : { payload }),
  };
}

export function isRuntimeRequest(frame: RuntimeControlFrame): frame is RuntimeRequestFrame {
  return frame.kind === "request";
}

export function isRuntimeResponse(frame: RuntimeControlFrame): frame is RuntimeResponseFrame {
  return frame.kind === "response";
}
