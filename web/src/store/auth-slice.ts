import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import {
  DEFAULT_USER_PREFERENCES,
  setExpectedTenantRequestPrincipal,
  type CurrentUser,
} from "../api.js";
import { DEFAULT_AGENT_ID } from "../agents.js";
import {
  emptyAgentSessionHistoryIds,
  emptyAgentSessionIds,
  emptyAgentUserSpaces,
  userScopeKeyFromCurrentUser,
} from "./user-scoped-storage.js";
import { disposeLoadedUserSpaceRuntimeState } from "../user-space-runtime-lifecycle.js";

function userScopedStateReset(): Partial<AppState> {
  return {
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
    messages: new Map(),
    streamingStartedAt: new Map(),
    streamingOutputTokens: new Map(),
    promptSuggestions: new Map(),
    pendingInteractions: new Map(),
    completedInteractions: new Map(),
    sessionTasks: new Map(),
    sessionProcesses: new Map(),
    toolProgress: new Map(),
    toolActivity: new Map(),
    selectedAgentId: DEFAULT_AGENT_ID,
    agentSessionIds: emptyAgentSessionIds(),
    agentSessionHistoryIds: emptyAgentSessionHistoryIds(),
    agentUserSpaces: emptyAgentUserSpaces(),
    creationProgress: null,
    creationError: null,
    sessionCreating: false,
    sessionCreatingBackend: null,
    preferences: DEFAULT_USER_PREFERENCES,
    preferencesLoaded: false,
    preferencesSaving: false,
    preferencesError: "",
  };
}

function getInitialAuthToken(): string | null {
  return null;
}

export interface AuthSlice {
  authToken: string | null;
  isAuthenticated: boolean;
  authInitialized: boolean;
  currentUser: CurrentUser | null;
  runtimeMode: string;

  setAuthToken: (token: string) => void;
  setCurrentUser: (user: CurrentUser, runtimeMode: string) => void;
  setUnauthenticated: (runtimeMode?: string) => void;
  logout: () => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (set, get) => ({
  authToken: getInitialAuthToken(),
  isAuthenticated: getInitialAuthToken() !== null,
  authInitialized: getInitialAuthToken() !== null,
  currentUser: null,
  runtimeMode: "local",

  setAuthToken: (token) => {
    set({ authToken: token, isAuthenticated: true, authInitialized: true, runtimeMode: "local" });
  },
  setCurrentUser: (user, runtimeMode) => {
    setExpectedTenantRequestPrincipal(user);
    const previousUserScopeKey = userScopeKeyFromCurrentUser(get().currentUser);
    const nextUserScopeKey = userScopeKeyFromCurrentUser(user);
    if (previousUserScopeKey !== nextUserScopeKey) disposeLoadedUserSpaceRuntimeState();
    set((state) => {
      if (userScopeKeyFromCurrentUser(state.currentUser) !== nextUserScopeKey) {
        return {
          ...userScopedStateReset(),
          currentUser: user,
          runtimeMode,
          isAuthenticated: true,
          authInitialized: true,
        };
      }
      return { currentUser: user, runtimeMode, isAuthenticated: true, authInitialized: true };
    });
  },
  setUnauthenticated: (runtimeMode = "local") => {
    setExpectedTenantRequestPrincipal(null);
    disposeLoadedUserSpaceRuntimeState();
    set({
      ...userScopedStateReset(),
      authToken: null,
      currentUser: null,
      runtimeMode,
      isAuthenticated: false,
      authInitialized: true,
    });
  },
  logout: () => {
    setExpectedTenantRequestPrincipal(null);
    disposeLoadedUserSpaceRuntimeState();
    set((state) => ({
      ...userScopedStateReset(),
      authToken: null,
      currentUser: null,
      runtimeMode: state.runtimeMode,
      isAuthenticated: false,
      authInitialized: true,
    }));
  },
});
