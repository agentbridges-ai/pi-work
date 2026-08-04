import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppsControlPlane } from "../apps-control-plane.js";
import type { AuthenticatedUser } from "../auth-types.js";
import { registerAppsRoutes } from "./apps-routes.js";

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

function fixture(getCurrentUser: () => AuthenticatedUser | null = () => user, withRuntime = false) {
  const appRecord = { id: "app-1", slug: "demo", status: "ready" };
  const service = {
    listApps: vi.fn().mockResolvedValue({ apps: [appRecord], nextCursor: null }),
    getApp: vi.fn().mockResolvedValue(appRecord),
    rename: vi.fn().mockResolvedValue(appRecord),
    listVersions: vi.fn().mockResolvedValue({ versions: [], nextCursor: null }),
    rollback: vi.fn().mockResolvedValue({ app: appRecord, deployment: { id: "deploy-2" } }),
    archive: vi.fn().mockResolvedValue({ ...appRecord, status: "archived" }),
    restore: vi.fn().mockResolvedValue({ ...appRecord, status: "ready" }),
    continueDevelopment: vi.fn().mockResolvedValue({
      appId: "app-1",
      sourceSessionId: "session-1",
      sourceSnapshotKey: "snapshot",
      restoreRequired: false,
    }),
  };
  const api = new Hono();
  const runtime = {
    rollback: vi.fn(),
    delete: vi.fn(),
    restore: vi.fn(),
    handleDeploymentTargetQueued: vi.fn(),
    setCustomDomain: vi.fn().mockResolvedValue({
      ...appRecord,
      customDomain: { hostname: "app.example.com", status: "active" },
    }),
    removeCustomDomain: vi.fn().mockResolvedValue({ ...appRecord, customDomain: null }),
  };
  registerAppsRoutes(api, {
    service: service as unknown as AppsControlPlane,
    ...(withRuntime ? { runtime: runtime as never } : {}),
    getCurrentUser,
  });
  return { api, service, runtime };
}

describe("Apps browser API", () => {
  it("binds list scope and session to the request tenant context", async () => {
    const { api, service } = fixture();
    const response = await api.request(
      "/apps?scope=current-session&sessionId=session-1&cursor=next",
      { headers: { "x-piwork-context-generation": "9" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apps: [{ id: "app-1", slug: "demo", status: "ready" }],
      nextCursor: null,
    });
    expect(service.listApps).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        membershipId: "member-1",
        generation: 9,
        mode: "ui",
      }),
      expect.objectContaining({ scope: "current-session", sessionId: "session-1", cursor: "next" }),
    );
  });

  it("exposes detail and versions without registering a logs endpoint", async () => {
    const { api } = fixture();
    const detail = await api.request("/apps/app-1");
    const versions = await api.request("/apps/app-1/versions");
    const logs = await api.request("/apps/app-1/logs");

    expect(await detail.json()).toEqual({
      app: { id: "app-1", slug: "demo", status: "ready" },
    });
    expect(await versions.json()).toEqual({ versions: [], nextCursor: null });
    expect(logs.status).toBe(404);
  });

  it("routes rollback, archive and restore with explicit UI intent", async () => {
    const { api, service } = fixture();
    const rollback = await api.request("/apps/app-1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rollback-1" },
      body: JSON.stringify({ deploymentId: "deploy-1" }),
    });
    const deleted = await api.request("/apps/app-1", { method: "DELETE" });
    const restored = await api.request("/apps/app-1/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "restore-1" }),
    });

    expect(rollback.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(restored.status).toBe(200);
    expect(service.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ explicitIntent: true, idempotencyKey: "rollback-1" }),
      "app-1",
      "deploy-1",
    );
    expect(service.archive).toHaveBeenCalledWith(
      expect.objectContaining({ explicitIntent: true }),
      "app-1",
    );
    expect(service.restore).toHaveBeenCalledWith(
      expect.objectContaining({ explicitIntent: true, idempotencyKey: "restore-1" }),
      "app-1",
    );
  });

  it("does not register the removed visibility endpoint", async () => {
    const { api } = fixture();
    const response = await api.request("/apps/app-1/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(response.status).toBe(404);
  });

  it("routes exact Worker Domain attach and detach requests through the trusted runtime", async () => {
    const { api, runtime } = fixture(() => user, true);
    const input = {
      connectionId: "connection-1",
      zoneId: "zone-1",
      hostname: "app.example.com",
      confirmImpact: true,
      idempotencyKey: "domain-1",
    };
    const attached = await api.request("/apps/app-1/domains", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const detached = await api.request("/apps/app-1/domains", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, idempotencyKey: "domain-remove-1" }),
    });

    expect(attached.status).toBe(200);
    expect(detached.status).toBe(200);
    expect(runtime.setCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        explicitIntent: true,
        idempotencyKey: "domain-1",
        tenantId: "tenant-1",
        membershipId: "member-1",
      }),
      "app-1",
      {
        connectionId: "connection-1",
        zoneId: "zone-1",
        hostname: "app.example.com",
        confirmImpact: true,
      },
    );
    expect(runtime.removeCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "domain-remove-1" }),
      "app-1",
      {
        connectionId: "connection-1",
        zoneId: "zone-1",
        hostname: "app.example.com",
        confirmImpact: true,
      },
    );
  });

  it("requires explicit Worker Domain impact confirmation", async () => {
    const { api, runtime } = fixture(() => user, true);
    const response = await api.request("/apps/app-1/domains", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "connection-1",
        zoneId: "zone-1",
        hostname: "app.example.com",
      }),
    });
    expect(response.status).toBe(400);
    expect(runtime.setCustomDomain).not.toHaveBeenCalled();
  });

  it("keeps continue-development owner authorization in the control-plane service", async () => {
    const { api, service } = fixture();
    const response = await api.request("/apps/app-1/continue-development", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: "session-1",
      restoredFromSnapshot: false,
    });
    expect(service.continueDevelopment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", tenantId: "tenant-1" }),
      "app-1",
    );
  });

  it("rejects Apps API calls without an authenticated tenant membership", async () => {
    const { api } = fixture(() => null);
    const response = await api.request("/apps");
    expect(response.status).toBe(401);
  });
});
