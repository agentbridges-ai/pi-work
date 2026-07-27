import { api, type WorkspaceSessionState } from "./api.js";
import { isAbortError, runtimeContextCoordinator } from "./runtime-context.js";
import { ScopedLatestWriteCoordinator } from "./scoped-latest-write-coordinator.js";
import { useStore } from "./store.js";
import {
  rawUserIdFromCurrentUser,
  userScopeKeyFromCurrentUser,
} from "./store/user-scoped-storage.js";

const WORKSPACE_PERSIST_DELAY_MS = 250;

export class WorkspaceSessionStatePersistenceCoordinator {
  private readonly writes: ScopedLatestWriteCoordinator<WorkspaceSessionState, unknown>;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scopeKey = "";
  private scheduled: { scopeKey: string; state: WorkspaceSessionState } | null = null;
  private intentSequence = 0;

  constructor(
    write: (
      state: WorkspaceSessionState,
      context: { scopeKey: string; signal: AbortSignal },
    ) => Promise<unknown>,
    options: {
      delayMs?: number;
      onError?: (error: unknown, state: WorkspaceSessionState, scopeKey: string) => void;
    } = {},
  ) {
    this.delayMs = options.delayMs ?? WORKSPACE_PERSIST_DELAY_MS;
    this.writes = new ScopedLatestWriteCoordinator({
      write,
      onError: options.onError,
      dedupeKey: workspaceStateFingerprint,
    });
  }

  setScope(scopeKey: string): void {
    if (scopeKey === this.scopeKey) return;
    this.scopeKey = scopeKey;
    this.intentSequence += 1;
    this.clearScheduled();
    this.writes.setScope(scopeKey);
  }

  persistNow(scopeKey: string, state: WorkspaceSessionState): void {
    if (!scopeKey) return;
    if (scopeKey !== this.scopeKey) this.setScope(scopeKey);
    this.intentSequence += 1;
    this.clearScheduled();
    this.writes.enqueue(scopeKey, state);
  }

  /**
   * Defers an immediate transition snapshot until the candidate runtime lease
   * is committed. A newer scheduled/immediate intent invalidates this
   * microtask before it can clear or overwrite that newer state.
   */
  deferPersistNow(
    scopeKey: string,
    state: WorkspaceSessionState,
    isStillCurrent: () => boolean = () => true,
  ): void {
    if (!scopeKey) return;
    if (scopeKey !== this.scopeKey) this.setScope(scopeKey);
    const intent = ++this.intentSequence;
    queueMicrotask(() => {
      if (intent !== this.intentSequence || scopeKey !== this.scopeKey || !isStillCurrent()) {
        return;
      }
      this.clearScheduled();
      this.writes.enqueue(scopeKey, state);
    });
  }

  schedule(scopeKey: string, state: WorkspaceSessionState): void {
    if (!scopeKey) return;
    if (scopeKey !== this.scopeKey) this.setScope(scopeKey);
    this.intentSequence += 1;
    this.clearScheduled();
    this.scheduled = { scopeKey, state };
    this.timer = setTimeout(() => {
      this.timer = null;
      const scheduled = this.scheduled;
      this.scheduled = null;
      if (!scheduled || scheduled.scopeKey !== this.scopeKey) return;
      this.writes.enqueue(scheduled.scopeKey, scheduled.state);
    }, this.delayMs);
  }

  async whenIdle(): Promise<void> {
    await this.writes.whenIdle();
  }

  async dispose(): Promise<void> {
    this.clearScheduled();
    await this.writes.dispose();
  }

  private clearScheduled(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.scheduled = null;
  }
}

function workspaceStateFingerprint(state: WorkspaceSessionState): string {
  return JSON.stringify(state);
}

function currentWorkspaceSnapshot(): {
  scopeKey: string;
  state: WorkspaceSessionState;
} | null {
  const store = useStore.getState();
  if (store.runtimeMode !== "local" || !store.isAuthenticated || !store.currentUser) return null;
  const scopeKey = userScopeKeyFromCurrentUser(store.currentUser);
  if (!scopeKey) return null;
  return {
    scopeKey,
    state: {
      selectedAgentId: store.selectedAgentId,
      currentSessionId: store.currentSessionId,
      agentSessionIds: store.agentSessionIds,
      agentSessionHistoryIds: store.agentSessionHistoryIds,
      agentUserSpaces: store.agentUserSpaces,
    },
  };
}

async function writeWorkspaceSessionState(
  state: WorkspaceSessionState,
  context: { scopeKey: string; signal: AbortSignal },
): Promise<WorkspaceSessionState> {
  const store = useStore.getState();
  const currentUserId = rawUserIdFromCurrentUser(store.currentUser);
  const lease = runtimeContextCoordinator.current();
  if (
    !lease ||
    lease.context.userId !== currentUserId ||
    lease.context.userScopeKey !== context.scopeKey
  ) {
    throw new DOMException("", "AbortError");
  }
  const writeScope = lease.userScope.child();
  const abort = () => void writeScope.dispose();
  if (context.signal.aborted) abort();
  else context.signal.addEventListener("abort", abort, { once: true });
  try {
    return await api.putWorkspaceSessionState(state, {
      signal: writeScope.signal,
      contextEpoch: lease.context.epoch,
    });
  } finally {
    context.signal.removeEventListener("abort", abort);
    await writeScope.dispose();
  }
}

const workspaceCoordinator = new WorkspaceSessionStatePersistenceCoordinator(
  writeWorkspaceSessionState,
  {
    onError: (error) => {
      if (isAbortError(error)) return;
      console.warn("[workspace-state] failed to persist", error);
    },
  },
);

workspaceCoordinator.setScope(userScopeKeyFromCurrentUser(useStore.getState().currentUser));
if (typeof useStore.subscribe === "function") {
  useStore.subscribe((state, previousState) => {
    const nextScopeKey = userScopeKeyFromCurrentUser(state.currentUser);
    if (nextScopeKey === userScopeKeyFromCurrentUser(previousState.currentUser)) return;
    workspaceCoordinator.setScope(nextScopeKey);
  });
}

export function persistWorkspaceSessionStateNow(): void {
  const snapshot = currentWorkspaceSnapshot();
  if (!snapshot) return;

  // Transition commit callbacks run immediately before the candidate lease is
  // installed. The microtask binds the write to that newly committed context.
  workspaceCoordinator.deferPersistNow(
    snapshot.scopeKey,
    snapshot.state,
    () => userScopeKeyFromCurrentUser(useStore.getState().currentUser) === snapshot.scopeKey,
  );
}

export function scheduleWorkspaceSessionStatePersist(): void {
  const snapshot = currentWorkspaceSnapshot();
  if (!snapshot) return;
  workspaceCoordinator.schedule(snapshot.scopeKey, snapshot.state);
}
