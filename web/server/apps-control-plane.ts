import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import type {
  AppContinueDevelopmentResponse,
  AppCustomDomainRecord,
  AppDeploymentRecord,
  AppListInput,
  AppListResponse,
  AppLeaseRecord,
  AppManifest,
  AppOperationContext,
  AppOperationOutboxRecord,
  AppRecord,
  AppVersionsResponse,
  BeginAppDeploymentInput,
  CompleteAppDeploymentInput,
} from "./apps-types.js";

type Db = Pool | PoolClient;

const APP_SELECT = `
  select a.*,
    d.id domain_id, d.hostname domain_hostname,
    d.cloudflare_connection_id domain_cloudflare_connection_id,
    d.zone_id domain_zone_id,
    d.cloudflare_hostname_id domain_cloudflare_hostname_id,
    d.certificate_id domain_certificate_id,
    d.status domain_status, d.ssl_status domain_ssl_status,
    d.validation_records domain_validation_records, d.error domain_error,
    d.created_at domain_created_at, d.updated_at domain_updated_at,
    d.activated_at domain_activated_at
  from apps a
  left join app_custom_domains d on d.app_id=a.id`;

const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const APP_LOG_BEARER_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const APP_LOG_TOKEN_PATTERN = /\b(?:sk|pk|api|token)[_-][A-Za-z0-9_-]{12,}\b/gi;

function nowIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : nowIso(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function outboxFromRow(row: QueryResultRow): AppOperationOutboxRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    tenantId: String(row.tenant_id),
    operation: row.operation,
    payload: objectValue(row.payload),
    appGeneration: Number(row.app_generation),
    idempotencyKey: String(row.idempotency_key),
    attempts: Number(row.attempts),
    leaseOwner: String(row.lease_owner),
    leaseUntil: nowIso(row.lease_until),
  };
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function domainFromRow(row: QueryResultRow): AppCustomDomainRecord | null {
  if (!row.domain_id) return null;
  return {
    id: String(row.domain_id),
    appId: String(row.id),
    hostname: String(row.domain_hostname),
    cloudflareConnectionId: String(row.domain_cloudflare_connection_id),
    zoneId: String(row.domain_zone_id),
    cloudflareHostnameId: row.domain_cloudflare_hostname_id
      ? String(row.domain_cloudflare_hostname_id)
      : null,
    certificateId: row.domain_certificate_id ? String(row.domain_certificate_id) : null,
    status: row.domain_status,
    sslStatus: row.domain_ssl_status,
    validationRecords: arrayValue(row.domain_validation_records),
    error: row.domain_error ? String(row.domain_error) : null,
    createdAt: nowIso(row.domain_created_at),
    updatedAt: nowIso(row.domain_updated_at),
    activatedAt: nullableIso(row.domain_activated_at),
  };
}

function appFromRow(
  row: QueryResultRow,
  userId: string,
  permissions: ReadonlySet<string>,
): AppRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    ownerMembershipId: String(row.owner_membership_id),
    ownerUserId: String(row.owner_user_id),
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    sourceSessionGeneration: Number(row.source_session_generation || 0),
    tenantHandle: String(row.tenant_handle),
    workerName: String(row.worker_name),
    slug: String(row.slug),
    name: String(row.name),
    status: row.status,
    statusReason: row.status_reason ? String(row.status_reason) : null,
    stableUrl: row.stable_url ? String(row.stable_url) : null,
    screenshotUrl: row.screenshot_url ? String(row.screenshot_url) : null,
    currentDeploymentId: row.current_deployment_id ? String(row.current_deployment_id) : null,
    generation: Number(row.generation || 0),
    customDomain: domainFromRow(row),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
    archivedAt: nullableIso(row.archived_at),
    canManage:
      permissions.has("app:manage-all") ||
      (row.owner_user_id === userId && permissions.has("app:manage-own")),
    targetKind: row.target_kind ?? "unassigned",
    cloudflareConnectionId: row.cloudflare_connection_id
      ? String(row.cloudflare_connection_id)
      : null,
    temporaryPreviewId: row.temporary_preview_id ? String(row.temporary_preview_id) : null,
  };
}

function deploymentFromRow(row: QueryResultRow): AppDeploymentRecord {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    version: Number(row.version),
    phase: row.phase ?? row.status ?? "building",
    targetKind: row.target_kind ?? "unassigned",
    cloudflareConnectionId: row.cloudflare_connection_id
      ? String(row.cloudflare_connection_id)
      : null,
    temporaryPreviewId: row.temporary_preview_id ? String(row.temporary_preview_id) : null,
    sourceSessionId: String(row.source_session_id),
    sourceSessionGeneration: Number(row.source_session_generation || 0),
    sourceDigest: String(row.source_digest),
    artifactKey: row.artifact_key ? String(row.artifact_key) : null,
    manifest: objectValue(row.manifest) as unknown as AppManifest,
    bindingManifest: objectValue(row.binding_manifest),
    cloudflareVersionId: row.cloudflare_version_id ? String(row.cloudflare_version_id) : null,
    cloudflareMigrationTag: row.cloudflare_migration_tag
      ? String(row.cloudflare_migration_tag)
      : null,
    stableUrl: row.stable_url ? String(row.stable_url) : null,
    screenshotUrl: row.screenshot_url ? String(row.screenshot_url) : null,
    warnings: arrayValue(row.warnings),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    rollbackOfDeploymentId: row.rollback_of_deployment_id
      ? String(row.rollback_of_deployment_id)
      : null,
    idempotencyKey: String(row.idempotency_key),
    appGeneration: Number(row.app_generation),
    createdBy: String(row.created_by),
    createdAt: nowIso(row.created_at),
    deployedAt: nullableIso(row.deployed_at),
  };
}

function encodeCursor(timestamp: unknown, id: unknown): string {
  return Buffer.from(JSON.stringify([nowIso(timestamp), String(id)]), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      Number.isNaN(new Date(parsed[0]).valueOf()) ||
      typeof parsed[1] !== "string" ||
      !parsed[1]
    )
      throw new Error();
    return [new Date(parsed[0]).toISOString(), parsed[1]];
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
}

function pageLimit(value?: number): number {
  const parsed = Math.floor(Number(value ?? 25));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 25;
}

function normalizeSlug(value: string | undefined): string {
  const slug = value?.trim().toLowerCase() || "";
  if (!APP_SLUG_PATTERN.test(slug)) {
    throw new Error("App slug must be 1-63 lowercase letters, numbers, or single hyphen runs.");
  }
  return slug;
}

function stableTenantHandle(name: unknown, tenantId: string): string {
  const base =
    String(name || "tenant")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "tenant";
  const suffix = createHash("sha256").update(tenantId).digest("hex").slice(0, 8);
  return `${base}-${suffix}`;
}

function stableWorkerName(appId: string): string {
  return `piwork-app-${appId.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}`.slice(0, 63);
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_PATTERN.test(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("A valid public custom-domain hostname is required.");
  }
  return hostname;
}

function normalizeIdempotencyKey(value?: string): string {
  const key = value?.trim() || randomUUID();
  if (key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error("Invalid idempotency key.");
  }
  return key;
}

function requireExplicitIntent(context: AppOperationContext, action: string): void {
  if (context.mode === "ui") return;
  if (!context.explicitIntent) throw new Error(`Explicit user intent is required to ${action}.`);
}

function requireAgentMutation(context: AppOperationContext): void {
  if (context.mode !== "agent" || !context.rootTask || context.readOnly) {
    throw new Error("Forbidden: App publishing requires an Agent-mode writable root task.");
  }
}

function requireMutation(context: AppOperationContext): void {
  if (context.mode === "ui") return;
  requireAgentMutation(context);
}

function safeErrorMessage(value: unknown): string {
  return redactAppLogValue(value instanceof Error ? value.message : String(value)).slice(0, 1000);
}

export function redactAppLogValue(value: unknown): string {
  return String(value)
    .replace(APP_LOG_BEARER_PATTERN, "[REDACTED]")
    .replace(APP_LOG_TOKEN_PATTERN, "[REDACTED]");
}

export class AppsControlPlane {
  constructor(
    private readonly pool: Pool = new Pool({
      connectionString: getDatabaseUrl() || "postgres://missing-database-url",
    }),
  ) {}

  private async membership(
    db: Db,
    context: Pick<AppOperationContext, "tenantId" | "userId" | "membershipId">,
  ): Promise<QueryResultRow> {
    const result = await db.query(
      `select m.id, m.tenant_id, m.user_id, t.name tenant_name
       from tenant_memberships m join tenants t on t.id=m.tenant_id
       where m.tenant_id=$1 and m.user_id=$2 and m.status='active' and t.status='active'
       limit 1`,
      [context.tenantId, context.userId],
    );
    const row = result.rows[0];
    if (!row || (context.membershipId && row.id !== context.membershipId)) {
      throw new Error("Tenant membership not found.");
    }
    return row;
  }

  private async permissionSet(db: Db, userId: string, tenantId: string): Promise<Set<string>> {
    const result = await db.query(
      `select distinct p.permission_key
       from scoped_role_assignments a
       join scoped_role_permissions p on p.role_id=a.role_id
       join scoped_roles r on r.id=a.role_id and r.deleted_at is null
       where a.user_id=$1 and (a.tenant_id is null or a.tenant_id=$2)`,
      [userId, tenantId],
    );
    return new Set(result.rows.map((row) => String(row.permission_key)));
  }

  private async requireManage(
    db: Db,
    context: Pick<AppOperationContext, "tenantId" | "userId" | "membershipId">,
    app: QueryResultRow,
  ): Promise<Set<string>> {
    await this.membership(db, context);
    const permissions = await this.permissionSet(db, context.userId, context.tenantId);
    const own = app.owner_user_id === context.userId && permissions.has("app:manage-own");
    if (!own && !permissions.has("app:manage-all")) {
      throw new Error("Forbidden by scoped authorization.");
    }
    return permissions;
  }

  private async requireActiveLease(
    db: Db,
    appId: string,
    appGeneration: number,
    leaseToken: string,
  ): Promise<void> {
    const result = await db.query(
      `select 1 from app_leases
       where app_id=$1 and app_generation=$2 and lease_token=$3
         and expires_at > clock_timestamp()
       for update`,
      [appId, appGeneration, leaseToken],
    );
    if (!result.rows[0]) throw new Error("App operation lease is stale or expired.");
  }

  private async readAppRow(db: Db, tenantId: string, appId: string): Promise<QueryResultRow> {
    const result = await db.query(`${APP_SELECT} where a.id=$1 and a.tenant_id=$2`, [
      appId,
      tenantId,
    ]);
    if (!result.rows[0]) throw new Error("App not found.");
    return result.rows[0];
  }

  private async lockedAppRow(db: Db, tenantId: string, appId: string): Promise<QueryResultRow> {
    const result = await db.query(`select * from apps where id=$1 and tenant_id=$2 for update`, [
      appId,
      tenantId,
    ]);
    if (!result.rows[0]) throw new Error("App not found.");
    return result.rows[0];
  }

  async listApps(context: AppOperationContext, input: AppListInput): Promise<AppListResponse> {
    await this.membership(this.pool, context);
    const permissions = await this.permissionSet(this.pool, context.userId, context.tenantId);
    if (!(["current-session", "mine", "tenant"] as const).includes(input.scope)) {
      throw new Error("Invalid App list scope.");
    }
    if (input.scope === "current-session" && !input.sessionId) {
      throw new Error("sessionId is required for current-session scope.");
    }
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const values: unknown[] = [context.tenantId];
    const filters = [`a.tenant_id=$1`];
    if (input.scope === "mine") {
      values.push(context.userId);
      filters.push(`a.owner_user_id=$${values.length}`);
    } else if (input.scope === "current-session") {
      values.push(input.sessionId);
      filters.push(
        `(a.source_session_id=$${values.length} or exists (
          select 1 from app_deployments session_deployment
          where session_deployment.app_id=a.id and session_deployment.source_session_id=$${values.length}
        ))`,
      );
    }
    if (cursor) {
      values.push(cursor[0], cursor[1]);
      filters.push(
        `(a.updated_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length})`,
      );
    }
    values.push(limit + 1);
    const result = await this.pool.query(
      `${APP_SELECT} where ${filters.join(" and ")}
       order by a.updated_at desc, a.id desc limit $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    return {
      apps: rows.map((row) => appFromRow(row, context.userId, permissions)),
      nextCursor:
        result.rows.length > limit && rows.length
          ? encodeCursor(rows.at(-1)?.updated_at, rows.at(-1)?.id)
          : null,
    };
  }

  async getApp(context: AppOperationContext, appId: string): Promise<AppRecord> {
    await this.membership(this.pool, context);
    const [row, permissions] = await Promise.all([
      this.readAppRow(this.pool, context.tenantId, appId),
      this.permissionSet(this.pool, context.userId, context.tenantId),
    ]);
    return appFromRow(row, context.userId, permissions);
  }

  async listVersions(
    context: AppOperationContext,
    appId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<AppVersionsResponse> {
    await this.membership(this.pool, context);
    await this.readAppRow(this.pool, context.tenantId, appId);
    const limit = Math.min(20, pageLimit(requestedLimit));
    const decoded = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : null;
    if (decoded !== null && (!Number.isInteger(decoded) || decoded < 1)) {
      throw new Error("Invalid pagination cursor.");
    }
    const result = await this.pool.query(
      `select * from app_deployments
       where app_id=$1 and ($2::integer is null or version < $2)
       order by version desc limit $3`,
      [appId, decoded, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      versions: rows.map(deploymentFromRow),
      nextCursor:
        result.rows.length > limit && rows.length
          ? Buffer.from(String(rows.at(-1)?.version), "utf8").toString("base64url")
          : null,
    };
  }

  async getDeployment(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
  ): Promise<AppDeploymentRecord> {
    await this.membership(this.pool, context);
    await this.readAppRow(this.pool, context.tenantId, appId);
    const result = await this.pool.query(
      `select * from app_deployments where id=$1 and app_id=$2`,
      [deploymentId, appId],
    );
    if (!result.rows[0]) throw new Error("App deployment not found.");
    return deploymentFromRow(result.rows[0]);
  }

  private async audit(
    db: Db,
    context: Pick<AppOperationContext, "tenantId" | "userId">,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await db.query(
      `insert into control_plane_audit_log
       (id,tenant_id,actor_user_id,action,resource_type,resource_id,metadata)
       values ($1,$2,$3,$4,'app',$5,$6::jsonb)`,
      [
        randomUUID(),
        context.tenantId,
        context.userId,
        action,
        resourceId,
        JSON.stringify(metadata),
      ],
    );
  }

  private async enqueue(
    db: Db,
    input: {
      appId: string;
      tenantId: string;
      operation: "deploy" | "rollback" | "domain_set" | "claim_verify";
      payload?: Record<string, unknown>;
      appGeneration: number;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await db.query(
      `insert into app_operation_outbox
       (id,app_id,tenant_id,operation,payload,app_generation,idempotency_key)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7)
       on conflict (app_id,operation,idempotency_key) do nothing`,
      [
        randomUUID(),
        input.appId,
        input.tenantId,
        input.operation,
        JSON.stringify(input.payload || {}),
        input.appGeneration,
        input.idempotencyKey,
      ],
    );
  }

  private async outboxExists(
    db: Db,
    appId: string,
    operation: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const result = await db.query(
      `select 1 from app_operation_outbox
       where app_id=$1 and operation=$2 and idempotency_key=$3 limit 1`,
      [appId, operation, idempotencyKey],
    );
    return Boolean(result.rowCount);
  }

  async beginDeployment(
    context: AppOperationContext,
    input: BeginAppDeploymentInput,
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }> {
    requireAgentMutation(context);
    if (!context.sessionId) throw new Error("A source session is required to publish an App.");
    if (!Number.isSafeInteger(context.generation) || context.generation < 0) {
      throw new Error("A valid session generation is required.");
    }
    if (!/^[a-f0-9]{64}$/i.test(input.sourceDigest)) {
      throw new Error("A SHA-256 source digest is required.");
    }
    if (input.manifest.version !== 1) throw new Error("Unsupported piwork.app.json version.");
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    const suppliedSlug = input.slug ? normalizeSlug(input.slug) : null;
    const client = await this.pool.connect();
    let appId = input.appId || "";
    let deploymentRow: QueryResultRow | undefined;
    try {
      await client.query("begin");
      const membership = await this.membership(client, context);
      const permissions = await this.permissionSet(client, context.userId, context.tenantId);
      if (!permissions.has("app:publish")) throw new Error("Forbidden by scoped authorization.");

      let app: QueryResultRow | undefined;
      if (input.appId) {
        app = (
          await client.query(`select * from apps where id=$1 and tenant_id=$2 for update`, [
            input.appId,
            context.tenantId,
          ])
        ).rows[0];
        if (!app) throw new Error("App not found.");
      } else if (suppliedSlug) {
        app = (
          await client.query(`select * from apps where tenant_id=$1 and slug=$2 for update`, [
            context.tenantId,
            suppliedSlug,
          ])
        ).rows[0];
      }

      if (app) {
        appId = String(app.id);
        const existing = await client.query(
          `select * from app_deployments where app_id=$1 and idempotency_key=$2`,
          [appId, idempotencyKey],
        );
        if (existing.rows[0]) {
          const existingDeployment = existing.rows[0];
          deploymentRow = existingDeployment;
          await client.query("commit");
          const appRecord = await this.getApp(context, appId);
          return { app: appRecord, deployment: deploymentFromRow(existingDeployment) };
        }
        const own = app.owner_user_id === context.userId && permissions.has("app:manage-own");
        if (!own && !permissions.has("app:manage-all")) {
          throw new Error("Forbidden by scoped authorization.");
        }
        if (suppliedSlug && suppliedSlug !== app.slug) {
          throw new Error("An App slug is immutable after first publish.");
        }
        if (app.status === "archived") {
          throw new Error("Restore the archived App before publishing it.");
        }
        if (
          app.source_session_id === context.sessionId &&
          context.generation < Number(app.source_session_generation || 0)
        ) {
          throw new Error("Stale session generation cannot replace a newer App deployment.");
        }
        const nextGeneration = Number(app.generation) + 1;
        await client.query(
          `update apps set
             source_session_id=$1,source_session_generation=$2,
             source_snapshot_key=coalesce($3,source_snapshot_key),
             name=coalesce(nullif($4,''),name),status='needs_action',status_reason=null,
             generation=$5,archived_at=null,updated_at=clock_timestamp()
           where id=$6`,
          [
            context.sessionId,
            context.generation,
            input.sourceSnapshotKey || null,
            input.name?.trim() || "",
            nextGeneration,
            appId,
          ],
        );
        app = { ...app, generation: nextGeneration };
      } else {
        requireExplicitIntent(context, "publish this App for the first time");
        if (!suppliedSlug) throw new Error("slug is required for the first App publish.");
        appId = randomUUID();
        const name = input.name?.trim() || suppliedSlug;
        await client.query(
          `insert into apps
           (id,tenant_id,owner_membership_id,owner_user_id,source_session_id,
            source_session_generation,source_snapshot_key,tenant_handle,worker_name,
	            slug,name,status,generation,created_by)
	           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'needs_action',1,$4)`,
          [
            appId,
            context.tenantId,
            String(membership.id),
            context.userId,
            context.sessionId,
            context.generation,
            input.sourceSnapshotKey || null,
            stableTenantHandle(membership.tenant_name, context.tenantId),
            stableWorkerName(appId),
            suppliedSlug,
            name,
          ],
        );
        app = { id: appId, generation: 1 };
      }

      const versionResult = await client.query(
        `select coalesce(max(version),0)::integer + 1 version from app_deployments where app_id=$1`,
        [appId],
      );
      const deploymentId = randomUUID();
      const inserted = await client.query(
        `insert into app_deployments
	         (id,app_id,version,phase,source_session_id,source_session_generation,
          source_digest,source_snapshot_key,artifact_key,manifest,binding_manifest,
          rollback_of_deployment_id,idempotency_key,app_generation,created_by)
	         values ($1,$2,$3,'awaiting_target',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)
         returning *`,
        [
          deploymentId,
          appId,
          Number(versionResult.rows[0]?.version || 1),
          context.sessionId,
          context.generation,
          input.sourceDigest.toLowerCase(),
          input.sourceSnapshotKey || null,
          input.artifactKey || null,
          JSON.stringify(input.manifest),
          JSON.stringify(input.bindingManifest),
          input.rollbackOfDeploymentId || null,
          idempotencyKey,
          Number(app.generation),
          context.userId,
        ],
      );
      deploymentRow = inserted.rows[0];
      if (!deploymentRow) throw new Error("App deployment was not created.");
      await this.audit(client, context, "app.deployment.building", appId, {
        deploymentId,
        version: deploymentRow.version,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        throw new Error("App slug already exists in this tenant.");
      }
      throw error;
    } finally {
      client.release();
    }
    if (!deploymentRow) throw new Error("App deployment was not created.");
    return {
      app: await this.getApp(context, appId),
      deployment: deploymentFromRow(deploymentRow),
    };
  }

  async setSourceSnapshotKey(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
    appGeneration: number,
    sourceSnapshotKey: string,
  ): Promise<boolean> {
    requireAgentMutation(context);
    const key = sourceSnapshotKey.trim().replaceAll("\\", "/");
    if (
      !key ||
      key.length > 1024 ||
      key.startsWith("/") ||
      key.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new Error("Source snapshot key must be a safe user-relative path.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      if (Number(app.generation) !== appGeneration) {
        throw new Error("Stale source snapshot cannot overwrite newer App state.");
      }
      const deployment = await client.query(
        `update app_deployments set source_snapshot_key=$1
         where id=$2 and app_id=$3 and app_generation=$4
           and phase in ('building','awaiting_target','awaiting_oauth','queued','provisioning','deploying')
         returning id`,
        [key, deploymentId, appId, appGeneration],
      );
      if (!deployment.rowCount) throw new Error("App deployment not found or already finalized.");
      await client.query(`update apps set source_snapshot_key=$1 where id=$2 and generation=$3`, [
        key,
        appId,
        appGeneration,
      ]);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeploymentDeploying(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
    appGeneration: number,
    leaseToken: string,
  ): Promise<AppDeploymentRecord> {
    requireAgentMutation(context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, appId, appGeneration, leaseToken);
      if (Number(app.generation) !== appGeneration) {
        throw new Error("Stale App operation cannot replace a newer deployment.");
      }
      const result = await client.query(
        `update app_deployments set phase='deploying'
         where id=$1 and app_id=$2 and app_generation=$3
           and phase in ('queued','provisioning','deploying')
         returning *`,
        [deploymentId, appId, appGeneration],
      );
      if (!result.rows[0]) throw new Error("App deployment is not publishable.");
      await client.query(
        `update apps set status='deploying',status_reason=null,updated_at=clock_timestamp()
         where id=$1 and generation=$2`,
        [appId, appGeneration],
      );
      await this.audit(client, context, "app.deployment.deploying", appId, { deploymentId });
      await client.query("commit");
      return deploymentFromRow(result.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDeployment(
    context: AppOperationContext,
    input: CompleteAppDeploymentInput,
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }> {
    requireAgentMutation(context);
    const client = await this.pool.connect();
    let row: QueryResultRow | undefined;
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, input.appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, input.appId, input.appGeneration, input.leaseToken);
      if (Number(app.generation) !== input.appGeneration) {
        throw new Error("Stale App operation cannot replace a newer deployment.");
      }
      const terminal = await client.query(
        `select * from app_deployments where id=$1 and app_id=$2 and app_generation=$3 for update`,
        [input.deploymentId, input.appId, input.appGeneration],
      );
      if (terminal.rows[0]?.phase === input.phase) {
        if (
          terminal.rows[0].cloudflare_version_id !== input.cloudflareVersionId ||
          terminal.rows[0].artifact_key !== input.artifactKey
        ) {
          throw new Error("Completed App deployment conflicts with this idempotent result.");
        }
        await client.query("commit");
        return {
          app: await this.getApp(context, input.appId),
          deployment: deploymentFromRow(terminal.rows[0]),
        };
      }
      const updated = await client.query(
        `update app_deployments set
           phase=$1,cloudflare_version_id=$2,cloudflare_migration_tag=$3,
           stable_url=$4,artifact_key=$5,
           screenshot_url=coalesce($6,screenshot_url),warnings=$7::jsonb,
           error_code=null,error_message=null,deployed_at=clock_timestamp()
         where id=$8 and app_id=$9 and app_generation=$10 and phase='deploying'
         returning *`,
        [
          input.phase,
          input.cloudflareVersionId,
          input.cloudflareMigrationTag || null,
          input.stableUrl,
          input.artifactKey,
          input.screenshotUrl || null,
          JSON.stringify(input.warnings || []),
          input.deploymentId,
          input.appId,
          input.appGeneration,
        ],
      );
      row = updated.rows[0];
      if (!row) throw new Error("App deployment is not ready to complete.");
      await client.query(
        `update apps set status=$1,status_reason=null,current_deployment_id=$2,
           stable_url=$3,screenshot_url=coalesce($4,screenshot_url),
           updated_at=clock_timestamp()
         where id=$5 and generation=$6`,
        [
          input.phase === "temporary_ready" ? "preview" : "ready",
          input.deploymentId,
          input.stableUrl,
          input.screenshotUrl || null,
          input.appId,
          input.appGeneration,
        ],
      );
      await this.audit(client, context, `app.deployment.${input.phase}`, input.appId, {
        deploymentId: input.deploymentId,
        cloudflareVersionId: input.cloudflareVersionId,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!row) throw new Error("App deployment was not completed.");
    return {
      app: await this.getApp(context, input.appId),
      deployment: deploymentFromRow(row),
    };
  }

  async failDeployment(
    context: AppOperationContext,
    input: {
      appId: string;
      deploymentId: string;
      appGeneration: number;
      errorCode: string;
      error: unknown;
      leaseToken?: string;
    },
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }> {
    requireAgentMutation(context);
    const client = await this.pool.connect();
    let row: QueryResultRow | undefined;
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, input.appId);
      await this.requireManage(client, context, app);
      if (input.leaseToken) {
        await this.requireActiveLease(client, input.appId, input.appGeneration, input.leaseToken);
      }
      if (Number(app.generation) !== input.appGeneration) {
        throw new Error("Stale App operation cannot overwrite a newer deployment.");
      }
      const terminal = await client.query(
        `select * from app_deployments where id=$1 and app_id=$2 and app_generation=$3 for update`,
        [input.deploymentId, input.appId, input.appGeneration],
      );
      if (terminal.rows[0]?.phase === "failed") {
        await client.query("commit");
        return {
          app: await this.getApp(context, input.appId),
          deployment: deploymentFromRow(terminal.rows[0]),
        };
      }
      const message = safeErrorMessage(input.error);
      const updated = await client.query(
        `update app_deployments set phase='failed',error_code=$1,error_message=$2
         where id=$3 and app_id=$4 and app_generation=$5
           and phase not in ('ready','expired','failed','cancelled')
         returning *`,
        [
          input.errorCode.slice(0, 100),
          message,
          input.deploymentId,
          input.appId,
          input.appGeneration,
        ],
      );
      row = updated.rows[0];
      if (!row) throw new Error("App deployment is already finalized.");
      await client.query(
        `update apps set status=case
             when current_deployment_id is null then 'failed'
             when exists (select 1 from app_deployments current
               where current.id=apps.current_deployment_id and current.phase='ready') then 'ready'
             else 'preview'
           end,
           status_reason=$1,updated_at=clock_timestamp()
         where id=$2 and generation=$3`,
        [message, input.appId, input.appGeneration],
      );
      await this.audit(client, context, "app.deployment.failed", input.appId, {
        deploymentId: input.deploymentId,
        errorCode: input.errorCode.slice(0, 100),
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!row) throw new Error("App deployment was not failed.");
    return {
      app: await this.getApp(context, input.appId),
      deployment: deploymentFromRow(row),
    };
  }

  async rollback(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }> {
    requireMutation(context);
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    const client = await this.pool.connect();
    let row: QueryResultRow | undefined;
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      if (app.status === "archived") {
        throw new Error("Archived Apps cannot be rolled back.");
      }
      if (["building", "deploying"].includes(String(app.status))) {
        throw new Error("App has another deployment in progress.");
      }
      const existing = await client.query(
        `select * from app_deployments where app_id=$1 and idempotency_key=$2`,
        [appId, idempotencyKey],
      );
      if (existing.rows[0]) {
        row = existing.rows[0];
        await client.query("commit");
      } else {
        const target = await client.query(
          `select * from app_deployments
           where id=$1 and app_id=$2 and phase='ready' and cloudflare_version_id is not null`,
          [deploymentId, appId],
        );
        const targetRow = target.rows[0];
        if (!targetRow) throw new Error("Rollback deployment not found or artifact unavailable.");
        const versionResult = await client.query(
          `select coalesce(max(version),0)::integer + 1 version from app_deployments where app_id=$1`,
          [appId],
        );
        const nextGeneration = Number(app.generation) + 1;
        const rollbackId = randomUUID();
        const inserted = await client.query(
          `insert into app_deployments
           (id,app_id,version,phase,source_session_id,source_session_generation,
            source_digest,source_snapshot_key,artifact_key,manifest,binding_manifest,
            rollback_of_deployment_id,idempotency_key,app_generation,created_by)
           values ($1,$2,$3,'awaiting_target',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           returning *`,
          [
            rollbackId,
            appId,
            Number(versionResult.rows[0]?.version || 1),
            targetRow.source_session_id,
            targetRow.source_session_generation,
            targetRow.source_digest,
            targetRow.source_snapshot_key,
            targetRow.artifact_key,
            targetRow.manifest,
            targetRow.binding_manifest,
            deploymentId,
            idempotencyKey,
            nextGeneration,
            // The rollback reuses the historical immutable artifact and
            // source snapshot, so retain their creator authority even when a
            // tenant administrator initiates the rollback.
            targetRow.created_by,
          ],
        );
        row = inserted.rows[0];
        await client.query(
          `update apps set status='needs_action',status_reason=null,generation=$1,
             source_session_id=$2,source_session_generation=$3,
             source_snapshot_key=coalesce($4,source_snapshot_key),updated_at=clock_timestamp()
           where id=$5`,
          [
            nextGeneration,
            targetRow.source_session_id,
            targetRow.source_session_generation,
            targetRow.source_snapshot_key,
            appId,
          ],
        );
        await this.audit(client, context, "app.rollback.awaiting_target", appId, {
          deploymentId: rollbackId,
          rollbackOfDeploymentId: deploymentId,
        });
        await client.query("commit");
      }
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!row) throw new Error("Rollback was not created.");
    return { app: await this.getApp(context, appId), deployment: deploymentFromRow(row) };
  }

  async setCustomDomain(
    context: AppOperationContext,
    appId: string,
    input: { hostname: string; connectionId: string; zoneId: string; leaseToken: string },
  ): Promise<AppRecord> {
    requireMutation(context);
    requireExplicitIntent(context, "configure a custom App domain");
    const hostname = normalizeHostname(input.hostname);
    const connectionId = input.connectionId.trim();
    const zoneId = input.zoneId.trim();
    if (!connectionId || connectionId.length > 200 || !zoneId || zoneId.length > 128) {
      throw new Error("Cloudflare connectionId and zoneId are required.");
    }
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, appId, Number(app.generation), input.leaseToken);
      if (await this.outboxExists(client, appId, "domain_set", idempotencyKey)) {
        await client.query("commit");
        return this.getApp(context, appId);
      }
      if (app.status === "archived") {
        throw new Error("Archived Apps cannot configure a custom domain.");
      }
      if (
        app.status !== "ready" ||
        app.target_kind !== "byoc" ||
        app.cloudflare_connection_id !== connectionId
      ) {
        throw new Error("Custom domains require the App's ready OAuth BYOC target.");
      }
      if (["building", "deploying"].includes(String(app.status))) {
        throw new Error("App has another deployment in progress.");
      }
      await client.query(
        `insert into app_custom_domains
         (id,app_id,hostname,cloudflare_connection_id,zone_id,status,ssl_status,created_by)
         values ($1,$2,$3,$4,$5,'pending','pending_validation',$6)
         on conflict (app_id) do update set
           hostname=excluded.hostname,cloudflare_connection_id=excluded.cloudflare_connection_id,
           zone_id=excluded.zone_id,cloudflare_hostname_id=null,certificate_id=null,status='pending',
           ssl_status='pending_validation',validation_records='[]'::jsonb,error=null,
           updated_at=clock_timestamp(),activated_at=null`,
        [randomUUID(), appId, hostname, connectionId, zoneId, context.userId],
      );
      await client.query(`update apps set updated_at=clock_timestamp() where id=$1`, [appId]);
      await this.enqueue(client, {
        appId,
        tenantId: context.tenantId,
        operation: "domain_set",
        payload: { hostname, connectionId, zoneId },
        appGeneration: Number(app.generation),
        idempotencyKey,
      });
      await this.audit(client, context, "app.domain.set", appId, {
        hostname,
        connectionId,
        zoneId,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") {
        throw new Error("Custom domain is already assigned to another App.");
      }
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async removeCustomDomain(
    context: AppOperationContext,
    appId: string,
    expected: { hostname: string; connectionId: string; zoneId: string; leaseToken: string },
  ): Promise<AppRecord> {
    requireMutation(context);
    requireExplicitIntent(context, "remove this App custom domain");
    const idempotencyKey = normalizeIdempotencyKey(context.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, appId, Number(app.generation), expected.leaseToken);
      if (await this.outboxExists(client, appId, "domain_set", idempotencyKey)) {
        await client.query("commit");
        return this.getApp(context, appId);
      }
      if (["building", "deploying"].includes(String(app.status))) {
        throw new Error("App has another deployment in progress.");
      }
      const domain = await client.query(
        `select * from app_custom_domains where app_id=$1 for update`,
        [appId],
      );
      if (!domain.rows[0]) throw new Error("App custom domain not found.");
      if (
        domain.rows[0].hostname !== normalizeHostname(expected.hostname) ||
        domain.rows[0].cloudflare_connection_id !== expected.connectionId.trim() ||
        domain.rows[0].zone_id !== expected.zoneId.trim()
      ) {
        throw new Error("Stale custom-domain removal request.");
      }
      if (domain.rows[0]) {
        await client.query(
          `update app_custom_domains set status='removing',updated_at=clock_timestamp() where app_id=$1`,
          [appId],
        );
        await client.query(`update apps set updated_at=clock_timestamp() where id=$1`, [appId]);
        await this.enqueue(client, {
          appId,
          tenantId: context.tenantId,
          operation: "domain_set",
          payload: {
            action: "detach",
            hostname: domain.rows[0].hostname,
            cloudflareHostnameId: domain.rows[0].cloudflare_hostname_id,
          },
          appGeneration: Number(app.generation),
          idempotencyKey,
        });
        await this.audit(client, context, "app.domain.remove", appId, {
          hostname: domain.rows[0].hostname,
        });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async archive(context: AppOperationContext, appId: string): Promise<AppRecord> {
    requireMutation(context);
    requireExplicitIntent(context, "archive this App");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      if (app.status !== "archived") {
        const nextGeneration = Number(app.generation) + 1;
        await client.query(
          `update apps set status='archived',status_reason=null,generation=$1,
             target_kind='unassigned',cloudflare_connection_id=null,temporary_preview_id=null,
             archived_at=clock_timestamp(),
             updated_at=clock_timestamp() where id=$2`,
          [nextGeneration, appId],
        );
        await this.audit(client, context, "app.archived", appId, { unlinkOnly: true });
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async restore(context: AppOperationContext, appId: string): Promise<AppRecord> {
    requireMutation(context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      if (app.status !== "archived") throw new Error("App is not archived.");
      const nextGeneration = Number(app.generation) + 1;
      await client.query(
        `update apps set status='needs_action',status_reason=null,generation=$1,
           target_kind='unassigned',cloudflare_connection_id=null,temporary_preview_id=null,
           archived_at=null,updated_at=clock_timestamp() where id=$2`,
        [nextGeneration, appId],
      );
      await this.audit(client, context, "app.restored", appId);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async continueDevelopment(
    context: AppOperationContext,
    appId: string,
  ): Promise<AppContinueDevelopmentResponse> {
    await this.membership(this.pool, context);
    const row = await this.readAppRow(this.pool, context.tenantId, appId);
    if (row.owner_user_id !== context.userId) {
      throw new Error("Forbidden: only the App owner can access its source snapshot.");
    }
    return {
      appId,
      sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
      sourceSnapshotKey: row.source_snapshot_key ? String(row.source_snapshot_key) : null,
      restoreRequired: !row.source_session_id,
    };
  }

  async rename(context: AppOperationContext, appId: string, nameInput: string): Promise<AppRecord> {
    requireMutation(context);
    const name = nameInput.trim();
    if (!name || name.length > 120) throw new Error("App name must contain 1-120 characters.");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      await client.query(`update apps set name=$1,updated_at=clock_timestamp() where id=$2`, [
        name,
        appId,
      ]);
      await this.audit(client, context, "app.renamed", appId, { name });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async markCustomDomainState(
    context: AppOperationContext,
    input: {
      appId: string;
      appGeneration: number;
      hostname: string;
      cloudflareHostnameId?: string;
      certificateId?: string;
      status: "pending" | "active" | "failed";
      sslStatus: "pending_validation" | "pending_issuance" | "active" | "failed";
      validationRecords?: Array<{ type: string; name: string; value: string }>;
      error?: string;
      leaseToken: string;
    },
  ): Promise<AppRecord> {
    requireAgentMutation(context);
    const hostname = normalizeHostname(input.hostname);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, input.appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, input.appId, input.appGeneration, input.leaseToken);
      if (Number(app.generation) !== input.appGeneration) {
        throw new Error("Stale custom-domain result cannot overwrite newer App state.");
      }
      const updated = await client.query(
        `update app_custom_domains set cloudflare_hostname_id=coalesce($1,cloudflare_hostname_id),
           certificate_id=coalesce($2,certificate_id),status=$3,ssl_status=$4,
           validation_records=$5::jsonb,error=$6,
           updated_at=clock_timestamp(),
           activated_at=case when $3='active' and $4='active' then clock_timestamp() else null end
         where app_id=$7 and hostname=$8 returning id`,
        [
          input.cloudflareHostnameId || null,
          input.certificateId || null,
          input.status,
          input.sslStatus,
          JSON.stringify(input.validationRecords || []),
          input.error ? safeErrorMessage(input.error) : null,
          input.appId,
          hostname,
        ],
      );
      if (!updated.rowCount) throw new Error("App custom domain not found.");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, input.appId);
  }

  async finishCustomDomainRemoval(
    context: AppOperationContext,
    appId: string,
    appGeneration: number,
    leaseToken: string,
  ): Promise<AppRecord> {
    requireAgentMutation(context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const app = await this.lockedAppRow(client, context.tenantId, appId);
      await this.requireManage(client, context, app);
      await this.requireActiveLease(client, appId, appGeneration, leaseToken);
      if (Number(app.generation) !== appGeneration) {
        throw new Error("Stale custom-domain removal cannot overwrite newer App state.");
      }
      await client.query(`delete from app_custom_domains where app_id=$1 and status='removing'`, [
        appId,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getApp(context, appId);
  }

  async acquireLease(
    appId: string,
    holder: string,
    appGeneration: number,
    ttlMs = 30_000,
  ): Promise<AppLeaseRecord | null> {
    const leaseToken = randomUUID();
    const ttl = Math.max(1_000, Math.min(300_000, Math.floor(ttlMs)));
    const result = await this.pool.query(
      `insert into app_leases
       (app_id,lease_token,holder,app_generation,expires_at)
       select $1,$2,$3,$4,clock_timestamp()+($5::text || ' milliseconds')::interval
       from apps where id=$1 and generation=$4 and status <> 'archived'
       on conflict (app_id) do update set
         lease_token=excluded.lease_token,holder=excluded.holder,
         app_generation=excluded.app_generation,acquired_at=clock_timestamp(),
         expires_at=excluded.expires_at
       where app_leases.expires_at <= clock_timestamp() or app_leases.holder=excluded.holder
       returning *`,
      [appId, leaseToken, holder.slice(0, 200), appGeneration, ttl],
    );
    const row = result.rows[0];
    return row
      ? {
          appId: String(row.app_id),
          leaseToken: String(row.lease_token),
          holder: String(row.holder),
          appGeneration: Number(row.app_generation),
          expiresAt: nowIso(row.expires_at),
        }
      : null;
  }

  async releaseLease(appId: string, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from app_leases where app_id=$1 and lease_token=$2 returning app_id`,
      [appId, leaseToken],
    );
    return Boolean(result.rowCount);
  }

  async renewLease(
    appId: string,
    leaseToken: string,
    appGeneration: number,
    ttlMs = 300_000,
  ): Promise<boolean> {
    const ttl = Math.max(1_000, Math.min(300_000, Math.floor(ttlMs)));
    const result = await this.pool.query(
      `update app_leases l set expires_at=clock_timestamp()+($1::text || ' milliseconds')::interval
       where l.app_id=$2 and l.lease_token=$3 and l.app_generation=$4
         and l.expires_at > clock_timestamp()
         and exists (select 1 from apps a where a.id=l.app_id and a.generation=l.app_generation)
       returning l.app_id`,
      [ttl, appId, leaseToken, appGeneration],
    );
    return Boolean(result.rowCount);
  }

  async claimOutbox(
    workerId: string,
    limit = 10,
    leaseMs = 30_000,
  ): Promise<AppOperationOutboxRecord[]> {
    const ttl = Math.max(1_000, Math.min(300_000, Math.floor(leaseMs)));
    const result = await this.pool.query(
      `with candidates as (
         select id from app_operation_outbox
         where (state='pending' or (state='leased' and lease_until <= clock_timestamp()))
           and available_at <= clock_timestamp()
         order by created_at
         for update skip locked limit $1
       )
       update app_operation_outbox o set state='leased',lease_owner=$2,
         lease_until=clock_timestamp()+($3::text || ' milliseconds')::interval,
         attempts=o.attempts+1
       from candidates c where o.id=c.id returning o.*`,
      [Math.max(1, Math.min(100, Math.floor(limit))), workerId.slice(0, 200), ttl],
    );
    return result.rows.map(outboxFromRow);
  }

  /** Claims only deploy/rollback work owned by one active tenant membership. */
  async claimDeploymentOutboxForPrincipal(
    context: { tenantId: string; userId: string; membershipId: string },
    workerId: string,
    limit = 10,
    leaseMs = 30_000,
  ): Promise<AppOperationOutboxRecord[]> {
    const ttl = Math.max(1_000, Math.min(300_000, Math.floor(leaseMs)));
    const result = await this.pool.query(
      `with candidates as (
         select o.id from app_operation_outbox o
         join tenant_memberships m on m.id=$4 and m.tenant_id=o.tenant_id
           and m.user_id=$3 and m.status='active'
         where o.tenant_id=$2 and o.operation in ('deploy','rollback')
           and o.payload->>'userId'=$3 and o.payload->>'membershipId'=$4
           and (o.state='pending' or (o.state='leased' and o.lease_until <= clock_timestamp()))
           and o.available_at <= clock_timestamp()
         order by o.created_at
         for update of o skip locked limit $1
       )
       update app_operation_outbox o set state='leased',lease_owner=$5,
         lease_until=clock_timestamp()+($6::text || ' milliseconds')::interval,
         attempts=o.attempts+1
       from candidates c where o.id=c.id returning o.*`,
      [
        Math.max(1, Math.min(100, Math.floor(limit))),
        context.tenantId,
        context.userId,
        context.membershipId,
        workerId.slice(0, 200),
        ttl,
      ],
    );
    return result.rows.map(outboxFromRow);
  }

  async completeOutbox(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update app_operation_outbox o set state='completed',completed_at=clock_timestamp(),
         lease_owner=null,lease_until=null
       where o.id=$1 and o.state='leased' and o.lease_owner=$2
         and exists (select 1 from apps a where a.id=o.app_id and a.generation=o.app_generation)
       returning o.id`,
      [id, workerId],
    );
    if (result.rowCount) return true;
    await this.pool.query(
      `update app_operation_outbox set state='failed',last_error='stale app generation',
         lease_owner=null,lease_until=null
       where id=$1 and state='leased' and lease_owner=$2`,
      [id, workerId],
    );
    return false;
  }

  async completeOutboxByKey(
    appId: string,
    operation: AppOperationOutboxRecord["operation"],
    idempotencyKey: string,
    appGeneration: number,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update app_operation_outbox o set state='completed',completed_at=clock_timestamp(),
         lease_owner=null,lease_until=null
       where o.app_id=$1 and o.operation=$2 and o.idempotency_key=$3
         and o.app_generation=$4 and o.state in ('pending','leased')
         and exists (select 1 from apps a where a.id=o.app_id and a.generation=o.app_generation)
         and exists (select 1 from app_leases l where l.app_id=o.app_id
           and l.app_generation=o.app_generation and l.lease_token=$5
           and l.expires_at > clock_timestamp())
       returning o.id`,
      [appId, operation, idempotencyKey, appGeneration, leaseToken],
    );
    return Boolean(result.rowCount);
  }

  async failOutboxByKey(
    appId: string,
    operation: AppOperationOutboxRecord["operation"],
    idempotencyKey: string,
    appGeneration: number,
    leaseToken: string,
    error: unknown,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update app_operation_outbox set state='failed',last_error=$1,
         lease_owner=null,lease_until=null
       where app_id=$2 and operation=$3 and idempotency_key=$4
         and app_generation=$5 and state in ('pending','leased')
         and exists (select 1 from app_leases l where l.app_id=app_operation_outbox.app_id
           and l.app_generation=app_operation_outbox.app_generation and l.lease_token=$6
           and l.expires_at > clock_timestamp())
       returning id`,
      [safeErrorMessage(error), appId, operation, idempotencyKey, appGeneration, leaseToken],
    );
    return Boolean(result.rowCount);
  }

  async failClaimedOutbox(id: string, workerId: string, error: unknown): Promise<boolean> {
    const result = await this.pool.query(
      `update app_operation_outbox set state='failed',last_error=$1,
         lease_owner=null,lease_until=null
       where id=$2 and state='leased' and lease_owner=$3 returning id`,
      [safeErrorMessage(error), id, workerId],
    );
    return Boolean(result.rowCount);
  }

  async retryOutbox(id: string, workerId: string, error: unknown): Promise<boolean> {
    const result = await this.pool.query(
      `update app_operation_outbox set state=case when attempts >= 10 then 'failed' else 'pending' end,
         available_at=clock_timestamp()+(least(300, power(2,least(attempts,8)))::text || ' seconds')::interval,
         last_error=$1,lease_owner=null,lease_until=null
       where id=$2 and state='leased' and lease_owner=$3 returning id`,
      [safeErrorMessage(error), id, workerId],
    );
    return Boolean(result.rowCount);
  }
}
