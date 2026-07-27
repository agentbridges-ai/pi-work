// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import type { PiSessionInfo } from "../types.js";
import { useSessionMenuMessageTimes } from "./use-session-menu-message-times.js";

const focusedSessions: PiSessionInfo[] = [
  {
    sessionId: "focused-session",
    state: "connected",
    backendType: "pi",
    transport: "pi-rpc",
    cwd: "/workspace",
    createdAt: 100,
  },
];

function MessageTimesProbe({ onRender }: { onRender: () => void }) {
  const times = useSessionMenuMessageTimes(focusedSessions, true);
  onRender();
  return <output>{times["focused-session"]}</output>;
}

beforeEach(() => {
  useStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useSessionMenuMessageTimes", () => {
  it("causes zero parent updates for twenty background streaming message changes", async () => {
    const onRender = vi.fn();
    render(<MessageTimesProbe onRender={onRender} />);
    expect(onRender).toHaveBeenCalledTimes(1);

    for (let index = 1; index <= 20; index += 1) {
      await act(async () => {
        useStore.getState().setMessages("background-session", [
          {
            id: "stream-background",
            role: "assistant",
            content: "x".repeat(index),
            timestamp: 1_000,
            isStreaming: true,
            streamingPhase: "text",
          },
        ]);
        await Promise.resolve();
      });
    }

    expect(onRender).toHaveBeenCalledTimes(1);

    await act(async () => {
      useStore.getState().setMessages("focused-session", [
        {
          id: "focused-message",
          role: "assistant",
          content: "current",
          timestamp: 2_000,
        },
      ]);
      await Promise.resolve();
    });
    expect(onRender).toHaveBeenCalledTimes(2);
  });
});
