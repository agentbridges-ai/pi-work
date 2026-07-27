// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FeedDisplayItem } from "./chat-work-groups.js";
import type { ToolActivityEntry } from "../store/tasks-slice.js";
import { uiCopy } from "../ui-copy.js";
import {
  createTimelineRenderContext,
  TimelineEntries,
  type TimelineDisclosureController,
} from "./TimelineFeed.js";

vi.mock("./MessageBubble.js", () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => (
    <div data-testid="message-bubble">{message.content}</div>
  ),
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("./ToolBlock.js", () => ({
  getPreview: (_name: string, input: { path?: string }) => input.path || "",
  getToolLabel: (name: string) => name,
  ToolDetail: ({ name }: { name: string }) => <div data-testid={`tool-${name}`}>{name}</div>,
}));

vi.mock("./TaskStopButton.js", () => ({
  TaskStopButton: ({ taskId }: { taskId: string }) => <button type="button">stop {taskId}</button>,
}));

describe("Pi timeline feed", () => {
  it("renders messages, native work steps, activity and running subagents", () => {
    const execution = {
      type: "tool_execution" as const,
      generation: 3,
      toolCallId: "tool-read",
      toolName: "read",
      status: "running" as const,
      timestamp: 2,
      input: { path: "README.md" },
    };
    const entries: FeedDisplayItem[] = [
      {
        kind: "message",
        msg: { id: "user-1", role: "user", content: "Inspect", timestamp: 1 },
      },
      {
        kind: "work_group",
        id: "work-1",
        firstId: "assistant-work",
        steps: [
          {
            kind: "thinking",
            id: "thinking-1",
            sourceMessageId: "assistant-work",
            text: "Reasoning with Pi",
          },
          {
            kind: "tool",
            id: "tool-read",
            sourceMessageId: "assistant-work",
            toolUseId: "tool-read",
            name: "read",
            input: { path: "README.md" },
            execution,
          },
          {
            kind: "result",
            id: "result-1",
            sourceMessageId: "assistant-work",
            toolUseId: "tool-read",
            name: "read",
            content: "native result",
            isError: false,
          },
        ],
      },
      {
        kind: "subagent",
        taskToolUseId: "task-parent",
        description: "Read-only child",
        status: "running",
        children: [
          {
            kind: "message",
            msg: {
              id: "child-1",
              role: "assistant",
              content: "Child progress",
              timestamp: 3,
              parentToolCallId: "task-parent",
            },
          },
        ],
      },
    ];
    const activity: ToolActivityEntry[] = [
      {
        toolCallId: "tool-read",
        toolName: "read",
        status: "running",
        preview: "Reading README.md",
        startedAt: 1,
        elapsedSeconds: 1,
      },
    ];
    expect(createTimelineRenderContext(entries)).toEqual({ entryCount: 3 });
    render(
      <TimelineEntries
        entries={entries}
        sessionId="session-1"
        toolActivity={activity}
        runningToolIds={new Set(["tool-read"])}
        awaitingToolIds={new Set(["ask-pending"])}
      />,
    );

    expect(screen.getByText("Inspect")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: uiCopy.timeline.thinking }));
    expect(screen.getByText("Reasoning with Pi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "read README.md" }));
    expect(screen.getByTestId("tool-read")).toBeInTheDocument();
    expect(screen.getByText("native result")).toBeInTheDocument();
    expect(screen.getByText("Read-only child")).toBeInTheDocument();
  });

  it("keeps timeline disclosure state controlled by the message feed", () => {
    const disclosureController: TimelineDisclosureController = {
      isOpen: vi.fn((_id, defaultOpen) => defaultOpen),
      onOpenChange: vi.fn(),
    };
    render(
      <TimelineEntries
        entries={[
          {
            kind: "work_group",
            id: "work-1",
            firstId: "assistant-work",
            steps: [
              {
                kind: "thinking",
                id: "thinking-1",
                sourceMessageId: "assistant-work",
                text: "Reasoning with Pi",
              },
            ],
          },
        ]}
        disclosureController={disclosureController}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: uiCopy.timeline.thinking }));
    expect(disclosureController.onOpenChange).toHaveBeenCalledWith("thinking-1", true, false);
  });

  it("renders failed subagent tone with its fallback title", () => {
    render(
      <TimelineEntries
        entries={[
          {
            kind: "subagent",
            taskToolUseId: "task-failed",
            description: "",
            status: "failed",
            children: [],
          },
        ]}
      />,
    );

    expect(screen.getByText(uiCopy.timeline.subagent)).toBeInTheDocument();
  });

  it("keeps completed Ask questions and answers in the timeline rail", () => {
    const review = {
      kind: "ask_user_question_review",
      answers: {
        "Choose a style": "Minimal",
        "Choose the scope": ["Frontend", "Backend"],
      },
      questions: [
        { header: "Style", question: "Choose a style", answer: "Minimal" },
        {
          header: "Scope",
          question: "Choose the scope",
          answer: ["Frontend", "Backend"],
        },
      ],
    };
    render(
      <TimelineEntries
        entries={[
          {
            kind: "message",
            msg: {
              id: "assistant-ask",
              role: "assistant",
              content: "",
              timestamp: 1,
              toolExecutions: [
                {
                  type: "tool_execution",
                  generation: 1,
                  toolCallId: "ask-1",
                  toolName: "ask",
                  status: "completed",
                  timestamp: 2,
                  input: {
                    questions: [
                      { header: "Style", question: "Choose a style" },
                      { header: "Scope", question: "Choose the scope" },
                    ],
                  },
                  output: {
                    content: [{ type: "text", text: JSON.stringify(review) }],
                    details: review,
                  },
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: uiCopy.interaction.askTitle })).toBeInTheDocument();
    expect(screen.getByText("Choose a style")).toBeInTheDocument();
    expect(screen.getByText("Minimal")).toBeInTheDocument();
    expect(screen.getByText("Choose the scope")).toBeInTheDocument();
    expect(screen.getByText("Frontend、Backend")).toBeInTheDocument();
  });

  it("keeps a completed Plan and its approval state in the timeline rail", () => {
    render(
      <TimelineEntries
        entries={[
          {
            kind: "message",
            msg: {
              id: "assistant-plan",
              role: "assistant",
              content: "",
              timestamp: 1,
              toolExecutions: [
                {
                  type: "tool_execution",
                  generation: 1,
                  toolCallId: "plan-1",
                  toolName: "propose_plan",
                  status: "completed",
                  timestamp: 2,
                  input: { plan: "1. Inspect\n2. Implement" },
                  output: {
                    content: [{ type: "text", text: "execute" }],
                    details: { decision: "execute", mode: "agent" },
                  },
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("timeline-plan-panel")).toBeInTheDocument();
    expect(screen.getByText(/1\. Inspect/)).toBeInTheDocument();
    expect(screen.getByText(uiCopy.timeline.approved)).toBeInTheDocument();
  });
});
