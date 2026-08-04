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
});
