import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 30_000;
const MAX_REQUEST_FRAME_BYTES = 16 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export type PiAgentMode = "agent" | "plan";

export interface AuthorizedRoot {
  path: string;
  access: "read" | "write";
}

export interface ProviderBootstrap {
  name: string;
  config: {
    name?: string;
    baseUrl?: string;
    apiKey: string;
    api: string;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models: ProviderModelBootstrap[];
  };
}

export interface ProviderModelBootstrap {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >;
  input?: Array<"text" | "image">;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      inputTokensAbove: number;
    }>;
  };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface McpToolBootstrap {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpBootstrap {
  name: string;
  enabled: boolean;
  status: "connected" | "failed" | "disabled" | "connecting";
  transport: "stdio" | "sse" | "streamable-http";
  tools: McpToolBootstrap[];
  /** Optional materialized summary; tools[].readOnly remains authoritative. */
  readOnlyTools?: string[];
}

export interface TaskPolicy {
  depth: number;
  maxDepth: number;
  maxParallel: number;
  readOnly?: boolean;
  brokerSocket?: string;
  capability?: string;
}

export interface ProductToolBootstrap {
  /** Generation capability for the protected User Space and OnlyOffice broker. */
  userSpaceCapability: string;
}

export interface ManagedSkillBootstrap {
  path: string;
  name?: string;
  sha256?: string;
}

export interface PiBootstrapPayload {
  version: 1;
  sessionId: string;
  generation: number;
  authorizedRoots: AuthorizedRoot[];
  mode: PiAgentMode;
  /** Server-governed instructions appended in memory before each Agent run. */
  instructions?: string;
  providers: ProviderBootstrap[];
  managedSkills: ManagedSkillBootstrap[];
  mcp: McpBootstrap[];
  taskPolicy: TaskPolicy;
  productTools?: ProductToolBootstrap;
  mcpBroker?: {
    socketPath: string;
    capability: string;
  };
}

interface BootstrapConsumeRequest {
  type: "pi_bootstrap_consume";
  version: 1;
  sessionId: string;
  generation: number;
}

interface BootstrapPayloadResponse {
  type: "pi_bootstrap_payload";
  version: 1;
  sessionId: string;
  generation: number;
  payload: PiBootstrapPayload;
}

interface BootstrapErrorResponse {
  type: "pi_bootstrap_error";
  version: 1;
  code: "binding_mismatch" | "consumed" | "expired" | "invalid_request" | "unavailable";
}

type BootstrapResponse = BootstrapPayloadResponse | BootstrapErrorResponse;

export type PiBootstrapErrorCode =
  BootstrapErrorResponse["code"] | "invalid_payload" | "invalid_socket" | "timeout";

export class PiBootstrapError extends Error {
  readonly code: PiBootstrapErrorCode;

  constructor(code: PiBootstrapErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiBootstrapError";
    this.code = code;
  }
}

export interface PiBootstrapServerOptions {
  socketPath: string;
  payload: PiBootstrapPayload;
  ttlMs?: number;
  requestTimeoutMs?: number;
  maxResponseFrameBytes?: number;
}

export interface ConsumePiBootstrapOptions {
  socketPath: string;
  sessionId: string;
  generation: number;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => isNonEmptyString(key) && typeof item === "string")
  );
}

const MODEL_KEYS = [
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "headers",
  "compat",
] as const;
const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const COMPAT_KEYS = new Set([
  "allowEmptySignature",
  "cacheControlFormat",
  "chatTemplateKwargs",
  "deferredToolsMode",
  "forceAdaptiveThinking",
  "maxTokensField",
  "openRouterRouting",
  "requiresAssistantAfterToolResult",
  "requiresReasoningContentOnAssistantMessages",
  "requiresThinkingAsText",
  "requiresToolResultName",
  "sendSessionAffinityHeaders",
  "sessionAffinityFormat",
  "supportsCacheControlOnTools",
  "supportsDeveloperRole",
  "supportsEagerToolInputStreaming",
  "supportsExplicitPromptCacheMode",
  "supportsLongCacheRetention",
  "supportsOpenAIGrammarTools",
  "supportsReasoningEffort",
  "supportsStore",
  "supportsStrictMode",
  "supportsStrictTools",
  "supportsTemperature",
  "supportsToolReferences",
  "supportsToolSearch",
  "supportsUsageInStreaming",
  "thinkingFormat",
  "vercelGatewayRouting",
  "zaiToolStream",
]);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, item]) => isNonEmptyString(key) && isJsonValue(item, depth + 1),
    )
  );
}

function isCost(value: unknown): value is NonNullable<ProviderModelBootstrap["cost"]> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["input", "output", "cacheRead", "cacheWrite", "tiers"]) ||
    !isFiniteNonNegative(value.input) ||
    !isFiniteNonNegative(value.output) ||
    !isFiniteNonNegative(value.cacheRead) ||
    !isFiniteNonNegative(value.cacheWrite)
  ) {
    return false;
  }
  return (
    value.tiers === undefined ||
    (Array.isArray(value.tiers) &&
      value.tiers.every(
        (tier) =>
          isRecord(tier) &&
          hasOnlyKeys(tier, ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"]) &&
          isFiniteNonNegative(tier.input) &&
          isFiniteNonNegative(tier.output) &&
          isFiniteNonNegative(tier.cacheRead) &&
          isFiniteNonNegative(tier.cacheWrite) &&
          isPositiveInteger(tier.inputTokensAbove),
      ))
  );
}

export function isProviderModelBootstrap(value: unknown): value is ProviderModelBootstrap {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, MODEL_KEYS) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    (value.api !== undefined && !isNonEmptyString(value.api)) ||
    (value.baseUrl !== undefined && !isNonEmptyString(value.baseUrl)) ||
    (value.reasoning !== undefined && typeof value.reasoning !== "boolean") ||
    (value.contextWindow !== undefined && !isPositiveInteger(value.contextWindow)) ||
    (value.maxTokens !== undefined && !isPositiveInteger(value.maxTokens)) ||
    (value.headers !== undefined && !isStringRecord(value.headers)) ||
    (value.cost !== undefined && !isCost(value.cost)) ||
    (value.input !== undefined &&
      (!Array.isArray(value.input) ||
        value.input.some((item) => item !== "text" && item !== "image"))) ||
    (value.thinkingLevelMap !== undefined &&
      (!isRecord(value.thinkingLevelMap) ||
        !hasOnlyKeys(value.thinkingLevelMap, THINKING_LEVEL_KEYS) ||
        Object.values(value.thinkingLevelMap).some(
          (item) => item !== null && typeof item !== "string",
        ))) ||
    (value.compat !== undefined &&
      (!isRecord(value.compat) ||
        Object.keys(value.compat).some((key) => !COMPAT_KEYS.has(key)) ||
        !isJsonValue(value.compat)))
  ) {
    return false;
  }
  if (typeof value.baseUrl === "string") {
    try {
      const url = new URL(value.baseUrl);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isAbsoluteSafePath(value: unknown): value is string {
  return isNonEmptyString(value) && isAbsolute(value);
}

function isAuthorizedRoot(value: unknown): value is AuthorizedRoot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "access"]) &&
    isAbsoluteSafePath(value.path) &&
    (value.access === "read" || value.access === "write")
  );
}

function isProviderBootstrap(value: unknown): value is ProviderBootstrap {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "config"]) ||
    !isNonEmptyString(value.name) ||
    !isRecord(value.config)
  ) {
    return false;
  }
  const config = value.config;
  return (
    hasOnlyKeys(config, ["name", "baseUrl", "apiKey", "api", "headers", "authHeader", "models"]) &&
    (config.name === undefined || isNonEmptyString(config.name)) &&
    (config.baseUrl === undefined || isNonEmptyString(config.baseUrl)) &&
    isNonEmptyString(config.apiKey) &&
    isNonEmptyString(config.api) &&
    (config.headers === undefined || isStringRecord(config.headers)) &&
    (config.authHeader === undefined || typeof config.authHeader === "boolean") &&
    Array.isArray(config.models) &&
    config.models.every(isProviderModelBootstrap)
  );
}

function isMcpToolBootstrap(value: unknown): value is McpToolBootstrap {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["name", "description", "inputSchema", "readOnly"]) &&
    isNonEmptyString(value.name) &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.inputSchema === undefined || isRecord(value.inputSchema)) &&
    typeof value.readOnly === "boolean"
  );
}

export function isMcpBootstrap(value: unknown): value is McpBootstrap {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "enabled", "status", "transport", "tools", "readOnlyTools"]) ||
    !isNonEmptyString(value.name) ||
    typeof value.enabled !== "boolean" ||
    (value.status !== "connected" &&
      value.status !== "failed" &&
      value.status !== "disabled" &&
      value.status !== "connecting") ||
    !Array.isArray(value.tools) ||
    !value.tools.every(isMcpToolBootstrap) ||
    (value.readOnlyTools !== undefined &&
      (!Array.isArray(value.readOnlyTools) || !value.readOnlyTools.every(isNonEmptyString)))
  ) {
    return false;
  }
  if (
    value.transport !== "stdio" &&
    value.transport !== "sse" &&
    value.transport !== "streamable-http"
  ) {
    return false;
  }
  if (
    (!value.enabled && value.status !== "disabled") ||
    (value.enabled && value.status === "disabled")
  ) {
    return false;
  }
  return true;
}

function isTaskPolicy(value: unknown): value is TaskPolicy {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "depth",
      "maxDepth",
      "maxParallel",
      "readOnly",
      "brokerSocket",
      "capability",
    ]) &&
    isNonNegativeInteger(value.depth) &&
    isNonNegativeInteger(value.maxDepth) &&
    value.maxDepth <= 2 &&
    value.depth <= value.maxDepth &&
    isNonNegativeInteger(value.maxParallel) &&
    value.maxParallel >= 1 &&
    value.maxParallel <= 4 &&
    (value.readOnly === undefined || typeof value.readOnly === "boolean") &&
    (value.brokerSocket === undefined || isAbsoluteSafePath(value.brokerSocket)) &&
    (value.capability === undefined || isNonEmptyString(value.capability))
  );
}

function isManagedSkill(value: unknown): value is ManagedSkillBootstrap {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["path", "name", "sha256"]) &&
    isAbsoluteSafePath(value.path) &&
    (value.name === undefined || isNonEmptyString(value.name)) &&
    (value.sha256 === undefined || /^[a-f0-9]{64}$/i.test(String(value.sha256)))
  );
}

export function isPiBootstrapPayload(value: unknown): value is PiBootstrapPayload {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "sessionId",
      "generation",
      "authorizedRoots",
      "mode",
      "instructions",
      "providers",
      "managedSkills",
      "mcp",
      "taskPolicy",
      "productTools",
      "mcpBroker",
    ]) ||
    value.version !== 1 ||
    !isNonEmptyString(value.sessionId) ||
    !isNonNegativeInteger(value.generation) ||
    (value.mode !== "agent" && value.mode !== "plan") ||
    (value.instructions !== undefined &&
      (typeof value.instructions !== "string" ||
        value.instructions.length > 1_000_000 ||
        value.instructions.includes("\0"))) ||
    !Array.isArray(value.authorizedRoots) ||
    !value.authorizedRoots.every(isAuthorizedRoot) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(isProviderBootstrap) ||
    !Array.isArray(value.managedSkills) ||
    !value.managedSkills.every(isManagedSkill) ||
    !Array.isArray(value.mcp) ||
    !value.mcp.every(isMcpBootstrap) ||
    !isTaskPolicy(value.taskPolicy)
  ) {
    return false;
  }
  if (
    value.productTools !== undefined &&
    (!isRecord(value.productTools) ||
      !hasOnlyKeys(value.productTools, ["userSpaceCapability"]) ||
      !isNonEmptyString(value.productTools.userSpaceCapability))
  ) {
    return false;
  }
  if (
    value.mcpBroker !== undefined &&
    (!isRecord(value.mcpBroker) ||
      !hasOnlyKeys(value.mcpBroker, ["socketPath", "capability"]) ||
      !isAbsoluteSafePath(value.mcpBroker.socketPath) ||
      !isNonEmptyString(value.mcpBroker.capability))
  ) {
    return false;
  }
  try {
    JSON.stringify(value);
  } catch {
    return false;
  }
  return true;
}

function parsePayload(value: unknown): PiBootstrapPayload {
  if (!isPiBootstrapPayload(value)) {
    throw new PiBootstrapError("invalid_payload", "Pi bootstrap payload failed schema validation.");
  }
  return value;
}

function validateSocketPath(socketPath: string): string {
  if (
    !isAbsoluteSafePath(socketPath) ||
    Buffer.byteLength(socketPath, "utf8") > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new PiBootstrapError("invalid_socket", "Pi bootstrap socket path is invalid.");
  }
  return resolve(socketPath);
}

function parseConsumeRequest(value: unknown): BootstrapConsumeRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "version", "sessionId", "generation"]) ||
    value.type !== "pi_bootstrap_consume" ||
    value.version !== 1 ||
    !isNonEmptyString(value.sessionId) ||
    !isNonNegativeInteger(value.generation)
  ) {
    return null;
  }
  return value as unknown as BootstrapConsumeRequest;
}

function parseBootstrapResponse(value: unknown): BootstrapResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") {
    throw new PiBootstrapError(
      "invalid_payload",
      "Pi bootstrap response failed schema validation.",
    );
  }
  if (value.type === "pi_bootstrap_error") {
    if (
      !hasOnlyKeys(value, ["type", "version", "code"]) ||
      (value.code !== "binding_mismatch" &&
        value.code !== "consumed" &&
        value.code !== "expired" &&
        value.code !== "invalid_request" &&
        value.code !== "unavailable")
    ) {
      throw new PiBootstrapError(
        "invalid_payload",
        "Pi bootstrap error response failed schema validation.",
      );
    }
    return value as unknown as BootstrapErrorResponse;
  }
  if (
    value.type !== "pi_bootstrap_payload" ||
    !hasOnlyKeys(value, ["type", "version", "sessionId", "generation", "payload"]) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonNegativeInteger(value.generation)
  ) {
    throw new PiBootstrapError(
      "invalid_payload",
      "Pi bootstrap response failed schema validation.",
    );
  }
  return {
    type: "pi_bootstrap_payload",
    version: 1,
    sessionId: value.sessionId,
    generation: value.generation,
    payload: parsePayload(value.payload),
  };
}

function clonePayload(payload: PiBootstrapPayload): PiBootstrapPayload {
  try {
    return parsePayload(structuredClone(payload));
  } catch (error) {
    if (error instanceof PiBootstrapError) throw error;
    throw new PiBootstrapError("invalid_payload", "Pi bootstrap payload could not be copied.", {
      cause: error,
    });
  }
}

function destroyObject(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) destroyObject(item, seen);
    value.fill(undefined);
    value.length = 0;
    return;
  }
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;
    destroyObject(record[key], seen);
    record[key] = undefined;
    delete record[key];
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function sameSocketIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isSocket();
}

/**
 * One-shot generation-bound credential channel. The path is server-owned and
 * providers/MCP credentials exist only in the in-memory payload and response.
 */
export class PiBootstrapServer {
  readonly socketPath: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly ttlMs: number;
  readonly requestTimeoutMs: number;
  readonly maxResponseFrameBytes: number;

  private payload: PiBootstrapPayload | null;
  private server: Server | null = null;
  private socketIdentity: Stats | null = null;
  private readonly sockets = new Set<Socket>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  private didConsume = false;
  private consumptionWaiters: Array<{
    resolve: () => void;
    reject: (error: PiBootstrapError) => void;
  }> = [];

  constructor(options: PiBootstrapServerOptions) {
    if (process.platform === "win32") {
      throw new PiBootstrapError("invalid_socket", "Pi bootstrap requires Unix domain sockets.");
    }
    this.socketPath = validateSocketPath(options.socketPath);
    this.payload = clonePayload(options.payload);
    this.sessionId = this.payload.sessionId;
    this.generation = this.payload.generation;
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS, "ttlMs");
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxResponseFrameBytes = positiveInteger(
      options.maxResponseFrameBytes,
      MAX_RESPONSE_FRAME_BYTES,
      "maxResponseFrameBytes",
    );
  }

  get consumed(): boolean {
    return this.didConsume;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) {
      throw new PiBootstrapError("unavailable", "Pi bootstrap server is unavailable.");
    }
    const parent = dirname(this.socketPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new PiBootstrapError(
        "invalid_socket",
        "Pi bootstrap socket parent is not a trusted directory.",
      );
    }
    if ((parentInfo.mode & 0o022) !== 0) {
      throw new PiBootstrapError(
        "invalid_socket",
        "Pi bootstrap socket parent permissions are too broad.",
      );
    }
    try {
      await lstat(this.socketPath);
      throw new PiBootstrapError("invalid_socket", "Pi bootstrap socket path is already occupied.");
    } catch (error) {
      if (error instanceof PiBootstrapError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PiBootstrapError(
          "invalid_socket",
          "Pi bootstrap socket path could not be inspected.",
          { cause: error },
        );
      }
    }

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        rejectStart(
          new PiBootstrapError("unavailable", "Pi bootstrap server could not listen.", {
            cause: error,
          }),
        );
      };
      const onListening = (): void => {
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
      if (!identity.isSocket() || (identity.mode & 0o777) !== 0o600) {
        throw new PiBootstrapError(
          "invalid_socket",
          "Pi bootstrap socket permissions could not be secured.",
        );
      }
      this.socketIdentity = identity;
      this.started = true;
      server.on("error", () => {
        void this.dispose(
          new PiBootstrapError("unavailable", "Pi bootstrap server became unavailable."),
        );
      });
      this.expiryTimer = setTimeout(() => {
        void this.dispose(new PiBootstrapError("expired", "Pi bootstrap capability expired."));
      }, this.ttlMs);
      this.expiryTimer.unref?.();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  waitForConsumption(): Promise<void> {
    if (this.didConsume) return Promise.resolve();
    if (this.disposed) {
      return Promise.reject(
        new PiBootstrapError("unavailable", "Pi bootstrap server is unavailable."),
      );
    }
    return new Promise((resolveWaiter, rejectWaiter) => {
      this.consumptionWaiters.push({
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    });
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.requestTimeoutMs);
    const decoder = new StrictLfJsonlDecoder(MAX_REQUEST_FRAME_BYTES);
    let handled = false;
    const cleanup = (): void => {
      this.sockets.delete(socket);
    };
    const rejectRequest = (code: BootstrapErrorResponse["code"]): void => {
      if (handled) return;
      handled = true;
      this.sendResponse(socket, { type: "pi_bootstrap_error", version: 1, code });
    };
    socket.once("close", cleanup);
    socket.once("timeout", () => rejectRequest("invalid_request"));
    socket.once("error", cleanup);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch {
        rejectRequest("invalid_request");
        return;
      }
      if (lines.length !== 1) {
        if (lines.length > 1) rejectRequest("invalid_request");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(lines[0]!) as unknown;
      } catch {
        rejectRequest("invalid_request");
        return;
      }
      const request = parseConsumeRequest(value);
      if (!request) {
        rejectRequest("invalid_request");
        return;
      }
      if (request.sessionId !== this.sessionId || request.generation !== this.generation) {
        rejectRequest("binding_mismatch");
        return;
      }
      if (this.didConsume || !this.payload) {
        rejectRequest("consumed");
        return;
      }
      handled = true;
      void this.consume(socket);
    });
    socket.once("end", () => {
      if (handled) return;
      try {
        decoder.end();
      } catch {
        // Generic invalid_request deliberately never echoes frame content.
      }
      rejectRequest("invalid_request");
    });
  }

  private async consume(socket: Socket): Promise<void> {
    const payload = this.payload;
    if (!payload || this.didConsume) {
      this.sendResponse(socket, {
        type: "pi_bootstrap_error",
        version: 1,
        code: "consumed",
      });
      return;
    }
    this.didConsume = true;
    this.payload = null;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    await this.closeListenerAndUnlink();
    this.sendResponse(
      socket,
      {
        type: "pi_bootstrap_payload",
        version: 1,
        sessionId: this.sessionId,
        generation: this.generation,
        payload,
      },
      () => {
        destroyObject(payload);
        for (const waiter of this.consumptionWaiters.splice(0)) waiter.resolve();
      },
    );
  }

  private sendResponse(socket: Socket, response: BootstrapResponse, afterWrite?: () => void): void {
    let frame: Buffer;
    try {
      frame = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
      if (frame.length - 1 > this.maxResponseFrameBytes) {
        throw new Error("response exceeds frame limit");
      }
    } catch {
      socket.destroy();
      afterWrite?.();
      return;
    }
    socket.end(frame, () => {
      frame.fill(0);
      afterWrite?.();
    });
  }

  private async closeListenerAndUnlink(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      // Stop accepting immediately. Do not await the close callback here: the
      // valid consumer socket remains open until its one response is flushed.
      try {
        server.close();
      } catch {}
    }
    const expected = this.socketIdentity;
    this.socketIdentity = null;
    if (!expected) return;
    try {
      const current = await lstat(this.socketPath);
      if (sameSocketIdentity(expected, current)) await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async dispose(reason?: PiBootstrapError): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    await this.closeListenerAndUnlink().catch(() => undefined);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.payload) {
      destroyObject(this.payload);
      this.payload = null;
    }
    if (!this.didConsume) {
      const error =
        reason ?? new PiBootstrapError("unavailable", "Pi bootstrap server is unavailable.");
      for (const waiter of this.consumptionWaiters.splice(0)) waiter.reject(error);
    }
  }
}

export async function consumePiBootstrap(
  options: ConsumePiBootstrapOptions,
): Promise<PiBootstrapPayload> {
  const socketPath = validateSocketPath(options.socketPath);
  if (!isNonEmptyString(options.sessionId)) {
    throw new PiBootstrapError("invalid_payload", "Pi bootstrap session binding is invalid.");
  }
  if (!isNonNegativeInteger(options.generation)) {
    throw new PiBootstrapError("invalid_payload", "Pi bootstrap generation binding is invalid.");
  }
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  return new Promise<PiBootstrapPayload>((resolvePayload, rejectPayload) => {
    const socket = createConnection(socketPath);
    const decoder = new StrictLfJsonlDecoder(MAX_RESPONSE_FRAME_BYTES);
    let settled = false;
    const finish = (error: PiBootstrapError | null, payload?: PiBootstrapPayload): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPayload(error);
      else resolvePayload(payload!);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () =>
      finish(new PiBootstrapError("timeout", "Pi bootstrap request timed out.")),
    );
    socket.once("error", (error) =>
      finish(
        new PiBootstrapError("unavailable", "Pi bootstrap capability is unavailable.", {
          cause: error,
        }),
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        finish(
          new PiBootstrapError("invalid_payload", "Pi bootstrap response framing is invalid.", {
            cause: error,
          }),
        );
        return;
      }
      if (lines.length !== 1) {
        if (lines.length > 1) {
          finish(
            new PiBootstrapError(
              "invalid_payload",
              "Pi bootstrap response contains multiple frames.",
            ),
          );
        }
        return;
      }
      try {
        const response = parseBootstrapResponse(JSON.parse(lines[0]!) as unknown);
        if (response.type === "pi_bootstrap_error") {
          finish(new PiBootstrapError(response.code, "Pi bootstrap request was rejected."));
          return;
        }
        if (
          response.sessionId !== options.sessionId ||
          response.generation !== options.generation ||
          response.payload.sessionId !== options.sessionId ||
          response.payload.generation !== options.generation
        ) {
          finish(
            new PiBootstrapError(
              "invalid_payload",
              "Pi bootstrap response binding does not match this process.",
            ),
          );
          return;
        }
        finish(null, response.payload);
      } catch (error) {
        finish(
          error instanceof PiBootstrapError
            ? error
            : new PiBootstrapError("invalid_payload", "Pi bootstrap response is invalid.", {
                cause: error,
              }),
        );
      }
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        decoder.end();
      } catch (error) {
        finish(
          new PiBootstrapError("invalid_payload", "Pi bootstrap response is incomplete.", {
            cause: error,
          }),
        );
        return;
      }
      finish(
        new PiBootstrapError("unavailable", "Pi bootstrap capability closed without a response."),
      );
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "pi_bootstrap_consume",
          version: 1,
          sessionId: options.sessionId,
          generation: options.generation,
        })}\n`,
      );
    });
  });
}

export const consumeBootstrapSocket = consumePiBootstrap;
