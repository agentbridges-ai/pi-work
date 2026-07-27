import type { ServerWebSocket } from "bun";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { BrowserOutgoingMessage } from "../shared/pi-browser-protocol.js";
import { PiAdapter } from "./pi-adapter.js";
import type { PiReadinessResult } from "./pi-readiness.js";
import type { PiRpcTransport } from "./pi-rpc-transport.js";
import { WsBridge } from "./ws-bridge.js";
import type { BrowserSocketData, SocketData } from "./ws-bridge-types.js";

const browserContext = {
  protocolVersion: 1 as const,
  contextEpoch: 9,
  contextId: "0123456789abcdef0123456789abcdef",
};

function sessionInfo(generation: number) {
  return {
    sessionId: "session-1",
    state: "ready" as const,
    lifecycleState: "enabled" as const,
    model: {
      key: "openai/gpt-5",
      provider: "openai",
      modelId: "gpt-5",
    },
    thinkingLevel: "high" as const,
    mode: "agent" as const,
    cwd: "/tmp/session-1/workspace",
    createdAt: 1,
    backendType: "pi" as const,
    transport: "pi-rpc" as const,
    generation,
    piVersion: "0.82.1" as const,
    piSessionRelativePath: "pi-sessions/session.jsonl",
  };
}

function readiness(): PiReadinessResult {
  return {
    state: {
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionFile: "/tmp/session-1/pi-sessions/session.jsonl",
      sessionId: "session-1",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
    models: [{ provider: "openai", id: "gpt-5" }],
    history: { entries: [], leafId: null },
    commands: [{ name: "piwork-agent" }],
    extension: { version: 1, mode: "agent", mcp: [] },
    mcp: [],
  };
}

function adapter(generation: number) {
  const transport = {
    isClosed: false,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    abortRetry: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({})),
    setModel: vi.fn(async (provider: string, modelId: string) => ({
      provider,
      id: modelId,
    })),
    setThinkingLevel: vi.fn(async () => undefined),
    replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
    sendExtensionUiResponse: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  } as unknown as PiRpcTransport;
  return {
    transport,
    adapter: new PiAdapter({
      transport,
      sessionId: "session-1",
      generation,
    }),
  };
}

function browserSocket() {
  return {
    data: {
      kind: "browser",
      sessionId: "session-1",
      ...browserContext,
    },
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as ServerWebSocket<BrowserSocketData>;
}

function envelope(message: BrowserOutgoingMessage) {
  return JSON.stringify({
    ...browserContext,
    eventId: "event-1",
    kind: message.type,
    payload: message,
  });
}

describe("native Pi bridge contract", () => {
  it("exposes only the strict browser WebSocket socket shape", () => {
    expectTypeOf<SocketData>().toEqualTypeOf<BrowserSocketData>();
    expectTypeOf<SocketData["kind"]>().toEqualTypeOf<"browser">();
    expectTypeOf<SocketData["protocolVersion"]>().toEqualTypeOf<1>();
    expectTypeOf<SocketData["contextEpoch"]>().toEqualTypeOf<number>();
    expectTypeOf<SocketData["contextId"]>().toEqualTypeOf<string>();
    type HasGeneration = "generation" extends keyof SocketData ? true : false;
    type HasCliToken = "cliToken" extends keyof SocketData ? true : false;
    expectTypeOf<HasGeneration>().toEqualTypeOf<false>();
    expectTypeOf<HasCliToken>().toEqualTypeOf<false>();

    const data: SocketData = {
      kind: "browser",
      sessionId: "session-1",
      ...browserContext,
    };
    expect(data).toEqual({
      kind: "browser",
      sessionId: "session-1",
      ...browserContext,
    });
  });

  it("drops late adapter events after a replacement Pi generation attaches", () => {
    const bridge = new WsBridge();
    const oldRuntime = adapter(1);
    const currentRuntime = adapter(2);
    bridge.attachPiAdapter(sessionInfo(1), oldRuntime.adapter, undefined, readiness());
    bridge.attachPiAdapter(sessionInfo(2), currentRuntime.adapter, undefined, readiness());
    const socket = browserSocket();
    bridge.handleBrowserOpen(socket, "session-1");
    const before = (socket.send as ReturnType<typeof vi.fn>).mock.calls.length;

    oldRuntime.adapter.handleNotification({ type: "agent_start" });
    expect(socket.send).toHaveBeenCalledTimes(before);

    currentRuntime.adapter.handleNotification({ type: "agent_start" });
    expect(socket.send).toHaveBeenCalledTimes(before + 1);
    expect(
      JSON.parse((socket.send as ReturnType<typeof vi.fn>).mock.lastCall![0]).payload,
    ).toMatchObject({
      type: "run_state",
      state: "running",
      generation: 2,
    });
  });

  it("rejects stale browser generations before native Pi delivery", () => {
    const bridge = new WsBridge();
    const runtime = adapter(2);
    const session = bridge.attachPiAdapter(sessionInfo(2), runtime.adapter, undefined, readiness());
    const socket = browserSocket();
    bridge.handleBrowserOpen(socket, "session-1");
    bridge.handleBrowserMessage(
      socket,
      envelope({
        type: "agent_message",
        generation: 1,
        clientMsgId: "stale-1",
        message: {
          id: "stale-1",
          role: "user",
          content: [{ type: "text", text: "stale" }],
          timestamp: 2,
        },
      }),
    );

    expect(runtime.transport.prompt).not.toHaveBeenCalled();
    expect(session.processedClientMessageIds).toEqual([]);
    const payloads = (socket.send as ReturnType<typeof vi.fn>).mock.calls.map(([raw]) =>
      JSON.parse(raw as string),
    );
    expect(
      payloads.some(
        ({ payload }) => payload.type === "error" && payload.code === "stale_generation",
      ),
    ).toBe(true);
  });
});
