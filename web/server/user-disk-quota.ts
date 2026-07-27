import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_USER_DISK_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES = 256 * 1024 * 1024;
export const DEFAULT_USER_DISK_MONITOR_INTERVAL_MS = 30_000;
const DEFAULT_USER_DISK_CACHE_TTL_MS = DEFAULT_USER_DISK_MONITOR_INTERVAL_MS * 2;

export interface UserDiskQuotaOptions {
  maxBytes: number;
  reservedHeadroomBytes: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface DiskUsageSnapshot {
  usedBytes: number;
  reservedBytes: number;
  maxBytes: number;
  availableBytes: number;
  scannedAt: number;
}

export interface DiskReservation {
  commit(): void;
  release(): void;
}

export interface DiskQuotaMonitor {
  checkNow(): Promise<DiskUsageSnapshot>;
  stop(): void;
}

/**
 * Reserve the complete peak size before a server-managed write. Once the
 * operation starts, failures are committed conservatively because a low-level
 * write error is not proof that no partial bytes reached disk. The next
 * reconciliation replaces that upper bound with the observed filesystem size.
 */
export async function withDiskReservation<T>(
  diskQuota: UserDiskQuota | undefined,
  bytes: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (!diskQuota) return operation();
  const reservation = diskQuota.reserve(bytes);
  try {
    const result = await operation();
    reservation.commit();
    return result;
  } catch (error) {
    reservation.commit();
    throw error;
  }
}

/** Synchronous counterpart for crash-safe stores whose write path is sync. */
export function withDiskReservationSync<T>(
  diskQuota: UserDiskQuota | undefined,
  bytes: number,
  operation: () => T,
): T {
  if (!diskQuota) return operation();
  const reservation = diskQuota.reserve(bytes);
  try {
    const result = operation();
    reservation.commit();
    return result;
  } catch (error) {
    reservation.commit();
    throw error;
  }
}

export class DiskQuotaExceededError extends Error {
  readonly status = 507;

  constructor(
    readonly usedBytes: number,
    readonly requestedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `User disk quota exceeded (${usedBytes} used + ${requestedBytes} requested > ${maxBytes})`,
    );
    this.name = "DiskQuotaExceededError";
  }
}

/** Admission fails closed until an asynchronous filesystem reconciliation succeeds. */
export class DiskQuotaStateUnavailableError extends Error {
  readonly status = 507;

  constructor(readonly reason: "uninitialized" | "stale") {
    super(
      reason === "uninitialized"
        ? "User disk quota usage is not initialized yet"
        : "User disk quota usage is stale; retry after reconciliation",
    );
    this.name = "DiskQuotaStateUnavailableError";
  }
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function inodeKey(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Application-level disk admission and reconciliation for one Better Auth
 * user. Scans never follow symlinks and hard-linked regular files are counted
 * once across all registered tenant roots.
 *
 * This protects Piwork-managed writes and launch admission. A child process
 * can still write between reconciliations; filesystem/project quotas remain
 * the only OS-level hard limit.
 */
export class UserDiskQuota {
  private readonly roots = new Set<string>();
  private readonly maxBytes: number;
  private readonly reservedHeadroomBytes: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cachedUsage: { bytes: number; scannedAt: number } | null = null;
  private pendingReservationBytes = 0;
  private invalidatedUsageFloorBytes = 0;
  private rootVersion = 0;
  private writeVersion = 0;
  private reconcileInFlight: Promise<DiskUsageSnapshot> | null = null;

  constructor(options: UserDiskQuotaOptions) {
    this.maxBytes = nonNegativeSafeInteger(options.maxBytes, "maxBytes");
    this.reservedHeadroomBytes = nonNegativeSafeInteger(
      options.reservedHeadroomBytes,
      "reservedHeadroomBytes",
    );
    if (this.maxBytes < 1 || this.reservedHeadroomBytes >= this.maxBytes) {
      throw new TypeError("reservedHeadroomBytes must be smaller than maxBytes");
    }
    this.cacheTtlMs = nonNegativeSafeInteger(
      options.cacheTtlMs ?? DEFAULT_USER_DISK_CACHE_TTL_MS,
      "cacheTtlMs",
    );
    this.now = options.now ?? Date.now;
  }

  addRoot(path: string): void {
    const normalized = resolve(path);
    if (this.roots.has(normalized)) return;
    this.roots.add(normalized);
    this.rootVersion += 1;
    this.invalidate();
  }

  removeRoot(path: string): void {
    if (this.roots.delete(resolve(path))) {
      this.rootVersion += 1;
      this.invalidate();
    }
  }

  invalidate(): void {
    if (this.cachedUsage) {
      this.invalidatedUsageFloorBytes = Math.max(
        this.invalidatedUsageFloorBytes,
        this.cachedUsage.bytes,
      );
    }
    this.cachedUsage = null;
  }

  reconcile(): Promise<DiskUsageSnapshot> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    this.reconcileInFlight = this.reconcileFresh().finally(() => {
      this.reconcileInFlight = null;
    });
    return this.reconcileInFlight;
  }

  snapshot(): DiskUsageSnapshot {
    const cached = this.requireCachedUsage();
    return this.snapshotFrom(cached.bytes, cached.scannedAt);
  }

  /** Blocks new managed processes unless the configured safety headroom remains. */
  assertLaunchAllowed(): DiskUsageSnapshot {
    const snapshot = this.snapshot();
    const usableBytes = this.maxBytes - this.reservedHeadroomBytes;
    if (snapshot.usedBytes + snapshot.reservedBytes > usableBytes) {
      throw new DiskQuotaExceededError(
        snapshot.usedBytes + snapshot.reservedBytes,
        this.reservedHeadroomBytes,
        this.maxBytes,
      );
    }
    return snapshot;
  }

  isOverQuota(snapshot = this.snapshot()): boolean {
    return snapshot.usedBytes + snapshot.reservedBytes > snapshot.maxBytes;
  }

  /**
   * Periodically reconciles application-owned roots and reports true quota
   * overruns. This is admission/response control only: child processes can
   * write between scans, so it is not an OS/filesystem hard quota.
   */
  startMonitoring(
    onOverQuota: (snapshot: DiskUsageSnapshot) => void | Promise<void>,
    intervalMs = DEFAULT_USER_DISK_MONITOR_INTERVAL_MS,
  ): DiskQuotaMonitor {
    const checkedIntervalMs = nonNegativeSafeInteger(intervalMs, "intervalMs");
    if (checkedIntervalMs < 1) throw new TypeError("intervalMs must be positive");

    let stopped = false;
    let checkInFlight: Promise<DiskUsageSnapshot> | null = null;
    const checkNow = (): Promise<DiskUsageSnapshot> => {
      if (checkInFlight) return checkInFlight;
      checkInFlight = this.reconcile()
        .then(async (snapshot) => {
          if (!stopped && this.isOverQuota(snapshot)) await onOverQuota(snapshot);
          return snapshot;
        })
        .finally(() => {
          checkInFlight = null;
        });
      return checkInFlight;
    };
    const timer = setInterval(() => {
      void checkNow().catch((error) => {
        console.error("[disk-quota] Application-level quota reconciliation failed", error);
      });
    }, checkedIntervalMs);
    timer.unref?.();

    // Prime admission asynchronously instead of making the first launch or
    // server-managed write recursively walk the user's workspace.
    void checkNow().catch((error) => {
      console.error("[disk-quota] Initial application-level quota reconciliation failed", error);
    });

    return {
      checkNow,
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  /**
   * Reserves peak bytes before a server-managed write. Atomic replacement
   * callers should reserve the full temporary-file size, not only the final
   * logical delta.
   */
  reserve(bytes: number): DiskReservation {
    const requestedBytes = nonNegativeSafeInteger(bytes, "bytes");
    const usage = this.requireCachedUsage();
    const projected = usage.bytes + this.pendingReservationBytes + requestedBytes;
    if (projected > this.maxBytes) {
      throw new DiskQuotaExceededError(
        usage.bytes + this.pendingReservationBytes,
        requestedBytes,
        this.maxBytes,
      );
    }
    this.pendingReservationBytes += requestedBytes;

    let settled = false;
    const settle = (committed: boolean) => {
      if (settled) return;
      settled = true;
      this.pendingReservationBytes = Math.max(0, this.pendingReservationBytes - requestedBytes);
      if (committed) {
        // Account the full peak reservation conservatively until the next
        // asynchronous scan observes the exact filesystem state. Deletions may
        // temporarily over-count, but admission never under-counts this write.
        if (this.cachedUsage) this.cachedUsage.bytes += requestedBytes;
        else this.invalidatedUsageFloorBytes += requestedBytes;
        this.writeVersion += 1;
      }
    };
    return {
      commit: () => settle(true),
      release: () => settle(false),
    };
  }

  private requireCachedUsage(): { bytes: number; scannedAt: number } {
    const cached = this.cachedUsage;
    if (!cached) throw new DiskQuotaStateUnavailableError("uninitialized");
    if (this.now() - cached.scannedAt > this.cacheTtlMs) {
      throw new DiskQuotaStateUnavailableError("stale");
    }
    return cached;
  }

  private snapshotFrom(usedBytes: number, scannedAt: number): DiskUsageSnapshot {
    return {
      usedBytes,
      reservedBytes: this.pendingReservationBytes,
      maxBytes: this.maxBytes,
      availableBytes: Math.max(0, this.maxBytes - usedBytes - this.pendingReservationBytes),
      scannedAt,
    };
  }

  private async reconcileFresh(): Promise<DiskUsageSnapshot> {
    while (true) {
      const rootsVersion = this.rootVersion;
      const writesAtStart = this.writeVersion;
      const roots = [...this.roots];
      const seenFiles = new Set<string>();
      const seenDirectories = new Set<string>();
      let usedBytes = 0;
      for (const root of roots) {
        usedBytes += await this.scanPath(root, seenFiles, seenDirectories);
      }

      // A newly registered root was not part of this walk. Repeat before
      // publishing a cache that synchronous admission is allowed to trust.
      if (rootsVersion !== this.rootVersion) continue;

      const scannedAt = this.now();
      if (writesAtStart !== this.writeVersion && this.cachedUsage) {
        // A reserved application write committed while the scan was walking.
        // The scan may or may not have observed it, so retain the larger
        // conservative value rather than double-counting or under-counting.
        usedBytes = Math.max(usedBytes, this.cachedUsage.bytes);
      }
      if (writesAtStart !== this.writeVersion) {
        usedBytes = Math.max(usedBytes, this.invalidatedUsageFloorBytes);
      }
      this.cachedUsage = { bytes: usedBytes, scannedAt };
      this.invalidatedUsageFloorBytes = 0;
      return this.snapshotFrom(usedBytes, scannedAt);
    }
  }

  private async scanPath(
    path: string,
    seenFiles: Set<string>,
    seenDirectories: Set<string>,
  ): Promise<number> {
    const stat = await this.lstatIfPresent(path);
    if (!stat) return 0;
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) {
      const key = inodeKey(stat);
      if (seenFiles.has(key)) return 0;
      seenFiles.add(key);
      return stat.size;
    }
    if (!stat.isDirectory()) return 0;

    const directoryKey = inodeKey(stat);
    if (seenDirectories.has(directoryKey)) return 0;
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return 0;
      throw error;
    }
    // Revalidate after enumeration. The final component is never followed, and
    // a directory swapped for a symlink/non-directory during the scan is
    // discarded instead of charging or traversing its entries.
    const observed = await this.lstatIfPresent(path);
    if (
      !observed ||
      observed.isSymbolicLink() ||
      !observed.isDirectory() ||
      observed.dev !== stat.dev ||
      observed.ino !== stat.ino
    ) {
      return 0;
    }
    seenDirectories.add(directoryKey);
    let bytes = 0;
    for (const entry of entries) {
      bytes += await this.scanPath(join(path, entry), seenFiles, seenDirectories);
    }
    return bytes;
  }

  private async lstatIfPresent(path: string): Promise<Stats | null> {
    try {
      return await lstat(path);
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private errorCode(error: unknown): string {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  }
}
