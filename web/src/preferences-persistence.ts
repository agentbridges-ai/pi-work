import { api, type UserPreferences } from "./api.js";
import { isAbortError, runtimeContextCoordinator } from "./runtime-context.js";
import { ScopedLatestWriteCoordinator } from "./scoped-latest-write-coordinator.js";
import { useStore } from "./store.js";
import { userScopeKeyFromCurrentUser } from "./store/user-scoped-storage.js";
import { uiCopy } from "./ui-copy.js";

type PreferencesResponse = { preferences: UserPreferences };

function currentUserScopeKey(): string {
  return userScopeKeyFromCurrentUser(useStore.getState().currentUser);
}

async function writePreferences(
  preferences: UserPreferences,
  context: { scopeKey: string; signal: AbortSignal },
): Promise<PreferencesResponse> {
  const lease = runtimeContextCoordinator.current();
  if (!lease || lease.context.userScopeKey !== context.scopeKey) {
    throw new DOMException("", "AbortError");
  }
  const writeScope = lease.userScope.child();
  const abort = () => void writeScope.dispose();
  if (context.signal.aborted) abort();
  else context.signal.addEventListener("abort", abort, { once: true });
  try {
    return await api.putPreferences(preferences, {
      signal: writeScope.signal,
      contextEpoch: lease.context.epoch,
    });
  } finally {
    context.signal.removeEventListener("abort", abort);
    await writeScope.dispose();
  }
}

const preferencesCoordinator = new ScopedLatestWriteCoordinator<
  UserPreferences,
  PreferencesResponse
>({
  write: writePreferences,
  onSuccess: (result, _preferences, scopeKey) => {
    if (currentUserScopeKey() !== scopeKey) return;
    useStore.getState().setPreferences(result.preferences);
  },
  onError: (error, _preferences, scopeKey) => {
    if (isAbortError(error)) return;
    if (currentUserScopeKey() !== scopeKey) return;
    useStore
      .getState()
      .setPreferencesError(
        error instanceof Error ? error.message : uiCopy.chat.errors.preferencesSaveFailed,
      );
  },
  onSavingChange: (saving, scopeKey) => {
    if (currentUserScopeKey() !== scopeKey) return;
    useStore.getState().setPreferencesSaving(saving);
  },
});

if (typeof useStore.subscribe === "function") {
  useStore.subscribe((state, previousState) => {
    const nextScopeKey = userScopeKeyFromCurrentUser(state.currentUser);
    if (nextScopeKey === userScopeKeyFromCurrentUser(previousState.currentUser)) return;
    preferencesCoordinator.setScope(nextScopeKey);
  });
}

export function savePreferencesLatest(preferences: UserPreferences): void {
  const scopeKey = currentUserScopeKey();
  if (!scopeKey) return;
  useStore.getState().setPreferencesError("");
  preferencesCoordinator.enqueue(scopeKey, preferences);
}
