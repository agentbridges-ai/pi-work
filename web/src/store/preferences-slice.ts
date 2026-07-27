import type { StateCreator } from "zustand";
import {
  DEFAULT_USER_PREFERENCES,
  type FilePreviewPreference,
  type FilePreviewPreferenceKey,
  type UserPreferences,
} from "../api.js";
import type { AppState } from "./index.js";

export type PreferencesSlice = {
  preferences: UserPreferences;
  preferencesLoaded: boolean;
  preferencesSaving: boolean;
  preferencesError: string;
  setPreferences: (preferences: UserPreferences) => void;
  setFilePreviewDefault: (key: FilePreviewPreferenceKey, value: FilePreviewPreference) => void;
  setPreferencesSaving: (saving: boolean) => void;
  setPreferencesError: (error: string) => void;
  resetPreferences: () => void;
};

export function normalizeUserPreferences(
  value: Partial<UserPreferences> | null | undefined,
): UserPreferences {
  return {
    ...DEFAULT_USER_PREFERENCES,
    ...value,
    filePreviewDefaults: {
      ...DEFAULT_USER_PREFERENCES.filePreviewDefaults,
      ...(value?.filePreviewDefaults || {}),
    },
    userSpace: {
      ...DEFAULT_USER_PREFERENCES.userSpace,
      ...(value?.userSpace || {}),
      searchHiddenEntries: true,
    },
  };
}

export const createPreferencesSlice: StateCreator<AppState, [], [], PreferencesSlice> = (set) => ({
  preferences: normalizeUserPreferences(null),
  preferencesLoaded: false,
  preferencesSaving: false,
  preferencesError: "",
  setPreferences: (preferences) =>
    set({
      preferences: normalizeUserPreferences(preferences),
      preferencesLoaded: true,
      preferencesError: "",
    }),
  setFilePreviewDefault: (key, value) =>
    set((state) => ({
      preferences: normalizeUserPreferences({
        ...state.preferences,
        filePreviewDefaults: {
          ...state.preferences.filePreviewDefaults,
          [key]: value,
        },
      }),
      preferencesLoaded: true,
      preferencesError: "",
    })),
  setPreferencesSaving: (saving) => set({ preferencesSaving: saving }),
  setPreferencesError: (error) => set({ preferencesError: error }),
  resetPreferences: () =>
    set({
      preferences: normalizeUserPreferences(null),
      preferencesLoaded: false,
      preferencesSaving: false,
      preferencesError: "",
    }),
});
