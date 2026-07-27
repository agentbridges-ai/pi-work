import { api, type UserSpaceCreateMetadata } from "./api.js";
import { isAbortError, runtimeContextCoordinator, type RuntimeContext } from "./runtime-context.js";
import { ScopedLatestWriteCoordinator } from "./scoped-latest-write-coordinator.js";
import { useStore } from "./store.js";
import { userScopeKeyFromCurrentUser } from "./store/user-scoped-storage.js";
import type { ActiveUserSpace, UserSpaceMount } from "./types.js";

export interface UserSpaceConfigurationContext {
  userId: string;
  userScopeKey: string;
  agentId: string;
  sessionId: string;
  epoch: number;
  contextId: string;
}

export interface UserSpaceConfigurationResult {
  user_space: ActiveUserSpace | null;
  user_spaces: UserSpaceMount[];
}

export interface UserSpaceConfigurationIntent {
  context: UserSpaceConfigurationContext;
  userSpace: UserSpaceCreateMetadata | UserSpaceCreateMetadata[] | null;
  activeMountId?: string;
  onSuccess?: (result: UserSpaceConfigurationResult) => void;
  onError?: (error: unknown) => void;
}

function contextKey(context: UserSpaceConfigurationContext): string {
  return JSON.stringify([
    context.userScopeKey,
    context.userId,
    context.agentId,
    context.sessionId,
    context.epoch,
    context.contextId,
  ]);
}

function matchesRuntimeContext(
  expected: UserSpaceConfigurationContext,
  current: RuntimeContext | null | undefined,
): boolean {
  return (
    !!current &&
    current.userId === expected.userId &&
    current.userScopeKey === expected.userScopeKey &&
    current.agentId === expected.agentId &&
    current.sessionId === expected.sessionId &&
    current.epoch === expected.epoch &&
    current.contextId === expected.contextId &&
    userScopeKeyFromCurrentUser(useStore.getState().currentUser) === expected.userScopeKey
  );
}

async function writeUserSpaceConfiguration(
  intent: UserSpaceConfigurationIntent,
  coordinatorContext: { scopeKey: string; signal: AbortSignal },
): Promise<UserSpaceConfigurationResult> {
  const lease = runtimeContextCoordinator.current();
  if (
    coordinatorContext.scopeKey !== contextKey(intent.context) ||
    !matchesRuntimeContext(intent.context, lease?.context)
  ) {
    throw new DOMException("", "AbortError");
  }

  const operationScope = lease!.scope.child();
  const abortOperation = () => void operationScope.dispose();
  if (coordinatorContext.signal.aborted) abortOperation();
  else coordinatorContext.signal.addEventListener("abort", abortOperation, { once: true });

  try {
    return await api.configureUserSpace(
      intent.context.sessionId,
      intent.userSpace,
      intent.activeMountId,
      {
        signal: operationScope.signal,
        contextEpoch: intent.context.epoch,
        contextId: intent.context.contextId,
      },
    );
  } finally {
    coordinatorContext.signal.removeEventListener("abort", abortOperation);
    await operationScope.dispose();
  }
}

const userSpaceConfigurationCoordinator = new ScopedLatestWriteCoordinator<
  UserSpaceConfigurationIntent,
  UserSpaceConfigurationResult
>({
  write: writeUserSpaceConfiguration,
  onSuccess: (result, intent) => {
    if (!matchesRuntimeContext(intent.context, runtimeContextCoordinator.current()?.context)) {
      return;
    }
    intent.onSuccess?.(result);
  },
  onError: (error, intent) => {
    if (isAbortError(error)) return;
    if (!matchesRuntimeContext(intent.context, runtimeContextCoordinator.current()?.context)) {
      return;
    }
    intent.onError?.(error);
  },
});

export function captureUserSpaceConfigurationContext(
  sessionId: string,
  agentId: string,
): UserSpaceConfigurationContext | null {
  const context = runtimeContextCoordinator.current()?.context;
  if (!context || context.sessionId !== sessionId || context.agentId !== agentId) return null;
  if (!matchesRuntimeContext({ ...context, sessionId }, context)) return null;
  return {
    userId: context.userId,
    userScopeKey: context.userScopeKey,
    agentId: context.agentId,
    sessionId,
    epoch: context.epoch,
    contextId: context.contextId,
  };
}

/**
 * Serializes configuration mutations for the active runtime and only exposes
 * the newest response. Callers must capture the account/agent/session epoch
 * at the point that produced the desired mount snapshot.
 */
export function configureUserSpaceLatest(intent: UserSpaceConfigurationIntent): number | null {
  if (!matchesRuntimeContext(intent.context, runtimeContextCoordinator.current()?.context)) {
    return null;
  }
  return userSpaceConfigurationCoordinator.enqueue(contextKey(intent.context), intent);
}

export function resetUserSpaceConfigurationForTests(): Promise<void> {
  return userSpaceConfigurationCoordinator.dispose();
}
