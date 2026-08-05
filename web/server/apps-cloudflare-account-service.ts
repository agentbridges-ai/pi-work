import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import { decryptSecret, encryptSecret, type EncryptedSecretPayload } from "./secret-cipher.js";
import { ENV, envFlag, environment } from "./environment.js";
import { TemporaryPreviewAbuseGuard } from "./apps-cloudflare-abuse.js";
import {
  assertTemporaryAppEligible,
  parsePiworkAppManifest,
  type PiworkAppManifestV1,
} from "./app-manifest.js";
import type {
  AppCloudflareAccountConnection,
  AppCloudflareAccountContext,
  AppCloudflareOAuthPurpose,
  AppCloudflareConnectionScope,
  AppCloudflareDeploymentCredential,
  AppCloudflareDeploymentEvent,
  AppCloudflareDeploymentProjection,
  AppCloudflareDeploymentTarget,
  AppCloudflareQueuedDeployment,
  AppCloudflareResourceKind,
  AppCloudflareResourceReceipt,
  AppCloudflareResourceStepStatus,
  AppCloudflareTargetRecord,
  AppCloudflareTemporaryAccount,
  AppCloudflareZone,
} from "./apps-cloudflare-account-types.js";
import {
  CLOUDFLARE_OAUTH_ATTEMPT_LIFETIME_MS,
  CLOUDFLARE_PRIVACY_POLICY_URL,
  CLOUDFLARE_TEMPORARY_ACCOUNT_LIFETIME_MS,
  CLOUDFLARE_TERMS_OF_SERVICE_URL,
  createPkceMaterial,
  hashOAuthState,
  HttpAppCloudflareAccountClient,
  type AppCloudflareAccountClient,
  type CloudflareOAuthTokenResult,
  type CloudflareTemporaryAccountResult,
} from "./apps-cloudflare-account-client.js";
import {
  CLOUDFLARE_PERMISSION_NAMES,
  parseCloudflareOAuthScopeCatalog,
  resolveCloudflareOAuthScopes,
  verifyCloudflareProviderScopeCatalog,
  type CloudflareOAuthScopeCatalog,
} from "./apps-cloudflare-oauth-scopes.js";

type Db = Pick<Pool | PoolClient, "query">;

interface StoredOAuthCredential {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  grantedScopes: string[];
  accessExpiresAt: string | null;
}

interface StoredTemporaryCredential {
  apiToken: string;
  tokenId: string | null;
}

interface TemporaryClaimBinding {
  appId: string;
  deploymentId: string;
  appGeneration: number;
  phase: string;
  stableUrl: string | null;
  currentDeploymentId: string | null;
}

const TEMPORARY_ACCOUNT_MISMATCH_MESSAGE =
  "Cloudflare OAuth account does not match the temporary preview. Select the same temporary account, or explicitly redeploy to the other account.";
const TEMPORARY_ACCOUNT_EXPIRED_MESSAGE =
  "Cloudflare temporary account expired. Select a new publishing target to continue.";
const OAUTH_CANCELLED_MESSAGE =
  "Cloudflare authorization was cancelled. Retry the account connection to continue.";

export class AppCloudflareNeedsOAuthError extends Error {
  readonly code = "needs_oauth" as const;
  readonly requiredPermissionNames: string[];

  constructor(requiredPermissionNames: string[]) {
    super("Cloudflare account needs additional OAuth permissions.");
    this.name = "AppCloudflareNeedsOAuthError";
    this.requiredPermissionNames = [...requiredPermissionNames];
  }
}

export interface AppCloudflareAccountServiceOptions {
  client?: AppCloudflareAccountClient;
  abuseGuard?: TemporaryPreviewAbuseGuard;
  masterKey?: () => string;
  now?: () => Date;
  temporaryEnabled?: () => boolean;
  byocEnabled?: () => boolean;
  scopeCatalog?: () => CloudflareOAuthScopeCatalog;
  turnstileEnabled?: () => boolean;
  verifyTurnstile?: (token: string, ipAddress: string) => Promise<boolean>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function safeTimestamp(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} is invalid.`);
  return new Date(timestamp).toISOString();
}

function isLoopbackAddress(value: string): boolean {
  const address = value.trim().toLowerCase();
  return (
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((entry): entry is string => typeof entry === "string" && !!entry)),
  ];
}

function connectionFromRow(row: QueryResultRow): AppCloudflareAccountConnection {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    scope: row.scope,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    ownerMembershipId: row.owner_membership_id ? String(row.owner_membership_id) : null,
    accountId: String(row.account_id),
    accountName: String(row.account_name),
    grantedScopes: stringArray(row.granted_scopes),
    status: row.status,
    accessExpiresAt: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null,
    lastRefreshedAt: row.last_refreshed_at ? new Date(row.last_refreshed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function temporaryFromRow(row: QueryResultRow, now: Date): AppCloudflareTemporaryAccount {
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const secretPresent = Boolean(row.claim_ciphertext && row.claim_iv && row.claim_auth_tag);
  return {
    id: String(row.id),
    appId: String(row.app_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    ownerMembershipId: String(row.owner_membership_id),
    accountId: row.account_id ? String(row.account_id) : null,
    accountName: row.account_name ? String(row.account_name) : null,
    status: row.status,
    accountExpiresAt: row.account_expires_at
      ? new Date(row.account_expires_at).toISOString()
      : null,
    claimExpiresAt: row.claim_expires_at ? new Date(row.claim_expires_at).toISOString() : null,
    expiresAt: expiresAt?.toISOString() || null,
    claimAvailable:
      secretPresent &&
      (row.status === "ready" || row.status === "claiming") &&
      Boolean(expiresAt && expiresAt.getTime() > now.getTime()),
    claimedConnectionId: row.claimed_connection_id ? String(row.claimed_connection_id) : null,
    policiesAcceptedAt: new Date(row.policies_accepted_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function encryptedFromRow(row: QueryResultRow, prefix: string): EncryptedSecretPayload {
  const ciphertext = row[`${prefix}_ciphertext`];
  const iv = row[`${prefix}_iv`];
  const authTag = row[`${prefix}_auth_tag`];
  const keyVersion = row[`${prefix}_key_version`];
  if (!ciphertext || !iv || !authTag || !keyVersion) {
    throw new Error("Cloudflare credential is unavailable.");
  }
  return {
    ciphertext: String(ciphertext),
    iv: String(iv),
    authTag: String(authTag),
    keyVersion: Number(keyVersion),
  };
}

function parseStoredJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Cloudflare credential envelope is invalid.");
  }
}

function normalizeReturnPath(value: string | undefined): string {
  const path = value?.trim() || "/apps";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("OAuth return path must be a same-origin absolute path.");
  }
  const parsed = new URL(path, "https://piwork.invalid");
  if (parsed.origin !== "https://piwork.invalid") {
    throw new Error("OAuth return path must be a same-origin absolute path.");
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function receiptFromRow(row: QueryResultRow): AppCloudflareResourceReceipt {
  return {
    id: String(row.id),
    appId: String(row.app_id),
    deploymentId: String(row.deployment_id),
    target: row.target_kind,
    connectionId: row.cloudflare_connection_id ? String(row.cloudflare_connection_id) : null,
    temporaryAccountId: row.temporary_preview_id ? String(row.temporary_preview_id) : null,
    logicalKey: String(row.logical_key),
    resourceKind: row.resource_kind,
    mode: row.mode,
    ownership: row.ownership,
    externalId: row.external_id ? String(row.external_id) : null,
    externalName: row.external_name ? String(row.external_name) : null,
    stepStatus: row.step_status,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

function deploymentProjectionFromRow(
  row: QueryResultRow,
  context: AppCloudflareAccountContext,
  now: Date,
): AppCloudflareDeploymentProjection {
  const manifest = parsePiworkAppManifest(row.manifest);
  const previewExpiresAt = row.preview_expires_at ? new Date(row.preview_expires_at) : null;
  const ownsPreview =
    row.preview_owner_user_id === context.userId &&
    row.preview_owner_membership_id === context.membershipId;
  return {
    id: String(row.id),
    appId: String(row.app_id),
    version: Number(row.version),
    phase: String(row.phase),
    targetKind: (row.target_kind || "unassigned") as AppCloudflareDeploymentTarget,
    sourceDigest: String(row.source_digest),
    cloudflareVersionId: row.cloudflare_version_id ? String(row.cloudflare_version_id) : null,
    stableUrl: row.stable_url ? String(row.stable_url) : null,
    requestedCustomDomain: manifest.exposure.requestedCustomDomain || null,
    temporaryPreview: row.preview_id
      ? {
          id: String(row.preview_id),
          expiresAt: previewExpiresAt?.toISOString() || null,
          claimExpiresAt: row.preview_claim_expires_at
            ? new Date(row.preview_claim_expires_at).toISOString()
            : null,
          claimAvailable:
            ownsPreview &&
            Boolean(row.preview_claim_ciphertext) &&
            (row.preview_status === "ready" || row.preview_status === "claiming") &&
            Boolean(previewExpiresAt && previewExpiresAt.getTime() > now.getTime()),
        }
      : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at).toISOString(),
    deployedAt: row.deployed_at ? new Date(row.deployed_at).toISOString() : null,
    current: row.current_deployment_id === row.id,
  };
}

function auditActionPhase(action: string): string | null {
  if (action.endsWith(".building")) return "building";
  if (action.endsWith(".deployment_target.selected")) return "queued";
  if (action.endsWith(".deploying")) return "deploying";
  if (action.endsWith(".claim_opened")) return "claim_pending";
  if (action.endsWith(".temporary.account_mismatch")) return "claim_pending";
  if (action.endsWith(".ready") || action.endsWith(".connection.created")) return "ready";
  if (action.includes("failed") || action.includes("mismatch")) return "failed";
  return null;
}

const RECEIPT_SECRET_KEY_PATTERN =
  /(?:token|secret|password|authorization|credential|claim.?url|api.?key|x.?auth.?key)/iu;
const RECEIPT_SECRET_VALUE_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/iu,
  /\b(?:cloudflare|cf)[_-]?(?:api[_-]?)?(?:token|key|secret)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
  /\b(?:access|refresh|claim|api)[_-]?(?:token|key|secret)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
  /(?:[?&]|\b)(?:token|access_token|refresh_token|claimToken|api_key)=[^\s&#]{8,}/iu,
  /\bx-auth-key\b\s*[:=]\s*[^\s,;]{8,}/iu,
] as const;

function assertSafeReceiptValue(value: unknown): void {
  if (typeof value === "string") {
    if (RECEIPT_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error("Cloudflare resource receipt contains credential material.");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (RECEIPT_SECRET_KEY_PATTERN.test(key)) {
      throw new Error("Cloudflare resource receipt contains a forbidden secret field.");
    }
    assertSafeReceiptValue(nested);
  }
}

function safeReceiptMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const metadata = value || {};
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1_024) {
    throw new Error("Cloudflare resource receipt metadata exceeds 16 KiB.");
  }
  const normalized = JSON.parse(serialized) as Record<string, unknown>;
  assertSafeReceiptValue(normalized);
  return normalized;
}

function effectiveTemporaryExpiry(
  result: CloudflareTemporaryAccountResult,
  now: Date,
): {
  accountExpiresAt: string;
  claimExpiresAt: string;
  expiresAt: string;
} {
  const accountExpiresAt = safeTimestamp(result.accountExpiresAt, "accountExpiresAt");
  const claimExpiresAt = safeTimestamp(result.claimExpiresAt, "claimExpiresAt");
  const limit = now.getTime() + CLOUDFLARE_TEMPORARY_ACCOUNT_LIFETIME_MS;
  const effective = Math.min(Date.parse(accountExpiresAt), Date.parse(claimExpiresAt), limit);
  if (effective <= now.getTime())
    throw new Error("Cloudflare temporary account is already expired.");
  return { accountExpiresAt, claimExpiresAt, expiresAt: new Date(effective).toISOString() };
}

export class AppCloudflareAccountService {
  private readonly client: AppCloudflareAccountClient;
  private readonly getMasterKey: () => string;
  private readonly now: () => Date;
  private readonly abuseGuard: TemporaryPreviewAbuseGuard;
  private readonly temporaryEnabled: () => boolean;
  private readonly byocEnabled: () => boolean;
  private readonly getScopeCatalog: () => CloudflareOAuthScopeCatalog;
  private readonly turnstileEnabled: () => boolean;
  private readonly verifyTurnstile: (token: string, ipAddress: string) => Promise<boolean>;
  private readonly refreshFlights = new Map<string, Promise<AppCloudflareAccountConnection>>();

  constructor(
    private readonly pool: Pool = new Pool({
      connectionString: getDatabaseUrl() || "postgres://missing-database-url",
    }),
    options: AppCloudflareAccountServiceOptions = {},
  ) {
    this.client =
      options.client ||
      new HttpAppCloudflareAccountClient({
        oauthClientId: environment.optionalString(ENV.PIWORK_APPS_CLOUDFLARE_OAUTH_CLIENT_ID),
        oauthClientSecret: environment.optionalString(
          ENV.PIWORK_APPS_CLOUDFLARE_OAUTH_CLIENT_SECRET,
          false,
        ),
        oauthRedirectUri: environment.optionalString(ENV.PIWORK_APPS_CLOUDFLARE_OAUTH_REDIRECT_URI),
      });
    this.getMasterKey =
      options.masterKey ||
      (() => {
        const key = environment.optionalString(ENV.PIWORK_APPS_CLOUDFLARE_CREDENTIAL_KEY, false);
        if (!key) {
          throw new Error("PIWORK_APPS_CLOUDFLARE_CREDENTIAL_KEY is required.");
        }
        return key;
      });
    this.now = options.now || (() => new Date());
    this.abuseGuard =
      options.abuseGuard ||
      new TemporaryPreviewAbuseGuard({
        maxPerUserOrIpPerHour: environment.number(ENV.PIWORK_APPS_TEMPORARY_MAX_PER_HOUR, 3),
        maxPerUserOrIpPerDay: environment.number(ENV.PIWORK_APPS_TEMPORARY_MAX_PER_DAY, 10),
        maxActivePerApp: environment.number(ENV.PIWORK_APPS_TEMPORARY_MAX_ACTIVE_PER_APP, 1),
        maxProofOfWorkConcurrency: environment.number(
          ENV.PIWORK_APPS_TEMPORARY_MAX_POW_CONCURRENCY,
          2,
        ),
      });
    this.temporaryEnabled =
      options.temporaryEnabled || (() => envFlag(ENV.PIWORK_APPS_TEMPORARY_ENABLED));
    this.byocEnabled = options.byocEnabled || (() => envFlag(ENV.PIWORK_APPS_BYOC_ENABLED));
    this.getScopeCatalog =
      options.scopeCatalog ||
      (() => {
        const catalog = environment.optionalString(
          ENV.PIWORK_APPS_CLOUDFLARE_OAUTH_SCOPE_CATALOG,
          false,
        );
        if (!catalog) throw new Error("Cloudflare OAuth scope catalog is not configured.");
        return parseCloudflareOAuthScopeCatalog(catalog);
      });
    this.turnstileEnabled =
      options.turnstileEnabled || (() => envFlag(ENV.PIWORK_APPS_TURNSTILE_ENABLED));
    this.verifyTurnstile =
      options.verifyTurnstile ||
      (async (token, ipAddress) => {
        const secret = environment.optionalString(ENV.PIWORK_APPS_TURNSTILE_SECRET_KEY, false);
        if (!secret) throw new Error("Cloudflare Turnstile is not configured.");
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret, response: token, remoteip: ipAddress }),
        });
        if (!response.ok) return false;
        const result = (await response.json()) as { success?: unknown };
        return result.success === true;
      });
  }

  private requireTemporaryEnabled(): void {
    if (!this.temporaryEnabled()) {
      throw new Error("Cloudflare temporary App publishing is disabled.");
    }
  }

  private requireByocEnabled(): void {
    if (!this.byocEnabled()) throw new Error("Cloudflare BYOC publishing is disabled.");
  }

  private async verifyProviderScopes(accessToken: string, requiredNames: string[]): Promise<void> {
    const catalog = this.getScopeCatalog();
    const provider = await this.client.listOAuthScopes(accessToken);
    verifyCloudflareProviderScopeCatalog(catalog, provider, requiredNames);
  }

  private scopeNamesForIds(ids: string[]): string[] {
    const catalog = this.getScopeCatalog();
    const namesById = new Map([...catalog.scopes].map(([name, id]) => [id, name]));
    return ids.map((id) => {
      const name = namesById.get(id);
      if (!name) throw new Error("Cloudflare OAuth grant contains an unknown scope.");
      return name;
    });
  }

  private assertConnectionGrants(connection: QueryResultRow, bindingManifest: unknown): void {
    const required = resolveCloudflareOAuthScopes(this.getScopeCatalog(), bindingManifest);
    const granted = new Set(stringArray(connection.granted_scopes));
    if (required.ids.some((id) => !granted.has(id))) {
      throw new AppCloudflareNeedsOAuthError(required.names);
    }
  }

  private masterKey(): string {
    const key = this.getMasterKey();
    if (Buffer.from(key, "base64").length !== 32) {
      throw new Error(
        "PIWORK_APPS_CLOUDFLARE_CREDENTIAL_KEY must be a base64-encoded 32-byte key.",
      );
    }
    return key;
  }

  private encrypt(value: unknown, aad: string): EncryptedSecretPayload {
    return encryptSecret(JSON.stringify(value), this.masterKey(), 1, aad);
  }

  private decrypt<T>(row: QueryResultRow, prefix: string, aad: string): T {
    return parseStoredJson<T>(decryptSecret(encryptedFromRow(row, prefix), this.masterKey(), aad));
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async membership(db: Db, context: AppCloudflareAccountContext): Promise<void> {
    const result = await db.query(
      `select m.id from tenant_memberships m join tenants t on t.id=m.tenant_id
       where m.id=$1 and m.tenant_id=$2 and m.user_id=$3
         and m.status='active' and t.status='active' limit 1`,
      [context.membershipId, context.tenantId, context.userId],
    );
    if (!result.rows[0]) throw new Error("Tenant membership not found.");
  }

  private async hasPermission(
    db: Db,
    context: AppCloudflareAccountContext,
    permission: string,
  ): Promise<boolean> {
    const result = await db.query(
      `select 1 from scoped_role_assignments a
       join scoped_role_permissions p on p.role_id=a.role_id
       join scoped_roles r on r.id=a.role_id and r.deleted_at is null
       where a.user_id=$1 and (a.tenant_id is null or a.tenant_id=$2)
         and p.permission_key=$3 limit 1`,
      [context.userId, context.tenantId, permission],
    );
    return Boolean(result.rows[0]);
  }

  private async requireTenantConnectionPermission(
    db: Db,
    context: AppCloudflareAccountContext,
  ): Promise<void> {
    if (!(await this.hasPermission(db, context, "app:manage-all"))) {
      throw new Error("Forbidden by scoped authorization.");
    }
  }

  private async requireManageApp(
    db: Db,
    context: AppCloudflareAccountContext,
    appId: string,
  ): Promise<QueryResultRow> {
    const result = await db.query(`select * from apps where id=$1 and tenant_id=$2 limit 1`, [
      appId,
      context.tenantId,
    ]);
    const app = result.rows[0];
    if (!app) throw new Error("App not found.");
    const own =
      app.owner_user_id === context.userId &&
      (await this.hasPermission(db, context, "app:manage-own"));
    if (!own && !(await this.hasPermission(db, context, "app:manage-all"))) {
      throw new Error("Forbidden by scoped authorization.");
    }
    return app;
  }

  private async temporaryClaimBinding(
    db: Db,
    context: AppCloudflareAccountContext,
    temporaryAccountId: string,
    appId: string,
    forUpdate = false,
  ): Promise<TemporaryClaimBinding> {
    const result = await db.query(
      `select d.id,d.app_id,d.app_generation,d.phase,d.stable_url,
              a.current_deployment_id
       from app_deployments d
       join apps a on a.id=d.app_id and a.tenant_id=$3
       where d.temporary_preview_id=$1 and d.app_id=$2
         and d.app_generation=a.generation
       order by d.version desc limit 1${forUpdate ? " for update of d,a" : ""}`,
      [temporaryAccountId, appId, context.tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Cloudflare temporary deployment is unavailable or stale.");
    return {
      appId: String(row.app_id),
      deploymentId: String(row.id),
      appGeneration: Number(row.app_generation),
      phase: String(row.phase),
      stableUrl: row.stable_url ? String(row.stable_url) : null,
      currentDeploymentId: row.current_deployment_id ? String(row.current_deployment_id) : null,
    };
  }

  private async reusableTemporaryAccount(
    db: Db,
    context: AppCloudflareAccountContext,
  ): Promise<QueryResultRow | undefined> {
    const result = await db.query(
      `select * from cloudflare_temporary_previews
       where tenant_id=$1 and owner_user_id=$2
         and status='ready' and expires_at > $3
       order by created_at desc,id desc limit 1`,
      [context.tenantId, context.userId, this.now().toISOString()],
    );
    return result.rows[0];
  }

  private async enqueueDeploymentOutbox(
    db: Db,
    context: AppCloudflareAccountContext,
    deployment: QueryResultRow,
    target: Exclude<AppCloudflareDeploymentTarget, "unassigned">,
    connectionId: string | null,
    temporaryAccountId: string | null,
  ): Promise<void> {
    const operation = deployment.rollback_of_deployment_id ? "rollback" : "deploy";
    const payload = {
      userId: context.userId,
      membershipId: context.membershipId,
      deploymentId: String(deployment.id),
      target,
      connectionId,
      temporaryAccountId,
    };
    await db.query(
      `insert into app_operation_outbox
       (id,app_id,tenant_id,operation,payload,app_generation,idempotency_key)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7)
       on conflict (app_id,operation,idempotency_key)
       do update set payload=excluded.payload,app_generation=excluded.app_generation`,
      [
        randomUUID(),
        deployment.app_id,
        context.tenantId,
        operation,
        JSON.stringify(payload),
        Number(deployment.app_generation),
        requiredString(deployment.idempotency_key, "deployment idempotencyKey"),
      ],
    );
  }

  private async audit(
    db: Db,
    context: AppCloudflareAccountContext,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await db.query(
      `insert into control_plane_audit_log
       (id,tenant_id,actor_user_id,action,resource_type,resource_id,metadata)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        randomUUID(),
        context.tenantId,
        context.userId,
        action,
        resourceType,
        resourceId,
        JSON.stringify(metadata),
      ],
    );
  }

  async listConnections(
    context: AppCloudflareAccountContext,
  ): Promise<AppCloudflareAccountConnection[]> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const result = await this.pool.query(
      `select * from cloudflare_connections
       where tenant_id=$1 and (scope='tenant' or owner_user_id=$2)
       order by updated_at desc,id desc`,
      [context.tenantId, context.userId],
    );
    return result.rows.map(connectionFromRow);
  }

  async listConnectionZones(
    context: AppCloudflareAccountContext,
    connectionId: string,
  ): Promise<AppCloudflareZone[]> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    let connection = await this.readUsableConnection(this.pool, context, connectionId, true);
    if (
      connection.status === "refresh_required" ||
      (connection.access_expires_at &&
        new Date(connection.access_expires_at).getTime() <= this.now().getTime() + 60_000)
    ) {
      await this.refreshConnectionRow(context, connection);
      connection = await this.readUsableConnection(this.pool, context, connectionId);
    }
    const zoneReadId = this.getScopeCatalog().scopes.get(CLOUDFLARE_PERMISSION_NAMES.zoneRead);
    if (!zoneReadId || !stringArray(connection.granted_scopes).includes(zoneReadId)) {
      throw new Error("Cloudflare connection is missing the Zone Read permission.");
    }
    const stored = this.decrypt<StoredOAuthCredential>(
      connection,
      "credential",
      `apps-cloudflare:connection:${context.tenantId}:${connection.id}:credential`,
    );
    return this.client.listZones(requiredString(stored.accessToken, "accessToken"));
  }

  async getConnection(
    context: AppCloudflareAccountContext,
    connectionId: string,
  ): Promise<AppCloudflareAccountConnection> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const row = await this.readUsableConnection(this.pool, context, connectionId, true);
    return connectionFromRow(row);
  }

  async listTemporaryAccounts(
    context: AppCloudflareAccountContext,
  ): Promise<AppCloudflareTemporaryAccount[]> {
    await this.membership(this.pool, context);
    await this.cleanupExpired();
    const result = await this.pool.query(
      `select * from cloudflare_temporary_previews
       where tenant_id=$1 and owner_user_id=$2 order by created_at desc,id desc`,
      [context.tenantId, context.userId],
    );
    return result.rows.map((row) => temporaryFromRow(row, this.now()));
  }

  async provisionTemporaryAccount(
    context: AppCloudflareAccountContext,
    input: {
      deploymentId: string;
      ipAddress: string;
      acceptedTermsOfService: boolean;
      acceptedPrivacyPolicy: boolean;
      turnstileToken?: string;
    },
  ): Promise<AppCloudflareTemporaryAccount> {
    this.requireTemporaryEnabled();
    await this.membership(this.pool, context);
    if (input.acceptedTermsOfService !== true || input.acceptedPrivacyPolicy !== true) {
      throw new Error(
        "Cloudflare Terms of Service and Privacy Policy must both be explicitly accepted.",
      );
    }
    const deploymentId = requiredString(input.deploymentId, "deploymentId");
    const deploymentResult = await this.pool.query(
      `select d.*,a.owner_user_id from app_deployments d join apps a on a.id=d.app_id
       where d.id=$1 and a.tenant_id=$2 and d.app_generation=a.generation limit 1`,
      [deploymentId, context.tenantId],
    );
    const deployment = deploymentResult.rows[0];
    if (!deployment) throw new Error("App deployment not found or stale.");
    const canManageOwn =
      deployment.owner_user_id === context.userId &&
      (await this.hasPermission(this.pool, context, "app:manage-own"));
    if (!canManageOwn && !(await this.hasPermission(this.pool, context, "app:manage-all"))) {
      throw new Error("Forbidden by scoped authorization.");
    }
    if (deployment.rollback_of_deployment_id) {
      throw new Error("App rollback requires a Cloudflare OAuth BYOC target.");
    }
    assertTemporaryAppEligible(deployment.manifest as PiworkAppManifestV1);
    const appId = String(deployment.app_id);
    const ipAddress = requiredString(input.ipAddress, "ipAddress");
    if (deployment.target_kind === "temporary" && deployment.temporary_preview_id) {
      const existing = await this.pool.query(
        `select * from cloudflare_temporary_previews
         where id=$1 and app_id=$2 and tenant_id=$3 and owner_user_id=$4
           limit 1`,
        [deployment.temporary_preview_id, appId, context.tenantId, context.userId],
      );
      if (existing.rows[0]) return temporaryFromRow(existing.rows[0], this.now());
    }
    if (deployment.phase !== "awaiting_target") {
      throw new Error("App deployment target has already been selected.");
    }
    if (this.turnstileEnabled() && !isLoopbackAddress(ipAddress)) {
      const turnstileToken = requiredString(input.turnstileToken, "turnstileToken");
      if (!(await this.verifyTurnstile(turnstileToken, ipAddress))) {
        throw new Error("Cloudflare Turnstile verification failed.");
      }
    }
    await this.cleanupExpired();
    const reusable = await this.reusableTemporaryAccount(this.pool, context);
    if (reusable) {
      if (String(reusable.app_id) !== appId) {
        throw new Error(
          "This user already has an active Cloudflare temporary preview for another App; claim it or use BYOC before creating another preview.",
        );
      }
      return temporaryFromRow(reusable, this.now());
    }
    const admission = this.abuseGuard.acquire({
      userId: context.userId,
      ipAddress,
      appId,
    });
    const id = randomUUID();
    const acceptedAt = this.now();
    let provisioned: CloudflareTemporaryAccountResult | undefined;
    let endProofOfWork: (() => void) | undefined;
    try {
      await this.pool.query(
        `insert into cloudflare_temporary_previews
         (id,app_id,tenant_id,owner_user_id,owner_membership_id,status,terms_of_service_url,
          privacy_policy_url,policies_accepted_at,created_by)
         values ($1,$2,$3,$4,$5,'provisioning',$6,$7,$8,$4)`,
        [
          id,
          appId,
          context.tenantId,
          context.userId,
          context.membershipId,
          CLOUDFLARE_TERMS_OF_SERVICE_URL,
          CLOUDFLARE_PRIVACY_POLICY_URL,
          acceptedAt.toISOString(),
        ],
      );
      endProofOfWork = this.abuseGuard.beginProofOfWork();
      provisioned = await this.client.provisionTemporaryAccount({
        termsOfService: CLOUDFLARE_TERMS_OF_SERVICE_URL,
        privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
        acceptTermsOfService: "yes",
      });
      endProofOfWork();
      endProofOfWork = undefined;
      const accountId = requiredString(provisioned.accountId, "accountId");
      const accountName = requiredString(provisioned.accountName, "accountName");
      const apiToken = requiredString(provisioned.apiToken, "apiToken");
      const claimUrl = new URL(requiredString(provisioned.claimUrl, "claimUrl"));
      if (claimUrl.protocol !== "https:" || claimUrl.hostname !== "dash.cloudflare.com") {
        throw new Error("Cloudflare claim URL is invalid.");
      }
      const expiry = effectiveTemporaryExpiry(provisioned, acceptedAt);
      const credential = this.encrypt(
        { apiToken, tokenId: provisioned.tokenId || null } satisfies StoredTemporaryCredential,
        `apps-cloudflare:temporary:${context.tenantId}:${id}:credential`,
      );
      const claim = this.encrypt(
        { claimUrl: claimUrl.toString() },
        `apps-cloudflare:temporary:${context.tenantId}:${id}:claim`,
      );
      const result = await this.pool.query(
        `update cloudflare_temporary_previews set
           account_id=$1,account_name=$2,status='ready',
           credential_ciphertext=$3,credential_iv=$4,credential_auth_tag=$5,credential_key_version=$6,
           claim_ciphertext=$7,claim_iv=$8,claim_auth_tag=$9,claim_key_version=$10,
           account_expires_at=$11,claim_expires_at=$12,expires_at=$13,updated_at=now()
         where id=$14 and tenant_id=$15 and owner_user_id=$16 returning *`,
        [
          accountId,
          accountName,
          credential.ciphertext,
          credential.iv,
          credential.authTag,
          credential.keyVersion,
          claim.ciphertext,
          claim.iv,
          claim.authTag,
          claim.keyVersion,
          expiry.accountExpiresAt,
          expiry.claimExpiresAt,
          expiry.expiresAt,
          id,
          context.tenantId,
          context.userId,
        ],
      );
      if (!result.rows[0]) throw new Error("Temporary account authority was lost.");
      await this.audit(
        this.pool,
        context,
        "app.cloudflare.temporary.created",
        "cloudflare_temporary_preview",
        id,
        { accountId, expiresAt: expiry.expiresAt },
      );
      return temporaryFromRow(result.rows[0], this.now());
    } catch {
      await this.pool.query(
        `update cloudflare_temporary_previews
         set status='failed',last_error_code='provisioning_failed',
             credential_ciphertext=null,credential_iv=null,credential_auth_tag=null,credential_key_version=null,
             claim_ciphertext=null,claim_iv=null,claim_auth_tag=null,claim_key_version=null,updated_at=now()
         where id=$1 and status='provisioning'`,
        [id],
      );
      if (provisioned?.accountId && provisioned.apiToken && this.client.discardTemporaryAccount) {
        await this.client
          .discardTemporaryAccount({
            accountId: provisioned.accountId,
            apiToken: provisioned.apiToken,
          })
          .catch(() => undefined);
      }
      const winner = await this.reusableTemporaryAccount(this.pool, context);
      if (winner && String(winner.app_id) === appId) return temporaryFromRow(winner, this.now());
      const provisioning = await this.pool.query(
        `select 1 from cloudflare_temporary_previews
         where tenant_id=$1 and owner_user_id=$2
           and status='provisioning' and id<>$3 limit 1`,
        [context.tenantId, context.userId, id],
      );
      if (provisioning.rows[0]) {
        throw new Error("Cloudflare temporary account provisioning is already in progress.");
      }
      throw new Error("Cloudflare temporary account provisioning failed.");
    } finally {
      endProofOfWork?.();
      admission.release();
    }
  }

  /**
   * Compensates the route's provision-then-select boundary. A preview is released
   * only while it is still unreferenced, so a concurrent successful selection wins.
   */
  async releaseUnassignedTemporaryAccount(
    context: AppCloudflareAccountContext,
    deploymentId: string,
    temporaryAccountId: string,
  ): Promise<boolean> {
    const released = await this.transaction(async (db) => {
      await this.membership(db, context);
      const result = await db.query(
        `select p.* from cloudflare_temporary_previews p
         join app_deployments d on d.id=$2 and d.app_id=p.app_id
         join apps a on a.id=d.app_id and a.tenant_id=$3 and d.app_generation=a.generation
         where p.id=$1 and p.tenant_id=$3 and p.owner_user_id=$4
           and p.owner_membership_id=$5 and p.status in ('ready','claiming')
           and not exists (
             select 1 from app_deployments linked where linked.temporary_preview_id=p.id
           )
           and not exists (
             select 1 from apps linked_app where linked_app.temporary_preview_id=p.id
           )
         for update of p`,
        [temporaryAccountId, deploymentId, context.tenantId, context.userId, context.membershipId],
      );
      const row = result.rows[0];
      if (!row) return null;
      let credential: StoredTemporaryCredential | null = null;
      try {
        credential = this.decrypt<StoredTemporaryCredential>(
          row,
          "credential",
          `apps-cloudflare:temporary:${context.tenantId}:${row.id}:credential`,
        );
      } catch {
        // Local authority still has to be cleared even if its envelope was damaged.
      }
      const cleared = await db.query(
        `update cloudflare_temporary_previews set status='failed',
         last_error_code='target_selection_failed',
         credential_ciphertext=null,credential_iv=null,credential_auth_tag=null,credential_key_version=null,
         claim_ciphertext=null,claim_iv=null,claim_auth_tag=null,claim_key_version=null,updated_at=now()
         where id=$1 and status in ('ready','claiming')
           and not exists (
             select 1 from app_deployments linked where linked.temporary_preview_id=$1
           )
           and not exists (
             select 1 from apps linked_app where linked_app.temporary_preview_id=$1
           )
         returning id`,
        [temporaryAccountId],
      );
      if (!cleared.rows[0]) return null;
      await this.audit(
        db,
        context,
        "app.cloudflare.temporary.released",
        "cloudflare_temporary_preview",
        temporaryAccountId,
        { deploymentId, reason: "target_selection_failed" },
      );
      return {
        accountId: row.account_id ? String(row.account_id) : "",
        apiToken: credential?.apiToken || "",
      };
    });
    if (!released) return false;
    if (released.accountId && released.apiToken && this.client.discardTemporaryAccount) {
      await this.client
        .discardTemporaryAccount({ accountId: released.accountId, apiToken: released.apiToken })
        .catch(() => undefined);
    }
    return true;
  }

  async getTemporaryClaimUrl(
    context: AppCloudflareAccountContext,
    temporaryAccountId: string,
  ): Promise<{ claimUrl: string; expiresAt: string }> {
    this.requireByocEnabled();
    const outcome = await this.transaction(async (db) => {
      await this.membership(db, context);
      const result = await db.query(
        `select * from cloudflare_temporary_previews
         where id=$1 and tenant_id=$2 and owner_user_id=$3 and owner_membership_id=$4
         for update`,
        [temporaryAccountId, context.tenantId, context.userId, context.membershipId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Cloudflare temporary account not found.");
      const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
      if (
        !expiresAt ||
        expiresAt.getTime() <= this.now().getTime() ||
        (row.status !== "ready" && row.status !== "claiming")
      ) {
        await this.expireTemporaryPreviews(db, [temporaryAccountId]);
        return { expired: true as const };
      }
      const deployment = await this.temporaryClaimBinding(
        db,
        context,
        temporaryAccountId,
        String(row.app_id),
        true,
      );
      if (deployment.phase === "temporary_ready") {
        const transitioned = await db.query(
          `update app_deployments set phase='claim_pending',error_code=null,error_message=null
           where id=$1 and app_id=$2 and app_generation=$3 and phase='temporary_ready'
           returning id`,
          [deployment.deploymentId, deployment.appId, deployment.appGeneration],
        );
        if (!transitioned.rows[0]) {
          throw new Error("Stale App deployment claim transition.");
        }
      } else if (deployment.phase !== "claim_pending" && deployment.phase !== "verifying_claim") {
        throw new Error("Cloudflare temporary deployment is not ready to claim.");
      }
      const claim = this.decrypt<{ claimUrl: string }>(
        row,
        "claim",
        `apps-cloudflare:temporary:${context.tenantId}:${temporaryAccountId}:claim`,
      );
      const claimUrl = new URL(requiredString(claim.claimUrl, "claimUrl"));
      if (claimUrl.protocol !== "https:" || claimUrl.hostname !== "dash.cloudflare.com") {
        throw new Error("Cloudflare claim URL is invalid.");
      }
      await db.query(
        `update cloudflare_temporary_previews set status='claiming',updated_at=now()
         where id=$1 and status in ('ready','claiming')`,
        [temporaryAccountId],
      );
      await this.audit(
        db,
        context,
        "app.cloudflare.temporary.claim_opened",
        "cloudflare_temporary_preview",
        temporaryAccountId,
        { appId: deployment.appId, deploymentId: deployment.deploymentId },
      );
      return {
        expired: false as const,
        claim: { claimUrl: claimUrl.toString(), expiresAt: expiresAt.toISOString() },
      };
    });
    if (outcome.expired) throw new Error("Cloudflare temporary account claim has expired.");
    return outcome.claim;
  }

  async getDeploymentClaimUrl(
    context: AppCloudflareAccountContext,
    deploymentId: string,
  ): Promise<{ claimUrl: string; expiresAt: string }> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const result = await this.pool.query(
      `select p.id from app_deployments d
       join apps a on a.id=d.app_id and a.tenant_id=$2
       join cloudflare_temporary_previews p on p.id=d.temporary_preview_id and p.app_id=a.id
       where d.id=$1 and d.app_generation=a.generation
         and p.tenant_id=$2 and p.owner_user_id=$3 and p.owner_membership_id=$4
       limit 1`,
      [deploymentId, context.tenantId, context.userId, context.membershipId],
    );
    if (!result.rows[0]) throw new Error("Cloudflare temporary deployment claim not found.");
    return this.getTemporaryClaimUrl(context, String(result.rows[0].id));
  }

  async startOAuth(
    context: AppCloudflareAccountContext,
    input: {
      purpose: AppCloudflareOAuthPurpose;
      scope: AppCloudflareConnectionScope;
      deploymentId: string;
      temporaryAccountId?: string;
      returnPath?: string;
    },
  ): Promise<{ authorizationUrl: string; expiresAt: string }> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    if (input.scope !== "user" && input.scope !== "tenant") {
      throw new Error("Cloudflare connection scope must be user or tenant.");
    }
    if (input.purpose !== "direct" && input.purpose !== "claim") {
      throw new Error("Cloudflare OAuth purpose must be direct or claim.");
    }
    if (input.scope === "tenant") await this.requireTenantConnectionPermission(this.pool, context);
    if (!this.client.oauthRedirectUri) {
      throw new Error("Cloudflare OAuth is not configured.");
    }
    const deploymentId = requiredString(input.deploymentId, "deploymentId");
    const deploymentResult = await this.pool.query(
      `select d.*,a.owner_user_id,a.generation current_app_generation
       from app_deployments d join apps a on a.id=d.app_id
       where d.id=$1 and a.tenant_id=$2 and d.app_generation=a.generation limit 1`,
      [deploymentId, context.tenantId],
    );
    const deployment = deploymentResult.rows[0];
    if (!deployment) throw new Error("App deployment not found or stale.");
    const canManageOwn =
      deployment.owner_user_id === context.userId &&
      (await this.hasPermission(this.pool, context, "app:manage-own"));
    if (!canManageOwn && !(await this.hasPermission(this.pool, context, "app:manage-all"))) {
      throw new Error("Forbidden by scoped authorization.");
    }
    const catalog = this.getScopeCatalog();
    const requested = resolveCloudflareOAuthScopes(catalog, deployment.binding_manifest);
    const temporaryAccountId = input.temporaryAccountId?.trim() || undefined;
    if (input.purpose === "claim" && !temporaryAccountId) {
      throw new Error("Cloudflare claim OAuth requires a temporary account.");
    }
    if (input.purpose === "direct" && temporaryAccountId) {
      throw new Error("Cloudflare direct OAuth cannot claim a temporary account.");
    }
    if (input.purpose === "claim") {
      const temporary = await this.pool.query(
        `select * from cloudflare_temporary_previews
         where id=$1 and tenant_id=$2 and owner_user_id=$3 and owner_membership_id=$4
           and app_id=$5 limit 1`,
        [
          temporaryAccountId,
          context.tenantId,
          context.userId,
          context.membershipId,
          deployment.app_id,
        ],
      );
      const row = temporary.rows[0];
      if (
        !row ||
        !row.expires_at ||
        new Date(row.expires_at).getTime() <= this.now().getTime() ||
        row.status !== "claiming" ||
        deployment.temporary_preview_id !== temporaryAccountId ||
        deployment.phase !== "claim_pending"
      ) {
        throw new Error("Cloudflare temporary account is unavailable for claim connection.");
      }
      const stored = this.decrypt<StoredTemporaryCredential>(
        row,
        "credential",
        `apps-cloudflare:temporary:${context.tenantId}:${row.id}:credential`,
      );
      await this.verifyProviderScopes(requiredString(stored.apiToken, "apiToken"), requested.names);
    } else if (deployment.phase !== "awaiting_target" && deployment.phase !== "awaiting_oauth") {
      throw new Error("App deployment is not awaiting a Cloudflare account.");
    }
    const pkce = createPkceMaterial();
    const id = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + CLOUDFLARE_OAUTH_ATTEMPT_LIFETIME_MS);
    const verifier = this.encrypt(
      { verifier: pkce.verifier },
      `apps-cloudflare:oauth:${context.tenantId}:${id}:verifier`,
    );
    const authorizationUrl = this.client.authorizationUrl({
      state: pkce.state,
      codeChallenge: pkce.challenge,
      redirectUri: this.client.oauthRedirectUri,
      scopes: requested.ids,
    });
    const parsedUrl = new URL(authorizationUrl);
    if (parsedUrl.protocol !== "https:") throw new Error("Cloudflare OAuth URL must use HTTPS.");
    const awaitingPhase = input.purpose === "direct" ? "awaiting_oauth" : "claim_pending";
    const phase = await this.pool.query(
      `update app_deployments d set phase=$1,error_code=null,error_message=null
       from apps a where d.id=$2 and d.app_id=$3 and d.app_generation=$4
         and d.app_id=a.id and a.tenant_id=$5 and a.generation=$4
         and d.phase in ($6,$1) returning d.id`,
      [
        awaitingPhase,
        deployment.id,
        deployment.app_id,
        Number(deployment.app_generation),
        context.tenantId,
        input.purpose === "direct" ? "awaiting_target" : "claim_pending",
      ],
    );
    if (!phase.rows[0]) throw new Error("Stale Cloudflare OAuth deployment authority.");
    await this.pool.query(
      `insert into cloudflare_oauth_states
       (id,tenant_id,user_id,membership_id,connection_scope,purpose,app_id,deployment_id,app_generation,
        temporary_account_id,state_hash,verifier_ciphertext,verifier_iv,verifier_auth_tag,
        verifier_key_version,requested_scopes,requested_scope_names,redirect_uri,return_path,
        status,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,
        $18,$19,'pending',$20)`,
      [
        id,
        context.tenantId,
        context.userId,
        context.membershipId,
        input.scope,
        input.purpose,
        deployment.app_id,
        deployment.id,
        Number(deployment.app_generation),
        temporaryAccountId || null,
        pkce.stateHash,
        verifier.ciphertext,
        verifier.iv,
        verifier.authTag,
        verifier.keyVersion,
        JSON.stringify(requested.ids),
        JSON.stringify(requested.names),
        this.client.oauthRedirectUri,
        normalizeReturnPath(input.returnPath),
        expiresAt.toISOString(),
      ],
    );
    return { authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  private async failOAuthAttempt(
    context: AppCloudflareAccountContext,
    attempt: QueryResultRow,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.transaction(async (db) => {
      await this.membership(db, context);
      await db.query(
        `update cloudflare_oauth_states set status='failed',last_error_code=$1
         where id=$2 and tenant_id=$3 and user_id=$4 and membership_id=$5
           and status='exchanging'`,
        [errorCode, attempt.id, context.tenantId, context.userId, context.membershipId],
      );
      if (attempt.temporary_account_id) {
        await db.query(
          `update app_deployments d set phase='failed',error_code=$1,error_message=$2
           from apps a where d.id=$3 and d.app_id=$4 and d.app_generation=$5
             and d.app_id=a.id and a.tenant_id=$6
             and d.phase in ('claim_pending','verifying_claim')`,
          [
            errorCode,
            errorMessage,
            attempt.deployment_id,
            attempt.app_id,
            Number(attempt.app_generation),
            context.tenantId,
          ],
        );
        await db.query(
          `update apps set
             status=case when current_deployment_id is null or current_deployment_id=$1
               then 'failed' else 'ready' end,
             status_reason=$2,updated_at=now()
           where id=$3 and tenant_id=$4 and generation=$5`,
          [
            attempt.deployment_id,
            errorMessage,
            attempt.app_id,
            context.tenantId,
            Number(attempt.app_generation),
          ],
        );
      }
      await this.audit(
        db,
        context,
        "app.cloudflare.oauth.failed",
        "app_deployment",
        String(attempt.deployment_id),
        { errorCode },
      );
    });
  }

  async finishOAuth(
    context: AppCloudflareAccountContext,
    input: { state: string; code: string },
  ): Promise<{ connection: AppCloudflareAccountConnection; returnPath: string }> {
    this.requireByocEnabled();
    const stateHash = hashOAuthState(requiredString(input.state, "state"));
    const code = requiredString(input.code, "code");
    const attempt = await this.transaction(async (db) => {
      await this.membership(db, context);
      const result = await db.query(
        `select * from cloudflare_oauth_states where state_hash=$1 for update`,
        [stateHash],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.tenant_id !== context.tenantId ||
        row.user_id !== context.userId ||
        row.membership_id !== context.membershipId
      ) {
        throw new Error("Cloudflare OAuth state is invalid.");
      }
      const claimPurpose = row.purpose === "claim";
      if (
        (row.purpose !== "direct" && row.purpose !== "claim") ||
        claimPurpose !== Boolean(row.temporary_account_id)
      ) {
        throw new Error("Cloudflare OAuth purpose binding is invalid.");
      }
      if (row.status !== "pending" || row.consumed_at) {
        throw new Error("Cloudflare OAuth state has already been consumed.");
      }
      if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
        await db.query(
          `update cloudflare_oauth_states set status='expired',consumed_at=now(),
           verifier_ciphertext=null,verifier_iv=null,verifier_auth_tag=null,verifier_key_version=null
           where id=$1`,
          [row.id],
        );
        return { expired: true as const };
      }
      if (row.connection_scope === "tenant") {
        await this.requireTenantConnectionPermission(db, context);
      }
      const stored = this.decrypt<{ verifier: string }>(
        row,
        "verifier",
        `apps-cloudflare:oauth:${context.tenantId}:${row.id}:verifier`,
      );
      await db.query(
        `update cloudflare_oauth_states set status='exchanging',consumed_at=now(),
         verifier_ciphertext=null,verifier_iv=null,verifier_auth_tag=null,verifier_key_version=null
         where id=$1`,
        [row.id],
      );
      return {
        expired: false as const,
        row,
        verifier: requiredString(stored.verifier, "OAuth verifier"),
      };
    });
    if (attempt.expired) throw new Error("Cloudflare OAuth state has expired.");

    let token: CloudflareOAuthTokenResult;
    try {
      token = await this.client.exchangeAuthorizationCode({
        code,
        codeVerifier: attempt.verifier,
        redirectUri: String(attempt.row.redirect_uri),
      });
      this.validateOAuthToken(token, stringArray(attempt.row.requested_scopes));
    } catch {
      await this.pool.query(
        `update cloudflare_oauth_states
         set status='failed',last_error_code='exchange_failed' where id=$1 and status='exchanging'`,
        [attempt.row.id],
      );
      throw new Error("Cloudflare OAuth exchange failed.");
    }
    try {
      await this.verifyProviderScopes(
        token.accessToken,
        stringArray(attempt.row.requested_scope_names),
      );
    } catch {
      await this.client.revokeToken(token.accessToken).catch(() => undefined);
      await this.failOAuthAttempt(
        context,
        attempt.row,
        "oauth_scope_catalog_mismatch",
        "Cloudflare OAuth permissions are missing or changed.",
      );
      throw new Error("Cloudflare OAuth permission catalog validation failed.");
    }

    let finalized:
      | { mismatch: true }
      | {
          mismatch: false;
          connection: AppCloudflareAccountConnection;
          returnPath: string;
        };
    try {
      finalized = await this.transaction(async (db) => {
        await this.membership(db, context);
        if (attempt.row.connection_scope === "tenant") {
          await this.requireTenantConnectionPermission(db, context);
        }
        const deploymentResult = await db.query(
          `select d.*,a.generation current_app_generation,a.current_deployment_id
           from app_deployments d join apps a on a.id=d.app_id
           where d.id=$1 and d.app_id=$2 and d.app_generation=$3
             and a.tenant_id=$4 and a.generation=$3
           for update of d,a`,
          [
            attempt.row.deployment_id,
            attempt.row.app_id,
            Number(attempt.row.app_generation),
            context.tenantId,
          ],
        );
        const deployment = deploymentResult.rows[0];
        if (!deployment) throw new Error("Stale Cloudflare OAuth deployment authority.");

        if (
          attempt.row.purpose === "direct" &&
          deployment.phase !== "awaiting_target" &&
          deployment.phase !== "awaiting_oauth"
        ) {
          throw new Error("App deployment is no longer awaiting a Cloudflare account.");
        }

        if (attempt.row.purpose === "claim") {
          const temporary = await db.query(
            `select * from cloudflare_temporary_previews
             where id=$1 and app_id=$2 and tenant_id=$3 and owner_user_id=$4
               and owner_membership_id=$5 for update`,
            [
              attempt.row.temporary_account_id,
              attempt.row.app_id,
              context.tenantId,
              context.userId,
              context.membershipId,
            ],
          );
          const preview = temporary.rows[0];
          if (!preview || preview.account_id !== token.accountId) {
            await db.query(
              `update cloudflare_oauth_states set status='failed',
               last_error_code='temporary_account_mismatch'
               where id=$1 and tenant_id=$2 and user_id=$3 and membership_id=$4
                 and status='exchanging'`,
              [attempt.row.id, context.tenantId, context.userId, context.membershipId],
            );
            await db.query(
              `update app_deployments set phase='claim_pending',error_code='temporary_account_mismatch',
               error_message=$1 where id=$2 and app_id=$3 and app_generation=$4
                 and phase in ('claim_pending','verifying_claim')`,
              [
                TEMPORARY_ACCOUNT_MISMATCH_MESSAGE,
                attempt.row.deployment_id,
                attempt.row.app_id,
                Number(attempt.row.app_generation),
              ],
            );
            await db.query(
              `update apps set status='needs_action',status_reason=$1,updated_at=now()
               where id=$2 and tenant_id=$3 and generation=$4
                 and temporary_preview_id=$5`,
              [
                TEMPORARY_ACCOUNT_MISMATCH_MESSAGE,
                attempt.row.app_id,
                context.tenantId,
                Number(attempt.row.app_generation),
                attempt.row.temporary_account_id,
              ],
            );
            await this.audit(
              db,
              context,
              "app.cloudflare.temporary.account_mismatch",
              "app_deployment",
              String(attempt.row.deployment_id),
              { errorCode: "temporary_account_mismatch" },
            );
            return { mismatch: true as const };
          }
          if (deployment.phase === "claim_pending") {
            const verifying = await db.query(
              `update app_deployments set phase='verifying_claim'
               where id=$1 and app_id=$2 and app_generation=$3 and phase='claim_pending'
               returning id`,
              [attempt.row.deployment_id, attempt.row.app_id, Number(attempt.row.app_generation)],
            );
            if (!verifying.rows[0]) throw new Error("Stale App claim verification transition.");
          } else if (deployment.phase !== "verifying_claim") {
            throw new Error("App deployment is not awaiting claim verification.");
          }
        }

        const connection = await this.upsertConnection(
          db,
          context,
          attempt.row.connection_scope,
          token,
        );
        if (attempt.row.purpose === "claim") {
          const claimed = await db.query(
            `update cloudflare_temporary_previews set status='claimed',claimed_connection_id=$1,
             credential_ciphertext=null,credential_iv=null,credential_auth_tag=null,credential_key_version=null,
             claim_ciphertext=null,claim_iv=null,claim_auth_tag=null,claim_key_version=null,updated_at=now()
             where id=$2 and app_id=$3 and tenant_id=$4 and owner_user_id=$5
               and owner_membership_id=$6 and account_id=$7 and status='claiming'
             returning id`,
            [
              connection.id,
              attempt.row.temporary_account_id,
              attempt.row.app_id,
              context.tenantId,
              context.userId,
              context.membershipId,
              token.accountId,
            ],
          );
          if (!claimed.rows[0]) throw new Error("Cloudflare temporary claim authority was lost.");
          const ready = await db.query(
            `update app_deployments set phase='ready',target_kind='byoc',
             cloudflare_connection_id=$1,temporary_preview_id=null,
             error_code=null,error_message=null,deployed_at=coalesce(deployed_at,now())
             where id=$2 and app_id=$3 and app_generation=$4 and phase='verifying_claim'
             returning id`,
            [
              connection.id,
              attempt.row.deployment_id,
              attempt.row.app_id,
              Number(attempt.row.app_generation),
            ],
          );
          if (!ready.rows[0]) throw new Error("Stale App claim completion transition.");
          const app = await db.query(
            `update apps set target_kind='byoc',cloudflare_connection_id=$1,
             temporary_preview_id=null,status='ready',status_reason=null,
             current_deployment_id=$2,updated_at=now()
             where id=$3 and tenant_id=$4 and generation=$5 and temporary_preview_id=$6
             returning id`,
            [
              connection.id,
              attempt.row.deployment_id,
              attempt.row.app_id,
              context.tenantId,
              Number(attempt.row.app_generation),
              attempt.row.temporary_account_id,
            ],
          );
          if (!app.rows[0]) throw new Error("Stale App claim authority.");
        } else {
          const queued = await db.query(
            `update app_deployments set phase='queued',target_kind='byoc',
             cloudflare_connection_id=$1,temporary_preview_id=null,
             error_code=null,error_message=null
             where id=$2 and app_id=$3 and app_generation=$4 and phase='awaiting_oauth'
             returning id`,
            [
              connection.id,
              attempt.row.deployment_id,
              attempt.row.app_id,
              Number(attempt.row.app_generation),
            ],
          );
          if (!queued.rows[0]) throw new Error("Stale App OAuth deployment transition.");
          const app = await db.query(
            `update apps set target_kind='byoc',cloudflare_connection_id=$1,
             temporary_preview_id=null,status='needs_action',status_reason=null,updated_at=now()
             where id=$2 and tenant_id=$3 and generation=$4 returning id`,
            [
              connection.id,
              attempt.row.app_id,
              context.tenantId,
              Number(attempt.row.app_generation),
            ],
          );
          if (!app.rows[0]) throw new Error("Stale App OAuth target authority.");
          await this.enqueueDeploymentOutbox(db, context, deployment, "byoc", connection.id, null);
        }
        const completed = await db.query(
          `update cloudflare_oauth_states
           set status='completed',completed_at=now(),connection_id=$1
           where id=$2 and tenant_id=$3 and user_id=$4 and membership_id=$5
             and status='exchanging' returning id`,
          [connection.id, attempt.row.id, context.tenantId, context.userId, context.membershipId],
        );
        if (!completed.rows[0]) throw new Error("Cloudflare OAuth state completion is stale.");
        await this.audit(
          db,
          context,
          "app.cloudflare.connection.created",
          "cloudflare_connection",
          connection.id,
          { scope: connection.scope, accountId: connection.accountId },
        );
        return {
          mismatch: false as const,
          connection,
          returnPath: String(attempt.row.return_path),
        };
      });
    } catch {
      await this.client.revokeToken(token.accessToken).catch(() => undefined);
      await this.failOAuthAttempt(
        context,
        attempt.row,
        "oauth_claim_finalize_failed",
        "Cloudflare account connection could not be finalized.",
      ).catch(() => undefined);
      throw new Error("Cloudflare OAuth connection finalization failed.");
    }
    if (finalized.mismatch) {
      await this.client.revokeToken(token.accessToken).catch(() => undefined);
      throw new Error(TEMPORARY_ACCOUNT_MISMATCH_MESSAGE);
    }
    return { connection: finalized.connection, returnPath: finalized.returnPath };
  }

  async cancelOAuth(
    context: AppCloudflareAccountContext,
    state: string,
  ): Promise<{ returnPath: string }> {
    this.requireByocEnabled();
    const stateHash = hashOAuthState(requiredString(state, "state"));
    return this.transaction(async (db) => {
      await this.membership(db, context);
      const result = await db.query(
        `select * from cloudflare_oauth_states where state_hash=$1 for update`,
        [stateHash],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.tenant_id !== context.tenantId ||
        row.user_id !== context.userId ||
        row.membership_id !== context.membershipId
      ) {
        throw new Error("Cloudflare OAuth state is invalid.");
      }
      const claimPurpose = row.purpose === "claim";
      if (
        (row.purpose !== "direct" && row.purpose !== "claim") ||
        claimPurpose !== Boolean(row.temporary_account_id)
      ) {
        throw new Error("Cloudflare OAuth purpose binding is invalid.");
      }
      if (row.status !== "pending" || row.consumed_at) {
        throw new Error("Cloudflare OAuth state has already been consumed.");
      }
      const deployment = await db.query(
        `select d.id,d.app_id,d.app_generation,d.phase,d.temporary_preview_id,
                a.generation current_app_generation
         from app_deployments d join apps a on a.id=d.app_id
         where d.id=$1 and d.app_id=$2 and d.app_generation=$3
           and a.tenant_id=$4 and a.generation=$3
         for update of d,a`,
        [row.deployment_id, row.app_id, Number(row.app_generation), context.tenantId],
      );
      const deploymentRow = deployment.rows[0];
      if (!deploymentRow) throw new Error("Stale Cloudflare OAuth deployment authority.");
      const retryPhase = claimPurpose ? "claim_pending" : "awaiting_oauth";
      const allowedPhase = claimPurpose
        ? deploymentRow.phase === "claim_pending" &&
          deploymentRow.temporary_preview_id === row.temporary_account_id
        : deploymentRow.phase === "awaiting_oauth" || deploymentRow.phase === "awaiting_target";
      if (!allowedPhase) throw new Error("Stale Cloudflare OAuth deployment authority.");
      const restored = await db.query(
        `update app_deployments set phase=$1,error_code='oauth_cancelled',error_message=$2
         where id=$3 and app_id=$4 and app_generation=$5 returning id`,
        [retryPhase, OAUTH_CANCELLED_MESSAGE, row.deployment_id, row.app_id, row.app_generation],
      );
      if (!restored.rows[0]) throw new Error("Stale Cloudflare OAuth deployment authority.");
      await db.query(
        `update apps set status='needs_action',status_reason=$1,updated_at=now()
         where id=$2 and tenant_id=$3 and generation=$4`,
        [OAUTH_CANCELLED_MESSAGE, row.app_id, context.tenantId, Number(row.app_generation)],
      );
      await db.query(
        `update cloudflare_oauth_states set status='failed',consumed_at=now(),
         last_error_code='oauth_cancelled',verifier_ciphertext=null,verifier_iv=null,
         verifier_auth_tag=null,verifier_key_version=null where id=$1`,
        [row.id],
      );
      await this.audit(
        db,
        context,
        "app.cloudflare.oauth.cancelled",
        "app_deployment",
        String(row.deployment_id),
        { purpose: row.purpose, errorCode: "oauth_cancelled" },
      );
      return { returnPath: String(row.return_path) };
    });
  }

  private validateOAuthToken(token: CloudflareOAuthTokenResult, requestedScopes: string[]): void {
    requiredString(token.accountId, "accountId");
    requiredString(token.accountName, "accountName");
    requiredString(token.accessToken, "accessToken");
    requiredString(token.refreshToken, "refreshToken");
    const granted = new Set(stringArray(token.grantedScopes));
    if (requestedScopes.some((scope) => !granted.has(scope))) {
      throw new Error("Cloudflare OAuth grant is missing required scopes.");
    }
    if (token.accessExpiresAt && Date.parse(token.accessExpiresAt) <= this.now().getTime()) {
      throw new Error("Cloudflare OAuth access token is already expired.");
    }
  }

  private async upsertConnection(
    db: Db,
    context: AppCloudflareAccountContext,
    scope: AppCloudflareConnectionScope,
    token: CloudflareOAuthTokenResult,
  ): Promise<AppCloudflareAccountConnection> {
    const accountId = requiredString(token.accountId, "accountId");
    const accountName = requiredString(token.accountName, "accountName");
    const existing = await db.query(
      scope === "user"
        ? `select id from cloudflare_connections
           where tenant_id=$1 and scope='user' and owner_user_id=$2 and account_id=$3 for update`
        : `select id from cloudflare_connections
           where tenant_id=$1 and scope='tenant' and account_id=$3 for update`,
      [context.tenantId, context.userId, accountId],
    );
    const id = existing.rows[0]?.id ? String(existing.rows[0].id) : randomUUID();
    const credential = this.encrypt(
      {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType || "Bearer",
        grantedScopes: stringArray(token.grantedScopes),
        accessExpiresAt: token.accessExpiresAt
          ? safeTimestamp(token.accessExpiresAt, "accessExpiresAt")
          : null,
      } satisfies StoredOAuthCredential,
      `apps-cloudflare:connection:${context.tenantId}:${id}:credential`,
    );
    const parameters = [
      id,
      context.tenantId,
      scope,
      scope === "user" ? context.userId : null,
      scope === "user" ? context.membershipId : null,
      accountId,
      accountName,
      JSON.stringify(stringArray(token.grantedScopes)),
      credential.ciphertext,
      credential.iv,
      credential.authTag,
      credential.keyVersion,
      token.accessExpiresAt ? safeTimestamp(token.accessExpiresAt, "accessExpiresAt") : null,
      context.userId,
    ];
    const result = existing.rows[0]
      ? await db.query(
          `update cloudflare_connections set
           account_name=$7,granted_scopes=$8::jsonb,status='active',
           credential_ciphertext=$9,credential_iv=$10,credential_auth_tag=$11,credential_key_version=$12,
           access_expires_at=$13,last_refreshed_at=now(),last_error_code=null,revoked_at=null,
           updated_at=now() where id=$1 returning *`,
          parameters,
        )
      : await db.query(
          `insert into cloudflare_connections
           (id,tenant_id,scope,owner_user_id,owner_membership_id,account_id,account_name,
            granted_scopes,status,credential_ciphertext,credential_iv,credential_auth_tag,
            credential_key_version,access_expires_at,last_refreshed_at,created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'active',$9,$10,$11,$12,$13,now(),$14)
           returning *`,
          parameters,
        );
    return connectionFromRow(result.rows[0]);
  }

  async refreshConnection(
    context: AppCloudflareAccountContext,
    connectionId: string,
  ): Promise<AppCloudflareAccountConnection> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const row = await this.readUsableConnection(this.pool, context, connectionId, true);
    if (row.scope === "tenant") {
      await this.requireTenantConnectionPermission(this.pool, context);
    }
    return this.refreshConnectionRow(context, row);
  }

  private async refreshConnectionRow(
    context: AppCloudflareAccountContext,
    row: QueryResultRow,
  ): Promise<AppCloudflareAccountConnection> {
    const flightKey = `${context.tenantId}:${String(row.id)}`;
    const existing = this.refreshFlights.get(flightKey);
    if (existing) return existing;
    const flight = this.rotateConnectionCredential(context, row);
    this.refreshFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (this.refreshFlights.get(flightKey) === flight) this.refreshFlights.delete(flightKey);
    }
  }

  private sameCredentialEnvelope(left: QueryResultRow, right: QueryResultRow): boolean {
    return (
      left.credential_ciphertext === right.credential_ciphertext &&
      left.credential_iv === right.credential_iv &&
      left.credential_auth_tag === right.credential_auth_tag &&
      Number(left.credential_key_version) === Number(right.credential_key_version)
    );
  }

  private async rotateConnectionCredential(
    context: AppCloudflareAccountContext,
    row: QueryResultRow,
  ): Promise<AppCloudflareAccountConnection> {
    const stored = this.decrypt<StoredOAuthCredential>(
      row,
      "credential",
      `apps-cloudflare:connection:${context.tenantId}:${row.id}:credential`,
    );
    let token: CloudflareOAuthTokenResult;
    try {
      token = await this.client.refreshAccessToken(
        requiredString(stored.refreshToken, "refreshToken"),
        stringArray(row.granted_scopes),
      );
      this.validateOAuthToken(token, stringArray(row.granted_scopes));
      if (token.accountId !== row.account_id) throw new Error("Cloudflare account changed.");
      await this.verifyProviderScopes(
        token.accessToken,
        this.scopeNamesForIds(stringArray(row.granted_scopes)),
      );
    } catch {
      const latest = await this.readUsableConnection(
        this.pool,
        context,
        String(row.id),
        true,
      ).catch(() => undefined);
      if (latest && !this.sameCredentialEnvelope(latest, row)) {
        return connectionFromRow(latest);
      }
      const marked = await this.pool.query(
        `update cloudflare_connections
         set status='refresh_required',last_error_code='refresh_failed',updated_at=now()
         where id=$1 and tenant_id=$2 and status <> 'revoked'
           and credential_ciphertext=$3 and credential_iv=$4
           and credential_auth_tag=$5 and credential_key_version=$6
         returning id`,
        [
          row.id,
          context.tenantId,
          row.credential_ciphertext,
          row.credential_iv,
          row.credential_auth_tag,
          Number(row.credential_key_version),
        ],
      );
      if (!marked.rows[0]) {
        const concurrent = await this.readUsableConnection(
          this.pool,
          context,
          String(row.id),
          true,
        ).catch(() => undefined);
        if (concurrent && !this.sameCredentialEnvelope(concurrent, row)) {
          return connectionFromRow(concurrent);
        }
      }
      throw new Error("Cloudflare OAuth token refresh failed.");
    }
    const credential = this.encrypt(
      {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenType: token.tokenType || "Bearer",
        grantedScopes: stringArray(token.grantedScopes),
        accessExpiresAt: token.accessExpiresAt
          ? safeTimestamp(token.accessExpiresAt, "accessExpiresAt")
          : null,
      } satisfies StoredOAuthCredential,
      `apps-cloudflare:connection:${context.tenantId}:${row.id}:credential`,
    );
    const rotated = await this.pool.query(
      `update cloudflare_connections set account_name=$1,granted_scopes=$2::jsonb,status='active',
       credential_ciphertext=$3,credential_iv=$4,credential_auth_tag=$5,credential_key_version=$6,
       access_expires_at=$7,last_refreshed_at=now(),last_error_code=null,revoked_at=null,
       updated_at=now()
       where id=$8 and tenant_id=$9 and account_id=$10 and status <> 'revoked'
         and credential_ciphertext=$11 and credential_iv=$12
         and credential_auth_tag=$13 and credential_key_version=$14
       returning *`,
      [
        token.accountName,
        JSON.stringify(stringArray(token.grantedScopes)),
        credential.ciphertext,
        credential.iv,
        credential.authTag,
        credential.keyVersion,
        token.accessExpiresAt ? safeTimestamp(token.accessExpiresAt, "accessExpiresAt") : null,
        row.id,
        context.tenantId,
        row.account_id,
        row.credential_ciphertext,
        row.credential_iv,
        row.credential_auth_tag,
        Number(row.credential_key_version),
      ],
    );
    let connection: AppCloudflareAccountConnection;
    if (rotated.rows[0]) {
      connection = connectionFromRow(rotated.rows[0]);
    } else {
      const winner = await this.readUsableConnection(this.pool, context, String(row.id), true);
      if (this.sameCredentialEnvelope(winner, row)) {
        throw new Error("Cloudflare OAuth credential rotation was stale.");
      }
      connection = connectionFromRow(winner);
    }
    await this.audit(
      this.pool,
      context,
      "app.cloudflare.connection.refreshed",
      "cloudflare_connection",
      connection.id,
      { rotated: Boolean(rotated.rows[0]) },
    );
    return connection;
  }

  async revokeConnection(
    context: AppCloudflareAccountContext,
    connectionId: string,
  ): Promise<void> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const row = await this.readUsableConnection(this.pool, context, connectionId, true);
    if (row.scope === "tenant") {
      await this.requireTenantConnectionPermission(this.pool, context);
    }
    const stored = this.decrypt<StoredOAuthCredential>(
      row,
      "credential",
      `apps-cloudflare:connection:${context.tenantId}:${row.id}:credential`,
    );
    let remoteFailed = false;
    try {
      await this.client.revokeToken(requiredString(stored.accessToken, "accessToken"));
    } catch {
      remoteFailed = true;
    }
    await this.transaction(async (db) => {
      await db.query(
        `update cloudflare_connections set status='revoked',
         credential_ciphertext=null,credential_iv=null,credential_auth_tag=null,credential_key_version=null,
         revoked_at=now(),last_error_code=$1,updated_at=now()
         where id=$2 and tenant_id=$3`,
        [remoteFailed ? "remote_revoke_failed" : null, connectionId, context.tenantId],
      );
      await db.query(
        `update apps set target_kind='unassigned',cloudflare_connection_id=null,
         temporary_preview_id=null,updated_at=now()
         where tenant_id=$1 and cloudflare_connection_id=$2`,
        [context.tenantId, connectionId],
      );
      await this.audit(
        db,
        context,
        "app.cloudflare.connection.revoked",
        "cloudflare_connection",
        connectionId,
        { remoteRevocationConfirmed: !remoteFailed },
      );
    });
  }

  private async readUsableConnection(
    db: Db,
    context: AppCloudflareAccountContext,
    connectionId: string,
    allowRefreshRequired = false,
  ): Promise<QueryResultRow> {
    const result = await db.query(
      `select * from cloudflare_connections where id=$1 and tenant_id=$2 limit 1`,
      [connectionId, context.tenantId],
    );
    const row = result.rows[0];
    if (
      !row ||
      (row.status !== "active" && !(allowRefreshRequired && row.status === "refresh_required"))
    ) {
      throw new Error("Cloudflare account connection not found or inactive.");
    }
    if (row.scope === "user" && row.owner_user_id !== context.userId) {
      throw new Error("Forbidden by scoped authorization.");
    }
    return row;
  }

  async selectDeploymentTarget(
    context: AppCloudflareAccountContext,
    deploymentId: string,
    input:
      | { target: "temporary"; temporaryAccountId: string }
      | { target: "byoc"; connectionId: string },
  ): Promise<AppCloudflareQueuedDeployment> {
    return this.transaction(async (db) => {
      await this.membership(db, context);
      const result = await db.query(
        `select d.*,a.tenant_id,a.owner_user_id
         from app_deployments d join apps a on a.id=d.app_id
         where d.id=$1 and a.tenant_id=$2 and d.app_generation=a.generation
           for update of d,a`,
        [deploymentId, context.tenantId],
      );
      const deployment = result.rows[0];
      if (!deployment) throw new Error("App deployment not found.");
      const canManageOwn =
        deployment.owner_user_id === context.userId &&
        (await this.hasPermission(db, context, "app:manage-own"));
      if (!canManageOwn && !(await this.hasPermission(db, context, "app:manage-all"))) {
        throw new Error("Forbidden by scoped authorization.");
      }
      if (input.target === "temporary" && deployment.rollback_of_deployment_id) {
        throw new Error("App rollback requires a Cloudflare OAuth BYOC target.");
      }
      if (deployment.phase !== "awaiting_target") {
        const sameTarget =
          deployment.target_kind === input.target &&
          (input.target === "temporary"
            ? deployment.temporary_preview_id === input.temporaryAccountId
            : deployment.cloudflare_connection_id === input.connectionId);
        if (sameTarget) {
          if (
            deployment.phase === "queued" ||
            deployment.phase === "provisioning" ||
            deployment.phase === "deploying"
          ) {
            await this.enqueueDeploymentOutbox(
              db,
              context,
              deployment,
              input.target,
              input.target === "byoc" ? String(deployment.cloudflare_connection_id) : null,
              input.target === "temporary" ? String(deployment.temporary_preview_id) : null,
            );
          }
          return {
            appId: String(deployment.app_id),
            deploymentId: String(deployment.id),
            appGeneration: Number(deployment.app_generation),
            phase: deployment.phase,
            target: input.target,
            connectionId:
              input.target === "byoc" ? String(deployment.cloudflare_connection_id) : null,
            temporaryAccountId:
              input.target === "temporary" ? String(deployment.temporary_preview_id) : null,
          };
        }
        throw new Error("App deployment target has already been selected.");
      }

      let connectionId: string | null = null;
      let temporaryAccountId: string | null = null;
      if (input.target === "byoc") {
        this.requireByocEnabled();
        const connection = await this.readUsableConnection(db, context, input.connectionId);
        this.assertConnectionGrants(connection, deployment.binding_manifest);
        connectionId = String(connection.id);
      } else {
        this.requireTemporaryEnabled();
        const temporary = await db.query(
          `select * from cloudflare_temporary_previews
           where id=$1 and tenant_id=$2 and owner_user_id=$3 and owner_membership_id=$4
             and app_id=$5 limit 1`,
          [
            input.temporaryAccountId,
            context.tenantId,
            context.userId,
            context.membershipId,
            deployment.app_id,
          ],
        );
        const row = temporary.rows[0];
        if (
          !row ||
          (row.status !== "ready" && row.status !== "claiming") ||
          !row.expires_at ||
          new Date(row.expires_at).getTime() <= this.now().getTime()
        ) {
          throw new Error("Cloudflare temporary preview not found or expired.");
        }
        temporaryAccountId = String(row.id);
      }
      const queued = await db.query(
        `update app_deployments set target_kind=$1,phase='queued',
         cloudflare_connection_id=$2,temporary_preview_id=$3
         where id=$4 and phase='awaiting_target' returning id`,
        [input.target, connectionId, temporaryAccountId, deploymentId],
      );
      if (!queued.rows[0]) throw new Error("Stale App deployment target selection.");
      await db.query(
        `update apps set target_kind=$1,cloudflare_connection_id=$2,
         temporary_preview_id=$3,updated_at=now() where id=$4 and tenant_id=$5`,
        [input.target, connectionId, temporaryAccountId, deployment.app_id, context.tenantId],
      );
      await this.enqueueDeploymentOutbox(
        db,
        context,
        deployment,
        input.target,
        connectionId,
        temporaryAccountId,
      );
      await this.audit(
        db,
        context,
        "app.cloudflare.deployment_target.selected",
        "app_deployment",
        deploymentId,
        {
          appId: deployment.app_id,
          appGeneration: Number(deployment.app_generation),
          target: input.target,
          connectionId,
          temporaryAccountId,
        },
      );
      return {
        appId: String(deployment.app_id),
        deploymentId: String(deployment.id),
        appGeneration: Number(deployment.app_generation),
        phase: "queued",
        target: input.target,
        connectionId,
        temporaryAccountId,
      };
    });
  }

  /** Trusted coordinator transition; no browser route exposes this method. */
  async transitionDeploymentPhase(
    context: AppCloudflareAccountContext,
    input: {
      deploymentId: string;
      appGeneration: number;
      leaseToken: string;
      from:
        | "queued"
        | "provisioning"
        | "deploying"
        | "temporary_ready"
        | "claim_pending"
        | "verifying_claim";
      to:
        | "provisioning"
        | "deploying"
        | "temporary_ready"
        | "claim_pending"
        | "verifying_claim"
        | "ready"
        | "expired"
        | "failed";
    },
  ): Promise<void> {
    const allowed = new Set([
      "queued:provisioning",
      "provisioning:deploying",
      "provisioning:failed",
      "deploying:temporary_ready",
      "deploying:ready",
      "deploying:failed",
      "temporary_ready:claim_pending",
      "temporary_ready:expired",
      "claim_pending:verifying_claim",
      "claim_pending:expired",
      "verifying_claim:ready",
      "verifying_claim:failed",
    ]);
    if (!allowed.has(`${input.from}:${input.to}`)) {
      throw new Error("Invalid App deployment phase transition.");
    }
    await this.membership(this.pool, context);
    const result = await this.pool.query(
      `update app_deployments d set phase=$1
       from apps a where d.id=$2 and d.app_id=a.id and a.tenant_id=$3
         and d.app_generation=$4 and d.phase=$5
         and exists (select 1 from app_leases l where l.app_id=d.app_id
           and l.app_generation=d.app_generation and l.lease_token=$6
           and l.expires_at > clock_timestamp()) returning d.id`,
      [
        input.to,
        input.deploymentId,
        context.tenantId,
        input.appGeneration,
        input.from,
        input.leaseToken,
      ],
    );
    if (!result.rows[0]) throw new Error("Stale App deployment phase transition.");
  }

  /** Persist immediately after each Cloudflare create/adopt operation. */
  async recordResourceReceipt(
    context: AppCloudflareAccountContext,
    input: {
      appId: string;
      deploymentId: string;
      appGeneration: number;
      leaseToken: string;
      logicalKey: string;
      resourceKind: AppCloudflareResourceKind;
      mode: "create" | "adopt";
      ownership: "created" | "adopted";
      externalId?: string | null;
      externalName?: string | null;
      stepStatus: AppCloudflareResourceStepStatus;
      metadata?: Record<string, unknown>;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<AppCloudflareResourceReceipt> {
    await this.membership(this.pool, context);
    const logicalKey = requiredString(input.logicalKey, "logicalKey");
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(logicalKey)) {
      throw new Error("Cloudflare resource logical key is invalid.");
    }
    if (
      (input.mode !== "create" && input.mode !== "adopt") ||
      (input.mode === "create" && input.ownership !== "created") ||
      (input.mode === "adopt" && input.ownership !== "adopted")
    ) {
      throw new Error("Cloudflare resource ownership does not match its mode.");
    }
    const externalId = input.externalId ? requiredString(input.externalId, "externalId") : null;
    const externalName = input.externalName
      ? requiredString(input.externalName, "externalName")
      : null;
    if ((externalId?.length || 0) > 512 || (externalName?.length || 0) > 512) {
      throw new Error("Cloudflare external resource identity is too long.");
    }
    const errorCode = input.errorCode ? requiredString(input.errorCode, "errorCode") : null;
    const errorMessage = input.errorMessage
      ? requiredString(input.errorMessage, "errorMessage")
      : null;
    if (
      (errorCode && !/^[A-Za-z0-9._:-]{1,100}$/u.test(errorCode)) ||
      (errorMessage?.length || 0) > 1_000
    ) {
      throw new Error("Cloudflare resource error metadata is invalid.");
    }
    if (errorMessage) assertSafeReceiptValue(errorMessage);
    const metadata = safeReceiptMetadata(input.metadata);
    const deployment = await this.pool.query(
      `select d.*,a.tenant_id from app_deployments d join apps a on a.id=d.app_id
       where d.id=$1 and d.app_id=$2 and a.tenant_id=$3 and d.app_generation=$4
         and a.generation=d.app_generation
         and exists (select 1 from app_leases l where l.app_id=d.app_id
           and l.app_generation=d.app_generation and l.lease_token=$5
           and l.expires_at > clock_timestamp()) limit 1`,
      [input.deploymentId, input.appId, context.tenantId, input.appGeneration, input.leaseToken],
    );
    const row = deployment.rows[0];
    if (
      !row ||
      ![
        "provisioning",
        "deploying",
        "temporary_ready",
        "claim_pending",
        "verifying_claim",
        "ready",
        "failed",
      ].includes(String(row.phase))
    ) {
      throw new Error("Stale or non-provisioning App deployment receipt.");
    }
    if (row.target_kind !== "temporary" && row.target_kind !== "byoc") {
      throw new Error("App deployment has no Cloudflare target.");
    }
    if (
      row.target_kind === "temporary" &&
      input.resourceKind !== "worker" &&
      input.resourceKind !== "assets"
    ) {
      throw new Error("Temporary previews support only Worker and Assets receipts.");
    }
    const id = randomUUID();
    const result = await this.pool.query(
      `insert into app_resource_receipts
       (id,app_id,deployment_id,target_kind,cloudflare_connection_id,temporary_preview_id,
        logical_key,resource_kind,mode,external_id,external_name,ownership,step_status,
        metadata,error_code,error_message)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
       on conflict (deployment_id,resource_kind,logical_key)
       do update set external_id=excluded.external_id,external_name=excluded.external_name,
         step_status=excluded.step_status,metadata=excluded.metadata,error_code=excluded.error_code,
         error_message=excluded.error_message,updated_at=now()
       where app_resource_receipts.mode=excluded.mode
         and app_resource_receipts.ownership=excluded.ownership
       returning *`,
      [
        id,
        input.appId,
        input.deploymentId,
        row.target_kind,
        row.cloudflare_connection_id || null,
        row.temporary_preview_id || null,
        logicalKey,
        input.resourceKind,
        input.mode,
        externalId,
        externalName,
        input.ownership,
        input.stepStatus,
        JSON.stringify(metadata),
        errorCode,
        errorMessage,
      ],
    );
    if (!result.rows[0]) throw new Error("Cloudflare resource receipt conflicts with prior state.");
    return receiptFromRow(result.rows[0]);
  }

  async listDeploymentReceipts(
    context: AppCloudflareAccountContext,
    deploymentId: string,
  ): Promise<AppCloudflareResourceReceipt[]> {
    await this.membership(this.pool, context);
    const result = await this.pool.query(
      `select r.* from app_resource_receipts r
       join apps a on a.id=r.app_id where r.deployment_id=$1 and a.tenant_id=$2
       order by r.created_at,r.id`,
      [deploymentId, context.tenantId],
    );
    return result.rows.map(receiptFromRow);
  }

  async getDeployment(
    context: AppCloudflareAccountContext,
    deploymentId: string,
  ): Promise<AppCloudflareDeploymentProjection> {
    await this.membership(this.pool, context);
    await this.cleanupExpired();
    const result = await this.pool.query(
      `select d.*,a.current_deployment_id,
              p.id preview_id,p.expires_at preview_expires_at,
              p.claim_expires_at preview_claim_expires_at,
              p.claim_ciphertext preview_claim_ciphertext,p.status preview_status,
              p.owner_user_id preview_owner_user_id,
              p.owner_membership_id preview_owner_membership_id
       from app_deployments d join apps a on a.id=d.app_id
       left join cloudflare_temporary_previews p on p.id=d.temporary_preview_id
       where d.id=$1 and a.tenant_id=$2 limit 1`,
      [deploymentId, context.tenantId],
    );
    if (!result.rows[0]) throw new Error("App deployment not found.");
    return deploymentProjectionFromRow(result.rows[0], context, this.now());
  }

  async listDeploymentEvents(
    context: AppCloudflareAccountContext,
    deploymentId: string,
  ): Promise<AppCloudflareDeploymentEvent[]> {
    const deployment = await this.getDeployment(context, deploymentId);
    const result = await this.pool.query(
      `select id,action,created_at from control_plane_audit_log
       where tenant_id=$1 and (
         (resource_type='app_deployment' and resource_id=$2)
         or metadata->>'deploymentId'=$2
       ) order by created_at,id`,
      [context.tenantId, deploymentId],
    );
    const events = result.rows.flatMap((row): AppCloudflareDeploymentEvent[] => {
      const phase = auditActionPhase(String(row.action));
      return phase
        ? [
            {
              id: String(row.id),
              deploymentId,
              phase,
              timestamp: new Date(row.created_at).toISOString(),
              code: null,
            },
          ]
        : [];
    });
    if (events.length) return events;
    return [
      {
        id: `${deploymentId}:current`,
        deploymentId,
        phase: deployment.phase,
        timestamp: deployment.deployedAt || deployment.createdAt,
        code: deployment.errorCode,
      },
    ];
  }

  async setAppTarget(
    context: AppCloudflareAccountContext,
    appId: string,
    input:
      | { target: "unassigned" }
      | { target: "temporary"; temporaryAccountId: string }
      | { target: "byoc"; connectionId: string },
  ): Promise<AppCloudflareTargetRecord> {
    return this.transaction(async (db) => {
      await this.membership(db, context);
      const appResult = await db.query(
        `select * from apps where id=$1 and tenant_id=$2 for update`,
        [appId, context.tenantId],
      );
      const app = appResult.rows[0];
      if (!app) throw new Error("App not found.");
      const canManageOwn =
        app.owner_user_id === context.userId &&
        (await this.hasPermission(db, context, "app:manage-own"));
      if (!canManageOwn && !(await this.hasPermission(db, context, "app:manage-all"))) {
        throw new Error("Forbidden by scoped authorization.");
      }
      let connectionId: string | null = null;
      let temporaryAccountId: string | null = null;
      if (input.target === "byoc") {
        this.requireByocEnabled();
        const connection = await this.readUsableConnection(db, context, input.connectionId);
        connectionId = String(connection.id);
      } else if (input.target === "temporary") {
        this.requireTemporaryEnabled();
        const result = await db.query(
          `select * from cloudflare_temporary_previews
           where id=$1 and tenant_id=$2 and owner_user_id=$3 and owner_membership_id=$4
             and app_id=$5 limit 1`,
          [input.temporaryAccountId, context.tenantId, context.userId, context.membershipId, appId],
        );
        const temporary = result.rows[0];
        if (
          !temporary ||
          (temporary.status !== "ready" && temporary.status !== "claiming") ||
          !temporary.expires_at ||
          new Date(temporary.expires_at).getTime() <= this.now().getTime()
        ) {
          throw new Error("Cloudflare temporary account not found or expired.");
        }
        temporaryAccountId = String(temporary.id);
      }
      const result = await db.query(
        `update apps set target_kind=$1,cloudflare_connection_id=$2,
         temporary_preview_id=$3,updated_at=now()
         where id=$4 and tenant_id=$5 returning *`,
        [input.target, connectionId, temporaryAccountId, appId, context.tenantId],
      );
      await this.audit(db, context, "app.cloudflare.target.updated", "app", appId, {
        target: input.target,
        connectionId,
        temporaryAccountId,
      });
      return this.targetFromAppRow(db, result.rows[0]);
    });
  }

  async getAppTarget(
    context: AppCloudflareAccountContext,
    appId: string,
  ): Promise<AppCloudflareTargetRecord> {
    await this.membership(this.pool, context);
    const result = await this.pool.query(
      `select * from apps where id=$1 and tenant_id=$2 limit 1`,
      [appId, context.tenantId],
    );
    if (!result.rows[0]) throw new Error("App not found.");
    return this.targetFromAppRow(this.pool, result.rows[0]);
  }

  private async targetFromAppRow(db: Db, app: QueryResultRow): Promise<AppCloudflareTargetRecord> {
    let accountId: string | null = null;
    let accountName: string | null = null;
    if (app.cloudflare_connection_id) {
      const connection = await db.query(
        `select account_id,account_name from cloudflare_connections where id=$1`,
        [app.cloudflare_connection_id],
      );
      accountId = connection.rows[0]?.account_id || null;
      accountName = connection.rows[0]?.account_name || null;
    } else if (app.temporary_preview_id) {
      const temporary = await db.query(
        `select account_id,account_name from cloudflare_temporary_previews where id=$1`,
        [app.temporary_preview_id],
      );
      accountId = temporary.rows[0]?.account_id || null;
      accountName = temporary.rows[0]?.account_name || null;
    }
    return {
      appId: String(app.id),
      target: (app.target_kind || "unassigned") as AppCloudflareDeploymentTarget,
      connectionId: app.cloudflare_connection_id ? String(app.cloudflare_connection_id) : null,
      temporaryAccountId: app.temporary_preview_id ? String(app.temporary_preview_id) : null,
      accountId: accountId ? String(accountId) : null,
      accountName: accountName ? String(accountName) : null,
    };
  }

  /** Trusted runtime use only. Never pass this result to a Hono response. */
  async resolveDeploymentCredential(
    context: AppCloudflareAccountContext,
    appId: string,
    deploymentId: string,
    appGeneration: number,
  ): Promise<AppCloudflareDeploymentCredential> {
    await this.membership(this.pool, context);
    const deployment = await this.pool.query(
      `select d.* from app_deployments d join apps a on a.id=d.app_id
       where d.id=$1 and d.app_id=$2 and d.app_generation=$3
         and a.tenant_id=$4 and a.generation=$3 limit 1`,
      [deploymentId, appId, appGeneration, context.tenantId],
    );
    const row = deployment.rows[0];
    if (!row) throw new Error("App deployment credential authority is stale.");
    if (row.target_kind === "temporary" && row.temporary_preview_id) {
      this.requireTemporaryEnabled();
      const result = await this.pool.query(
        `select * from cloudflare_temporary_previews
         where id=$1 and tenant_id=$2 and owner_user_id=$3 and app_id=$4
           and owner_membership_id=$5 limit 1`,
        [row.temporary_preview_id, context.tenantId, context.userId, appId, context.membershipId],
      );
      const temporary = result.rows[0];
      if (
        !temporary ||
        (temporary.status !== "ready" && temporary.status !== "claiming") ||
        !temporary.expires_at ||
        new Date(temporary.expires_at).getTime() <= this.now().getTime()
      ) {
        throw new Error("Cloudflare temporary deployment credential is unavailable.");
      }
      const stored = this.decrypt<StoredTemporaryCredential>(
        temporary,
        "credential",
        `apps-cloudflare:temporary:${context.tenantId}:${temporary.id}:credential`,
      );
      return {
        target: "temporary",
        accountId: String(temporary.account_id),
        apiToken: requiredString(stored.apiToken, "apiToken"),
        connectionId: null,
        temporaryAccountId: String(temporary.id),
        expiresAt: new Date(temporary.expires_at).toISOString(),
      };
    }
    if (row.target_kind === "byoc" && row.cloudflare_connection_id) {
      this.requireByocEnabled();
      let connection = await this.readUsableConnection(
        this.pool,
        context,
        String(row.cloudflare_connection_id),
        true,
      );
      if (
        connection.status === "refresh_required" ||
        (connection.access_expires_at &&
          new Date(connection.access_expires_at).getTime() <= this.now().getTime() + 60_000)
      ) {
        await this.refreshConnectionRow(context, connection);
        connection = await this.readUsableConnection(
          this.pool,
          context,
          String(row.cloudflare_connection_id),
        );
      }
      this.assertConnectionGrants(connection, row.binding_manifest);
      const stored = this.decrypt<StoredOAuthCredential>(
        connection,
        "credential",
        `apps-cloudflare:connection:${context.tenantId}:${connection.id}:credential`,
      );
      return {
        target: "byoc",
        accountId: String(connection.account_id),
        apiToken: requiredString(stored.accessToken, "accessToken"),
        connectionId: String(connection.id),
        temporaryAccountId: null,
        expiresAt: stored.accessExpiresAt,
      };
    }
    throw new Error("App has no Cloudflare deployment target.");
  }

  /** Trusted custom-domain runner use only. Never pass this result to a response. */
  async resolveConnectionCredential(
    context: AppCloudflareAccountContext,
    appId: string,
    connectionId: string,
  ): Promise<AppCloudflareDeploymentCredential> {
    this.requireByocEnabled();
    await this.membership(this.pool, context);
    const app = await this.requireManageApp(this.pool, context, appId);
    if (
      app.target_kind !== "byoc" ||
      !app.cloudflare_connection_id ||
      String(app.cloudflare_connection_id) !== connectionId
    ) {
      throw new Error("App Cloudflare connection authority is stale.");
    }
    let connection = await this.readUsableConnection(this.pool, context, connectionId, true);
    if (
      connection.status === "refresh_required" ||
      (connection.access_expires_at &&
        new Date(connection.access_expires_at).getTime() <= this.now().getTime() + 60_000)
    ) {
      await this.refreshConnectionRow(context, connection);
      connection = await this.readUsableConnection(this.pool, context, connectionId);
    }
    const stored = this.decrypt<StoredOAuthCredential>(
      connection,
      "credential",
      `apps-cloudflare:connection:${context.tenantId}:${connection.id}:credential`,
    );
    return {
      target: "byoc",
      accountId: String(connection.account_id),
      apiToken: requiredString(stored.accessToken, "accessToken"),
      connectionId: String(connection.id),
      temporaryAccountId: null,
      expiresAt: stored.accessExpiresAt,
    };
  }

  async cleanupExpired(): Promise<{ temporaryAccounts: number; oauthAttempts: number }> {
    const temporaryAccounts = await this.expireTemporaryPreviews(this.pool);
    const oauth = await this.pool.query(
      `update cloudflare_oauth_states set status='expired',consumed_at=coalesce(consumed_at,now()),
       verifier_ciphertext=null,verifier_iv=null,verifier_auth_tag=null,verifier_key_version=null
       where status='pending' and expires_at <= now() returning id`,
    );
    return { temporaryAccounts, oauthAttempts: oauth.rowCount || 0 };
  }

  /**
   * Run from the process maintenance timer, which intentionally has no user
   * request/RLS context. The migration-owned function performs the same
   * expiry transitions under a narrowly scoped SECURITY DEFINER boundary and
   * returns counts only.
   */
  async cleanupExpiredForMaintenance(): Promise<{
    temporaryAccounts: number;
    oauthAttempts: number;
  }> {
    const result = await this.pool.query<{
      temporary_accounts: number | string;
      oauth_attempts: number | string;
    }>("select * from piwork_cleanup_cloudflare_expired()");
    const row = result.rows[0];
    return {
      temporaryAccounts: row ? Number(row.temporary_accounts) : 0,
      oauthAttempts: row ? Number(row.oauth_attempts) : 0,
    };
  }

  private async expireTemporaryPreviews(db: Db, ids?: string[]): Promise<number> {
    const selectedIds = ids?.map((id) => requiredString(id, "temporaryAccountId"));
    const predicate = selectedIds ? "id = any($1::text[])" : "expires_at <= now()";
    const result = await db.query(
      `with abandoned_previews as (
         update cloudflare_temporary_previews set status='failed',
           last_error_code='provisioning_abandoned',updated_at=now()
         where status='provisioning' and created_at <= now() - interval '10 minutes'
         returning id
       ), newly_expired as (
         update cloudflare_temporary_previews set status='expired',
           credential_ciphertext=null,credential_iv=null,credential_auth_tag=null,credential_key_version=null,
           claim_ciphertext=null,claim_iv=null,claim_auth_tag=null,claim_key_version=null,updated_at=now()
         where status in ('ready','claiming') and ${predicate}
         returning id,app_id
       ), expired_previews as (
         select id,app_id from newly_expired
         union
         select id,app_id from cloudflare_temporary_previews
         where status='expired' and ${predicate}
       ), expired_deployments as (
         update app_deployments d set phase='expired',stable_url=null,
           error_code='temporary_account_expired',error_message=$${selectedIds ? 2 : 1}
         from expired_previews p
         where d.temporary_preview_id=p.id and d.app_id=p.app_id
           and d.phase in ('queued','provisioning','deploying','temporary_ready',
             'claim_pending','verifying_claim')
         returning d.id,d.app_id,d.app_generation,d.temporary_preview_id
       ), affected_apps as (
         update apps a set status='needs_action',status_reason=$${selectedIds ? 2 : 1},
           stable_url=null,target_kind='unassigned',cloudflare_connection_id=null,
           temporary_preview_id=null,updated_at=now()
         from expired_previews p
         where a.id=p.app_id and a.temporary_preview_id=p.id
         returning a.id
       )
       select id from newly_expired`,
      selectedIds
        ? [selectedIds, TEMPORARY_ACCOUNT_EXPIRED_MESSAGE]
        : [TEMPORARY_ACCOUNT_EXPIRED_MESSAGE],
    );
    return result.rowCount || 0;
  }
}
