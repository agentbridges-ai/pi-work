// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { McpServerDetail, PiSessionInfo, SessionState } from "../types.js";
import { useStore } from "../store.js";

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

const model = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };

function runtimeSession(sessionId: string, name = "Topic"): PiSessionInfo {
  return {
    sessionId,
    state: "connected",
    transport: "pi-rpc",
    model,
    thinkingLevel: "high",
    mode: "agent",
    runState: "ready",
    generation: 1,
    cwd: "/workspace",
    createdAt: 1,
    name,
    backendType: "pi",
  };
}

function sessionState(sessionId: string): SessionState {
  return {
    sessionId,
    backendType: "pi",
    transport: "pi-rpc",
    piVersion: "0.82.1",
    model,
    thinkingLevel: "high",
    mode: "agent",
    cwd: "/workspace",
    tools: ["read"],
    commands: [],
    skills: [],
    mcpServers: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    runState: "ready",
    isCompacting: false,
    generation: 1,
  };
}

beforeEach(() => useStore.getState().reset());

describe("Pi session projections", () => {
  it("clears a removed session from durable and runtime projections", () => {
    const store = useStore.getState();
    store.addSession(sessionState("session-1"));
    store.setRuntimeSessions([runtimeSession("session-1"), runtimeSession("session-2")]);
    store.setCurrentSession("session-1");
    store.setConnectionStatus("session-1", "connected");
    store.setRuntimeConnected("session-1", true);
    store.setRuntimeReconnecting("session-1", true);
    store.setRunState("session-1", "running");
    store.setRunActive("session-1", true);
    store.setPreviousAgentMode("session-1", "plan");
    store.setSessionName("session-1", "Topic");
    store.markRecentlyRenamed("session-1");
    store.setTasks("session-1", [
      { id: "todo", subject: "Inspect", description: "", status: "pending" },
    ]);

    useStore.getState().removeSession("session-1");

    const next = useStore.getState();
    expect(next.sessions.has("session-1")).toBe(false);
    expect(next.runtimeSessions.map((session) => session.sessionId)).toEqual(["session-2"]);
    expect(next.currentSessionId).toBeNull();
    expect(next.sessionNames.has("session-1")).toBe(false);
    expect(next.recentlyRenamed.has("session-1")).toBe(false);
    expect(next.sessionTasks.has("session-1")).toBe(false);
  });

  it("unloads only runtime state and toggles transient flags", () => {
    const store = useStore.getState();
    store.addSession(sessionState("session-1"));
    store.setRuntimeSessions([runtimeSession("session-1")]);
    store.setSessionName("session-1", "Keep this");
    store.setRuntimeReconnecting("session-1", true);
    store.setRuntimeReconnecting("session-1", false);
    store.setRunActive("session-1", true);
    store.setRunActive("session-1", false);
    store.setRuntimeConnected("session-1", true);

    store.unloadSessionRuntime("session-1");

    const next = useStore.getState();
    expect(next.sessions.has("session-1")).toBe(false);
    expect(next.runtimeSessions).toHaveLength(1);
    expect(next.sessionNames.get("session-1")).toBe("Keep this");
    expect(next.runtimeConnected.has("session-1")).toBe(false);
    expect(next.runtimeReconnecting.has("session-1")).toBe(false);
    expect(next.runActive.has("session-1")).toBe(false);
  });

  it("removes names from both projections and tracks MCP and rename state", () => {
    const server: McpServerDetail = {
      name: "docs",
      enabled: true,
      status: "connected",
      scope: "agent",
      config: { type: "streamable-http", url: "https://example.test/mcp" },
    };
    const store = useStore.getState();
    store.setRuntimeSessions([runtimeSession("session-1")]);
    store.setSessionName("session-1", "Topic");
    store.markRecentlyRenamed("session-1");
    store.setMcpServers("session-1", [server]);

    store.clearSessionName("session-1");
    store.clearRecentlyRenamed("session-1");

    const next = useStore.getState();
    expect(next.sessionNames.has("session-1")).toBe(false);
    expect(next.runtimeSessions[0]).not.toHaveProperty("name");
    expect(next.recentlyRenamed.has("session-1")).toBe(false);
    expect(next.mcpServers.get("session-1")).toEqual([server]);
  });
});
