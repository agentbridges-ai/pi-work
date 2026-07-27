import { getUserPreferencesPath } from "./local-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

export type FilePreviewPreference = "preview" | "alternate";
export type FilePreviewPreferenceKey = "html" | "markdown" | "word" | "ppt" | "excel";

export interface LocalUserPreferences {
  filePreviewDefaults: Record<FilePreviewPreferenceKey, FilePreviewPreference>;
  userSpace: {
    showHiddenEntries: boolean;
    searchHiddenEntries: boolean;
  };
  updatedAt: string;
}

export const defaultLocalUserPreferences: LocalUserPreferences = {
  filePreviewDefaults: {
    html: "preview",
    markdown: "preview",
    word: "preview",
    ppt: "preview",
    excel: "preview",
  },
  userSpace: {
    showHiddenEntries: false,
    searchHiddenEntries: true,
  },
  updatedAt: "",
};

const FILE_PREVIEW_KEYS: FilePreviewPreferenceKey[] = ["html", "markdown", "word", "ppt", "excel"];

function normalizePreviewPreference(value: unknown): FilePreviewPreference {
  return value === "alternate" ? "alternate" : "preview";
}

export function normalizeLocalUserPreferences(value: unknown): LocalUserPreferences {
  const input = value && typeof value === "object" ? (value as Partial<LocalUserPreferences>) : {};
  const inputDefaults =
    input.filePreviewDefaults && typeof input.filePreviewDefaults === "object"
      ? (input.filePreviewDefaults as Partial<Record<FilePreviewPreferenceKey, unknown>>)
      : {};
  const filePreviewDefaults = { ...defaultLocalUserPreferences.filePreviewDefaults };
  for (const key of FILE_PREVIEW_KEYS) {
    filePreviewDefaults[key] = normalizePreviewPreference(inputDefaults[key]);
  }
  const inputUserSpace =
    input.userSpace && typeof input.userSpace === "object"
      ? (input.userSpace as Partial<LocalUserPreferences["userSpace"]>)
      : {};
  return {
    filePreviewDefaults,
    userSpace: {
      showHiddenEntries: inputUserSpace.showHiddenEntries === true,
      searchHiddenEntries: true,
    },
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : "",
  };
}

export class LocalUserPreferencesStore {
  private store(uuid: string): AtomicJsonStore<LocalUserPreferences> {
    return new AtomicJsonStore(getUserPreferencesPath(uuid), {
      schemaVersion: 1,
      normalize: normalizeLocalUserPreferences,
      defaultValue: () => normalizeLocalUserPreferences(defaultLocalUserPreferences),
    });
  }

  read(uuid: string): LocalUserPreferences {
    return (
      this.store(uuid).readValue() ?? normalizeLocalUserPreferences(defaultLocalUserPreferences)
    );
  }

  write(uuid: string, preferences: unknown): LocalUserPreferences {
    const next = normalizeLocalUserPreferences(preferences);
    next.updatedAt = new Date().toISOString();
    this.store(uuid).write(next);
    return next;
  }
}
