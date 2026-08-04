import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { runWithRuntimeDbContext } from "./runtime-db-context.js";
import { ScopedDatabase } from "./scoped-database.js";

function clientFixture() {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 0 }));
  const release = vi.fn();
  return { client: { query, release }, query, release };
}

describe("ScopedDatabase", () => {
  it("applies a complete tenant scope without duplicating an explicit BEGIN", async () => {
    const fixture = clientFixture();
    const rawPool = {
      connect: vi.fn(async () => fixture.client),
    } as unknown as { connect(): Promise<PoolClient> };
    const database = new ScopedDatabase(rawPool as never);
    await runWithRuntimeDbContext(
      {
        userId: "user-a",
        tenantId: "tenant-a",
        membershipId: "membership-a",
        orgNodeId: "org-root",
      },
      async () => {
        const client = await database.connect();
        await client.query("begin;");
        await client.query("select 1");
        await client.query("commit");
        client.release();
      },
    );
    expect(fixture.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "begin;",
      expect.stringContaining("piwork.tenant_id"),
      "select 1",
      "commit",
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("uses the raw pool without context and scopes incomplete user context", async () => {
    const fixture = clientFixture();
    const rawPool = {
      query: vi.fn(async (..._args: unknown[]) => ({ rows: [{ value: 1 }], rowCount: 1 })),
      connect: vi.fn(async () => fixture.client),
    } as unknown as {
      query: (...args: unknown[]) => Promise<unknown>;
      connect(): Promise<PoolClient>;
    };
    const database = new ScopedDatabase(rawPool as never);

    await expect(database.query("select 1")).resolves.toMatchObject({ rows: [{ value: 1 }] });
    expect(rawPool.query).toHaveBeenCalledWith("select 1");
    await runWithRuntimeDbContext(
      { userId: "user-a", tenantId: "", membershipId: "", orgNodeId: "" },
      async () => {
        await database.query("select scoped");
      },
    );
    expect(fixture.query.mock.calls.map(([sql]) => String(sql))).toContain("select scoped");
    expect(fixture.query.mock.calls.map(([sql]) => String(sql))).toContain("commit");
  });

  it("rolls back incomplete user scopes and initializes a connected client lazily", async () => {
    const fixture = clientFixture();
    fixture.query.mockImplementationOnce(async () => {
      throw new Error("query failed");
    });
    const rawPool = {
      connect: vi.fn(async () => fixture.client),
    } as unknown as { connect(): Promise<PoolClient> };
    const database = new ScopedDatabase(rawPool as never);
    await expect(
      runWithRuntimeDbContext(
        { userId: "user-a", tenantId: "", membershipId: "", orgNodeId: "" },
        () => database.query("select failing"),
      ),
    ).rejects.toThrow("query failed");
    expect(fixture.release).toHaveBeenCalledOnce();

    const second = clientFixture();
    const connectedPool = {
      connect: vi.fn(async () => second.client),
    } as unknown as { connect(): Promise<PoolClient> };
    const connected = new ScopedDatabase(connectedPool as never);
    await runWithRuntimeDbContext(
      {
        userId: "user-a",
        tenantId: "tenant-a",
        membershipId: "membership-a",
        orgNodeId: "org-root",
      },
      async () => {
        const client = await connected.connect();
        await client.query("select 1");
        await client.query("rollback");
        client.release();
      },
    );
    expect(second.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "begin",
      expect.stringContaining("set_config('piwork.tenant_id"),
      "select 1",
      "rollback",
    ]);
  });
});
