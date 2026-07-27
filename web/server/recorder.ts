import { chmodSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BackendType } from "./session-types.js";
import { getLocalDataRoot } from "./local-paths.js";
import { countFileLines } from "./fs-utils.js";
import { ENV, environment } from "./environment.js";
import {
  DiskQuotaStateUnavailableError,
  type DiskReservation,
  type UserDiskQuota,
} from "./user-disk-quota.js";

const DEFAULT_MAX_LINES = 1_000_000;
const DEFAULT_MAX_SESSION_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_USER_BYTES = 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function refreshUnavailableDiskQuota(diskQuota: UserDiskQuota | undefined, error: unknown): void {
  if (!diskQuota || !(error instanceof DiskQuotaStateUnavailableError)) return;
  void diskQuota.reconcile().catch((reconcileError) => {
    console.warn(
      `[recorder] Disk quota reconciliation failed: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
    );
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RecordingHeader {
  _header: true;
  version: 2;
  session_id: string;
  backend_type: "pi";
  transport: "pi-rpc";
  started_at: number;
  cwd: string;
}

export type RecordingDirection = "in" | "out";
export type RecordingChannel = "pi-rpc" | "browser" | "extension";

export type RecordingLifecycleEvent =
  | "ws_open"
  | "ws_close"
  | "ws_error"
  | "process_spawn"
  | "process_ready"
  | "process_exit"
  | "generation_change"
  | "transport_error"
  | "reconnect_attempt"
  | "reconnect_success";

export interface RecordingEntry {
  ts: number;
  dir: RecordingDirection;
  raw: string;
  ch: RecordingChannel;
  /** Optional connection lifecycle event (for disconnection diagnostics). */
  event?: RecordingLifecycleEvent;
  /** Optional runtime attribution or lifecycle metadata. */
  meta?: Record<string, unknown>;
}

export interface RecordingFileMeta {
  filename: string;
  sessionId: string;
  backendType: string;
  startedAt: string;
  /** Number of lines in the file (header + entries). */
  lines: number;
  bytes: number;
}

const REDACTED_VALUE = "[REDACTED]";
const MAX_TRACKED_PROTECTED_CALLS = 16_384;
const MAX_PENDING_TOOL_ARGUMENT_DELTAS = 256;
const SENSITIVE_FIELD =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|oauth[_-]?token|token|secret|password|credential|authorization|auth|cookie|headers?|env|environment|variables|capability|lease|commit[_-]?lease|runtime[_-]?epoch)(?:$|[_-])/i;
const BEARER_VALUE = /^\s*(?:bearer|basic)\s+\S+/i;
const URL_WITH_QUERY = /((?:https?:\/\/|\/)[^\s"'<>?]+)\?([^\s"'<>#]*)(#[^\s"'<>]*)?/giu;
const PROTECTED_BASH_COMMAND = /(?:^|[\/\s;&|()`"'])(?:user-space|onlyoffice)(?=$|[\s;&|()`"'])/u;

type ToolArgumentSensitivity = "protected" | "ordinary" | "unknown";

interface RecordingSemanticState {
  recordingSessionId?: string;
  protectedToolCallIds: Set<string>;
  protectedRpcBashIds: Set<string>;
  pendingRootToolArgumentDeltas: ToolArgumentSensitivity[];
  redactAllBashResults: boolean;
  redactAllToolArgumentDeltas: boolean;
}

interface RecordingSanitizationContext {
  channel?: RecordingChannel;
  runtimeSessionId?: string;
}

function createRecordingSemanticState(recordingSessionId?: string): RecordingSemanticState {
  return {
    recordingSessionId,
    protectedToolCallIds: new Set(),
    protectedRpcBashIds: new Set(),
    pendingRootToolArgumentDeltas: [],
    redactAllBashResults: false,
    redactAllToolArgumentDeltas: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFieldName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD.test(normalizedFieldName(name));
}

function redactUrlQueries(value: string): { value: string; changed: boolean } {
  const redacted = value.replace(
    URL_WITH_QUERY,
    (_match, base: string, _query: string, fragment: string | undefined) =>
      `${base}?${REDACTED_VALUE}${fragment ?? ""}`,
  );
  return { value: redacted, changed: redacted !== value };
}

function redactValue(value: unknown, parentKey = ""): { value: unknown; changed: boolean } {
  if (isSensitiveField(parentKey)) {
    if (value === undefined || value === null) return { value, changed: false };
    if (Array.isArray(value)) {
      return { value: value.map(() => REDACTED_VALUE), changed: value.length > 0 };
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return {
        value: Object.fromEntries(Object.keys(record).map((key) => [key, REDACTED_VALUE])),
        changed: Object.keys(record).length > 0,
      };
    }
    return { value: REDACTED_VALUE, changed: true };
  }
  if (typeof value === "string") {
    if (BEARER_VALUE.test(value)) return { value: REDACTED_VALUE, changed: true };
    return redactUrlQueries(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const sanitized = redactValue(item);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return { value: output, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = redactValue(item, key);
      changed ||= sanitized.changed;
      output[key] = sanitized.value;
    }
    return { value: output, changed };
  }
  return { value, changed: false };
}

function stringField(
  value: Record<string, unknown>,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    if (typeof value[name] === "string" && value[name]) return value[name] as string;
  }
  return undefined;
}

function commandFrom(value: Record<string, unknown>): string | undefined {
  if (typeof value.command === "string") return value.command;
  for (const key of ["args", "arguments", "input"] as const) {
    const nested = value[key];
    if (isRecord(nested) && typeof nested.command === "string") return nested.command;
  }
  return undefined;
}

function toolCallId(value: Record<string, unknown>): string | undefined {
  const explicit = stringField(value, "toolCallId", "tool_call_id");
  if (explicit) return explicit;
  return value.type === "toolCall" || value.type === "tool_call"
    ? stringField(value, "id")
    : undefined;
}

function toolName(value: Record<string, unknown>): string | undefined {
  const explicit = stringField(value, "toolName", "tool_name");
  if (explicit) return explicit;
  return value.type === "toolCall" || value.type === "tool_call"
    ? stringField(value, "name")
    : undefined;
}

function isProtectedBashCommand(command: unknown): command is string {
  return typeof command === "string" && PROTECTED_BASH_COMMAND.test(command);
}

function rememberProtectedCall(
  target: Set<string>,
  id: string | undefined,
  state: RecordingSemanticState,
): void {
  if (!id || state.redactAllBashResults) return;
  if (target.size >= MAX_TRACKED_PROTECTED_CALLS) {
    state.redactAllBashResults = true;
    state.protectedToolCallIds.clear();
    state.protectedRpcBashIds.clear();
    return;
  }
  target.add(id);
}

/**
 * Discover protected calls before rewriting the frame. Responses such as
 * agent_end/get_messages can contain a tool call and its result in the same
 * object, so a separate first pass is required regardless of object order.
 */
function discoverProtectedCalls(value: unknown, state: RecordingSemanticState): boolean {
  let found = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      const childFound = discoverProtectedCalls(item, state);
      found = childFound || found;
    }
    return found;
  }
  if (!isRecord(value)) return false;

  const command = commandFrom(value);
  if (value.type === "bash" && isProtectedBashCommand(command)) {
    rememberProtectedCall(state.protectedRpcBashIds, stringField(value, "id"), state);
    found = true;
  }
  if (value.role === "bashExecution" && isProtectedBashCommand(command)) found = true;
  if (toolName(value) === "bash" && isProtectedBashCommand(command)) {
    rememberProtectedCall(state.protectedToolCallIds, toolCallId(value), state);
    found = true;
  }

  for (const item of Object.values(value)) {
    const childFound = discoverProtectedCalls(item, state);
    found = childFound || found;
  }
  return found;
}

function classifyToolArguments(
  value: unknown,
  state: RecordingSemanticState,
): ToolArgumentSensitivity {
  if (Array.isArray(value)) {
    let result: ToolArgumentSensitivity = "unknown";
    for (const item of value) {
      const child = classifyToolArguments(item, state);
      if (child === "protected") return child;
      if (child === "ordinary") result = child;
    }
    return result;
  }
  if (!isRecord(value)) return "unknown";

  const name = toolName(value);
  if (name) {
    if (name !== "bash") return "ordinary";
    const id = toolCallId(value);
    if (
      state.redactAllBashResults ||
      (id !== undefined && state.protectedToolCallIds.has(id)) ||
      isProtectedBashCommand(commandFrom(value))
    ) {
      return "protected";
    }
    return commandFrom(value) === undefined ? "unknown" : "ordinary";
  }

  let result: ToolArgumentSensitivity = "unknown";
  for (const item of Object.values(value)) {
    const child = classifyToolArguments(item, state);
    if (child === "protected") return child;
    if (child === "ordinary") result = child;
  }
  return result;
}

function enqueueRootToolArgumentDelta(
  state: RecordingSemanticState,
  sensitivity: ToolArgumentSensitivity,
): void {
  if (state.redactAllToolArgumentDeltas) return;
  if (state.pendingRootToolArgumentDeltas.length >= MAX_PENDING_TOOL_ARGUMENT_DELTAS) {
    state.redactAllToolArgumentDeltas = true;
    state.pendingRootToolArgumentDeltas.length = 0;
    return;
  }
  state.pendingRootToolArgumentDeltas.push(sensitivity);
}

function isRootPiFrame(
  state: RecordingSemanticState,
  context: RecordingSanitizationContext,
): boolean {
  return (
    context.channel === "pi-rpc" &&
    state.recordingSessionId !== undefined &&
    context.runtimeSessionId === state.recordingSessionId
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function redactField(
  value: Record<string, unknown>,
  key: string,
  replacement: unknown = REDACTED_VALUE,
): boolean {
  if (!hasOwn(value, key) || value[key] === undefined) return false;
  value[key] = replacement;
  return true;
}

function redactStreamingDelta(
  value: Record<string, unknown>,
  reason: "protected_bash" | "uncorrelated_tool_arguments",
): boolean {
  const changed = redactField(value, "delta");
  if (changed) value._recordingRedaction = reason;
  return changed;
}

function protectedObject(): Record<string, unknown> {
  return { redacted: true };
}

function protectedContent(): Array<Record<string, string>> {
  return [{ type: "text", text: REDACTED_VALUE }];
}

function redactCommand(value: Record<string, unknown>): boolean {
  let changed = false;
  if (typeof value.command === "string") {
    value.command = REDACTED_VALUE;
    changed = true;
  }
  for (const key of ["args", "arguments", "input"] as const) {
    if (!isRecord(value[key]) || typeof value[key].command !== "string") continue;
    value[key] = { ...value[key], command: REDACTED_VALUE };
    changed = true;
  }
  return changed;
}

function redactToolResult(value: Record<string, unknown>): boolean {
  let changed = false;
  changed = redactField(value, "content", protectedContent()) || changed;
  for (const key of ["result", "partialResult", "output", "details"] as const) {
    changed = redactField(value, key, protectedObject()) || changed;
  }
  for (const key of ["delta", "progress", "error", "errorMessage", "fullOutputPath"] as const) {
    changed = redactField(value, key) || changed;
  }
  return changed;
}

function sanitizeProtectedSemantics(
  value: unknown,
  state: RecordingSemanticState,
  frameContainsProtectedBash: boolean,
  context: RecordingSanitizationContext,
): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      changed =
        sanitizeProtectedSemantics(item, state, frameContainsProtectedBash, context) || changed;
    }
    return changed;
  }
  if (!isRecord(value)) return false;

  const type = stringField(value, "type");
  if (type === "user_space_request" || type === "user_space_mutation_request") {
    changed = redactField(value, "input", protectedObject()) || changed;
  } else if (type === "user_space_response") {
    changed = redactField(value, "result", protectedObject()) || changed;
    changed = redactField(value, "error") || changed;
  } else if (type === "user_space_mutation_authorization") {
    changed = redactField(value, "error") || changed;
  } else if (
    type === "user_space_blob_checkout_request" ||
    type === "user_space_blob_checkin_request"
  ) {
    for (const key of ["mountId", "path", "hash", "baseHash", "baseMtime"] as const) {
      changed = redactField(value, key) || changed;
    }
  } else if (type === "onlyoffice_request") {
    const operationType = isRecord(value.operation)
      ? stringField(value.operation, "type")
      : undefined;
    changed =
      redactField(value, "operation", {
        ...(operationType ? { type: operationType } : {}),
        redacted: true,
      }) || changed;
    changed = redactField(value, "target", protectedObject()) || changed;
    changed = redactField(value, "editor_instance_id") || changed;
  } else if (type === "onlyoffice_response") {
    changed = redactField(value, "result", protectedObject()) || changed;
    changed = redactField(value, "error") || changed;
  } else if (type === "onlyoffice_status" && isRecord(value.document)) {
    const document = value.document;
    value.document = {
      redacted: true,
      ...(typeof document.documentType === "string" ? { documentType: document.documentType } : {}),
      ...(typeof document.writable === "boolean" ? { writable: document.writable } : {}),
      ...(typeof document.pluginReady === "boolean" ? { pluginReady: document.pluginReady } : {}),
      ...(typeof document.foreground === "boolean" ? { foreground: document.foreground } : {}),
    };
    changed = true;
  }

  const id = toolCallId(value);
  const name = toolName(value);
  const command = commandFrom(value);
  const isToolResult =
    value.role === "toolResult" ||
    type === "tool_result" ||
    type === "tool_execution_update" ||
    type === "tool_execution_end" ||
    type === "tool_execution";
  const protectedToolCall =
    (state.redactAllBashResults && isToolResult) ||
    (id !== undefined && state.protectedToolCallIds.has(id)) ||
    (name === "bash" && (state.redactAllBashResults || isProtectedBashCommand(command)));
  if (protectedToolCall) changed = redactCommand(value) || changed;

  if (protectedToolCall && isToolResult) changed = redactToolResult(value) || changed;

  if (value.role === "bashExecution" && isProtectedBashCommand(command)) {
    changed = redactCommand(value) || changed;
    changed = redactToolResult(value) || changed;
  }

  const rpcId = stringField(value, "id");
  if (
    type === "bash" &&
    (state.redactAllBashResults ||
      (rpcId !== undefined && state.protectedRpcBashIds.has(rpcId)) ||
      isProtectedBashCommand(command))
  ) {
    changed = redactCommand(value) || changed;
  }
  if (
    type === "bash_execution_update" &&
    (state.redactAllBashResults || (rpcId !== undefined && state.protectedRpcBashIds.has(rpcId)))
  ) {
    changed = redactField(value, "delta") || changed;
  }
  if (
    type === "response" &&
    value.command === "bash" &&
    (state.redactAllBashResults || (rpcId !== undefined && state.protectedRpcBashIds.has(rpcId)))
  ) {
    changed = redactField(value, "data", protectedObject()) || changed;
    changed = redactField(value, "error") || changed;
  }

  // Pi emits the validated raw message_update before its browser projection.
  // Keep a bounded root-runtime correlation queue so ordinary tool arguments
  // remain raw while protected Bash arguments are redacted in both channels.
  if (type === "message_update" && isRecord(value.assistantMessageEvent)) {
    const event = value.assistantMessageEvent;
    if (event.type === "toolcall_delta") {
      let sensitivity = state.redactAllToolArgumentDeltas
        ? "unknown"
        : frameContainsProtectedBash
          ? "protected"
          : classifyToolArguments(value.message ?? event.partial, state);
      if (isRootPiFrame(state, context)) {
        enqueueRootToolArgumentDelta(state, sensitivity);
        if (state.redactAllToolArgumentDeltas) sensitivity = "unknown";
      }
      if (sensitivity !== "ordinary") {
        changed =
          redactStreamingDelta(
            event,
            sensitivity === "protected" ? "protected_bash" : "uncorrelated_tool_arguments",
          ) || changed;
      }
    }
  }
  if (type === "message_delta" && isRecord(value.delta) && value.delta.kind === "tool_arguments") {
    const deltaToolCallId = stringField(value.delta, "toolCallId", "tool_call_id");
    const sensitivity = state.redactAllToolArgumentDeltas
      ? "unknown"
      : deltaToolCallId !== undefined && state.protectedToolCallIds.has(deltaToolCallId)
        ? "protected"
        : context.channel === "browser"
          ? (state.pendingRootToolArgumentDeltas.shift() ?? "unknown")
          : undefined;
    if (sensitivity === "protected" || sensitivity === "unknown") {
      changed =
        redactStreamingDelta(
          value.delta,
          sensitivity === "protected" ? "protected_bash" : "uncorrelated_tool_arguments",
        ) || changed;
    }
  }

  for (const item of Object.values(value)) {
    changed =
      sanitizeProtectedSemantics(item, state, frameContainsProtectedBash, context) || changed;
  }
  return changed;
}

/**
 * Preserve an ordinary JSONL frame byte-for-byte, but fail closed for malformed
 * input and redact credential-bearing fields, transient capabilities, and
 * protected User Space/ONLYOFFICE payloads before they can reach disk.
 */
export function sanitizeRecordingFrame(
  raw: string,
  sensitiveValues: readonly string[] = [],
  semanticState: RecordingSemanticState = createRecordingSemanticState(),
  context: RecordingSanitizationContext = {},
): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const frameContainsProtectedBash = discoverProtectedCalls(parsed, semanticState);
    const semanticChanged = sanitizeProtectedSemantics(
      parsed,
      semanticState,
      frameContainsProtectedBash,
      context,
    );
    const explicit = redactSensitiveStrings(parsed, sensitiveValues);
    const sanitized = redactValue(explicit.value);
    return semanticChanged || explicit.changed || sanitized.changed
      ? JSON.stringify(sanitized.value)
      : raw;
  } catch {
    return JSON.stringify({
      type: "invalid_jsonl_frame",
      bytes: Buffer.byteLength(raw, "utf8"),
    });
  }
}

function redactSensitiveStrings(
  value: unknown,
  sensitiveValues: readonly string[],
  seen = new WeakSet<object>(),
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const redacted = sensitiveValues.reduce(
      (current, secret) => (secret.length > 0 ? current.split(secret).join("[REDACTED]") : current),
      value,
    );
    return { value: redacted, changed: redacted !== value };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return { value: "[REDACTED]", changed: true };
    seen.add(value);
    let changed = false;
    const output = value.map((item) => {
      const redacted = redactSensitiveStrings(item, sensitiveValues, seen);
      changed ||= redacted.changed;
      return redacted.value;
    });
    return { value: output, changed };
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return { value: "[REDACTED]", changed: true };
    seen.add(value);
    let changed = false;
    const output = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const redactedKey = redactSensitiveStrings(key, sensitiveValues, seen);
        const redacted = redactSensitiveStrings(item, sensitiveValues, seen);
        changed ||= redactedKey.changed || redacted.changed;
        return [redactedKey.value as string, redacted.value];
      }),
    );
    return { value: output, changed };
  }
  return { value, changed: false };
}

function sanitizeRecordingMeta(
  meta: Record<string, unknown> | undefined,
  sensitiveValues: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  return redactValue(redactSensitiveStrings(meta, sensitiveValues).value).value as Record<
    string,
    unknown
  >;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

/**
 * Writes raw messages for a single session to a JSONL file.
 * First line is a header with session metadata; subsequent lines are entries.
 * Tracks its own line count so the manager can enforce the global limit.
 */
export class SessionRecorder {
  readonly filePath: string;
  private closed = false;
  private _recordWriteErrorLogged = false;
  /** Number of lines written (1 for the header at construction). */
  lineCount = 1;
  bytesWritten = 0;
  private sensitiveValues: string[] = [];
  private readonly semanticState: RecordingSemanticState;

  constructor(
    sessionId: string,
    backendType: BackendType,
    cwd: string,
    outputDir: string,
    private readonly diskQuota?: UserDiskQuota,
    semanticState?: RecordingSemanticState,
  ) {
    this.semanticState = semanticState ?? createRecordingSemanticState(sessionId);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(outputDir, 0o700);
    } catch {}
    const ts = new Date().toISOString().replace(/:/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const filename = `${sessionId}_${backendType}_${ts}_${suffix}.jsonl`;
    this.filePath = join(outputDir, filename);

    const header: RecordingHeader = {
      _header: true,
      version: 2,
      session_id: sessionId,
      backend_type: "pi",
      transport: "pi-rpc",
      started_at: Date.now(),
      cwd,
    };
    const serialized = JSON.stringify(header) + "\n";
    const serializedBytes = Buffer.byteLength(serialized);
    const reservation = this.diskQuota?.reserve(serializedBytes);
    try {
      appendFileSync(this.filePath, serialized, { encoding: "utf-8", mode: 0o600 });
      reservation?.commit();
    } catch (error) {
      // appendFileSync may have created or partially written the leaf. Charge
      // the full reserved size conservatively until async reconciliation.
      reservation?.commit();
      throw error;
    }
    try {
      chmodSync(this.filePath, 0o600);
    } catch {}
    this.bytesWritten = serializedBytes;
  }

  setSensitiveValues(values: readonly string[]): void {
    this.sensitiveValues = [
      ...new Set(values.filter((value) => typeof value === "string" && value.length > 0)),
    ];
  }

  record(
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    maxTotalBytes = Number.POSITIVE_INFINITY,
    meta?: Record<string, unknown>,
  ): boolean {
    if (this.closed) return false;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir,
      raw: sanitizeRecordingFrame(raw, this.sensitiveValues, this.semanticState, {
        channel,
        runtimeSessionId:
          meta && typeof meta.runtimeSessionId === "string" ? meta.runtimeSessionId : undefined,
      }),
      ch: channel,
      ...(meta ? { meta: sanitizeRecordingMeta(meta, this.sensitiveValues) } : {}),
    };
    let reservation: DiskReservation | undefined;
    try {
      const serialized = JSON.stringify(entry) + "\n";
      const serializedBytes = Buffer.byteLength(serialized);
      if (this.bytesWritten + serializedBytes > maxTotalBytes) return false;
      reservation = this.diskQuota?.reserve(serializedBytes);
      appendFileSync(this.filePath, serialized, { encoding: "utf-8", mode: 0o600 });
      reservation?.commit();
      this.lineCount++;
      this.bytesWritten += serializedBytes;
      return true;
    } catch (err) {
      // An append failure can leave a partial record. Commit conservatively;
      // reserve failures leave reservation undefined and therefore write none.
      reservation?.commit();
      refreshUnavailableDiskQuota(this.diskQuota, err);
      // Never throw — recording must not disrupt normal operation.
      // But log once so operators can diagnose disk/permission issues.
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(
          `[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`,
        );
      }
      return false;
    }
  }

  /** Record a connection lifecycle event (open, close, error, reconnect). */
  recordEvent(
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
    maxTotalBytes = Number.POSITIVE_INFINITY,
  ): boolean {
    if (this.closed) return false;
    const entry: RecordingEntry = {
      ts: Date.now(),
      dir: "in",
      raw: "",
      ch: channel,
      event,
      ...(meta ? { meta: sanitizeRecordingMeta(meta, this.sensitiveValues) } : {}),
    };
    let reservation: DiskReservation | undefined;
    try {
      const serialized = JSON.stringify(entry) + "\n";
      const serializedBytes = Buffer.byteLength(serialized);
      if (this.bytesWritten + serializedBytes > maxTotalBytes) return false;
      reservation = this.diskQuota?.reserve(serializedBytes);
      appendFileSync(this.filePath, serialized, { encoding: "utf-8", mode: 0o600 });
      reservation?.commit();
      this.lineCount++;
      this.bytesWritten += serializedBytes;
      return true;
    } catch (err) {
      reservation?.commit();
      refreshUnavailableDiskQuota(this.diskQuota, err);
      if (!this._recordWriteErrorLogged) {
        this._recordWriteErrorLogged = true;
        console.warn(
          `[recorder] Write failed for ${this.filePath}: ${err instanceof Error ? err.message : err}`,
        );
      }
      return false;
    }
  }

  close(): void {
    this.closed = true;
  }
}

// ─── RecorderManager ─────────────────────────────────────────────────────────

/**
 * Manages recording for all sessions.
 *
 * Enabled by default in development and disabled by default in packaged or
 * production runtimes. PIWORK_RECORD explicitly overrides either default.
 *
 * Automatic rotation: when total lines across all recording files exceed
 * maxLines (default 1 000 000, override with PIWORK_RECORDINGS_MAX_LINES),
 * the oldest files are deleted until we're back under the limit.
 */
export class RecorderManager {
  private globalEnabled: boolean;
  private recordingsDir: string;
  private maxLines: number;
  private maxSessionBytes: number;
  private maxUserBytes: number;
  private retentionDays: number;
  private recordingsDirForSession?: (sessionId: string) => string;
  private diskQuota?: UserDiskQuota;
  private perSessionEnabled = new Set<string>();
  private perSessionDisabled = new Set<string>();
  private recorders = new Map<string, SessionRecorder>();
  private sensitiveValues = new Map<string, string[]>();
  private semanticStates = new Map<string, RecordingSemanticState>();
  private dirsCreated = new Set<string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private trackedUserBytes: number | null = null;

  constructor(options?: {
    globalEnabled?: boolean;
    recordingsDir?: string;
    recordingsDirForSession?: (sessionId: string) => string;
    maxLines?: number;
    maxSessionBytes?: number;
    maxUserBytes?: number;
    retentionDays?: number;
    diskQuota?: UserDiskQuota;
  }) {
    this.globalEnabled = options?.globalEnabled ?? RecorderManager.resolveEnabled();
    this.recordingsDir =
      options?.recordingsDir ??
      environment.value(ENV.PIWORK_RECORDINGS_DIR) ??
      join(getLocalDataRoot(), "recordings");
    this.maxLines =
      options?.maxLines ?? environment.number(ENV.PIWORK_RECORDINGS_MAX_LINES, DEFAULT_MAX_LINES);
    this.maxSessionBytes =
      options?.maxSessionBytes ??
      environment.number(ENV.PIWORK_RECORDINGS_MAX_SESSION_BYTES, DEFAULT_MAX_SESSION_BYTES);
    this.maxUserBytes =
      options?.maxUserBytes ??
      environment.number(ENV.PIWORK_RECORDINGS_MAX_USER_BYTES, DEFAULT_MAX_USER_BYTES);
    this.retentionDays =
      options?.retentionDays ??
      environment.number(ENV.PIWORK_RECORDINGS_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
    this.recordingsDirForSession = options?.recordingsDirForSession;
    this.diskQuota = options?.diskQuota;

    if (this.globalEnabled) {
      // Run cleanup at startup (async, non-blocking) and periodically
      this.cleanup();
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  /**
   * Explicit PIWORK_RECORD wins. Development defaults on for protocol
   * diagnostics; packaged/production runtimes default off until the user opts in.
   */
  private static resolveEnabled(): boolean {
    const env = environment.value(ENV.PIWORK_RECORD);
    if (env === "0" || env === "false") return false;
    if (env === "1" || env === "true") return true;
    return !environment.isProduction;
  }

  isGloballyEnabled(): boolean {
    return this.globalEnabled;
  }

  getRecordingsDir(): string {
    return this.recordingsDir;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const recorder of this.recorders.values()) {
      recorder.close();
    }
    this.recorders.clear();
    this.sensitiveValues.clear();
    this.semanticStates.clear();
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  getRetentionPolicy(): { maxSessionBytes: number; maxUserBytes: number; retentionDays: number } {
    return {
      maxSessionBytes: this.maxSessionBytes,
      maxUserBytes: this.maxUserBytes,
      retentionDays: this.retentionDays,
    };
  }

  isRecording(sessionId: string): boolean {
    if (this.perSessionDisabled.has(sessionId)) return false;
    return this.globalEnabled || this.perSessionEnabled.has(sessionId);
  }

  enableForSession(sessionId: string): void {
    this.perSessionDisabled.delete(sessionId);
    this.perSessionEnabled.add(sessionId);
  }

  disableForSession(sessionId: string): void {
    this.perSessionEnabled.delete(sessionId);
    this.perSessionDisabled.add(sessionId);
    this.stopRecording(sessionId);
  }

  /**
   * Supply values already held in the server-side launch authority so an
   * accidental echo from Pi or an extension is redacted before recording.
   */
  setSensitiveValues(sessionId: string, values: readonly string[]): void {
    const safe = [...new Set(values.filter((value) => value.length > 0))];
    this.sensitiveValues.set(sessionId, safe);
    this.recorders.get(sessionId)?.setSensitiveValues(safe);
  }

  /** Add newly issued one-use capabilities without dropping existing secrets. */
  addSensitiveValues(sessionId: string, values: readonly string[]): void {
    this.setSensitiveValues(sessionId, [...(this.sensitiveValues.get(sessionId) ?? []), ...values]);
  }

  private getOrCreateRecorder(
    sessionId: string,
    backendType: BackendType,
    cwd: string,
  ): SessionRecorder | undefined {
    let recorder = this.recorders.get(sessionId);
    if (recorder) return recorder;

    const usedBeforeCreate = this.getTrackedUserBytes();
    const outputDir = this.resolveRecordingDir(sessionId);
    this.ensureDir(outputDir);
    let createdSemanticState = false;
    try {
      let semanticState = this.semanticStates.get(sessionId);
      if (!semanticState) {
        semanticState = createRecordingSemanticState(sessionId);
        this.semanticStates.set(sessionId, semanticState);
        createdSemanticState = true;
      }
      recorder = new SessionRecorder(
        sessionId,
        backendType,
        cwd,
        outputDir,
        this.diskQuota,
        semanticState,
      );
      recorder.setSensitiveValues(this.sensitiveValues.get(sessionId) || []);
    } catch (error) {
      if (createdSemanticState) this.semanticStates.delete(sessionId);
      refreshUnavailableDiskQuota(this.diskQuota, error);
      console.warn(
        `[recorder] Could not start recording for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    if (usedBeforeCreate + recorder.bytesWritten > this.maxUserBytes) {
      recorder.close();
      if (createdSemanticState) this.semanticStates.delete(sessionId);
      try {
        unlinkSync(recorder.filePath);
      } catch {}
      return undefined;
    }
    this.trackedUserBytes = usedBeforeCreate + recorder.bytesWritten;
    this.recorders.set(sessionId, recorder);
    return recorder;
  }

  /**
   * Record a raw message. No-op if recording is disabled for this session.
   * Lazily creates the SessionRecorder on first call.
   */
  record(
    sessionId: string,
    dir: RecordingDirection,
    raw: string,
    channel: RecordingChannel,
    backendType: BackendType,
    cwd: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.isRecording(sessionId)) return;

    const recorder = this.getOrCreateRecorder(sessionId, backendType, cwd);
    if (!recorder) return;
    const before = recorder.bytesWritten;
    const userRemaining = Math.max(0, this.maxUserBytes - this.getTrackedUserBytes());
    const hardLimit = Math.min(this.maxSessionBytes, recorder.bytesWritten + userRemaining);
    const recorded = recorder.record(dir, raw, channel, hardLimit, meta);
    this.trackedUserBytes = this.getTrackedUserBytes() + (recorder.bytesWritten - before);
    if (!recorded || recorder.bytesWritten >= this.maxSessionBytes) {
      recorder.close();
      this.recorders.delete(sessionId);
      this.cleanup();
    }
  }

  /** Record a connection lifecycle event for diagnostics. */
  recordEvent(
    sessionId: string,
    event: RecordingLifecycleEvent,
    channel: RecordingChannel,
    meta?: Record<string, unknown>,
    backendType?: BackendType,
    cwd?: string,
  ): void {
    if (!this.isRecording(sessionId)) return;
    const recorder =
      this.recorders.get(sessionId) ??
      (backendType && cwd ? this.getOrCreateRecorder(sessionId, backendType, cwd) : undefined);
    if (recorder) {
      const before = recorder.bytesWritten;
      const userRemaining = Math.max(0, this.maxUserBytes - this.getTrackedUserBytes());
      const hardLimit = Math.min(this.maxSessionBytes, recorder.bytesWritten + userRemaining);
      const recorded = recorder.recordEvent(event, channel, meta, hardLimit);
      this.trackedUserBytes = this.getTrackedUserBytes() + (recorder.bytesWritten - before);
      if (!recorded || recorder.bytesWritten >= this.maxSessionBytes) {
        recorder.close();
        this.recorders.delete(sessionId);
        this.cleanup();
      }
    }
  }

  stopRecording(sessionId: string): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.close();
      this.recorders.delete(sessionId);
    }
    this.semanticStates.delete(sessionId);
  }

  getRecordingStatus(sessionId: string): { filePath?: string } {
    const recorder = this.recorders.get(sessionId);
    return recorder ? { filePath: recorder.filePath } : {};
  }

  listRecordings(): RecordingFileMeta[] {
    try {
      const files = this.collectRecordingFiles();
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((filename) => {
          const fullPath = join(this.recordingsDir, filename);
          const basename = filename.split("/").pop() || filename;
          // Format: {sessionId}_{backendType}_{ISO-timestamp}_{suffix}.jsonl
          const withoutExt = basename.replace(/\.jsonl$/, "");
          const firstUnderscore = withoutExt.indexOf("_");
          const secondUnderscore = withoutExt.indexOf("_", firstUnderscore + 1);
          if (firstUnderscore === -1 || secondUnderscore === -1) {
            return { filename, sessionId: "", backendType: "", startedAt: "", lines: 0, bytes: 0 };
          }
          // Count lines — fast: just count newlines
          const lines = countFileLines(fullPath);
          return {
            filename,
            sessionId: withoutExt.substring(0, firstUnderscore),
            backendType: withoutExt.substring(firstUnderscore + 1, secondUnderscore),
            startedAt: withoutExt.substring(secondUnderscore + 1),
            lines,
            bytes: statSync(fullPath).size,
          };
        });
    } catch {
      return [];
    }
  }

  closeAll(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [, recorder] of this.recorders) {
      recorder.close();
    }
    this.recorders.clear();
    this.sensitiveValues.clear();
    this.semanticStates.clear();
  }

  /**
   * Delete oldest recording files until total lines are under maxLines.
   * Skips files that belong to active (currently recording) sessions.
   */
  cleanup(): number {
    try {
      this.ensureDir(this.recordingsDir);
      const files = this.collectRecordingFiles().filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) {
        this.trackedUserBytes = 0;
        return 0;
      }

      // Build list with line counts and mtime, sorted oldest-first
      const activeFiles = new Set<string>();
      for (const rec of this.recorders.values()) {
        activeFiles.add(rec.filePath);
      }

      const entries: {
        filename: string;
        path: string;
        sessionId: string;
        lines: number;
        bytes: number;
        mtimeMs: number;
        deleted: boolean;
      }[] = [];
      let totalLines = 0;
      let totalBytes = 0;

      for (const filename of files) {
        const fullPath = join(this.recordingsDir, filename);
        const lines = countFileLines(fullPath);
        let mtimeMs = 0;
        let bytes = 0;
        try {
          const stat = statSync(fullPath);
          mtimeMs = stat.mtimeMs;
          bytes = stat.size;
        } catch {
          continue;
        }
        const basename = filename.split("/").pop() || filename;
        const sessionId = basename.split("_")[0] || "";
        entries.push({
          filename,
          path: fullPath,
          sessionId,
          lines,
          bytes,
          mtimeMs,
          deleted: false,
        });
        totalLines += lines;
        totalBytes += bytes;
      }

      // Sort oldest first (lowest mtime = oldest)
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deleted = 0;
      const removeEntry = (entry: (typeof entries)[number]): boolean => {
        if (entry.deleted || activeFiles.has(entry.path)) return false;
        try {
          unlinkSync(entry.path);
          entry.deleted = true;
          totalLines -= entry.lines;
          totalBytes -= entry.bytes;
          deleted++;
          return true;
        } catch {
          return false;
        }
      };

      if (this.retentionDays > 0) {
        const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        for (const entry of entries) {
          if (entry.mtimeMs < cutoff) removeEntry(entry);
        }
      }

      const sessionBytes = new Map<string, number>();
      for (const entry of entries) {
        if (!entry.deleted)
          sessionBytes.set(entry.sessionId, (sessionBytes.get(entry.sessionId) || 0) + entry.bytes);
      }
      for (const entry of entries) {
        const used = sessionBytes.get(entry.sessionId) || 0;
        if (used <= this.maxSessionBytes) continue;
        if (removeEntry(entry)) sessionBytes.set(entry.sessionId, used - entry.bytes);
      }

      for (const entry of entries) {
        if (totalLines <= this.maxLines && totalBytes <= this.maxUserBytes) break;
        removeEntry(entry);
      }

      if (deleted > 0) {
        console.log(
          `[recorder] Cleanup: deleted ${deleted} old recording(s), ${totalLines} lines / ${totalBytes} bytes remaining`,
        );
      }
      this.trackedUserBytes = totalBytes;
      return deleted;
    } catch {
      return 0;
    }
  }

  private resolveRecordingDir(sessionId: string): string {
    return this.recordingsDirForSession?.(sessionId) ?? this.recordingsDir;
  }

  private collectRecordingFiles(): string[] {
    const results: string[] = [];
    const collectJsonl = (dir: string, prefix: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
    };
    collectJsonl(this.recordingsDir, "");
    let entries: Dirent[];
    try {
      entries = readdirSync(this.recordingsDir, { withFileTypes: true }) as Dirent[];
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "recordings") {
        collectJsonl(join(this.recordingsDir, entry.name), entry.name);
        continue;
      }
      collectJsonl(join(this.recordingsDir, entry.name, "recordings"), `${entry.name}/recordings`);
    }
    return results;
  }

  private ensureDir(dir: string): void {
    if (this.dirsCreated.has(dir)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {}
    this.dirsCreated.add(dir);
  }

  private getTrackedUserBytes(): number {
    if (this.trackedUserBytes !== null) return this.trackedUserBytes;
    let total = 0;
    for (const filename of this.collectRecordingFiles()) {
      try {
        total += statSync(join(this.recordingsDir, filename)).size;
      } catch {}
    }
    this.trackedUserBytes = total;
    return total;
  }
}
