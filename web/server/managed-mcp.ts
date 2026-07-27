import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 64 * 1024;

export type ManagedMcpTransport = "stdio" | "sse" | "streamable-http";
export type ManagedMcpStatus = "connected" | "failed" | "disabled" | "connecting";

export interface ManagedMcpToolPolicy {
  readOnly: boolean;
}

interface ManagedMcpBaseConfig {
  name: string;
  enabled: boolean;
  toolPolicies?: Record<string, ManagedMcpToolPolicy>;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface ManagedMcpStdioConfig extends ManagedMcpBaseConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  /** Non-secret process settings only. Credential-shaped names are rejected. */
  env?: Record<string, string>;
}

export interface ManagedMcpRemoteConfig extends ManagedMcpBaseConfig {
  transport: "sse" | "streamable-http";
  url: string;
  /** Kept only in memory and attached by the manager-owned fetch closure. */
  headers?: Record<string, string>;
}

export type ManagedMcpServerConfig = ManagedMcpStdioConfig | ManagedMcpRemoteConfig;

export interface ManagedMcpToolDetail {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface ManagedMcpServerDetail {
  name: string;
  transport: ManagedMcpTransport;
  status: ManagedMcpStatus;
  enabled: boolean;
  serverInfo?: { name: string; version: string };
  error?: string;
  tools: ManagedMcpToolDetail[];
  config: {
    transport: ManagedMcpTransport;
    command?: string;
    args?: string[];
    url?: string;
  };
}

export interface ManagedMcpCallOptions {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  readOnlyOnly?: boolean;
  onProgress?: (progress: unknown) => void;
}

export interface ManagedMcpManagerOptions {
  servers: readonly ManagedMcpServerConfig[];
  authorizeRemoteUrl?: (url: URL, server: string) => void | Promise<void>;
  authorizeStdio?: (config: Readonly<ManagedMcpStdioConfig>) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}

type NativeTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

interface Runtime {
  config: ManagedMcpServerConfig;
  status: ManagedMcpStatus;
  client?: Client;
  transport?: NativeTransport;
  tools: ManagedMcpToolDetail[];
  serverInfo?: { name: string; version: string };
  error?: string;
  connecting?: Promise<void>;
  connectionEpoch: number;
  stderrBytes: number;
  credentialHeaders: Record<string, string>;
  sensitiveValues: string[];
}

export class ManagedMcpError extends Error {
  readonly code:
    | "invalid_config"
    | "disabled"
    | "not_connected"
    | "not_found"
    | "policy_denied"
    | "transport_failed";

  constructor(code: ManagedMcpError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedMcpError";
    this.code = code;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const output = value ?? fallback;
  if (!Number.isSafeInteger(output) || output < 1) {
    throw new ManagedMcpError(
      "invalid_config",
      "Managed MCP timeout must be a positive safe integer.",
    );
  }
  return output;
}

function validateName(name: string, kind: string): void {
  if (!nonEmpty(name) || !/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) {
    throw new ManagedMcpError("invalid_config", `Managed MCP ${kind} is invalid.`);
  }
}

function credentialShapedName(value: string): boolean {
  return /(?:^|[^A-Za-z0-9])(?:api[-_]?key|access[-_]?token|token|secret|password|credential|authorization|auth|cookie)(?:$|[^A-Za-z0-9])/iu.test(
    value,
  );
}

function validateHeaders(headers: Record<string, string> | undefined): void {
  if (headers !== undefined && !isRecord(headers)) {
    throw new ManagedMcpError("invalid_config", "Managed MCP HTTP headers are invalid.");
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      credentialShapedName(name) ||
      typeof value !== "string" ||
      /[\r\n\0]/u.test(value)
    ) {
      throw new ManagedMcpError("invalid_config", "Managed MCP HTTP headers are invalid.");
    }
  }
}

interface ManagedMcpCredentialMaterial {
  headers: Readonly<Record<string, string>>;
  sensitiveValues: readonly string[];
}

const managedMcpCredentials = new WeakMap<object, ManagedMcpCredentialMaterial>();
const markedCredentialConfigs = new WeakSet<object>();
const consumedCredentialConfigs = new WeakSet<object>();

/**
 * Attaches credential material to an in-memory config without adding
 * serializable fields. WeakMap metadata cannot cross argv/env/JSONL/log
 * boundaries through object spread or JSON serialization.
 */
export function markManagedMcpCredential<T extends ManagedMcpRemoteConfig>(
  config: T,
  header: string,
  headerValue: string,
  secretValue: string,
): T {
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header) ||
    !headerValue ||
    !secretValue ||
    /[\r\n\0]/u.test(headerValue) ||
    /[\r\n\0]/u.test(secretValue)
  ) {
    throw new ManagedMcpError("invalid_config", "Managed MCP credential material is invalid.");
  }
  managedMcpCredentials.set(config, {
    headers: { [header]: headerValue },
    sensitiveValues: [secretValue, headerValue],
  });
  markedCredentialConfigs.add(config);
  return config;
}

function cloneToolPolicies(
  policies: Record<string, ManagedMcpToolPolicy> | undefined,
): Record<string, ManagedMcpToolPolicy> | undefined {
  return policies
    ? Object.fromEntries(
        Object.entries(policies).map(([name, policy]) => [name, { readOnly: policy.readOnly }]),
      )
    : undefined;
}

function cloneConfig(config: ManagedMcpServerConfig): ManagedMcpServerConfig {
  const common = {
    name: config.name,
    enabled: config.enabled,
    ...(config.toolPolicies ? { toolPolicies: cloneToolPolicies(config.toolPolicies) } : {}),
    ...(config.connectTimeoutMs ? { connectTimeoutMs: config.connectTimeoutMs } : {}),
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  };
  return config.transport === "stdio"
    ? {
        ...common,
        transport: "stdio",
        command: config.command,
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: { ...config.env } } : {}),
      }
    : {
        ...common,
        transport: config.transport,
        url: config.url,
        ...(config.headers ? { headers: { ...config.headers } } : {}),
      };
}

function validateConfig(config: ManagedMcpServerConfig): void {
  if (
    !isRecord(config) ||
    typeof config.enabled !== "boolean" ||
    (config.toolPolicies !== undefined && !isRecord(config.toolPolicies))
  ) {
    throw new ManagedMcpError("invalid_config", "Managed MCP config is invalid.");
  }
  validateName(config.name, "server name");
  positiveInteger(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  positiveInteger(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  for (const [tool, policy] of Object.entries(config.toolPolicies ?? {})) {
    validateName(tool, "tool name");
    if (typeof policy !== "object" || policy === null || typeof policy.readOnly !== "boolean") {
      throw new ManagedMcpError("invalid_config", "Managed MCP tool policy is invalid.");
    }
  }
  if (config.transport === "stdio") {
    if (
      !hasOnlyKeys(config, [
        "name",
        "enabled",
        "transport",
        "toolPolicies",
        "connectTimeoutMs",
        "requestTimeoutMs",
        "command",
        "args",
        "cwd",
        "env",
      ]) ||
      !nonEmpty(config.command) ||
      !isAbsolute(config.command) ||
      (config.args !== undefined && !Array.isArray(config.args)) ||
      config.args?.some((value) => typeof value !== "string" || value.includes("\0")) ||
      config.args?.some(
        (value) =>
          credentialShapedName(value.replace(/^--?/u, "")) ||
          /^(?:bearer|basic)\s+/iu.test(value) ||
          /^(?:sk|key|token|secret)[-_][A-Za-z0-9._~-]{8,}$/u.test(value),
      ) ||
      (config.cwd !== undefined &&
        (!nonEmpty(config.cwd) || !isAbsolute(config.cwd) || config.cwd.includes("\0"))) ||
      (config.env !== undefined && !isRecord(config.env))
    ) {
      throw new ManagedMcpError("invalid_config", "Managed MCP stdio command is invalid.");
    }
    for (const [name, value] of Object.entries(config.env ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        credentialShapedName(name) ||
        typeof value !== "string" ||
        value.includes("\0")
      ) {
        throw new ManagedMcpError(
          "invalid_config",
          "Managed MCP stdio environment may contain only non-secret settings.",
        );
      }
    }
    return;
  }
  if (config.transport !== "sse" && config.transport !== "streamable-http") {
    throw new ManagedMcpError("invalid_config", "SDK-injected MCP transports are forbidden.");
  }
  if (
    !hasOnlyKeys(config, [
      "name",
      "enabled",
      "transport",
      "toolPolicies",
      "connectTimeoutMs",
      "requestTimeoutMs",
      "url",
      "headers",
    ])
  ) {
    throw new ManagedMcpError(
      "invalid_config",
      "Managed MCP remote config contains unsupported fields.",
    );
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new ManagedMcpError("invalid_config", "Managed MCP URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname
  ) {
    throw new ManagedMcpError(
      "invalid_config",
      "Managed MCP remote transport requires an HTTPS URL without embedded credentials.",
    );
  }
  validateHeaders(config.headers);
}

function sanitizedFailure(): string {
  return "Managed MCP transport failed.";
}

function authenticatedFetch(
  baseFetch: typeof globalThis.fetch,
  managedHeaders: Readonly<Record<string, string>>,
  endpoint: URL,
  authorizeRemoteUrl: ((url: URL, server: string) => void | Promise<void>) | undefined,
  server: string,
): typeof globalThis.fetch {
  const fetchWithManagedHeaders = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const requested = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (requested.origin !== endpoint.origin) {
      throw new ManagedMcpError("policy_denied", "Managed MCP remote request changed origin.");
    }
    await authorizeRemoteUrl?.(requested, server);
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    for (const [name, value] of new Headers(init?.headers)) {
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(managedHeaders)) {
      headers.set(name, value);
    }
    return baseFetch(input, { ...init, headers, redirect: "error" });
  };
  return fetchWithManagedHeaders as typeof globalThis.fetch;
}

function redactSensitiveValues(
  value: unknown,
  sensitiveValues: readonly string[],
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") {
    return sensitiveValues.reduce(
      (output, sensitive) =>
        sensitive.length > 0 ? output.split(sensitive).join("[REDACTED]") : output,
      value,
    );
  }
  if (typeof value !== "object" || value === null) return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) {
      output.push(redactSensitiveValues(item, sensitiveValues, seen));
    }
    return output;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const output = Object.create(null) as Record<string, unknown>;
  seen.set(value, output);
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const safeName = redactSensitiveValues(name, sensitiveValues) as string;
    output[safeName] = redactSensitiveValues(item, sensitiveValues, seen);
  }
  return output;
}

export class ManagedMcpManager {
  private readonly authorizeRemoteUrl?: ManagedMcpManagerOptions["authorizeRemoteUrl"];
  private readonly authorizeStdio?: ManagedMcpManagerOptions["authorizeStdio"];
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly runtimes = new Map<string, Runtime>();
  private disposed = false;

  constructor(options: ManagedMcpManagerOptions) {
    this.authorizeRemoteUrl = options.authorizeRemoteUrl;
    this.authorizeStdio = options.authorizeStdio;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    for (const source of options.servers) {
      validateConfig(source);
      if (this.runtimes.has(source.name)) {
        throw new ManagedMcpError("invalid_config", "Managed MCP server names must be unique.");
      }
      if (consumedCredentialConfigs.has(source)) {
        throw new ManagedMcpError(
          "invalid_config",
          "Managed MCP credential capability was already consumed.",
        );
      }
      const credentialMaterial = managedMcpCredentials.get(source);
      if (markedCredentialConfigs.has(source)) {
        consumedCredentialConfigs.add(source);
      }
      managedMcpCredentials.delete(source);
      const config = cloneConfig(source);
      this.runtimes.set(config.name, {
        config,
        status: config.enabled ? "connecting" : "disabled",
        tools: [],
        connectionEpoch: 0,
        stderrBytes: 0,
        credentialHeaders: {
          ...(credentialMaterial?.headers ?? {}),
        },
        sensitiveValues: [...(credentialMaterial?.sensitiveValues ?? [])],
      });
    }
  }

  async start(): Promise<void> {
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.config.enabled)
        .map((runtime) => this.connectRuntime(runtime)),
    );
  }

  details(): ManagedMcpServerDetail[] {
    return [...this.runtimes.values()].map((runtime) => ({
      name: runtime.config.name,
      transport: runtime.config.transport,
      status: runtime.status,
      enabled: runtime.config.enabled,
      ...(runtime.serverInfo ? { serverInfo: runtime.serverInfo } : {}),
      ...(runtime.error ? { error: runtime.error } : {}),
      tools: runtime.tools.map((tool) => ({
        ...tool,
        inputSchema: { ...tool.inputSchema },
      })),
      config: {
        transport: runtime.config.transport,
        ...(runtime.config.transport === "stdio"
          ? {
              command: runtime.config.command,
              args: runtime.config.args ? [...runtime.config.args] : undefined,
            }
          : { url: runtime.config.url }),
      },
    }));
  }

  /**
   * Ephemeral values that a diagnostics sink must redact if a managed server
   * echoes credential material. The returned copy is never serialized.
   */
  sensitiveValuesForRedaction(): string[] {
    return [
      ...new Set(
        [...this.runtimes.values()].flatMap((runtime) =>
          runtime.sensitiveValues.filter((value) => value.length > 0),
        ),
      ),
    ];
  }

  private runtime(name: string): Runtime {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new ManagedMcpError("not_found", "Managed MCP server was not found.");
    }
    return runtime;
  }

  private async createTransport(runtime: Runtime): Promise<NativeTransport> {
    const config = runtime.config;
    if (config.transport === "stdio") {
      await this.authorizeStdio?.(config);
      const parameters: StdioServerParameters = {
        command: config.command,
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(config.env ? { env: { ...config.env } } : {}),
        stderr: "pipe",
      };
      const transport = new StdioClientTransport(parameters);
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
        runtime.stderrBytes = Math.min(MAX_STDERR_BYTES, runtime.stderrBytes + bytes);
      });
      return transport;
    }
    const url = new URL(config.url);
    await this.authorizeRemoteUrl?.(url, config.name);
    const fetchWithAuth = authenticatedFetch(
      this.fetchImplementation,
      {
        ...(config.headers ?? {}),
        ...runtime.credentialHeaders,
      },
      url,
      this.authorizeRemoteUrl,
      config.name,
    );
    if (config.transport === "sse") {
      const options: SSEClientTransportOptions = { fetch: fetchWithAuth };
      return new SSEClientTransport(url, options);
    }
    const options: StreamableHTTPClientTransportOptions = {
      fetch: fetchWithAuth,
    };
    return new StreamableHTTPClientTransport(url, options);
  }

  private async connectRuntime(runtime: Runtime): Promise<void> {
    if (runtime.connecting) return runtime.connecting;
    if (!runtime.config.enabled) {
      runtime.status = "disabled";
      return;
    }
    runtime.status = "connecting";
    runtime.error = undefined;
    const epoch = ++runtime.connectionEpoch;
    const connect = (async () => {
      let client: Client | undefined;
      let transport: NativeTransport | undefined;
      try {
        transport = await this.createTransport(runtime);
        if (epoch !== runtime.connectionEpoch || !runtime.config.enabled || this.disposed) {
          await transport.close().catch(() => undefined);
          return;
        }
        client = new Client({ name: "piwork-managed-mcp", version: "1" }, { capabilities: {} });
        client.onclose = () => {
          if (epoch === runtime.connectionEpoch && runtime.config.enabled && !this.disposed) {
            runtime.status = "failed";
            runtime.error = sanitizedFailure();
          }
        };
        client.onerror = () => {
          if (epoch === runtime.connectionEpoch && runtime.config.enabled && !this.disposed) {
            runtime.status = "failed";
            runtime.error = sanitizedFailure();
          }
        };
        runtime.client = client;
        runtime.transport = transport;
        const timeoutMs = positiveInteger(
          runtime.config.connectTimeoutMs,
          DEFAULT_CONNECT_TIMEOUT_MS,
        );
        await client.connect(transport, { timeout: timeoutMs });
        const listed = await client.listTools(
          {},
          { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
        );
        if (epoch !== runtime.connectionEpoch || !runtime.config.enabled || this.disposed) {
          await client.close().catch(() => undefined);
          return;
        }
        runtime.tools = listed.tools.map((tool) => {
          const safeTool = redactSensitiveValues(tool, runtime.sensitiveValues) as typeof tool;
          validateName(safeTool.name, "tool name");
          return {
            name: safeTool.name,
            ...(safeTool.description ? { description: safeTool.description } : {}),
            inputSchema: safeTool.inputSchema,
            readOnly: runtime.config.toolPolicies?.[safeTool.name]?.readOnly === true,
          };
        });
        const serverInfo = client.getServerVersion();
        const safeServerInfo = redactSensitiveValues(
          serverInfo,
          runtime.sensitiveValues,
        ) as typeof serverInfo;
        runtime.serverInfo = safeServerInfo
          ? { name: safeServerInfo.name, version: safeServerInfo.version }
          : undefined;
        runtime.status = "connected";
      } catch {
        if (epoch !== runtime.connectionEpoch || !runtime.config.enabled || this.disposed) {
          await client?.close().catch(() => undefined);
          if (!client) await transport?.close().catch(() => undefined);
          return;
        }
        runtime.status = "failed";
        runtime.error = sanitizedFailure();
        runtime.client = undefined;
        runtime.transport = undefined;
        await client?.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);
        throw new ManagedMcpError("transport_failed", sanitizedFailure());
      } finally {
        if (epoch === runtime.connectionEpoch) {
          runtime.connecting = undefined;
        }
      }
    })();
    runtime.connecting = connect;
    return connect;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const runtime = this.runtime(name);
    if (runtime.config.enabled === enabled) {
      if (enabled && runtime.status !== "connected") {
        await this.connectRuntime(runtime);
      }
      return;
    }
    runtime.config = { ...runtime.config, enabled } as ManagedMcpServerConfig;
    if (!enabled) {
      await this.closeRuntime(runtime);
      runtime.status = "disabled";
      runtime.error = undefined;
      return;
    }
    await this.connectRuntime(runtime);
  }

  async reconnect(name: string): Promise<void> {
    const runtime = this.runtime(name);
    if (!runtime.config.enabled) {
      throw new ManagedMcpError("disabled", "Managed MCP server is disabled.");
    }
    await this.closeRuntime(runtime);
    await this.connectRuntime(runtime);
  }

  async callTool(options: ManagedMcpCallOptions): Promise<unknown> {
    const runtime = this.runtime(options.server);
    if (!runtime.config.enabled) {
      throw new ManagedMcpError("disabled", "Managed MCP server is disabled.");
    }
    if (runtime.status !== "connected" || !runtime.client) {
      throw new ManagedMcpError("not_connected", "Managed MCP server is not connected.");
    }
    const tool = runtime.tools.find((candidate) => candidate.name === options.tool);
    if (!tool) {
      throw new ManagedMcpError("not_found", "Managed MCP tool was not found.");
    }
    if (options.readOnlyOnly && !tool.readOnly) {
      throw new ManagedMcpError("policy_denied", "Managed MCP tool is not explicitly read-only.");
    }
    const timeout = positiveInteger(
      options.timeoutMs ?? runtime.config.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      const value = await runtime.client.callTool(
        { name: options.tool, arguments: options.arguments ?? {} },
        undefined,
        {
          signal: options.signal,
          timeout,
          maxTotalTimeout: timeout,
          resetTimeoutOnProgress: true,
          onprogress: (progress) =>
            options.onProgress?.(redactSensitiveValues(progress, runtime.sensitiveValues)),
        },
      );
      return redactSensitiveValues(value, runtime.sensitiveValues);
    } catch {
      throw new ManagedMcpError("transport_failed", "Managed MCP tool call failed.");
    }
  }

  private async closeRuntime(runtime: Runtime): Promise<void> {
    runtime.connectionEpoch += 1;
    const connecting = runtime.connecting;
    runtime.connecting = undefined;
    const client = runtime.client;
    const transport = runtime.transport;
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.tools = [];
    runtime.serverInfo = undefined;
    await client?.close().catch(() => undefined);
    if (!client) await transport?.close().catch(() => undefined);
    await connecting?.catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.runtimes.values()].map((runtime) => this.closeRuntime(runtime)));
    for (const runtime of this.runtimes.values()) {
      if (runtime.config.transport === "sse" || runtime.config.transport === "streamable-http") {
        for (const name of Object.keys(runtime.config.headers ?? {})) {
          runtime.config.headers![name] = "";
          delete runtime.config.headers![name];
        }
      }
      for (const name of Object.keys(runtime.credentialHeaders)) {
        runtime.credentialHeaders[name] = "";
        delete runtime.credentialHeaders[name];
      }
      runtime.sensitiveValues.fill("");
      runtime.sensitiveValues.length = 0;
    }
  }
}

/**
 * Strict configuration boundary used by control-plane inputs. In particular,
 * the historical `sdk` transport is rejected rather than adapted.
 */
export function parseManagedMcpServerConfig(value: unknown): ManagedMcpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManagedMcpError("invalid_config", "Managed MCP config is invalid.");
  }
  const config = value as ManagedMcpServerConfig;
  validateConfig(config);
  return config;
}
