import type { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import type { ControlPlaneService } from "../control-plane-service.js";
import { OrgService } from "../org-service.js";
import { McpSecretService } from "../mcp-secret-service.js";
import type { TenantRuntimeDriver } from "../tenant-runtime-driver.js";
import { ScopedAuthorizationService } from "../scoped-authorization.js";

const orgService = new OrgService();
const mcpSecrets = new McpSecretService();
const scopedAuthorization = new ScopedAuthorizationService();

export function registerControlPlaneRoutes(
  api: Hono,
  deps: {
    service: ControlPlaneService;
    runtimeDriver?: TenantRuntimeDriver;
    getCurrentUser: () => AuthenticatedUser | null;
  },
): void {
  const current = () => {
    const user = deps.getCurrentUser();
    if (!user) throw new Error("Unauthorized");
    return user;
  };
  const currentTenant = () => {
    const user = current();
    if (!user.tenantId || !user.membershipId) {
      throw new Error("Tenant membership not found.");
    }
    return {
      user,
      tenantId: user.tenantId,
      membershipId: user.membershipId,
    };
  };
  const error = (c: any, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = /Unauthorized/i.test(message)
      ? 401
      : /Forbidden/i.test(message)
        ? 403
        : /not found|not editable|not publishable/i.test(message)
          ? 404
          : 400;
    return c.json({ error: message }, status);
  };

  api.get("/tenants", async (c) => {
    try {
      const user = current();
      await deps.service.ensurePersonalTenant(user.userId, user.displayName);
      return c.json({
        memberships: await deps.service.listMemberships(user.userId),
        active: await deps.service.getActiveMembership(user.userId),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/onboarding/complete", async (c) => {
    try {
      const user = current();
      const body = await c.req.json().catch(() => ({}));
      if (!["personal", "team", "enterprise"].includes(body.type)) {
        return c.json({ error: "personal, team, or enterprise type is required" }, 400);
      }
      return c.json({
        onboarding: await deps.service.completeOnboarding(user.userId, user.displayName, {
          type: body.type,
          workspaceName: typeof body.workspaceName === "string" ? body.workspaceName : undefined,
        }),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.put("/tenants/active", async (c) => {
    try {
      const user = current();
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.tenantId !== "string") return c.json({ error: "tenantId is required" }, 400);
      return c.json({ active: await deps.service.switchTenant(user.userId, body.tenantId) });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/tenants", async (c) => {
    try {
      const user = current();
      const body = await c.req.json().catch(() => ({}));
      if ((body.type !== "enterprise" && body.type !== "team") || typeof body.name !== "string") {
        return c.json({ error: "name and enterprise/team type are required" }, 400);
      }
      return c.json({
        tenant: await deps.service.createTenant(user.userId, { name: body.name, type: body.type }),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/tenants/:id/members", async (c) => {
    try {
      const user = current();
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.userId !== "string") return c.json({ error: "userId is required" }, 400);
      return c.json(
        {
          membership: await deps.service.addMembership(user.userId, c.req.param("id"), body.userId),
        },
        201,
      );
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.delete("/tenants/:id/members/:userId", async (c) => {
    try {
      const user = current();
      await deps.service.removeMembership(user.userId, c.req.param("id"), c.req.param("userId"));
      return c.json({ ok: true });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.get("/control-plane/org", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      return c.json({ nodes: await orgService.list(user.userId, tenantId) });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/org", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.name !== "string") return c.json({ error: "name is required" }, 400);
      return c.json({ node: await orgService.create(user.userId, tenantId, body) });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.delete("/control-plane/org/:id", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      await orgService.remove(user.userId, tenantId, c.req.param("id"));
      return c.json({ ok: true });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.get("/control-plane/agents", async (c) => {
    try {
      const { user, tenantId, membershipId } = currentTenant();
      const tenant = (await deps.service.listMemberships(user.userId)).find(
        (membership) => membership.id === membershipId && membership.tenantId === tenantId,
      );
      if (!tenant) throw new Error("Tenant membership not found.");
      return c.json({
        agents: await deps.service.listAgents(user.userId, tenantId),
        tenant,
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/agents", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.name !== "string") return c.json({ error: "name is required" }, 400);
      return c.json({ agent: await deps.service.createAgent(user.userId, tenantId, body) }, 201);
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/agents/:id/grants", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (
        !["tenant", "org_subtree", "role", "membership"].includes(body.kind) ||
        typeof body.id !== "string"
      ) {
        return c.json({ error: "valid kind and id are required" }, 400);
      }
      return c.json(
        {
          grant: await deps.service.grantAgent(user.userId, tenantId, c.req.param("id"), body),
        },
        201,
      );
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/knowledge-roots", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.name !== "string" || typeof body.relativePath !== "string")
        return c.json({ error: "name and relativePath are required" }, 400);
      return c.json(
        {
          knowledgeRoot: await deps.service.registerKnowledgeRoot(user.userId, tenantId, body),
        },
        201,
      );
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/network-policies", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (
        typeof body.name !== "string" ||
        !Array.isArray(body.allowedDomains) ||
        !Array.isArray(body.deniedDomains)
      ) {
        return c.json({ error: "name, allowedDomains and deniedDomains are required" }, 400);
      }
      return c.json(
        {
          networkPolicy: await deps.service.createNetworkPolicy(user.userId, tenantId, body),
        },
        201,
      );
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.get("/control-plane/runtime", async (c) => {
    try {
      if (!deps.runtimeDriver) return c.json({ error: "Runtime driver unavailable" }, 501);
      const { user, tenantId } = currentTenant();
      await scopedAuthorization.require(user.userId, "runtime:view", { tenantId });
      return c.json({ runtime: await deps.runtimeDriver.status(tenantId) });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/runtime/restart", async (c) => {
    try {
      if (!deps.runtimeDriver) return c.json({ error: "Runtime driver unavailable" }, 501);
      const { user, tenantId } = currentTenant();
      await scopedAuthorization.require(user.userId, "runtime:manage", { tenantId });
      return c.json({ runtime: await deps.runtimeDriver.restart(tenantId) });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/mcp/secrets", async (c) => {
    try {
      const { user, tenantId, membershipId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (
        typeof body.plaintext !== "string" ||
        !body.plaintext ||
        typeof body.purpose !== "string"
      ) {
        return c.json({ error: "purpose and plaintext are required" }, 400);
      }
      const personal = body.scope === "personal";
      const secret = await mcpSecrets.create({
        actorUserId: user.userId,
        tenantId,
        ...(personal ? { membershipId } : {}),
        purpose: body.purpose,
        plaintext: body.plaintext,
      });
      return c.json({ secret }, 201);
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/skills/import", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      const body = await c.req.json().catch(() => ({}));
      if (
        typeof body.sourceUrl !== "string" ||
        typeof body.sourceCommit !== "string" ||
        !Array.isArray(body.files)
      ) {
        return c.json({ error: "sourceUrl, sourceCommit and files are required" }, 400);
      }
      return c.json({ skill: await deps.service.importSkill(user.userId, tenantId, body) }, 201);
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/skills/:id/approve", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      return c.json({
        skill: await deps.service.approveSkill(user.userId, tenantId, c.req.param("id")),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.delete("/control-plane/mcp/secrets/:id", async (c) => {
    try {
      const { user, tenantId, membershipId } = currentTenant();
      await mcpSecrets.revoke(user.userId, tenantId, membershipId, c.req.param("id"));
      return c.json({ ok: true });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.put("/control-plane/agents/:id/draft", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      return c.json({
        agent: await deps.service.updateOwnedAgentDraft(
          user.userId,
          tenantId,
          c.req.param("id"),
          await c.req.json(),
        ),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
  api.post("/control-plane/agents/:id/publish", async (c) => {
    try {
      const { user, tenantId } = currentTenant();
      return c.json({
        version: await deps.service.publishOwnedAgent(user.userId, tenantId, c.req.param("id")),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });
}
