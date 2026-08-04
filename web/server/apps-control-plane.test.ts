import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AppsControlPlane } from "./apps-control-plane.js";
import type { AppOperationContext, AppRecord } from "./apps-types.js";

const agentContext: AppOperationContext = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "member-1",
  sessionId: "session-1",
  generation: 4,
  rootTask: true,
  readOnly: false,
  mode: "agent",
  explicitIntent: true,
  idempotencyKey: "request-1",
};

describe("AppsControlPlane safety gates", () => {
  it("claims deployment outbox work only for one active user membership", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "outbox-1",
          app_id: "app-1",
          tenant_id: "tenant-1",
          operation: "deploy",
          payload: {
            userId: "user-1",
            membershipId: "member-1",
            deploymentId: "deployment-1",
            target: "byoc",
            connectionId: "connection-1",
            temporaryAccountId: null,
          },
          app_generation: 3,
          idempotency_key: "deploy:key",
          attempts: 2,
          lease_owner: "worker-1",
          lease_until: "2026-08-04T00:00:30.000Z",
        },
      ],
      rowCount: 1,
    });
    const service = new AppsControlPlane({ query } as unknown as Pool);

    await expect(
      service.claimDeploymentOutboxForPrincipal(
        { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
        "worker-1",
        5,
        20_000,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "outbox-1",
        operation: "deploy",
        appGeneration: 3,
        leaseOwner: "worker-1",
      }),
    ]);

    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("o.operation in ('deploy','rollback')");
    expect(sql).toContain("m.status='active'");
    expect(sql).toContain("o.payload->>'userId'=$3");
    expect(sql).toContain("o.payload->>'membershipId'=$4");
    expect(parameters).toEqual([5, "tenant-1", "user-1", "member-1", "worker-1", 20_000]);
  });

  it("fences by-key outbox settlement with an active App lease", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "outbox-1" }], rowCount: 1 });
    const service = new AppsControlPlane({ query } as unknown as Pool);

    await expect(
      service.completeOutboxByKey("app-1", "deploy", "deploy:key", 7, "lease-1"),
    ).resolves.toBe(true);
    await expect(
      service.failOutboxByKey(
        "app-1",
        "rollback",
        "rollback:key",
        7,
        "lease-2",
        new Error("failed"),
      ),
    ).resolves.toBe(true);
    await expect(
      service.failClaimedOutbox("outbox-1", "worker-1", new Error("malformed")),
    ).resolves.toBe(true);

    const [completeSql, completeParameters] = query.mock.calls[0]!;
    expect(completeSql).toContain("l.lease_token=$5");
    expect(completeSql).toContain("l.expires_at > clock_timestamp()");
    expect(completeParameters).toEqual(["app-1", "deploy", "deploy:key", 7, "lease-1"]);
    const [failSql, failParameters] = query.mock.calls[1]!;
    expect(failSql).toContain("l.lease_token=$6");
    expect(failSql).toContain("l.expires_at > clock_timestamp()");
    expect(failParameters).toEqual(["failed", "app-1", "rollback", "rollback:key", 7, "lease-2"]);
    const [claimedFailSql, claimedFailParameters] = query.mock.calls[2]!;
    expect(claimedFailSql).toContain("state='leased' and lease_owner=$3");
    expect(claimedFailParameters).toEqual(["malformed", "outbox-1", "worker-1"]);
  });

  it.each([
    { mode: "plan" as const, rootTask: true, readOnly: true },
    { mode: "agent" as const, rootTask: false, readOnly: false },
    { mode: "agent" as const, rootTask: true, readOnly: true },
  ])("rejects publish mutations outside a writable Agent root task", async (patch) => {
    const connect = vi.fn();
    const service = new AppsControlPlane({ connect } as unknown as Pool);

    await expect(
      service.beginDeployment(
        { ...agentContext, ...patch },
        {
          slug: "demo",
          sourceDigest: "a".repeat(64),
          manifest: {
            version: 1,
            runtime: "cloudflare-workers",
            exposure: { workersDev: true },
          },
          bindingManifest: {},
        },
      ),
    ).rejects.toThrow(/Agent-mode writable root task/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects malformed immutable slugs before opening a transaction", async () => {
    const connect = vi.fn();
    const service = new AppsControlPlane({ connect } as unknown as Pool);

    await expect(
      service.beginDeployment(agentContext, {
        slug: "../tenant-escape",
        sourceDigest: "a".repeat(64),
        manifest: {
          version: 1,
          runtime: "cloudflare-workers",
          exposure: { workersDev: true },
        },
        bindingManifest: {},
      }),
    ).rejects.toThrow(/App slug/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects invalid pagination, generation, snapshot, domain, and idempotency inputs early", async () => {
    const connect = vi.fn();
    const service = new AppsControlPlane({ connect } as unknown as Pool);
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      if (normalized.includes("from tenant_memberships")) {
        return { rows: [{ id: "member-1" }], rowCount: 1 };
      }
      if (normalized.includes("from scoped_role_assignments")) {
        return { rows: [{ permission_key: "app:manage-own" }], rowCount: 1 };
      }
      if (
        normalized.includes("from apps a left join") ||
        normalized.includes("select * from apps")
      ) {
        return { rows: [{ id: "app-1", owner_user_id: "user-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const readService = new AppsControlPlane({ query } as unknown as Pool);

    await expect(readService.listApps(agentContext, { scope: "invalid" as never })).rejects.toThrow(
      /Invalid App list scope/,
    );
    await expect(readService.listApps(agentContext, { scope: "current-session" })).rejects.toThrow(
      /sessionId is required/,
    );
    await expect(readService.listVersions(agentContext, "app-1", "not-a-number")).rejects.toThrow(
      /Invalid pagination cursor/,
    );
    await expect(
      service.beginDeployment(
        { ...agentContext, generation: -1 },
        {
          slug: "demo",
          sourceDigest: "a".repeat(64),
          manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
          bindingManifest: {},
        },
      ),
    ).rejects.toThrow(/valid session generation/);
    await expect(
      service.beginDeployment(agentContext, {
        slug: "demo",
        sourceDigest: "not-a-digest",
        manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
        bindingManifest: {},
      }),
    ).rejects.toThrow(/SHA-256 source digest/);
    await expect(
      service.beginDeployment(
        { ...agentContext, idempotencyKey: "contains spaces" },
        {
          slug: "demo",
          sourceDigest: "a".repeat(64),
          manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
          bindingManifest: {},
        },
      ),
    ).rejects.toThrow(/Invalid idempotency key/);
    await expect(
      service.setSourceSnapshotKey(agentContext, "app-1", "deployment-1", 1, "../escape"),
    ).rejects.toThrow(/safe user-relative path/);
    await expect(
      service.setCustomDomain(agentContext, "app-1", {
        hostname: "app.localhost",
        connectionId: "connection-1",
        zoneId: "zone-1",
        leaseToken: "lease-1",
      }),
    ).rejects.toThrow(/valid public custom-domain/);
    await expect(
      service.markCustomDomainState(agentContext, {
        appId: "app-1",
        appGeneration: 1,
        hostname: "not a hostname",
        status: "failed",
        sslStatus: "failed",
        leaseToken: "lease-1",
      }),
    ).rejects.toThrow(/valid public custom-domain/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("never exposes another member's source snapshot through continue development", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: "member-1", tenant_id: "tenant-1", user_id: "user-1" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "app-1",
            tenant_id: "tenant-1",
            owner_user_id: "user-2",
            source_snapshot_key: "published-apps/app-1/source.tar",
          },
        ],
      });
    const service = new AppsControlPlane({ query } as unknown as Pool);

    await expect(service.continueDevelopment(agentContext, "app-1")).rejects.toThrow(
      /only the App owner/,
    );
  });

  it("archives an App link without deleting its deployment resources", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback")
        return { rows: [], rowCount: 0 };
      if (sql.includes("select * from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              tenant_id: "tenant-1",
              owner_user_id: "user-1",
              generation: 4,
              status: "ready",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from tenant_memberships")) {
        return { rows: [{ id: "member-1", tenant_name: "Tenant" }], rowCount: 1 };
      }
      if (sql.includes("from scoped_role_assignments")) {
        return { rows: [{ permission_key: "app:manage-own" }], rowCount: 1 };
      }
      if (sql.includes("select 1 from app_operation_outbox")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AppsControlPlane({
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool);
    const archived = { id: "app-1", status: "archived" } as AppRecord;
    vi.spyOn(service, "getApp").mockResolvedValue(archived);

    await expect(service.archive(agentContext, "app-1")).resolves.toBe(archived);

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("update apps set status='archived'"),
      [5, "app-1"],
    );
    const archiveSql = String(
      clientQuery.mock.calls.find(([sql]) => String(sql).includes("status='archived'"))?.[0],
    );
    expect(archiveSql).toContain("target_kind='unassigned'");
    expect(archiveSql).toContain("cloudflare_connection_id=null");
    expect(archiveSql).toContain("temporary_preview_id=null");
    expect(archiveSql).not.toContain("stable_url=");
    expect(clientQuery.mock.calls.some(([sql]) => /^\s*delete\s/iu.test(String(sql)))).toBe(false);
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into app_operation_outbox"),
      expect.anything(),
    );
  });

  it("rejects a stale custom-domain provider result after its App lease is lost", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select * from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              tenant_id: "tenant-1",
              owner_user_id: "user-1",
              generation: 4,
              status: "ready",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from tenant_memberships")) {
        return { rows: [{ id: "member-1", tenant_name: "Tenant" }], rowCount: 1 };
      }
      if (sql.includes("from scoped_role_assignments")) {
        return { rows: [{ permission_key: "app:manage-own" }], rowCount: 1 };
      }
      if (sql.includes("select 1 from app_leases")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const service = new AppsControlPlane({
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    } as unknown as Pool);

    await expect(
      service.markCustomDomainState(agentContext, {
        appId: "app-1",
        appGeneration: 4,
        hostname: "app.example.com",
        status: "active",
        sslStatus: "active",
        leaseToken: "lost-domain-lease",
      }),
    ).rejects.toThrow(/lease is stale or expired/i);

    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("update app_custom_domains"),
      expect.anything(),
    );
  });

  it.each(["temporary_ready", "ready"] as const)(
    "restores archived %s history as needs_action without relinking a target",
    async (deploymentPhase) => {
      const clientQuery = vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "commit" || sql === "rollback") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("select * from apps where")) {
          return {
            rows: [
              {
                id: "app-1",
                tenant_id: "tenant-1",
                owner_user_id: "user-1",
                generation: 4,
                status: "archived",
                current_deployment_id: "deployment-1",
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("from tenant_memberships")) {
          return { rows: [{ id: "member-1", tenant_name: "Tenant" }], rowCount: 1 };
        }
        if (sql.includes("from scoped_role_assignments")) {
          return { rows: [{ permission_key: "app:manage-own" }], rowCount: 1 };
        }
        if (sql.includes("select 1 from app_operation_outbox")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("select phase from app_deployments")) {
          return { rows: [{ phase: deploymentPhase }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });
      const client = { query: clientQuery, release: vi.fn() };
      const service = new AppsControlPlane({
        connect: vi.fn().mockResolvedValue(client),
      } as unknown as Pool);
      const restored = {
        id: "app-1",
        status: "needs_action",
        targetKind: "unassigned",
      } as AppRecord;
      vi.spyOn(service, "getApp").mockResolvedValue(restored);

      await expect(service.restore(agentContext, "app-1")).resolves.toBe(restored);

      expect(clientQuery).toHaveBeenCalledWith(
        expect.stringContaining("update apps set status='needs_action'"),
        [5, "app-1"],
      );
      const restoreSql = String(
        clientQuery.mock.calls.find(([sql]) => String(sql).includes("status='needs_action'"))?.[0],
      );
      expect(restoreSql).toContain("target_kind='unassigned'");
      expect(restoreSql).toContain("cloudflare_connection_id=null");
      expect(restoreSql).toContain("temporary_preview_id=null");
      expect(restoreSql).not.toContain("stable_url=");
      expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("select phase"))).toBe(
        false,
      );
      expect(clientQuery).not.toHaveBeenCalledWith(
        expect.stringContaining("insert into app_operation_outbox"),
        expect.anything(),
      );
    },
  );
});
