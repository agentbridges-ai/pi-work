import type { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import type { RbacService } from "../rbac-service.js";

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  );
}

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function registerRbacRoutes(
  api: Hono,
  deps: {
    rbac: RbacService;
    getCurrentUser: () => AuthenticatedUser | null;
  },
): void {
  api.use("/rbac/*", async (c, next) => {
    try {
      const user = deps.getCurrentUser();
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const ok = await deps.rbac.requireAdmin(user, new URL(c.req.url).pathname);
      if (!ok) return c.json({ error: "Forbidden" }, 403);
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : /forbidden/i.test(message) ? 403 : 400;
      return jsonError(message, status);
    }
  });

  api.get("/rbac/bootstrap", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json(await deps.rbac.getBootstrap(user));
  });

  api.get("/rbac/users", async (c) => {
    const url = new URL(c.req.url);
    return c.json(
      await deps.rbac.listUsers({
        cursor: numberParam(url.searchParams.get("cursor"), 0),
        limit: numberParam(url.searchParams.get("limit"), 25),
        departmentId: stringValue(url.searchParams.get("departmentId")),
        query: stringValue(url.searchParams.get("query")),
      }),
    );
  });

  api.post("/rbac/users", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const displayName = stringValue((body as { displayName?: unknown }).displayName);
    const email = stringValue((body as { email?: unknown }).email);
    const password = stringValue((body as { password?: unknown }).password);
    if (!displayName || !email || !password) {
      return c.json({ error: "displayName, email and password are required" }, 400);
    }
    const created = await deps.rbac.createUser(user, {
      displayName,
      email,
      password,
      departmentIds: stringArray((body as { departmentIds?: unknown }).departmentIds),
      roleIds: stringArray((body as { roleIds?: unknown }).roleIds),
    });
    return c.json({ user: created });
  });

  api.post("/rbac/departments", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const name = stringValue((body as { name?: unknown }).name);
    if (!name) return c.json({ error: "name is required" }, 400);
    const parentId = stringValue((body as { parentId?: unknown }).parentId) || undefined;
    const sortOrder = Number((body as { sortOrder?: unknown }).sortOrder);
    const department = await deps.rbac.createDepartment(user, {
      name,
      parentId,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
    });
    return c.json({ department });
  });

  api.patch("/rbac/departments/:id", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const patch: { name?: string; parentId?: string | null; sortOrder?: number } = {};
    if (Object.prototype.hasOwnProperty.call(body, "name"))
      patch.name = stringValue((body as { name?: unknown }).name);
    if (Object.prototype.hasOwnProperty.call(body, "parentId")) {
      const parentId = stringValue((body as { parentId?: unknown }).parentId);
      patch.parentId = parentId || null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "sortOrder")) {
      const sortOrder = Number((body as { sortOrder?: unknown }).sortOrder);
      if (Number.isFinite(sortOrder)) patch.sortOrder = sortOrder;
    }
    const department = await deps.rbac.updateDepartment(user, c.req.param("id"), patch);
    return c.json({ department });
  });

  api.delete("/rbac/departments/:id", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    await deps.rbac.deleteDepartment(user, c.req.param("id"));
    return c.json({ ok: true });
  });

  api.put("/rbac/departments/:id/roles", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    await deps.rbac.replaceDepartmentRoles(
      user,
      c.req.param("id"),
      stringArray((body as { roleIds?: unknown }).roleIds),
    );
    return c.json({ ok: true });
  });

  api.post("/rbac/roles", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const name = stringValue((body as { name?: unknown }).name);
    if (!name) return c.json({ error: "name is required" }, 400);
    const role = await deps.rbac.createRole(user, {
      name,
      description: stringValue((body as { description?: unknown }).description),
    });
    return c.json({ role });
  });

  api.patch("/rbac/roles/:id", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const role = await deps.rbac.updateRole(user, c.req.param("id"), {
      name: Object.prototype.hasOwnProperty.call(body, "name")
        ? stringValue((body as { name?: unknown }).name)
        : undefined,
      description: Object.prototype.hasOwnProperty.call(body, "description")
        ? stringValue((body as { description?: unknown }).description)
        : undefined,
    });
    return c.json({ role });
  });

  api.delete("/rbac/roles/:id", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    await deps.rbac.deleteRole(user, c.req.param("id"));
    return c.json({ ok: true });
  });

  api.put("/rbac/roles/:id/permissions", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const role = await deps.rbac.replaceRolePermissions(
      user,
      c.req.param("id"),
      stringArray((body as { permissionKeys?: unknown }).permissionKeys),
    );
    return c.json({ role });
  });

  api.put("/rbac/users/:userId/departments", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    await deps.rbac.replaceUserDepartments(
      user,
      c.req.param("userId"),
      stringArray((body as { departmentIds?: unknown }).departmentIds),
    );
    return c.json({ ok: true });
  });

  api.put("/rbac/users/:userId/roles", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    await deps.rbac.replaceUserRoles(
      user,
      c.req.param("userId"),
      stringArray((body as { roleIds?: unknown }).roleIds),
    );
    return c.json({ ok: true });
  });

  api.put("/rbac/users/:userId/password", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const newPassword = stringValue((body as { newPassword?: unknown }).newPassword);
    if (!newPassword) return c.json({ error: "newPassword is required" }, 400);
    await deps.rbac.resetUserPassword(user, c.req.param("userId"), newPassword);
    return c.json({ ok: true });
  });

  api.get("/rbac/audit", async (c) => {
    return c.json({ audit: await deps.rbac.listAudit() });
  });

  api.put("/rbac/settings", async (c) => {
    const user = deps.getCurrentUser();
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}));
    const settings = await deps.rbac.updateSystemSettings(user, {
      registrationEnabled:
        typeof (body as { registrationEnabled?: unknown }).registrationEnabled === "boolean"
          ? (body as { registrationEnabled: boolean }).registrationEnabled
          : undefined,
    });
    return c.json({ settings });
  });
}
