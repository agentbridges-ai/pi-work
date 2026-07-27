import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import type { RbacService } from "../rbac-service.js";
import { registerRbacRoutes } from "./rbac-routes.js";

const user: AuthenticatedUser = {
  userId: "admin-user",
  uuid: "admin-user",
  username: "admin@example.test",
  displayName: "Admin",
  orgId: "local",
  orgName: "Local",
  roles: ["user"],
};

function createApp(rbac: Partial<RbacService>, current: AuthenticatedUser | null = user) {
  const app = new Hono();
  registerRbacRoutes(app, {
    rbac: rbac as RbacService,
    getCurrentUser: () => current,
  });
  return app;
}

describe("RBAC routes", () => {
  it("blocks non-admin users from RBAC endpoints", async () => {
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(false),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/bootstrap");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(rbac.requireAdmin).toHaveBeenCalledWith(user, "/rbac/bootstrap");
  });

  it("returns bootstrap data for admins", async () => {
    const bootstrap = {
      current: { ...user, permissions: ["admin:access"], departments: [] },
      departments: [],
      roles: [],
      permissions: [],
      users: [],
      audit: [],
      settings: { registrationEnabled: true },
    };
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      getBootstrap: vi.fn().mockResolvedValue(bootstrap),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/bootstrap");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(bootstrap);
    expect(rbac.getBootstrap).toHaveBeenCalledWith(user);
  });

  it("returns paginated users for admins", async () => {
    const page = {
      users: [],
      total: 0,
      cursor: 25,
      limit: 25,
      nextCursor: 25,
      hasMore: false,
    };
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      listUsers: vi.fn().mockResolvedValue(page),
    };
    const app = createApp(rbac);

    const response = await app.request(
      "/rbac/users?departmentId=dept-root&query=ada&cursor=25&limit=25",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(rbac.listUsers).toHaveBeenCalledWith({
      cursor: 25,
      limit: 25,
      departmentId: "dept-root",
      query: "ada",
    });
  });

  it("normalizes role permission replacement payloads", async () => {
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      replaceRolePermissions: vi.fn().mockResolvedValue({
        id: "role-member",
        name: "成员",
        description: "",
        system: false,
        permissionKeys: ["admin:access"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/roles/role-member/permissions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionKeys: ["admin:access", "admin:access", 42, ""] }),
    });

    expect(response.status).toBe(200);
    expect(rbac.replaceRolePermissions).toHaveBeenCalledWith(user, "role-member", ["admin:access"]);
  });

  it("resets a user's password through the RBAC admin route", async () => {
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      resetUserPassword: vi.fn().mockResolvedValue(undefined),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/users/ada/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "new-secure-password" }),
    });

    expect(response.status).toBe(200);
    expect(rbac.resetUserPassword).toHaveBeenCalledWith(user, "ada", "new-secure-password");
  });

  it("creates a user through the RBAC admin route", async () => {
    const created = {
      userId: "grace",
      username: "grace@example.test",
      displayName: "Grace",
      email: "grace@example.test",
      orgId: "local",
      orgName: "Local",
      roleIds: [],
      departmentIds: ["dept-root"],
      primaryDepartmentId: "dept-root",
      permissions: [],
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    };
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      createUser: vi.fn().mockResolvedValue(created),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Grace",
        email: "grace@example.test",
        password: "secure-password",
        departmentIds: ["dept-root"],
        roleIds: ["role-member"],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: created });
    expect(rbac.createUser).toHaveBeenCalledWith(user, {
      displayName: "Grace",
      email: "grace@example.test",
      password: "secure-password",
      departmentIds: ["dept-root"],
      roleIds: ["role-member"],
    });
  });

  it("updates system settings through the RBAC admin route", async () => {
    const rbac = {
      requireAdmin: vi.fn().mockResolvedValue(true),
      updateSystemSettings: vi.fn().mockResolvedValue({ registrationEnabled: false }),
    };
    const app = createApp(rbac);

    const response = await app.request("/rbac/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationEnabled: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: { registrationEnabled: false } });
    expect(rbac.updateSystemSettings).toHaveBeenCalledWith(user, { registrationEnabled: false });
  });
});
