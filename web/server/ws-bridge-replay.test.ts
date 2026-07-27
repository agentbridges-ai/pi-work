import { describe, expect, it, vi } from "vitest";
import { WsBridge } from "./ws-bridge.js";
import {
  isDuplicateClientMessage,
  isHistoryBackedEvent,
  rememberClientMessage,
  sequenceEvent,
  shouldBufferForReplay,
} from "./ws-bridge-replay.js";

function session() {
  return new WsBridge().restoreSession({
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
}

describe("Pi browser replay", () => {
  it("keeps replay state in memory with monotonic sequence numbers", () => {
    const value = session();
    const first = sequenceEvent(
      value,
      {
        type: "run_state",
        state: "ready",
        generation: 1,
        timestamp: 1,
      },
      10,
    );
    const second = sequenceEvent(
      value,
      {
        type: "run_state",
        state: "running",
        generation: 1,
        timestamp: 2,
      },
      10,
    );
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(value.eventBuffer.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("does not buffer init, history snapshots, or replay wrappers", () => {
    const value = session();
    expect(shouldBufferForReplay({ type: "session_init", session: value.state })).toBe(false);
    expect(
      shouldBufferForReplay({
        type: "history_snapshot",
        generation: 1,
        entries: [],
        total: 0,
        cursor: 0,
        nextCursor: 0,
        hasMore: false,
        reason: "initial",
      }),
    ).toBe(false);
    expect(shouldBufferForReplay({ type: "event_replay", events: [] })).toBe(false);
  });

  it("treats only durable Agent messages as JSONL-backed", () => {
    expect(
      isHistoryBackedEvent({
        type: "agent_message",
        generation: 1,
        message: {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      }),
    ).toBe(true);
    expect(
      isHistoryBackedEvent({
        type: "run_state",
        state: "ready",
        generation: 1,
        timestamp: 1,
      }),
    ).toBe(false);
  });

  it("bounds persisted de-duplication ids", () => {
    const value = session();
    const persist = vi.fn();
    rememberClientMessage(value, "m1", 2, persist);
    rememberClientMessage(value, "m2", 2, persist);
    rememberClientMessage(value, "m3", 2, persist);
    expect(value.processedClientMessageIds).toEqual(["m2", "m3"]);
    expect(isDuplicateClientMessage(value, "m1")).toBe(false);
    expect(isDuplicateClientMessage(value, "m3")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(3);
  });
});
