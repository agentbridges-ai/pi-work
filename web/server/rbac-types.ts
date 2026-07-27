import type { AuthenticatedUser } from "./auth-types.js";

export const RBAC_ADMIN_PERMISSION = "admin:access";
export const RBAC_ROOT_DEPARTMENT_ID = "dept-root";
export const RBAC_SYSTEM_ADMIN_ROLE_ID = "role-system-admin";

export interface RbacPrincipalDepartment {
  id: string;
  name: string;
  parentId: string | null;
  primary: boolean;
}

export interface RbacPrincipal {
  userId: string;
  username: string;
  displayName: string;
  orgId: string;
  orgName: string;
  roles: string[];
  permissions: string[];
  departments: RbacPrincipalDepartment[];
}

export interface RbacDepartment {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  source: string;
  externalId: string | null;
  roleIds: string[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RbacRole {
  id: string;
  name: string;
  description: string;
  system: boolean;
  permissionKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RbacPermission {
  key: string;
  name: string;
  description: string;
  category: string;
}

export interface RbacUser {
  userId: string;
  username: string;
  displayName: string;
  email?: string;
  orgId: string;
  orgName: string;
  roleIds: string[];
  departmentIds: string[];
  primaryDepartmentId: string | null;
  permissions: string[];
  lastSeenAt: string;
}

export interface RbacSystemSettings {
  registrationEnabled: boolean;
}

export interface RbacAuditEntry {
  id: string;
  actorUserId: string;
  actorDisplayName?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RbacBootstrap {
  current: RbacPrincipal;
  departments: RbacDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  users: RbacUser[];
  audit: RbacAuditEntry[];
  settings: RbacSystemSettings;
}

export interface RbacUserPage {
  users: RbacUser[];
  total: number;
  cursor: number;
  limit: number;
  nextCursor: number;
  hasMore: boolean;
}

export interface RbacUserListOptions {
  cursor?: number;
  limit?: number;
  departmentId?: string | null;
  query?: string;
}

export interface RbacAuthenticatedUser extends AuthenticatedUser {
  permissions: string[];
  departments: RbacPrincipalDepartment[];
}
