import { describe, expect, it } from "vitest";
import {
  shouldRequireTurnstile,
  TemporaryPreviewAbuseGuard,
  TemporaryPreviewRateLimitError,
} from "./apps-cloudflare-abuse.js";

describe("Temporary preview abuse controls", () => {
  it("enforces per-user/ip hourly and daily limits and retry-after", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const guard = new TemporaryPreviewAbuseGuard({
      now: () => now,
      maxPerUserOrIpPerHour: 3,
      maxPerUserOrIpPerDay: 10,
    });
    for (let index = 0; index < 3; index += 1) {
      const lease = guard.acquire({
        userId: "user",
        ipAddress: "127.0.0.1",
        appId: `app-${index}`,
      });
      lease.release();
    }
    expect(() => guard.acquire({ userId: "user", ipAddress: "127.0.0.1", appId: "app-4" })).toThrow(
      TemporaryPreviewRateLimitError,
    );
    now += 60 * 60 * 1_000;
    const lease = guard.acquire({ userId: "user", ipAddress: "127.0.0.1", appId: "app-5" });
    lease.release();
  });

  it("allows only one active preview per App and two proof-of-work workers", () => {
    const guard = new TemporaryPreviewAbuseGuard();
    const first = guard.acquire({ userId: "u", ipAddress: "10.0.0.1", appId: "app" });
    expect(() =>
      guard.acquire({ userId: "u", ipAddress: "10.0.0.1", appId: "app-2" }),
    ).not.toThrow();
    expect(() => guard.acquire({ userId: "u", ipAddress: "10.0.0.1", appId: "app" })).toThrow(
      /active preview/,
    );
    const releaseOne = guard.beginProofOfWork();
    const releaseTwo = guard.beginProofOfWork();
    expect(() => guard.beginProofOfWork()).toThrow(TemporaryPreviewRateLimitError);
    releaseOne();
    releaseTwo();
    first.release();
  });

  it("requires Turnstile only for non-loopback production requests", () => {
    expect(shouldRequireTurnstile({ enabled: true, isLoopback: false })).toBe(true);
    expect(shouldRequireTurnstile({ enabled: true, isLoopback: true })).toBe(false);
    expect(shouldRequireTurnstile({ enabled: false, isLoopback: false })).toBe(false);
  });
});
