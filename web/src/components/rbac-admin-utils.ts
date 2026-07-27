import type { RbacAuditEntry, RbacDepartment, RbacPermission, RbacRole } from "../api.js";
import { getUiCopyLanguage, uiCopy } from "../ui-copy.js";

export interface FlatDepartment extends RbacDepartment {
  depth: number;
  hasChildren: boolean;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function flattenVisibleDepartments(
  departments: RbacDepartment[],
  collapsedIds: Set<string>,
): FlatDepartment[] {
  const children = new Map<string | null, RbacDepartment[]>();
  for (const department of departments) {
    const siblings = children.get(department.parentId) || [];
    siblings.push(department);
    children.set(department.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
  }

  const seen = new Set<string>();
  const result: FlatDepartment[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const department of children.get(parentId) || []) {
      if (seen.has(department.id)) continue;
      seen.add(department.id);
      const hasChildren = (children.get(department.id) || []).length > 0;
      result.push({ ...department, depth, hasChildren });
      if (!collapsedIds.has(department.id)) visit(department.id, depth + 1);
    }
  };
  visit(null, 0);

  const departmentIds = new Set(departments.map((department) => department.id));
  for (const department of departments) {
    if (seen.has(department.id) || (department.parentId && departmentIds.has(department.parentId)))
      continue;
    result.push({
      ...department,
      depth: 0,
      hasChildren: (children.get(department.id) || []).length > 0,
    });
    seen.add(department.id);
  }
  return result;
}

export function formatRbacDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getUiCopyLanguage(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function roleNames(roleIds: string[], roles: RbacRole[]): string {
  const names = roleIds
    .map((roleId) => roles.find((role) => role.id === roleId)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length
    ? names.join(uiCopy.common.listSeparator)
    : uiCopy.rbacAdmin.member.unassigned;
}

export function departmentNames(departmentIds: string[], departments: RbacDepartment[]): string {
  const names = departmentIds
    .map((departmentId) => departments.find((department) => department.id === departmentId)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length
    ? names.join(uiCopy.common.listSeparator)
    : uiCopy.rbacAdmin.member.unassigned;
}

export function permissionNames(permissionKeys: string[], permissions: RbacPermission[]): string {
  const names = permissionKeys
    .map(
      (permissionKey) =>
        permissions.find((permission) => permission.key === permissionKey)?.name || permissionKey,
    )
    .filter(Boolean);
  return names.length ? names.join(uiCopy.common.listSeparator) : uiCopy.rbacAdmin.none;
}

export function departmentLabel(id: string, departments: RbacDepartment[]): string {
  return departments.find((department) => department.id === id)?.name || id;
}

export function auditSummary(entry: RbacAuditEntry): string {
  const copy = uiCopy.rbacAdmin.audit;
  const actor = entry.actorDisplayName || copy.unknownActor;
  const target = entry.resourceName || copy.unknownTarget;
  const actions = copy.actionSummary;
  const actionLabels: Record<string, string> = {
    "rbac.bootstrap_admin": actions.bootstrapAdmin(target),
    "authorization.denied": actions.denied,
    "department.create": actions.departmentCreate(target),
    "department.update": actions.departmentUpdate(target),
    "department.delete": actions.departmentDelete(target),
    "department.roles.replace": actions.departmentRolesReplace(target),
    "role.create": actions.roleCreate(target),
    "role.update": actions.roleUpdate(target),
    "role.delete": actions.roleDelete(target),
    "role.permissions.replace": actions.rolePermissionsReplace(target),
    "user.create": actions.userCreate(target),
    "user.roles.replace": actions.userRolesReplace(target),
    "user.departments.replace": actions.userDepartmentsReplace(target),
    "user.password.reset": actions.userPasswordReset(target),
    "system.settings.update": actions.systemSettingsUpdate,
  };
  return actions.withActor(actor, actionLabels[entry.action] || actions.fallback(entry.action));
}
