import { create } from "zustand";
import { createAuthSlice, type AuthSlice } from "./auth-slice.js";
import { createSessionsSlice, type SessionsSlice } from "./sessions-slice.js";
import { createChatSlice, type ChatSlice } from "./chat-slice.js";
import { createInteractionsSlice, type InteractionsSlice } from "./interactions-slice.js";
import { createTasksSlice, type TasksSlice } from "./tasks-slice.js";
import {
  createUiSlice,
  type UiSlice,
  cleanupLegacyDesignRadiusPreference,
  getInitialThemeMode,
  getInitialUiLanguage,
  resolveThemeMode,
} from "./ui-slice.js";
import { createUpdatesSlice, type UpdatesSlice } from "./updates-slice.js";
import { createPreferencesSlice, type PreferencesSlice } from "./preferences-slice.js";
import { createActivitySlice, type ActivitySlice } from "./activity-slice.js";
import { DEFAULT_AGENT_ID, AGENTS } from "../agents.js";
import { DEFAULT_USER_PREFERENCES, setExpectedTenantRequestPrincipal } from "../api.js";

export type AppState = AuthSlice &
  SessionsSlice &
  ChatSlice &
  InteractionsSlice &
  TasksSlice &
  UiSlice &
  PreferencesSlice &
  ActivitySlice &
  UpdatesSlice & {
    reset: () => void;
  };

export const useStore = create<AppState>((...args) => ({
  ...createAuthSlice(...args),
  ...createSessionsSlice(...args),
  ...createChatSlice(...args),
  ...createInteractionsSlice(...args),
  ...createTasksSlice(...args),
  ...createUiSlice(...args),
  ...createPreferencesSlice(...args),
  ...createActivitySlice(...args),
  ...createUpdatesSlice(...args),

  reset: () => {
    const [set] = args;
    setExpectedTenantRequestPrincipal(null);
    const themeMode = getInitialThemeMode();
    const uiLanguage = getInitialUiLanguage();
    cleanupLegacyDesignRadiusPreference();
    set({
      // Sessions
      authToken: null,
      isAuthenticated: false,
      authInitialized: true,
      currentUser: null,
      runtimeMode: "local",
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
      // Chat
      messages: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      promptSuggestions: new Map(),
      // Product interactions
      pendingInteractions: new Map(),
      interactionSubmissions: new Map(),
      completedInteractions: new Map(),
      // Tasks
      sessionTasks: new Map(),
      sessionProcesses: new Map(),
      toolProgress: new Map(),
      toolActivity: new Map(),
      // UI
      themeMode,
      darkMode: resolveThemeMode(themeMode),
      uiLanguage,
      selectedAgentId: DEFAULT_AGENT_ID,
      agentSessionIds: Object.fromEntries(
        AGENTS.map((agent) => [agent.id, ""]),
      ) as AppState["agentSessionIds"],
      agentSessionHistoryIds: AGENTS.reduce(
        (acc, agent) => {
          acc[agent.id] = [];
          return acc;
        },
        {} as AppState["agentSessionHistoryIds"],
      ),
      agentUserSpaces: AGENTS.reduce(
        (acc, agent) => {
          acc[agent.id] = [];
          return acc;
        },
        {} as AppState["agentUserSpaces"],
      ),
      preferences: DEFAULT_USER_PREFERENCES,
      preferencesLoaded: false,
      preferencesSaving: false,
      preferencesError: "",
      agentActivity: new Map(),
    });
  },
}));

export type { PreferencesSlice } from "./preferences-slice.js";
