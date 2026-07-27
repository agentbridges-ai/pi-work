// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../types.js";
import { useStore } from "../store.js";
import { Composer } from "./Composer.js";

const send = vi.hoisted(() => vi.fn((_sessionId: string, _message: unknown) => true));
vi.mock("../ws.js", () => ({
  createClientMessageId: () => "client-1",
  sendToSession: (sessionId: string, message: unknown) => send(sessionId, message),
}));
vi.mock("./ModelSwitcher.js", () => ({ ModelSwitcher: () => null }));

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

const session: SessionState = {
  sessionId: "session-1",
  backendType: "pi",
  transport: "pi-rpc",
  piVersion: "0.82.1",
  model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
  thinkingLevel: "high",
  mode: "agent",
  cwd: "/workspace",
  tools: ["read", "write", "edit", "bash"],
  commands: [],
  skills: [],
  mcpServers: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  runState: "ready",
  isCompacting: false,
  generation: 4,
};

beforeEach(() => {
  useStore.getState().reset();
  useStore.getState().addSession(session);
  useStore.getState().setConnectionStatus(session.sessionId, "connected");
  send.mockClear();
});

describe("Composer Pi protocol", () => {
  it("sends a native agent_message with generation and content parts", () => {
    render(<Composer sessionId={session.sessionId} />);
    const editor = screen.getByRole("textbox");
    editor.textContent = "hello";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(send).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({
        type: "agent_message",
        generation: 4,
        clientMsgId: "client-1",
        message: expect.objectContaining({
          id: "client-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
        }),
      }),
    );
  });

  it("uses Shift+Tab to toggle only agent and plan modes", () => {
    render(<Composer sessionId={session.sessionId} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab", shiftKey: true });
    expect(send).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ type: "set_mode", mode: "plan" }),
    );
    expect(useStore.getState().sessions.get(session.sessionId)?.mode).toBe("plan");
  });

  it("uses abort for active runs", () => {
    useStore.getState().setRunActive(session.sessionId, true);
    render(<Composer sessionId={session.sessionId} />);
    fireEvent.click(screen.getByRole("button", { name: /停止生成|Stop generation/ }));
    expect(send).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ type: "abort", generation: 4 }),
    );
  });
});
