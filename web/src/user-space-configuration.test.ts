import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeContextCoordinator } from "./runtime-context.js";
import {
  captureUserSpaceConfigurationContext,
  configureUserSpaceLatest,
  resetUserSpaceConfigurationForTests,
} from "./user-space-configuration.js";

const harness = vi.hoisted(() => ({
  state: {
    currentUser: { uuid: "user-a", userId: "user-a", tenantId: "tenant-a" },
  } as { currentUser: { uuid: string; userId: string; tenantId?: string } | null },
  configureUserSpace: vi.fn(),
}));

vi.mock("./store.js", () => {
  const useStore = (selector: (state: typeof harness.state) => unknown) => selector(harness.state);
  useStore.getState = () => harness.state;
  return { useStore };
});

vi.mock("./api.js", () => ({
  api: {
    configureUserSpace: (...args: unknown[]) => harness.configureUserSpace(...args),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flushCoordinator = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function activate(userId: string, tenantId: string, agentId: string, sessionId: string) {
  harness.state.currentUser = { uuid: userId, userId, tenantId };
  return runtimeContextCoordinator.activate({
    userId,
    userScopeKey: JSON.stringify([userId, tenantId]),
    agentId,
    sessionId,
  });
}

describe("user-space configuration scope", () => {
  beforeEach(async () => {
    harness.configureUserSpace.mockReset();
    await resetUserSpaceConfigurationForTests();
    await runtimeContextCoordinator.dispose();
  });

  afterEach(async () => {
    await resetUserSpaceConfigurationForTests();
    await runtimeContextCoordinator.dispose();
  });

  it("serializes writes and exposes only the newest response for one runtime epoch", async () => {
    const lease = activate("user-a", "tenant-a", "agent-a", "session-a");
    const context = captureUserSpaceConfigurationContext("session-a", "agent-a");
    expect(context).not.toBeNull();
    const first = deferred<{ user_space: null; user_spaces: [] }>();
    const second = deferred<{ user_space: null; user_spaces: [] }>();
    harness.configureUserSpace
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const applied: string[] = [];

    configureUserSpaceLatest({
      context: context!,
      userSpace: null,
      onSuccess: () => applied.push("first"),
    });
    configureUserSpaceLatest({
      context: context!,
      userSpace: [
        {
          mountId: "mount-new",
          name: "New",
          rootName: "New",
          access: "readwrite",
          includeHidden: true,
        },
      ],
      activeMountId: "mount-new",
      onSuccess: () => applied.push("second"),
    });

    expect(harness.configureUserSpace).toHaveBeenCalledTimes(1);
    expect(harness.configureUserSpace).toHaveBeenNthCalledWith(
      1,
      "session-a",
      null,
      undefined,
      expect.objectContaining({
        contextEpoch: lease.context.epoch,
        contextId: lease.context.contextId,
        signal: expect.any(AbortSignal),
      }),
    );

    first.resolve({ user_space: null, user_spaces: [] });
    await vi.waitFor(() => expect(harness.configureUserSpace).toHaveBeenCalledTimes(2));
    expect(applied).toEqual([]);
    expect(harness.configureUserSpace).toHaveBeenNthCalledWith(
      2,
      "session-a",
      expect.arrayContaining([expect.objectContaining({ mountId: "mount-new" })]),
      "mount-new",
      expect.objectContaining({
        contextEpoch: lease.context.epoch,
        contextId: lease.context.contextId,
        signal: expect.any(AbortSignal),
      }),
    );

    second.resolve({ user_space: null, user_spaces: [] });
    await vi.waitFor(() => expect(applied).toEqual(["second"]));
  });

  it("aborts the old account request and ignores its late response after a runtime switch", async () => {
    activate("user-a", "tenant-a", "agent-a", "session-a");
    const oldContext = captureUserSpaceConfigurationContext("session-a", "agent-a")!;
    const oldResponse = deferred<{ user_space: null; user_spaces: [] }>();
    const newResponse = deferred<{ user_space: null; user_spaces: [] }>();
    harness.configureUserSpace
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const applied: string[] = [];

    configureUserSpaceLatest({
      context: oldContext,
      userSpace: null,
      onSuccess: () => applied.push("old"),
    });
    const oldSignal = harness.configureUserSpace.mock.calls[0]?.[3]?.signal as AbortSignal;

    const newLease = activate("user-b", "tenant-b", "agent-b", "session-b");
    expect(oldSignal.aborted).toBe(true);
    const newContext = captureUserSpaceConfigurationContext("session-b", "agent-b")!;
    configureUserSpaceLatest({
      context: newContext,
      userSpace: null,
      onSuccess: () => applied.push("new"),
    });
    expect(configureUserSpaceLatest({ context: oldContext, userSpace: null })).toBeNull();

    oldResponse.resolve({ user_space: null, user_spaces: [] });
    await vi.waitFor(() => expect(harness.configureUserSpace).toHaveBeenCalledTimes(2));
    expect(applied).toEqual([]);
    expect(harness.configureUserSpace.mock.calls[1]?.[0]).toBe("session-b");
    expect(harness.configureUserSpace.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({
        contextEpoch: newLease.context.epoch,
        contextId: newLease.context.contextId,
      }),
    );

    newResponse.resolve({ user_space: null, user_spaces: [] });
    await vi.waitFor(() => expect(applied).toEqual(["new"]));
  });

  it("does not send a queued configuration after its runtime becomes stale", async () => {
    activate("user-a", "tenant-a", "agent-a", "session-a");
    const context = captureUserSpaceConfigurationContext("session-a", "agent-a")!;
    const first = deferred<{ user_space: null; user_spaces: [] }>();
    harness.configureUserSpace.mockReturnValueOnce(first.promise);
    const onError = vi.fn();

    configureUserSpaceLatest({ context, userSpace: null });
    configureUserSpaceLatest({
      context,
      userSpace: null,
      activeMountId: "queued-mount",
      onError,
    });
    expect(harness.configureUserSpace).toHaveBeenCalledTimes(1);

    activate("user-b", "tenant-b", "agent-b", "session-b");
    first.resolve({ user_space: null, user_spaces: [] });
    await flushCoordinator();

    expect(harness.configureUserSpace).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("suppresses a successful response when the runtime changed while it was in flight", async () => {
    activate("user-a", "tenant-a", "agent-a", "session-a");
    const context = captureUserSpaceConfigurationContext("session-a", "agent-a")!;
    const response = deferred<{ user_space: null; user_spaces: [] }>();
    harness.configureUserSpace.mockReturnValueOnce(response.promise);
    const onSuccess = vi.fn();

    configureUserSpaceLatest({ context, userSpace: null, onSuccess });
    activate("user-b", "tenant-b", "agent-b", "session-b");
    response.resolve({ user_space: null, user_spaces: [] });
    await flushCoordinator();

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("suppresses an error when the runtime changed while it was in flight", async () => {
    activate("user-a", "tenant-a", "agent-a", "session-a");
    const context = captureUserSpaceConfigurationContext("session-a", "agent-a")!;
    const response = deferred<{ user_space: null; user_spaces: [] }>();
    harness.configureUserSpace.mockReturnValueOnce(response.promise);
    const onError = vi.fn();

    configureUserSpaceLatest({ context, userSpace: null, onError });
    activate("user-b", "tenant-b", "agent-b", "session-b");
    response.reject(new Error("stale failure"));
    await flushCoordinator();

    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a non-abort error for the current runtime", async () => {
    activate("user-a", "tenant-a", "agent-a", "session-a");
    const context = captureUserSpaceConfigurationContext("session-a", "agent-a")!;
    const error = new Error("configuration failed");
    harness.configureUserSpace.mockRejectedValueOnce(error);
    const onError = vi.fn();

    configureUserSpaceLatest({ context, userSpace: null, onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});
