export interface TemporaryPreviewAttempt {
  userId: string;
  ipAddress: string;
  appId: string;
}

export interface TemporaryPreviewAbuseGuardOptions {
  now?: () => number;
  maxPerUserOrIpPerHour?: number;
  maxPerUserOrIpPerDay?: number;
  maxActivePerApp?: number;
  maxProofOfWorkConcurrency?: number;
}

export interface TemporaryPreviewLease {
  key: string;
  appKey: string;
  release(): void;
}

export class TemporaryPreviewRateLimitError extends Error {
  readonly code = "temporary_preview_rate_limited";
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = "Temporary preview rate limit exceeded") {
    super(message);
    this.name = "TemporaryPreviewRateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

interface Bucket {
  hourStart: number;
  dayStart: number;
  hourCount: number;
  dayCount: number;
}

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function bucketStart(now: number, duration: number): number {
  return Math.floor(now / duration) * duration;
}

/**
 * In-process guard for the preview admission path. Production deployments can
 * back the same decision with Postgres/Redis; the lease and retry semantics
 * stay identical and never perform unbounded retries against Cloudflare.
 */
export class TemporaryPreviewAbuseGuard {
  private readonly now: () => number;
  private readonly maxPerHour: number;
  private readonly maxPerDay: number;
  private readonly maxActivePerApp: number;
  private readonly maxPow: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly activeApps = new Map<string, number>();
  private activePow = 0;

  constructor(options: TemporaryPreviewAbuseGuardOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxPerHour = options.maxPerUserOrIpPerHour ?? 3;
    this.maxPerDay = options.maxPerUserOrIpPerDay ?? 10;
    this.maxActivePerApp = options.maxActivePerApp ?? 1;
    this.maxPow = options.maxProofOfWorkConcurrency ?? 2;
    for (const [name, value] of [
      ["maxPerUserOrIpPerHour", this.maxPerHour],
      ["maxPerUserOrIpPerDay", this.maxPerDay],
      ["maxActivePerApp", this.maxActivePerApp],
      ["maxProofOfWorkConcurrency", this.maxPow],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
    }
  }

  private consume(key: string, now: number): void {
    const current = this.buckets.get(key);
    const hourStart = bucketStart(now, HOUR);
    const dayStart = bucketStart(now, DAY);
    const bucket: Bucket =
      current && current.hourStart === hourStart && current.dayStart === dayStart
        ? current
        : {
            hourStart,
            dayStart,
            hourCount: current?.hourStart === hourStart ? current.hourCount : 0,
            dayCount: current?.dayStart === dayStart ? current.dayCount : 0,
          };
    if (bucket.hourCount >= this.maxPerHour) {
      throw new TemporaryPreviewRateLimitError((hourStart + HOUR - now) / 1_000);
    }
    if (bucket.dayCount >= this.maxPerDay) {
      throw new TemporaryPreviewRateLimitError((dayStart + DAY - now) / 1_000);
    }
    bucket.hourCount += 1;
    bucket.dayCount += 1;
    this.buckets.set(key, bucket);
  }

  acquire(attempt: TemporaryPreviewAttempt): TemporaryPreviewLease {
    const userId = required(attempt.userId, "userId");
    const ipAddress = required(attempt.ipAddress, "ipAddress");
    const appId = required(attempt.appId, "appId");
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("now is invalid");
    // Count both identities independently. This prevents rotating IPs around
    // the per-user limit and prevents anonymous bursts from one address.
    this.consume(`user:${userId}`, now);
    try {
      this.consume(`ip:${ipAddress}`, now);
    } catch (error) {
      // Do not charge the user bucket if the IP bucket rejected the attempt.
      const bucket = this.buckets.get(`user:${userId}`);
      if (bucket) {
        bucket.hourCount = Math.max(0, bucket.hourCount - 1);
        bucket.dayCount = Math.max(0, bucket.dayCount - 1);
      }
      throw error;
    }
    const active = this.activeApps.get(appId) ?? 0;
    if (active >= this.maxActivePerApp) {
      throw new TemporaryPreviewRateLimitError(60, "This App already has an active preview");
    }
    this.activeApps.set(appId, active + 1);
    let released = false;
    return {
      key: `user:${userId}`,
      appKey: appId,
      release: () => {
        if (released) return;
        released = true;
        const count = this.activeApps.get(appId) ?? 0;
        if (count <= 1) this.activeApps.delete(appId);
        else this.activeApps.set(appId, count - 1);
      },
    };
  }

  beginProofOfWork(): () => void {
    if (this.activePow >= this.maxPow) throw new TemporaryPreviewRateLimitError(1);
    this.activePow += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activePow = Math.max(0, this.activePow - 1);
    };
  }

  snapshot(): { activeProofOfWork: number; activeApps: number } {
    return {
      activeProofOfWork: this.activePow,
      activeApps: [...this.activeApps.values()].reduce((total, value) => total + value, 0),
    };
  }
}

export function shouldRequireTurnstile(options: {
  isLoopback: boolean;
  enabled: boolean;
}): boolean {
  return options.enabled && !options.isLoopback;
}
