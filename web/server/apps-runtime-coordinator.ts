import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthenticatedUser } from "./auth-types.js";
import { collectAppBuildArtifact, type AppBuildArtifact } from "./app-build.js";
import {
  CloudflareByocAdapter,
  deserializeAppArtifact,
  serializeAppArtifact,
  TemporaryPreviewAdapter,
  type AppRuntimeDriver,
  type AppRuntimePreparedResources,
  type AppRuntimeResourceReceipt,
  type AppRuntimeTarget,
} from "./app-runtime-driver.js";
import { createAppSourceSnapshot } from "./app-source-snapshot.js";
import type { AppCloudflareAccountService } from "./apps-cloudflare-account-service.js";
import type {
  AppCloudflareAccountContext,
  AppCloudflareQueuedDeployment,
  AppCloudflareResourceReceipt,
} from "./apps-cloudflare-account-types.js";
import type { AppsControlPlane } from "./apps-control-plane.js";
import type {
  AppDeploymentRecord,
  AppListInput,
  AppOperationContext,
  AppRecord,
} from "./apps-types.js";
import { ENV, envFlag } from "./environment.js";
import type { PiBrokerRequest, PiBrokerRequestContext } from "./pi-broker-server.js";

export interface AppBrokerScope {
  sessionId: string;
  generation: number;
  sessionRoot: string;
  workspaceDir: string;
}

export interface AppsRuntimeCoordinatorOptions {
  controlPlane: AppsControlPlane;
  cloudflareAccounts: AppCloudflareAccountService;
  driver: AppRuntimeDriver;
  getCurrentUser(): AuthenticatedUser | null;
  /** Creator-owned user/profile root. Source snapshots never enter tenant-shared storage. */
  creatorRoot: string;
  resolveCreatorRoot?: (ownerUserId: string) => string;
}

export interface AppsRuntimeUiOperations {
  rollback(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
    signal?: AbortSignal,
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }>;
  delete(context: AppOperationContext, appId: string): Promise<AppRecord>;
  restore(context: AppOperationContext, appId: string): Promise<AppRecord>;
  handleDeploymentTargetQueued(
    context: AppCloudflareAccountContext,
    deployment: AppCloudflareQueuedDeployment,
  ): Promise<void>;
  setCustomDomain(
    context: AppOperationContext,
    appId: string,
    input: { connectionId: string; zoneId: string; hostname: string; confirmImpact: true },
  ): Promise<AppRecord>;
  removeCustomDomain(
    context: AppOperationContext,
    appId: string,
    input: { connectionId: string; zoneId: string; hostname: string; confirmImpact: true },
  ): Promise<AppRecord>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function brokerIdempotencyKey(requestId: string): string {
  return `broker:${createHash("sha256").update(requestId).digest("hex")}`;
}

const CREATOR_ARTIFACT_PREFIX = "creator-artifact:";

function deploymentError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function receiptJurisdiction(value: unknown): "default" | "eu" | "fedramp" | null {
  return value === "default" || value === "eu" || value === "fedramp" ? value : null;
}

function runtimeReceipt(receipt: AppCloudflareResourceReceipt): AppRuntimeResourceReceipt | null {
  if (
    receipt.resourceKind === "worker" ||
    receipt.resourceKind === "assets" ||
    receipt.resourceKind === "domain"
  ) {
    return null;
  }
  const binding =
    typeof receipt.metadata.binding === "string" && receipt.metadata.binding.trim()
      ? receipt.metadata.binding.trim()
      : receipt.logicalKey;
  return {
    logicalKey: receipt.logicalKey,
    kind: receipt.resourceKind,
    binding,
    mode: receipt.resourceKind === "durable_object" ? "created" : receipt.mode,
    ownership: receipt.ownership,
    externalId: receipt.externalId,
    externalName: receipt.externalName,
    jurisdiction: receiptJurisdiction(receipt.metadata.jurisdiction),
    stepStatus: receipt.stepStatus,
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code || "");
    if (/^[A-Za-z0-9._:-]{1,100}$/u.test(code)) return code;
  }
  return "app_deployment_failed";
}

function internalContext(context: AppOperationContext): AppOperationContext {
  return {
    ...context,
    rootTask: true,
    readOnly: false,
    mode: "agent",
  };
}

function deploymentWarnings(artifact: AppBuildArtifact): AppDeploymentRecord["warnings"] {
  return artifact.warnings.map((warning) => ({
    code: warning.code,
    path: warning.path,
    message: `${warning.path} is ${String(warning.size)} bytes; Cloudflare assets are limited to ${String(
      warning.limit,
    )} bytes per file.`,
  }));
}

/**
 * Connects trusted Pi broker operations and authenticated UI mutations to the
 * Postgres authority and the configured deployment driver. The coordinator
 * owns ordering; neither Agent payloads nor browser headers own App identity,
 * tenant identity, or session generation.
 */
export class AppsRuntimeCoordinator implements AppsRuntimeUiOperations {
  private readonly controlPlane: AppsControlPlane;
  private readonly cloudflareAccounts: AppCloudflareAccountService;
  private readonly temporaryAdapter: TemporaryPreviewAdapter;
  private readonly byocAdapter: CloudflareByocAdapter;
  private readonly getCurrentUser: AppsRuntimeCoordinatorOptions["getCurrentUser"];
  private readonly creatorRoot: string;
  private readonly resolveCreatorRoot: (ownerUserId: string) => string;

  private startLeaseHeartbeat(input: {
    appId: string;
    appGeneration: number;
    leaseToken: string;
    ttlMs: number;
    errorCode: string;
    errorMessage: string;
  }): {
    ensure(): Promise<void>;
    lost(): boolean;
    stop(): void;
  } {
    let leaseLost = false;
    let renewal: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (leaseLost) return;
      if (!renewal) {
        renewal = this.controlPlane
          .renewLease(input.appId, input.leaseToken, input.appGeneration, input.ttlMs)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            renewal = null;
          });
      }
      await renewal;
    };
    const ensure = async (): Promise<void> => {
      await renew();
      if (leaseLost) throw deploymentError(input.errorCode, input.errorMessage);
    };
    const heartbeat = setInterval(() => void renew(), Math.max(1_000, input.ttlMs / 4));
    heartbeat.unref?.();
    return {
      ensure,
      lost: () => leaseLost,
      stop: () => clearInterval(heartbeat),
    };
  }

  constructor(options: AppsRuntimeCoordinatorOptions) {
    this.controlPlane = options.controlPlane;
    this.cloudflareAccounts = options.cloudflareAccounts;
    this.temporaryAdapter = new TemporaryPreviewAdapter(options.driver);
    this.byocAdapter = new CloudflareByocAdapter(options.driver);
    this.getCurrentUser = options.getCurrentUser;
    this.creatorRoot = options.creatorRoot;
    this.resolveCreatorRoot = options.resolveCreatorRoot || (() => options.creatorRoot);
  }

  private user(): AuthenticatedUser & { tenantId: string; membershipId: string } {
    const user = this.getCurrentUser();
    if (!user) throw new Error("Unauthorized");
    if (!user.tenantId || !user.membershipId) throw new Error("Tenant membership not found.");
    return user as AuthenticatedUser & { tenantId: string; membershipId: string };
  }

  private brokerContext(
    request: PiBrokerRequest,
    scope: AppBrokerScope,
    explicitIntent = false,
  ): AppOperationContext {
    const user = this.user();
    if (request.sessionId !== scope.sessionId || request.generation !== scope.generation) {
      throw new Error("Managed App broker authority is stale.");
    }
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      membershipId: user.membershipId,
      sessionId: scope.sessionId,
      generation: scope.generation,
      rootTask: true,
      readOnly: false,
      mode: "agent",
      idempotencyKey: brokerIdempotencyKey(request.id),
      explicitIntent,
    };
  }

  private checkDeploySwitches(): void {
    if (envFlag(ENV.PIWORK_APPS_KILL_SWITCH)) {
      throw new Error("App deployments are paused by the platform operator.");
    }
  }

  private async failDeployment(
    context: AppOperationContext,
    app: AppRecord,
    deployment: AppDeploymentRecord,
    error: unknown,
    leaseToken?: string,
  ): Promise<boolean> {
    try {
      await this.controlPlane.failDeployment(internalContext(context), {
        appId: app.id,
        deploymentId: deployment.id,
        appGeneration: deployment.appGeneration,
        errorCode: errorCode(error),
        error,
        ...(leaseToken ? { leaseToken } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async persistStagedArtifact(artifact: AppBuildArtifact): Promise<string> {
    const creatorRoot = await realpath(this.creatorRoot);
    const directory = join(creatorRoot, "published-apps", "staged-artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const digest = artifact.artifactDigest;
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error("App artifact digest is invalid.");
    const destination = join(directory, `${digest}.json`);
    const bytes = serializeAppArtifact(artifact);
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, destination).catch(async (error) => {
        const existing = await readFile(destination).catch(() => null);
        if (!existing || !existing.equals(Buffer.from(bytes))) throw error;
      });
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return `${CREATOR_ARTIFACT_PREFIX}${digest}`;
  }

  private async readStagedArtifact(
    ownerUserId: string,
    deployment: AppDeploymentRecord,
  ): Promise<AppBuildArtifact> {
    if (!deployment.artifactKey?.startsWith(CREATOR_ARTIFACT_PREFIX)) {
      throw deploymentError("app_artifact_unavailable", "App deployment artifact is unavailable.");
    }
    const digest = deployment.artifactKey.slice(CREATOR_ARTIFACT_PREFIX.length);
    if (!/^[a-f0-9]{64}$/u.test(digest)) {
      throw deploymentError("app_artifact_invalid", "App deployment artifact locator is invalid.");
    }
    const creatorRoot = await realpath(this.resolveCreatorRoot(ownerUserId));
    const expected = join(creatorRoot, "published-apps", "staged-artifacts", `${digest}.json`);
    const actual = await realpath(expected).catch(() => "");
    if (!actual || actual !== expected) {
      throw deploymentError("app_artifact_unavailable", "App deployment artifact is unavailable.");
    }
    const artifact = deserializeAppArtifact(await readFile(actual));
    if (artifact.artifactDigest !== digest || artifact.sourceDigest !== deployment.sourceDigest) {
      throw deploymentError(
        "app_artifact_digest_mismatch",
        "App deployment artifact digest does not match.",
      );
    }
    return artifact;
  }

  private deploymentContext(
    context: AppCloudflareAccountContext,
    deployment: AppDeploymentRecord,
  ): AppOperationContext {
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      membershipId: context.membershipId,
      sessionId: deployment.sourceSessionId,
      generation: deployment.sourceSessionGeneration,
      rootTask: true,
      readOnly: false,
      mode: "agent",
      idempotencyKey: deployment.idempotencyKey,
      explicitIntent: true,
    };
  }

  private async persistRuntimeReceipt(
    context: AppCloudflareAccountContext,
    deployment: AppDeploymentRecord,
    receipt: AppRuntimeResourceReceipt,
    leaseToken: string,
  ): Promise<void> {
    await this.cloudflareAccounts.recordResourceReceipt(context, {
      appId: deployment.appId,
      deploymentId: deployment.id,
      appGeneration: deployment.appGeneration,
      leaseToken,
      logicalKey: receipt.logicalKey,
      resourceKind: receipt.kind,
      mode: receipt.mode === "adopt" ? "adopt" : "create",
      ownership: receipt.ownership,
      externalId: receipt.externalId,
      externalName: receipt.externalName,
      stepStatus: receipt.stepStatus,
      metadata: {
        binding: receipt.binding,
        ...(receipt.jurisdiction ? { jurisdiction: receipt.jurisdiction } : {}),
      },
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
    });
  }

  private async persistCoreReceipt(
    context: AppCloudflareAccountContext,
    deployment: AppDeploymentRecord,
    input: {
      logicalKey: "worker" | "assets";
      stepStatus: "provisioning" | "ready" | "failed";
      externalId?: string | null;
      externalName?: string | null;
      error?: unknown;
    },
    leaseToken: string,
  ): Promise<void> {
    await this.cloudflareAccounts.recordResourceReceipt(context, {
      appId: deployment.appId,
      deploymentId: deployment.id,
      appGeneration: deployment.appGeneration,
      leaseToken,
      logicalKey: input.logicalKey,
      resourceKind: input.logicalKey,
      mode: "create",
      ownership: "created",
      externalId: input.externalId ?? null,
      externalName: input.externalName ?? null,
      stepStatus: input.stepStatus,
      ...(input.error
        ? {
            errorCode: errorCode(input.error),
            errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
          }
        : {}),
    });
  }

  async handleDeploymentTargetQueued(
    accountContext: AppCloudflareAccountContext,
    queued: AppCloudflareQueuedDeployment,
  ): Promise<void> {
    this.checkDeploySwitches();
    const holder = `cloudflare-deploy:${queued.deploymentId}:${randomUUID()}`;
    const leaseTtlMs = 300_000;
    const lease = await this.controlPlane.acquireLease(
      queued.appId,
      holder,
      queued.appGeneration,
      leaseTtlMs,
    );
    if (!lease) throw deploymentError("app_deployment_busy", "App deployment is already running.");

    let leaseLost = false;
    let leaseRenewalRunning = false;
    const renewLease = async (): Promise<void> => {
      if (leaseLost || leaseRenewalRunning) return;
      leaseRenewalRunning = true;
      try {
        if (
          !(await this.controlPlane.renewLease(
            queued.appId,
            lease.leaseToken,
            queued.appGeneration,
            leaseTtlMs,
          ))
        ) {
          leaseLost = true;
        }
      } catch {
        leaseLost = true;
      } finally {
        leaseRenewalRunning = false;
      }
    };
    const ensureLease = async (): Promise<void> => {
      await renewLease();
      if (leaseLost) {
        throw deploymentError(
          "app_deployment_lease_lost",
          "App deployment lease was lost before the operation completed.",
        );
      }
    };
    const leaseHeartbeat = setInterval(() => void renewLease(), 60_000);
    leaseHeartbeat.unref?.();

    let deployment: AppDeploymentRecord | undefined;
    let operation: "deploy" | "rollback" = "deploy";
    let preparedResources: AppRuntimePreparedResources | undefined;
    let workerReceiptStarted = false;
    let assetsReceiptStarted = false;
    try {
      const lookupContext: AppOperationContext = {
        tenantId: accountContext.tenantId,
        userId: accountContext.userId,
        membershipId: accountContext.membershipId,
        generation: queued.appGeneration,
        rootTask: true,
        readOnly: false,
        mode: "agent",
      };
      const app = await this.controlPlane.getApp(lookupContext, queued.appId);
      deployment = await this.controlPlane.getDeployment(
        lookupContext,
        queued.appId,
        queued.deploymentId,
      );
      if (
        deployment.appGeneration !== queued.appGeneration ||
        app.generation !== queued.appGeneration
      ) {
        throw deploymentError(
          "app_deployment_stale",
          "Stale deployment cannot overwrite this App.",
        );
      }
      if (
        deployment.phase === "temporary_ready" ||
        deployment.phase === "claim_pending" ||
        deployment.phase === "verifying_claim" ||
        deployment.phase === "ready"
      ) {
        return;
      }
      if (
        deployment.phase === "failed" ||
        deployment.phase === "expired" ||
        deployment.phase === "cancelled"
      ) {
        // The durable worker may be replaying an outbox record after another
        // actor finalized the deployment. Returning lets the outbox worker
        // acknowledge that terminal record instead of retrying it forever.
        return;
      }
      if (
        deployment.phase !== "queued" &&
        deployment.phase !== "provisioning" &&
        deployment.phase !== "deploying"
      ) {
        throw deploymentError("app_deployment_not_queued", "App deployment target is not queued.");
      }
      if (deployment.targetKind !== queued.target) {
        throw deploymentError("app_deployment_target_mismatch", "App deployment target changed.");
      }

      const context = this.deploymentContext(accountContext, deployment);
      const artifact = await this.readStagedArtifact(app.ownerUserId, deployment);
      const credential = await this.cloudflareAccounts.resolveDeploymentCredential(
        accountContext,
        app.id,
        deployment.id,
        deployment.appGeneration,
      );
      await ensureLease();
      await (queued.target === "temporary"
        ? this.temporaryAdapter.validate(artifact)
        : this.byocAdapter.validate(artifact));
      if (deployment.phase === "queued") {
        await this.cloudflareAccounts.transitionDeploymentPhase(accountContext, {
          deploymentId: deployment.id,
          appGeneration: deployment.appGeneration,
          leaseToken: lease.leaseToken,
          from: "queued",
          to: "provisioning",
        });
        deployment = { ...deployment, phase: "provisioning" };
      }

      const currentReceipts = await this.cloudflareAccounts.listDeploymentReceipts(
        accountContext,
        deployment.id,
      );
      let priorDeployment: AppDeploymentRecord | null = null;
      if (app.currentDeploymentId && app.currentDeploymentId !== deployment.id) {
        priorDeployment = await this.controlPlane.getDeployment(
          context,
          app.id,
          app.currentDeploymentId,
        );
      }
      const sameTarget =
        priorDeployment?.targetKind === deployment.targetKind &&
        (deployment.targetKind === "byoc"
          ? priorDeployment.cloudflareConnectionId === deployment.cloudflareConnectionId
          : deployment.targetKind === "temporary" &&
            priorDeployment.temporaryPreviewId === deployment.temporaryPreviewId);
      const priorReceipts =
        sameTarget && priorDeployment
          ? await this.cloudflareAccounts.listDeploymentReceipts(accountContext, priorDeployment.id)
          : [];
      const receiptMap = new Map<string, AppCloudflareResourceReceipt>();
      for (const receipt of [...priorReceipts, ...currentReceipts]) {
        receiptMap.set(`${receipt.resourceKind}:${receipt.logicalKey}`, receipt);
      }
      const prepared =
        queued.target === "temporary"
          ? { receipts: [] }
          : await this.byocAdapter.prepareResources({
              target: {
                appId: app.id,
                tenantId: app.tenantId,
                workerName: app.workerName,
                ownerUserId: app.ownerUserId,
              },
              credential,
              bindings: artifact.bindings,
              existingReceipts: [...receiptMap.values()]
                .map(runtimeReceipt)
                .filter((receipt): receipt is AppRuntimeResourceReceipt => receipt !== null),
              onReceipt: async (receipt) => {
                await ensureLease();
                await this.persistRuntimeReceipt(
                  accountContext,
                  deployment!,
                  receipt,
                  lease.leaseToken,
                );
              },
            });
      if (queued.target === "byoc") preparedResources = prepared;
      await ensureLease();
      deployment = await this.controlPlane.markDeploymentDeploying(
        context,
        app.id,
        deployment.id,
        deployment.appGeneration,
        lease.leaseToken,
      );
      operation = deployment.rollbackOfDeploymentId ? "rollback" : "deploy";

      const target: AppRuntimeTarget = {
        appId: app.id,
        tenantId: app.tenantId,
        workerName: app.workerName,
        ownerUserId: app.ownerUserId,
      };
      await this.persistCoreReceipt(
        accountContext,
        deployment,
        {
          logicalKey: "worker",
          stepStatus: "provisioning",
          externalId: app.workerName,
        },
        lease.leaseToken,
      );
      workerReceiptStarted = true;
      if (artifact.assets.length > 0) {
        await this.persistCoreReceipt(
          accountContext,
          deployment,
          {
            logicalKey: "assets",
            stepStatus: "provisioning",
            externalId: artifact.artifactDigest,
          },
          lease.leaseToken,
        );
        assetsReceiptStarted = true;
      }

      let result;
      if (deployment.rollbackOfDeploymentId) {
        if (queued.target !== "byoc") {
          throw deploymentError(
            "app_temporary_rollback_unsupported",
            "Rollback requires an OAuth BYOC target.",
          );
        }
        const rollbackTarget = await this.controlPlane.getDeployment(
          context,
          app.id,
          deployment.rollbackOfDeploymentId,
        );
        const sameRollbackTarget =
          rollbackTarget.targetKind === deployment.targetKind &&
          (deployment.targetKind === "byoc"
            ? rollbackTarget.cloudflareConnectionId === deployment.cloudflareConnectionId
            : deployment.targetKind === "temporary" &&
              rollbackTarget.temporaryPreviewId === deployment.temporaryPreviewId);
        if (!sameRollbackTarget || !rollbackTarget.cloudflareVersionId) {
          throw deploymentError(
            "app_rollback_target_mismatch",
            "Rollback must use the same Cloudflare account and immutable Worker version.",
          );
        }
        result = await this.byocAdapter.rollback({
          target,
          deploymentId: deployment.id,
          credential,
          providerVersion: rollbackTarget.cloudflareVersionId,
        });
      } else {
        let previous:
          | { providerVersion: string; durableObjectClasses: string[]; migrationTag?: string }
          | undefined;
        if (sameTarget && priorDeployment?.cloudflareVersionId) {
          const previousArtifact = await this.readStagedArtifact(app.ownerUserId, priorDeployment);
          previous = {
            providerVersion: priorDeployment.cloudflareVersionId,
            durableObjectClasses: previousArtifact.durableObjectClasses,
            ...(priorDeployment.cloudflareMigrationTag
              ? { migrationTag: priorDeployment.cloudflareMigrationTag }
              : {}),
          };
        }
        const onReceipt = async (receipt: AppRuntimeResourceReceipt) => {
          await ensureLease();
          await this.persistRuntimeReceipt(accountContext, deployment!, receipt, lease.leaseToken);
        };
        result =
          queued.target === "temporary"
            ? await this.temporaryAdapter.deploy({
                target,
                deploymentId: deployment.id,
                credential,
                artifact,
                ...(previous ? { previous } : {}),
                onReceipt,
              })
            : await this.byocAdapter.deploy({
                target,
                deploymentId: deployment.id,
                credential,
                artifact,
                resources: prepared,
                ...(previous ? { previous } : {}),
                onReceipt,
              });
      }
      await ensureLease();
      if (result.readiness !== "ready") {
        throw deploymentError(
          "cloudflare_worker_not_ready",
          "Cloudflare Worker did not pass readiness verification.",
        );
      }
      await this.persistCoreReceipt(
        accountContext,
        deployment,
        {
          logicalKey: "worker",
          stepStatus: "ready",
          externalId: app.workerName,
          externalName: result.stableUrl,
        },
        lease.leaseToken,
      );
      if (assetsReceiptStarted) {
        await this.persistCoreReceipt(
          accountContext,
          deployment,
          {
            logicalKey: "assets",
            stepStatus: "ready",
            externalId: artifact.artifactDigest,
            externalName: app.workerName,
          },
          lease.leaseToken,
        );
      }
      await this.controlPlane.completeDeployment(context, {
        appId: app.id,
        deploymentId: deployment.id,
        appGeneration: deployment.appGeneration,
        leaseToken: lease.leaseToken,
        phase: queued.target === "temporary" ? "temporary_ready" : "ready",
        cloudflareVersionId: result.providerVersion,
        ...(result.migrationTag ? { cloudflareMigrationTag: result.migrationTag } : {}),
        stableUrl: result.stableUrl,
        artifactKey: deployment.artifactKey!,
        warnings: deploymentWarnings(artifact),
      });
      await this.controlPlane.completeOutboxByKey(
        app.id,
        operation,
        deployment.idempotencyKey,
        deployment.appGeneration,
        lease.leaseToken,
      );
    } catch (error) {
      if (deployment && !leaseLost) {
        if (preparedResources) {
          await ensureLease().catch(() => undefined);
          if (!leaseLost) {
            for (const receipt of preparedResources.receipts) {
              if (receipt.ownership !== "created") continue;
              await this.persistRuntimeReceipt(
                accountContext,
                deployment,
                {
                  ...receipt,
                  stepStatus: "needs_cleanup",
                  errorCode: "cloudflare_worker_deploy_failed",
                },
                lease.leaseToken,
              ).catch(() => undefined);
            }
          }
        }
        if (workerReceiptStarted) {
          await this.persistCoreReceipt(
            accountContext,
            deployment,
            {
              logicalKey: "worker",
              stepStatus: "failed",
              error,
            },
            lease.leaseToken,
          ).catch(() => undefined);
        }
        if (assetsReceiptStarted) {
          await this.persistCoreReceipt(
            accountContext,
            deployment,
            {
              logicalKey: "assets",
              stepStatus: "failed",
              error,
            },
            lease.leaseToken,
          ).catch(() => undefined);
        }
        const context = this.deploymentContext(accountContext, deployment);
        const failed = await this.controlPlane
          .getApp(context, deployment.appId)
          .then((app) => this.failDeployment(context, app, deployment!, error, lease.leaseToken))
          .catch(() => false);
        if (failed) {
          await this.controlPlane
            .failOutboxByKey(
              deployment.appId,
              operation,
              deployment.idempotencyKey,
              deployment.appGeneration,
              lease.leaseToken,
              error,
            )
            .catch(() => undefined);
        }
      }
      throw error;
    } finally {
      clearInterval(leaseHeartbeat);
      await this.controlPlane.releaseLease(queued.appId, lease.leaseToken).catch(() => undefined);
    }
  }

  private async deploy(
    context: AppOperationContext,
    scope: AppBrokerScope,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    void signal;
    const requestedPath = requiredString(payload.path, "path");
    const artifact = await collectAppBuildArtifact(scope.workspaceDir, requestedPath);
    const build = record(payload.build);
    const prebuildDigest = optionalString(build.sourceDigestBeforeBuild);
    if (prebuildDigest && prebuildDigest !== artifact.sourceDigest) {
      throw new Error("App source changed while the build was running; build it again.");
    }
    this.checkDeploySwitches();

    if (payload.dryRun === true) {
      return {
        dryRun: true,
        sourceDigest: artifact.sourceDigest,
        artifactDigest: artifact.artifactDigest,
        fileCount: artifact.fileCount,
        sourceBytes: artifact.sourceBytes,
        manifest: artifact.manifest,
        bindings: artifact.bindings,
        warnings: deploymentWarnings(artifact),
      };
    }

    let begun: { app: AppRecord; deployment: AppDeploymentRecord } | undefined;
    try {
      begun = await this.controlPlane.beginDeployment(context, {
        ...(optionalString(payload.appId) ? { appId: optionalString(payload.appId) } : {}),
        ...(optionalString(payload.slug) ? { slug: optionalString(payload.slug) } : {}),
        sourceDigest: artifact.sourceDigest,
        artifactKey: await this.persistStagedArtifact(artifact),
        manifest: artifact.manifest,
        bindingManifest: artifact.bindings as unknown as Record<string, unknown>,
      });
      if (begun.deployment.phase === "ready") return begun;
      if (begun.deployment.phase === "failed") {
        throw new Error(begun.deployment.errorMessage || "This App deployment previously failed.");
      }
      const snapshot = await createAppSourceSnapshot({
        creatorRoot: this.creatorRoot,
        appId: begun.app.id,
        deploymentId: begun.deployment.id,
        sourceRoot: artifact.sourceRoot,
        expectedDigest: artifact.sourceDigest,
      });
      await this.controlPlane.setSourceSnapshotKey(
        internalContext(context),
        begun.app.id,
        begun.deployment.id,
        begun.deployment.appGeneration,
        snapshot.key,
      );
      return {
        app: await this.controlPlane.getApp(context, begun.app.id),
        deployment: await this.controlPlane.getDeployment(
          context,
          begun.app.id,
          begun.deployment.id,
        ),
        awaitingTarget: true,
      };
    } catch (error) {
      if (begun && begun.deployment.phase !== "ready" && begun.deployment.phase !== "failed") {
        await this.failDeployment(context, begun.app, begun.deployment, error);
      }
      throw error;
    }
  }

  async rollback(
    context: AppOperationContext,
    appId: string,
    deploymentId: string,
    signal?: AbortSignal,
  ): Promise<{ app: AppRecord; deployment: AppDeploymentRecord }> {
    if (envFlag(ENV.PIWORK_APPS_KILL_SWITCH)) {
      throw new Error("App deployments are paused by the platform operator.");
    }
    void signal;
    const targetDeployment = await this.controlPlane.getDeployment(context, appId, deploymentId);
    if (!targetDeployment.artifactKey) throw new Error("Rollback artifact is unavailable.");
    const rollback = await this.controlPlane.rollback(context, appId, deploymentId);
    return rollback;
  }

  async delete(context: AppOperationContext, appId: string): Promise<AppRecord> {
    return this.controlPlane.archive(context, appId);
  }

  async restore(context: AppOperationContext, appId: string): Promise<AppRecord> {
    return this.controlPlane.restore(context, appId);
  }

  private accountContext(context: AppOperationContext): AppCloudflareAccountContext {
    if (!context.membershipId) throw new Error("Tenant membership not found.");
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      membershipId: context.membershipId,
    };
  }

  async setCustomDomain(
    context: AppOperationContext,
    appId: string,
    input: { connectionId: string; zoneId: string; hostname: string; confirmImpact: true },
  ): Promise<AppRecord> {
    if (input.confirmImpact !== true) {
      throw new Error("Custom-domain impact confirmation is required.");
    }
    const operationContext = {
      ...context,
      idempotencyKey: context.idempotencyKey || `domain:${randomUUID()}`,
      explicitIntent: true,
    };
    const accountContext = this.accountContext(operationContext);
    const before = await this.controlPlane.getApp(operationContext, appId);
    if (
      before.status !== "ready" ||
      before.targetKind !== "byoc" ||
      before.cloudflareConnectionId !== input.connectionId ||
      !before.currentDeploymentId ||
      !before.stableUrl
    ) {
      throw new Error("Custom domains require the App's ready OAuth BYOC target.");
    }
    const deployment = await this.controlPlane.getDeployment(
      operationContext,
      appId,
      before.currentDeploymentId,
    );
    if (
      !deployment.manifest.exposure.requestedCustomDomain ||
      deployment.manifest.exposure.requestedCustomDomain !== input.hostname.trim().toLowerCase()
    ) {
      throw new Error("Custom domain does not match piwork.app.json intent.");
    }
    const credential = await this.cloudflareAccounts.resolveConnectionCredential(
      accountContext,
      appId,
      input.connectionId,
    );
    const lease = await this.controlPlane.acquireLease(
      appId,
      `cloudflare-domain:${randomUUID()}`,
      before.generation,
      120_000,
    );
    if (!lease) throw deploymentError("app_domain_busy", "App has another operation in progress.");
    const leaseGuard = this.startLeaseHeartbeat({
      appId,
      appGeneration: before.generation,
      leaseToken: lease.leaseToken,
      ttlMs: 120_000,
      errorCode: "app_domain_lease_lost",
      errorMessage: "App custom-domain lease was lost before the operation completed.",
    });
    let pending: AppRecord | undefined;
    try {
      await leaseGuard.ensure();
      pending = await this.controlPlane.setCustomDomain(operationContext, appId, {
        hostname: input.hostname,
        connectionId: input.connectionId,
        zoneId: input.zoneId,
        leaseToken: lease.leaseToken,
      });
      await leaseGuard.ensure();
      const result = await this.byocAdapter.setCustomDomain(
        {
          appId: before.id,
          tenantId: before.tenantId,
          workerName: before.workerName,
          ownerUserId: before.ownerUserId,
        },
        credential,
        {
          hostname: input.hostname,
          zoneId: input.zoneId,
          confirmImpact: true,
          workersDevHealthy: true,
        },
      );
      await leaseGuard.ensure();
      await this.cloudflareAccounts.recordResourceReceipt(accountContext, {
        appId,
        deploymentId: deployment.id,
        appGeneration: deployment.appGeneration,
        leaseToken: lease.leaseToken,
        logicalKey: input.hostname.trim().toLowerCase(),
        resourceKind: "domain",
        mode: "create",
        ownership: "created",
        externalId: result.providerId,
        externalName: result.hostname,
        stepStatus: "ready",
        metadata: {
          zoneId: result.zoneId,
          ...(result.certificateId ? { certificateId: result.certificateId } : {}),
        },
      });
      await leaseGuard.ensure();
      const updated = await this.controlPlane.markCustomDomainState(operationContext, {
        appId,
        appGeneration: pending.generation,
        hostname: result.hostname,
        cloudflareHostnameId: result.providerId,
        ...(result.certificateId ? { certificateId: result.certificateId } : {}),
        status: result.active ? "active" : "pending",
        sslStatus: result.active ? "active" : "pending_issuance",
        leaseToken: lease.leaseToken,
      });
      if (result.active) {
        await leaseGuard.ensure();
        await this.controlPlane.completeOutboxByKey(
          appId,
          "domain_set",
          operationContext.idempotencyKey!,
          pending.generation,
          lease.leaseToken,
        );
      }
      return updated;
    } catch (error) {
      if (pending && !leaseGuard.lost()) {
        await this.controlPlane
          .markCustomDomainState(operationContext, {
            appId,
            appGeneration: pending.generation,
            hostname: input.hostname,
            status: "failed",
            sslStatus: "failed",
            error: error instanceof Error ? error.message : String(error),
            leaseToken: lease.leaseToken,
          })
          .catch(() => undefined);
        await this.controlPlane
          .failOutboxByKey(
            appId,
            "domain_set",
            operationContext.idempotencyKey!,
            pending.generation,
            lease.leaseToken,
            error,
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      leaseGuard.stop();
      await this.controlPlane.releaseLease(appId, lease.leaseToken).catch(() => undefined);
    }
  }

  async removeCustomDomain(
    context: AppOperationContext,
    appId: string,
    input: { connectionId: string; zoneId: string; hostname: string; confirmImpact: true },
  ): Promise<AppRecord> {
    if (input.confirmImpact !== true) {
      throw new Error("Custom-domain impact confirmation is required.");
    }
    const operationContext = {
      ...context,
      idempotencyKey: context.idempotencyKey || `domain-remove:${randomUUID()}`,
      explicitIntent: true,
    };
    const accountContext = this.accountContext(operationContext);
    const before = await this.controlPlane.getApp(operationContext, appId);
    const domain = before.customDomain;
    if (
      before.targetKind !== "byoc" ||
      before.cloudflareConnectionId !== input.connectionId ||
      !domain ||
      domain.cloudflareConnectionId !== input.connectionId ||
      domain.zoneId !== input.zoneId ||
      domain.hostname !== input.hostname.trim().toLowerCase() ||
      !domain.cloudflareHostnameId
    ) {
      throw new Error("Stale or missing App custom domain.");
    }
    const credential = await this.cloudflareAccounts.resolveConnectionCredential(
      accountContext,
      appId,
      input.connectionId,
    );
    const lease = await this.controlPlane.acquireLease(
      appId,
      `cloudflare-domain-remove:${randomUUID()}`,
      before.generation,
      120_000,
    );
    if (!lease) throw deploymentError("app_domain_busy", "App has another operation in progress.");
    const leaseGuard = this.startLeaseHeartbeat({
      appId,
      appGeneration: before.generation,
      leaseToken: lease.leaseToken,
      ttlMs: 120_000,
      errorCode: "app_domain_lease_lost",
      errorMessage: "App custom-domain lease was lost before the operation completed.",
    });
    let removing: AppRecord | undefined;
    try {
      await leaseGuard.ensure();
      removing = await this.controlPlane.removeCustomDomain(operationContext, appId, {
        hostname: input.hostname,
        connectionId: input.connectionId,
        zoneId: input.zoneId,
        leaseToken: lease.leaseToken,
      });
      await leaseGuard.ensure();
      await this.byocAdapter.removeCustomDomain(credential, domain.cloudflareHostnameId);
      await leaseGuard.ensure();
      const updated = await this.controlPlane.finishCustomDomainRemoval(
        operationContext,
        appId,
        removing.generation,
        lease.leaseToken,
      );
      await leaseGuard.ensure();
      await this.controlPlane.completeOutboxByKey(
        appId,
        "domain_set",
        operationContext.idempotencyKey!,
        removing.generation,
        lease.leaseToken,
      );
      return updated;
    } catch (error) {
      if (removing && !leaseGuard.lost()) {
        await this.controlPlane
          .failOutboxByKey(
            appId,
            "domain_set",
            operationContext.idempotencyKey!,
            removing.generation,
            lease.leaseToken,
            error,
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      leaseGuard.stop();
      await this.controlPlane.releaseLease(appId, lease.leaseToken).catch(() => undefined);
    }
  }

  private async preview(context: AppOperationContext, appId: string): Promise<unknown> {
    const app = await this.controlPlane.getApp(context, appId);
    if ((app.status !== "preview" && app.status !== "ready") || !app.stableUrl) {
      throw new Error("App preview is unavailable until deployment is ready.");
    }
    const url =
      app.customDomain?.status === "active" && app.customDomain.sslStatus === "active"
        ? `https://${app.customDomain.hostname}`
        : app.stableUrl;
    return {
      appId: app.id,
      url,
      fallbackUrl: app.stableUrl,
      sandbox: "allow-scripts allow-forms allow-popups allow-downloads",
      ready: true,
    };
  }

  async handleBroker(
    request: PiBrokerRequest,
    broker: PiBrokerRequestContext,
    scope: AppBrokerScope,
  ): Promise<unknown> {
    const payload = record(request.payload);
    const explicitIntent = payload.publishIntent === "user_requested";
    const context = this.brokerContext(request, scope, explicitIntent);
    switch (request.operation) {
      case "app.deploy":
        return this.deploy(context, scope, payload, broker.signal);
      case "app.list": {
        const input: AppListInput = {
          scope:
            payload.scope === "current-session" ||
            payload.scope === "mine" ||
            payload.scope === "tenant"
              ? payload.scope
              : "current-session",
          ...(optionalString(payload.cursor) ? { cursor: optionalString(payload.cursor) } : {}),
          ...(payload.scope === "current-session" ? { sessionId: scope.sessionId } : {}),
        };
        return this.controlPlane.listApps(context, input);
      }
      case "app.versions":
        return this.controlPlane.listVersions(
          context,
          requiredString(payload.appId, "appId"),
          optionalString(payload.cursor),
        );
      case "app.rollback":
        return this.rollback(
          context,
          requiredString(payload.appId, "appId"),
          requiredString(payload.deploymentId, "deploymentId"),
          broker.signal,
        );
      case "app.delete":
        return { app: await this.delete(context, requiredString(payload.appId, "appId")) };
      case "app.restore":
        return { app: await this.restore(context, requiredString(payload.appId, "appId")) };
      case "app.preview":
        return this.preview(context, requiredString(payload.appId, "appId"));
      default:
        throw new Error("Unsupported App broker operation.");
    }
  }
}
