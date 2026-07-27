import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth-types.js";
import type { ControlPlaneService } from "../control-plane-service.js";
import { McpSecretService } from "../mcp-secret-service.js";
import { OrgService } from "../org-service.js";
import { ScopedAuthorizationService } from "../scoped-authorization.js";
import type { TenantRuntimeDriver } from "../tenant-runtime-driver.js";
import { registerControlPlaneRoutes } from "./control-plane-routes.js";

const user: AuthenticatedUser = {
  userId: "u1",
  uuid: "u1",
  username: "user",
  displayName: "User",
  orgId: "t1",
  orgName: "Tenant",
  roles: [],
  tenantId: "t1",
  membershipId: "m1",
};

function fixture(
  options: {
    getCurrentUser?: () => AuthenticatedUser | null;
    runtimeDriver?: TenantRuntimeDriver;
  } = {},
) {
  const membership = {
    id: "m1",
    tenantId: "t1",
    tenantName: "Tenant",
    tenantType: "personal",
    userId: "u1",
    status: "active",
    isDefault: true,
  };
  const service = {
    ensurePersonalTenant: vi.fn().mockResolvedValue(membership),
    listMemberships: vi.fn().mockResolvedValue([membership]),
    getActiveMembership: vi.fn().mockResolvedValue(membership),
    switchTenant: vi.fn().mockResolvedValue(membership),
    listAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue({ id: "agent-1" }),
    grantAgent: vi.fn().mockResolvedValue({ id: "grant-1" }),
    registerKnowledgeRoot: vi.fn().mockResolvedValue({ id: "knowledge-1" }),
    createNetworkPolicy: vi.fn().mockResolvedValue({ id: "network-1" }),
    updateOwnedAgentDraft: vi.fn().mockResolvedValue({ id: "agent-1", name: "Updated" }),
    publishOwnedAgent: vi.fn().mockResolvedValue({ id: "version-1" }),
    createTenant: vi.fn(),
    importSkill: vi.fn().mockResolvedValue({ id: "skill-1" }),
    approveSkill: vi.fn().mockResolvedValue({ id: "skill-1", approved: true }),
    resolveSessionAuthority: vi.fn(),
    completeOnboarding: vi.fn().mockResolvedValue({
      tenantId: "t1",
      tenantName: "Tenant",
      tenantType: "personal",
      completed: true,
    }),
  };
  const app = new Hono();
  registerControlPlaneRoutes(app, {
    service: service as unknown as ControlPlaneService,
    runtimeDriver: options.runtimeDriver,
    getCurrentUser: options.getCurrentUser ?? (() => user),
  });
  return { app, service, membership };
}

describe("control-plane routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists memberships and active tenant without exposing credentials", async () => {
    const { app, membership } = fixture();
    const response = await app.request("/tenants");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ memberships: [membership], active: membership });
  });

  it("switches only through the membership service", async () => {
    const { app, service } = fixture();
    const response = await app.request("/tenants/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "t2" }),
    });
    expect(response.status).toBe(200);
    expect(service.switchTenant).toHaveBeenCalledWith("u1", "t2");
  });

  it("resolves Agent lists from the request-bound tenant snapshot", async () => {
    const { app, service } = fixture();
    const response = await app.request("/control-plane/agents");
    expect(response.status).toBe(200);
    expect(service.listAgents).toHaveBeenCalledWith("u1", "t1");
    expect(service.getActiveMembership).not.toHaveBeenCalled();
  });

  it("rejects scoped routes when the request has no tenant membership", async () => {
    const { app } = fixture({
      getCurrentUser: () => ({ ...user, tenantId: undefined, membershipId: undefined }),
    });

    const response = await app.request("/control-plane/org");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Tenant membership not found." });
  });

  it("binds organization reads and mutations to the request tenant", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const list = vi.spyOn(OrgService.prototype, "list").mockResolvedValue([{ id: "org-1" }]);
    const create = vi.spyOn(OrgService.prototype, "create").mockResolvedValue({
      id: organizationId,
      tenantId: "t1",
      parentId: null,
      name: "Engineering",
      sortOrder: 0,
      isRoot: true,
    });
    const remove = vi.spyOn(OrgService.prototype, "remove").mockResolvedValue(undefined);
    const { app } = fixture();

    const listResponse = await app.request("/control-plane/org");
    const createResponse = await app.request("/control-plane/org", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Engineering" }),
    });
    const deleteResponse = await app.request(`/control-plane/org/${organizationId}`, {
      method: "DELETE",
    });

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ nodes: [{ id: "org-1" }] });
    expect(createResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(list).toHaveBeenCalledWith("u1", "t1");
    expect(create).toHaveBeenCalledWith("u1", "t1", { name: "Engineering" });
    expect(remove).toHaveBeenCalledWith("u1", "t1", organizationId);
  });

  it("binds grants, knowledge roots, and network policies to the request tenant", async () => {
    const { app, service } = fixture();

    const grantResponse = await app.request("/control-plane/agents/agent-1/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "role", id: "role-1" }),
    });
    const knowledgeResponse = await app.request("/control-plane/knowledge-roots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Handbook", relativePath: "docs/handbook" }),
    });
    const policyResponse = await app.request("/control-plane/network-policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Default",
        allowedDomains: ["example.com"],
        deniedDomains: [],
      }),
    });

    expect(grantResponse.status).toBe(201);
    expect(knowledgeResponse.status).toBe(201);
    expect(policyResponse.status).toBe(201);
    expect(service.grantAgent).toHaveBeenCalledWith("u1", "t1", "agent-1", {
      kind: "role",
      id: "role-1",
    });
    expect(service.registerKnowledgeRoot).toHaveBeenCalledWith("u1", "t1", {
      name: "Handbook",
      relativePath: "docs/handbook",
    });
    expect(service.createNetworkPolicy).toHaveBeenCalledWith("u1", "t1", {
      name: "Default",
      allowedDomains: ["example.com"],
      deniedDomains: [],
    });
  });

  it("authorizes runtime reads and restarts against the request tenant", async () => {
    const runtimeStatus = {
      tenantId: "t1",
      state: "ready" as const,
      checkedAt: "2026-07-16T00:00:00.000Z",
    };
    const runtimeDriver: TenantRuntimeDriver = {
      provision: vi.fn().mockResolvedValue(runtimeStatus),
      resolveEndpoint: vi.fn().mockResolvedValue(new URL("http://127.0.0.1")),
      status: vi.fn().mockResolvedValue(runtimeStatus),
      restart: vi.fn().mockResolvedValue(runtimeStatus),
      stop: vi.fn().mockResolvedValue(runtimeStatus),
    };
    const requirePermission = vi
      .spyOn(ScopedAuthorizationService.prototype, "require")
      .mockResolvedValue(undefined);
    const { app } = fixture({ runtimeDriver });

    const statusResponse = await app.request("/control-plane/runtime");
    const restartResponse = await app.request("/control-plane/runtime/restart", { method: "POST" });

    expect(statusResponse.status).toBe(200);
    expect(restartResponse.status).toBe(200);
    expect(requirePermission).toHaveBeenNthCalledWith(1, "u1", "runtime:view", {
      tenantId: "t1",
    });
    expect(requirePermission).toHaveBeenNthCalledWith(2, "u1", "runtime:manage", {
      tenantId: "t1",
    });
    expect(runtimeDriver.status).toHaveBeenCalledWith("t1");
    expect(runtimeDriver.restart).toHaveBeenCalledWith("t1");
  });

  it("does not expose a browser-facing runtime token minting endpoint", async () => {
    const { app, service } = fixture();

    const response = await app.request("/control-plane/runtime/launch-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        agentDefinitionId: "agent-1",
      }),
    });

    expect(response.status).toBe(404);
    expect(service.resolveSessionAuthority).not.toHaveBeenCalled();
  });

  it("binds personal MCP secret creation and revocation to the request membership", async () => {
    const secretId = "00000000-0000-4000-8000-000000000003";
    const create = vi.spyOn(McpSecretService.prototype, "create").mockResolvedValue({
      id: secretId,
      tenantId: "t1",
      ownerMembershipId: "m1",
      purpose: "github",
      keyVersion: 1,
    });
    const revoke = vi.spyOn(McpSecretService.prototype, "revoke").mockResolvedValue(undefined);
    const { app } = fixture();

    const createResponse = await app.request("/control-plane/mcp/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal", purpose: "github", plaintext: "secret" }),
    });
    const revokeResponse = await app.request(`/control-plane/mcp/secrets/${secretId}`, {
      method: "DELETE",
    });

    expect(createResponse.status).toBe(201);
    expect(revokeResponse.status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      actorUserId: "u1",
      tenantId: "t1",
      membershipId: "m1",
      purpose: "github",
      plaintext: "secret",
    });
    expect(revoke).toHaveBeenCalledWith("u1", "t1", "m1", secretId);
  });

  it("binds skill and owned-agent lifecycle mutations to the request tenant", async () => {
    const { app, service } = fixture();
    const skillInput = {
      sourceUrl: "https://example.com/skill.git",
      sourceCommit: "abc123",
      files: [{ path: "SKILL.md", content: "# Skill" }],
    };
    const draftInput = { name: "Updated" };

    const importResponse = await app.request("/control-plane/skills/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(skillInput),
    });
    const approveResponse = await app.request("/control-plane/skills/skill-1/approve", {
      method: "POST",
    });
    const draftResponse = await app.request("/control-plane/agents/agent-1/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draftInput),
    });
    const publishResponse = await app.request("/control-plane/agents/agent-1/publish", {
      method: "POST",
    });

    expect(importResponse.status).toBe(201);
    expect(approveResponse.status).toBe(200);
    expect(draftResponse.status).toBe(200);
    expect(publishResponse.status).toBe(200);
    expect(service.importSkill).toHaveBeenCalledWith("u1", "t1", skillInput);
    expect(service.approveSkill).toHaveBeenCalledWith("u1", "t1", "skill-1");
    expect(service.updateOwnedAgentDraft).toHaveBeenCalledWith("u1", "t1", "agent-1", draftInput);
    expect(service.publishOwnedAgent).toHaveBeenCalledWith("u1", "t1", "agent-1");
  });

  it("keeps an in-flight mutation bound to its snapshot while the active tenant switches", async () => {
    const tenantBMembership = {
      id: "m2",
      tenantId: "t2",
      tenantName: "Tenant B",
      tenantType: "team",
      userId: "u1",
      status: "active",
      isDefault: false,
    };
    let activeUser: AuthenticatedUser = { ...user };
    let resolveSnapshotCaptured!: () => void;
    const snapshotCaptured = new Promise<void>((resolve) => {
      resolveSnapshotCaptured = resolve;
    });
    let captured = false;
    const { app, service } = fixture({
      getCurrentUser: () => {
        const snapshot = { ...activeUser };
        if (!captured) {
          captured = true;
          resolveSnapshotCaptured();
        }
        return snapshot;
      },
    });
    let resolveTenantSwitched!: () => void;
    const tenantSwitched = new Promise<void>((resolve) => {
      resolveTenantSwitched = resolve;
    });
    service.getActiveMembership.mockImplementation(async () => {
      await tenantSwitched;
      return tenantBMembership;
    });
    service.switchTenant.mockImplementation(async () => {
      activeUser = {
        ...user,
        orgId: "t2",
        orgName: "Tenant B",
        tenantId: "t2",
        tenantName: "Tenant B",
        tenantType: "team",
        membershipId: "m2",
      };
      resolveTenantSwitched();
      return tenantBMembership;
    });
    service.createAgent.mockImplementation(async () => {
      await tenantSwitched;
      return { id: "agent-1" };
    });

    const createResponsePromise = app.request("/control-plane/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Snapshot Agent" }),
    });
    await snapshotCaptured;
    const switchResponse = await app.request("/tenants/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "t2" }),
    });
    const createResponse = await createResponsePromise;

    expect(switchResponse.status).toBe(200);
    expect(createResponse.status).toBe(201);
    expect(service.createAgent).toHaveBeenCalledWith("u1", "t1", {
      name: "Snapshot Agent",
    });
    expect(service.getActiveMembership).not.toHaveBeenCalled();
  });

  it("completes the selected registration type once through the authenticated user", async () => {
    const { app, service } = fixture();
    const response = await app.request("/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "enterprise", workspaceName: "星河科技" }),
    });
    expect(response.status).toBe(200);
    expect(service.completeOnboarding).toHaveBeenCalledWith("u1", "User", {
      type: "enterprise",
      workspaceName: "星河科技",
    });
  });
});
