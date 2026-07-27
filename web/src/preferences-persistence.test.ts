import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPreferences } from "./api.js";

interface MockStoreState {
  currentUser: { scopeKey: string } | null;
  setPreferences: ReturnType<typeof vi.fn>;
  setPreferencesError: ReturnType<typeof vi.fn>;
  setPreferencesSaving: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => {
  const state: MockStoreState = {
    currentUser: { scopeKey: "scope-a" },
    setPreferences: vi.fn(),
    setPreferencesError: vi.fn(),
    setPreferencesSaving: vi.fn(),
  };
  return {
    state,
    putPreferences: vi.fn(),
    listeners: [] as Array<(state: MockStoreState, previous: MockStoreState) => void>,
    leaseScopeKey: "scope-a",
    childDispose: vi.fn(async () => undefined),
  };
});

vi.mock("./api.js", () => ({
  api: { putPreferences: (...args: unknown[]) => harness.putPreferences(...args) },
}));

vi.mock("./runtime-context.js", () => ({
  isAbortError: (error: unknown) =>
    error instanceof DOMException ? error.name === "AbortError" : false,
  runtimeContextCoordinator: {
    current: () => ({
      context: { userScopeKey: harness.leaseScopeKey, epoch: 7 },
      userScope: {
        child: () => ({
          signal: new AbortController().signal,
          dispose: harness.childDispose,
        }),
      },
    }),
  },
}));

vi.mock("./store.js", () => ({
  useStore: {
    getState: () => harness.state,
    subscribe: (
      listener: (state: typeof harness.state, previous: typeof harness.state) => void,
    ) => {
      harness.listeners.push(listener);
      return () => undefined;
    },
  },
}));

vi.mock("./store/user-scoped-storage.js", () => ({
  userScopeKeyFromCurrentUser: (user: { scopeKey?: string } | null) => user?.scopeKey || "",
}));

vi.mock("./ui-copy.js", () => ({
  uiCopy: { chat: { errors: { preferencesSaveFailed: "save failed" } } },
}));

import { savePreferencesLatest } from "./preferences-persistence.js";

function preferences(showHiddenEntries = false): UserPreferences {
  return {
    filePreviewDefaults: {
      html: "preview",
      markdown: "preview",
      word: "preview",
      ppt: "preview",
      excel: "preview",
    },
    userSpace: { showHiddenEntries, searchHiddenEntries: false },
  };
}

describe("preferences latest-write persistence", () => {
  beforeEach(() => {
    harness.state.currentUser = { scopeKey: "scope-a" };
    harness.leaseScopeKey = "scope-a";
    harness.putPreferences.mockReset();
    harness.state.setPreferences.mockReset();
    harness.state.setPreferencesError.mockReset();
    harness.state.setPreferencesSaving.mockReset();
    harness.childDispose.mockClear();
  });

  it("publishes saving state and applies the latest response for the active scope", async () => {
    const nextPreferences = preferences(true);
    harness.putPreferences.mockResolvedValue({ preferences: nextPreferences });

    savePreferencesLatest(nextPreferences);

    expect(harness.state.setPreferencesError).toHaveBeenCalledWith("");
    expect(harness.state.setPreferencesSaving).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(harness.state.setPreferences).toHaveBeenCalledWith(nextPreferences);
      expect(harness.state.setPreferencesSaving).toHaveBeenLastCalledWith(false);
    });
    expect(harness.putPreferences).toHaveBeenCalledWith(
      nextPreferences,
      expect.objectContaining({ contextEpoch: 7, signal: expect.any(AbortSignal) }),
    );
    expect(harness.childDispose).toHaveBeenCalled();
  });

  it("does not publish a late response or saving transition after the visible scope changes", async () => {
    let resolveWrite!: (value: { preferences: UserPreferences }) => void;
    harness.putPreferences.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );
    const nextPreferences = preferences();
    savePreferencesLatest(nextPreferences);
    expect(harness.state.setPreferencesSaving).toHaveBeenCalledWith(true);

    harness.state.currentUser = { scopeKey: "scope-b" };
    harness.state.setPreferences.mockClear();
    harness.state.setPreferencesSaving.mockClear();
    resolveWrite({ preferences: nextPreferences });
    await vi.waitFor(() => expect(harness.childDispose).toHaveBeenCalled());

    expect(harness.state.setPreferences).not.toHaveBeenCalled();
    expect(harness.state.setPreferencesSaving).not.toHaveBeenCalled();
    harness.listeners[0]?.(harness.state, {
      ...harness.state,
      currentUser: { scopeKey: "scope-a" },
    });
  });

  it("fails closed when the runtime lease belongs to another user scope", async () => {
    harness.leaseScopeKey = "scope-b";
    savePreferencesLatest(preferences());

    await vi.waitFor(() => {
      expect(harness.state.setPreferencesSaving).toHaveBeenLastCalledWith(false);
    });
    expect(harness.putPreferences).not.toHaveBeenCalled();
    expect(harness.state.setPreferences).not.toHaveBeenCalled();
  });
});
