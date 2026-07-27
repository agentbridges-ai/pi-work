import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type { BrowserSocketData } from "./ws-bridge-types.js";
import { WsBridge } from "./ws-bridge.js";
import { broadcastToBrowsers, sendToBrowser } from "./ws-bridge-publish.js";

function session() {
  const bridge = new WsBridge();
  return bridge.restoreSession({
    sessionId: "session-1",
    state: "exited",
    thinkingLevel: "low",
    mode: "agent",
    cwd: "/tmp/session-1/workspace",
    createdAt: 1,
    backendType: "pi",
    transport: "pi-rpc",
    generation: 2,
    piVersion: "0.82.1",
  });
}

function socket(send = vi.fn()) {
  return {
    data: {
      kind: "browser",
      sessionId: "session-1",
      protocolVersion: 1,
      contextEpoch: 4,
      contextId: "0123456789abcdef0123456789abcdef",
    },
    send,
  } as unknown as ServerWebSocket<BrowserSocketData>;
}

describe("Pi browser publish", () => {
  it("sequences broadcasts and wraps them in the runtime context envelope", () => {
    const value = session();
    const ws = socket();
    value.browserSockets.add(ws);
    const sequenced = broadcastToBrowsers(
      value,
      {
        type: "run_state",
        state: "ready",
        generation: 2,
        timestamp: 10,
      },
      { recorder: null },
    );
    expect(sequenced.seq).toBe(1);
    expect(value.eventBuffer).toHaveLength(1);
    const wire = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(wire).toMatchObject({
      protocolVersion: 1,
      contextEpoch: 4,
      contextId: "0123456789abcdef0123456789abcdef",
      kind: "run_state",
      payload: { type: "run_state", state: "ready", seq: 1 },
    });
  });

  it("sends snapshots point-to-point without consuming a sequence", () => {
    const value = session();
    const ws = socket();
    expect(sendToBrowser(ws, { type: "session_init", session: value.state })).toBe(true);
    expect(value.nextEventSeq).toBe(1);
    const wire = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(wire.kind).toBe("session_init");
    expect(wire.payload.seq).toBeUndefined();
  });

  it("drops a socket that fails a broadcast", () => {
    const value = session();
    const ws = socket(
      vi.fn(() => {
        throw new Error("closed");
      }),
    );
    value.browserSockets.add(ws);
    broadcastToBrowsers(
      value,
      {
        type: "run_state",
        state: "ready",
        generation: 2,
        timestamp: 10,
      },
      { recorder: null },
    );
    expect(value.browserSockets.size).toBe(0);
  });
});
