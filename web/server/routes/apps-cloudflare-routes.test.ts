import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth-types.js";
import { TemporaryPreviewRateLimitError } from "../apps-cloudflare-abuse.js";
import {
  AppCloudflareNeedsOAuthError,
  type AppCloudflareAccountService,
} from "../apps-cloudflare-account-service.js";
import { registerAppsCloudflareRoutes } from "./apps-cloudflare-routes.js";

const user: AuthenticatedUser = {
  userId: "user-1",
  uuid: "user-1",
  username: "user",
  displayName: "User",
  orgId: "tenant-1",
  orgName: "Tenant",
  tenantId: "tenant-1",
  membershipId: "member-1",
  roles: [],
};

function fixture(
  getCurrentUser: () => AuthenticatedUser | null = () => user,
  flags: {
    temporary: boolean;
    byoc: boolean;
    turnstile?: boolean;
    siteKey?: string;
  } = { temporary: true, byoc: true },
) {
  const service = {
    listConnections: vi.fn().mockResolvedValue([]),
    listTemporaryAccounts: vi.fn().mockResolvedValue([]),
    provisionTemporaryAccount: vi.fn().mockResolvedValue({
      id: "preview-1",
      accountId: "account-1",
      claimAvailable: true,
    }),
    releaseUnassignedTemporaryAccount: vi.fn().mockResolvedValue(true),
    getTemporaryClaimUrl: vi.fn().mockResolvedValue({
      claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=bearer-secret",
      expiresAt: "2026-08-04T09:00:00.000Z",
    }),
    getDeploymentClaimUrl: vi.fn().mockResolvedValue({
      claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=bearer-secret",
      expiresAt: "2026-08-04T09:00:00.000Z",
    }),
    startOAuth: vi.fn().mockResolvedValue({
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth?state=state",
      expiresAt: "2026-08-04T08:10:00.000Z",
    }),
    finishOAuth: vi.fn().mockResolvedValue({
      connection: { id: "connection-1" },
      returnPath: "/apps?view=mine",
    }),
    refreshConnection: vi.fn().mockResolvedValue({ id: "connection-1" }),
    revokeConnection: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({ id: "connection-1" }),
    listConnectionZones: vi.fn().mockResolvedValue([]),
    getDeployment: vi.fn().mockResolvedValue({
      id: "deployment-1",
      appId: "app-1",
      version: 1,
      phase: "awaiting_target",
      targetKind: "unassigned",
      sourceDigest: "a".repeat(64),
      temporaryPreview: null,
    }),
    listDeploymentEvents: vi.fn().mockResolvedValue([
      {
        id: "event-1",
        deploymentId: "deployment-1",
        phase: "awaiting_target",
        timestamp: "2026-08-04T08:00:00.000Z",
        code: null,
      },
    ]),
    getAppTarget: vi.fn().mockResolvedValue({ appId: "app-1", target: "unassigned" }),
    selectDeploymentTarget: vi.fn().mockResolvedValue({
      appId: "app-1",
      deploymentId: "deployment-1",
      appGeneration: 3,
      phase: "queued",
      target: "temporary",
      connectionId: null,
      temporaryAccountId: "preview-1",
    }),
  };
  const onDeploymentTargetQueued = vi.fn().mockResolvedValue(undefined);
  const api = new Hono();
  registerAppsCloudflareRoutes(api, {
    service: service as unknown as AppCloudflareAccountService,
    getCurrentUser,
    onDeploymentTargetQueued,
    temporaryEnabled: () => flags.temporary,
    byocEnabled: () => flags.byoc,
    turnstileEnabled: () => flags.turnstile === true,
    turnstileSiteKey: () => flags.siteKey,
  });
  return { api, service, onDeploymentTargetQueued };
}

describe("Apps Cloudflare account routes", () => {
  it("serves only authenticated browser-safe Cloudflare feature configuration", async () => {
    const { api } = fixture(() => user, {
      temporary: true,
      byoc: true,
      turnstile: true,
      siteKey: "public-site-key",
    });
    const response = await api.request("/cloudflare/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      temporaryEnabled: true,
      byocEnabled: true,
      turnstileEnabled: true,
      siteKey: "public-site-key",
    });

    const unauthenticated = fixture(() => null).api;
    expect((await unauthenticated.request("/cloudflare/config")).status).toBe(401);
  });

  it("fails closed when Turnstile is enabled without a public site key", async () => {
    const { api } = fixture(() => user, {
      temporary: true,
      byoc: true,
      turnstile: true,
    });
    const response = await api.request("/cloudflare/config");
    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toMatch(/secret|credential|token/i);
  });

  it("binds OAuth start to an explicit deployment and purpose", async () => {
    const { api, service } = fixture();
    const response = await api.request("/cloudflare/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "direct",
        deploymentId: "deployment-1",
        scope: "user",
        returnPath: "/apps",
      }),
    });
    expect(response.status).toBe(200);
    expect(service.startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      {
        purpose: "direct",
        deploymentId: "deployment-1",
        scope: "user",
        temporaryAccountId: undefined,
        returnPath: "/apps",
      },
    );

    const missingPurpose = await api.request("/cloudflare/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deploymentId: "deployment-1" }),
    });
    expect(missingPurpose.status).toBe(400);
    expect(service.startOAuth).toHaveBeenCalledTimes(1);
  });

  it("requires explicit acceptance values before provisioning", async () => {
    const { api, service } = fixture();
    const response = await api.request("/apps/cloudflare/temporary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deploymentId: "deployment-1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: false,
        turnstileToken: undefined,
      }),
    });
    expect(response.status).toBe(201);
    expect(service.provisionTemporaryAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        membershipId: "member-1",
      }),
      {
        deploymentId: "deployment-1",
        ipAddress: "unknown",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: false,
      },
    );
  });

  it("returns the Temporary Preview retry window as 429 Retry-After", async () => {
    const { api, service } = fixture();
    vi.mocked(service.provisionTemporaryAccount).mockRejectedValueOnce(
      new TemporaryPreviewRateLimitError(37),
    );
    const response = await api.request("/apps/cloudflare/temporary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deploymentId: "deployment-1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    await expect(response.json()).resolves.toEqual({
      error: "Temporary preview rate limit exceeded",
      code: "temporary_preview_rate_limited",
    });
  });

  it("delivers an owner-authorized claim bearer only as a no-store redirect", async () => {
    const { api, service } = fixture();
    const response = await api.request("/apps/deployments/deployment-1/claim");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://dash.cloudflare.com/claim-preview?claimToken=bearer-secret",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).not.toContain("bearer-secret");
    expect(service.getDeploymentClaimUrl).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", membershipId: "member-1" }),
      "deployment-1",
    );
  });

  it("queues an explicit deployment target and hands server context to the coordinator", async () => {
    const { api, service, onDeploymentTargetQueued } = fixture();
    const response = await api.request("/apps/deployments/deployment-1/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "temporary",
        termsAcceptance: {
          acceptedTermsOfService: true,
          acceptedPrivacyPolicy: true,
        },
      }),
    });
    expect(response.status).toBe(202);
    expect(service.provisionTemporaryAccount).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      expect.objectContaining({ deploymentId: "deployment-1" }),
    );
    expect(service.selectDeploymentTarget).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", userId: "user-1" }),
      "deployment-1",
      { target: "temporary", temporaryAccountId: "preview-1" },
    );
    expect(onDeploymentTargetQueued).toHaveBeenCalledWith(
      expect.objectContaining({ membershipId: "member-1" }),
      expect.objectContaining({ deploymentId: "deployment-1", appGeneration: 3 }),
    );
  });

  it("safely releases a newly provisioned preview when target selection loses a race", async () => {
    const { api, service } = fixture();
    vi.mocked(service.selectDeploymentTarget).mockRejectedValueOnce(
      new Error("App deployment target has already been selected."),
    );
    const response = await api.request("/apps/deployments/deployment-1/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "temporary",
        termsAcceptance: {
          acceptedTermsOfService: true,
          acceptedPrivacyPolicy: true,
        },
      }),
    });
    expect(response.status).toBe(409);
    expect(service.releaseUnassignedTemporaryAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", membershipId: "member-1" }),
      "deployment-1",
      "preview-1",
    );
  });

  it("returns browser-safe incremental OAuth requirements for an insufficient BYOC grant", async () => {
    const { api, service } = fixture();
    vi.mocked(service.selectDeploymentTarget).mockRejectedValueOnce(
      new AppCloudflareNeedsOAuthError(["Workers Scripts Write", "D1 Write"]),
    );
    const response = await api.request("/apps/deployments/deployment-1/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "byoc", connectionId: "connection-1" }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Cloudflare account needs additional OAuth permissions.",
      code: "needs_oauth",
      requiredPermissionNames: ["Workers Scripts Write", "D1 Write"],
    });
  });

  it("finishes OAuth with one session-bound state and redirects to a same-origin path", async () => {
    const { api, service } = fixture();
    const response = await api.request(
      "/cloudflare/oauth/callback?state=opaque-state&code=authorization-code",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/apps?view=mine&cloudflare=connected");
    expect(service.finishOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { state: "opaque-state", code: "authorization-code" },
    );
  });

  it("serves browser-safe zones from the final BYOC connection route", async () => {
    const { api, service } = fixture();
    vi.mocked(service.listConnectionZones).mockResolvedValue([
      { id: "zone-1", name: "example.com", status: "active" },
    ]);
    const response = await api.request("/cloudflare/connections/connection-1/zones");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      zones: [{ id: "zone-1", name: "example.com", status: "active" }],
    });
    expect(service.listConnectionZones).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1" }),
      "connection-1",
    );
  });

  it("serves deployment detail and phase events without receipt or credential fields", async () => {
    const { api } = fixture();
    const detail = await api.request("/apps/deployments/deployment-1");
    const events = await api.request("/apps/deployments/deployment-1/events");
    expect(detail.status).toBe(200);
    expect(events.status).toBe(200);
    const serialized = JSON.stringify([await detail.json(), await events.json()]);
    expect(serialized).not.toMatch(/apiToken|credential|receipt|claimUrl|secret/i);
  });

  it("fails closed without an authenticated tenant membership", async () => {
    const { api } = fixture(() => null);
    const response = await api.request("/apps/cloudflare/connections");
    expect(response.status).toBe(401);
  });

  it("fails closed at the route boundary when Cloudflare publishing gates are disabled", async () => {
    const { api, service } = fixture(() => user, { temporary: false, byoc: false });
    const temporary = await api.request("/apps/deployments/deployment-1/target", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "temporary",
        termsAcceptance: {
          acceptedTermsOfService: true,
          acceptedPrivacyPolicy: true,
        },
      }),
    });
    const connections = await api.request("/cloudflare/connections");
    expect(temporary.status).toBe(503);
    expect(connections.status).toBe(503);
    expect(service.provisionTemporaryAccount).not.toHaveBeenCalled();
    expect(service.listConnections).not.toHaveBeenCalled();
  });
});
