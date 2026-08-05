import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserIncomingMessage,
  HistorySnapshotEvent,
  ReplayableBrowserIncomingMessage,
} from "../shared/pi-browser-protocol.js";
import { handleSessionAck, handleSessionSubscribe } from "./ws-bridge-browser.js";
import type { BrowserSocketData, Session } from "./ws-bridge-types.js";

function socket(): ServerWebSocket<BrowserSocketData> {
  return {
    data: {
      kind: "browser",
      sessionId: "session-1",
      protocolVersion: 1,
      contextEpoch: 1,
      contextId: "0123456789abcdef0123456789abcdef",
      subscribed: false,
      lastAckSeq: 0,
    },
  } as ServerWebSocket<BrowserSocketData>;
}

function session(
  value: Partial<Pick<Session, "eventBuffer" | "nextEventSeq" | "lastAckSeq">> = {},
): Session {
  const current = socket();
  return {
    id: "session-1",
    browserSockets: new Set([current]),
    eventBuffer: [],
    nextEventSeq: 1,
    lastAckSeq: 0,
    state: {
      runState: "ready",
      generation: 4,
      usage: { inputTokens: 10, outputTokens: 3 },
    },
    ...value,
  } as unknown as Session;
}

function history(reason: HistorySnapshotEvent["reason"]): HistorySnapshotEvent {
  return {
    type: "history_snapshot",
    reason,
    generation: 4,
    entries: [],
    total: 0,
    cursor: 0,
    nextCursor: 0,
    hasMore: false,
  };
}

describe("Pi browser replay subscription", () => {
  it("ignores missing and detached sockets without mutating subscription state", async () => {
    const value = session();
    const detached = socket();
    const send = vi.fn();
    const loadHistory = vi.fn(async (reason) => history(reason));
    await handleSessionSubscribe(value, undefined, 0, send, loadHistory, () => false);
    await handleSessionSubscribe(value, detached, 0, send, loadHistory, () => false);
    expect(detached.data.subscribed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("loads initial history, replays only transient frames, and publishes authoritative run state", async () => {
    const current = socket();
    const value = session({
      eventBuffer: [
        {
          seq: 1,
          message: {
            type: "agent_message",
            generation: 4,
            message: {
              id: "message-1",
              role: "assistant",
              content: [{ type: "text", text: "persisted in Pi" }],
              timestamp: 1,
            },
          },
        },
        {
          seq: 2,
          message: {
            type: "run_state",
            state: "running",
            generation: 4,
            timestamp: 2,
          },
        },
      ],
      nextEventSeq: 3,
    });
    value.browserSockets = new Set([current]);
    const sent: BrowserIncomingMessage[] = [];
    const send = vi.fn((_socket, message: BrowserIncomingMessage) => {
      sent.push(message);
    });
    const loadHistory = vi.fn(async (reason) => history(reason));
    const isHistoryBacked = (message: ReplayableBrowserIncomingMessage) =>
      message.type === "agent_message";

    await handleSessionSubscribe(value, current, 0, send, loadHistory, isHistoryBacked);

    expect(current.data).toMatchObject({ subscribed: true, lastAckSeq: 0 });
    expect(loadHistory).toHaveBeenCalledWith("initial");
    expect(sent).toEqual([
      history("initial"),
      {
        type: "event_replay",
        events: [value.eventBuffer[1]],
      },
      expect.objectContaining({
        type: "run_state",
        state: "ready",
        generation: 4,
        usage: value.state.usage,
      }),
    ]);
  });

  it("recovers an ack gap, reports unavailable history, and preserves transient replay", async () => {
    const current = socket();
    const value = session({
      eventBuffer: [
        {
          seq: 5,
          message: {
            type: "tool_execution",
            generation: 4,
            toolCallId: "tool-1",
            toolName: "read",
            status: "running",
            timestamp: 5,
          },
        },
      ],
      nextEventSeq: 6,
    });
    value.browserSockets = new Set([current]);
    const sent: BrowserIncomingMessage[] = [];
    const send = vi.fn((_socket, message: BrowserIncomingMessage) => {
      sent.push(message);
    });
    const loadHistory = vi.fn(async () => {
      throw new Error("history file changed");
    });

    await handleSessionSubscribe(value, current, 2, send, loadHistory, () => false);

    expect(loadHistory).toHaveBeenCalledWith("gap");
    expect(sent[0]).toEqual({
      type: "error",
      code: "pi_history_unavailable",
      message: "Pi session history is unavailable.",
      retryable: true,
    });
    expect(sent[1]).toEqual({ type: "event_replay", events: value.eventBuffer });
    expect(sent[2]).toMatchObject({ type: "run_state", state: "ready", generation: 4 });
  });

  it("uses history recovery when the replay buffer is empty and reconciles a current ack", async () => {
    const current = socket();
    const value = session({ eventBuffer: [], nextEventSeq: 8 });
    value.browserSockets = new Set([current]);
    const send = vi.fn();
    const loadHistory = vi.fn(async (reason) => history(reason));
    await handleSessionSubscribe(value, current, 3, send, loadHistory, () => false);
    expect(loadHistory).toHaveBeenCalledWith("recovery");
    expect(send).toHaveBeenLastCalledWith(
      current,
      expect.objectContaining({ type: "run_state", generation: 4 }),
    );

    value.eventBuffer = [
      {
        seq: 7,
        message: {
          type: "run_state",
          state: "ready",
          generation: 4,
          timestamp: 7,
        },
      },
    ];
    send.mockClear();
    loadHistory.mockClear();
    await handleSessionSubscribe(value, current, 7, send, loadHistory, () => false);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      current,
      expect.objectContaining({ type: "run_state", generation: 4 }),
    );
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("recovers when the browser cursor is ahead of a restarted server", async () => {
    const current = socket();
    const value = session({
      eventBuffer: [
        {
          seq: 1,
          message: {
            type: "run_state",
            state: "running",
            generation: 4,
            timestamp: 1,
          },
        },
      ],
      nextEventSeq: 2,
    });
    value.browserSockets = new Set([current]);
    const sent: BrowserIncomingMessage[] = [];
    const send = vi.fn((_socket, message: BrowserIncomingMessage) => {
      sent.push(message);
    });
    const loadHistory = vi.fn(async (reason) => history(reason));

    await handleSessionSubscribe(value, current, 500, send, loadHistory, () => false);

    expect(current.data.lastAckSeq).toBe(0);
    expect(loadHistory).toHaveBeenCalledWith("recovery");
    expect(sent).toEqual([
      history("recovery"),
      { type: "event_replay", events: value.eventBuffer },
      expect.objectContaining({ type: "run_state", generation: 4 }),
    ]);
  });

  it("advances attached socket and session acknowledgements monotonically", () => {
    const current = socket();
    const value = session({ lastAckSeq: 3 });
    value.browserSockets = new Set([current]);
    current.data.lastAckSeq = 4;
    handleSessionAck(value, current, 9.8);
    expect(current.data.lastAckSeq).toBe(9);
    expect(value.lastAckSeq).toBe(9);

    handleSessionAck(value, current, -10);
    expect(current.data.lastAckSeq).toBe(9);
    expect(value.lastAckSeq).toBe(9);

    const detached = socket();
    handleSessionAck(value, detached, 12);
    expect(detached.data.lastAckSeq).toBe(0);
    expect(value.lastAckSeq).toBe(12);
  });
});
