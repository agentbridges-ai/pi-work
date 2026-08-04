import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { collectAppBuildArtifact } from "./app-build.js";
import type { AppCloudflareAccountService } from "./apps-cloudflare-account-service.js";
import type { AppsControlPlane } from "./apps-control-plane.js";
import { serializeAppArtifact, type AppRuntimeDriver } from "./app-runtime-driver.js";
import { AppsRuntimeCoordinator } from "./apps-runtime-coordinator.js";
import type { AppDeploymentRecord, AppRecord } from "./apps-types.js";

async function appFixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-apps-coordinator-"));
  const workspace = join(root, "session", "workspace");
  const source = join(workspace, "demo");
  const creatorRoot = join(root, "creator");
  await mkdir(join(source, "build", "server"), { recursive: true });
  await mkdir(creatorRoot, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { build: "true" } }));
  await writeFile(join(source, "bun.lock"), "lockfileVersion = 1\n");
  await writeFile(
    join(source, "piwork.app.json"),
    JSON.stringify({
      version: 1,
      runtime: "cloudflare-workers",
      exposure: { workersDev: true },
    }),
  );
  await writeFile(
    join(source, "build", "server", "wrangler.json"),
    JSON.stringify({ main: "index.js", compatibility_date: "2026-08-04" }),
  );
  await writeFile(
    join(source, "build", "server", "index.js"),
    "export default { fetch() { return new Response('ok') } };\n",
  );
  return { root, workspace, source, creatorRoot };
}

function app(status: AppRecord["status"] = "building"): AppRecord {
  return {
    id: "app-1",
    tenantId: "tenant-1",
    ownerMembershipId: "member-1",
    ownerUserId: "user-1",
    sourceSessionId: "session-1",
    sourceSessionGeneration: 7,
    tenantHandle: "tenant-12345678",
    workerName: "piwork-app-app-1",
    slug: "demo",
    name: "Demo",
    status,
    statusReason: null,
    stableUrl: null,
    screenshotUrl: null,
    currentDeploymentId: null,
    generation: 1,
    customDomain: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    archivedAt: status === "archived" ? "2026-08-04T00:01:00.000Z" : null,
    canManage: true,
    targetKind: "unassigned",
    cloudflareConnectionId: null,
    temporaryPreviewId: null,
  } as AppRecord;
}

function deployment(overrides: Partial<AppDeploymentRecord> = {}): AppDeploymentRecord {
  return {
    id: "deployment-1",
    appId: "app-1",
    version: 1,
    phase: "awaiting_target",
    targetKind: "unassigned",
    cloudflareConnectionId: null,
    temporaryPreviewId: null,
    sourceSessionId: "session-1",
    sourceSessionGeneration: 7,
    sourceDigest: "a".repeat(64),
    artifactKey: null,
    manifest: {
      version: 1,
      runtime: "cloudflare-workers",
      exposure: { workersDev: true },
    },
    bindingManifest: {},
    cloudflareVersionId: null,
    cloudflareMigrationTag: null,
    stableUrl: null,
    screenshotUrl: null,
    warnings: [],
    errorCode: null,
    errorMessage: null,
    rollbackOfDeploymentId: null,
    idempotencyKey: "broker:key",
    appGeneration: 1,
    createdBy: "user-1",
    createdAt: "2026-08-04T00:00:00.000Z",
    deployedAt: null,
    ...overrides,
  } as AppDeploymentRecord;
}

function harness(controlPlane: Record<string, ReturnType<typeof vi.fn>>, creatorRoot: string) {
  const driver = {
    kind: "disabled",
    validate: vi.fn(),
    deploy: vi.fn(),
    rollback: vi.fn(),
  } as unknown as AppRuntimeDriver;
  const coordinator = new AppsRuntimeCoordinator({
    controlPlane: controlPlane as unknown as AppsControlPlane,
    cloudflareAccounts: {} as AppCloudflareAccountService,
    driver,
    creatorRoot,
    getCurrentUser: () => ({
      userId: "user-1",
      uuid: "user-1",
      username: "alice",
      displayName: "Alice",
      orgId: "tenant-1",
      orgName: "Tenant",
      tenantId: "tenant-1",
      membershipId: "member-1",
      roles: [],
    }),
  });
  return { coordinator, driver };
}

function brokerRequest(operation: string, payload: Record<string, unknown>) {
  return {
    id: "request-1",
    sessionId: "session-1",
    generation: 7,
    operation,
    payload,
  };
}

const brokerContext = {
  signal: new AbortController().signal,
  onProgress: vi.fn(),
};

const brokerScope = {
  sessionId: "session-1",
  generation: 7,
  sessionRoot: "/session",
  workspaceDir: "",
};

describe("AppsRuntimeCoordinator", () => {
  it("honors the operator deployment kill switch before a dry run", async () => {
    const fixture = await appFixture();
    const { coordinator } = harness({}, fixture.creatorRoot);
    vi.stubEnv("PIWORK_APPS_KILL_SWITCH", "1");
    try {
      await expect(
        coordinator.handleBroker(
          brokerRequest("app.deploy", { path: "demo", dryRun: true }),
          brokerContext,
          { ...brokerScope, workspaceDir: fixture.workspace },
        ),
      ).rejects.toThrow("paused by the platform operator");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs dry-run validation without creating control-plane or staged artifact state", async () => {
    const fixture = await appFixture();
    const beginDeployment = vi.fn();
    const { coordinator, driver } = harness({ beginDeployment }, fixture.creatorRoot);

    const result = await coordinator.handleBroker(
      brokerRequest("app.deploy", {
        path: "demo",
        slug: "demo",
        dryRun: true,
        publishIntent: "user_requested",
      }),
      brokerContext,
      { ...brokerScope, workspaceDir: fixture.workspace },
    );

    expect(result).toMatchObject({ dryRun: true, fileCount: 3 });
    expect(beginDeployment).not.toHaveBeenCalled();
    expect(driver.validate).not.toHaveBeenCalled();
  });

  it("persists bundle and creator-only source snapshot before awaiting target selection", async () => {
    const fixture = await appFixture();
    let createdDeployment = deployment();
    const beginDeployment = vi.fn(async (_context, input) => {
      createdDeployment = deployment({
        sourceDigest: input.sourceDigest,
        artifactKey: input.artifactKey,
      });
      return { app: app(), deployment: createdDeployment };
    });
    const setSourceSnapshotKey = vi.fn().mockResolvedValue(true);
    const getApp = vi.fn().mockResolvedValue(app());
    const getDeployment = vi.fn(async () => createdDeployment);
    const failDeployment = vi.fn();
    const { coordinator, driver } = harness(
      { beginDeployment, setSourceSnapshotKey, getApp, getDeployment, failDeployment },
      fixture.creatorRoot,
    );

    const result = await coordinator.handleBroker(
      brokerRequest("app.deploy", {
        path: "demo",
        slug: "demo",
        publishIntent: "user_requested",
      }),
      brokerContext,
      { ...brokerScope, workspaceDir: fixture.workspace },
    );

    expect(result).toMatchObject({ awaitingTarget: true });
    const input = beginDeployment.mock.calls[0]?.[1];
    expect(input.artifactKey).toMatch(/^creator-artifact:[a-f0-9]{64}$/u);
    const digest = input.artifactKey.split(":")[1];
    const staged = await readFile(
      join(fixture.creatorRoot, "published-apps", "staged-artifacts", `${digest}.json`),
    );
    expect(staged.byteLength).toBeGreaterThan(0);
    expect(setSourceSnapshotKey).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", generation: 7 }),
      "app-1",
      "deployment-1",
      1,
      "app-1/sources/deployment-1",
    );
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(failDeployment).not.toHaveBeenCalled();
  });

  it("runs the selected BYOC target through the trusted driver and completes the outbox", async () => {
    const fixture = await appFixture();
    const artifact = await collectAppBuildArtifact(fixture.workspace, "demo");
    const stagedDir = join(fixture.creatorRoot, "published-apps", "staged-artifacts");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, `${artifact.artifactDigest}.json`),
      serializeAppArtifact(artifact),
    );
    const queued = deployment({
      phase: "queued",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-1",
      sourceDigest: artifact.sourceDigest,
      artifactKey: `creator-artifact:${artifact.artifactDigest}`,
    });
    const deploying = deployment({ ...queued, phase: "deploying" });
    const appRecord = {
      ...app("needs_action"),
      targetKind: "byoc" as const,
      cloudflareConnectionId: "connection-1",
    };
    const priorReceipt = {
      id: "receipt-1",
      appId: "app-1",
      deploymentId: "deployment-0",
      target: "byoc" as const,
      connectionId: "connection-1",
      temporaryAccountId: null,
      logicalKey: "cache",
      resourceKind: "kv" as const,
      mode: "adopt" as const,
      ownership: "adopted" as const,
      externalId: "kv-1",
      externalName: "cache",
      stepStatus: "ready" as const,
      metadata: { binding: "CACHE", jurisdiction: "eu" },
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    };
    const workerReceipt = {
      ...priorReceipt,
      id: "receipt-worker",
      logicalKey: "worker",
      resourceKind: "worker" as const,
    };
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-1" }),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue(appRecord),
      getDeployment: vi.fn().mockResolvedValue(queued),
      markDeploymentDeploying: vi.fn().mockResolvedValue(deploying),
      completeDeployment: vi.fn().mockResolvedValue({ app: app("ready"), deployment: deploying }),
      completeOutboxByKey: vi.fn().mockResolvedValue(true),
      failOutboxByKey: vi.fn().mockResolvedValue(true),
      failDeployment: vi.fn(),
    };
    const accounts = {
      resolveDeploymentCredential: vi.fn().mockResolvedValue({
        target: "byoc",
        accountId: "account-1",
        apiToken: "server-only-token",
        connectionId: "connection-1",
        temporaryAccountId: null,
        expiresAt: null,
      }),
      transitionDeploymentPhase: vi.fn().mockResolvedValue(undefined),
      listDeploymentReceipts: vi.fn().mockResolvedValue([priorReceipt, workerReceipt]),
      recordResourceReceipt: vi.fn().mockResolvedValue({}),
    };
    const driver = {
      kind: "cloudflare",
      validate: vi.fn().mockResolvedValue(undefined),
      prepareResources: vi.fn().mockResolvedValue({ receipts: [] }),
      deploy: vi.fn().mockResolvedValue({
        providerVersion: "version-1",
        stableUrl: "https://piwork-app-app-1.example.workers.dev",
        artifactLocation: "cloudflare://version-1",
        readiness: "ready",
        warnings: [],
        resourceReceipts: [],
      }),
    } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await coordinator.handleDeploymentTargetQueued(
      { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
      {
        appId: "app-1",
        deploymentId: queued.id,
        appGeneration: 1,
        phase: "queued",
        target: "byoc",
        connectionId: "connection-1",
        temporaryAccountId: null,
      },
    );

    expect(accounts.transitionDeploymentPhase).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "queued", to: "provisioning" }),
    );
    expect(driver.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: queued.id,
        targetKind: "byoc",
        credential: expect.objectContaining({ apiToken: "server-only-token" }),
      }),
    );
    expect(driver.prepareResources).toHaveBeenCalledWith(
      expect.objectContaining({
        existingReceipts: [
          expect.objectContaining({
            logicalKey: "cache",
            binding: "CACHE",
            jurisdiction: "eu",
          }),
        ],
      }),
    );
    expect(controlPlane.completeDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: "ready", cloudflareVersionId: "version-1" }),
    );
    expect(controlPlane.completeOutboxByKey).toHaveBeenCalledWith(
      "app-1",
      "deploy",
      queued.idempotencyKey,
      1,
      "lease-1",
    );
    expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "lease-1");
  });

  it("fails a queued deployment when its creator artifact locator is unavailable", async () => {
    const fixture = await appFixture();
    const queued = deployment({
      phase: "queued",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-1",
      artifactKey: null,
    });
    const appRecord = {
      ...app("needs_action"),
      targetKind: "byoc" as const,
      cloudflareConnectionId: "connection-1",
    };
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-artifact" }),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue(appRecord),
      getDeployment: vi.fn().mockResolvedValue(queued),
      failDeployment: vi.fn().mockResolvedValue(undefined),
      failOutboxByKey: vi.fn().mockResolvedValue(true),
    };
    const accounts = {
      resolveDeploymentCredential: vi.fn().mockResolvedValue({
        target: "byoc",
        accountId: "account-1",
        apiToken: "server-only-token",
        connectionId: "connection-1",
        temporaryAccountId: null,
        expiresAt: null,
      }),
    };
    const driver = {
      kind: "cloudflare",
      validate: vi.fn(),
      prepareResources: vi.fn(),
      deploy: vi.fn(),
    } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await expect(
      coordinator.handleDeploymentTargetQueued(
        { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
        {
          appId: "app-1",
          deploymentId: queued.id,
          appGeneration: 1,
          phase: "queued",
          target: "byoc",
          connectionId: "connection-1",
          temporaryAccountId: null,
        },
      ),
    ).rejects.toThrow("artifact is unavailable");
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(controlPlane.failDeployment).toHaveBeenCalledOnce();
    expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "lease-artifact");
  });

  it("marks prepared created resources for cleanup when deployment fails before provider upload", async () => {
    const fixture = await appFixture();
    await writeFile(
      join(fixture.source, "piwork.app.json"),
      JSON.stringify({
        version: 1,
        runtime: "cloudflare-workers",
        resources: {
          kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
          d1: [
            {
              key: "main",
              binding: "DB",
              mode: "adopt",
              databaseId: "a".repeat(32),
            },
          ],
        },
        exposure: { workersDev: true },
      }),
    );
    const artifact = await collectAppBuildArtifact(fixture.workspace, "demo");
    const stagedDir = join(fixture.creatorRoot, "published-apps", "staged-artifacts");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, `${artifact.artifactDigest}.json`),
      serializeAppArtifact(artifact),
    );
    const queued = deployment({
      phase: "queued",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-1",
      sourceDigest: artifact.sourceDigest,
      artifactKey: `creator-artifact:${artifact.artifactDigest}`,
      manifest: artifact.manifest,
    });
    const appRecord = {
      ...app("needs_action"),
      targetKind: "byoc" as const,
      cloudflareConnectionId: "connection-1",
    };
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-cleanup" }),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue(appRecord),
      getDeployment: vi.fn().mockResolvedValue(queued),
      markDeploymentDeploying: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("database unavailable"), { code: "database_unavailable" }),
        ),
      failDeployment: vi.fn().mockResolvedValue(undefined),
      failOutboxByKey: vi.fn().mockResolvedValue(true),
    };
    const recordResourceReceipt = vi.fn().mockResolvedValue({});
    const accounts = {
      resolveDeploymentCredential: vi.fn().mockResolvedValue({
        target: "byoc",
        accountId: "account-1",
        apiToken: "server-only-token",
        connectionId: "connection-1",
        temporaryAccountId: null,
        expiresAt: null,
      }),
      transitionDeploymentPhase: vi.fn().mockResolvedValue(undefined),
      listDeploymentReceipts: vi.fn().mockResolvedValue([]),
      recordResourceReceipt,
    };
    const createdReceipt = {
      logicalKey: "cache",
      kind: "kv" as const,
      binding: "CACHE",
      mode: "create" as const,
      ownership: "created" as const,
      externalId: "created-kv-id",
      externalName: "created-kv-name",
      jurisdiction: null,
      stepStatus: "ready" as const,
    };
    const adoptedReceipt = {
      logicalKey: "main",
      kind: "d1" as const,
      binding: "DB",
      mode: "adopt" as const,
      ownership: "adopted" as const,
      externalId: "a".repeat(32),
      externalName: "adopted-db",
      jurisdiction: null,
      stepStatus: "ready" as const,
    };
    const driver = {
      kind: "cloudflare",
      validate: vi.fn().mockResolvedValue(undefined),
      prepareResources: vi.fn(
        async (request: Parameters<AppRuntimeDriver["prepareResources"]>[0]) => {
          await request.onReceipt?.(createdReceipt);
          await request.onReceipt?.(adoptedReceipt);
          return { receipts: [createdReceipt, adoptedReceipt] };
        },
      ),
      deploy: vi.fn(),
    } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await expect(
      coordinator.handleDeploymentTargetQueued(
        { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
        {
          appId: "app-1",
          deploymentId: queued.id,
          appGeneration: 1,
          phase: "queued",
          target: "byoc",
          connectionId: "connection-1",
          temporaryAccountId: null,
        },
      ),
    ).rejects.toThrow("database unavailable");

    const receiptUpdates = recordResourceReceipt.mock.calls.map((call) => call[1]);
    expect(receiptUpdates).toContainEqual(
      expect.objectContaining({
        logicalKey: "cache",
        ownership: "created",
        stepStatus: "needs_cleanup",
        errorCode: "cloudflare_worker_deploy_failed",
        leaseToken: "lease-cleanup",
      }),
    );
    expect(
      receiptUpdates.some(
        (receipt) =>
          receipt.logicalKey === "main" &&
          receipt.ownership === "adopted" &&
          receipt.stepStatus === "needs_cleanup",
      ),
    ).toBe(false);
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(controlPlane.failDeployment).toHaveBeenCalledOnce();
  });

  it("deploys a Temporary Account without entering the BYOC resource provisioner", async () => {
    const fixture = await appFixture();
    const artifact = await collectAppBuildArtifact(fixture.workspace, "demo");
    const stagedDir = join(fixture.creatorRoot, "published-apps", "staged-artifacts");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, `${artifact.artifactDigest}.json`),
      serializeAppArtifact(artifact),
    );
    const queued = deployment({
      phase: "queued",
      targetKind: "temporary",
      temporaryPreviewId: "preview-1",
      sourceDigest: artifact.sourceDigest,
      artifactKey: `creator-artifact:${artifact.artifactDigest}`,
    });
    const deploying = deployment({ ...queued, phase: "deploying" });
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-temporary" }),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue({
        ...app("needs_action"),
        targetKind: "temporary",
        temporaryPreviewId: "preview-1",
      }),
      getDeployment: vi.fn().mockResolvedValue(queued),
      markDeploymentDeploying: vi.fn().mockResolvedValue(deploying),
      completeDeployment: vi.fn().mockResolvedValue({ app: app("preview"), deployment: deploying }),
      completeOutboxByKey: vi.fn().mockResolvedValue(true),
      failOutboxByKey: vi.fn().mockResolvedValue(true),
      failDeployment: vi.fn(),
    };
    const accounts = {
      resolveDeploymentCredential: vi.fn().mockResolvedValue({
        target: "temporary",
        accountId: "temporary-account-1",
        apiToken: "server-only-temporary-token",
        connectionId: null,
        temporaryAccountId: "preview-1",
        expiresAt: "2099-08-04T01:00:00.000Z",
      }),
      transitionDeploymentPhase: vi.fn().mockResolvedValue(undefined),
      listDeploymentReceipts: vi.fn().mockResolvedValue([]),
      recordResourceReceipt: vi.fn().mockResolvedValue({}),
    };
    const driver = {
      kind: "cloudflare",
      validate: vi.fn().mockResolvedValue(undefined),
      prepareResources: vi.fn().mockRejectedValue(new Error("BYOC-only path was called")),
      deploy: vi.fn().mockResolvedValue({
        providerVersion: "temporary-version-1",
        stableUrl: "https://piwork-app-app-1.temporary.workers.dev",
        artifactLocation: "cloudflare://temporary-version-1",
        readiness: "ready",
        warnings: [],
        resourceReceipts: [],
      }),
    } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await coordinator.handleDeploymentTargetQueued(
      { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
      {
        appId: "app-1",
        deploymentId: queued.id,
        appGeneration: 1,
        phase: "queued",
        target: "temporary",
        connectionId: null,
        temporaryAccountId: "preview-1",
      },
    );

    expect(driver.prepareResources).not.toHaveBeenCalled();
    expect(driver.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "temporary",
        credential: expect.objectContaining({
          target: "temporary",
          temporaryAccountId: "preview-1",
        }),
        resources: { receipts: [] },
      }),
    );
    expect(controlPlane.completeDeployment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: "temporary_ready" }),
    );
  });

  it("fences a stale runner after its deployment lease is lost", async () => {
    const fixture = await appFixture();
    const artifact = await collectAppBuildArtifact(fixture.workspace, "demo");
    const stagedDir = join(fixture.creatorRoot, "published-apps", "staged-artifacts");
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, `${artifact.artifactDigest}.json`),
      serializeAppArtifact(artifact),
    );
    const queued = deployment({
      phase: "queued",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-1",
      sourceDigest: artifact.sourceDigest,
      artifactKey: `creator-artifact:${artifact.artifactDigest}`,
    });
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-stale" }),
      renewLease: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue({
        ...app("needs_action"),
        targetKind: "byoc",
        cloudflareConnectionId: "connection-1",
      }),
      getDeployment: vi.fn().mockResolvedValue(queued),
      markDeploymentDeploying: vi.fn(),
      completeDeployment: vi.fn(),
      completeOutboxByKey: vi.fn(),
      failOutboxByKey: vi.fn(),
      failDeployment: vi.fn(),
    };
    const accounts = {
      resolveDeploymentCredential: vi.fn().mockResolvedValue({
        target: "byoc",
        accountId: "account-1",
        apiToken: "server-only-token",
        connectionId: "connection-1",
        temporaryAccountId: null,
        expiresAt: null,
      }),
      transitionDeploymentPhase: vi.fn().mockResolvedValue(undefined),
      listDeploymentReceipts: vi.fn().mockResolvedValue([]),
      recordResourceReceipt: vi.fn(),
    };
    const driver = {
      kind: "cloudflare",
      validate: vi.fn().mockResolvedValue(undefined),
      prepareResources: vi.fn().mockResolvedValue({ receipts: [] }),
      deploy: vi.fn(),
    } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await expect(
      coordinator.handleDeploymentTargetQueued(
        { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
        {
          appId: "app-1",
          deploymentId: queued.id,
          appGeneration: 1,
          phase: "queued",
          target: "byoc",
          connectionId: "connection-1",
          temporaryAccountId: null,
        },
      ),
    ).rejects.toThrow(/lease was lost/i);

    expect(accounts.transitionDeploymentPhase).toHaveBeenCalledOnce();
    expect(controlPlane.markDeploymentDeploying).not.toHaveBeenCalled();
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(controlPlane.completeDeployment).not.toHaveBeenCalled();
    expect(controlPlane.failDeployment).not.toHaveBeenCalled();
    expect(controlPlane.completeOutboxByKey).not.toHaveBeenCalled();
    expect(controlPlane.failOutboxByKey).not.toHaveBeenCalled();
    expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "lease-stale");
  });

  it("acknowledges an already-expired deployment without replaying Cloudflare work", async () => {
    const fixture = await appFixture();
    const expired = deployment({
      phase: "expired",
      targetKind: "temporary",
      temporaryPreviewId: "preview-expired",
    });
    const controlPlane = {
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "lease-expired" }),
      releaseLease: vi.fn().mockResolvedValue(true),
      getApp: vi.fn().mockResolvedValue({
        ...app("needs_action"),
        targetKind: "unassigned",
      }),
      getDeployment: vi.fn().mockResolvedValue(expired),
    };
    const { coordinator, driver } = harness(controlPlane, fixture.creatorRoot);

    await expect(
      coordinator.handleDeploymentTargetQueued(
        { tenantId: "tenant-1", userId: "user-1", membershipId: "member-1" },
        {
          appId: "app-1",
          deploymentId: expired.id,
          appGeneration: 1,
          phase: "expired",
          target: "temporary",
          connectionId: null,
          temporaryAccountId: "preview-expired",
        },
      ),
    ).resolves.toBeUndefined();

    expect(driver.validate).not.toHaveBeenCalled();
    expect(driver.deploy).not.toHaveBeenCalled();
    expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "lease-expired");
  });

  it("creates rollback intent without rebuilding or contacting Cloudflare before target choice", async () => {
    const fixture = await appFixture();
    const historical = deployment({
      id: "deployment-old",
      phase: "ready",
      artifactKey: `creator-artifact:${"b".repeat(64)}`,
    });
    const rolledBack = deployment({
      id: "deployment-new",
      rollbackOfDeploymentId: historical.id,
    });
    const getDeployment = vi.fn().mockResolvedValue(historical);
    const rollback = vi.fn().mockResolvedValue({ app: app("building"), deployment: rolledBack });
    const { coordinator, driver } = harness({ getDeployment, rollback }, fixture.creatorRoot);

    const result = await coordinator.handleBroker(
      brokerRequest("app.rollback", {
        appId: "app-1",
        deploymentId: historical.id,
      }),
      brokerContext,
      { ...brokerScope, workspaceDir: fixture.workspace },
    );

    expect(result).toEqual({ app: app("building"), deployment: rolledBack });
    expect(rollback).toHaveBeenCalledOnce();
    expect(driver.rollback).not.toHaveBeenCalled();
  });

  it("rejects a custom domain that was not declared as source intent", async () => {
    const fixture = await appFixture();
    const readyApp = {
      ...app("ready"),
      targetKind: "byoc" as const,
      cloudflareConnectionId: "connection-1",
      currentDeploymentId: "deployment-1",
      stableUrl: "https://piwork-app-app-1.example.workers.dev",
    };
    const getApp = vi.fn().mockResolvedValue(readyApp);
    const getDeployment = vi.fn().mockResolvedValue(
      deployment({
        phase: "ready",
        targetKind: "byoc",
        cloudflareConnectionId: "connection-1",
      }),
    );
    const { coordinator } = harness({ getApp, getDeployment }, fixture.creatorRoot);

    await expect(
      coordinator.setCustomDomain(
        {
          tenantId: "tenant-1",
          userId: "user-1",
          membershipId: "member-1",
          generation: 7,
          rootTask: true,
          readOnly: false,
          mode: "ui",
          explicitIntent: true,
        },
        "app-1",
        {
          connectionId: "connection-1",
          zoneId: "zone-1",
          hostname: "app.example.com",
          confirmImpact: true,
        },
      ),
    ).rejects.toThrow(/piwork\.app\.json intent/i);
  });

  it("does not persist a custom-domain attach result after the provider lease is lost", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await appFixture();
      const readyApp = {
        ...app("ready"),
        targetKind: "byoc" as const,
        cloudflareConnectionId: "connection-1",
        currentDeploymentId: "deployment-1",
        stableUrl: "https://piwork-app-app-1.example.workers.dev",
      };
      const pendingApp = { ...readyApp };
      const controlPlane = {
        getApp: vi.fn().mockResolvedValue(readyApp),
        getDeployment: vi.fn().mockResolvedValue(
          deployment({
            phase: "ready",
            targetKind: "byoc",
            cloudflareConnectionId: "connection-1",
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true, requestedCustomDomain: "app.example.com" },
            },
          }),
        ),
        acquireLease: vi.fn().mockResolvedValue({ leaseToken: "domain-lease" }),
        renewLease: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        releaseLease: vi.fn().mockResolvedValue(true),
        setCustomDomain: vi.fn().mockResolvedValue(pendingApp),
        markCustomDomainState: vi.fn(),
        completeOutboxByKey: vi.fn(),
        failOutboxByKey: vi.fn(),
      };
      const accounts = {
        resolveConnectionCredential: vi.fn().mockResolvedValue({
          target: "byoc",
          accountId: "account-1",
          apiToken: "server-only-token",
          connectionId: "connection-1",
          temporaryAccountId: null,
          expiresAt: null,
        }),
        recordResourceReceipt: vi.fn(),
      };
      const providerResult = {
        providerId: "provider-domain-1",
        hostname: "app.example.com",
        zoneId: "zone-1",
        certificateId: null,
        active: true,
      };
      let providerStarted!: () => void;
      let finishProvider!: (result: typeof providerResult) => void;
      const providerStartedPromise = new Promise<void>((resolve) => {
        providerStarted = resolve;
      });
      const providerPromise = new Promise<typeof providerResult>((resolve) => {
        finishProvider = resolve;
      });
      const setCustomDomain = vi.fn(async () => {
        providerStarted();
        return providerPromise;
      });
      const driver = { kind: "cloudflare", setCustomDomain } as unknown as AppRuntimeDriver;
      const coordinator = new AppsRuntimeCoordinator({
        controlPlane: controlPlane as unknown as AppsControlPlane,
        cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
        driver,
        creatorRoot: fixture.creatorRoot,
        getCurrentUser: () => null,
      });

      const operation = coordinator.setCustomDomain(
        {
          tenantId: "tenant-1",
          userId: "user-1",
          membershipId: "member-1",
          generation: 7,
          rootTask: true,
          readOnly: false,
          mode: "ui",
          idempotencyKey: "domain-idempotency",
          explicitIntent: true,
        },
        "app-1",
        {
          connectionId: "connection-1",
          zoneId: "zone-1",
          hostname: "app.example.com",
          confirmImpact: true,
        },
      );
      await providerStartedPromise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controlPlane.renewLease).toHaveBeenCalledTimes(3);
      finishProvider(providerResult);
      await expect(operation).rejects.toThrow(/domain lease was lost/i);

      expect(setCustomDomain).toHaveBeenCalledOnce();
      expect(accounts.recordResourceReceipt).not.toHaveBeenCalled();
      expect(controlPlane.markCustomDomainState).not.toHaveBeenCalled();
      expect(controlPlane.completeOutboxByKey).not.toHaveBeenCalled();
      expect(controlPlane.failOutboxByKey).not.toHaveBeenCalled();
      expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "domain-lease");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist a custom-domain detach result after the provider lease is lost", async () => {
    const fixture = await appFixture();
    const activeDomain = {
      id: "domain-1",
      appId: "app-1",
      hostname: "app.example.com",
      cloudflareConnectionId: "connection-1",
      zoneId: "zone-1",
      cloudflareHostnameId: "provider-domain-1",
      certificateId: "certificate-1",
      status: "active" as const,
      sslStatus: "active" as const,
      validationRecords: [],
      error: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      activatedAt: "2026-08-04T00:00:00.000Z",
    };
    const readyApp = {
      ...app("ready"),
      targetKind: "byoc" as const,
      cloudflareConnectionId: "connection-1",
      currentDeploymentId: "deployment-1",
      stableUrl: "https://piwork-app-app-1.example.workers.dev",
      customDomain: activeDomain,
    };
    const removingApp = {
      ...readyApp,
      customDomain: { ...activeDomain, status: "removing" as const },
    };
    const controlPlane = {
      getApp: vi.fn().mockResolvedValue(readyApp),
      acquireLease: vi.fn().mockResolvedValue({ leaseToken: "domain-remove-lease" }),
      renewLease: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      releaseLease: vi.fn().mockResolvedValue(true),
      removeCustomDomain: vi.fn().mockResolvedValue(removingApp),
      finishCustomDomainRemoval: vi.fn(),
      completeOutboxByKey: vi.fn(),
      failOutboxByKey: vi.fn(),
    };
    const accounts = {
      resolveConnectionCredential: vi.fn().mockResolvedValue({
        target: "byoc",
        accountId: "account-1",
        apiToken: "server-only-token",
        connectionId: "connection-1",
        temporaryAccountId: null,
        expiresAt: null,
      }),
    };
    const removeCustomDomain = vi.fn().mockResolvedValue(undefined);
    const driver = { kind: "cloudflare", removeCustomDomain } as unknown as AppRuntimeDriver;
    const coordinator = new AppsRuntimeCoordinator({
      controlPlane: controlPlane as unknown as AppsControlPlane,
      cloudflareAccounts: accounts as unknown as AppCloudflareAccountService,
      driver,
      creatorRoot: fixture.creatorRoot,
      getCurrentUser: () => null,
    });

    await expect(
      coordinator.removeCustomDomain(
        {
          tenantId: "tenant-1",
          userId: "user-1",
          membershipId: "member-1",
          generation: 7,
          rootTask: true,
          readOnly: false,
          mode: "ui",
          idempotencyKey: "domain-remove-idempotency",
          explicitIntent: true,
        },
        "app-1",
        {
          connectionId: "connection-1",
          zoneId: "zone-1",
          hostname: "app.example.com",
          confirmImpact: true,
        },
      ),
    ).rejects.toThrow(/domain lease was lost/i);

    expect(removeCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({ target: "byoc" }),
      "provider-domain-1",
    );
    expect(controlPlane.finishCustomDomainRemoval).not.toHaveBeenCalled();
    expect(controlPlane.completeOutboxByKey).not.toHaveBeenCalled();
    expect(controlPlane.failOutboxByKey).not.toHaveBeenCalled();
    expect(controlPlane.releaseLease).toHaveBeenCalledWith("app-1", "domain-remove-lease");
  });

  it.each(["preview", "ready"] as const)(
    "opens isolated preview metadata for an App in the %s state",
    async (status) => {
      const fixture = await appFixture();
      const getApp = vi.fn().mockResolvedValue({
        ...app(status),
        stableUrl: "https://demo.apps.example.test",
      });
      const { coordinator } = harness({ getApp }, fixture.creatorRoot);

      const result = await coordinator.handleBroker(
        brokerRequest("app.preview", { appId: "app-1" }),
        brokerContext,
        { ...brokerScope, workspaceDir: fixture.workspace },
      );

      expect(result).toEqual({
        appId: "app-1",
        url: "https://demo.apps.example.test",
        fallbackUrl: "https://demo.apps.example.test",
        sandbox: "allow-scripts allow-forms allow-popups allow-downloads",
        ready: true,
      });
    },
  );

  it("brokers archive and restore as Piwork link lifecycle operations", async () => {
    const fixture = await appFixture();
    const archive = vi.fn().mockResolvedValue(app("archived"));
    const restore = vi.fn().mockResolvedValue(app("ready"));
    const { coordinator } = harness({ archive, restore }, fixture.creatorRoot);

    await expect(
      coordinator.handleBroker(
        brokerRequest("app.delete", { appId: "app-1", publishIntent: "user_requested" }),
        brokerContext,
        { ...brokerScope, workspaceDir: fixture.workspace },
      ),
    ).resolves.toEqual({ app: app("archived") });
    await expect(
      coordinator.handleBroker(brokerRequest("app.restore", { appId: "app-1" }), brokerContext, {
        ...brokerScope,
        workspaceDir: fixture.workspace,
      }),
    ).resolves.toEqual({ app: app("ready") });
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ explicitIntent: true }),
      "app-1",
    );
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({ explicitIntent: false }),
      "app-1",
    );
  });

  it("routes read, rollback, preview, and stale broker operations through authority", async () => {
    const fixture = await appFixture();
    const ready = {
      ...app("ready"),
      stableUrl: "https://demo.example.workers.dev",
      currentDeploymentId: "deployment-1",
    } as AppRecord;
    const listApps = vi.fn().mockResolvedValue({ apps: [ready], nextCursor: null });
    const listVersions = vi.fn().mockResolvedValue({ versions: [], nextCursor: null });
    const getDeployment = vi
      .fn()
      .mockResolvedValue(deployment({ artifactKey: "creator-artifact:a" }));
    const rollback = vi.fn().mockResolvedValue({ app: ready, deployment: deployment() });
    const getApp = vi.fn().mockResolvedValue(ready);
    const { coordinator } = harness(
      { listApps, listVersions, getDeployment, rollback, getApp },
      fixture.creatorRoot,
    );

    await expect(
      coordinator.handleBroker(
        brokerRequest("app.list", { scope: "tenant" }),
        brokerContext,
        brokerScope,
      ),
    ).resolves.toEqual({ apps: [ready], nextCursor: null });
    await expect(
      coordinator.handleBroker(
        brokerRequest("app.versions", { appId: "app-1" }),
        brokerContext,
        brokerScope,
      ),
    ).resolves.toEqual({ versions: [], nextCursor: null });
    await expect(
      coordinator.handleBroker(
        brokerRequest("app.rollback", { appId: "app-1", deploymentId: "deployment-1" }),
        brokerContext,
        brokerScope,
      ),
    ).resolves.toEqual({ app: ready, deployment: deployment() });
    await expect(
      coordinator.handleBroker(
        brokerRequest("app.preview", { appId: "app-1" }),
        brokerContext,
        brokerScope,
      ),
    ).resolves.toMatchObject({ appId: "app-1", ready: true, url: ready.stableUrl });
    expect(listApps).toHaveBeenCalledOnce();
    expect(listVersions).toHaveBeenCalledOnce();
    expect(getDeployment).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    await expect(
      coordinator.handleBroker(brokerRequest("app.list", {}), brokerContext, {
        ...brokerScope,
        generation: 8,
      }),
    ).rejects.toThrow("broker authority is stale");
    await expect(
      coordinator.handleBroker(brokerRequest("app.unknown", {}), brokerContext, brokerScope),
    ).rejects.toThrow("Unsupported App broker operation");
  });
});
