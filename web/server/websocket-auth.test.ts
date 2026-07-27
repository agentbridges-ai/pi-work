import { afterEach, describe, expect, it, vi } from "vitest";
import { socketAuthorizationMatches, startPeriodicSocketAuthorization } from "./websocket-auth.js";

describe("WebSocket authorization lease", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a live cookie that now belongs to another user or tenant", () => {
    const binding = { userId: "user-a", tenantId: "tenant-a" };
    expect(
      socketAuthorizationMatches(binding, {
        identityUserId: "user-a",
        activeTenantId: "tenant-a",
        runtimeUserId: "user-a",
        runtimeTenantId: "tenant-a",
        authorityActive: true,
      }),
    ).toBe(true);
    expect(
      socketAuthorizationMatches(binding, {
        identityUserId: "user-b",
        activeTenantId: "tenant-a",
        runtimeUserId: "user-a",
        runtimeTenantId: "tenant-a",
        authorityActive: true,
      }),
    ).toBe(false);
    expect(
      socketAuthorizationMatches(binding, {
        identityUserId: "user-a",
        activeTenantId: "tenant-b",
        runtimeUserId: "user-a",
        runtimeTenantId: "tenant-a",
        authorityActive: true,
      }),
    ).toBe(false);
  });

  it("closes an idle socket within the short TTL after session revocation", async () => {
    vi.useFakeTimers();
    let valid = true;
    const close = vi.fn();
    const timer = startPeriodicSocketAuthorization(async () => valid, close, 5_000);
    valid = false;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(close).toHaveBeenCalledOnce();
    clearInterval(timer);
  });
});
