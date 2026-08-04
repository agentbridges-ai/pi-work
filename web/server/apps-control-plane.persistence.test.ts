import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AppsControlPlane, redactAppLogValue } from "./apps-control-plane.js";
import {
  APP_DEPLOYMENT_PHASES,
  APP_DOMAIN_STATUSES,
  APP_SSL_STATUSES,
  APP_STATUSES,
  type AppOperationContext,
} from "./apps-types.js";

const context: AppOperationContext = {
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

function appRow(): Record<string, unknown> {
  return {
    id: "app-1",
    tenant_id: "tenant-1",
    owner_membership_id: "member-1",
    owner_user_id: "user-1",
    source_session_id: "session-1",
    source_session_generation: 4,
    source_snapshot_key: "app-1/sources/deployment-1",
    tenant_handle: "tenant-12345678",
    worker_name: "piwork-app-app-1",
    slug: "demo",
    name: "Demo",
    status: "ready",
    status_reason: null,
    stable_url: "https://demo.example.workers.dev",
    screenshot_url: null,
    current_deployment_id: "deployment-1",
    generation: 4,
    target_kind: "byoc",
    cloudflare_connection_id: "connection-1",
    temporary_preview_id: null,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    archived_at: null,
    domain_id: "domain-1",
    domain_hostname: "app.example.com",
    domain_cloudflare_connection_id: "connection-1",
    domain_zone_id: "zone-1",
    domain_cloudflare_hostname_id: "hostname-1",
    domain_certificate_id: "certificate-1",
    domain_status: "active",
    domain_ssl_status: "active",
    domain_validation_records: [],
    domain_error: null,
    domain_created_at: "2026-08-04T00:00:00.000Z",
    domain_updated_at: "2026-08-04T00:00:00.000Z",
    domain_activated_at: "2026-08-04T00:00:00.000Z",
  };
}

function deploymentRow(phase = "deploying"): Record<string, unknown> {
  return {
    id: "deployment-1",
    app_id: "app-1",
    version: 1,
    phase,
    target_kind: "byoc",
    cloudflare_connection_id: "connection-1",
    temporary_preview_id: null,
    source_session_id: "session-1",
    source_session_generation: 4,
    source_digest: "a".repeat(64),
    source_snapshot_key: "app-1/sources/deployment-1",
    artifact_key: "creator-artifact:artifact-1",
    manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
    binding_manifest: {},
    cloudflare_version_id: "version-1",
    cloudflare_migration_tag: null,
    stable_url: "https://demo.example.workers.dev",
    screenshot_url: null,
    warnings: [],
    error_code: null,
    error_message: null,
    rollback_of_deployment_id: null,
    idempotency_key: "request-1",
    app_generation: 4,
    created_by: "user-1",
    created_at: "2026-08-04T00:00:00.000Z",
    deployed_at: "2026-08-04T00:01:00.000Z",
  };
}

function outboxRow(): Record<string, unknown> {
  return {
    id: "outbox-1",
    app_id: "app-1",
    tenant_id: "tenant-1",
    operation: "deploy",
    payload: { userId: "user-1", membershipId: "member-1" },
    app_generation: 4,
    idempotency_key: "request-1",
    attempts: 1,
    lease_owner: "worker-1",
    lease_until: "2026-08-04T00:02:00.000Z",
  };
}

function makePool() {
  const currentApp = appRow();
  const currentDeployment = deploymentRow();
  const domain = {
    id: "domain-1",
    app_id: "app-1",
    hostname: "app.example.com",
    cloudflare_connection_id: "connection-1",
    zone_id: "zone-1",
    cloudflare_hostname_id: "hostname-1",
    certificate_id: "certificate-1",
    status: "active",
    ssl_status: "active",
    validation_records: [],
    error: null,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    activated_at: "2026-08-04T00:00:00.000Z",
  };
  const lease = {
    app_id: "app-1",
    lease_token: "lease-1",
    holder: "worker-1",
    app_generation: 4,
    expires_at: "2026-08-04T00:02:00.000Z",
  };
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.trim().replace(/\s+/g, " ");
    if (["begin", "commit", "rollback"].includes(normalized)) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes("from tenant_memberships")) {
      return {
        rows: [{ id: "member-1", tenant_id: "tenant-1", user_id: "user-1", tenant_name: "Tenant" }],
        rowCount: 1,
      };
    }
    if (normalized.includes("from scoped_role_assignments")) {
      return {
        rows: [{ permission_key: "app:publish" }, { permission_key: "app:manage-own" }],
        rowCount: 2,
      };
    }
    if (normalized.includes("select 1 from app_leases")) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (normalized.includes("select 1 from app_operation_outbox")) return { rows: [], rowCount: 0 };
    if (normalized.includes("from app_custom_domains where"))
      return { rows: [domain], rowCount: 1 };
    if (normalized.includes("from apps a left join")) return { rows: [currentApp], rowCount: 1 };
    if (normalized.includes("select * from apps where")) return { rows: [currentApp], rowCount: 1 };
    if (normalized.includes("select coalesce(max(version)"))
      return { rows: [{ version: 2 }], rowCount: 1 };
    if (normalized.includes("phase='ready'"))
      return { rows: [deploymentRow("ready")], rowCount: 1 };
    if (normalized.includes("from app_deployments"))
      return { rows: [currentDeployment], rowCount: 1 };
    if (normalized.includes("insert into app_leases")) return { rows: [lease], rowCount: 1 };
    if (normalized.includes("update app_leases")) return { rows: [lease], rowCount: 1 };
    if (normalized.includes("delete from app_leases"))
      return { rows: [{ app_id: "app-1" }], rowCount: 1 };
    if (normalized.includes("update app_deployments")) {
      return {
        rows: [deploymentRow(normalized.includes("phase='failed'") ? "failed" : "ready")],
        rowCount: 1,
      };
    }
    if (normalized.includes("insert into app_deployments"))
      return { rows: [currentDeployment], rowCount: 1 };
    if (normalized.includes("idempotency_key")) return { rows: [], rowCount: 0 };
    if (normalized.includes("update app_custom_domains"))
      return { rows: [{ id: "domain-1" }], rowCount: 1 };
    if (
      normalized.includes("update app_operation_outbox") ||
      normalized.includes("insert into app_operation_outbox")
    ) {
      return { rows: [outboxRow()], rowCount: 1 };
    }
    if (normalized.includes("delete from app_custom_domains")) return { rows: [], rowCount: 1 };
    if (normalized.includes("returning id")) return { rows: [{ id: "outbox-1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return { pool: { query, connect: vi.fn().mockResolvedValue(client) }, currentApp };
}

describe("AppsControlPlane persistence paths", () => {
  it("keeps the public status contracts and cursor scopes explicit", async () => {
    expect(APP_STATUSES).toEqual([
      "building",
      "needs_action",
      "deploying",
      "preview",
      "ready",
      "failed",
      "archived",
    ]);
    expect(APP_DEPLOYMENT_PHASES).toContain("verifying_claim");
    expect(APP_DOMAIN_STATUSES).toEqual(["pending", "active", "failed", "removing"]);
    expect(APP_SSL_STATUSES).toContain("pending_issuance");

    const { pool } = makePool();
    const service = new AppsControlPlane(pool as unknown as Pool);
    const cursor = Buffer.from(
      JSON.stringify(["2026-08-04T00:00:00.000Z", "app-0"]),
      "utf8",
    ).toString("base64url");
    await expect(service.listApps(context, { scope: "mine", cursor })).resolves.toMatchObject({
      apps: [expect.objectContaining({ id: "app-1" })],
    });
    await expect(
      service.listApps(context, { scope: "current-session", sessionId: "session-1", cursor }),
    ).resolves.toMatchObject({ apps: [expect.objectContaining({ id: "app-1" })] });
    const versionCursor = Buffer.from("1", "utf8").toString("base64url");
    await expect(service.listVersions(context, "app-1", versionCursor)).resolves.toMatchObject({
      versions: [expect.objectContaining({ id: "deployment-1" })],
    });
    await expect(
      service.listApps(context, { scope: "tenant", cursor: "not-a-cursor" }),
    ).rejects.toThrow("Invalid pagination cursor");
  });

  it("covers read, deployment, domain, lifecycle, lease, and outbox transitions", async () => {
    const { pool, currentApp } = makePool();
    const service = new AppsControlPlane(pool as unknown as Pool);

    await expect(service.listApps(context, { scope: "tenant", limit: 1 })).resolves.toMatchObject({
      apps: [expect.objectContaining({ id: "app-1" })],
    });
    await expect(service.getApp(context, "app-1")).resolves.toMatchObject({ id: "app-1" });
    await expect(service.listVersions(context, "app-1")).resolves.toMatchObject({
      versions: [expect.objectContaining({ id: "deployment-1" })],
    });
    await expect(service.getDeployment(context, "app-1", "deployment-1")).resolves.toMatchObject({
      id: "deployment-1",
    });
    await expect(
      service.beginDeployment(context, {
        appId: "app-1",
        sourceDigest: "b".repeat(64),
        manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
        bindingManifest: {},
        artifactKey: "creator-artifact:artifact-2",
      }),
    ).resolves.toMatchObject({ deployment: { id: "deployment-1" } });
    await expect(
      service.setSourceSnapshotKey(context, "app-1", "deployment-1", 4, "sources/current.tar"),
    ).resolves.toBe(true);
    await expect(
      service.markDeploymentDeploying(context, "app-1", "deployment-1", 4, "lease-1"),
    ).resolves.toMatchObject({ id: "deployment-1" });
    await expect(
      service.completeDeployment(context, {
        appId: "app-1",
        deploymentId: "deployment-1",
        appGeneration: 4,
        leaseToken: "lease-1",
        phase: "ready",
        cloudflareVersionId: "version-1",
        stableUrl: "https://demo.example.workers.dev",
        artifactKey: "creator-artifact:artifact-2",
      }),
    ).resolves.toMatchObject({ deployment: { id: "deployment-1" } });
    await expect(
      service.failDeployment(context, {
        appId: "app-1",
        deploymentId: "deployment-1",
        appGeneration: 4,
        errorCode: "provider_failed",
        error: new Error("provider failed token_123456789012"),
        leaseToken: "lease-1",
      }),
    ).resolves.toMatchObject({ deployment: { id: "deployment-1" } });
    await expect(service.rollback(context, "app-1", "deployment-1")).resolves.toMatchObject({
      deployment: { id: "deployment-1" },
    });
    const domainInput = {
      hostname: "app.example.com",
      connectionId: "connection-1",
      zoneId: "zone-1",
      leaseToken: "lease-1",
    };
    await expect(service.setCustomDomain(context, "app-1", domainInput)).resolves.toMatchObject({
      id: "app-1",
    });
    await expect(service.removeCustomDomain(context, "app-1", domainInput)).resolves.toMatchObject({
      id: "app-1",
    });
    await expect(
      service.markCustomDomainState(context, {
        appId: "app-1",
        appGeneration: 4,
        hostname: "app.example.com",
        status: "active",
        sslStatus: "active",
        leaseToken: "lease-1",
      }),
    ).resolves.toMatchObject({ id: "app-1" });
    await expect(
      service.finishCustomDomainRemoval(context, "app-1", 4, "lease-1"),
    ).resolves.toMatchObject({ id: "app-1" });
    await expect(service.rename(context, "app-1", "Renamed")).resolves.toMatchObject({
      id: "app-1",
    });
    await expect(service.continueDevelopment(context, "app-1")).resolves.toMatchObject({
      appId: "app-1",
      sourceSnapshotKey: expect.any(String),
    });
    await expect(service.archive(context, "app-1")).resolves.toMatchObject({ id: "app-1" });
    currentApp.status = "archived";
    await expect(service.restore(context, "app-1")).resolves.toMatchObject({ id: "app-1" });
    await expect(service.acquireLease("app-1", "worker-1", 4, 20_000)).resolves.toMatchObject({
      appId: "app-1",
    });
    await expect(service.renewLease("app-1", "lease-1", 4)).resolves.toBe(true);
    await expect(service.releaseLease("app-1", "lease-1")).resolves.toBe(true);
    await expect(service.claimOutbox("worker-1")).resolves.toHaveLength(1);
    await expect(service.completeOutbox("outbox-1", "worker-1")).resolves.toBe(true);
    await expect(
      service.completeOutboxByKey("app-1", "deploy", "request-1", 4, "lease-1"),
    ).resolves.toBe(true);
    await expect(
      service.failOutboxByKey("app-1", "deploy", "request-1", 4, "lease-1", "failed"),
    ).resolves.toBe(true);
    await expect(service.failClaimedOutbox("outbox-1", "worker-1", "failed")).resolves.toBe(true);
    await expect(service.retryOutbox("outbox-1", "worker-1", "retry")).resolves.toBe(true);
  });

  it("rejects invalid App scopes and immutable deployment inputs before mutation", async () => {
    const { pool, currentApp } = makePool();
    currentApp.created_at = "not-a-date";
    const service = new AppsControlPlane(pool as unknown as Pool);

    await expect(service.listApps(context, { scope: "invalid" as never })).rejects.toThrow(
      "Invalid App list scope",
    );
    await expect(service.listApps(context, { scope: "current-session" })).rejects.toThrow(
      "sessionId is required",
    );
    await expect(
      service.listVersions(context, "app-1", Buffer.from("0", "utf8").toString("base64url")),
    ).rejects.toThrow("Invalid pagination cursor");
    await expect(
      service.listApps(context, { scope: "tenant", limit: 1 }),
    ).resolves.toMatchObject({ apps: [expect.objectContaining({ createdAt: "1970-01-01T00:00:00.000Z" })] });

    const deploymentInput = {
      slug: "demo",
      sourceDigest: "a".repeat(64),
      manifest: { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } },
      bindingManifest: {},
    } as const;
    await expect(
      service.beginDeployment({ ...context, generation: -1 }, deploymentInput),
    ).rejects.toThrow("session generation");
    await expect(
      service.beginDeployment({ ...context, idempotencyKey: "bad key" }, deploymentInput),
    ).rejects.toThrow("idempotency key");
    await expect(
      service.beginDeployment(context, { ...deploymentInput, sourceDigest: "bad" }),
    ).rejects.toThrow("SHA-256");
    await expect(
      service.beginDeployment(context, {
        ...deploymentInput,
        manifest: { ...deploymentInput.manifest, version: 2 as never },
      }),
    ).rejects.toThrow("Unsupported");
    await expect(
      service.setSourceSnapshotKey(context, "app-1", "deployment-1", 4, "../escape"),
    ).rejects.toThrow("safe user-relative path");
    expect(redactAppLogValue("Bearer secret_123456789012 and token_123456789012")).toBe(
      "[REDACTED] and [REDACTED]",
    );
  });
});
