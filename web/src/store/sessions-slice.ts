import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type {
  AgentMode,
  McpServerDetail,
  PiRunState,
  PiSessionInfo,
  SessionState,
} from "../types.js";
import { deleteFromMap, deleteFromSet } from "./utils.js";

export interface SessionsSlice {
  sessions: Map<string, SessionState>;
  runtimeSessions: PiSessionInfo[];
  currentSessionId: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  runtimeConnected: Map<string, boolean>;
  runtimeReconnecting: Map<string, boolean>;
  runStates: Map<string, PiRunState | null>;
  runActive: Map<string, boolean>;
  previousAgentMode: Map<string, AgentMode>;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  mcpServers: Map<string, McpServerDetail[]>;
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  unloadSessionRuntime: (sessionId: string) => void;
  setRuntimeSessions: (sessions: PiSessionInfo[]) => void;
  setConnectionStatus: (
    sessionId: string,
    status: "connecting" | "connected" | "disconnected",
  ) => void;
  setRuntimeConnected: (sessionId: string, connected: boolean) => void;
  setRuntimeReconnecting: (sessionId: string, reconnecting: boolean) => void;
  setRunState: (sessionId: string, state: PiRunState | null) => void;
  setRunActive: (sessionId: string, active: boolean) => void;
  setPreviousAgentMode: (sessionId: string, mode: AgentMode) => void;
  setSessionName: (sessionId: string, name: string) => void;
  clearSessionName: (sessionId: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;
}

function runtimeCleanup(state: AppState, sessionId: string) {
  return {
    sessions: deleteFromMap(state.sessions, sessionId),
    connectionStatus: deleteFromMap(state.connectionStatus, sessionId),
    runtimeConnected: deleteFromMap(state.runtimeConnected, sessionId),
    runtimeReconnecting: deleteFromMap(state.runtimeReconnecting, sessionId),
    runStates: deleteFromMap(state.runStates, sessionId),
    runActive: deleteFromMap(state.runActive, sessionId),
    previousAgentMode: deleteFromMap(state.previousAgentMode, sessionId),
    mcpServers: deleteFromMap(state.mcpServers, sessionId),
    messages: deleteFromMap(state.messages, sessionId),
    streamingStartedAt: deleteFromMap(state.streamingStartedAt, sessionId),
    streamingOutputTokens: deleteFromMap(state.streamingOutputTokens, sessionId),
    pendingInteractions: deleteFromMap(state.pendingInteractions, sessionId),
    completedInteractions: deleteFromMap(state.completedInteractions, sessionId),
    sessionTasks: deleteFromMap(state.sessionTasks, sessionId),
    sessionProcesses: deleteFromMap(state.sessionProcesses, sessionId),
    toolProgress: deleteFromMap(state.toolProgress, sessionId),
    toolActivity: deleteFromMap(state.toolActivity, sessionId),
  };
}

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set) => ({
  sessions: new Map(),
  runtimeSessions: [],
  currentSessionId: null,
  connectionStatus: new Map(),
  runtimeConnected: new Map(),
  runtimeReconnecting: new Map(),
  runStates: new Map(),
  runActive: new Map(),
  previousAgentMode: new Map(),
  sessionNames: new Map(),
  recentlyRenamed: new Set(),
  mcpServers: new Map(),
  setCurrentSession: (id) => set({ currentSessionId: id }),
  addSession: (session) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(session.sessionId, session);
      const messages = new Map(state.messages);
      if (!messages.has(session.sessionId)) messages.set(session.sessionId, []);
      return { sessions, messages };
    }),
  updateSession: (sessionId, updates) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      const current = sessions.get(sessionId);
      if (current) sessions.set(sessionId, { ...current, ...updates });
      return { sessions };
    }),
  removeSession: (sessionId) =>
    set((state) => ({
      ...runtimeCleanup(state, sessionId),
      sessionNames: deleteFromMap(state.sessionNames, sessionId),
      recentlyRenamed: deleteFromSet(state.recentlyRenamed, sessionId),
      runtimeSessions: state.runtimeSessions.filter((session) => session.sessionId !== sessionId),
      currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
    })),
  unloadSessionRuntime: (sessionId) => set((state) => runtimeCleanup(state, sessionId)),
  setRuntimeSessions: (runtimeSessions) => set({ runtimeSessions }),
  setConnectionStatus: (sessionId, status) =>
    set((state) => {
      const connectionStatus = new Map(state.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),
  setRuntimeConnected: (sessionId, connected) =>
    set((state) => {
      const runtimeConnected = new Map(state.runtimeConnected);
      runtimeConnected.set(sessionId, connected);
      return { runtimeConnected };
    }),
  setRuntimeReconnecting: (sessionId, reconnecting) =>
    set((state) => {
      const runtimeReconnecting = new Map(state.runtimeReconnecting);
      if (reconnecting) runtimeReconnecting.set(sessionId, true);
      else runtimeReconnecting.delete(sessionId);
      return { runtimeReconnecting };
    }),
  setRunState: (sessionId, runState) =>
    set((state) => {
      const runStates = new Map(state.runStates);
      runStates.set(sessionId, runState);
      return { runStates };
    }),
  setRunActive: (sessionId, active) =>
    set((state) => {
      const runActive = new Map(state.runActive);
      if (active) runActive.set(sessionId, true);
      else runActive.delete(sessionId);
      return { runActive };
    }),
  setPreviousAgentMode: (sessionId, mode) =>
    set((state) => {
      const previousAgentMode = new Map(state.previousAgentMode);
      previousAgentMode.set(sessionId, mode);
      return { previousAgentMode };
    }),
  setSessionName: (sessionId, name) =>
    set((state) => {
      const sessionNames = new Map(state.sessionNames);
      sessionNames.set(sessionId, name);
      return { sessionNames };
    }),
  clearSessionName: (sessionId) =>
    set((state) => {
      const sessionNames = new Map(state.sessionNames);
      sessionNames.delete(sessionId);
      const runtimeSessions = state.runtimeSessions.map((session) => {
        if (session.sessionId !== sessionId || session.name === undefined) return session;
        const next = { ...session };
        delete next.name;
        return next;
      });
      return { sessionNames, runtimeSessions };
    }),
  markRecentlyRenamed: (sessionId) =>
    set((state) => {
      const recentlyRenamed = new Set(state.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),
  clearRecentlyRenamed: (sessionId) =>
    set((state) => {
      const recentlyRenamed = new Set(state.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),
  setMcpServers: (sessionId, servers) =>
    set((state) => {
      const mcpServers = new Map(state.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),
});
