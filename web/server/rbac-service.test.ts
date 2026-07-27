import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "./auth-types.js";
import type { RbacStore } from "./rbac-store.js";
import { MemoryAuthorizationCache, RbacService } from "./rbac-service.js";
import type { RbacPrincipal } from "./rbac-types.js";

const baseUser: AuthenticatedUser = {
  userId: "user-1",
  uuid: "user-1",
  username: "ada@example.test",
  displayName: "Ada",
  orgId: "local",
  orgName: "Local",
  roles: ["user"],
};

function principal(permissions: string[]): RbacPrincipal {
  return {
    userId: baseUser.userId,
    username: baseUser.username,
    displayName: baseUser.displayName,
    orgId: baseUser.orgId,
    orgName: baseUser.orgName,
    roles: permissions.includes("admin:access") ? ["系统管理员"] : ["成员"],
    permissions,
    departments: [{ id: "dept-root", name: "默认组织", parentId: null, primary: true }],
  };
}

function fakeStore(
  overrides: Partial<Record<keyof RbacStore, ReturnType<typeof vi.fn>>> = {},
): RbacStore {
  return {
    bootstrapUser: vi.fn(),
    getPrincipal: vi.fn().mockResolvedValue(principal([])),
    auditDenied: vi.fn(),
    replaceUserRoles: vi.fn(),
    replaceUserDepartments: vi.fn(),
    replaceDepartmentRoles: vi.fn(),
    createDepartment: vi.fn(),
    updateDepartment: vi.fn(),
    deleteDepartment: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    replaceRolePermissions: vi.fn(),
    listBootstrap: vi.fn(),
    listAudit: vi.fn(),
    ...overrides,
  } as unknown as RbacStore;
}

describe("RbacService", () => {
  it("bootstraps and enriches authenticated users with RBAC principal data", async () => {
    const store = fakeStore({
      getPrincipal: vi.fn().mockResolvedValue(principal(["admin:access"])),
    });
    const service = new RbacService(store, new MemoryAuthorizationCache());

    const user = await service.syncAuthenticatedUser(baseUser);

    expect(store.bootstrapUser).toHaveBeenCalledWith(baseUser);
    expect(user.permissions).toEqual(["admin:access"]);
    expect(user.departments).toEqual([
      { id: "dept-root", name: "默认组织", parentId: null, primary: true },
    ]);
    expect(user.roles).toEqual(["系统管理员"]);
  });

  it("uses the authorization cache and invalidates affected users after assignment writes", async () => {
    let nextPrincipal = principal(["admin:access"]);
    const store = fakeStore({
      getPrincipal: vi.fn().mockImplementation(async () => nextPrincipal),
      replaceUserRoles: vi.fn().mockResolvedValue(undefined),
    });
    const service = new RbacService(store, new MemoryAuthorizationCache());

    await expect(service.can(baseUser, "admin:access")).resolves.toBe(true);
    nextPrincipal = principal([]);
    await expect(service.can(baseUser, "admin:access")).resolves.toBe(true);

    await service.replaceUserRoles(baseUser, baseUser.userId, []);

    await expect(service.can(baseUser, "admin:access")).resolves.toBe(false);
    expect(store.getPrincipal).toHaveBeenCalledTimes(2);
  });

  it("audits denied admin access", async () => {
    const store = fakeStore({
      getPrincipal: vi.fn().mockResolvedValue(principal([])),
      auditDenied: vi.fn().mockResolvedValue(undefined),
    });
    const service = new RbacService(store, new MemoryAuthorizationCache());

    await expect(service.requireAdmin(baseUser, "/api/rbac/bootstrap")).resolves.toBe(false);

    expect(store.auditDenied).toHaveBeenCalledWith(
      baseUser.userId,
      "admin:access",
      "/api/rbac/bootstrap",
    );
  });

  it("refuses to enable registration while listening on a non-loopback host", async () => {
    const updateSystemSettings = vi.fn().mockResolvedValue({ registrationEnabled: true });
    const store = fakeStore({ updateSystemSettings });
    const service = new RbacService(store, new MemoryAuthorizationCache(), "0.0.0.0");

    await expect(
      service.updateSystemSettings(baseUser, { registrationEnabled: true }),
    ).rejects.toThrow("non-loopback");
    expect(updateSystemSettings).not.toHaveBeenCalled();
  });

  it("still permits registration changes on a loopback-only listener", async () => {
    const updateSystemSettings = vi.fn().mockResolvedValue({ registrationEnabled: true });
    const store = fakeStore({ updateSystemSettings });
    const service = new RbacService(store, new MemoryAuthorizationCache(), "127.0.0.1");

    await expect(
      service.updateSystemSettings(baseUser, { registrationEnabled: true }),
    ).resolves.toEqual({ registrationEnabled: true });
    expect(updateSystemSettings).toHaveBeenCalledWith(baseUser.userId, {
      registrationEnabled: true,
    });
  });
});
