import { describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

import { materializeManagedMcpServer } from "./control-plane-managed-mcp.js";

describe("control-plane managed MCP materialization", () => {
  it("supports the three native managed transports", () => {
    expect(
      materializeManagedMcpServer({
        name: "local",
        transport: "stdio",
        config: {
          command: "/usr/bin/local-mcp",
          args: ["--read-only"],
          env: { LOG_LEVEL: "warn" },
        },
      }),
    ).toEqual({
      name: "local",
      enabled: true,
      transport: "stdio",
      command: "/usr/bin/local-mcp",
      args: ["--read-only"],
      env: { LOG_LEVEL: "warn" },
    });
    expect(
      materializeManagedMcpServer({
        name: "events",
        transport: "sse",
        config: { url: "https://mcp.example.test/events" },
      }),
    ).toMatchObject({
      name: "events",
      enabled: true,
      transport: "sse",
    });
    expect(
      materializeManagedMcpServer({
        name: "documents",
        transport: "streamable-http",
        config: { url: "https://mcp.example.test/rpc" },
      }),
    ).toMatchObject({
      name: "documents",
      enabled: true,
      transport: "streamable-http",
    });
  });

  it("materializes encrypted remote credentials only into an in-memory header copy", () => {
    const config = {
      url: "https://mcp.example.test/rpc",
      headers: { Accept: "application/json" },
      credentialHeader: "X-API-Key",
      credentialScheme: "Token",
    };
    const resolved = materializeManagedMcpServer(
      { name: "documents", transport: "streamable-http", config },
      "secret-canary",
    );

    expect(resolved).toMatchObject({
      headers: {
        Accept: "application/json",
      },
    });
    expect(JSON.stringify(resolved)).not.toContain("secret-canary");
    expect(config.headers).toEqual({ Accept: "application/json" });
    expect(resolved).not.toHaveProperty("credentialHeader");
    expect(resolved).not.toHaveProperty("credentialScheme");
  });

  it("rejects credential-bearing stdio env, persisted auth headers, and unsupported transports", () => {
    expect(() =>
      materializeManagedMcpServer({
        name: "local",
        transport: "stdio",
        config: {
          command: "/usr/bin/local-mcp",
          env: { ACCESS_TOKEN: "must-not-enter-env" },
        },
      }),
    ).toThrow("non-secret settings");
    expect(() =>
      materializeManagedMcpServer({
        name: "local",
        transport: "stdio",
        config: {
          command: "/usr/bin/local-mcp",
          args: ["--api-key", "must-not-enter-argv"],
        },
      }),
    ).toThrow("arguments");
    expect(() =>
      materializeManagedMcpServer({
        name: "remote",
        transport: "sse",
        config: {
          url: "https://mcp.example.test/events",
          headers: { Authorization: "must-not-be-persisted" },
        },
      }),
    ).toThrow("encrypted secret");
    expect(() =>
      materializeManagedMcpServer({
        name: "remote",
        transport: "sse",
        config: {
          url: "https://mcp.example.test/events",
          headers: { "X-Access-Token": "must-not-be-persisted" },
        },
      }),
    ).toThrow("encrypted secret");
    expect(() =>
      materializeManagedMcpServer({
        name: "remote",
        transport: "sdk",
        config: {},
      }),
    ).toThrow("unsupported");
    expect(() =>
      materializeManagedMcpServer(
        {
          name: "local",
          transport: "stdio",
          config: { command: "/usr/bin/local-mcp" },
        },
        "must-not-enter-env",
      ),
    ).toThrow("isolated capability channel");
    expect(() =>
      materializeManagedMcpServer(
        {
          name: "remote",
          transport: "streamable-http",
          config: { url: "https://mcp.example.test/rpc" },
        },
        "unsafe\r\nheader",
      ),
    ).toThrow("credential is invalid");
  });
});
