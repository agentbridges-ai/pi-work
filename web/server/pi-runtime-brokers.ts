import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpBootstrap, PiAgentMode } from "./pi-bootstrap-channel.js";
import { ManagedMcpManager, type ManagedMcpServerConfig } from "./managed-mcp.js";
import {
  PiBrokerServer,
  type PiBrokerRequest,
  type PiBrokerRequestContext,
} from "./pi-broker-server.js";

const CAPABILITY_BYTES = 32;
// Long foreground Pi tasks may run for 30 minutes. Keep the broker envelope
// slightly wider so the task manager, not the socket timer, owns termination.
const BROKER_REQUEST_TIMEOUT_MS = 31 * 60_000;

export interface PiTaskBrokerHandler {
  (request: PiBrokerRequest, context: PiBrokerRequestContext): Promise<unknown>;
}

export interface PiRuntimeBrokersOptions {
  runtimeDir: string;
  sessionId: string;
  generation: number;
  mode: PiAgentMode;
  managedMcpServers?: readonly ManagedMcpServerConfig[];
  authorizeRemoteUrl?: (url: URL, server: string) => void | Promise<void>;
  authorizeStdio?: (
    config: Readonly<Extract<ManagedMcpServerConfig, { transport: "stdio" }>>,
  ) => void | Promise<void>;
  handleTask?: PiTaskBrokerHandler;
  handleApp?: PiTaskBrokerHandler;
  handleNativeFile?: PiTaskBrokerHandler;
  onModeChange?: (mode: PiAgentMode) => void | Promise<void>;
}

export interface PiChildBrokerAuthority {
  mode: PiAgentMode;
  readOnlyLocked: boolean;
}

interface PiBrokerAuthority extends PiChildBrokerAuthority {
  capability: string;
  root: boolean;
}

function capability(): string {
  return randomBytes(CAPABILITY_BYTES).toString("base64url");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mcpBootstrap(manager: ManagedMcpManager): McpBootstrap[] {
  return manager.details().map((server) => ({
    name: server.name,
    enabled: server.enabled,
    status: server.status,
    transport: server.transport,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: { ...tool.inputSchema },
      readOnly: tool.readOnly,
    })),
    readOnlyTools: server.tools.filter((tool) => tool.readOnly).map((tool) => tool.name),
  }));
}

/**
 * Server-owned MCP/task boundary for one Pi process generation. The child sees
 * only an opaque capability and a private Unix socket; SDK transports and
 * credentials remain in this process.
 */
export class PiRuntimeBrokers {
  readonly sessionId: string;
  readonly generation: number;
  private activeMode: PiAgentMode;
  readonly socketPath: string;
  readonly capability: string;
  private readonly mcp: ManagedMcpManager;
  private readonly broker: PiBrokerServer;
  private readonly handleTask?: PiTaskBrokerHandler;
  private readonly handleApp?: PiTaskBrokerHandler;
  private readonly handleNativeFile?: PiTaskBrokerHandler;
  private readonly onModeChange?: PiRuntimeBrokersOptions["onModeChange"];
  private readonly authorities = new Map<string, PiBrokerAuthority>();
  private started = false;
  private disposed = false;

  constructor(options: PiRuntimeBrokersOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.activeMode = options.mode;
    this.socketPath = join(
      options.runtimeDir,
      "pi-brokers",
      `${options.sessionId}-${options.generation}.sock`,
    );
    this.capability = capability();
    this.authorities.set(`${this.sessionId}:${this.generation}`, {
      capability: this.capability,
      mode: options.mode,
      readOnlyLocked: false,
      root: true,
    });
    this.handleTask = options.handleTask;
    this.handleApp = options.handleApp;
    this.handleNativeFile = options.handleNativeFile;
    this.onModeChange = options.onModeChange;
    this.mcp = new ManagedMcpManager({
      servers: options.managedMcpServers ?? [],
      authorizeRemoteUrl: options.authorizeRemoteUrl,
      authorizeStdio: options.authorizeStdio,
    });
    this.broker = new PiBrokerServer({
      socketPath: this.socketPath,
      maxConcurrent: 16,
      requestTimeoutMs: BROKER_REQUEST_TIMEOUT_MS,
      resolveCapability: (sessionId, generation) =>
        this.authorities.get(`${sessionId}:${generation}`)?.capability,
      handle: (request, context) => this.handle(request, context),
    });
  }

  get mode(): PiAgentMode {
    return this.activeMode;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) throw new Error("Pi runtime brokers are disposed");
    await this.mcp.start();
    await this.broker.start();
    this.started = true;
  }

  mcpState(): McpBootstrap[] {
    return mcpBootstrap(this.mcp);
  }

  sensitiveValuesForRedaction(): string[] {
    return this.mcp.sensitiveValuesForRedaction();
  }

  mcpEndpoint(): { socketPath: string; capability: string } | undefined {
    return this.mcp.details().length > 0
      ? { socketPath: this.socketPath, capability: this.capability }
      : undefined;
  }

  taskEndpoint(): { brokerSocket: string; capability: string } | undefined {
    return this.handleTask
      ? { brokerSocket: this.socketPath, capability: this.capability }
      : undefined;
  }

  issueChildEndpoint(
    sessionId: string,
    generation: number,
    authority: PiChildBrokerAuthority,
  ): { brokerSocket: string; capability: string } {
    const childCapability = capability();
    this.authorities.set(`${sessionId}:${generation}`, {
      capability: childCapability,
      mode: authority.mode,
      readOnlyLocked: authority.readOnlyLocked,
      root: false,
    });
    return {
      brokerSocket: this.socketPath,
      capability: childCapability,
    };
  }

  revokeChildEndpoint(sessionId: string, generation: number): void {
    this.authorities.delete(`${sessionId}:${generation}`);
  }

  details() {
    return this.mcp.details();
  }

  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    await this.mcp.setEnabled(name, enabled);
  }

  async reconnectMcp(name: string): Promise<void> {
    await this.mcp.reconnect(name);
  }

  private async handle(
    request: PiBrokerRequest,
    context: PiBrokerRequestContext,
  ): Promise<unknown> {
    const authority = this.authorities.get(`${request.sessionId}:${request.generation}`);
    if (!authority) throw new Error("Managed Pi broker authority is stale");
    if (request.operation === "mcp.call") {
      const payload = record(request.payload);
      if (
        typeof payload.server !== "string" ||
        typeof payload.tool !== "string" ||
        (payload.arguments !== undefined &&
          (typeof payload.arguments !== "object" ||
            payload.arguments === null ||
            Array.isArray(payload.arguments)))
      ) {
        throw new Error("Managed MCP call payload is invalid");
      }
      return this.mcp.callTool({
        server: payload.server,
        tool: payload.tool,
        arguments: record(payload.arguments),
        signal: context.signal,
        readOnlyOnly:
          (authority.root ? this.activeMode : authority.mode) === "plan" ||
          authority.readOnlyLocked,
        onProgress: context.onProgress,
      });
    }
    if (request.operation === "native-file.action") {
      if (
        (authority.root ? this.activeMode : authority.mode) === "plan" ||
        authority.readOnlyLocked
      ) {
        throw new Error("Native file actions are unavailable in Plan mode");
      }
      if (!this.handleNativeFile) throw new Error("Native file helper is unavailable");
      return this.handleNativeFile(request, context);
    }
    if (request.operation === "mode.set") {
      const payload = record(request.payload);
      if (payload.mode !== "agent" && payload.mode !== "plan") {
        throw new Error("Managed Agent mode is invalid");
      }
      if (request.sessionId === this.sessionId && request.generation === this.generation) {
        await this.onModeChange?.(payload.mode);
        this.activeMode = payload.mode;
        authority.mode = payload.mode;
        return { mode: this.activeMode };
      }
      if (payload.mode === "agent" && authority.readOnlyLocked) {
        throw new Error("Read-only managed tasks cannot enter Agent mode");
      }
      if (!this.handleTask) {
        throw new Error("Managed child mode runtime is unavailable");
      }
      const result = await this.handleTask(request, context);
      authority.mode = payload.mode;
      return result;
    }
    if (request.operation === "mcp.status") {
      return { servers: mcpBootstrap(this.mcp) };
    }
    if (request.operation === "mcp.toggle") {
      const payload = record(request.payload);
      if (typeof payload.server !== "string" || typeof payload.enabled !== "boolean") {
        throw new Error("Managed MCP toggle payload is invalid");
      }
      await this.mcp.setEnabled(payload.server, payload.enabled);
      return { servers: mcpBootstrap(this.mcp) };
    }
    if (request.operation === "mcp.reconnect") {
      const payload = record(request.payload);
      if (typeof payload.server !== "string") {
        throw new Error("Managed MCP reconnect payload is invalid");
      }
      await this.mcp.reconnect(payload.server);
      return { servers: mcpBootstrap(this.mcp) };
    }
    if (
      request.operation === "task.start" ||
      request.operation === "task.stop" ||
      request.operation === "task.list" ||
      request.operation === "task.status" ||
      request.operation === "task.wait" ||
      request.operation === "task.steer"
    ) {
      if (!this.handleTask) throw new Error("Managed task broker is unavailable");
      return this.handleTask(request, context);
    }
    if (request.operation.startsWith("app.")) {
      const readOnlyOperations = new Set(["app.list", "app.versions"]);
      if (!readOnlyOperations.has(request.operation)) {
        if (!authority.root) {
          throw new Error("App mutations are available only to the root managed task");
        }
        if (this.activeMode === "plan" || authority.readOnlyLocked) {
          throw new Error("App mutations are unavailable in Plan mode");
        }
      }
      if (!this.handleApp) throw new Error("Managed App runtime is unavailable");
      return this.handleApp(request, context);
    }
    throw new Error("Unsupported managed Pi broker operation");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.authorities.clear();
    await Promise.allSettled([this.broker.dispose(), this.mcp.dispose()]);
  }
}
