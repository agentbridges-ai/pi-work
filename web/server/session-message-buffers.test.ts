import { describe, expect, it } from "vitest";
import { replayEventBuffer } from "./session-message-buffers.js";
import { WsBridge } from "./ws-bridge.js";

describe("Pi replay buffer", () => {
  it("bounds ephemeral events by count", () => {
    const session = new WsBridge().restoreSession({
      sessionId: "session-1",
      state: "exited",
      thinkingLevel: "off",
      mode: "agent",
      cwd: "/tmp/session-1/workspace",
      createdAt: 1,
      backendType: "pi",
      transport: "pi-rpc",
      generation: 1,
      piVersion: "0.82.1",
    });
    const buffer = replayEventBuffer(session, 2, 100_000);
    for (let seq = 1; seq <= 3; seq++) {
      buffer.append({
        seq,
        message: {
          type: "run_state",
          state: "ready",
          generation: 1,
          timestamp: seq,
        },
      });
    }
    expect(session.eventBuffer.map((event) => event.seq)).toEqual([2, 3]);
  });
});
