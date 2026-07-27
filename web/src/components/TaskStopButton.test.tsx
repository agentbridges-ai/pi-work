// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskStopButton } from "./TaskStopButton.js";

const send = vi.hoisted(() => vi.fn((_sessionId: string, _message: unknown) => true));
vi.mock("../ws.js", () => ({
  createClientMessageId: () => "client-stop",
  sendToSession: (sessionId: string, message: unknown) => send(sessionId, message),
}));

describe("TaskStopButton", () => {
  it("stops a task only through the Pi browser protocol", () => {
    render(<TaskStopButton sessionId="session-1" taskId="task-1" />);
    fireEvent.click(screen.getByRole("button", { name: /停止任务|Stop task/ }));
    expect(send).toHaveBeenCalledWith("session-1", {
      type: "stop_task",
      taskId: "task-1",
      clientMsgId: "client-stop",
    });
  });
});
