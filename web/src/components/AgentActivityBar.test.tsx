// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { useStore } from "../store.js";
import { AgentActivityBar } from "./AgentActivityBar.js";

const SESSION_ID = "activity-session";

function connectAndRun(): void {
  const store = useStore.getState();
  store.setAgentActivityConnection(SESSION_ID, "connected");
  store.projectAgentActivity(SESSION_ID, {
    type: "run_state",
    generation: 1,
    state: "running",
    timestamp: 1,
  });
}

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().setUiLanguage("zh-CN");
});

describe("AgentActivityBar", () => {
  it("shows high-signal work and progressively discloses delegated and queued detail", () => {
    const store = useStore.getState();
    connectAndRun();
    store.upsertToolActivity(SESSION_ID, {
      toolCallId: "read-1",
      toolName: "read",
      status: "running",
      preview: "docs/brief.md",
      input: { path: "docs/brief.md" },
      startedAt: 1,
      elapsedSeconds: 2,
    });
    store.upsertProcess(SESSION_ID, {
      taskId: "task-1",
      toolCallId: "task-call-1",
      name: "资料核对",
      description: "核对来源",
      execution: "background",
      depth: 1,
      status: "running",
      startedAt: 1,
      progress: "正在查阅",
    });
    store.projectAgentActivity(SESSION_ID, {
      type: "pi_queue",
      generation: 1,
      steering: ["优先完成摘要"],
      followUp: ["再核对格式"],
      timestamp: 2,
    });

    render(<AgentActivityBar sessionId={SESSION_ID} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在工作");
    expect(screen.getByText("docs/brief.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开 Agent 活动" }));
    expect(screen.getByText("委派工作")).toBeInTheDocument();
    expect(screen.getByText("优先完成摘要")).toBeInTheDocument();
    expect(screen.getByText("再核对格式")).toBeInTheDocument();
  });

  it("renders reviewable artifacts in both UI languages", () => {
    const store = useStore.getState();
    connectAndRun();
    store.projectAgentActivity(SESSION_ID, {
      type: "run_state",
      generation: 1,
      state: "settling",
      timestamp: 2,
    });
    store.projectAgentActivity(SESSION_ID, {
      type: "run_state",
      generation: 1,
      state: "ready",
      timestamp: 3,
    });
    store.upsertToolActivity(SESSION_ID, {
      toolCallId: "write-1",
      toolName: "write",
      status: "completed",
      preview: "reports/summary.md",
      input: { path: "reports/summary.md", content: "summary" },
      startedAt: 1,
      completedAt: 3,
      elapsedSeconds: 2,
    });

    render(<AgentActivityBar sessionId={SESSION_ID} />);
    expect(screen.getByRole("status")).toHaveTextContent("可供审阅");

    act(() => useStore.getState().setUiLanguage("en-US"));
    expect(screen.getByRole("status")).toHaveTextContent("Ready to review");
    fireEvent.click(screen.getByRole("button", { name: "Expand Agent activity" }));
    expect(screen.getByText("Outputs")).toBeInTheDocument();
    expect(screen.getByText("reports/summary.md")).toBeInTheDocument();
  });

  it("scopes outputs and review readiness to the latest run", () => {
    const store = useStore.getState();
    connectAndRun();
    store.upsertToolActivity(SESSION_ID, {
      toolCallId: "write-old",
      toolName: "write",
      status: "completed",
      preview: "reports/old.md",
      input: { path: "reports/old.md" },
      startedAt: 1,
      completedAt: 2,
      elapsedSeconds: 1,
    });
    store.projectAgentActivity(SESSION_ID, {
      type: "run_state",
      generation: 1,
      state: "ready",
      timestamp: 3,
    });
    store.projectAgentActivity(SESSION_ID, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 10,
    });

    render(<AgentActivityBar sessionId={SESSION_ID} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在工作");
    expect(screen.queryByText("可供审阅")).not.toBeInTheDocument();
    expect(screen.queryByText("old.md")).not.toBeInTheDocument();
  });

  it("localizes an extension failure without a provider error string", () => {
    const store = useStore.getState();
    store.setAgentActivityConnection(SESSION_ID, "connected");
    store.projectAgentActivity(SESSION_ID, {
      type: "pi_extension_event",
      generation: 1,
      event: "error",
      payload: {},
      timestamp: 1,
    });

    render(<AgentActivityBar sessionId={SESSION_ID} />);
    expect(screen.getByText("Pi 扩展执行失败。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开 Agent 活动" })).not.toBeInTheDocument();
    act(() => useStore.getState().setUiLanguage("en-US"));
    expect(screen.getByText("Pi extension failed.")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    connectAndRun();
    const { container } = render(<AgentActivityBar sessionId={SESSION_ID} />);
    expect((await axe(container)).violations).toEqual([]);
  });
});
