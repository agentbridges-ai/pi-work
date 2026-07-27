// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { MessageFeed } from "./MessageFeed.js";

vi.mock("../ws.js", () => ({
  loadSessionHistoryPage: async () => ({
    cursor: 0,
    hasMore: false,
    loaded: true,
    loading: false,
  }),
}));
vi.mock("./use-message-feed-virtualizer.js", () => ({
  useMessageFeedVirtualizer: ({ rows }: { rows: Array<{ key: string }> }) => ({
    beginManualScroll: () => {},
    cancelAnchorRestore: () => {},
    isPinned: true,
    remeasureRowNow: () => {},
    relayoutForGeometry: () => {},
    scrollToEnd: () => {},
    scrollToRowStart: () => {},
    syncScrollState: () => {},
    virtualItems: rows.map((_row, index) => ({ index, key: String(index) })),
    virtualizer: {
      containerRef: () => {},
      measureElement: () => {},
    },
  }),
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

beforeEach(() => useStore.getState().reset());

describe("MessageFeed", () => {
  it("renders the empty conversation state", () => {
    render(<MessageFeed sessionId="session-1" />);
    expect(screen.getByTestId("empty-chat-space")).toBeTruthy();
  });

  it("renders Pi user and assistant messages", () => {
    useStore.getState().setMessages("session-1", [
      { id: "user-1", role: "user", content: "question", timestamp: 1 },
      {
        id: "assistant-1",
        role: "assistant",
        content: "answer",
        contentParts: [{ type: "text", text: "answer" }],
        timestamp: 2,
      },
    ]);
    render(<MessageFeed sessionId="session-1" />);
    expect(screen.getByText("question")).toBeTruthy();
    expect(screen.getByText("answer")).toBeTruthy();
  });

  it("shows compacting state from the Pi run state", () => {
    useStore.getState().setRunState("session-1", "compacting");
    render(<MessageFeed sessionId="session-1" />);
    expect(screen.getByText(/正在整理上下文|Organizing context/)).toBeTruthy();
  });

  it("drops completed and interaction-owned tools from active Pi progress", () => {
    const store = useStore.getState();
    store.setMessages("session-1", [
      {
        id: "assistant-tool",
        role: "assistant",
        content: "done",
        timestamp: 2,
        toolExecutions: [
          {
            type: "tool_execution",
            generation: 1,
            toolCallId: "tool-complete",
            toolName: "read",
            status: "completed",
            timestamp: 2,
            input: { path: "README.md" },
            output: "done",
          },
        ],
      },
    ]);
    store.setToolProgress("session-1", "tool-complete", {
      toolName: "read",
      elapsedSeconds: 1,
    });
    store.setToolProgress("session-1", "tool-ask", {
      toolName: "ask",
      elapsedSeconds: 2,
    });
    store.addInteraction("session-1", {
      id: "ask-1",
      kind: "ask",
      toolCallId: "tool-ask",
      questions: [
        {
          id: "question-0",
          question: "Choose",
          options: [],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    });
    store.setRunActive("session-1", true);

    render(<MessageFeed sessionId="session-1" />);

    expect(screen.getAllByText("done")).toHaveLength(1);
    expect(screen.queryByText(/正在工作|Working/)).toBeNull();
  });

  it("renders a pending Pi plan once in the CCR-style timeline panel", () => {
    const store = useStore.getState();
    const plan = "1. Inspect\n2. Implement";
    store.setMessages("session-1", [
      {
        id: "assistant-plan",
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          {
            type: "tool_execution",
            generation: 1,
            toolCallId: "tool-plan",
            toolName: "propose_plan",
            status: "running",
            timestamp: 2,
            input: { plan },
          },
        ],
      },
    ]);
    store.addInteraction("session-1", {
      id: "plan-request",
      kind: "propose_plan",
      toolCallId: "tool-plan",
      plan,
    });
    store.setRunActive("session-1", true);

    render(<MessageFeed sessionId="session-1" />);

    expect(screen.getAllByTestId("timeline-plan-panel")).toHaveLength(1);
    expect(screen.getByTestId("markdown").textContent).toBe(plan);
  });
});
