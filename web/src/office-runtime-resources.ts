import {
  createOfficeRuntimeResourceManager,
  type OfficeRuntimeResourceManager,
  type OfficeRuntimeResourceSnapshot,
} from "@agentbridges-ai/onlyoffice-browser";
import { resolvePiworkOnlyOfficeAssetBaseUrl } from "./onlyoffice-host-url.js";

export type OfficeResourceErrorCode =
  "initialization-failed" | "insufficient-storage" | "operation-failed";

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
const settingsRequestListeners = new Set<Listener>();

function publish(next: PiworkOfficeResourceSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function publishManagerSnapshot(resources: OfficeRuntimeResourceSnapshot): void {
  publish({
    status: resources.error ? "error" : "ready",
    resources,
    error: resources.error ? { code: "operation-failed" } : null,
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
  initializePromise = createOfficeRuntimeResourceManager({
    assetBaseUrl: resolvePiworkOnlyOfficeAssetBaseUrl(),
  })
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
      publish({ ...snapshot, status: "error", error: { code: "operation-failed" } });
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

export async function checkAndRepairOfficeResources(): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  try {
    await resourceManager.checkHealth();
  } catch (error) {
    publish({ ...snapshot, status: "error", error: { code: "operation-failed" } });
    throw error;
  }
}

export function downloadOfficeFontFamily(id: string): Promise<void> {
  return runOperation(
    (resourceManager) => resourceManager.downloadFontFamily(id),
    (resourceManager) =>
      resourceManager.getSnapshot().fonts.find((font) => font.id === id)?.bytes ?? 0,
  );
}

export async function uninstallOfficeFontFamily(id: string): Promise<void> {
  const resourceManager = await ensureOfficeResources();
  try {
    await resourceManager.uninstallFontFamily(id);
  } catch (error) {
    publish({ ...snapshot, status: "error", error: { code: "operation-failed" } });
    throw error;
  }
}

export function officeResourcesNeedAttention(): boolean {
  const current = snapshot.resources?.progress;
  return snapshot.status === "error" || Boolean(current && current.phase !== "complete");
}

export function requestOfficeResourceSettings(): void {
  for (const listener of settingsRequestListeners) listener();
}

export function subscribeOfficeResourceSettingsRequests(listener: Listener): () => void {
  settingsRequestListeners.add(listener);
  return () => settingsRequestListeners.delete(listener);
}

export function resetOfficeResourcesForTests(): void {
  unsubscribeManager?.();
  unsubscribeManager = null;
  manager = null;
  initializePromise = null;
  snapshot = { status: "idle", resources: null, error: null };
  listeners.clear();
  settingsRequestListeners.clear();
}
