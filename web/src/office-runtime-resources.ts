import type {
  OfficeDocumentResourceType,
  OfficeFontPreset,
  OfficeRuntimeResourceManager,
  OfficeRuntimeResourceSnapshot,
  RequiredReleaseIdentity,
  ResourceErrorCode,
  ResourcePlan,
} from "@agentbridges-ai/onlyoffice-browser";
import releaseDescriptor from "../../release/onlyoffice-release-manifest.json";
import { resolvePiworkOnlyOfficeAssetBaseUrl } from "./onlyoffice-host-url.js";
import {
  requestOfficeResourceSettings,
  resetOfficeResourceSettingsChannelForTests,
  subscribeOfficeResourceSettingsRequests,
} from "./office-resource-settings-channel.js";

export { requestOfficeResourceSettings, subscribeOfficeResourceSettingsRequests };

export type OfficeResourceErrorCode =
  "initialization-failed" | "insufficient-storage" | ResourceErrorCode;

export type PiworkOfficeResourceSnapshot = {
  status: "idle" | "checking" | "ready" | "error";
  resources: OfficeRuntimeResourceSnapshot | null;
  error: {
    code: OfficeResourceErrorCode;
    availableBytes?: number;
    requiredBytes?: number;
  } | null;
};

type Listener = () => void;

let manager: OfficeRuntimeResourceManager | null = null;
let initializePromise: Promise<OfficeRuntimeResourceManager> | null = null;
let unsubscribeManager: (() => void) | null = null;
let snapshot: PiworkOfficeResourceSnapshot = {
  status: "idle",
  resources: null,
  error: null,
};
const listeners = new Set<Listener>();
const requiredReleaseIdentity: RequiredReleaseIdentity = Object.freeze({
  releaseId: releaseDescriptor.releaseManifest.releaseId,
  manifestSha256: releaseDescriptor.releaseManifest.sha256,
  packageVersion: releaseDescriptor.runtimeIdentity.packageVersion,
  hostBuildId: releaseDescriptor.releaseManifest.hostBuildId,
});

function publish(next: PiworkOfficeResourceSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function hasOfficeResourceInventory(
  resources: OfficeRuntimeResourceSnapshot,
): resources is OfficeRuntimeResourceSnapshot {
  return (
    Array.isArray(resources.packs) &&
    Array.isArray(resources.fonts) &&
    Array.isArray(resources.verifiedFontPaths) &&
    Boolean(resources.progress) &&
    Array.isArray(resources.progress.categories)
  );
}

function publishManagerSnapshot(resources: OfficeRuntimeResourceSnapshot): void {
  if (!hasOfficeResourceInventory(resources)) {
    publish({
      status: "error",
      resources: null,
      error: { code: "initialization-failed" },
    });
    return;
  }
  publish({
    status: resources.error || resources.readiness === "error" ? "error" : "ready",
    resources,
    error: resources.error ? { code: resources.error.code } : null,
  });
}

export function getOfficeResourceSnapshot(): PiworkOfficeResourceSnapshot {
  return snapshot;
}

export function subscribeOfficeResources(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function ensureOfficeResources(): Promise<OfficeRuntimeResourceManager> {
  if (manager) return manager;
  if (initializePromise) return initializePromise;

  publish({ ...snapshot, status: "checking", error: null });
  initializePromise = import("@agentbridges-ai/onlyoffice-browser")
    .then(({ createOfficeRuntimeResourceManager }) =>
      createOfficeRuntimeResourceManager({
        assetBaseUrl: resolvePiworkOnlyOfficeAssetBaseUrl(),
        requiredReleaseIdentity,
      }),
    )
    .then((nextManager) => {
      manager = nextManager;
      unsubscribeManager?.();
      unsubscribeManager = manager.subscribe(publishManagerSnapshot);
      publishManagerSnapshot(manager.getSnapshot());
      return manager;
    })
    .catch((error) => {
      publish({
        status: "error",
        resources: null,
        error: { code: "initialization-failed" },
      });
      throw error;
    })
    .finally(() => {
      initializePromise = null;
    });
  return initializePromise;
}

export function getVerifiedOfficeFontPaths(): string[] {
  return manager?.getVerifiedFontPaths() ?? [];
}

export function getTargetOfficeReleaseId(): string | null {
  const resources = manager?.getSnapshot();
  return resources?.installedRelease ?? null;
}

export function officeResourcesReadyForRelease(releaseId: string): boolean {
  const resources = manager?.getSnapshot();
  return Boolean(
    resources &&
    resources.installedRelease === releaseId &&
    (resources.readiness === "ready" || resources.readiness === "update-available") &&
    resources.phase === "idle" &&
    !resources.error,
  );
}

async function requestPersistentStorage(requiredBytes: number): Promise<void> {
  await navigator.storage?.persist?.();
  const estimate = await navigator.storage?.estimate?.();
  if (
    typeof estimate?.quota !== "number" ||
    typeof estimate.usage !== "number" ||
    estimate.quota - estimate.usage >= requiredBytes
  ) {
    return;
  }
  publish({
    ...snapshot,
    status: "error",
    error: {
      code: "insufficient-storage",
      availableBytes: Math.max(0, estimate.quota - estimate.usage),
      requiredBytes,
    },
  });
  throw new Error("Insufficient browser storage for Office resources");
}

async function runOperation(
  operation: (resourceManager: OfficeRuntimeResourceManager) => Promise<unknown>,
  requiredBytes: (resourceManager: OfficeRuntimeResourceManager) => number,
): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  await requestPersistentStorage(requiredBytes(resourceManager));
  try {
    await operation(resourceManager);
  } catch (error) {
    if (snapshot.error?.code !== "insufficient-storage") {
      const code = resourceManager.getSnapshot().error?.code ?? "network";
      publish({ ...snapshot, status: "error", error: { code } });
    }
    throw error;
  }
}

export function loadAllOfficeResources(): Promise<void> {
  return runOperation(
    (resourceManager) => resourceManager.loadAll(),
    (resourceManager) => resourceManager.remainingBytes(),
  );
}

function officeDocumentResourceType(fileName: string): OfficeDocumentResourceType {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase();
  if (extension === "xlsx" || extension === "xls" || extension === "csv" || extension === "ods") {
    return "cell";
  }
  if (extension === "pptx" || extension === "ppt" || extension === "odp") return "slide";
  return "word";
}

export async function prepareOfficeResourcesForFile(fileName: string): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  const plan = await resourceManager.plan({
    scope: "document",
    documentType: officeDocumentResourceType(fileName),
  });
  await requestPersistentStorage(plan.downloadBytes);
  await resourceManager.apply(plan);
}

export async function planOfficeResourcesForFile(fileName: string): Promise<ResourcePlan> {
  const resourceManager = await ensureOfficeResources();
  return resourceManager.plan({
    scope: "document",
    documentType: officeDocumentResourceType(fileName),
  });
}

export async function applyOfficeResourcePlan(plan: ResourcePlan): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  await requestPersistentStorage(plan.downloadBytes);
  await resourceManager.apply(plan);
}

export function installOfficeFontPreset(preset: OfficeFontPreset): Promise<void> {
  return runOperation(
    (resourceManager) => resourceManager.installFontPreset(preset),
    (resourceManager) => resourceManager.remainingBytes(),
  );
}

export async function checkAndRepairOfficeResources(): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  try {
    await resourceManager.repair({ scope: "installed" });
  } catch (error) {
    const code = resourceManager.getSnapshot().error?.code ?? "network";
    publish({ ...snapshot, status: "error", error: { code } });
    throw error;
  }
}

export function downloadOfficeFontFamily(id: string): Promise<void> {
  return runOperation(
    (resourceManager) => resourceManager.downloadFontFamily(id),
    (resourceManager) =>
      resourceManager.getSnapshot().fonts?.find((font) => font.id === id)?.bytes ?? 0,
  );
}

export async function uninstallOfficeFontFamily(id: string): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  try {
    await resourceManager.uninstallFontFamily(id);
  } catch (error) {
    const code = resourceManager.getSnapshot().error?.code ?? "storage";
    publish({ ...snapshot, status: "error", error: { code } });
    throw error;
  }
}

export function officeResourcesNeedAttention(): boolean {
  const resources = snapshot.resources;
  if (snapshot.status === "error" || resources?.readiness === "error") return true;
  return Boolean(
    resources?.packs?.some((pack) => (pack.id === "core" || pack.id === "fonts") && !pack.ready),
  );
}

export async function pauseOfficeResources(): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  resourceManager.pause();
}

export async function resumeOfficeResources(): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  await resourceManager.resume();
}

export function resetOfficeResourcesForTests(): void {
  unsubscribeManager?.();
  unsubscribeManager = null;
  manager = null;
  initializePromise = null;
  snapshot = { status: "idle", resources: null, error: null };
  listeners.clear();
  resetOfficeResourceSettingsChannelForTests();
}
