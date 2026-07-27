import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../../shared/pi-browser-protocol.js";
import type { Recording } from "../replay.js";
import { ReplayAdapter } from "./replay-adapter.js";

function agentMessage(id: string): BrowserIncomingMessage {
  return {
    type: "agent_message",
    generation: 7,
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text: id }],
      timestamp: 1_000,
    },
  };
}

function makeRecording(browserMessages: BrowserIncomingMessage[], delayMs = 100): Recording {
  return {
    header: {
      _header: true,
      version: 2,
      session_id: "test-session",
      backend_type: "pi",
      transport: "pi-rpc",
      started_at: 1_000,
      cwd: "/test",
    },
    entries: browserMessages.map((message, index) => ({
      ts: 1_000 + index * delayMs,
      dir: "out",
      raw: JSON.stringify(message),
      ch: "browser",
    })),
  };
}

describe("ReplayAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays Pi browser events in order and terminates with run_state stopped", async () => {
    const messages: BrowserIncomingMessage[] = [
      agentMessage("message-1"),
      {
        type: "message_delta",
        generation: 7,
        messageId: "message-2",
        role: "assistant",
        delta: { kind: "text", contentIndex: 0, delta: "hello" },
      },
      {
        type: "tool_execution",
        generation: 7,
        toolCallId: "tool-1",
        toolName: "read",
        status: "completed",
        timestamp: 1_200,
      },
    ];
    const adapter = new ReplayAdapter(makeRecording(messages), Infinity, 7);
    const received: BrowserIncomingMessage[] = [];
    const finished = vi.fn();
    adapter.onBrowserMessage((message) => received.push(message));
    adapter.onFinished(finished);

    adapter.play();
    vi.runAllTimers();

    expect(received.slice(0, -1)).toEqual(messages);
    expect(received.at(-1)).toMatchObject({
      type: "run_state",
      state: "stopped",
      generation: 7,
    });
    expect(finished).toHaveBeenCalledOnce();
    expect(adapter.isActive()).toBe(false);
  });

  it("pauses and resumes without duplicating events", async () => {
    const adapter = new ReplayAdapter(
      makeRecording(
        [agentMessage("message-1"), agentMessage("message-2"), agentMessage("message-3")],
        100,
      ),
      1,
      7,
    );
    const received: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((message) => received.push(message));

    adapter.play();
    vi.advanceTimersByTime(0);
    adapter.pause();
    const pausedAt = received.length;
    vi.advanceTimersByTime(500);
    expect(received).toHaveLength(pausedAt);

    adapter.play();
    vi.runAllTimers();
    expect(received.filter((message) => message.type === "agent_message")).toHaveLength(3);
  });

  it("applies speed changes to the remaining delay", async () => {
    const adapter = new ReplayAdapter(
      makeRecording([agentMessage("message-1"), agentMessage("message-2")], 1_000),
      1,
      7,
    );
    const received: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((message) => received.push(message));

    adapter.play();
    vi.advanceTimersByTime(0);
    adapter.setSpeed(2);
    vi.advanceTimersByTime(600);

    expect(received.filter((message) => message.type === "agent_message")).toHaveLength(2);
  });

  it("stops an active replay and calls the completion hook once", async () => {
    const adapter = new ReplayAdapter(
      makeRecording([agentMessage("message-1"), agentMessage("message-2")], 5_000),
      1,
      7,
    );
    const finished = vi.fn();
    adapter.onFinished(finished);
    adapter.play();

    adapter.stop();
    adapter.stop();
    vi.runAllTimers();

    expect(adapter.getProgress().state).toBe("finished");
    expect(adapter.isActive()).toBe(false);
    expect(finished).toHaveBeenCalledOnce();
  });

  it("reports progress for empty and completed recordings", async () => {
    const empty = new ReplayAdapter(makeRecording([]), Infinity, 7);
    const received: BrowserIncomingMessage[] = [];
    empty.onBrowserMessage((message) => received.push(message));

    expect(empty.getProgress()).toEqual({
      current: 0,
      total: 0,
      percentComplete: 100,
      state: "idle",
    });
    empty.play();
    vi.runAllTimers();

    expect(empty.getProgress().state).toBe("finished");
    expect(received).toEqual([
      expect.objectContaining({
        type: "run_state",
        state: "stopped",
        generation: 7,
      }),
    ]);
  });

  it("does not duplicate a recorded run_state stopped event", async () => {
    const adapter = new ReplayAdapter(
      makeRecording([
        {
          type: "run_state",
          state: "stopped",
          generation: 7,
          timestamp: 1_000,
        },
      ]),
      Infinity,
      7,
    );
    const received: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((message) => received.push(message));

    adapter.play();
    vi.runAllTimers();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "run_state", state: "stopped" });
  });

  it("skips a malformed recorded browser frame without inventing a legacy event", async () => {
    const recording = makeRecording([agentMessage("message-1")]);
    recording.entries.unshift({
      ts: 900,
      dir: "out",
      raw: "not-json",
      ch: "browser",
    });
    const adapter = new ReplayAdapter(recording, Infinity, 7);
    const received: BrowserIncomingMessage[] = [];
    adapter.onBrowserMessage((message) => received.push(message));

    adapter.play();
    vi.runAllTimers();

    expect(received.map((message) => message.type)).toEqual(["agent_message", "run_state"]);
  });
});
