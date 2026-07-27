import { describe, expect, it, vi } from "vitest";
import type { UserSpaceMount } from "./types.js";
import {
  UserSpacePersistence,
  type PersistedUserSpaceRecord,
  type UserSpacePersistenceAdapter,
  type UserSpacePersistenceScope,
} from "./user-space-persistence.js";

interface TestRoot {
  id: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(name: string): UserSpaceMount {
  return {
    mountId: "mount-1",
    name,
    rootName: name,
    status: "mounted",
    access: "readwrite",
    includeHidden: true,
  };
}

function recordKey(scope: UserSpacePersistenceScope, mountId: string): string {
  return JSON.stringify([scope.userId, scope.tenantId || "", mountId]);
}

describe("UserSpacePersistence write invalidation", () => {
  it("keeps A's replacement behind an invalidated in-flight A write across A to B to A", async () => {
    const oldAStarted = deferred();
    const releaseOldA = deferred();
    const records = new Map<string, PersistedUserSpaceRecord<TestRoot>>();
    const completedRoots: string[] = [];
    const adapter: UserSpacePersistenceAdapter<TestRoot> = {
      put: vi.fn(async (record) => {
        if (record.root.id === "old-a") {
          oldAStarted.resolve();
          await releaseOldA.promise;
        }
        completedRoots.push(record.root.id);
        records.set(
          recordKey(
            { userId: record.ownerUserId, tenantId: record.ownerTenantId || undefined },
            record.mountId,
          ),
          record,
        );
      }),
      get: async (scope, mountId) => records.get(recordKey(scope, mountId)) || null,
      getAll: async (scope) =>
        Array.from(records.values()).filter(
          (record) =>
            record.ownerUserId === scope.userId && record.ownerTenantId === (scope.tenantId || ""),
        ),
      delete: async (scope, mountId) => {
        records.delete(recordKey(scope, mountId));
      },
    };
    const persistence = new UserSpacePersistence<TestRoot>(async (left, right) => left === right);
    persistence.configureAdapterForTests(adapter);

    const scopeA = { userId: "user-a", tenantId: "tenant" };
    const scopeB = { userId: "user-b", tenantId: "tenant" };
    const oldA = persistence.queueMount(scopeA, mount("old-a"), { id: "old-a" });
    await oldAStarted.promise;

    persistence.clearPendingWrites();
    const staleB = persistence.queueMount(scopeB, mount("stale-b"), { id: "stale-b" });
    persistence.clearPendingWrites();
    const newA = persistence.queueMount(scopeA, mount("new-a"), { id: "new-a" });

    await Promise.resolve();
    expect(completedRoots).toEqual([]);

    releaseOldA.resolve();
    await Promise.all([oldA, staleB, newA]);

    expect(completedRoots).toEqual(["old-a", "new-a"]);
    expect(records.get(recordKey(scopeA, "mount-1"))?.root.id).toBe("new-a");
    expect(records.has(recordKey(scopeB, "mount-1"))).toBe(false);
  });

  it("drops a queued write from the generation cleared before it reaches IndexedDB", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const put = vi.fn(async (record: PersistedUserSpaceRecord<TestRoot>) => {
      if (record.root.id === "first") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    const persistence = new UserSpacePersistence<TestRoot>(async () => false);
    persistence.configureAdapterForTests({
      put,
      get: async () => null,
      getAll: async () => [],
      delete: async () => undefined,
    });
    const scope = { userId: "user-a" };

    const first = persistence.queueMount(scope, mount("first"), { id: "first" });
    await firstStarted.promise;
    const queued = persistence.queueMount(scope, mount("queued"), { id: "queued" });
    persistence.clearPendingWrites();
    releaseFirst.resolve();
    await Promise.all([first, queued]);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0].root.id).toBe("first");
  });
});
