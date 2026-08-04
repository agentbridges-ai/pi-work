import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { ControlPlaneService } from "./control-plane-service.js";

function queryResult(rows: Array<Record<string, unknown>> = []) {
  return { rows, rowCount: rows.length };
}

describe("ControlPlaneService legacy admin synchronization", () => {
  it("adds and revokes only the deterministic compatibility assignment", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await service.syncLegacySystemAdmin("user-a", true);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("insert into scoped_role_assignments"),
      ["assignment-platform-admin-user-a", "user-a"],
    );

    await service.syncLegacySystemAdmin("user-a", false);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringMatching(/delete from scoped_role_assignments[\s\S]*role-platform-system-admin/),
      ["assignment-platform-admin-user-a", "user-a"],
    );
    expect(query.mock.calls.at(-1)?.[0]).toContain("tenant_id is null");
    expect(query.mock.calls.at(-1)?.[0]).toContain("org_node_id is null");
  });

  it("revokes in-memory runtime authority only after membership writes complete", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized === "begin" || normalized === "rollback") return queryResult();
        if (normalized === "commit") {
          events.push("commit");
          return queryResult();
        }
        if (normalized.includes("from tenants") && normalized.includes("for update")) {
          return queryResult([{ id: "tenant-a" }]);
        }
        if (normalized.includes("from scoped_role_assignments a")) return queryResult([{ ok: 1 }]);
        if (normalized.includes("from tenant_memberships") && normalized.includes("for update")) {
          return queryResult([{ id: "membership-b" }]);
        }
        if (normalized.includes("role-template-tenant-admin")) return queryResult();
        if (normalized.startsWith("update tenant_memberships")) events.push("membership");
        if (normalized.startsWith("delete from scoped_role_assignments")) {
          events.push("assignment");
        }
        return queryResult();
      }),
      release: vi.fn(),
    };
    const revoker = vi.fn(async () => {
      events.push("runtime");
    });
    const service = new ControlPlaneService({ connect: vi.fn(async () => client) } as any);
    service.setMembershipRevoker(revoker);

    await service.removeMembership("admin-a", "tenant-a", "user-b");

    expect(events).toEqual(["membership", "assignment", "commit", "runtime"]);
    expect(revoker).toHaveBeenCalledWith("tenant-a", "user-b");
  });
});

describe("ControlPlaneService membership revocation", () => {
  it("commits membership and role revocation before draining the runtime principal", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        events.push(normalized);
        if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
          return queryResult();
        }
        if (normalized.includes("from tenants") && normalized.includes("for update")) {
          return queryResult([{ id: "tenant-1" }]);
        }
        if (normalized.includes("count(distinct a.user_id)")) return queryResult([{ count: 1 }]);
        if (normalized.includes("from scoped_role_assignments a")) return queryResult([{ ok: 1 }]);
        if (normalized.includes("from tenant_memberships") && normalized.includes("for update")) {
          return queryResult([{ id: "membership-target" }]);
        }
        if (normalized.includes("role_id='role-template-tenant-admin'")) return queryResult();
        return queryResult();
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const service = new ControlPlaneService(pool);
    const revoke = vi.fn(async () => {
      events.push("runtime-revoked");
    });
    service.setMembershipRevoker(revoke);

    await service.removeMembership("actor", "tenant-1", "target");

    const commitIndex = events.indexOf("commit");
    const runtimeIndex = events.indexOf("runtime-revoked");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(runtimeIndex).toBeGreaterThan(commitIndex);
    expect(revoke).toHaveBeenCalledWith("tenant-1", "target");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/update tenant_memberships[\s\S]*status='removed'/),
      ["tenant-1", "target"],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("delete from scoped_role_assignments"),
      ["tenant-1", "target"],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back without touching runtime when the target is the last active administrator", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized === "begin" || normalized === "rollback") return queryResult();
        if (normalized.includes("from tenants") && normalized.includes("for update")) {
          return queryResult([{ id: "tenant-1" }]);
        }
        if (normalized.includes("count(distinct a.user_id)")) {
          return queryResult([{ count: 1 }]);
        }
        if (normalized.includes("from scoped_role_assignments a")) return queryResult([{ ok: 1 }]);
        if (normalized.includes("from tenant_memberships") && normalized.includes("for update")) {
          return queryResult([{ id: "membership-target" }]);
        }
        if (normalized.includes("select 1 from scoped_role_assignments")) {
          return queryResult([{ admin: true }]);
        }
        return queryResult();
      }),
      release: vi.fn(),
    };
    const service = new ControlPlaneService({ connect: vi.fn(async () => client) } as any);
    const revoke = vi.fn();
    service.setMembershipRevoker(revoke);

    await expect(service.removeMembership("actor", "tenant-1", "target")).rejects.toThrow(
      "last tenant administrator",
    );

    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).replace(/\s+/g, " ").includes("update tenant_memberships set status='removed'"),
      ),
    ).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("serializes concurrent last-admin checks with the tenant row lock", async () => {
    let unlockSecond!: () => void;
    const secondTenantLock = new Promise<void>((resolve) => {
      unlockSecond = resolve;
    });
    const activeAdmins = new Set(["admin-a", "admin-b"]);
    const events: string[] = [];

    const makeClient = (index: number) => ({
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized === "begin") return queryResult();
        if (normalized.includes("from tenants") && normalized.includes("for update")) {
          events.push(`lock:${index}:waiting`);
          if (index === 2) await secondTenantLock;
          events.push(`lock:${index}:acquired`);
          return queryResult([{ id: "tenant-1" }]);
        }
        if (normalized.includes("count(distinct a.user_id)")) {
          return queryResult([{ count: activeAdmins.size }]);
        }
        if (normalized.includes("from scoped_role_assignments a")) return queryResult([{ ok: 1 }]);
        if (normalized.includes("from tenant_memberships") && normalized.includes("for update")) {
          return queryResult([{ id: `membership-${String(params?.[1])}` }]);
        }
        if (normalized.includes("select 1 from scoped_role_assignments")) {
          return queryResult([{ admin: true }]);
        }
        if (normalized.startsWith("update tenant_memberships")) {
          activeAdmins.delete(String(params?.[1]));
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("delete from scoped_role_assignments")) return queryResult();
        if (normalized === "commit") {
          events.push(`commit:${index}`);
          if (index === 1) unlockSecond();
          return queryResult();
        }
        if (normalized === "rollback") {
          events.push(`rollback:${index}`);
          return queryResult();
        }
        return queryResult();
      }),
      release: vi.fn(),
    });
    const clients = [makeClient(1), makeClient(2)];
    const pool = {
      connect: vi.fn(async () => clients.shift()!),
    } as unknown as Pool;
    const service = new ControlPlaneService(pool);
    const revoke = vi.fn().mockResolvedValue(undefined);
    service.setMembershipRevoker(revoke);

    const results = await Promise.allSettled([
      service.removeMembership("platform-actor", "tenant-1", "admin-a"),
      service.removeMembership("platform-actor", "tenant-1", "admin-b"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      message: "The last tenant administrator cannot be removed.",
    });
    expect(events.indexOf("commit:1")).toBeLessThan(events.indexOf("lock:2:acquired"));
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(activeAdmins.size).toBe(1);
  });
});

describe("ControlPlaneService permission membership binding", () => {
  it("exposes the scoped runtime permission check to route guards", async () => {
    const query = vi.fn().mockResolvedValue(queryResult([{ allowed: 1 }]));
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await expect(service.can("user-1", "tenant-1", "runtime:view")).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("p.permission_key=$3"), [
      "user-1",
      "tenant-1",
      "runtime:view",
    ]);
  });

  it("requires active tenant membership for tenant and org assignments while allowing platform roles", async () => {
    const query = vi.fn().mockResolvedValue(queryResult());
    const service = new ControlPlaneService({ query } as unknown as Pool);

    await (service as any).hasTenantPermission("user-1", "tenant-1", "agent:create");
    const tenantSql = String(query.mock.calls.at(-1)?.[0]);
    expect(tenantSql).toContain("a.tenant_id is null");
    expect(tenantSql).toContain("m.status='active'");
    expect(tenantSql).toContain("t.status='active'");

    await (service as any).hasOrgPermission("user-1", "tenant-1", "org-1", "agent:create");
    const orgSql = String(query.mock.calls.at(-1)?.[0]);
    expect(orgSql).toContain("join tenant_memberships m");
    expect(orgSql).toContain("m.status='active'");
    expect(orgSql).toContain("t.status='active'");
  });

  it("clears a runtime tombstone only after a rejoin transaction commits", async () => {
    const events: string[] = [];
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes('from "user"')) return queryResult([{ id: "target" }]);
      if (sql.includes("scoped_role_permissions")) return queryResult([{ ok: 1 }]);
      return queryResult();
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        events.push(normalized);
        if (normalized.includes("returning id"))
          return queryResult([{ id: "existing-membership" }]);
        if (normalized.includes("from tenants")) return queryResult([{ id: "tenant-1" }]);
        if (normalized.includes("from scoped_role_assignments a")) return queryResult([{ ok: 1 }]);
        return queryResult();
      }),
      release: vi.fn(),
    };
    const service = new ControlPlaneService({
      query: poolQuery,
      connect: vi.fn(async () => client),
    } as unknown as Pool);
    const activate = vi.fn(async () => {
      events.push("runtime-activated");
    });
    service.setMembershipActivator(activate);

    const result = await service.addMembership("actor", "tenant-1", "target");

    expect(result.id).toBe("existing-membership");
    expect(events.indexOf("runtime-activated")).toBeGreaterThan(events.indexOf("commit"));
    expect(activate).toHaveBeenCalledWith("tenant-1", "target");
  });
});
