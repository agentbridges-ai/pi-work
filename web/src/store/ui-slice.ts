import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import { type AgentId } from "../agents.js";
import type { UserSpaceMount } from "../types.js";
import {
  emptyAgentSessionHistoryIds,
  emptyAgentSessionIds,
  emptyAgentUserSpaces,
} from "./user-scoped-storage.js";
import {
  legacyStorageKey,
  readStorageItem,
  removeStorageItem,
  writeStorageItem,
} from "../utils/local-storage.js";
import { setUiCopyLanguage } from "../ui-copy.js";

export type ThemeMode = "system" | "light" | "dark";
export type UiLanguage = "zh-CN" | "en-US";

const THEME_MODE_STORAGE_KEY = "piwork-theme-mode";
const LEGACY_THEME_MODE_STORAGE_KEY = legacyStorageKey("theme-mode");
const RESOLVED_DARK_MODE_STORAGE_KEY = "piwork-dark-mode";
const LEGACY_RESOLVED_DARK_MODE_STORAGE_KEY = legacyStorageKey("dark-mode");
const LEGACY_DESIGN_RADIUS_STORAGE_KEY = "piwork-design-radius";
const UI_LANGUAGE_STORAGE_KEY = "piwork-ui-language";
const LEGACY_UI_LANGUAGE_STORAGE_KEY = legacyStorageKey("ui-language");
const NOTIFICATION_DESKTOP_STORAGE_KEY = "piwork-notification-desktop";
const LEGACY_NOTIFICATION_DESKTOP_STORAGE_KEY = legacyStorageKey("notification-desktop");

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isUiLanguage(value: string | null): value is UiLanguage {
  return value === "zh-CN" || value === "en-US";
}

function getSystemDarkMode(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveThemeMode(mode: ThemeMode): boolean {
  return mode === "system" ? getSystemDarkMode() : mode === "dark";
}

export function getInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = readStorageItem(THEME_MODE_STORAGE_KEY, LEGACY_THEME_MODE_STORAGE_KEY);
  if (isThemeMode(stored)) return stored;

  const legacyDarkMode = readStorageItem(
    RESOLVED_DARK_MODE_STORAGE_KEY,
    LEGACY_RESOLVED_DARK_MODE_STORAGE_KEY,
  );
  if (legacyDarkMode === "true") return "dark";
  if (legacyDarkMode === "false") return "system";
  return "system";
}

export function cleanupLegacyDesignRadiusPreference(): void {
  if (typeof window === "undefined") return;
  removeStorageItem(LEGACY_DESIGN_RADIUS_STORAGE_KEY);
}

export function getInitialUiLanguage(): UiLanguage {
  if (typeof window === "undefined") return "zh-CN";
  const stored = readStorageItem(UI_LANGUAGE_STORAGE_KEY, LEGACY_UI_LANGUAGE_STORAGE_KEY);
  return isUiLanguage(stored) ? stored : "zh-CN";
}

function persistThemeMode(mode: ThemeMode, darkMode: boolean): void {
  if (typeof window === "undefined") return;
  writeStorageItem(THEME_MODE_STORAGE_KEY, mode, LEGACY_THEME_MODE_STORAGE_KEY);
  writeStorageItem(
    RESOLVED_DARK_MODE_STORAGE_KEY,
    String(darkMode),
    LEGACY_RESOLVED_DARK_MODE_STORAGE_KEY,
  );
}

function persistUiLanguage(language: UiLanguage): void {
  if (typeof window === "undefined") return;
  writeStorageItem(UI_LANGUAGE_STORAGE_KEY, language, LEGACY_UI_LANGUAGE_STORAGE_KEY);
}

function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = readStorageItem(
    NOTIFICATION_DESKTOP_STORAGE_KEY,
    LEGACY_NOTIFICATION_DESKTOP_STORAGE_KEY,
  );
  if (stored !== null) return stored === "true";
  return false;
}

function getInitialSelectedAgentId(): AgentId {
  return "agent";
}

function getInitialAgentSessionIds(): Record<AgentId, string> {
  return emptyAgentSessionIds();
}

function getInitialAgentSessionHistoryIds(): Record<AgentId, string[]> {
  return emptyAgentSessionHistoryIds();
}

function getInitialAgentUserSpaces(): Record<AgentId, UserSpaceMount[]> {
  return emptyAgentUserSpaces();
}

export interface UiSlice {
  themeMode: ThemeMode;
  darkMode: boolean;
  uiLanguage: UiLanguage;
  notificationDesktop: boolean;
  publicUrl: string;
  selectedAgentId: AgentId;
  agentSessionIds: Record<AgentId, string>;
  agentSessionHistoryIds: Record<AgentId, string[]>;
  agentUserSpaces: Record<AgentId, UserSpaceMount[]>;

  setThemeMode: (mode: ThemeMode) => void;
  setUiLanguage: (language: UiLanguage) => void;
  refreshSystemTheme: () => void;
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setPublicUrl: (url: string) => void;
  setSelectedAgentId: (id: AgentId) => void;
  hydrateWorkspaceSessionState: (state: {
    selectedAgentId: AgentId;
    agentSessionIds: Record<AgentId, string>;
    agentSessionHistoryIds: Record<AgentId, string[]>;
    agentUserSpaces?: Record<AgentId, UserSpaceMount[]>;
  }) => void;
  bindSessionToAgent: (agentId: AgentId, sessionId: string) => void;
  clearAgentSessionBinding: (agentId: AgentId) => void;
  setAgentUserSpaces: (agentId: AgentId, mounts: UserSpaceMount[]) => void;
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => {
  const initialThemeMode = getInitialThemeMode();
  const initialDarkMode = resolveThemeMode(initialThemeMode);
  const initialUiLanguage = getInitialUiLanguage();
  cleanupLegacyDesignRadiusPreference();
  setUiCopyLanguage(initialUiLanguage);

  return {
    themeMode: initialThemeMode,
    darkMode: initialDarkMode,
    uiLanguage: initialUiLanguage,
    notificationDesktop: getInitialNotificationDesktop(),
    publicUrl: "",
    selectedAgentId: getInitialSelectedAgentId(),
    agentSessionIds: getInitialAgentSessionIds(),
    agentSessionHistoryIds: getInitialAgentSessionHistoryIds(),
    agentUserSpaces: getInitialAgentUserSpaces(),

    setThemeMode: (mode) => {
      const darkMode = resolveThemeMode(mode);
      persistThemeMode(mode, darkMode);
      set({ themeMode: mode, darkMode });
    },
    setUiLanguage: (language) => {
      setUiCopyLanguage(language);
      persistUiLanguage(language);
      set({ uiLanguage: language });
    },
    refreshSystemTheme: () => {
      const state = get();
      if (state.themeMode !== "system") return;
      const darkMode = resolveThemeMode("system");
      persistThemeMode("system", darkMode);
      set({ darkMode });
    },
    setDarkMode: (v) => {
      const mode: ThemeMode = v ? "dark" : "light";
      const darkMode = resolveThemeMode(mode);
      persistThemeMode(mode, darkMode);
      set({ themeMode: mode, darkMode });
    },
    toggleDarkMode: () =>
      set((s) => {
        const mode: ThemeMode = s.darkMode ? "light" : "dark";
        const darkMode = resolveThemeMode(mode);
        persistThemeMode(mode, darkMode);
        return { themeMode: mode, darkMode };
      }),
    setNotificationDesktop: (v) => {
      writeStorageItem(
        NOTIFICATION_DESKTOP_STORAGE_KEY,
        String(v),
        LEGACY_NOTIFICATION_DESKTOP_STORAGE_KEY,
      );
      set({ notificationDesktop: v });
    },
    toggleNotificationDesktop: () =>
      set((s) => {
        const next = !s.notificationDesktop;
        writeStorageItem(
          NOTIFICATION_DESKTOP_STORAGE_KEY,
          String(next),
          LEGACY_NOTIFICATION_DESKTOP_STORAGE_KEY,
        );
        return { notificationDesktop: next };
      }),
    setPublicUrl: (url) => set({ publicUrl: url }),
    setSelectedAgentId: (id) => set({ selectedAgentId: id }),
    hydrateWorkspaceSessionState: (state) =>
      set({
        selectedAgentId: state.selectedAgentId,
        agentSessionIds: { ...state.agentSessionIds },
        agentSessionHistoryIds: Object.fromEntries(
          Object.entries(state.agentSessionHistoryIds).map(([agentId, sessionIds]) => [
            agentId,
            [...sessionIds],
          ]),
        ) as Record<AgentId, string[]>,
        ...(state.agentUserSpaces
          ? {
              agentUserSpaces: Object.fromEntries(
                Object.entries(state.agentUserSpaces).map(([agentId, mounts]) => [
                  agentId,
                  mounts.map((mount) => ({ ...mount })),
                ]),
              ) as Record<AgentId, UserSpaceMount[]>,
            }
          : {}),
      }),
    bindSessionToAgent: (agentId, sessionId) =>
      set((s) => {
        const agentSessionIds = { ...s.agentSessionIds, [agentId]: sessionId };
        const existingHistory = s.agentSessionHistoryIds[agentId] || [];
        const agentSessionHistoryIds = {
          ...s.agentSessionHistoryIds,
          [agentId]: [sessionId, ...existingHistory.filter((id) => id !== sessionId)],
        };
        return { agentSessionIds, agentSessionHistoryIds, selectedAgentId: agentId };
      }),
    clearAgentSessionBinding: (agentId) =>
      set((s) => {
        const agentSessionIds = { ...s.agentSessionIds, [agentId]: "" };
        return { agentSessionIds };
      }),
    setAgentUserSpaces: (agentId, mounts) =>
      set((s) => {
        const agentUserSpaces = {
          ...s.agentUserSpaces,
          [agentId]: mounts.map((mount) => ({ ...mount })),
        };
        return { agentUserSpaces };
      }),
  };
};
