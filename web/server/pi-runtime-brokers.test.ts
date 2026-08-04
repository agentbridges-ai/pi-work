import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  handle: undefined as
    | ((
        request: Record<string, unknown>,
        context: {
          signal: AbortSignal;
          onProgress(value: unknown): void;
        },
      ) => Promise<unknown>)
    | undefined,
  resolveCapability: undefined as
    ((sessionId: string, generation: number) => string | undefined) | undefined,
  enabled: false,
  reconnects: 0,
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./managed-mcp.js", () => ({
  ManagedMcpManager: class {
    private readonly hasServers: boolean;

    constructor(options: { servers?: unknown[] }) {
      this.hasServers = (options.servers?.length ?? 0) > 0;
    }

    async start() {
      mocks.order.push("mcp");
    }
    details() {
      if (!this.hasServers) return [];
      return [
        {
          name: "docs",
          transport: "streamable-http",
          status: mocks.enabled ? "connected" : "disabled",
          enabled: mocks.enabled,
          tools: mocks.enabled
            ? [
                {
                  name: "search",
                  description: "Search",
                  inputSchema: { type: "object" },
                  readOnly: true,
                },
              ]
            : [],
          config: {
            transport: "streamable-http",
            url: "https://mcp.example.test",
          },
        },
      ];
    }
    async setEnabled(_name: string, enabled: boolean) {
      mocks.enabled = enabled;
    }
    async reconnect() {
      mocks.reconnects += 1;
    }
    async callTool(options: Record<string, unknown>) {
      mocks.calls.push(options);
      if (options.readOnlyOnly === true && options.tool === "write") {
        throw new Error("Managed MCP tool is not read-only");
      }
      return { ok: true };
    }
    sensitiveValuesForRedaction() {
      return ["managed-secret"];
    }
    async dispose() {
      mocks.order.push("mcp:dispose");
    }
  },
}));

vi.mock("./pi-broker-server.js", () => ({
  PiBrokerServer: class {
    constructor(options: {
      resolveCapability(sessionId: string, generation: number): string | undefined;
      handle(
        request: Record<string, unknown>,
        context: {
          signal: AbortSignal;
          onProgress(value: unknown): void;
        },
      ): Promise<unknown>;
    }) {
      mocks.handle = options.handle;
      mocks.resolveCapability = options.resolveCapability;
    }
    async start() {
      mocks.order.push("broker");
    }
    async dispose() {
      mocks.order.push("broker:dispose");
    }
  },
}));

import { PiRuntimeBrokers, type PiTaskBrokerHandler } from "./pi-runtime-brokers.js";

beforeEach(() => {
  mocks.order.length = 0;
  mocks.handle = undefined;
  mocks.resolveCapability = undefined;
  mocks.enabled = false;
  mocks.reconnects = 0;
  mocks.calls.length = 0;
});

function request(
  operation: string,
  payload?: unknown,
  sessionId = "session-1",
  generation = 3,
): Record<string, unknown> {
  return {
    id: "request-1",
    sessionId,
    generation,
    operation,
    payload,
  };
}

describe("PiRuntimeBrokers", () => {
  it("starts MCP discovery before accepting broker requests", async () => {
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      managedMcpServers: [
        {
          name: "docs",
          enabled: false,
          transport: "streamable-http",
          url: "https://mcp.example.test",
        },
      ],
    });

    await brokers.start();
    expect(mocks.order).toEqual(["mcp", "broker"]);
    expect(brokers.mcpEndpoint()).toEqual({
      socketPath: "/tmp/piwork-runtime-test/pi-brokers/session-1-3.sock",
      capability: expect.any(String),
    });
    await brokers.dispose();
  });

  it("returns only sanitized tool metadata after enabling and reconnecting", async () => {
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      managedMcpServers: [
        {
          name: "docs",
          enabled: false,
          transport: "streamable-http",
          url: "https://mcp.example.test",
        },
      ],
    });
    await brokers.start();
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };

    await mocks.handle!(
      request("mcp.toggle", {
        server: "docs",
        enabled: true,
      }),
      context,
    );
    const status = await mocks.handle!(request("mcp.status"), context);
    expect(status).toEqual({
      servers: [
        {
          name: "docs",
          enabled: true,
          status: "connected",
          transport: "streamable-http",
          tools: [
            {
              name: "search",
              description: "Search",
              inputSchema: { type: "object" },
              readOnly: true,
            },
          ],
          readOnlyTools: ["search"],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toMatch(/https:|headers|command|capability/iu);

    await mocks.handle!(request("mcp.reconnect", { server: "docs" }), context);
    expect(mocks.reconnects).toBe(1);
    await brokers.dispose();
  });

  it("issues distinct generation-bound child capabilities and revokes them", () => {
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
    });
    const child = brokers.issueChildEndpoint("child-session", 1, {
      mode: "agent",
      readOnlyLocked: false,
    });
    expect(child.capability).not.toBe(brokers.capability);
    expect(mocks.resolveCapability?.("child-session", 1)).toBe(child.capability);

    brokers.revokeChildEndpoint("child-session", 1);
    expect(mocks.resolveCapability?.("child-session", 1)).toBeUndefined();
  });

  it("binds child Plan authority independently from an Agent-mode root", async () => {
    const handleTask = vi.fn(async () => ({ mode: "agent" }));
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      handleTask,
    });
    brokers.issueChildEndpoint("child-session", 1, {
      mode: "plan",
      readOnlyLocked: true,
    });
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };

    await expect(
      mocks.handle!(
        request("mcp.call", { server: "docs", tool: "write", arguments: {} }, "child-session", 1),
        context,
      ),
    ).rejects.toThrow(/not read-only/);
    expect(mocks.calls.at(-1)).toMatchObject({ readOnlyOnly: true });

    await expect(
      mocks.handle!(request("mode.set", { mode: "agent" }, "child-session", 1), context),
    ).rejects.toThrow(/cannot enter Agent mode/);
    expect(handleTask).not.toHaveBeenCalled();

    await expect(
      mocks.handle!(request("mcp.call", { server: "docs", tool: "write", arguments: {} }), context),
    ).resolves.toEqual({ ok: true });
    expect(mocks.calls.at(-1)).toMatchObject({ readOnlyOnly: false });
  });

  it("allows typed native file actions only for Agent-mode authority", async () => {
    const handleNativeFile = vi.fn(async () => ({
      operationId: "operation-a",
      action: "file.quickLook",
      state: "shown",
    }));
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      handleNativeFile,
    });
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };

    await expect(
      mocks.handle!(
        request("native-file.action", {
          action: "file.quickLook",
          path: "report.docx",
        }),
        context,
      ),
    ).resolves.toMatchObject({ operationId: "operation-a", state: "shown" });
    expect(handleNativeFile).toHaveBeenCalledOnce();

    await mocks.handle!(request("mode.set", { mode: "plan" }), context);
    await expect(
      mocks.handle!(
        request("native-file.action", {
          action: "file.open",
          path: "report.docx",
        }),
        context,
      ),
    ).rejects.toThrow(/unavailable in Plan mode/);
    expect(handleNativeFile).toHaveBeenCalledOnce();
  });

  it("exposes only configured endpoints and delegates public MCP controls", async () => {
    const withoutServices = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
    });
    expect(withoutServices.mcpEndpoint()).toBeUndefined();
    expect(withoutServices.taskEndpoint()).toBeUndefined();
    expect(withoutServices.mcpState()).toEqual([]);
    expect(withoutServices.details()).toEqual([]);
    expect(withoutServices.sensitiveValuesForRedaction()).toEqual(["managed-secret"]);

    const handleTask = vi.fn(async () => ({ ok: true }));
    const withServices = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      managedMcpServers: [
        {
          name: "docs",
          enabled: false,
          transport: "streamable-http",
          url: "https://mcp.example.test",
        },
      ],
      handleTask,
    });
    expect(withServices.taskEndpoint()).toEqual({
      brokerSocket: withServices.socketPath,
      capability: withServices.capability,
    });
    await withServices.setMcpEnabled("docs", true);
    await withServices.reconnectMcp("docs");
    expect(withServices.mcpState()[0]).toMatchObject({ name: "docs", enabled: true });
    expect(mocks.reconnects).toBe(1);
  });

  it("updates root and child modes while preserving read-only authority", async () => {
    const onModeChange = vi.fn(async () => undefined);
    const handleTask = vi.fn(async () => ({ mode: "plan" }));
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      onModeChange,
      handleTask,
    });
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };

    await expect(mocks.handle!(request("mode.set", { mode: "plan" }), context)).resolves.toEqual({
      mode: "plan",
    });
    expect(brokers.mode).toBe("plan");
    expect(onModeChange).toHaveBeenCalledWith("plan");

    brokers.issueChildEndpoint("child-session", 1, {
      mode: "agent",
      readOnlyLocked: false,
    });
    await expect(
      mocks.handle!(request("mode.set", { mode: "plan" }, "child-session", 1), context),
    ).resolves.toEqual({ mode: "plan" });
    expect(handleTask).toHaveBeenCalledOnce();
    await mocks.handle!(
      request("mcp.call", { server: "docs", tool: "read" }, "child-session", 1),
      context,
    );
    expect(mocks.calls.at(-1)).toMatchObject({ arguments: {}, readOnlyOnly: true });
  });

  it("fails closed for stale authority and malformed or unavailable operations", async () => {
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
    });
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };

    await expect(
      mocks.handle!(request("mcp.status", undefined, "stale", 1), context),
    ).rejects.toThrow(/authority is stale/);
    for (const payload of [
      undefined,
      { server: 1, tool: "read" },
      { server: "docs", tool: 1 },
      { server: "docs", tool: "read", arguments: [] },
    ]) {
      await expect(mocks.handle!(request("mcp.call", payload), context)).rejects.toThrow(
        /payload is invalid/,
      );
    }
    await expect(mocks.handle!(request("mode.set", { mode: "unsafe" }), context)).rejects.toThrow(
      /mode is invalid/,
    );

    brokers.issueChildEndpoint("child-session", 1, {
      mode: "agent",
      readOnlyLocked: false,
    });
    await expect(
      mocks.handle!(request("mode.set", { mode: "plan" }, "child-session", 1), context),
    ).rejects.toThrow(/child mode runtime is unavailable/);
    await expect(
      mocks.handle!(request("mcp.toggle", { server: 1, enabled: true }), context),
    ).rejects.toThrow(/toggle payload is invalid/);
    await expect(mocks.handle!(request("mcp.reconnect", { server: 1 }), context)).rejects.toThrow(
      /reconnect payload is invalid/,
    );
    await expect(mocks.handle!(request("task.start"), context)).rejects.toThrow(
      /task broker is unavailable/,
    );
    await expect(mocks.handle!(request("unknown"), context)).rejects.toThrow(/Unsupported/);
  });

  it("delegates task operations and makes start/dispose idempotent", async () => {
    const handleTask: PiTaskBrokerHandler = vi.fn(async (value) => ({
      operation: value.operation,
    }));
    const brokers = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-1",
      generation: 3,
      mode: "agent",
      handleTask,
    });
    const context = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };
    await brokers.start();
    await brokers.start();
    expect(mocks.order).toEqual(["mcp", "broker"]);
    await expect(mocks.handle!(request("task.start"), context)).resolves.toEqual({
      operation: "task.start",
    });
    await expect(mocks.handle!(request("task.stop"), context)).resolves.toEqual({
      operation: "task.stop",
    });
    for (const operation of ["task.list", "task.status", "task.wait", "task.steer"]) {
      await expect(mocks.handle!(request(operation), context)).resolves.toEqual({
        operation,
      });
    }

    await brokers.dispose();
    await brokers.dispose();
    expect(mocks.order).toEqual(["mcp", "broker", "broker:dispose", "mcp:dispose"]);
    expect(mocks.resolveCapability?.("session-1", 3)).toBeUndefined();
    await expect(brokers.start()).resolves.toBeUndefined();

    const neverStarted = new PiRuntimeBrokers({
      runtimeDir: "/tmp/piwork-runtime-test",
      sessionId: "session-2",
      generation: 1,
      mode: "agent",
    });
    await neverStarted.dispose();
    await expect(neverStarted.start()).rejects.toThrow(/disposed/);
  });
});
