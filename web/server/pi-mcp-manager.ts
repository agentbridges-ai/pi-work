import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { isMcpBootstrap, type McpBootstrap, type PiAgentMode } from "./pi-bootstrap-channel.js";
import {
  requestPiBroker,
  type PiBrokerEndpoint,
  type PiBrokerRequestOptions,
} from "./pi-broker-client.js";

type McpExtensionApi = Pick<ExtensionAPI, "getAllTools" | "registerTool" | "setActiveTools">;

type BrokerRequest = (options: PiBrokerRequestOptions) => Promise<unknown>;

interface ManagedToolBinding {
  server: string;
  tool: string;
  readOnly: boolean;
}

export interface PiMcpManagerOptions {
  pi: McpExtensionApi;
  endpoint?: PiBrokerEndpoint;
  sessionId: string;
  generation: number;
  initial: readonly McpBootstrap[];
  request?: BrokerRequest;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textResult(text: string, details: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function safeMcpSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  if (!normalized || normalized.length > 80) {
    throw new Error("Managed MCP name is invalid.");
  }
  return normalized;
}

export function managedMcpToolName(server: string, tool: string): string {
  return `mcp__${safeMcpSegment(server)}__${safeMcpSegment(tool)}`;
}

function cloneSnapshot(servers: readonly McpBootstrap[]): McpBootstrap[] {
  return servers.map((server) => ({
    name: server.name,
    enabled: server.enabled,
    status: server.status,
    transport: server.transport,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema ? { inputSchema: structuredClone(tool.inputSchema) } : {}),
      readOnly: tool.readOnly,
    })),
    ...(server.readOnlyTools ? { readOnlyTools: [...server.readOnlyTools] } : {}),
  }));
}

function parseStatus(value: unknown): McpBootstrap[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.servers) ||
    !value.servers.every(isMcpBootstrap)
  ) {
    throw new Error("Managed MCP status response is invalid.");
  }
  const names = new Set<string>();
  for (const server of value.servers) {
    if (names.has(server.name)) {
      throw new Error("Managed MCP status contains duplicate servers.");
    }
    names.add(server.name);
  }
  return cloneSnapshot(value.servers);
}

/**
 * Pi-side projection of the server-owned MCP manager. Credentials, remote
 * headers, commands, and URLs never enter this object. It receives only tool
 * metadata plus an opaque generation-bound broker endpoint.
 */
export class PiMcpManager {
  private readonly pi: McpExtensionApi;
  private readonly endpoint?: PiBrokerEndpoint;
  private readonly sessionId: string;
  private readonly generation: number;
  private readonly request: BrokerRequest;
  private readonly knownBindings = new Map<string, Omit<ManagedToolBinding, "readOnly">>();
  private readonly registeredNames = new Set<string>();
  private activeBindings = new Map<string, ManagedToolBinding>();
  private servers: McpBootstrap[] = [];

  constructor(options: PiMcpManagerOptions) {
    this.pi = options.pi;
    this.endpoint = options.endpoint;
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.request = options.request ?? requestPiBroker;
    this.replaceSnapshot(cloneSnapshot(options.initial));
  }

  snapshot(): McpBootstrap[] {
    return cloneSnapshot(this.servers);
  }

  isManagedTool(name: string): boolean {
    return this.registeredNames.has(name);
  }

  isActiveTool(name: string): boolean {
    return this.activeBindings.has(name);
  }

  readOnly(name: string): boolean | undefined {
    return this.activeBindings.get(name)?.readOnly;
  }

  applyActiveTools(mode: PiAgentMode): void {
    const available = this.pi.getAllTools().map((tool) => tool.name);
    this.pi.setActiveTools(
      available.filter((name) => {
        if (this.registeredNames.has(name) && !this.activeBindings.has(name)) {
          return false;
        }
        if (mode === "agent") return true;
        if (name === "write" || name === "edit") return false;
        const mcp = this.activeBindings.get(name);
        return mcp ? mcp.readOnly : true;
      }),
    );
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.endpoint) {
      this.replaceSnapshot([]);
      return;
    }
    try {
      const value = await this.request({
        endpoint: this.endpoint,
        sessionId: this.sessionId,
        generation: this.generation,
        operation: "mcp.status",
        signal,
      });
      this.replaceSnapshot(parseStatus(value));
    } catch (error) {
      // A stale catalog must never remain callable after the server-owned
      // broker becomes unavailable or returns malformed state.
      this.replaceSnapshot([]);
      throw error;
    }
  }

  private replaceSnapshot(servers: McpBootstrap[]): void {
    const nextBindings = new Map<string, ManagedToolBinding>();
    const identities = new Set<string>();
    const planned: Array<{
      name: string;
      binding: ManagedToolBinding;
      inputSchema?: Record<string, unknown>;
      description?: string;
    }> = [];
    for (const server of servers) {
      if (!server.enabled || server.status !== "connected") continue;
      for (const tool of server.tools) {
        const identityKey = JSON.stringify([server.name, tool.name]);
        if (identities.has(identityKey)) {
          throw new Error("Managed MCP status contains duplicate tools.");
        }
        identities.add(identityKey);
        const name = managedMcpToolName(server.name, tool.name);
        const identity = { server: server.name, tool: tool.name };
        const known = this.knownBindings.get(name);
        if (known && (known.server !== identity.server || known.tool !== identity.tool)) {
          throw new Error("Managed MCP tool names collide after normalization.");
        }
        const current = nextBindings.get(name);
        if (current && (current.server !== identity.server || current.tool !== identity.tool)) {
          throw new Error("Managed MCP tool names collide after normalization.");
        }
        const binding = {
          ...identity,
          readOnly: tool.readOnly,
        };
        nextBindings.set(name, binding);
        planned.push({
          name,
          binding,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.description ? { description: tool.description } : {}),
        });
      }
    }
    for (const tool of planned) {
      this.knownBindings.set(tool.name, {
        server: tool.binding.server,
        tool: tool.binding.tool,
      });
      this.registeredNames.add(tool.name);
      this.registerTool(tool.name, tool.inputSchema, tool.description);
    }
    this.servers = cloneSnapshot(servers);
    this.activeBindings = nextBindings;
  }

  private registerTool(
    name: string,
    inputSchema: Record<string, unknown> | undefined,
    description: string | undefined,
  ): void {
    this.pi.registerTool({
      name,
      label: name,
      description: description ?? "Managed MCP tool.",
      parameters: (inputSchema ?? {
        type: "object",
        additionalProperties: true,
      }) as TSchema,
      execute: async (_id, params, signal, onUpdate) => {
        const binding = this.activeBindings.get(name);
        if (!binding || !this.endpoint) {
          throw new Error("Managed MCP tool is unavailable.");
        }
        const value = await this.request({
          endpoint: this.endpoint,
          sessionId: this.sessionId,
          generation: this.generation,
          operation: "mcp.call",
          payload: {
            server: binding.server,
            tool: binding.tool,
            arguments: params,
          },
          signal,
          onProgress: (progress) =>
            onUpdate?.({
              content: [{ type: "text", text: JSON.stringify(progress) }],
              details: progress,
            }),
        });
        return textResult(JSON.stringify(value), value);
      },
    } as ToolDefinition);
  }
}
