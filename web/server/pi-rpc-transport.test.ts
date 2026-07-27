import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  PiJsonlFrameError,
  PiRpcRemoteError,
  PiRpcTransport,
  PiRpcTransportError,
  redactPiSensitiveText,
  StrictLfJsonlDecoder,
} from "./pi-rpc-transport.js";

class ProcessEvents extends EventEmitter {}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

function fixture(overrides: Partial<ConstructorParameters<typeof PiRpcTransport>[0]> = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = new ProcessEvents();
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const transport = new PiRpcTransport({
    sessionId: "s1",
    generation: 7,
    stdin,
    stdout,
    stderr,
    process,
    requestTimeoutMs: 100,
    ...overrides,
  });
  return { transport, stdin, stdout, stderr, process, writes };
}

describe("StrictLfJsonlDecoder", () => {
  it("handles fragmented/coalesced LF without splitting U+2028", () => {
    const decoder = new StrictLfJsonlDecoder(1_024);
    expect(decoder.push('{"a":"left')).toEqual([]);
    expect(decoder.push(' right"}\n{"b":2}\n')).toEqual(['{"a":"left right"}', '{"b":2}']);
    decoder.end();
  });

  it("rejects CRLF, empty, over-limit, invalid UTF-8, and unterminated frames", () => {
    expect(() => new StrictLfJsonlDecoder().push("{}\r\n")).toThrow(/does not accept CRLF/);
    expect(() => new StrictLfJsonlDecoder().push("\n")).toThrow(PiJsonlFrameError);
    expect(() => new StrictLfJsonlDecoder(3).push("1234")).toThrow(/byte limit/);
    expect(() => new StrictLfJsonlDecoder().push(Buffer.from([0xff, 0x0a]))).toThrow(/UTF-8/);
    const decoder = new StrictLfJsonlDecoder();
    decoder.push("{}");
    expect(() => decoder.end()).toThrow(/unterminated/);
  });

  it("rejects invalid limits, ignores empty chunks, and seals on end", () => {
    expect(() => new StrictLfJsonlDecoder(0)).toThrow(/positive safe integer/);
    expect(() => new StrictLfJsonlDecoder(Number.NaN)).toThrow(/positive safe integer/);
    const decoder = new StrictLfJsonlDecoder(4);
    expect(decoder.push("")).toEqual([]);
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.push("{}\n")).toEqual(["{}"]);
    decoder.end();
    decoder.end();
    expect(() => decoder.push("{}\n")).toThrow(/stream ended/);
    expect(() => new StrictLfJsonlDecoder(2).push("123\n")).toThrow(/byte limit/);
  });
});

describe("PiRpcTransport", () => {
  it("observes only validated inbound frames and successfully written outbound frames", async () => {
    const onFrame = vi.fn();
    const { transport, stdout } = fixture({ observer: { onFrame } });

    await transport.sendInput({ type: "abort" });
    expect(onFrame).toHaveBeenCalledWith(
      {
        direction: "out",
        raw: '{"type":"abort"}',
        value: { type: "abort" },
      },
      { sessionId: "s1", generation: 7 },
    );

    stdout.write('{"type":"agent_');
    expect(onFrame).toHaveBeenCalledTimes(1);
    stdout.write('start"}\n{"type":"agent_start"}\n');
    await eventually(() => expect(onFrame).toHaveBeenCalledTimes(3));
    expect(onFrame.mock.calls.slice(1)).toEqual([
      [
        {
          direction: "in",
          raw: '{"type":"agent_start"}',
          value: { type: "agent_start" },
        },
        { sessionId: "s1", generation: 7 },
      ],
      [
        {
          direction: "in",
          raw: '{"type":"agent_start"}',
          value: { type: "agent_start" },
        },
        { sessionId: "s1", generation: 7 },
      ],
    ]);
    transport.dispose();

    const invalidFrame = vi.fn();
    const malformed = fixture({ observer: { onFrame: invalidFrame } });
    malformed.stdout.write('{"type":"not_pi"}\n');
    await malformed.transport.waitForClose();
    expect(invalidFrame).not.toHaveBeenCalled();
  });

  it("correlates out-of-order responses and forwards notifications", async () => {
    const onNotification = vi.fn();
    const { transport, stdout, writes } = fixture({ onNotification });
    const first = transport.getState();
    const second = transport.getAvailableModels();
    await eventually(() => expect(writes).toHaveLength(2));
    const firstId = JSON.parse(writes[0]!).id;
    const secondId = JSON.parse(writes[1]!).id;
    stdout.write('{"type":"agent_start"}\n');
    stdout.write(
      `${JSON.stringify({
        id: secondId,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "p", id: "m" }] },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        id: firstId,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "pi",
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      })}\n`,
    );
    await expect(second).resolves.toEqual([{ provider: "p", id: "m" }]);
    await expect(first).resolves.toMatchObject({ sessionId: "pi" });
    expect(onNotification).toHaveBeenCalledWith(
      { type: "agent_start" },
      { sessionId: "s1", generation: 7 },
    );
    transport.dispose();
  });

  it("times out, classifies a late response, and does not corrupt another request", async () => {
    const onLateResponse = vi.fn();
    const { transport, stdout, writes } = fixture({
      requestTimeoutMs: 10,
      onLateResponse,
    });
    const request = transport.getAvailableModels();
    await eventually(() => expect(writes).toHaveLength(1));
    const id = JSON.parse(writes[0]!).id;
    await expect(request).rejects.toMatchObject({ code: "request_timeout" });
    stdout.write(
      `${JSON.stringify({
        id,
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [] },
      })}\n`,
    );
    await eventually(() => expect(onLateResponse).toHaveBeenCalledTimes(1));
    transport.dispose();
  });

  it("cleans all pending requests on child exit and stdout EOF", async () => {
    const first = fixture();
    const pending = first.transport.getState();
    first.process.emit("exit", 1, null);
    await expect(pending).rejects.toMatchObject({ code: "child_exit" });
    expect(first.transport.pendingRequestCount).toBe(0);

    const second = fixture();
    const other = second.transport.getState();
    second.stdout.end();
    await expect(other).rejects.toMatchObject({ code: "stdout_eof" });
  });

  it("fails closed for stale generations and malformed output", async () => {
    const stale = fixture({ isGenerationCurrent: () => false });
    await expect(stale.transport.getState()).rejects.toMatchObject({
      code: "stale_generation",
    });

    const malformed = fixture();
    const request = malformed.transport.getState();
    malformed.stdout.write('{"type":"claude"}\n');
    await expect(request).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("supports AbortSignal and optionally sends a remote abort", async () => {
    const { transport, writes } = fixture();
    const controller = new AbortController();
    const request = transport.request(
      { type: "get_state" },
      { signal: controller.signal, abortRemoteOnSignal: true },
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "aborted" });
    await eventually(() =>
      expect(writes.some((line) => JSON.parse(line).type === "abort")).toBe(true),
    );
    transport.dispose();
  });

  it("rejects an already-aborted request without writing or leaving pending state", async () => {
    const { transport, writes } = fixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request({ type: "get_state" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(writes).toEqual([]);
    expect(transport.pendingRequestCount).toBe(0);
    transport.dispose();
  });

  it("does not write a request that times out behind backpressure", async () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const writes: string[] = [];
    const stdin = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        writes.push(chunk.toString("utf8"));
        callbacks.push(done);
      },
    });
    const transport = new PiRpcTransport({
      sessionId: "s",
      generation: 1,
      stdin,
      stdout: new PassThrough(),
      requestTimeoutMs: 10,
    });

    const blockingWrite = transport.sendInput({ type: "abort" });
    await eventually(() => expect(writes).toHaveLength(1));
    const timedOut = transport.getState();
    await expect(timedOut).rejects.toMatchObject({ code: "request_timeout" });

    callbacks.shift()?.();
    stdin.emit("drain");
    await expect(blockingWrite).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes.map((line) => JSON.parse(line).type)).toEqual(["abort"]);
    transport.dispose();
  });

  it("waits for write callback and drain backpressure", async () => {
    let callback: ((error?: Error | null) => void) | undefined;
    const stdin = new Writable({
      write(_chunk, _encoding, done) {
        callback = done;
      },
      highWaterMark: 1,
    });
    const stdout = new PassThrough();
    const onFrame = vi.fn();
    const transport = new PiRpcTransport({
      sessionId: "s",
      generation: 1,
      stdin,
      stdout,
      requestTimeoutMs: 1_000,
      observer: { onFrame },
    });
    const sending = transport.sendInput({ type: "abort" });
    let settled = false;
    void sending.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
    callback?.();
    stdin.emit("drain");
    await expect(sending).resolves.toBeUndefined();
    expect(onFrame).toHaveBeenCalledOnce();
    transport.dispose();
  });

  it("bounds and redacts stderr without placing it in lifecycle errors", async () => {
    const secret = "sk-super-secret";
    const { transport, stderr, process } = fixture({
      maxStderrBytes: 48,
      sensitiveValues: [secret],
    });
    stderr.write(`api_key=${secret} ${"x".repeat(100)}`);
    const closed = transport.waitForClose();
    process.emit("exit", 9, null);
    const error = await closed;
    expect(transport.getStderr()).not.toContain(secret);
    expect(Buffer.byteLength(transport.getStderr())).toBeLessThanOrEqual(48);
    expect(error.message).not.toContain(secret);
    expect(error).toBeInstanceOf(PiRpcTransportError);
  });

  it("validates constructor limits and redacts common credential forms", () => {
    const streams = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    };
    expect(() => new PiRpcTransport({ sessionId: "", generation: 1, ...streams })).toThrow(
      /sessionId/,
    );
    expect(() => new PiRpcTransport({ sessionId: "s", generation: -1, ...streams })).toThrow(
      /generation/,
    );
    for (const option of [
      { requestTimeoutMs: 0 },
      { maxFrameBytes: 0 },
      { maxStderrBytes: Number.NaN },
    ]) {
      expect(
        () => new PiRpcTransport({ sessionId: "s", generation: 1, ...streams, ...option }),
      ).toThrow(/positive safe integer/);
    }
    expect(
      redactPiSensitiveText("Bearer abc api_key=visible password:guess sk-12345678 literal.a+b", [
        "literal.a+b",
      ]),
    ).toBe("Bearer [REDACTED] api_key=[REDACTED] password:[REDACTED] [REDACTED] [REDACTED]");
  });

  it("exercises every typed command helper and preserves correlated results", async () => {
    const { transport, stdout, writes } = fixture({ requestTimeoutMs: 1_000 });
    const operations = [
      transport.prompt("hello", {
        images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        streamingBehavior: "steer",
      }),
      transport.steer("steer"),
      transport.followUp("follow"),
      transport.abort(),
      transport.getState(),
      transport.getAvailableModels(),
      transport.setModel("openai", "gpt-5"),
      transport.setThinkingLevel("high"),
      transport.getAvailableThinkingLevels(),
      transport.compact("shorten"),
      transport.setAutoRetry(false),
      transport.retry(),
      transport.abortRetry(),
      transport.getEntries("entry-1"),
      transport.replayHistory(),
      transport.getMessages(),
      transport.getCommands(),
      transport.getSessionStats(),
    ];
    await eventually(() => expect(writes).toHaveLength(operations.length));

    const dataFor = (type: string): unknown => {
      switch (type) {
        case "get_state":
          return {
            sessionId: "pi",
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "all",
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        case "get_available_models":
          return { models: [{ provider: "openai", id: "gpt-5" }] };
        case "set_model":
          return { provider: "openai", id: "gpt-5" };
        case "get_available_thinking_levels":
          return { levels: ["off", "high"] };
        case "compact":
          return { compacted: true };
        case "get_entries":
          return { entries: [], leafId: null };
        case "get_messages":
          return { messages: [{ role: "user" }] };
        case "get_commands":
          return { commands: [{ name: "piwork-plan" }] };
        case "get_session_stats":
          return { tokens: 1 };
        default:
          return undefined;
      }
    };
    for (const line of writes) {
      const command = JSON.parse(line) as { id: string; type: string };
      const data = dataFor(command.type);
      stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          ...(data === undefined ? {} : { data }),
        })}\n`,
      );
    }

    const results = await Promise.all(operations);
    expect(results[4]).toMatchObject({ sessionId: "pi" });
    expect(results[5]).toEqual([{ provider: "openai", id: "gpt-5" }]);
    expect(results[6]).toEqual({ provider: "openai", id: "gpt-5" });
    expect(results[8]).toEqual(["off", "high"]);
    expect(results[9]).toEqual({ compacted: true });
    expect(results[13]).toEqual({ entries: [], leafId: null });
    expect(results[15]).toEqual([{ role: "user" }]);
    expect(results[16]).toEqual([{ name: "piwork-plan" }]);
    expect(results[17]).toEqual({ tokens: 1 });
    transport.dispose();
  });

  it("rejects duplicate ids, mismatched responses, and redacted remote failures", async () => {
    const secret = "sk-remote-secret";
    const remote = fixture({ sensitiveValues: [secret] });
    const failed = remote.transport.getState();
    await eventually(() => expect(remote.writes).toHaveLength(1));
    const failedId = JSON.parse(remote.writes[0]!).id;
    remote.stdout.write(
      `${JSON.stringify({
        id: failedId,
        type: "response",
        command: "get_state",
        success: false,
        error: `provider rejected ${secret}`,
      })}\n`,
    );
    const failure = await failed.catch((error) => error);
    expect(failure).toBeInstanceOf(PiRpcRemoteError);
    expect(failure.message).toBe("provider rejected [REDACTED]");
    remote.transport.dispose();

    const duplicate = fixture();
    const first = duplicate.transport.request({ id: "same", type: "get_state" });
    await expect(
      duplicate.transport.request({ id: "same", type: "get_state" }),
    ).rejects.toMatchObject({ code: "protocol_error" });
    duplicate.stdout.write(
      '{"id":"same","type":"response","command":"get_commands","success":true,"data":{"commands":[]}}\n',
    );
    await expect(first).rejects.toMatchObject({ code: "protocol_error" });

    const uncorrelated = fixture();
    uncorrelated.stdout.write(
      '{"type":"response","command":"get_state","success":true,"data":{"sessionId":"pi","thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}\n',
    );
    await expect(uncorrelated.transport.waitForClose()).resolves.toMatchObject({
      code: "protocol_error",
    });
  });

  it("closes on process and stream failures and invalidates generations", async () => {
    const lifecycle = vi.fn();
    const childError = fixture({ onLifecycle: lifecycle });
    childError.process.emit("error", new Error("spawn failed"));
    await expect(childError.transport.waitForClose()).resolves.toMatchObject({
      code: "child_error",
    });

    const stdoutError = fixture();
    stdoutError.stdout.emit("error", new Error("read failed"));
    await expect(stdoutError.transport.waitForClose()).resolves.toMatchObject({ code: "closed" });

    const stdinError = fixture();
    stdinError.stdin.emit("error", new Error("write failed"));
    await expect(stdinError.transport.waitForClose()).resolves.toMatchObject({
      code: "write_failed",
    });

    const stale = fixture();
    stale.transport.invalidateGeneration();
    expect(stale.transport.isClosed).toBe(true);
    await expect(
      stale.transport.sendExtensionUiResponse({
        type: "extension_ui_response",
        id: "ui",
        cancelled: true,
      }),
    ).rejects.toMatchObject({ code: "stale_generation" });
  });
});
