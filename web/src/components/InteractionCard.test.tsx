// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import type { InteractionRequest } from "../types.js";
import { setUiCopyLanguage } from "../ui-copy.js";
import { InteractionCard } from "./InteractionCard.js";

const mockSend = vi.hoisted(() => vi.fn((_sessionId: string, _message: unknown) => true));
vi.mock("../ws.js", () => ({
  createClientMessageId: () => "client-1",
  sendToSession: (sessionId: string, message: unknown) => mockSend(sessionId, message),
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

beforeEach(() => {
  setUiCopyLanguage("zh-CN");
  useStore.getState().reset();
  mockSend.mockClear();
});

describe("InteractionCard", () => {
  it("submits single-choice ask responses through interaction_response", () => {
    const interaction: InteractionRequest = {
      id: "ask-1",
      kind: "ask",
      toolCallId: "tool-1",
      questions: [
        {
          id: "question-0",
          header: "Choice",
          question: "Choose one",
          options: [{ id: "a", label: "A" }],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.click(screen.getByRole("radio", { name: /A$/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "interaction_response",
        requestId: "ask-1",
        kind: "ask",
        answers: [
          {
            questionId: "question-0",
            selectedOptionIds: ["a"],
          },
        ],
      }),
    );
  });

  it("submits multi-choice and free-text ask responses", () => {
    const interaction: InteractionRequest = {
      id: "ask-2",
      kind: "ask",
      toolCallId: "tool-2",
      questions: [
        {
          id: "question-0",
          question: "Choose any",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          allowMultiple: true,
          allowFreeText: true,
        },
      ],
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.click(screen.getByRole("checkbox", { name: /A$/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /B$/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Details" } });
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        requestId: "ask-2",
        answers: [
          {
            questionId: "question-0",
            selectedOptionIds: ["a", "b"],
            freeText: "Details",
          },
        ],
      }),
    );
  });

  it("collects a group of questions before submitting once", () => {
    const interaction: InteractionRequest = {
      id: "ask-group",
      kind: "ask",
      toolCallId: "tool-group",
      questions: [
        {
          id: "question-0",
          question: "Choose a style",
          options: [{ id: "style-a", label: "Minimal" }],
          allowMultiple: false,
          allowFreeText: true,
        },
        {
          id: "question-1",
          question: "Choose controls",
          options: [{ id: "control-a", label: "Keyboard" }],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    expect(screen.getByTestId("ask-question-progress").textContent).toContain("1 / 2");
    fireEvent.click(screen.getByRole("radio", { name: /Minimal/ }));
    fireEvent.click(screen.getByRole("button", { name: /下一个问题|Next question/ }));
    expect(screen.getByText("Choose controls")).toBeTruthy();
    expect(screen.getByTestId("ask-question-progress").textContent).toContain("2 / 2");
    fireEvent.click(screen.getByRole("radio", { name: /Keyboard/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        requestId: "ask-group",
        answers: [
          { questionId: "question-0", selectedOptionIds: ["style-a"] },
          { questionId: "question-1", selectedOptionIds: ["control-a"] },
        ],
      }),
    );
  });

  it("renders grouped Ask navigation from the active language catalog", () => {
    const interaction: InteractionRequest = {
      id: "ask-language",
      kind: "ask",
      toolCallId: "tool-language",
      questions: [
        {
          id: "question-0",
          question: "First",
          options: [{ id: "first", label: "First option" }],
          allowMultiple: false,
          allowFreeText: true,
        },
        {
          id: "question-1",
          question: "Second",
          options: [{ id: "second", label: "Second option" }],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    };
    setUiCopyLanguage("en-US");
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    expect(screen.getByRole("button", { name: "Next question" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Other, enter your answer")).toBeTruthy();
  });

  it("supports cancellation and timeout responses", () => {
    const interaction: InteractionRequest = {
      id: "ask-cancel",
      kind: "ask",
      toolCallId: "tool-cancel",
      questions: [
        {
          id: "question-0",
          question: "Cancel?",
          options: [],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    };
    const first = render(
      <InteractionCard interaction={interaction} sessionId="session-1" inline />,
    );
    fireEvent.click(screen.getByRole("button", { name: /忽略问题并中断工具|Ignore the question/ }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ requestId: "ask-cancel", status: "cancelled" }),
    );
    first.unmount();

    mockSend.mockClear();
    vi.useFakeTimers();
    try {
      render(
        <InteractionCard
          interaction={{ ...interaction, id: "ask-timeout", timeoutAt: Date.now() + 1_000 }}
          sessionId="session-1"
          inline
        />,
      );
      act(() => vi.advanceTimersByTime(1_000));
      expect(mockSend).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ requestId: "ask-timeout", status: "timed_out" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits plan execution once and waits for the trusted extension to change mode", () => {
    const interaction: InteractionRequest = {
      id: "plan-1",
      kind: "propose_plan",
      toolCallId: "tool-2",
      plan: "1. Inspect\n2. Implement",
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.click(screen.getByRole("button", { name: /实施此计划|implement this plan/i }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "interaction_response",
        requestId: "plan-1",
        decision: "execute",
      }),
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
  });

  it("keeps a submitted interaction visible until a matching runtime acknowledgement arrives", () => {
    const interaction: InteractionRequest = {
      id: "ask-ack",
      kind: "ask",
      toolCallId: "tool-ack",
      questions: [
        {
          id: "question-0",
          question: "Choose",
          options: [{ id: "yes", label: "Yes" }],
          allowMultiple: false,
          allowFreeText: true,
        },
      ],
    };
    useStore.getState().addInteraction("session-1", interaction);
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.click(screen.getByRole("radio", { name: /Yes$/ }));
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));

    expect(useStore.getState().pendingInteractions.get("session-1")?.has("ask-ack")).toBe(true);
    expect(useStore.getState().interactionSubmissions.get("session-1")?.has("ask-ack")).toBe(true);

    useStore.getState().completeInteraction("session-1", {
      requestId: "ask-ack",
      kind: "ask",
      status: "submitted",
      answers: [{ questionId: "question-0", selectedOptionIds: ["yes"] }],
    });
    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
    expect(useStore.getState().interactionSubmissions.has("session-1")).toBe(false);
  });

  it("updates the default plan title when the mounted UI language changes", () => {
    const interaction: InteractionRequest = {
      id: "plan-language",
      kind: "propose_plan",
      toolCallId: "tool-language",
      plan: "1. Verify language switching",
    };
    setUiCopyLanguage("zh-CN");
    const view = render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    expect(screen.getByRole("region", { name: "执行计划确认" })).toBeTruthy();

    setUiCopyLanguage("en-US");
    view.rerender(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    expect(screen.getByRole("region", { name: "Confirm execution plan" })).toBeTruthy();
  });

  it("continues planning without changing to agent mode", () => {
    const interaction: InteractionRequest = {
      id: "plan-continue",
      kind: "propose_plan",
      toolCallId: "tool-plan",
      plan: "1. Keep planning",
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "interaction_response",
        requestId: "plan-continue",
        decision: "continue_planning",
      }),
    );
    expect(mockSend).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "set_mode" }),
    );
  });

  it("submits plan refinement text without changing mode", () => {
    const interaction: InteractionRequest = {
      id: "plan-refine",
      kind: "propose_plan",
      toolCallId: "tool-refine",
      plan: "1. Draft",
    };
    render(<InteractionCard interaction={interaction} sessionId="session-1" inline />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Add validation" } });
    fireEvent.click(screen.getByRole("button", { name: /提交|Submit/ }));
    expect(mockSend).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        requestId: "plan-refine",
        decision: "refine",
        refinement: "Add validation",
      }),
    );
    expect(mockSend).not.toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "set_mode" }),
    );
  });
});
