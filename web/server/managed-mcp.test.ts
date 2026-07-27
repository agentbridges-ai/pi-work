import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    closed: boolean;
    transport?: { close(): Promise<void> };
  }>,
  transports: [] as Array<{
    kind: "stdio" | "sse" | "streamable-http";
    input: unknown;
    options?: Record<string, unknown>;
    closed: boolean;
    close(): Promise<void>;
  }>,
  connectDelays: [] as Array<Promise<void>>,
  toolsQueue: [] as Array<
    Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>
  >,
  callResult: { content: [{ type: "text", text: "ok" }] } as unknown,
  progressResult: undefined as unknown,
}));

function transport(
  kind: "stdio" | "sse" | "streamable-http",
  input: unknown,
  options?: Record<string, unknown>,
) {
  const value = {
    kind,
    input,
    options,
    closed: false,
    async close() {
      value.closed = true;
    },
  };
  mocks.transports.push(value);
  return value;
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    onerror?: () => void;
    closed = false;
    transport?: { close(): Promise<void> };

    constructor() {
      mocks.clients.push(this);
    }

    async connect(value: { close(): Promise<void> }) {
      this.transport = value;
      await (mocks.connectDelays.shift() ?? Promise.resolve());
    }

    async listTools() {
      return {
        tools: mocks.toolsQueue.shift() ?? [
          {
            name: "search",
            description: "Search documents",
            inputSchema: { type: "object" },
          },
        ],
      };
    }

    getServerVersion() {
      return { name: "test-mcp", version: "1" };
    }

    async callTool(
      _request: unknown,
      _schema: unknown,
      options: { onprogress?: (value: unknown) => void },
    ) {
      if (mocks.progressResult !== undefined) {
        options.onprogress?.(mocks.progressResult);
      }
      return mocks.callResult;
    }

    async close() {
      this.closed = true;
      await this.transport?.close();
      this.onclose?.();
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    private readonly value: ReturnType<typeof transport>;
    constructor(input: unknown, options?: Record<string, unknown>) {
      this.value = transport("sse", input, options);
    }
    close() {
      return this.value.close();
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    private readonly value: ReturnType<typeof transport>;
    readonly stderr = { on: vi.fn() };
    constructor(input: unknown) {
      this.value = transport("stdio", input);
    }
    close() {
      return this.value.close();
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    private readonly value: ReturnType<typeof transport>;
    constructor(input: unknown, options?: Record<string, unknown>) {
      this.value = transport("streamable-http", input, options);
    }
    close() {
      return this.value.close();
    }
  },
}));

import {
  ManagedMcpManager,
  markManagedMcpCredential,
  parseManagedMcpServerConfig,
} from "./managed-mcp.js";

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.transports.length = 0;
  mocks.connectDelays.length = 0;
  mocks.toolsQueue.length = 0;
  mocks.callResult = { content: [{ type: "text", text: "ok" }] };
  mocks.progressResult = undefined;
});

describe("managed MCP configuration", () => {
  it("rejects injected SDK transports", () => {
    expect(() =>
      parseManagedMcpServerConfig({
        name: "unsafe",
        enabled: true,
        transport: "sdk",
      }),
    ).toThrow(/forbidden/u);
  });

  it("rejects credential-shaped stdio environment and relative commands", () => {
    expect(() =>
      parseManagedMcpServerConfig({
        name: "stdio",
        enabled: true,
        transport: "stdio",
        command: "node",
      }),
    ).toThrow(/command/u);
    expect(() =>
      parseManagedMcpServerConfig({
        name: "stdio",
        enabled: true,
        transport: "stdio",
        command: "/usr/bin/node",
        env: { API_TOKEN: "secret" },
      }),
    ).toThrow(/non-secret/u);
  });

  it("requires credential-free HTTPS endpoint URLs", () => {
    expect(() =>
      parseManagedMcpServerConfig({
        name: "remote",
        enabled: true,
        transport: "streamable-http",
        url: "http://example.test/mcp",
      }),
    ).toThrow(/HTTPS/u);
    expect(() =>
      parseManagedMcpServerConfig({
        name: "remote",
        enabled: true,
        transport: "sse",
        url: "https://user:secret@example.test/mcp",
      }),
    ).toThrow(/credentials/u);
    expect(() =>
      parseManagedMcpServerConfig({
        name: "remote",
        enabled: true,
        transport: "streamable-http",
        url: "https://example.test/mcp?access_token=persisted-secret",
      }),
    ).toThrow(/credentials|HTTPS/u);
    expect(() =>
      parseManagedMcpServerConfig({
        name: "remote",
        enabled: true,
        transport: "sse",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer persisted-secret" },
      }),
    ).toThrow(/headers/u);
  });

  it("never exposes managed headers in status details", () => {
    const manager = new ManagedMcpManager({
      servers: [
        markManagedMcpCredential(
          {
            name: "remote",
            enabled: false,
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
          "Authorization",
          "Bearer secret-canary",
          "secret-canary",
        ),
      ],
    });
    expect(JSON.stringify(manager.details())).not.toContain("secret");
    expect(manager.details()).toMatchObject([
      {
        name: "remote",
        enabled: false,
        status: "disabled",
        config: {
          transport: "streamable-http",
          url: "https://example.test/mcp",
        },
      },
    ]);
  });

  it("consumes non-serializable credential material exactly once", async () => {
    const config = markManagedMcpCredential(
      {
        name: "remote",
        enabled: false,
        transport: "streamable-http",
        url: "https://example.test/mcp",
      },
      "Authorization",
      "Bearer secret-canary",
      "secret-canary",
    );
    expect(JSON.stringify(config)).not.toContain("secret-canary");
    const manager = new ManagedMcpManager({ servers: [config] });
    expect(() => new ManagedMcpManager({ servers: [config] })).toThrow(/already consumed/u);
    await manager.dispose();
  });

  it("discovers tools when an initially disabled server is enabled and reconnected", async () => {
    const manager = new ManagedMcpManager({
      servers: [
        {
          name: "remote",
          enabled: false,
          transport: "streamable-http",
          url: "https://example.test/mcp",
          toolPolicies: { search: { readOnly: true } },
        },
      ],
    });
    await manager.start();
    expect(manager.details()[0]).toMatchObject({
      enabled: false,
      status: "disabled",
      tools: [],
    });

    await manager.setEnabled("remote", true);
    expect(manager.details()[0]).toMatchObject({
      enabled: true,
      status: "connected",
      tools: [{ name: "search", readOnly: true }],
    });

    await manager.setEnabled("remote", false);
    expect(manager.details()[0]).toMatchObject({
      enabled: false,
      status: "disabled",
      tools: [],
    });
    await manager.setEnabled("remote", true);
    await manager.reconnect("remote");
    expect(mocks.clients).toHaveLength(3);
    expect(manager.details()[0]?.tools).toHaveLength(1);
    await manager.dispose();
  });

  it("supports stdio, SSE, and Streamable HTTP with independent authorization", async () => {
    const authorizeStdio = vi.fn();
    const authorizeRemoteUrl = vi.fn();
    const manager = new ManagedMcpManager({
      servers: [
        {
          name: "stdio",
          enabled: false,
          transport: "stdio",
          command: "/usr/bin/mcp",
        },
        {
          name: "events",
          enabled: false,
          transport: "sse",
          url: "https://events.example.test/mcp",
        },
        {
          name: "http",
          enabled: false,
          transport: "streamable-http",
          url: "https://http.example.test/mcp",
        },
      ],
      authorizeStdio,
      authorizeRemoteUrl,
    });

    await manager.start();
    expect(manager.details().map(({ status }) => status)).toEqual([
      "disabled",
      "disabled",
      "disabled",
    ]);
    await Promise.all(["stdio", "events", "http"].map((name) => manager.setEnabled(name, true)));
    expect(manager.details().map(({ status }) => status)).toEqual([
      "connected",
      "connected",
      "connected",
    ]);
    expect(mocks.transports.map(({ kind }) => kind).sort()).toEqual([
      "sse",
      "stdio",
      "streamable-http",
    ]);
    expect(authorizeStdio).toHaveBeenCalledOnce();
    expect(authorizeRemoteUrl).toHaveBeenCalledTimes(2);
    await Promise.all(["stdio", "events", "http"].map((name) => manager.reconnect(name)));
    expect(manager.details().every(({ tools }) => tools.length === 1)).toBe(true);
    await Promise.all(["stdio", "events", "http"].map((name) => manager.setEnabled(name, false)));
    expect(manager.details().map(({ status }) => status)).toEqual([
      "disabled",
      "disabled",
      "disabled",
    ]);
    await manager.dispose();
  });

  it("pins authenticated fetches to the authorized origin and rejects redirects", async () => {
    const fetchCalls: Array<{
      input: Parameters<typeof fetch>[0];
      init?: Parameters<typeof fetch>[1];
    }> = [];
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        fetchCalls.push({ input, init });
        return new Response("ok");
      },
    );
    const baseFetch = fetchMock as unknown as typeof fetch;
    const authorizeRemoteUrl = vi.fn();
    const manager = new ManagedMcpManager({
      servers: [
        markManagedMcpCredential(
          {
            name: "remote",
            enabled: true,
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
          "Authorization",
          "Bearer secret-canary",
          "secret-canary",
        ),
      ],
      fetch: baseFetch,
      authorizeRemoteUrl,
    });
    await manager.start();
    const remote = mocks.transports.find(({ kind }) => kind === "streamable-http");
    const managedFetch = remote?.options?.fetch as typeof fetch;

    await managedFetch("https://example.test/next", {
      headers: { Accept: "application/json" },
    });
    expect(authorizeRemoteUrl).toHaveBeenLastCalledWith(
      new URL("https://example.test/next"),
      "remote",
    );
    const init = fetchCalls.at(-1)?.init;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-canary");
    expect(init?.redirect).toBe("error");
    await expect(managedFetch("https://redirected.example.test/mcp")).rejects.toMatchObject({
      code: "policy_denied",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("redacts credential echoes from tool metadata, progress, and results", async () => {
    mocks.toolsQueue.push([
      {
        name: "search",
        description: "credential=secret-canary",
        inputSchema: {
          type: "object",
          description: "secret-canary",
        },
      },
    ]);
    mocks.progressResult = { message: "Bearer secret-canary" };
    mocks.callResult = {
      content: [{ type: "text", text: "secret-canary" }],
    };
    const manager = new ManagedMcpManager({
      servers: [
        markManagedMcpCredential(
          {
            name: "remote",
            enabled: true,
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
          "Authorization",
          "Bearer secret-canary",
          "secret-canary",
        ),
      ],
    });
    await manager.start();
    expect(JSON.stringify(manager.details())).not.toContain("secret-canary");
    const progress = vi.fn();
    const result = await manager.callTool({
      server: "remote",
      tool: "search",
      onProgress: progress,
    });
    expect(JSON.stringify(result)).not.toContain("secret-canary");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("secret-canary");
    await manager.dispose();
  });

  it("cannot resurrect a connection that was disabled while connecting", async () => {
    let finishConnect!: () => void;
    mocks.connectDelays.push(
      new Promise<void>((resolve) => {
        finishConnect = resolve;
      }),
    );
    const manager = new ManagedMcpManager({
      servers: [
        {
          name: "remote",
          enabled: true,
          transport: "streamable-http",
          url: "https://example.test/mcp",
        },
      ],
    });
    const starting = manager.start();
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(1));
    const disabling = manager.setEnabled("remote", false);
    finishConnect();
    await Promise.all([starting, disabling]);
    expect(manager.details()[0]).toMatchObject({
      enabled: false,
      status: "disabled",
      tools: [],
    });
    expect(mocks.clients[0]?.closed).toBe(true);
    await manager.dispose();
  });
});
