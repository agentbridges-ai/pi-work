// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

describe("MessageBubble Pi projection", () => {
  it("renders user text and native mediaType images", () => {
    const message: ChatMessage = {
      id: "user-1",
      role: "user",
      content: "hello",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
      timestamp: 1,
    };
    render(<MessageBubble message={message} sessionId="session-1" />);
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
  });

  it("renders text and collapsible thinking from Pi content parts", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "answer",
      contentParts: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
      timestamp: 1,
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("reasoning")).toBeTruthy();
  });

  it("renders tool execution status and output", () => {
    const message: ChatMessage = {
      id: "tool:tool-1",
      role: "assistant",
      content: "",
      timestamp: 1,
      toolExecutions: [
        {
          type: "tool_execution",
          generation: 1,
          toolCallId: "tool-1",
          toolName: "read",
          status: "completed",
          timestamp: 1,
          input: { path: "README.md" },
          output: "contents",
        },
      ],
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("contents")).toBeTruthy();
    expect(screen.queryByText(/已完成|Completed/)).toBeNull();
  });
});
