export type AppCloudflareConnectionScope = "user" | "tenant";

export type AppCloudflareOAuthPurpose = "direct" | "claim";

/** Browser-safe feature configuration. Turnstile's secret key is server-only. */
export interface AppCloudflareBrowserConfig {
  temporaryEnabled: boolean;
  byocEnabled: boolean;
  turnstileEnabled: boolean;
  siteKey: string | null;
}

export type AppCloudflareConnectionStatus = "active" | "refresh_required" | "error" | "revoked";

export type AppCloudflareTemporaryAccountStatus =
  "provisioning" | "ready" | "claiming" | "claimed" | "expired" | "failed";

export type AppCloudflareDeploymentTarget = "unassigned" | "temporary" | "byoc";

export interface AppCloudflareAccountContext {
  tenantId: string;
  userId: string;
  membershipId: string;
}

/** Browser-safe permanent account metadata. OAuth credentials are intentionally absent. */
export interface AppCloudflareAccountConnection {
  id: string;
  tenantId: string;
  scope: AppCloudflareConnectionScope;
  ownerUserId: string | null;
  ownerMembershipId: string | null;
  accountId: string;
  accountName: string;
  grantedScopes: string[];
  status: AppCloudflareConnectionStatus;
  accessExpiresAt: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface AppCloudflareZone {
  id: string;
  name: string;
  status: string;
}

export interface AppCloudflareDeploymentProjection {
  id: string;
  appId: string;
  version: number;
  phase: string;
  targetKind: AppCloudflareDeploymentTarget;
  sourceDigest: string;
  cloudflareVersionId: string | null;
  stableUrl: string | null;
  requestedCustomDomain: string | null;
  temporaryPreview: {
    id: string | null;
    expiresAt: string | null;
    claimExpiresAt: string | null;
    claimAvailable: boolean;
  } | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: string;
  deployedAt: string | null;
  current: boolean;
}

export interface AppCloudflareDeploymentEvent {
  id: string;
  deploymentId: string;
  phase: string;
  timestamp: string;
  code: string | null;
}

/** Browser-safe temporary account metadata. API and claim bearer tokens are absent. */
export interface AppCloudflareTemporaryAccount {
  id: string;
  appId: string;
  tenantId: string;
  ownerUserId: string;
  ownerMembershipId: string;
  accountId: string | null;
  accountName: string | null;
  status: AppCloudflareTemporaryAccountStatus;
  accountExpiresAt: string | null;
  claimExpiresAt: string | null;
  expiresAt: string | null;
  claimAvailable: boolean;
  claimedConnectionId: string | null;
  policiesAcceptedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppCloudflareTargetRecord {
  appId: string;
  target: AppCloudflareDeploymentTarget;
  connectionId: string | null;
  temporaryAccountId: string | null;
  accountId: string | null;
  accountName: string | null;
}

export interface AppCloudflareQueuedDeployment {
  appId: string;
  deploymentId: string;
  appGeneration: number;
  phase:
    | "queued"
    | "provisioning"
    | "deploying"
    | "temporary_ready"
    | "claim_pending"
    | "verifying_claim"
    | "ready"
    | "expired"
    | "failed"
    | "cancelled";
  target: Exclude<AppCloudflareDeploymentTarget, "unassigned">;
  connectionId: string | null;
  temporaryAccountId: string | null;
}

export type AppCloudflareResourceKind =
  "worker" | "assets" | "kv" | "r2" | "d1" | "durable_object" | "domain";

export type AppCloudflareResourceStepStatus =
  "planned" | "provisioning" | "ready" | "failed" | "needs_cleanup";

export interface AppCloudflareResourceReceipt {
  id: string;
  appId: string;
  deploymentId: string;
  target: Exclude<AppCloudflareDeploymentTarget, "unassigned">;
  connectionId: string | null;
  temporaryAccountId: string | null;
  logicalKey: string;
  resourceKind: AppCloudflareResourceKind;
  mode: "create" | "adopt";
  ownership: "created" | "adopted";
  externalId: string | null;
  externalName: string | null;
  stepStatus: AppCloudflareResourceStepStatus;
  metadata: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Trusted-server-only deployment credentials. Never serialize this into an API response. */
export interface AppCloudflareDeploymentCredential {
  target: Exclude<AppCloudflareDeploymentTarget, "unassigned">;
  accountId: string;
  apiToken: string;
  connectionId: string | null;
  temporaryAccountId: string | null;
  expiresAt: string | null;
}
