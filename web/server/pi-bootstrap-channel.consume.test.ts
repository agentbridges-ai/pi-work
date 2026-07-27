import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockSocketControl extends EventEmitter {
  readonly writes: Buffer[];
  timeoutMs: number | null;
  destroyed: boolean;
}

type SocketHandler = (socket: MockSocketControl, request: Buffer) => void;

const network = vi.hoisted(() => ({
  handler: null as unknown,
  sockets: [] as unknown[],
}));

vi.mock("node:net", async () => {
  const { EventEmitter: MockEventEmitter } = await import("node:events");

  class MockSocket extends MockEventEmitter {
    readonly writes: Buffer[] = [];
    timeoutMs: number | null = null;
    destroyed = false;

    setTimeout(timeoutMs: number): this {
      this.timeoutMs = timeoutMs;
      return this;
    }

    write(frame: string | Uint8Array): boolean {
      const request = Buffer.from(frame);
      this.writes.push(request);
      (network.handler as SocketHandler | null)?.(this, request);
      return true;
    }

    destroy(): this {
      this.destroyed = true;
      return this;
    }
  }

  return {
    createConnection: () => {
      const socket = new MockSocket();
      network.sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    createServer: vi.fn(),
  };
});

import { consumePiBootstrap, type PiBootstrapPayload } from "./pi-bootstrap-channel.js";

function bootstrapPayload(): PiBootstrapPayload {
  const root = join(tmpdir(), "piwork-bootstrap-consumer");
  return {
    version: 1,
    sessionId: "session-a",
    generation: 4,
    authorizedRoots: [{ path: join(root, "workspace"), access: "write" }],
    mode: "agent",
    providers: [
      {
        name: "managed",
        config: {
          api: "openai-completions",
          apiKey: "sk-consumer-secret",
          models: [{ id: "model-a", name: "Model A" }],
        },
      },
    ],
    managedSkills: [{ path: join(root, "skills", "SKILL.md") }],
    mcp: [
      {
        name: "docs",
        enabled: true,
        status: "connected",
        transport: "sse",
        tools: [{ name: "search", readOnly: true }],
      },
    ],
    taskPolicy: {
      depth: 0,
      maxDepth: 2,
      maxParallel: 4,
      brokerSocket: join(root, "task.sock"),
      capability: "task-secret",
    },
  };
}

function responseFrame(
  overrides: Record<string, unknown> = {},
  payloadOverrides: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: "pi_bootstrap_payload",
      version: 1,
      sessionId: "session-a",
      generation: 4,
      payload: { ...bootstrapPayload(), ...payloadOverrides },
      ...overrides,
    })}\n`,
  );
}

function setHandler(handler: SocketHandler): void {
  network.handler = handler;
}

function latestSocket(): MockSocketControl {
  return network.sockets.at(-1) as MockSocketControl;
}

function consume() {
  return consumePiBootstrap({
    socketPath: join(tmpdir(), "piwork-bootstrap-consume.sock"),
    sessionId: "session-a",
    generation: 4,
    timeoutMs: 50,
  });
}

beforeEach(() => {
  network.handler = null;
  network.sockets.length = 0;
});

describe("Pi bootstrap consumer protocol", () => {
  it("writes only the binding request and accepts one fragmented strict-LF payload", async () => {
    setHandler((socket, request) => {
      expect(request.toString("utf8")).toBe(
        '{"type":"pi_bootstrap_consume","version":1,"sessionId":"session-a","generation":4}\n',
      );
      expect(request.toString("utf8")).not.toContain("sk-consumer-secret");
      const response = responseFrame();
      socket.emit("data", response.subarray(0, 11));
      socket.emit("data", response.subarray(11));
    });

    await expect(consume()).resolves.toMatchObject({
      sessionId: "session-a",
      generation: 4,
      providers: [{ config: { apiKey: "sk-consumer-secret" } }],
    });
    expect(latestSocket().timeoutMs).toBe(50);
    expect(latestSocket().destroyed).toBe(true);
  });

  it.each(["binding_mismatch", "consumed", "expired", "invalid_request", "unavailable"] as const)(
    "maps a remote %s rejection without reflecting secrets",
    async (code) => {
      setHandler((socket) => {
        socket.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              type: "pi_bootstrap_error",
              version: 1,
              code,
            })}\n`,
          ),
        );
      });
      const result = consume();
      await expect(result).rejects.toMatchObject({ code });
      await expect(result).rejects.not.toThrow(/sk-consumer-secret|task-secret/);
    },
  );

  it.each([
    {
      name: "invalid envelope",
      chunks: [Buffer.from('{"type":"unknown","version":1}\n')],
      code: "invalid_payload",
    },
    {
      name: "invalid remote error code",
      chunks: [
        Buffer.from('{"type":"pi_bootstrap_error","version":1,"code":"credential-failure"}\n'),
      ],
      code: "invalid_payload",
    },
    {
      name: "multiple frames",
      chunks: [Buffer.concat([responseFrame(), responseFrame()])],
      code: "invalid_payload",
    },
    {
      name: "CRLF",
      chunks: [Buffer.from('{"type":"pi_bootstrap_error","version":1,"code":"expired"}\r\n')],
      code: "invalid_payload",
    },
    {
      name: "malformed JSON",
      chunks: [Buffer.from("{not-json}\n")],
      code: "invalid_payload",
    },
  ])("rejects a $name response", async ({ chunks, code }) => {
    setHandler((socket) => {
      for (const chunk of chunks) socket.emit("data", chunk);
    });
    await expect(consume()).rejects.toMatchObject({ code });
  });

  it.each([
    {
      name: "outer session",
      response: () => responseFrame({ sessionId: "other" }),
    },
    {
      name: "outer generation",
      response: () => responseFrame({ generation: 5 }),
    },
    {
      name: "payload session",
      response: () => responseFrame({}, { sessionId: "other" }),
    },
    {
      name: "payload generation",
      response: () => responseFrame({}, { generation: 5 }),
    },
  ])("rejects a mismatched $name binding", async ({ response }) => {
    setHandler((socket) => socket.emit("data", response()));
    await expect(consume()).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("rejects an incomplete frame and a clean close without a response", async () => {
    setHandler((socket) => {
      socket.emit("data", Buffer.from('{"type":"pi_bootstrap_payload"'));
      socket.emit("end");
    });
    await expect(consume()).rejects.toMatchObject({ code: "invalid_payload" });

    setHandler((socket) => socket.emit("end"));
    await expect(consume()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cleans up on timeout and connection failure", async () => {
    setHandler((socket) => socket.emit("timeout"));
    await expect(consume()).rejects.toMatchObject({ code: "timeout" });
    expect(latestSocket().destroyed).toBe(true);

    setHandler((socket) => socket.emit("error", new Error("socket unavailable")));
    await expect(consume()).rejects.toMatchObject({ code: "unavailable" });
    expect(latestSocket().destroyed).toBe(true);
  });
});
