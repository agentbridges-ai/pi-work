import { join } from "node:path";
import { PIWORK_HOME } from "./paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { withDiskReservationSync, type UserDiskQuota } from "./user-disk-quota.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(PIWORK_HOME, "session-names.json");
export const MAX_SESSION_NAME_BYTES = 256;

export class SessionNameTooLongError extends Error {
  readonly status = 400;

  constructor(readonly actualBytes: number) {
    super(`Session name exceeds the ${MAX_SESSION_NAME_BYTES}-byte UTF-8 limit`);
    this.name = "SessionNameTooLongError";
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class SessionNameStore {
  private names: Record<string, string> = {};
  private loaded = false;
  private readonly store: AtomicJsonStore<Record<string, string>>;

  constructor(
    filePath = DEFAULT_PATH,
    private readonly diskQuota?: UserDiskQuota,
  ) {
    this.store = new AtomicJsonStore(filePath, {
      schemaVersion: 1,
      normalize: normalizeNames,
      defaultValue: () => ({}),
    });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.names = this.store.readValue() ?? {};
    this.loaded = true;
  }

  private persist(names: Record<string, string>): void {
    const prepared = this.store.prepareWrite(names);
    withDiskReservationSync(this.diskQuota, prepared.reservationBytes, () => prepared.commit());
    this.names = names;
  }

  getName(sessionId: string): string | undefined {
    this.ensureLoaded();
    return this.names[sessionId];
  }

  setName(sessionId: string, name: string): void {
    this.ensureLoaded();
    const nameBytes = Buffer.byteLength(name, "utf-8");
    if (nameBytes > MAX_SESSION_NAME_BYTES) throw new SessionNameTooLongError(nameBytes);
    this.persist({ ...this.names, [sessionId]: name });
  }

  getAllNames(): Record<string, string> {
    this.ensureLoaded();
    return { ...this.names };
  }

  removeName(sessionId: string): void {
    this.ensureLoaded();
    if (!Object.prototype.hasOwnProperty.call(this.names, sessionId)) return;
    const names = { ...this.names };
    delete names[sessionId];
    // Do not grow a legacy backup while deleting non-authoritative metadata.
    // The normal reservation still enforces the hard physical peak limit.
    const prepared = this.store.prepareWrite(names, { backupLegacy: false });
    withDiskReservationSync(this.diskQuota, prepared.reservationBytes, () => prepared.commit());
    this.names = names;
  }

  /**
   * Reconciles after authoritative session data has been removed, then attempts
   * the non-authoritative name cleanup without ever exceeding the hard quota.
   * A remaining 507 leaves a harmless stale label for later reconciliation.
   */
  async removeNameAfterSpaceRelease(sessionId: string): Promise<boolean> {
    if (this.diskQuota) await this.diskQuota.reconcile();
    try {
      this.removeName(sessionId);
      return true;
    } catch (error) {
      if ((error as { status?: unknown })?.status === 507) return false;
      throw error;
    }
  }
}

function normalizeNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const names: Record<string, string> = {};
  for (const [sessionId, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === "string" && name.trim()) names[sessionId] = name;
  }
  return names;
}

let defaultStore = new SessionNameStore(DEFAULT_PATH);

// ─── Public API ─────────────────────────────────────────────────────────────

export function getName(sessionId: string): string | undefined {
  return defaultStore.getName(sessionId);
}

export function isPlaceholderName(name: string | undefined): boolean {
  const normalized = name?.trim();
  return !normalized;
}

export function setName(sessionId: string, name: string): void {
  defaultStore.setName(sessionId, name);
}

export function getAllNames(): Record<string, string> {
  return defaultStore.getAllNames();
}

export function removeName(sessionId: string): void {
  defaultStore.removeName(sessionId);
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  defaultStore = new SessionNameStore(customPath || DEFAULT_PATH);
}
