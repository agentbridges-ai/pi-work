// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUiCopyLanguage } from "../ui-copy.js";
import { ModelSwitcher } from "./ModelSwitcher.js";

const first = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };
const second = { key: "anthropic/sonnet", provider: "anthropic", modelId: "sonnet" };
const send = vi.hoisted(() => vi.fn((_sessionId: string, _message: unknown) => true));
const getBackendModels = vi.hoisted(() =>
  vi.fn(async (_agentId: string) => [
    {
      model: first,
      label: "GPT-5",
      description: "General",
      thinkingLevels: ["off", "high", "max"],
    },
    {
      model: second,
      label: "Sonnet",
      description: "Balanced",
      thinkingLevels: ["low", "medium"],
    },
  ]),
);

const state = {
  runtimeSessions: [
    {
      sessionId: "session-1",
      state: "connected",
      transport: "pi-rpc",
      cwd: "/workspace",
      createdAt: 1,
      backendType: "pi",
      model: first,
      thinkingLevel: "high",
      mode: "agent",
    },
  ],
  sessions: new Map(),
  selectedAgentId: "agent",
  updateSession: vi.fn(),
  setRuntimeSessions: vi.fn(),
};

vi.mock("../store.js", () => {
  const useStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { useStore };
});
vi.mock("../api.js", () => ({
  api: { getBackendModels: (agentId: string) => getBackendModels(agentId) },
}));
vi.mock("../ws.js", () => ({
  createClientMessageId: () => "client-1",
  sendToSession: (sessionId: string, message: unknown) => send(sessionId, message),
}));

beforeEach(() => {
  setUiCopyLanguage("zh-CN");
  send.mockClear();
  getBackendModels.mockClear();
  state.updateSession.mockClear();
  state.setRuntimeSessions.mockClear();
});

describe("ModelSwitcher", () => {
  it("probes models by agent id and sends a complete PiModelRef", async () => {
    render(<ModelSwitcher sessionId="session-1" />);
    expect(getBackendModels).toHaveBeenCalledWith("agent");
    fireEvent.click(screen.getByRole("button", { name: /切换模型|Switch model/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Sonnet/ }));
    expect(send).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "set_model", model: second }),
    );
  });

  it("switches only among thinking levels allowed for the selected model", async () => {
    render(<ModelSwitcher sessionId="session-1" />);
    fireEvent.click(screen.getByRole("button", { name: /切换模型|Switch model/ }));
    const slider = await screen.findByRole("slider", { name: "推理强度" });
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("2");
    expect(screen.getByText("关闭")).toBeTruthy();
    expect(screen.getByText("最大")).toBeTruthy();
    expect(screen.queryByText("中")).toBeNull();
    fireEvent.change(slider, { target: { value: "0" } });
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ type: "set_thinking_level", thinkingLevel: "off" }),
      ),
    );
  });

  it("renders localized thinking controls in English", async () => {
    setUiCopyLanguage("en-US");
    render(<ModelSwitcher sessionId="session-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    expect(await screen.findByRole("slider", { name: "Reasoning effort" })).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByText("Maximum")).toBeTruthy();
  });
});
