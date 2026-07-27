import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock("node:net", () => ({
  createConnection: netMocks.createConnection,
}));

import {
  equalPiBrokerCapability,
  requestPiBroker,
  type PiBrokerRequestOptions,
} from "./pi-broker-client.js";

class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn();
  readonly write = vi.fn((value: Uint8Array | string) => {
    this.writtenReference = value;
    this.writtenFrame = Buffer.from(value);
    return true;
  });
  writtenFrame: Buffer | undefined;
  writtenReference: Uint8Array | string | undefined;
}

const endpoint = {
  socketPath: "/tmp/piwork-pi-broker.sock",
  capability: "broker-capability-secret",
};

function options(overrides: Partial<PiBrokerRequestOptions> = {}): PiBrokerRequestOptions {
  return {
    endpoint,
    sessionId: "session-1",
    generation: 4,
    operation: "task.run",
    payload: { prompt: "inspect" },
    ...overrides,
  };
}

function installSocket(): FakeSocket {
  const socket = new FakeSocket();
  netMocks.createConnection.mockReturnValue(socket);
  return socket;
}

function connectAndReadRequest(socket: FakeSocket): Record<string, unknown> {
  socket.emit("connect");
  expect(socket.writtenFrame?.at(-1)).toBe(0x0a);
  return JSON.parse(socket.writtenFrame!.toString("utf8").trimEnd()) as Record<string, unknown>;
}

function response(request: Record<string, unknown>, value: Record<string, unknown>): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      version: 1,
      id: request.id,
      ...value,
    })}\n`,
    "utf8",
  );
}

beforeEach(() => {
  netMocks.createConnection.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Pi broker client", () => {
  it("compares capabilities without accepting different byte lengths", () => {
    expect(equalPiBrokerCapability("same-capability", "same-capability")).toBe(true);
    expect(equalPiBrokerCapability("same-capability", "other-capability")).toBe(false);
    expect(equalPiBrokerCapability("short", "longer")).toBe(false);
  });

  it.each([
    ["relative socket", { endpoint: { ...endpoint, socketPath: "broker.sock" } }],
    ["oversized socket", { endpoint: { ...endpoint, socketPath: `/${"s".repeat(101)}` } }],
    ["empty capability", { endpoint: { ...endpoint, capability: "" } }],
    ["NUL capability", { endpoint: { ...endpoint, capability: "cap\0secret" } }],
    ["empty session", { sessionId: "" }],
    ["NUL session", { sessionId: "session\0other" }],
    ["negative generation", { generation: -1 }],
    ["fractional generation", { generation: 1.5 }],
    ["empty operation", { operation: "" }],
    ["unsafe operation", { operation: "task/run" }],
  ])("rejects an invalid endpoint binding: %s", (_label, overrides) => {
    expect(() => requestPiBroker(options(overrides))).toThrow(
      expect.objectContaining({
        code: "invalid_endpoint",
        message: "Managed Pi broker endpoint is invalid.",
      }),
    );
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["timeoutMs", 0],
    ["timeoutMs", Number.NaN],
    ["maxFrameBytes", 0],
    ["maxFrameBytes", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("requires a positive safe %s", (field, value) => {
    expect(() => requestPiBroker(options({ [field]: value }))).toThrow(
      new TypeError(`${field} must be a positive safe integer.`),
    );
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("rejects cyclic payloads and request frames over the configured limit", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(requestPiBroker(options({ payload: cyclic }))).rejects.toMatchObject({
      code: "invalid_endpoint",
      message: "Managed Pi broker request is not serializable.",
      cause: expect.any(TypeError),
    });
    await expect(requestPiBroker(options({ maxFrameBytes: 8 }))).rejects.toMatchObject({
      code: "invalid_endpoint",
      message: "Managed Pi broker request exceeds its frame limit.",
    });
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("uses one LF-framed, request-ID-bound exchange with fragmented progress", async () => {
    const socket = installSocket();
    const onProgress = vi.fn();
    const pending = requestPiBroker(options({ onProgress }));
    const request = connectAndReadRequest(socket);

    expect(netMocks.createConnection).toHaveBeenCalledTimes(1);
    expect(netMocks.createConnection).toHaveBeenCalledWith(endpoint.socketPath);
    expect(netMocks.createConnection.mock.calls[0]).toHaveLength(1);
    expect(request).toMatchObject({
      type: "pi_broker_request",
      version: 1,
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      sessionId: "session-1",
      generation: 4,
      capability: endpoint.capability,
      operation: "task.run",
      payload: { prompt: "inspect" },
    });
    expect(socket.writtenFrame!.includes(0x0d)).toBe(false);

    const progress = response(request, {
      type: "pi_broker_progress",
      progress: { completed: 1 },
    });
    const result = response(request, {
      type: "pi_broker_result",
      ok: true,
      value: { accepted: true },
    });
    socket.emit("data", progress.subarray(0, 7));
    socket.emit("data", Buffer.concat([progress.subarray(7), result]));

    await expect(pending).resolves.toEqual({ accepted: true });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ completed: 1 });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect([...(socket.writtenReference as Uint8Array)].every((byte) => byte === 0)).toBe(true);
  });

  it("does not copy shell environment values into the broker request", async () => {
    const socket = installSocket();
    const priorValue = process.env.PIWORK_BROKER_TEST_CANARY;
    process.env.PIWORK_BROKER_TEST_CANARY = "shell-env-secret-canary";
    try {
      const pending = requestPiBroker(options({ payload: undefined }));
      const request = connectAndReadRequest(socket);
      const wire = socket.writtenFrame!.toString("utf8");
      expect(wire).not.toContain("shell-env-secret-canary");
      expect(request).not.toHaveProperty("env");
      socket.emit("data", response(request, { type: "pi_broker_result", ok: true, value: null }));
      await expect(pending).resolves.toBeNull();
    } finally {
      if (priorValue === undefined) delete process.env.PIWORK_BROKER_TEST_CANARY;
      else process.env.PIWORK_BROKER_TEST_CANARY = priorValue;
    }
  });

  it.each([
    ["explicit remote message", "denied", "denied"],
    [
      "non-string remote error",
      { protected: "must-not-be-rendered" },
      "Managed Pi broker operation failed.",
    ],
  ])("maps %s to a bounded remote error", async (_label, remoteError, expectedMessage) => {
    const socket = installSocket();
    const pending = requestPiBroker(options());
    const request = connectAndReadRequest(socket);
    socket.emit(
      "data",
      response(request, {
        type: "pi_broker_result",
        ok: false,
        error: remoteError,
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "remote_error",
      message: expectedMessage,
    });
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["non-object", "null\n", "response binding"],
    ["invalid JSON", "{not-json}\n", "invalid JSON"],
    [
      "wrong version",
      JSON.stringify({ version: 2, id: "ignored", type: "pi_broker_result", ok: true }) + "\n",
      "response binding",
    ],
    [
      "wrong request ID",
      JSON.stringify({ version: 1, id: "wrong", type: "pi_broker_result", ok: true }) + "\n",
      "response binding",
    ],
  ])("rejects %s without exposing the capability", async (_label, wire, expectedMessage) => {
    const socket = installSocket();
    const pending = requestPiBroker(options());
    connectAndReadRequest(socket);
    socket.emit("data", Buffer.from(wire, "utf8"));

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining(expectedMessage),
    });
    expect(String(error)).not.toContain(endpoint.capability);
  });

  it.each([
    [
      "missing type",
      (request: Record<string, unknown>) => ({ version: 1, id: request.id }),
      "response binding",
    ],
    [
      "unknown type",
      (request: Record<string, unknown>) => ({
        version: 1,
        id: request.id,
        type: "pi_broker_other",
      }),
      "response type",
    ],
    [
      "result without ok",
      (request: Record<string, unknown>) => ({
        version: 1,
        id: request.id,
        type: "pi_broker_result",
      }),
      "response type",
    ],
  ])("rejects a response with %s", async (_label, makeValue, expectedMessage) => {
    const socket = installSocket();
    const pending = requestPiBroker(options());
    const request = connectAndReadRequest(socket);
    socket.emit("data", Buffer.from(`${JSON.stringify(makeValue(request))}\n`, "utf8"));

    await expect(pending).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining(expectedMessage),
    });
  });

  it.each([
    ["CRLF records", "{}\r\n"],
    ["oversized records", "x".repeat(513)],
  ])("fails closed on %s", async (_label, wire) => {
    const socket = installSocket();
    const pending = requestPiBroker(options({ maxFrameBytes: 512 }));
    connectAndReadRequest(socket);
    socket.emit("data", Buffer.from(wire, "utf8"));

    await expect(pending).rejects.toMatchObject({
      code: "invalid_response",
      message: "Managed Pi broker framing is invalid.",
      cause: expect.any(Error),
    });
  });

  it("rejects clean and incomplete EOF while clearing the pending request", async () => {
    const cleanSocket = installSocket();
    const cleanPending = requestPiBroker(options());
    connectAndReadRequest(cleanSocket);
    cleanSocket.emit("end");
    await expect(cleanPending).rejects.toMatchObject({
      code: "unavailable",
      message: "Managed Pi broker closed without a final result.",
    });

    const incompleteSocket = installSocket();
    const incompletePending = requestPiBroker(options());
    connectAndReadRequest(incompleteSocket);
    incompleteSocket.emit("data", Buffer.from('{"type":"pi_broker_result"', "utf8"));
    incompleteSocket.emit("end");
    await expect(incompletePending).rejects.toMatchObject({
      code: "invalid_response",
      message: "Managed Pi broker response is incomplete.",
      cause: expect.any(Error),
    });
  });

  it("maps connection failures without reflecting protected endpoint data", async () => {
    const socket = installSocket();
    const pending = requestPiBroker(options());
    const cause = new Error("connect failed");
    socket.emit("error", cause);

    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "Managed Pi broker is unavailable.",
      cause,
    });
    expect(String(error)).not.toContain(endpoint.capability);
    expect(String(error)).not.toContain(endpoint.socketPath);
  });

  it("rejects already-aborted and in-flight requests and clears secret-bearing frames", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(requestPiBroker(options({ signal: alreadyAborted.signal }))).rejects.toMatchObject(
      { code: "aborted" },
    );
    expect(netMocks.createConnection).not.toHaveBeenCalled();

    const socket = installSocket();
    const controller = new AbortController();
    const pending = requestPiBroker(options({ signal: controller.signal }));
    connectAndReadRequest(socket);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "aborted",
      message: "Managed Pi broker request was aborted.",
    });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect([...(socket.writtenReference as Uint8Array)].every((byte) => byte === 0)).toBe(true);
  });

  it("times out, destroys the socket, and ignores late terminal events", async () => {
    vi.useFakeTimers();
    const socket = installSocket();
    const pending = requestPiBroker(options({ timeoutMs: 10 }));
    const request = connectAndReadRequest(socket);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "timeout",
      message: "Managed Pi broker request timed out.",
    });

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(socket.destroy).toHaveBeenCalledOnce();

    socket.emit("data", response(request, { type: "pi_broker_result", ok: true, value: "late" }));
    socket.emit("error", new Error("late"));
    socket.emit("end");
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
