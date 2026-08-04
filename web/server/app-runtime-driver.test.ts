import { describe, expect, it, vi } from "vitest";
import {
  computeAppArtifactDigest,
  type AppBuildArtifact,
  type AppStaticAsset,
} from "./app-build.js";
import type { AppCloudflareDeploymentCredential } from "./apps-cloudflare-account-types.js";
import {
  AppRuntimeConfigurationError,
  AppRuntimeDisabledError,
  CloudflareByocAdapter,
  CloudflareAppRuntimeDriver,
  CloudflareSdkAppRuntimeApi,
  createAppRuntimeDriver,
  deserializeAppArtifact,
  prepareWrappedWorkerUpload,
  serializeAppArtifact,
  TEMPORARY_APP_ASSET_FILE_LIMIT_BYTES,
  TemporaryPreviewAdapter,
  type AppRuntimeDeployResult,
  type AppRuntimeDriver,
  type AppRuntimeResourceReceipt,
  type AppRuntimeTarget,
  type CloudflareAppRuntimeApi,
} from "./app-runtime-driver.js";

function artifact(overrides: Partial<AppBuildArtifact> = {}): AppBuildArtifact {
  const value: AppBuildArtifact = {
    sourceRoot: "/workspace/app",
    fileCount: 3,
    sourceBytes: 10,
    sourceDigest: "a".repeat(64),
    manifest: {
      version: 1,
      runtime: "cloudflare-workers",
      exposure: { workersDev: true },
    },
    bindings: {
      kv: [],
      d1: [],
      r2: [],
      durableObjects: [],
      exposure: { workersDev: true },
      hasStatefulResources: false,
      temporaryEligible: true,
      sensitive: false,
    },
    configPath: "build/server/wrangler.json",
    mainModule: "worker.js",
    compatibilityFlags: [],
    modules: [
      {
        name: "worker.js",
        contentType: "application/javascript+module",
        bytes: new TextEncoder().encode("export default {}"),
      },
    ],
    assets: [],
    warnings: [],
    artifactDigest: "b".repeat(64),
    durableObjectClasses: [],
    rawConfig: { main: "worker.js" },
    ...overrides,
  };
  if (overrides.artifactDigest === undefined) {
    value.artifactDigest = computeAppArtifactDigest(value);
  }
  return value;
}

function target(): AppRuntimeTarget {
  return {
    appId: "123e4567-e89b-12d3-a456-426614174000",
    tenantId: "tenant-1",
    workerName: "piwork-app-123",
    ownerUserId: "user-1",
  };
}

function credential(targetKind: "temporary" | "byoc" = "byoc"): AppCloudflareDeploymentCredential {
  return {
    target: targetKind,
    accountId: "account-1",
    apiToken: "server-secret-token",
    connectionId: targetKind === "byoc" ? "connection-1" : null,
    temporaryAccountId: targetKind === "temporary" ? "temporary-1" : null,
    expiresAt: null,
  };
}

class FakeCloudflareApi implements CloudflareAppRuntimeApi {
  readonly calls: Array<{ name: string; input?: unknown }> = [];
  zoneStatus = "active";
  uploadedBindings: Array<Record<string, unknown>> = [];

  private named(name: string, id = `${name}-id`) {
    return { id, name };
  }

  async createKv(name: string) {
    this.calls.push({ name: "createKv", input: name });
    return this.named(name);
  }
  async getKv(id: string) {
    this.calls.push({ name: "getKv", input: id });
    return this.named("adopted-kv", id);
  }
  async findKvByName(name: string) {
    this.calls.push({ name: "findKvByName", input: name });
    return null;
  }
  async createD1(name: string) {
    this.calls.push({ name: "createD1", input: name });
    return this.named(name);
  }
  async getD1(id: string) {
    this.calls.push({ name: "getD1", input: id });
    return this.named("adopted-d1", id);
  }
  async findD1ByName(name: string) {
    this.calls.push({ name: "findD1ByName", input: name });
    return null;
  }
  async createR2(name: string, jurisdiction?: "default" | "eu" | "fedramp") {
    this.calls.push({ name: "createR2", input: { name, jurisdiction } });
    return { ...this.named(name, name), jurisdiction };
  }
  async getR2(name: string, jurisdiction?: "default" | "eu" | "fedramp") {
    this.calls.push({ name: "getR2", input: { name, jurisdiction } });
    return { ...this.named(name, name), jurisdiction };
  }
  async uploadAssets(_workerName: string, _assets: AppStaticAsset[]) {
    this.calls.push({ name: "uploadAssets" });
    return undefined;
  }
  async uploadWorker(input: {
    appId: string;
    workerName: string;
    deploymentId: string;
    artifact: AppBuildArtifact;
    bindings: Array<Record<string, unknown>>;
    assetsJwt?: string;
    migration?: Record<string, unknown>;
  }) {
    this.calls.push({ name: "uploadWorker", input });
    this.uploadedBindings = input.bindings;
    return { versionId: "version-1", migrationTag: "migration-1" };
  }
  async rollbackWorker(workerName: string, providerVersion: string) {
    this.calls.push({ name: "rollbackWorker", input: { workerName, providerVersion } });
  }
  async enableWorkersDev(workerName: string) {
    this.calls.push({ name: "enableWorkersDev", input: workerName });
  }
  async disableWorkersDev(workerName: string) {
    this.calls.push({ name: "disableWorkersDev", input: workerName });
  }
  async getWorkersSubdomain() {
    this.calls.push({ name: "getWorkersSubdomain" });
    return "account-subdomain";
  }
  async getZone(zoneId: string) {
    this.calls.push({ name: "getZone", input: zoneId });
    return { id: zoneId, name: "example.com", status: this.zoneStatus };
  }
  async attachDomain(input: { workerName: string; hostname: string; zoneId: string }) {
    this.calls.push({ name: "attachDomain", input });
    return {
      id: "domain-1",
      hostname: input.hostname,
      zoneId: input.zoneId,
      certificateId: "certificate-1",
    };
  }
  async getDomain(providerId: string) {
    this.calls.push({ name: "getDomain", input: providerId });
    return {
      id: providerId,
      hostname: "app.example.com",
      zoneId: "a".repeat(32),
      certificateId: "certificate-1",
    };
  }
  async detachDomain(providerId: string) {
    this.calls.push({ name: "detachDomain", input: providerId });
  }
}

function cloudflareDriver(api = new FakeCloudflareApi()) {
  return {
    api,
    driver: new CloudflareAppRuntimeDriver({
      apiFactory: () => api,
      fetch: vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    }),
  };
}

function adapterDriver() {
  const result: AppRuntimeDeployResult = {
    providerVersion: "version-1",
    stableUrl: "https://piwork-app-123.example.workers.dev",
    artifactLocation:
      "cloudflare://accounts/account-1/workers/scripts/piwork-app-123/versions/version-1",
    readiness: "ready",
    warnings: [],
    resourceReceipts: [],
  };
  const validate = vi.fn(async () => undefined);
  const prepareResources = vi.fn(
    async (request: Parameters<AppRuntimeDriver["prepareResources"]>[0]) => ({
      receipts: request.existingReceipts ?? [],
    }),
  );
  const deploy = vi.fn(async () => result);
  const rollback = vi.fn(async () => result);
  const disableExposure = vi.fn(async () => undefined);
  const setCustomDomain = vi.fn(async () => ({
    providerId: "domain-1",
    hostname: "app.example.com",
    zoneId: "zone-1",
    certificateId: null,
    active: true,
  }));
  const verifyCustomDomain = vi.fn(async () => ({
    providerId: "domain-1",
    hostname: "app.example.com",
    zoneId: "zone-1",
    certificateId: null,
    active: true,
  }));
  const removeCustomDomain = vi.fn(async () => undefined);
  const driver: AppRuntimeDriver = {
    kind: "cloudflare",
    validate,
    prepareResources,
    deploy,
    rollback,
    disableExposure,
    setCustomDomain,
    verifyCustomDomain,
    removeCustomDomain,
    health: vi.fn(async () => ({ ok: true, driver: "cloudflare" as const })),
  };
  return {
    driver,
    validate,
    prepareResources,
    deploy,
    rollback,
    disableExposure,
    setCustomDomain,
    verifyCustomDomain,
    removeCustomDomain,
  };
}

describe("App runtime drivers", () => {
  it("defaults to disabled and has no local runtime mode", async () => {
    const driver = createAppRuntimeDriver({ env: {} });
    expect(driver.kind).toBe("disabled");
    await expect(driver.deploy({} as never)).rejects.toBeInstanceOf(AppRuntimeDisabledError);
    expect(createAppRuntimeDriver({ env: { PIWORK_APPS_DRIVER: "local" } }).kind).toBe("disabled");
    expect(createAppRuntimeDriver({ env: { PIWORK_APPS_BYOC_ENABLED: "true" } }).kind).toBe(
      "cloudflare",
    );
  });

  it("fails closed for every disabled driver mutation and preserves a health projection", async () => {
    const driver = createAppRuntimeDriver({ env: {} });
    await expect(driver.validate({} as never, "temporary")).rejects.toBeInstanceOf(
      AppRuntimeDisabledError,
    );
    await expect(driver.prepareResources({} as never)).rejects.toBeInstanceOf(
      AppRuntimeDisabledError,
    );
    await expect(driver.rollback({} as never)).rejects.toBeInstanceOf(AppRuntimeDisabledError);
    await expect(driver.disableExposure({} as never, {} as never)).rejects.toBeInstanceOf(
      AppRuntimeDisabledError,
    );
    await expect(
      driver.setCustomDomain({} as never, {} as never, {} as never),
    ).rejects.toBeInstanceOf(AppRuntimeDisabledError);
    await expect(
      driver.verifyCustomDomain({} as never, "provider", "app.example.com"),
    ).rejects.toBeInstanceOf(AppRuntimeDisabledError);
    await expect(driver.removeCustomDomain({} as never, "provider")).rejects.toBeInstanceOf(
      AppRuntimeDisabledError,
    );
    await expect(driver.health()).resolves.toMatchObject({
      ok: false,
      driver: "disabled",
      details: expect.stringContaining("disabled"),
    });
  });

  it("rejects a staged artifact whose bytes were changed without updating its digest", () => {
    const encoded = serializeAppArtifact(artifact());
    const value = JSON.parse(new TextDecoder().decode(encoded)) as {
      modules: Array<{ base64: string }>;
    };
    value.modules[0]!.base64 = Buffer.from("export default { fetch() {} }").toString("base64");
    expect(() => deserializeAppArtifact(new TextEncoder().encode(JSON.stringify(value)))).toThrow(
      "digest does not match",
    );
  });

  it("rejects malformed staged artifacts and unsafe wrapper binding declarations", () => {
    const encoded = serializeAppArtifact(artifact());
    const value = JSON.parse(new TextDecoder().decode(encoded)) as Record<string, unknown>;
    value.version = 2;
    expect(() => deserializeAppArtifact(new TextEncoder().encode(JSON.stringify(value)))).toThrow(
      "Stored App artifact is invalid",
    );
    const invalidAsset = JSON.parse(new TextDecoder().decode(encoded)) as {
      assets: Array<{ path: string; contentType: string; sha256: string; base64: string }>;
    };
    invalidAsset.assets.push({
      path: "/asset.txt",
      contentType: "text/plain",
      sha256: "bad",
      base64: Buffer.from("asset").toString("base64"),
    });
    expect(() =>
      deserializeAppArtifact(new TextEncoder().encode(JSON.stringify(invalidAsset))),
    ).toThrow("digest does not match");
    expect(() =>
      prepareWrappedWorkerUpload({
        appId: target().appId,
        artifact: artifact(),
        bindings: [
          { type: "kv_namespace", name: "CACHE", namespace_id: "one" },
          { type: "kv_namespace", name: "CACHE", namespace_id: "two" },
        ],
      }),
    ).toThrow("binding allowlist is invalid");
  });

  it("round-trips creator-owned staged artifacts without storing credentials", () => {
    const value = artifact();
    const serialized = serializeAppArtifact(value);
    expect(new TextDecoder().decode(serialized)).not.toContain("server-secret-token");
    const restored = deserializeAppArtifact(serialized);
    expect(restored.artifactDigest).toBe(value.artifactDigest);
    expect(new TextDecoder().decode(restored.modules[0]!.bytes)).toBe("export default {}");
  });

  it("fails temporary capability analysis before provisioning", async () => {
    const { driver } = cloudflareDriver();
    const stateful = artifact({
      manifest: {
        version: 1,
        runtime: "cloudflare-workers",
        resources: {
          kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
        },
        exposure: { workersDev: true },
      },
    });
    await expect(driver.validate(stateful, "temporary")).rejects.toThrow(
      "stateful_resources_require_byoc",
    );
    const oversized = artifact({
      assets: [
        {
          path: "/large.bin",
          contentType: "application/octet-stream",
          sha256: "c".repeat(64),
          bytes: new Uint8Array(TEMPORARY_APP_ASSET_FILE_LIMIT_BYTES + 1),
        },
      ],
    });
    await expect(driver.validate(oversized, "temporary")).rejects.toThrow("exceeds 5 MiB");
  });

  it("keeps the Temporary adapter stateless and forces the temporary deployment contract", async () => {
    const fake = adapterDriver();
    const adapter = new TemporaryPreviewAdapter(fake.driver);
    const exposed = adapter as unknown as Record<string, unknown>;

    expect(exposed.prepareResources).toBeUndefined();
    expect(exposed.rollback).toBeUndefined();
    expect(exposed.setCustomDomain).toBeUndefined();
    expect(exposed.verifyCustomDomain).toBeUndefined();
    expect(exposed.removeCustomDomain).toBeUndefined();

    await adapter.validate(artifact());
    expect(fake.validate).toHaveBeenCalledWith(expect.any(Object), "temporary");

    await adapter.deploy({
      target: target(),
      deploymentId: "deployment-temporary",
      credential: credential("temporary"),
      artifact: artifact(),
      // Exercise the runtime boundary as well as the TypeScript surface: even
      // an untyped caller cannot smuggle BYOC resources into this adapter.
      targetKind: "byoc",
      resources: {
        receipts: [
          {
            logicalKey: "cache",
            kind: "kv",
            binding: "CACHE",
            mode: "create",
            ownership: "created",
            externalId: "namespace-1",
            externalName: "cache",
            jurisdiction: null,
            stepStatus: "ready",
          },
        ],
      },
    } as never);

    expect(fake.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "temporary",
        resources: { receipts: [] },
      }),
    );
    expect(() =>
      adapter.deploy({
        target: target(),
        deploymentId: "deployment-wrong-credential",
        credential: credential("byoc"),
        artifact: artifact(),
      }),
    ).toThrow("target does not match credential");
    expect(fake.deploy).toHaveBeenCalledTimes(1);
  });

  it("keeps BYOC resources, rollback, and Domains explicit while forcing the BYOC target", async () => {
    const fake = adapterDriver();
    const adapter = new CloudflareByocAdapter(fake.driver);
    const exposed = adapter as unknown as Record<string, unknown>;

    expect(exposed.prepareResources).toBeTypeOf("function");
    expect(exposed.rollback).toBeTypeOf("function");
    expect(exposed.setCustomDomain).toBeTypeOf("function");
    expect(exposed.verifyCustomDomain).toBeTypeOf("function");
    expect(exposed.removeCustomDomain).toBeTypeOf("function");

    const resources = { receipts: [] };
    await adapter.deploy({
      target: target(),
      deploymentId: "deployment-byoc",
      credential: credential("byoc"),
      artifact: artifact(),
      resources,
      targetKind: "temporary",
    } as never);
    expect(fake.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "byoc", resources }),
    );

    await adapter.prepareResources({
      target: target(),
      credential: credential("byoc"),
      bindings: artifact().bindings,
    });
    expect(fake.prepareResources).toHaveBeenCalledOnce();

    await adapter.rollback({
      target: target(),
      deploymentId: "deployment-rollback",
      credential: credential("byoc"),
      providerVersion: "version-old",
    });
    expect(fake.rollback).toHaveBeenCalledOnce();

    await adapter.disableExposure(target(), credential("byoc"));
    await adapter.setCustomDomain(target(), credential("byoc"), {
      hostname: "app.example.com",
      zoneId: "zone-1",
      confirmImpact: true,
      workersDevHealthy: true,
    });
    await adapter.verifyCustomDomain(credential("byoc"), "domain-1", "app.example.com");
    await adapter.removeCustomDomain(credential("byoc"), "domain-1");
    expect(fake.disableExposure).toHaveBeenCalledOnce();
    expect(fake.setCustomDomain).toHaveBeenCalledOnce();
    expect(fake.verifyCustomDomain).toHaveBeenCalledOnce();
    expect(fake.removeCustomDomain).toHaveBeenCalledOnce();
  });

  it("provisions BYOC create/adopt resources and persists each ledger transition", async () => {
    const { driver, api } = cloudflareDriver();
    const transitions: AppRuntimeResourceReceipt[] = [];
    const prepared = await driver.prepareResources({
      target: target(),
      credential: credential(),
      bindings: {
        kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
        d1: [
          {
            key: "main",
            binding: "DB",
            mode: "adopt",
            databaseId: "database-immutable-1234",
          },
        ],
        r2: [
          {
            key: "files",
            binding: "FILES",
            mode: "create",
            jurisdiction: "eu",
          },
        ],
        durableObjects: [
          { binding: "ROOMS", className: "Room", storage: "sqlite", state: "created" },
        ],
        exposure: { workersDev: true },
        hasStatefulResources: true,
        temporaryEligible: false,
        sensitive: true,
      },
      onReceipt: async (receipt) => {
        transitions.push(structuredClone(receipt));
      },
    });
    expect(prepared.receipts).toHaveLength(4);
    expect(transitions.map((entry) => entry.stepStatus)).toEqual([
      "provisioning",
      "ready",
      "provisioning",
      "ready",
      "provisioning",
      "ready",
      "planned",
    ]);
    expect(api.calls.some((call) => call.name === "getD1")).toBe(true);
    expect(api.calls.find((call) => call.name === "createR2")?.input).toMatchObject({
      jurisdiction: "eu",
    });
  });

  it("marks every created resource touched by a partially failed prepare as needs_cleanup", async () => {
    const { driver, api } = cloudflareDriver();
    vi.spyOn(api, "createD1").mockRejectedValueOnce(new Error("D1 create response lost"));
    const transitions: AppRuntimeResourceReceipt[] = [];

    await expect(
      driver.prepareResources({
        target: target(),
        credential: credential(),
        bindings: {
          kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
          d1: [{ key: "main", binding: "DB", mode: "create" }],
          r2: [],
          durableObjects: [],
          exposure: { workersDev: true },
          hasStatefulResources: true,
          temporaryEligible: false,
          sensitive: true,
        },
        onReceipt: async (receipt) => {
          transitions.push(structuredClone(receipt));
        },
      }),
    ).rejects.toThrow("D1 create response lost");

    const finalByBinding = new Map(transitions.map((receipt) => [receipt.binding, receipt]));
    expect(finalByBinding.get("CACHE")).toMatchObject({
      kind: "kv",
      ownership: "created",
      stepStatus: "needs_cleanup",
      errorCode: "cloudflare_resource_provision_failed",
    });
    expect(finalByBinding.get("CACHE")?.externalId).toBeTruthy();
    expect(finalByBinding.get("DB")).toMatchObject({
      kind: "d1",
      ownership: "created",
      stepStatus: "needs_cleanup",
      errorCode: "cloudflare_resource_provision_failed",
    });
  });

  it("uploads an ordinary Worker, binds immutable resource receipts, and returns workers.dev", async () => {
    const { driver, api } = cloudflareDriver();
    const built = artifact({
      bindings: {
        kv: [],
        d1: [{ key: "main", binding: "DB", mode: "create" }],
        r2: [],
        durableObjects: [],
        exposure: { workersDev: true },
        hasStatefulResources: true,
        temporaryEligible: false,
        sensitive: true,
      },
    });
    const result = await driver.deploy({
      target: target(),
      deploymentId: "deployment-1",
      targetKind: "byoc",
      credential: credential(),
      artifact: built,
      resources: {
        receipts: [
          {
            logicalKey: "main",
            kind: "d1",
            binding: "DB",
            mode: "create",
            ownership: "created",
            externalId: "database-id-1",
            externalName: "database-name-1",
            jurisdiction: null,
            stepStatus: "ready",
          },
        ],
      },
    });
    expect(api.uploadedBindings).toContainEqual({
      type: "d1",
      name: "DB",
      database_id: "database-id-1",
    });
    expect(result.stableUrl).toBe("https://piwork-app-123.account-subdomain.workers.dev");
    expect(result.artifactLocation).toContain("/versions/version-1");
    expect(api.calls.map((call) => call.name)).toContain("enableWorkersDev");
  });

  it("reuses a tagged immutable Worker version before attempting another upload", async () => {
    const versionsList = vi.fn(async () => [
      {
        id: "version-existing",
        metadata: { annotations: { "workers/tag": "deployment-retry" } },
      },
    ]);
    const update = vi.fn(async () => ({ id: "unexpected-upload" }));
    const api = new CloudflareSdkAppRuntimeApi("account-1", "server-secret-token", {
      workers: {
        scripts: {
          versions: { list: versionsList },
          update,
        },
      },
    } as never);

    const result = await api.uploadWorker({
      appId: target().appId,
      workerName: target().workerName,
      deploymentId: "deployment-retry",
      artifact: artifact(),
      bindings: [],
    });

    expect(result).toEqual({ versionId: "version-existing" });
    expect(versionsList).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("makes the Piwork security wrapper the real Worker entrypoint", () => {
    const wrapped = prepareWrappedWorkerUpload({
      appId: target().appId,
      artifact: artifact(),
      bindings: [{ type: "kv_namespace", name: "CACHE", namespace_id: "namespace-1" }],
    });
    expect(wrapped.mainModule).toMatch(/^__piwork_wrapper_[a-f0-9]+\.mjs$/u);
    expect(wrapped.compatibilityFlags).toContain("disallow_importable_env");
    expect(wrapped.bindings).toContainEqual(
      expect.objectContaining({
        type: "plain_text",
        name: "PIWORK_WRAPPER_CONFIG",
        text: expect.stringContaining('"allowedBindings":["CACHE"]'),
      }),
    );
    const source = new TextDecoder().decode(
      wrapped.modules.find((module) => module.name === wrapped.mainModule)?.bytes,
    );
    expect(source).toContain('headers.delete("authorization")');
    expect(source).toContain('name.toLowerCase().startsWith("x-piwork-")');
    expect(source).toContain("better-auth");
    expect(source).toContain('url.pathname === "/__piwork"');
    expect(source).toContain('export * from "./worker.js"');
  });

  it("does not mark a workers.dev deployment ready for an HTTP error", async () => {
    const api = new FakeCloudflareApi();
    const driver = new CloudflareAppRuntimeDriver({
      apiFactory: () => api,
      fetch: vi.fn(
        async () => new Response("upstream failed", { status: 503 }),
      ) as unknown as typeof fetch,
    });
    const result = await driver.deploy({
      target: target(),
      deploymentId: "deployment-unhealthy",
      targetKind: "byoc",
      credential: credential(),
      artifact: artifact(),
      resources: { receipts: [] },
    });
    expect(result.readiness).toBe("pending");
  });

  it("accepts successful and redirect workers.dev health responses", async () => {
    for (const status of [200, 302]) {
      const api = new FakeCloudflareApi();
      const driver = new CloudflareAppRuntimeDriver({
        apiFactory: () => api,
        fetch: vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      const result = await driver.deploy({
        target: target(),
        deploymentId: `deployment-health-${status}`,
        targetKind: "byoc",
        credential: credential(),
        artifact: artifact(),
        resources: { receipts: [] },
      });
      expect(result.readiness).toBe("ready");
    }
  });

  it("rejects destructive Durable Object migrations", async () => {
    const { driver } = cloudflareDriver();
    await expect(
      driver.deploy({
        target: target(),
        deploymentId: "deployment-2",
        targetKind: "byoc",
        credential: credential(),
        artifact: artifact(),
        resources: { receipts: [] },
        previous: {
          providerVersion: "version-old",
          durableObjectClasses: ["DeletedRoom"],
          migrationTag: "old-tag",
        },
      }),
    ).rejects.toThrow("deletion, rename, or transfer");
  });

  it("retains created Durable Object receipts as needs_cleanup after upload failure", async () => {
    const { driver, api } = cloudflareDriver();
    vi.spyOn(api, "uploadWorker").mockRejectedValueOnce(new Error("upload failed"));
    const transitions: AppRuntimeResourceReceipt[] = [];
    await expect(
      driver.deploy({
        target: target(),
        deploymentId: "deployment-do-failed",
        targetKind: "byoc",
        credential: credential(),
        artifact: artifact({
          bindings: {
            kv: [],
            d1: [],
            r2: [],
            durableObjects: [
              { binding: "ROOMS", className: "Room", storage: "sqlite", state: "created" },
            ],
            exposure: { workersDev: true },
            hasStatefulResources: true,
            temporaryEligible: false,
            sensitive: true,
          },
          durableObjectClasses: ["Room"],
        }),
        resources: {
          receipts: [
            {
              logicalKey: "ROOMS",
              kind: "durable_object",
              binding: "ROOMS",
              mode: "created",
              ownership: "created",
              externalId: null,
              externalName: "Room",
              jurisdiction: null,
              stepStatus: "planned",
            },
          ],
        },
        onReceipt: async (receipt) => {
          transitions.push(receipt);
        },
      }),
    ).rejects.toThrow("upload failed");

    expect(transitions).toEqual([
      expect.objectContaining({
        kind: "durable_object",
        logicalKey: "ROOMS",
        stepStatus: "needs_cleanup",
        errorCode: "cloudflare_worker_deploy_failed",
      }),
    ]);
  });

  it("marks all created state receipts but never adopted receipts after Worker failure", async () => {
    const { driver, api } = cloudflareDriver();
    vi.spyOn(api, "uploadWorker").mockRejectedValueOnce(new Error("worker upload failed"));
    const transitions: AppRuntimeResourceReceipt[] = [];
    const createdKv: AppRuntimeResourceReceipt = {
      logicalKey: "cache",
      kind: "kv",
      binding: "CACHE",
      mode: "create",
      ownership: "created",
      externalId: "namespace-created",
      externalName: "created-cache",
      jurisdiction: null,
      stepStatus: "ready",
    };
    const adoptedD1: AppRuntimeResourceReceipt = {
      logicalKey: "main",
      kind: "d1",
      binding: "DB",
      mode: "adopt",
      ownership: "adopted",
      externalId: "database-adopted",
      externalName: "adopted-db",
      jurisdiction: null,
      stepStatus: "ready",
    };

    await expect(
      driver.deploy({
        target: target(),
        deploymentId: "deployment-state-failed",
        targetKind: "byoc",
        credential: credential(),
        artifact: artifact({
          bindings: {
            kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
            d1: [
              {
                key: "main",
                binding: "DB",
                mode: "adopt",
                databaseId: "database-adopted",
              },
            ],
            r2: [],
            durableObjects: [],
            exposure: { workersDev: true },
            hasStatefulResources: true,
            temporaryEligible: false,
            sensitive: true,
          },
        }),
        resources: { receipts: [createdKv, adoptedD1] },
        onReceipt: async (receipt) => {
          transitions.push(structuredClone(receipt));
        },
      }),
    ).rejects.toThrow("worker upload failed");

    expect(transitions).toEqual([
      expect.objectContaining({
        logicalKey: "cache",
        ownership: "created",
        stepStatus: "needs_cleanup",
        errorCode: "cloudflare_worker_deploy_failed",
      }),
    ]);
    expect(transitions.some((receipt) => receipt.ownership === "adopted")).toBe(false);
  });

  it("rolls back by immutable Cloudflare version without rebuilding source", async () => {
    const { driver, api } = cloudflareDriver();
    const result = await driver.rollback({
      target: target(),
      deploymentId: "deployment-rollback",
      credential: credential(),
      providerVersion: "version-old",
    });
    expect(result.providerVersion).toBe("version-old");
    expect(api.calls.find((call) => call.name === "rollbackWorker")?.input).toEqual({
      workerName: "piwork-app-123",
      providerVersion: "version-old",
    });
    expect(api.calls.some((call) => call.name === "uploadWorker")).toBe(false);
  });

  it("attaches only an explicitly confirmed BYOC domain in an active zone", async () => {
    const { driver, api } = cloudflareDriver();
    await expect(
      driver.setCustomDomain(target(), credential("temporary"), {
        hostname: "app.example.com",
        zoneId: "a".repeat(32),
        confirmImpact: true,
        workersDevHealthy: true,
      }),
    ).rejects.toThrow("OAuth BYOC");
    const result = await driver.setCustomDomain(target(), credential(), {
      hostname: "app.example.com",
      zoneId: "a".repeat(32),
      confirmImpact: true,
      workersDevHealthy: true,
    });
    expect(result).toMatchObject({
      providerId: "domain-1",
      hostname: "app.example.com",
      active: true,
    });
    api.zoneStatus = "pending";
    await expect(
      driver.setCustomDomain(target(), credential(), {
        hostname: "next.example.com",
        zoneId: "a".repeat(32),
        confirmImpact: true,
        workersDevHealthy: true,
      }),
    ).rejects.toThrow("not active");
  });

  it("verifies the current account workers.dev URL before attaching a custom domain", async () => {
    const api = new FakeCloudflareApi();
    const fetcher = vi.fn(
      async () => new Response("not ready", { status: 503 }),
    ) as unknown as typeof fetch;
    const driver = new CloudflareAppRuntimeDriver({ apiFactory: () => api, fetch: fetcher });

    await expect(
      driver.setCustomDomain(target(), credential("byoc"), {
        hostname: "app.example.com",
        zoneId: "a".repeat(32),
        confirmImpact: true,
        workersDevHealthy: true,
      }),
    ).rejects.toMatchObject({ code: "cloudflare_worker_not_ready" });

    expect(fetcher).toHaveBeenCalledWith(
      "https://piwork-app-123.account-subdomain.workers.dev",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(api.calls.some((call) => call.name === "attachDomain")).toBe(false);
  });

  it("rejects an attached custom domain that changes hostname and reports provider health", async () => {
    const api = new FakeCloudflareApi();
    vi.spyOn(api, "getDomain").mockResolvedValueOnce({
      id: "domain-1",
      hostname: "other.example.com",
      zoneId: "a".repeat(32),
      certificateId: "certificate-1",
    });
    const driver = new CloudflareAppRuntimeDriver({ apiFactory: () => api });
    await expect(
      driver.verifyCustomDomain(credential("byoc"), "domain-1", "app.example.com"),
    ).rejects.toMatchObject({ code: "cloudflare_domain_mismatch" });
    await expect(driver.health()).resolves.toMatchObject({ ok: true, driver: "cloudflare" });
    vi.spyOn(api, "getWorkersSubdomain").mockRejectedValueOnce(new Error("unavailable"));
    await expect(driver.health(credential("byoc"))).resolves.toMatchObject({
      ok: false,
      details: "Cloudflare account is unavailable",
    });
    await driver.disableExposure(target(), credential("byoc"));
    await driver.removeCustomDomain(credential("byoc"), "domain-1");
  });
});
