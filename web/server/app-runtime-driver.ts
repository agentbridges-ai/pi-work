import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Cloudflare from "cloudflare";
import { createRuntimeWrapperModuleSource } from "../../packages/apps-platform/src/runtime-wrapper-source.js";
import {
  assertTemporaryAppEligible,
  type AppBindingManifest,
  type AppResourceMode,
  type PiworkAppManifestV1,
} from "./app-manifest.js";
import {
  computeAppArtifactDigest,
  type AppBuildArtifact,
  type AppBuildWarning,
  type AppStaticAsset,
} from "./app-build.js";
import type { AppCloudflareDeploymentCredential } from "./apps-cloudflare-account-types.js";

export const TEMPORARY_APP_ASSET_LIMIT = 1_000;
export const TEMPORARY_APP_ASSET_FILE_LIMIT_BYTES = 5 * 1024 * 1024;

export type AppRuntimeDriverKind = "disabled" | "cloudflare";
export type AppRuntimeTargetKind = "temporary" | "byoc";
export type AppRuntimeResourceKind = "kv" | "d1" | "r2" | "durable_object";
export type AppRuntimeResourceStepStatus =
  "provisioning" | "planned" | "ready" | "failed" | "needs_cleanup";

export interface AppRuntimeTarget {
  appId: string;
  tenantId: string;
  workerName: string;
  ownerUserId: string;
}

export interface AppRuntimeResourceReceipt {
  logicalKey: string;
  kind: AppRuntimeResourceKind;
  binding: string;
  mode: AppResourceMode | "created";
  ownership: "created" | "adopted";
  externalId: string | null;
  externalName: string | null;
  jurisdiction: "default" | "eu" | "fedramp" | null;
  stepStatus: AppRuntimeResourceStepStatus;
  errorCode?: string;
}

export interface AppRuntimePreparedResources {
  receipts: AppRuntimeResourceReceipt[];
}

export interface AppRuntimePrepareResourcesRequest {
  target: AppRuntimeTarget;
  credential: AppCloudflareDeploymentCredential;
  bindings: AppBindingManifest;
  existingReceipts?: AppRuntimeResourceReceipt[];
  onReceipt?: (receipt: AppRuntimeResourceReceipt) => Promise<void>;
}

export interface AppRuntimeDeployRequest {
  target: AppRuntimeTarget;
  deploymentId: string;
  targetKind: AppRuntimeTargetKind;
  credential: AppCloudflareDeploymentCredential;
  artifact: AppBuildArtifact;
  resources: AppRuntimePreparedResources;
  previous?: {
    providerVersion: string;
    durableObjectClasses: string[];
    migrationTag?: string;
  };
  onReceipt?: (receipt: AppRuntimeResourceReceipt) => Promise<void>;
  signal?: AbortSignal;
}

export interface AppRuntimeRollbackRequest {
  target: AppRuntimeTarget;
  deploymentId: string;
  credential: AppCloudflareDeploymentCredential;
  providerVersion: string;
  signal?: AbortSignal;
}

export interface AppRuntimeDeployResult {
  providerVersion: string;
  stableUrl: string;
  /** A non-secret locator. Cloudflare owns the immutable version used for rollback. */
  artifactLocation: string;
  readiness: "ready" | "pending";
  migrationTag?: string;
  warnings: AppBuildWarning[];
  resourceReceipts: AppRuntimeResourceReceipt[];
}

export interface AppRuntimeDomainResult {
  providerId: string;
  hostname: string;
  zoneId: string;
  certificateId: string | null;
  active: boolean;
}

export interface AppRuntimeHealth {
  ok: boolean;
  driver: AppRuntimeDriverKind;
  details?: string;
}

export interface AppRuntimeDriver {
  readonly kind: AppRuntimeDriverKind;
  validate(artifact: AppBuildArtifact, targetKind: AppRuntimeTargetKind): Promise<void>;
  prepareResources(
    request: AppRuntimePrepareResourcesRequest,
  ): Promise<AppRuntimePreparedResources>;
  deploy(request: AppRuntimeDeployRequest): Promise<AppRuntimeDeployResult>;
  rollback(request: AppRuntimeRollbackRequest): Promise<AppRuntimeDeployResult>;
  /** Disables workers.dev exposure without deleting the Worker or its resources. */
  disableExposure(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
  ): Promise<void>;
  setCustomDomain(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
    input: {
      hostname: string;
      zoneId: string;
      confirmImpact: true;
      workersDevHealthy: true;
    },
  ): Promise<AppRuntimeDomainResult>;
  verifyCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
    hostname: string,
  ): Promise<AppRuntimeDomainResult>;
  removeCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
  ): Promise<void>;
  health(credential?: AppCloudflareDeploymentCredential): Promise<AppRuntimeHealth>;
}

export class AppRuntimeConfigurationError extends Error {
  readonly code = "app_runtime_configuration";
}

export class AppRuntimeDisabledError extends Error {
  readonly code = "app_runtime_disabled";

  constructor(reason = "Piwork Apps publishing is disabled") {
    super(reason);
    this.name = "AppRuntimeDisabledError";
  }
}

export class AppRuntimeProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppRuntimeProviderError";
    this.code = code;
  }
}

export class DisabledAppRuntimeDriver implements AppRuntimeDriver {
  readonly kind = "disabled" as const;

  constructor(private readonly reason = "Piwork Apps publishing is disabled") {}

  private unavailable(): never {
    throw new AppRuntimeDisabledError(this.reason);
  }

  async validate(): Promise<void> {
    this.unavailable();
  }
  async prepareResources(): Promise<AppRuntimePreparedResources> {
    return this.unavailable();
  }
  async deploy(): Promise<AppRuntimeDeployResult> {
    return this.unavailable();
  }
  async rollback(): Promise<AppRuntimeDeployResult> {
    return this.unavailable();
  }
  async disableExposure(): Promise<void> {
    this.unavailable();
  }
  async setCustomDomain(): Promise<AppRuntimeDomainResult> {
    return this.unavailable();
  }
  async verifyCustomDomain(): Promise<AppRuntimeDomainResult> {
    return this.unavailable();
  }
  async removeCustomDomain(): Promise<void> {
    this.unavailable();
  }
  async health(): Promise<AppRuntimeHealth> {
    return { ok: false, driver: this.kind, details: this.reason };
  }
}

interface SerializedArtifact {
  version: 1;
  sourceDigest: string;
  artifactDigest: string;
  mainModule: string;
  compatibilityDate?: string;
  compatibilityFlags: string[];
  manifest: PiworkAppManifestV1;
  bindings: AppBindingManifest;
  durableObjectClasses: string[];
  fileCount: number;
  sourceBytes: number;
  warnings: AppBuildWarning[];
  rawConfig: Record<string, unknown>;
  modules: Array<{ name: string; contentType: string; base64: string }>;
  assets: Array<{
    path: string;
    contentType: string;
    sha256: string;
    base64: string;
  }>;
}

/** Used only for creator-owned deployment staging; it is not a local Cloudflare runtime. */
export function serializeAppArtifact(artifact: AppBuildArtifact): Uint8Array {
  const value: SerializedArtifact = {
    version: 1,
    sourceDigest: artifact.sourceDigest,
    artifactDigest: artifact.artifactDigest,
    mainModule: artifact.mainModule,
    ...(artifact.compatibilityDate ? { compatibilityDate: artifact.compatibilityDate } : {}),
    compatibilityFlags: [...artifact.compatibilityFlags],
    manifest: artifact.manifest,
    bindings: artifact.bindings,
    durableObjectClasses: [...artifact.durableObjectClasses],
    fileCount: artifact.fileCount,
    sourceBytes: artifact.sourceBytes,
    warnings: structuredClone(artifact.warnings),
    rawConfig: structuredClone(artifact.rawConfig),
    modules: artifact.modules.map((module) => ({
      name: module.name,
      contentType: module.contentType,
      base64: Buffer.from(module.bytes).toString("base64"),
    })),
    assets: artifact.assets.map((asset) => ({
      path: asset.path,
      contentType: asset.contentType,
      sha256: asset.sha256,
      base64: Buffer.from(asset.bytes).toString("base64"),
    })),
  };
  return new TextEncoder().encode(JSON.stringify(value));
}

export function deserializeAppArtifact(bytes: Uint8Array): AppBuildArtifact {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as SerializedArtifact;
  if (
    value.version !== 1 ||
    !value.artifactDigest ||
    !value.mainModule ||
    !Array.isArray(value.modules) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Stored App artifact is invalid");
  }
  const artifact: AppBuildArtifact = {
    sourceDigest: value.sourceDigest,
    artifactDigest: value.artifactDigest,
    sourceRoot: "<creator-owned-staged-app-artifact>",
    configPath: "build/server/wrangler.json",
    fileCount: Number.isSafeInteger(value.fileCount) && value.fileCount >= 0 ? value.fileCount : 0,
    sourceBytes:
      Number.isSafeInteger(value.sourceBytes) && value.sourceBytes >= 0 ? value.sourceBytes : 0,
    mainModule: value.mainModule,
    ...(value.compatibilityDate ? { compatibilityDate: value.compatibilityDate } : {}),
    compatibilityFlags: [...value.compatibilityFlags],
    manifest: structuredClone(value.manifest),
    bindings: structuredClone(value.bindings),
    durableObjectClasses: [...value.durableObjectClasses],
    warnings: Array.isArray(value.warnings) ? structuredClone(value.warnings) : [],
    rawConfig:
      value.rawConfig && typeof value.rawConfig === "object" && !Array.isArray(value.rawConfig)
        ? structuredClone(value.rawConfig)
        : {},
    modules: value.modules.map((module) => ({
      name: module.name,
      contentType: module.contentType,
      bytes: Buffer.from(module.base64, "base64"),
    })),
    assets: value.assets.map((asset) => ({
      path: asset.path,
      contentType: asset.contentType,
      sha256: asset.sha256,
      bytes: Buffer.from(asset.base64, "base64"),
    })),
  };
  const recomputed = computeAppArtifactDigest(artifact);
  if (recomputed !== value.artifactDigest) {
    throw new Error("Stored App artifact digest does not match its content");
  }
  for (const asset of artifact.assets) {
    if (createHash("sha256").update(asset.bytes).digest("hex") !== asset.sha256) {
      throw new Error("Stored App asset digest does not match its content");
    }
  }
  return artifact;
}

export async function readSerializedAppArtifact(path: string): Promise<AppBuildArtifact> {
  return deserializeAppArtifact(await readFile(path));
}

interface CloudflareNamedResource {
  id: string;
  name: string;
  jurisdiction?: "default" | "eu" | "fedramp";
}

interface CloudflareUploadedWorker {
  versionId: string;
  migrationTag?: string;
}

export interface WrappedWorkerUpload {
  mainModule: string;
  compatibilityFlags: string[];
  bindings: Array<Record<string, unknown>>;
  modules: Array<{ name: string; contentType: string; bytes: Uint8Array }>;
}

export function prepareWrappedWorkerUpload(input: {
  appId: string;
  artifact: AppBuildArtifact;
  bindings: Array<Record<string, unknown>>;
}): WrappedWorkerUpload {
  const allowedBindings = input.bindings.map((binding) =>
    requiredProviderString(binding.name, "Cloudflare binding name"),
  );
  if (
    allowedBindings.includes("PIWORK_WRAPPER_CONFIG") ||
    new Set(allowedBindings).size !== allowedBindings.length ||
    allowedBindings.length > 64
  ) {
    throw new AppRuntimeConfigurationError("Cloudflare App binding allowlist is invalid");
  }
  const wrapperName = `__piwork_wrapper_${input.artifact.artifactDigest.slice(0, 16)}.mjs`;
  if (input.artifact.modules.some((module) => module.name === wrapperName)) {
    throw new AppRuntimeConfigurationError("Cloudflare App wrapper module name conflicts");
  }
  const wrapperConfig = JSON.stringify({
    schemaVersion: 1,
    appId: input.appId,
    allowedBindings,
  });
  return {
    mainModule: wrapperName,
    compatibilityFlags: [
      ...new Set([...input.artifact.compatibilityFlags, "disallow_importable_env"]),
    ],
    bindings: [
      ...input.bindings,
      {
        type: "plain_text",
        name: "PIWORK_WRAPPER_CONFIG",
        text: wrapperConfig,
      },
    ],
    modules: [
      ...input.artifact.modules,
      {
        name: wrapperName,
        contentType: "application/javascript+module",
        bytes: new TextEncoder().encode(
          createRuntimeWrapperModuleSource(input.artifact.mainModule),
        ),
      },
    ],
  };
}

interface CloudflareDomain {
  id: string;
  hostname: string;
  zoneId: string;
  certificateId: string | null;
}

/** High-level boundary used by focused tests; the production implementation uses the official SDK. */
export interface CloudflareAppRuntimeApi {
  createKv(name: string): Promise<CloudflareNamedResource>;
  getKv(id: string): Promise<CloudflareNamedResource>;
  findKvByName(name: string): Promise<CloudflareNamedResource | null>;
  createD1(name: string): Promise<CloudflareNamedResource>;
  getD1(id: string): Promise<CloudflareNamedResource>;
  findD1ByName(name: string): Promise<CloudflareNamedResource | null>;
  createR2(
    name: string,
    jurisdiction?: "default" | "eu" | "fedramp",
  ): Promise<CloudflareNamedResource>;
  getR2(
    name: string,
    jurisdiction?: "default" | "eu" | "fedramp",
  ): Promise<CloudflareNamedResource>;
  uploadAssets(workerName: string, assets: AppStaticAsset[]): Promise<string | undefined>;
  uploadWorker(input: {
    appId: string;
    workerName: string;
    deploymentId: string;
    artifact: AppBuildArtifact;
    bindings: Array<Record<string, unknown>>;
    assetsJwt?: string;
    migration?: Record<string, unknown>;
  }): Promise<CloudflareUploadedWorker>;
  rollbackWorker(workerName: string, providerVersion: string): Promise<void>;
  enableWorkersDev(workerName: string): Promise<void>;
  disableWorkersDev(workerName: string): Promise<void>;
  getWorkersSubdomain(): Promise<string>;
  getZone(zoneId: string): Promise<{ id: string; name: string; status: string }>;
  attachDomain(input: {
    workerName: string;
    hostname: string;
    zoneId: string;
  }): Promise<CloudflareDomain>;
  getDomain(providerId: string): Promise<CloudflareDomain>;
  detachDomain(providerId: string): Promise<void>;
}

type CloudflareApiFactory = (
  credential: AppCloudflareDeploymentCredential,
) => CloudflareAppRuntimeApi;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredProviderString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppRuntimeProviderError("cloudflare_invalid_response", `${label} is missing`);
  }
  return value.trim();
}

async function recordsFrom(value: unknown): Promise<Record<string, unknown>[]> {
  if (value && typeof value === "object" && Symbol.asyncIterator in value) {
    const records: Record<string, unknown>[] = [];
    for await (const entry of value as AsyncIterable<unknown>) records.push(object(entry));
    return records;
  }
  const resolved = await (value as Promise<unknown>);
  if (Array.isArray(resolved)) return resolved.map(object);
  const result = object(resolved);
  for (const key of ["result", "items", "versions", "buckets", "deployments"]) {
    if (Array.isArray(result[key])) return (result[key] as unknown[]).map(object);
  }
  return [];
}

interface CloudflareSdkLike {
  workers: {
    scripts: {
      update(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      versions: { list(name: string, params: Record<string, unknown>): unknown };
      deployments: {
        create(name: string, params: Record<string, unknown>): Promise<unknown>;
      };
      assets: {
        upload: {
          create(
            name: string,
            params: Record<string, unknown>,
          ): Promise<{ jwt?: string; buckets?: string[][] }>;
        };
      };
      subdomain: {
        create(name: string, params: Record<string, unknown>): Promise<unknown>;
        delete(name: string, params: Record<string, unknown>): Promise<unknown>;
      };
    };
    assets: {
      upload: {
        create(
          params: Record<string, unknown>,
          options?: Record<string, unknown>,
        ): Promise<{ jwt?: string }>;
      };
    };
    subdomains: { get(params: Record<string, unknown>): Promise<{ subdomain?: string }> };
    domains: {
      update(params: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      delete(id: string, params: Record<string, unknown>): Promise<unknown>;
    };
  };
  kv: {
    namespaces: {
      create(params: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      list(params: Record<string, unknown>): unknown;
    };
  };
  d1: {
    database: {
      create(params: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(id: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      list(params: Record<string, unknown>): unknown;
    };
  };
  r2: {
    buckets: {
      create(params: Record<string, unknown>): Promise<Record<string, unknown>>;
      get(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  zones: { get(params: Record<string, unknown>): Promise<Record<string, unknown>> };
}

export class CloudflareSdkAppRuntimeApi implements CloudflareAppRuntimeApi {
  private readonly client: CloudflareSdkLike;

  constructor(
    private readonly accountId: string,
    apiToken: string,
    client?: CloudflareSdkLike,
  ) {
    this.client = client ?? (new Cloudflare({ apiToken }) as unknown as CloudflareSdkLike);
  }

  private named(
    value: Record<string, unknown>,
    idField: "id" | "uuid",
    nameField: "title" | "name",
  ): CloudflareNamedResource {
    return {
      id: requiredProviderString(value[idField], `Cloudflare ${idField}`),
      name: requiredProviderString(value[nameField], `Cloudflare ${nameField}`),
      ...(value.jurisdiction === "default" ||
      value.jurisdiction === "eu" ||
      value.jurisdiction === "fedramp"
        ? { jurisdiction: value.jurisdiction }
        : {}),
    };
  }

  async createKv(name: string): Promise<CloudflareNamedResource> {
    return this.named(
      await this.client.kv.namespaces.create({ account_id: this.accountId, title: name }),
      "id",
      "title",
    );
  }

  async getKv(id: string): Promise<CloudflareNamedResource> {
    return this.named(
      await this.client.kv.namespaces.get(id, { account_id: this.accountId }),
      "id",
      "title",
    );
  }

  async findKvByName(name: string): Promise<CloudflareNamedResource | null> {
    const records = await recordsFrom(
      this.client.kv.namespaces.list({ account_id: this.accountId }),
    );
    const match = records.find((entry) => entry.title === name);
    return match ? this.named(match, "id", "title") : null;
  }

  async createD1(name: string): Promise<CloudflareNamedResource> {
    return this.named(
      await this.client.d1.database.create({ account_id: this.accountId, name }),
      "uuid",
      "name",
    );
  }

  async getD1(id: string): Promise<CloudflareNamedResource> {
    return this.named(
      await this.client.d1.database.get(id, { account_id: this.accountId }),
      "uuid",
      "name",
    );
  }

  async findD1ByName(name: string): Promise<CloudflareNamedResource | null> {
    const records = await recordsFrom(
      this.client.d1.database.list({ account_id: this.accountId, name }),
    );
    const match = records.find((entry) => entry.name === name);
    return match ? this.named(match, "uuid", "name") : null;
  }

  async createR2(
    name: string,
    jurisdiction?: "default" | "eu" | "fedramp",
  ): Promise<CloudflareNamedResource> {
    const result = await this.client.r2.buckets.create({
      account_id: this.accountId,
      name,
      ...(jurisdiction ? { jurisdiction } : {}),
    });
    return {
      id: name,
      name: requiredProviderString(result.name ?? name, "Cloudflare R2 bucket name"),
      ...(jurisdiction ? { jurisdiction } : {}),
    };
  }

  async getR2(
    name: string,
    jurisdiction?: "default" | "eu" | "fedramp",
  ): Promise<CloudflareNamedResource> {
    const result = await this.client.r2.buckets.get(name, {
      account_id: this.accountId,
      ...(jurisdiction ? { jurisdiction } : {}),
    });
    const providerJurisdiction =
      result.jurisdiction === "default" ||
      result.jurisdiction === "eu" ||
      result.jurisdiction === "fedramp"
        ? result.jurisdiction
        : jurisdiction;
    return {
      id: name,
      name: requiredProviderString(result.name ?? name, "Cloudflare R2 bucket name"),
      ...(providerJurisdiction ? { jurisdiction: providerJurisdiction } : {}),
    };
  }

  async uploadAssets(workerName: string, assets: AppStaticAsset[]): Promise<string | undefined> {
    if (assets.length === 0) return undefined;
    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, AppStaticAsset>();
    for (const asset of assets) {
      const hash = asset.sha256.slice(0, 32);
      manifest[asset.path] = { hash, size: asset.bytes.byteLength };
      byHash.set(hash, asset);
    }
    const session = await this.client.workers.scripts.assets.upload.create(workerName, {
      account_id: this.accountId,
      manifest,
    });
    const uploadJwt = requiredProviderString(session.jwt, "Cloudflare asset upload token");
    let completionJwt = uploadJwt;
    for (const bucket of session.buckets ?? []) {
      const body: Record<string, string> = {};
      for (const hash of bucket) {
        const asset = byHash.get(hash);
        if (!asset) {
          throw new AppRuntimeProviderError(
            "cloudflare_asset_protocol",
            "Cloudflare requested an unknown App asset",
          );
        }
        body[hash] = Buffer.from(asset.bytes).toString("base64");
      }
      const uploaded = await this.client.workers.assets.upload.create(
        { account_id: this.accountId, base64: true, body },
        { headers: { Authorization: `Bearer ${uploadJwt}` } },
      );
      if (uploaded.jwt) completionJwt = uploaded.jwt;
    }
    return completionJwt;
  }

  async uploadWorker(input: {
    appId: string;
    workerName: string;
    deploymentId: string;
    artifact: AppBuildArtifact;
    bindings: Array<Record<string, unknown>>;
    assetsJwt?: string;
    migration?: Record<string, unknown>;
  }): Promise<CloudflareUploadedWorker> {
    const findDeploymentVersion = (
      versions: Record<string, unknown>[],
    ): Record<string, unknown> | undefined =>
      versions.find((version) => {
        const annotations = object(object(version.metadata).annotations);
        return annotations["workers/tag"] === input.deploymentId;
      });
    const existingVersions = await recordsFrom(
      this.client.workers.scripts.versions.list(input.workerName, {
        account_id: this.accountId,
      }),
    );
    const existing = findDeploymentVersion(existingVersions);
    if (existing) {
      return {
        versionId: requiredProviderString(existing.id, "Cloudflare Worker version id"),
      };
    }

    const wrapped = prepareWrappedWorkerUpload(input);
    const metadata = {
      main_module: wrapped.mainModule,
      compatibility_date: input.artifact.compatibilityDate ?? "2026-08-04",
      compatibility_flags: wrapped.compatibilityFlags,
      bindings: wrapped.bindings,
      annotations: {
        "workers/message": `Piwork App deployment ${input.deploymentId}`,
        "workers/tag": input.deploymentId,
      },
      tags: [`piwork-app:${input.deploymentId}`],
      ...(input.assetsJwt ? { assets: { jwt: input.assetsJwt } } : {}),
      ...(input.migration ? { migrations: input.migration } : {}),
    };
    const files = wrapped.modules.map(
      (module) =>
        new File([Buffer.from(module.bytes)], module.name, {
          type: module.contentType,
        }),
    );
    const uploaded = await this.client.workers.scripts.update(input.workerName, {
      account_id: this.accountId,
      metadata,
      files,
      bindings_inherit: "strict",
    });
    const versions = await recordsFrom(
      this.client.workers.scripts.versions.list(input.workerName, {
        account_id: this.accountId,
      }),
    );
    const tagged = findDeploymentVersion(versions);
    const latest = tagged ?? versions[0];
    return {
      versionId: requiredProviderString(latest?.id, "Cloudflare Worker version id"),
      ...(typeof uploaded.migration_tag === "string"
        ? { migrationTag: uploaded.migration_tag }
        : {}),
    };
  }

  async rollbackWorker(workerName: string, providerVersion: string): Promise<void> {
    await this.client.workers.scripts.deployments.create(workerName, {
      account_id: this.accountId,
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: providerVersion }],
      annotations: { "workers/message": `Piwork rollback to ${providerVersion}` },
    });
  }

  async enableWorkersDev(workerName: string): Promise<void> {
    await this.client.workers.scripts.subdomain.create(workerName, {
      account_id: this.accountId,
      enabled: true,
      previews_enabled: false,
    });
  }

  async disableWorkersDev(workerName: string): Promise<void> {
    await this.client.workers.scripts.subdomain.delete(workerName, {
      account_id: this.accountId,
    });
  }

  async getWorkersSubdomain(): Promise<string> {
    const result = await this.client.workers.subdomains.get({ account_id: this.accountId });
    return requiredProviderString(result.subdomain, "Cloudflare workers.dev subdomain");
  }

  async getZone(zoneId: string): Promise<{ id: string; name: string; status: string }> {
    const result = await this.client.zones.get({ zone_id: zoneId });
    return {
      id: requiredProviderString(result.id, "Cloudflare zone id"),
      name: requiredProviderString(result.name, "Cloudflare zone name"),
      status: requiredProviderString(result.status, "Cloudflare zone status"),
    };
  }

  private domain(value: Record<string, unknown>): CloudflareDomain {
    return {
      id: requiredProviderString(value.id, "Cloudflare Worker domain id"),
      hostname: requiredProviderString(value.hostname, "Cloudflare Worker domain hostname"),
      zoneId: requiredProviderString(value.zone_id, "Cloudflare Worker domain zone id"),
      certificateId:
        typeof value.cert_id === "string" && value.cert_id.trim() ? value.cert_id.trim() : null,
    };
  }

  async attachDomain(input: {
    workerName: string;
    hostname: string;
    zoneId: string;
  }): Promise<CloudflareDomain> {
    return this.domain(
      await this.client.workers.domains.update({
        account_id: this.accountId,
        hostname: input.hostname,
        service: input.workerName,
        zone_id: input.zoneId,
      }),
    );
  }

  async getDomain(providerId: string): Promise<CloudflareDomain> {
    return this.domain(
      await this.client.workers.domains.get(providerId, { account_id: this.accountId }),
    );
  }

  async detachDomain(providerId: string): Promise<void> {
    await this.client.workers.domains.delete(providerId, { account_id: this.accountId });
  }
}

function validateCredential(
  credential: AppCloudflareDeploymentCredential,
  targetKind?: AppRuntimeTargetKind,
): void {
  if (!credential.accountId || !credential.apiToken) {
    throw new AppRuntimeConfigurationError("Cloudflare deployment credential is incomplete");
  }
  if (targetKind && credential.target !== targetKind) {
    throw new AppRuntimeConfigurationError(
      "Cloudflare deployment target does not match credential",
    );
  }
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    throw new AppRuntimeProviderError(
      "cloudflare_credential_expired",
      "Cloudflare deployment credential has expired",
    );
  }
}

function validateTarget(target: AppRuntimeTarget): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(target.workerName)) {
    throw new AppRuntimeConfigurationError("Cloudflare Worker name is invalid");
  }
}

function stableResourceName(appId: string, kind: "kv" | "d1" | "r2", key: string): string {
  const digest = createHash("sha256").update(`${appId}:${kind}:${key}`).digest("hex").slice(0, 10);
  const base = `piwork-${appId}-${kind}-${key}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const prefix = base.slice(0, Math.max(1, 63 - digest.length - 1)).replace(/-$/u, "");
  return `${prefix}-${digest}`;
}

function receiptKey(receipt: Pick<AppRuntimeResourceReceipt, "kind" | "logicalKey">): string {
  return `${receipt.kind}:${receipt.logicalKey}`;
}

function failedReceipt(
  receipt: AppRuntimeResourceReceipt,
  errorCode = "cloudflare_resource_provision_failed",
): AppRuntimeResourceReceipt {
  return { ...receipt, stepStatus: "failed", errorCode };
}

function exactHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    hostname.includes("*") ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname
      .split(".")
      .some(
        (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new AppRuntimeConfigurationError("Custom domain hostname is invalid");
  }
  return hostname;
}

export interface CloudflareAppRuntimeDriverOptions {
  apiFactory?: CloudflareApiFactory;
  fetch?: typeof fetch;
}

export class CloudflareAppRuntimeDriver implements AppRuntimeDriver {
  readonly kind = "cloudflare" as const;
  private readonly apiFactory: CloudflareApiFactory;
  private readonly fetcher: typeof fetch;

  constructor(options: CloudflareAppRuntimeDriverOptions = {}) {
    this.apiFactory =
      options.apiFactory ??
      ((credential) => new CloudflareSdkAppRuntimeApi(credential.accountId, credential.apiToken));
    this.fetcher = options.fetch ?? fetch;
  }

  async validate(artifact: AppBuildArtifact, targetKind: AppRuntimeTargetKind): Promise<void> {
    if (targetKind === "temporary") {
      assertTemporaryAppEligible(artifact.manifest);
      if (artifact.assets.length > TEMPORARY_APP_ASSET_LIMIT) {
        throw new AppRuntimeConfigurationError(
          `Temporary Cloudflare previews support at most ${TEMPORARY_APP_ASSET_LIMIT} assets`,
        );
      }
      const oversized = artifact.assets.find(
        (asset) => asset.bytes.byteLength > TEMPORARY_APP_ASSET_FILE_LIMIT_BYTES,
      );
      if (oversized) {
        throw new AppRuntimeConfigurationError(
          `Temporary Cloudflare preview asset exceeds 5 MiB: ${oversized.path}`,
        );
      }
    }
  }

  private api(
    credential: AppCloudflareDeploymentCredential,
    targetKind?: AppRuntimeTargetKind,
  ): CloudflareAppRuntimeApi {
    validateCredential(credential, targetKind);
    return this.apiFactory(credential);
  }

  async prepareResources(
    request: AppRuntimePrepareResourcesRequest,
  ): Promise<AppRuntimePreparedResources> {
    validateTarget(request.target);
    const api = this.api(request.credential, "byoc");
    const existing = new Map(
      (request.existingReceipts ?? []).map((receipt) => [receiptKey(receipt), receipt]),
    );
    const output: AppRuntimeResourceReceipt[] = [];
    const touchedCreated = new Map<string, AppRuntimeResourceReceipt>();
    const persist = async (receipt: AppRuntimeResourceReceipt): Promise<void> => {
      const key = receiptKey(receipt);
      existing.set(key, receipt);
      if (receipt.ownership === "created") touchedCreated.set(key, receipt);
      await request.onReceipt?.(receipt);
    };
    const markTouchedCreatedForCleanup = async (): Promise<void> => {
      for (const [key, receipt] of [...touchedCreated]) {
        const cleanup: AppRuntimeResourceReceipt = {
          ...receipt,
          stepStatus: "needs_cleanup",
          errorCode: "cloudflare_resource_provision_failed",
        };
        existing.set(key, cleanup);
        touchedCreated.set(key, cleanup);
        await request.onReceipt?.(cleanup);
      }
    };

    const provision = async (input: {
      logicalKey: string;
      kind: "kv" | "d1" | "r2";
      binding: string;
      mode: AppResourceMode;
      adoptId?: string;
      adoptName?: string;
      jurisdiction?: "default" | "eu" | "fedramp";
    }): Promise<void> => {
      const key = `${input.kind}:${input.logicalKey}`;
      const prior = existing.get(key);
      const generatedName = stableResourceName(request.target.appId, input.kind, input.logicalKey);
      const initial: AppRuntimeResourceReceipt = {
        logicalKey: input.logicalKey,
        kind: input.kind,
        binding: input.binding,
        mode: input.mode,
        ownership: input.mode === "create" ? "created" : "adopted",
        externalId: input.adoptId ?? (input.kind === "r2" ? (input.adoptName ?? null) : null),
        externalName: input.adoptName ?? (input.mode === "create" ? generatedName : null),
        jurisdiction: input.jurisdiction ?? null,
        stepStatus: "provisioning",
      };
      await persist(initial);
      try {
        let resource: CloudflareNamedResource;
        if (input.kind === "kv") {
          if (input.mode === "adopt") {
            resource = await api.getKv(requiredProviderString(input.adoptId, "KV namespace id"));
          } else if (prior?.ownership === "created") {
            resource =
              (await api.findKvByName(generatedName)) ?? (await api.createKv(generatedName));
          } else {
            resource = await api.createKv(generatedName);
          }
        } else if (input.kind === "d1") {
          if (input.mode === "adopt") {
            resource = await api.getD1(requiredProviderString(input.adoptId, "D1 database id"));
          } else if (prior?.ownership === "created") {
            resource =
              (await api.findD1ByName(generatedName)) ?? (await api.createD1(generatedName));
          } else {
            resource = await api.createD1(generatedName);
          }
        } else {
          const name = input.mode === "adopt" ? input.adoptName : generatedName;
          const requiredName = requiredProviderString(name, "R2 bucket name");
          if (input.mode === "adopt" || prior?.ownership === "created") {
            try {
              resource = await api.getR2(requiredName, input.jurisdiction);
            } catch (error) {
              if (input.mode === "adopt") throw error;
              resource = await api.createR2(requiredName, input.jurisdiction);
            }
          } else {
            resource = await api.createR2(requiredName, input.jurisdiction);
          }
        }
        if (input.mode === "adopt") {
          if (input.adoptId && resource.id !== input.adoptId) {
            throw new AppRuntimeProviderError(
              "cloudflare_adopt_mismatch",
              `${input.kind.toUpperCase()} immutable id does not match`,
            );
          }
          if (input.adoptName && resource.name !== input.adoptName) {
            throw new AppRuntimeProviderError(
              "cloudflare_adopt_mismatch",
              `${input.kind.toUpperCase()} immutable name does not match`,
            );
          }
        }
        if (
          input.jurisdiction &&
          resource.jurisdiction &&
          resource.jurisdiction !== input.jurisdiction
        ) {
          throw new AppRuntimeProviderError(
            "cloudflare_adopt_mismatch",
            "R2 jurisdiction does not match the manifest",
          );
        }
        const ready: AppRuntimeResourceReceipt = {
          ...initial,
          externalId: resource.id,
          externalName: resource.name,
          jurisdiction: resource.jurisdiction ?? input.jurisdiction ?? null,
          stepStatus: "ready",
        };
        await persist(ready);
        output.push(ready);
      } catch (error) {
        await persist(failedReceipt(initial));
        throw error;
      }
    };

    try {
      for (const resource of request.bindings.kv) {
        await provision({
          logicalKey: resource.key,
          kind: "kv",
          binding: resource.binding,
          mode: resource.mode,
          adoptId: resource.namespaceId,
        });
      }
      for (const resource of request.bindings.d1) {
        await provision({
          logicalKey: resource.key,
          kind: "d1",
          binding: resource.binding,
          mode: resource.mode,
          adoptId: resource.databaseId,
        });
      }
      for (const resource of request.bindings.r2) {
        await provision({
          logicalKey: resource.key,
          kind: "r2",
          binding: resource.binding,
          mode: resource.mode,
          adoptName: resource.bucketName,
          jurisdiction: resource.jurisdiction,
        });
      }
      for (const resource of request.bindings.durableObjects) {
        const planned: AppRuntimeResourceReceipt = {
          logicalKey: resource.binding,
          kind: "durable_object",
          binding: resource.binding,
          mode: "created",
          ownership: "created",
          externalId: null,
          externalName: resource.className,
          jurisdiction: null,
          stepStatus: "planned",
        };
        await persist(planned);
        output.push(planned);
      }
      return { receipts: output };
    } catch (error) {
      // Cloudflare resource APIs are not transactional. A timed-out create may
      // have succeeded even when its response was lost, so retain every
      // created resource touched by this attempt for explicit user cleanup.
      await markTouchedCreatedForCleanup();
      throw error;
    }
  }

  private metadataBindings(
    artifact: AppBuildArtifact,
    resources: AppRuntimePreparedResources,
  ): Array<Record<string, unknown>> {
    const receipts = new Map(resources.receipts.map((receipt) => [receipt.binding, receipt]));
    const bindings: Array<Record<string, unknown>> = [];
    for (const resource of artifact.bindings.kv) {
      const receipt = receipts.get(resource.binding);
      if (receipt?.stepStatus !== "ready" || !receipt.externalId) {
        throw new AppRuntimeConfigurationError(`KV binding ${resource.binding} is not ready`);
      }
      bindings.push({
        type: "kv_namespace",
        name: resource.binding,
        namespace_id: receipt.externalId,
      });
    }
    for (const resource of artifact.bindings.d1) {
      const receipt = receipts.get(resource.binding);
      if (receipt?.stepStatus !== "ready" || !receipt.externalId) {
        throw new AppRuntimeConfigurationError(`D1 binding ${resource.binding} is not ready`);
      }
      bindings.push({ type: "d1", name: resource.binding, database_id: receipt.externalId });
    }
    for (const resource of artifact.bindings.r2) {
      const receipt = receipts.get(resource.binding);
      if (receipt?.stepStatus !== "ready" || !receipt.externalName) {
        throw new AppRuntimeConfigurationError(`R2 binding ${resource.binding} is not ready`);
      }
      bindings.push({
        type: "r2_bucket",
        name: resource.binding,
        bucket_name: receipt.externalName,
        ...(receipt.jurisdiction && receipt.jurisdiction !== "default"
          ? { jurisdiction: receipt.jurisdiction }
          : {}),
      });
    }
    for (const resource of artifact.bindings.durableObjects) {
      bindings.push({
        type: "durable_object_namespace",
        name: resource.binding,
        class_name: resource.className,
      });
    }
    if (artifact.assets.length > 0) bindings.push({ type: "assets", name: "ASSETS" });
    return bindings;
  }

  private migration(request: AppRuntimeDeployRequest): Record<string, unknown> | undefined {
    const previousClasses = new Set(request.previous?.durableObjectClasses ?? []);
    const nextClasses = new Set(request.artifact.durableObjectClasses);
    const removed = [...previousClasses].filter((className) => !nextClasses.has(className));
    if (removed.length > 0) {
      throw new AppRuntimeConfigurationError(
        "Durable Object class deletion, rename, or transfer is not supported in piwork.app.json v1",
      );
    }
    const added = [...nextClasses].filter((className) => !previousClasses.has(className));
    if (added.length === 0) return undefined;
    return {
      ...(request.previous?.migrationTag ? { old_tag: request.previous.migrationTag } : {}),
      new_tag: `piwork-${request.artifact.artifactDigest.slice(0, 24)}`,
      new_sqlite_classes: added,
    };
  }

  private async stableUrl(api: CloudflareAppRuntimeApi, workerName: string): Promise<string> {
    const subdomain = await api.getWorkersSubdomain();
    return `https://${workerName}.${subdomain}.workers.dev`;
  }

  private async urlReady(url: string, signal?: AbortSignal): Promise<boolean> {
    const timeout = AbortSignal.timeout(10_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal: combined,
      });
      // A reachable endpoint is not necessarily a healthy deployment.  Keep
      // workers.dev as a fallback until Cloudflare returns a successful
      // response (redirects are deliberately not followed, but a redirect is
      // still a valid edge response during propagation).
      return response.ok || (response.status >= 300 && response.status < 400);
    } catch {
      return false;
    }
  }

  async deploy(request: AppRuntimeDeployRequest): Promise<AppRuntimeDeployResult> {
    validateTarget(request.target);
    validateCredential(request.credential, request.targetKind);
    await this.validate(request.artifact, request.targetKind);
    if (request.targetKind === "temporary" && request.resources.receipts.length > 0) {
      throw new AppRuntimeConfigurationError(
        "Temporary Cloudflare previews cannot provision App resources",
      );
    }
    const api = this.api(request.credential, request.targetKind);
    try {
      const assetsJwt = await api.uploadAssets(request.target.workerName, request.artifact.assets);
      const migration = this.migration(request);
      const uploaded = await api.uploadWorker({
        appId: request.target.appId,
        workerName: request.target.workerName,
        deploymentId: request.deploymentId,
        artifact: request.artifact,
        bindings: this.metadataBindings(request.artifact, request.resources),
        ...(assetsJwt ? { assetsJwt } : {}),
        ...(migration ? { migration } : {}),
      });
      await api.enableWorkersDev(request.target.workerName);
      const stableUrl = await this.stableUrl(api, request.target.workerName);
      const ready = await this.urlReady(stableUrl, request.signal);
      const doReceipts = request.resources.receipts.map((receipt) =>
        receipt.kind === "durable_object"
          ? {
              ...receipt,
              externalId: `${request.target.workerName}:${receipt.externalName ?? receipt.binding}`,
              stepStatus: "ready" as const,
            }
          : receipt,
      );
      for (const receipt of doReceipts) {
        if (receipt.kind === "durable_object") await request.onReceipt?.(receipt);
      }
      return {
        providerVersion: uploaded.versionId,
        stableUrl,
        artifactLocation: `cloudflare://accounts/${request.credential.accountId}/workers/scripts/${request.target.workerName}/versions/${uploaded.versionId}`,
        readiness: ready ? "ready" : "pending",
        ...(uploaded.migrationTag
          ? { migrationTag: uploaded.migrationTag }
          : migration && typeof migration.new_tag === "string"
            ? { migrationTag: migration.new_tag }
            : request.previous?.migrationTag
              ? { migrationTag: request.previous.migrationTag }
              : {}),
        warnings: [...request.artifact.warnings],
        resourceReceipts: doReceipts,
      };
    } catch (error) {
      // Cloudflare resource APIs and Worker uploads are not one transaction.
      // Keep every created state resource for explicit cleanup after any
      // interrupted upload or deployment step; adopted resources stay intact.
      for (const receipt of request.resources.receipts) {
        if (receipt.ownership !== "created") continue;
        await request.onReceipt?.({
          ...receipt,
          stepStatus: "needs_cleanup",
          errorCode: "cloudflare_worker_deploy_failed",
        });
      }
      throw error;
    }
  }

  async rollback(request: AppRuntimeRollbackRequest): Promise<AppRuntimeDeployResult> {
    validateTarget(request.target);
    const api = this.api(request.credential);
    await api.rollbackWorker(request.target.workerName, request.providerVersion);
    await api.enableWorkersDev(request.target.workerName);
    const stableUrl = await this.stableUrl(api, request.target.workerName);
    const ready = await this.urlReady(stableUrl, request.signal);
    return {
      providerVersion: request.providerVersion,
      stableUrl,
      artifactLocation: `cloudflare://accounts/${request.credential.accountId}/workers/scripts/${request.target.workerName}/versions/${request.providerVersion}`,
      readiness: ready ? "ready" : "pending",
      warnings: [],
      resourceReceipts: [],
    };
  }

  async disableExposure(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
  ): Promise<void> {
    validateTarget(target);
    await this.api(credential).disableWorkersDev(target.workerName);
  }

  async setCustomDomain(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
    input: {
      hostname: string;
      zoneId: string;
      confirmImpact: true;
      workersDevHealthy: true;
    },
  ): Promise<AppRuntimeDomainResult> {
    validateTarget(target);
    if (credential.target !== "byoc") {
      throw new AppRuntimeConfigurationError("Custom domains require an OAuth BYOC connection");
    }
    if (input.confirmImpact !== true || input.workersDevHealthy !== true) {
      throw new AppRuntimeConfigurationError(
        "Custom domain attachment requires confirmed impact and a healthy workers.dev deployment",
      );
    }
    const hostname = exactHostname(input.hostname);
    const api = this.api(credential, "byoc");
    const workersDevUrl = await this.stableUrl(api, target.workerName);
    if (!(await this.urlReady(workersDevUrl))) {
      throw new AppRuntimeProviderError(
        "cloudflare_worker_not_ready",
        "The default workers.dev deployment is not ready for a custom domain",
      );
    }
    const zone = await api.getZone(input.zoneId);
    if (zone.id !== input.zoneId || zone.status !== "active") {
      throw new AppRuntimeProviderError(
        "cloudflare_zone_inactive",
        "Cloudflare zone is not active",
      );
    }
    if (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`)) {
      throw new AppRuntimeConfigurationError("Custom domain is outside the selected zone");
    }
    const attached = await api.attachDomain({
      workerName: target.workerName,
      hostname,
      zoneId: zone.id,
    });
    return {
      providerId: attached.id,
      hostname: attached.hostname,
      zoneId: attached.zoneId,
      certificateId: attached.certificateId,
      active: await this.urlReady(`https://${hostname}`),
    };
  }

  async verifyCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
    hostname: string,
  ): Promise<AppRuntimeDomainResult> {
    const normalized = exactHostname(hostname);
    const attached = await this.api(credential, "byoc").getDomain(providerId);
    if (attached.hostname !== normalized) {
      throw new AppRuntimeProviderError(
        "cloudflare_domain_mismatch",
        "Cloudflare domain no longer matches the App",
      );
    }
    return {
      providerId: attached.id,
      hostname: attached.hostname,
      zoneId: attached.zoneId,
      certificateId: attached.certificateId,
      active: await this.urlReady(`https://${normalized}`),
    };
  }

  async removeCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
  ): Promise<void> {
    await this.api(credential, "byoc").detachDomain(providerId);
  }

  async health(credential?: AppCloudflareDeploymentCredential): Promise<AppRuntimeHealth> {
    if (!credential) {
      return {
        ok: true,
        driver: this.kind,
        details: "Cloudflare credentials are resolved per deployment",
      };
    }
    try {
      await this.api(credential).getWorkersSubdomain();
      return { ok: true, driver: this.kind };
    } catch {
      return {
        ok: false,
        driver: this.kind,
        details: "Cloudflare account is unavailable",
      };
    }
  }
}

/**
 * Stateless, expiring preview semantics. Resource provisioning and domains are
 * intentionally absent from this surface so callers cannot accidentally widen
 * a Temporary Account deployment.
 */
export type TemporaryPreviewDriverPort = Pick<
  AppRuntimeDriver,
  "validate" | "deploy" | "disableExposure"
>;

export class TemporaryPreviewAdapter {
  constructor(private readonly driver: TemporaryPreviewDriverPort) {}

  validate(artifact: AppBuildArtifact): Promise<void> {
    return this.driver.validate(artifact, "temporary");
  }

  deploy(
    request: Omit<AppRuntimeDeployRequest, "targetKind" | "resources">,
  ): Promise<AppRuntimeDeployResult> {
    validateCredential(request.credential, "temporary");
    return this.driver.deploy({
      ...request,
      targetKind: "temporary",
      resources: { receipts: [] },
    });
  }

  disableExposure(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
  ): Promise<void> {
    validateCredential(credential, "temporary");
    return this.driver.disableExposure(target, credential);
  }
}

/** Permanent-account OAuth semantics, including explicit resources and Domains. */
export type CloudflareByocDriverPort = Pick<
  AppRuntimeDriver,
  | "validate"
  | "prepareResources"
  | "deploy"
  | "rollback"
  | "disableExposure"
  | "setCustomDomain"
  | "verifyCustomDomain"
  | "removeCustomDomain"
>;

export class CloudflareByocAdapter {
  constructor(private readonly driver: CloudflareByocDriverPort) {}

  validate(artifact: AppBuildArtifact): Promise<void> {
    return this.driver.validate(artifact, "byoc");
  }

  prepareResources(
    request: AppRuntimePrepareResourcesRequest,
  ): Promise<AppRuntimePreparedResources> {
    validateCredential(request.credential, "byoc");
    return this.driver.prepareResources(request);
  }

  deploy(request: Omit<AppRuntimeDeployRequest, "targetKind">): Promise<AppRuntimeDeployResult> {
    validateCredential(request.credential, "byoc");
    return this.driver.deploy({ ...request, targetKind: "byoc" });
  }

  rollback(request: AppRuntimeRollbackRequest): Promise<AppRuntimeDeployResult> {
    validateCredential(request.credential, "byoc");
    return this.driver.rollback(request);
  }

  disableExposure(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
  ): Promise<void> {
    validateCredential(credential, "byoc");
    return this.driver.disableExposure(target, credential);
  }

  setCustomDomain(
    target: AppRuntimeTarget,
    credential: AppCloudflareDeploymentCredential,
    input: {
      hostname: string;
      zoneId: string;
      confirmImpact: true;
      workersDevHealthy: true;
    },
  ): Promise<AppRuntimeDomainResult> {
    validateCredential(credential, "byoc");
    return this.driver.setCustomDomain(target, credential, input);
  }

  verifyCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
    hostname: string,
  ): Promise<AppRuntimeDomainResult> {
    validateCredential(credential, "byoc");
    return this.driver.verifyCustomDomain(credential, providerId, hostname);
  }

  removeCustomDomain(
    credential: AppCloudflareDeploymentCredential,
    providerId: string,
  ): Promise<void> {
    validateCredential(credential, "byoc");
    return this.driver.removeCustomDomain(credential, providerId);
  }
}

export interface CreateAppRuntimeDriverOptions {
  env?: NodeJS.ProcessEnv;
  /** Kept for call-site compatibility; no local runtime is created below this path. */
  runtimeRoot?: string;
  fetch?: typeof fetch;
  apiFactory?: CloudflareApiFactory;
}

export function createAppRuntimeDriver(
  options: CreateAppRuntimeDriverOptions = {},
): AppRuntimeDriver {
  const env = options.env ?? process.env;
  const enabled = (name: string): boolean => {
    const value = (env[name] ?? "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  };
  if (!enabled("PIWORK_APPS_TEMPORARY_ENABLED") && !enabled("PIWORK_APPS_BYOC_ENABLED")) {
    return new DisabledAppRuntimeDriver();
  }
  return new CloudflareAppRuntimeDriver({
    fetch: options.fetch,
    apiFactory: options.apiFactory,
  });
}
