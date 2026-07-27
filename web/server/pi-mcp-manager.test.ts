import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpBootstrap } from "./pi-bootstrap-channel.js";
import { managedMcpToolName, PiMcpManager } from "./pi-mcp-manager.js";

function server(enabled: boolean, readOnly = true): McpBootstrap {
  return {
    name: "docs",
    enabled,
    status: enabled ? "connected" : "disabled",
    transport: "streamable-http",
    tools: enabled
      ? [
          {
            name: "search",
            description: "Search documents",
            inputSchema: { type: "object" },
            readOnly,
          },
        ]
      : [],
  };
}

function fixture(initial: readonly McpBootstrap[] = [server(false)]) {
  const tools = new Map<string, ToolDefinition>();
  for (const name of ["read", "write", "edit", "bash"]) {
    tools.set(name, {
      name,
      label: name,
      description: name,
      parameters: { type: "object" } as never,
      execute: vi.fn(),
    });
  }
  const active: string[][] = [];
  const pi = {
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
    getAllTools: vi.fn(() =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: {
          path: "<test>",
          resolvedPath: "<test>",
          source: "explicit",
        },
      })),
    ),
    setActiveTools: vi.fn((names: string[]) => {
      active.push([...names]);
    }),
  } as unknown as Pick<ExtensionAPI, "getAllTools" | "registerTool" | "setActiveTools">;
  const request = vi.fn();
  const manager = new PiMcpManager({
    pi,
    endpoint: {
      socketPath: "/tmp/piwork-mcp-test.sock",
      capability: "opaque-capability",
    },
    sessionId: "session-1",
    generation: 4,
    initial,
    request,
  });
  return { active, manager, pi, request, tools };
}

describe("PiMcpManager", () => {
  it("discovers tools after an initially disabled server is enabled", async () => {
    const value = fixture();
    expect(value.pi.registerTool).not.toHaveBeenCalled();
    value.request.mockResolvedValueOnce({ servers: [server(true)] });

    await value.manager.refresh();
    value.manager.applyActiveTools("agent");

    const name = "mcp__docs__search";
    expect(value.tools.has(name)).toBe(true);
    expect(value.manager.isActiveTool(name)).toBe(true);
    expect(value.active.at(-1)).toContain(name);
    expect(value.manager.snapshot()).toEqual([server(true)]);
  });

  it("keeps disabled and removed definitions inactive in Agent and Plan modes", async () => {
    const value = fixture([server(true, false)]);
    const name = "mcp__docs__search";
    expect(value.tools.has(name)).toBe(true);

    value.request.mockResolvedValueOnce({ servers: [server(false)] });
    await value.manager.refresh();
    value.manager.applyActiveTools("agent");
    expect(value.active.at(-1)).not.toContain(name);

    value.manager.applyActiveTools("plan");
    expect(value.active.at(-1)).not.toContain(name);
    expect(value.active.at(-1)).not.toContain("write");
    expect(value.active.at(-1)).not.toContain("edit");
    await expect(
      value.tools.get(name)!.execute("call-1", {}, undefined, undefined, {} as never),
    ).rejects.toThrow("unavailable");
  });

  it("allows only explicitly read-only MCP tools in Plan mode", () => {
    const value = fixture([
      {
        ...server(true),
        tools: [
          { name: "read", readOnly: true },
          { name: "write", readOnly: false },
        ],
      },
    ]);

    value.manager.applyActiveTools("plan");
    expect(value.active.at(-1)).toContain("mcp__docs__read");
    expect(value.active.at(-1)).not.toContain("mcp__docs__write");
  });

  it("routes calls through the opaque broker without transport configuration", async () => {
    const value = fixture([server(true)]);
    value.request.mockResolvedValueOnce({ content: "result" });
    const tool = value.tools.get("mcp__docs__search")!;
    await expect(
      tool.execute("call-1", { query: "pi" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: '{"content":"result"}' }],
    });
    expect(value.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mcp.call",
        sessionId: "session-1",
        generation: 4,
        payload: {
          server: "docs",
          tool: "search",
          arguments: { query: "pi" },
        },
      }),
    );
    expect(JSON.stringify(value.manager.snapshot())).not.toMatch(
      /capability|headers|command|url/iu,
    );
  });

  it("fails closed on malformed status and normalized-name collisions", async () => {
    const value = fixture([server(true)]);
    value.request.mockResolvedValueOnce({
      servers: [
        {
          ...server(true),
          headers: { Authorization: "must-not-cross-broker" },
        },
      ],
    });
    await expect(value.manager.refresh()).rejects.toThrow("invalid");
    value.manager.applyActiveTools("agent");
    expect(value.active.at(-1)).not.toContain("mcp__docs__search");

    expect(
      () =>
        new PiMcpManager({
          pi: value.pi,
          sessionId: "session-1",
          generation: 4,
          initial: [
            {
              name: "docs.prod",
              enabled: true,
              status: "connected",
              transport: "sse",
              tools: [{ name: "search", readOnly: true }],
            },
            {
              name: "docs_prod",
              enabled: true,
              status: "connected",
              transport: "sse",
              tools: [{ name: "search", readOnly: true }],
            },
          ],
          request: value.request,
        }),
    ).toThrow("collide");
  });

  it("produces deterministic Pi-native names", () => {
    expect(managedMcpToolName("files.prod", "read/file")).toBe("mcp__files_prod__read_file");
  });
});
