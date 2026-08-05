import type { PiworkAppManifestV1 } from "./app-manifest.js";

export const APP_STATUSES = [
  "building",
  "needs_action",
  "deploying",
  "preview",
  "ready",
  "failed",
  "archived",
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const APP_DEPLOYMENT_PHASES = [
  "building",
  "awaiting_target",
  "awaiting_oauth",
  "queued",
  "provisioning",
  "deploying",
  "temporary_ready",
  "claim_pending",
  "verifying_claim",
  "ready",
  "expired",
  "failed",
  "cancelled",
] as const;
export type AppDeploymentPhase = (typeof APP_DEPLOYMENT_PHASES)[number];
export type AppCloudflareTargetKind = "unassigned" | "temporary" | "byoc";

export const APP_DOMAIN_STATUSES = ["pending", "active", "failed", "removing"] as const;
export type AppDomainStatus = (typeof APP_DOMAIN_STATUSES)[number];

export const APP_SSL_STATUSES = [
  "pending_validation",
  "pending_issuance",
  "active",
  "failed",
] as const;
export type AppSslStatus = (typeof APP_SSL_STATUSES)[number];

export type AppListScope = "current-session" | "mine" | "tenant";
export type AppOperationMode = "agent" | "plan" | "ui";

/** Validated, versioned piwork.app.json persisted with every deployment. */
export type AppManifest = PiworkAppManifestV1;

export interface AppOperationContext {
  tenantId: string;
  userId: string;
  membershipId?: string;
  sessionId?: string;
  /** Session/runtime generation captured before the operation began. */
  generation: number;
  rootTask: boolean;
  readOnly: boolean;
  mode: AppOperationMode;
  idempotencyKey?: string;
  explicitIntent?: boolean;
}

export interface AppRecord {
  id: string;
  tenantId: string;
  ownerMembershipId: string;
  ownerUserId: string;
  sourceSessionId: string | null;
  sourceSessionGeneration: number;
  tenantHandle: string;
  workerName: string;
  slug: string;
  name: string;
  status: AppStatus;
  statusReason: string | null;
  stableUrl: string | null;
  screenshotUrl: string | null;
  currentDeploymentId: string | null;
  generation: number;
  customDomain: AppCustomDomainRecord | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  canManage: boolean;
  targetKind: AppCloudflareTargetKind;
  cloudflareConnectionId: string | null;
  temporaryPreviewId: string | null;
}

export interface AppDeploymentRecord {
  id: string;
  appId: string;
  version: number;
  phase: AppDeploymentPhase;
  targetKind: AppCloudflareTargetKind;
  cloudflareConnectionId: string | null;
  temporaryPreviewId: string | null;
  sourceSessionId: string;
  sourceSessionGeneration: number;
  sourceDigest: string;
  artifactKey: string | null;
  manifest: AppManifest;
  bindingManifest: Record<string, unknown>;
  cloudflareVersionId: string | null;
  cloudflareMigrationTag: string | null;
  stableUrl: string | null;
  screenshotUrl: string | null;
  warnings: Array<{ code: string; message: string; path?: string }>;
  errorCode: string | null;
  errorMessage: string | null;
  rollbackOfDeploymentId: string | null;
  idempotencyKey: string;
  appGeneration: number;
  createdBy: string;
  createdAt: string;
  deployedAt: string | null;
}

export interface AppCustomDomainRecord {
  id: string;
  appId: string;
  hostname: string;
  cloudflareConnectionId: string;
  zoneId: string;
  cloudflareHostnameId: string | null;
  certificateId: string | null;
  status: AppDomainStatus;
  sslStatus: AppSslStatus;
  validationRecords: Array<{ type: string; name: string; value: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface AppListInput {
  scope: AppListScope;
  sessionId?: string;
  cursor?: string;
  limit?: number;
}

export interface AppListResponse {
  apps: AppRecord[];
  nextCursor: string | null;
}

export interface AppVersionsResponse {
  versions: AppDeploymentRecord[];
  nextCursor: string | null;
}

export interface BeginAppDeploymentInput {
  appId?: string;
  slug?: string;
  name?: string;
  sourceDigest: string;
  manifest: AppManifest;
  bindingManifest: Record<string, unknown>;
  artifactKey?: string;
  sourceSnapshotKey?: string;
  rollbackOfDeploymentId?: string;
}

export interface CompleteAppDeploymentInput {
  appId: string;
  deploymentId: string;
  appGeneration: number;
  leaseToken: string;
  phase: "temporary_ready" | "ready";
  cloudflareVersionId: string;
  cloudflareMigrationTag?: string;
  stableUrl: string;
  artifactKey: string;
  screenshotUrl?: string;
  warnings?: AppDeploymentRecord["warnings"];
}

export interface AppContinueDevelopmentResponse {
  appId: string;
  sourceSessionId: string | null;
  sourceSnapshotKey: string | null;
  restoreRequired: boolean;
}

export interface AppOperationOutboxRecord {
  id: string;
  appId: string;
  tenantId: string;
  operation: "deploy" | "rollback" | "domain_set" | "claim_verify";
  payload: Record<string, unknown>;
  appGeneration: number;
  idempotencyKey: string;
  attempts: number;
  leaseOwner: string;
  leaseUntil: string;
}

export interface AppLeaseRecord {
  appId: string;
  leaseToken: string;
  holder: string;
  appGeneration: number;
  expiresAt: string;
}
