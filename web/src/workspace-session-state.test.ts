import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type WorkspaceSessionState } from "./api.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { useStore } from "./store.js";
import { userScopeKeyFromCurrentUser } from "./store/user-scoped-storage.js";
import {
  persistWorkspaceSessionStateNow,
  WorkspaceSessionStatePersistenceCoordinator,
} from "./workspace-session-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function state(currentSessionId: string): WorkspaceSessionState {
  return {
    selectedAgentId: "agent",
    currentSessionId,
    agentSessionIds: { agent: currentSessionId, "agent-a": "", "agent-b": "", "agent-c": "" },
    agentSessionHistoryIds: {
      agent: [currentSessionId],
      "agent-a": [],
      "agent-b": [],
      "agent-c": [],
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await runtimeContextCoordinator.dispose();
});

describe("WorkspaceSessionStatePersistenceCoordinator", () => {
  it("sends an immediate tenant-scoped snapshot with the raw Better Auth identity", async () => {
    useStore.getState().reset();
    const currentUser = {
      userId: "user-a",
      uuid: "user-a",
      username: "user-a",
      displayName: "User A",
      orgId: "org",
      orgName: "Org",
      roles: [],
      tenantId: "tenant-a",
    };
    useStore.getState().setCurrentUser(currentUser, "local");
    useStore.getState().setCurrentSession("session-a");
    useStore.getState().bindSessionToAgent("agent", "session-a");
    const scopeKey = userScopeKeyFromCurrentUser(currentUser);
    const lease = runtimeContextCoordinator.activate({
      userId: currentUser.uuid,
      userScopeKey: scopeKey,
      agentId: "agent",
      sessionId: "session-a",
    });
    const putWorkspaceState = vi
      .spyOn(api, "putWorkspaceSessionState")
      .mockImplementation(async (snapshot) => snapshot);

    persistWorkspaceSessionStateNow();

    await vi.waitFor(() => {
      expect(putWorkspaceState).toHaveBeenCalledWith(
        expect.objectContaining({ currentSessionId: "session-a" }),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          contextEpoch: lease.context.epoch,
        }),
      );
    });
    expect(runtimeContextCoordinator.current()?.context.userId).toBe("user-a");
    expect(runtimeContextCoordinator.current()?.context.userScopeKey).toBe(scopeKey);
  });

  it("lets an immediate write supersede a pending debounced snapshot", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => ({}));
    const coordinator = new WorkspaceSessionStatePersistenceCoordinator(write);

    coordinator.schedule("tenant-a", state("debounced"));
    coordinator.persistNow("tenant-a", state("immediate"));
    await coordinator.whenIdle();
    await vi.advanceTimersByTimeAsync(250);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ currentSessionId: "immediate" }),
      expect.objectContaining({ scopeKey: "tenant-a" }),
    );
    await coordinator.dispose();
  });

  it("does not let an older deferred snapshot clear a newer scheduled intent", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => ({}));
    const coordinator = new WorkspaceSessionStatePersistenceCoordinator(write);

    coordinator.deferPersistNow("tenant-a", state("old-transition"));
    coordinator.schedule("tenant-a", state("newer-interaction"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await coordinator.whenIdle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ currentSessionId: "newer-interaction" }),
      expect.objectContaining({ scopeKey: "tenant-a" }),
    );
    await coordinator.dispose();
  });

  it("serializes a debounced update behind an in-flight immediate write", async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const write = vi
      .fn<(value: WorkspaceSessionState) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onError = vi.fn();
    const coordinator = new WorkspaceSessionStatePersistenceCoordinator(write, { onError });

    coordinator.persistNow("tenant-a", state("first"));
    coordinator.schedule("tenant-a", state("latest"));
    await vi.advanceTimersByTimeAsync(250);
    expect(write).toHaveBeenCalledTimes(1);

    first.reject(new Error("obsolete failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentSessionId: "latest" }),
      expect.objectContaining({ scopeKey: "tenant-a" }),
    );
    second.resolve({});
    await coordinator.whenIdle();

    expect(onError).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  it("aborts an old tenant write and drops its scheduled snapshot on scope change", async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const write = vi
      .fn<(value: WorkspaceSessionState, context: { signal: AbortSignal }) => Promise<unknown>>()
      .mockImplementationOnce((_value, context) => {
        signals.push(context.signal);
        return first.promise;
      })
      .mockImplementationOnce((_value, context) => {
        signals.push(context.signal);
        return second.promise;
      });
    const coordinator = new WorkspaceSessionStatePersistenceCoordinator(write);

    coordinator.persistNow("tenant-a", state("tenant-a"));
    coordinator.schedule("tenant-a", state("tenant-a-debounced"));
    coordinator.setScope("tenant-b");
    coordinator.schedule("tenant-b", state("tenant-b"));
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    first.resolve({});
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentSessionId: "tenant-b" }),
      expect.objectContaining({ scopeKey: "tenant-b" }),
    );
    second.resolve({});
    await coordinator.whenIdle();
    await coordinator.dispose();
  });
});
