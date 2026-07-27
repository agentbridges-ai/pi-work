import type { AuthenticatedUser } from "./auth-types.js";
import { auth } from "./better-auth.js";
import { RbacStore } from "./rbac-store.js";
import {
  RBAC_ADMIN_PERMISSION,
  type RbacAuthenticatedUser,
  type RbacBootstrap,
  type RbacPrincipal,
  type RbacSystemSettings,
  type RbacUserListOptions,
} from "./rbac-types.js";
import { environment } from "./environment.js";
import { isLoopbackHost } from "./network-security.js";

export interface AuthorizationCache {
  get(userId: string): RbacPrincipal | null;
  set(userId: string, value: RbacPrincipal): void;
  deleteByUser(userId: string): void;
  invalidateAll(): void;
}

export class MemoryAuthorizationCache implements AuthorizationCache {
  private readonly values = new Map<string, RbacPrincipal>();

  get(userId: string): RbacPrincipal | null {
    return this.values.get(userId) || null;
  }

  set(userId: string, value: RbacPrincipal): void {
    this.values.set(userId, value);
  }

  deleteByUser(userId: string): void {
    this.values.delete(userId);
  }

  invalidateAll(): void {
    this.values.clear();
  }
}

function enrichUser(user: AuthenticatedUser, principal: RbacPrincipal): RbacAuthenticatedUser {
  return {
    ...user,
    roles: principal.roles.length ? principal.roles : user.roles,
    permissions: principal.permissions,
    departments: principal.departments,
  };
}

function usernameFromEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("请输入有效邮箱。");
}

export class RbacService {
  constructor(
    private readonly store = new RbacStore(),
    private readonly cache: AuthorizationCache = new MemoryAuthorizationCache(),
    private readonly listenerHost = environment.host,
  ) {}

  async syncAuthenticatedUser(user: AuthenticatedUser): Promise<RbacAuthenticatedUser> {
    await this.store.bootstrapUser(user);
    this.cache.deleteByUser(user.userId);
    return enrichUser(user, await this.getPrincipal(user));
  }

  async getPrincipal(user: AuthenticatedUser): Promise<RbacPrincipal> {
    const cached = this.cache.get(user.userId);
    if (cached) return cached;
    const principal = await this.store.getPrincipal(user);
    this.cache.set(user.userId, principal);
    return principal;
  }

  async can(user: AuthenticatedUser, permission: string): Promise<boolean> {
    if (Array.isArray((user as { permissions?: unknown }).permissions)) {
      const permissions = (user as { permissions: string[] }).permissions;
      if (permissions.includes(permission)) return true;
    }
    const principal = await this.getPrincipal(user);
    return principal.permissions.includes(permission);
  }

  async requireAdmin(user: AuthenticatedUser, path: string): Promise<boolean> {
    const ok = await this.can(user, RBAC_ADMIN_PERMISSION);
    if (!ok)
      await this.store.auditDenied(user.userId, RBAC_ADMIN_PERMISSION, path).catch(() => undefined);
    return ok;
  }

  async getBootstrap(user: AuthenticatedUser): Promise<RbacBootstrap> {
    const principal = await this.getPrincipal(user);
    return this.store.listBootstrap(principal);
  }

  async listUsers(options: RbacUserListOptions = {}) {
    return this.store.listUsersPage(options);
  }

  async getSystemSettings(): Promise<RbacSystemSettings> {
    return this.store.getSystemSettings();
  }

  async updateSystemSettings(
    actor: AuthenticatedUser,
    settings: Partial<RbacSystemSettings>,
  ): Promise<RbacSystemSettings> {
    if (settings.registrationEnabled === true && !isLoopbackHost(this.listenerHost)) {
      throw new Error("Public registration cannot be enabled on a non-loopback listener.");
    }
    return this.store.updateSystemSettings(actor.userId, settings);
  }

  async isRegistrationEnabled(): Promise<boolean> {
    return (await this.getSystemSettings()).registrationEnabled;
  }

  async createUser(
    actor: AuthenticatedUser,
    input: {
      displayName: string;
      email: string;
      password: string;
      departmentIds?: string[];
      roleIds?: string[];
    },
  ) {
    const displayName = input.displayName.trim();
    const email = input.email.trim().toLowerCase();
    const password = input.password.trim();
    if (!displayName) throw new Error("姓名不能为空。");
    validateEmail(email);
    const context = await auth.$context;
    const minPasswordLength = context.password.config.minPasswordLength;
    const maxPasswordLength = context.password.config.maxPasswordLength;
    if (password.length < minPasswordLength) {
      throw new Error(`Password must be at least ${minPasswordLength} characters.`);
    }
    if (password.length > maxPasswordLength) {
      throw new Error(`Password must be at most ${maxPasswordLength} characters.`);
    }
    if (await context.internalAdapter.findUserByEmail(email)) {
      throw new Error("该邮箱已存在。");
    }
    const hashedPassword = await context.password.hash(password);
    const createdUser = await context.internalAdapter.createUser({
      email,
      name: displayName,
      emailVerified: false,
    });
    if (!createdUser) throw new Error("创建用户失败。");
    await context.internalAdapter.linkAccount({
      userId: createdUser.id,
      providerId: "credential",
      accountId: createdUser.id,
      password: hashedPassword,
    });
    const rbacUser = await this.store.createUser(
      actor.userId,
      {
        userId: createdUser.id,
        uuid: createdUser.id,
        username: usernameFromEmail(email),
        displayName: String(createdUser.name || displayName),
        orgId: "local",
        orgName: "Local",
        roles: ["user"],
        email,
      },
      {
        departmentIds: input.departmentIds,
        roleIds: input.roleIds,
      },
    );
    this.cache.deleteByUser(createdUser.id);
    return rbacUser;
  }

  async createDepartment(
    actor: AuthenticatedUser,
    input: { name: string; parentId?: string | null; sortOrder?: number },
  ) {
    const result = await this.store.createDepartment(actor.userId, input);
    this.cache.invalidateAll();
    return result;
  }

  async updateDepartment(
    actor: AuthenticatedUser,
    id: string,
    input: { name?: string; parentId?: string | null; sortOrder?: number },
  ) {
    const result = await this.store.updateDepartment(actor.userId, id, input);
    this.cache.invalidateAll();
    return result;
  }

  async deleteDepartment(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.store.deleteDepartment(actor.userId, id);
    this.cache.invalidateAll();
  }

  async createRole(actor: AuthenticatedUser, input: { name: string; description?: string }) {
    const result = await this.store.createRole(actor.userId, input);
    this.cache.invalidateAll();
    return result;
  }

  async updateRole(
    actor: AuthenticatedUser,
    id: string,
    input: { name?: string; description?: string },
  ) {
    const result = await this.store.updateRole(actor.userId, id, input);
    this.cache.invalidateAll();
    return result;
  }

  async deleteRole(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.store.deleteRole(actor.userId, id);
    this.cache.invalidateAll();
  }

  async replaceRolePermissions(actor: AuthenticatedUser, roleId: string, permissionKeys: string[]) {
    const result = await this.store.replaceRolePermissions(actor.userId, roleId, permissionKeys);
    this.cache.invalidateAll();
    return result;
  }

  async replaceUserRoles(
    actor: AuthenticatedUser,
    userId: string,
    roleIds: string[],
  ): Promise<void> {
    await this.store.replaceUserRoles(actor.userId, userId, roleIds);
    this.cache.deleteByUser(userId);
  }

  async replaceUserDepartments(
    actor: AuthenticatedUser,
    userId: string,
    departmentIds: string[],
  ): Promise<void> {
    await this.store.replaceUserDepartments(actor.userId, userId, departmentIds);
    this.cache.deleteByUser(userId);
  }

  async resetUserPassword(
    actor: AuthenticatedUser,
    userId: string,
    newPassword: string,
  ): Promise<void> {
    const password = newPassword.trim();
    const context = await auth.$context;
    const minPasswordLength = context.password.config.minPasswordLength;
    const maxPasswordLength = context.password.config.maxPasswordLength;
    if (password.length < minPasswordLength) {
      throw new Error(`Password must be at least ${minPasswordLength} characters.`);
    }
    if (password.length > maxPasswordLength) {
      throw new Error(`Password must be at most ${maxPasswordLength} characters.`);
    }
    if (!(await context.internalAdapter.findUserById(userId))) {
      throw new Error("User not found.");
    }
    const hashedPassword = await context.password.hash(password);
    const accounts = await context.internalAdapter.findAccounts(userId);
    if (accounts.find((account) => account.providerId === "credential")) {
      await context.internalAdapter.updatePassword(userId, hashedPassword);
    } else {
      await context.internalAdapter.createAccount({
        userId,
        providerId: "credential",
        accountId: userId,
        password: hashedPassword,
      });
    }
    await this.store.auditPasswordReset(actor.userId, userId);
  }

  async replaceDepartmentRoles(
    actor: AuthenticatedUser,
    departmentId: string,
    roleIds: string[],
  ): Promise<void> {
    await this.store.replaceDepartmentRoles(actor.userId, departmentId, roleIds);
    this.cache.invalidateAll();
  }

  async listAudit() {
    return this.store.listAudit(100);
  }
}
