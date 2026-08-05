import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { withRuntimeDbScope } from "./runtime-db-scope.js";
import { RuntimeSessionIndexStore } from "./runtime-session-index.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "session-a",
  generation: 2,
};

function clientFixture() {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 0 }));
  const release = vi.fn();
  return { client: { query, release }, query, release };
}

describe("Runtime database scope", () => {
  it("sets all RLS authority values transaction-locally and releases the client", async () => {
    const fixture = clientFixture();
    const database = { connect: vi.fn(async () => fixture.client) } as unknown as {
      connect(): Promise<PoolClient>;
    };
    await expect(
      withRuntimeDbScope(database, scope, async (client) => {
        await client.query("select 1");
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin",
      expect.stringContaining("piwork.tenant_id"),
      "select 1",
      "commit",
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rolls back on a failed scoped operation", async () => {
    const fixture = clientFixture();
    const database = { connect: vi.fn(async () => fixture.client) } as unknown as {
      connect(): Promise<PoolClient>;
    };
    await expect(
      withRuntimeDbScope(database, scope, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin",
      expect.stringContaining("piwork.tenant_id"),
      "rollback",
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("projects only the newest generation for a tenant/session", async () => {
    const fixture = clientFixture();
    const database = { connect: vi.fn(async () => fixture.client) } as unknown as {
      connect(): Promise<PoolClient>;
    };
    const store = new RuntimeSessionIndexStore({ database });
    await store.upsert(scope, "ready");
    const insert = fixture.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into runtime_session_index"),
    );
    expect(insert?.[1]).toEqual([
      "tenant-a",
      "user-a",
      "membership-a",
      "org-root",
      "session-a",
      2,
      "ready",
    ]);
    expect(String(insert?.[0])).toContain("generation <= excluded.generation");
  });

  it("rebuilds a tenant projection atomically and rejects cross-tenant rows", async () => {
    const fixture = clientFixture();
    const database = { connect: vi.fn(async () => fixture.client) } as unknown as {
      connect(): Promise<PoolClient>;
    };
    const store = new RuntimeSessionIndexStore({ database });
    await store.rebuild(scope, [{ scope, lifecycle: "running" }]);
    expect(fixture.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "begin",
      expect.stringContaining("piwork.tenant_id"),
      "delete from runtime_session_index where tenant_id=$1",
      expect.stringContaining("insert into runtime_session_index"),
      "commit",
    ]);

    await expect(
      store.rebuild(scope, [{ scope: { ...scope, tenantId: "tenant-b" }, lifecycle: "ready" }]),
    ).rejects.toThrow("crossed tenant scope");
    expect(fixture.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("marks failed sessions and closes only an internally owned pool", async () => {
    const fixture = clientFixture();
    const database = { connect: vi.fn(async () => fixture.client) } as unknown as {
      connect(): Promise<PoolClient>;
    };
    const store = new RuntimeSessionIndexStore({ database });
    await store.markStopped(scope, "failed");
    expect(fixture.query.mock.calls.at(-2)?.[1]).toContain("failed");
    await expect(store.close()).resolves.toBeUndefined();

    const owned = new RuntimeSessionIndexStore();
    await expect(owned.close()).resolves.toBeUndefined();
  });
});
