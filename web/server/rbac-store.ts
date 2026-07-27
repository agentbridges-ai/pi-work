import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getDatabaseUrl } from "./better-auth.js";
import type { AuthenticatedUser } from "./auth-types.js";
import {
  RBAC_ADMIN_PERMISSION,
  RBAC_ROOT_DEPARTMENT_ID,
  RBAC_SYSTEM_ADMIN_ROLE_ID,
  type RbacAuditEntry,
  type RbacBootstrap,
  type RbacDepartment,
  type RbacPermission,
  type RbacPrincipal,
  type RbacPrincipalDepartment,
  type RbacRole,
  type RbacSystemSettings,
  type RbacUser,
  type RbacUserListOptions,
  type RbacUserPage,
} from "./rbac-types.js";

type Db = Pool | PoolClient;

function nowIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date().toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function rowDepartment(row: QueryResultRow): RbacDepartment {
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    name: String(row.name || ""),
    sortOrder: Number(row.sort_order || 0),
    source: String(row.source || "local"),
    externalId: row.external_id ? String(row.external_id) : null,
    roleIds: stringArray(row.role_ids),
    userCount: Number(row.user_count || 0),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

function rowRole(row: QueryResultRow): RbacRole {
  return {
    id: String(row.id),
    name: String(row.name || ""),
    description: String(row.description || ""),
    system: row.system === true,
    permissionKeys: stringArray(row.permission_keys),
    createdAt: nowIso(row.created_at),
    updatedAt: nowIso(row.updated_at),
  };
}

function rowPermission(row: QueryResultRow): RbacPermission {
  return {
    key: String(row.key || ""),
    name: String(row.name || ""),
    description: String(row.description || ""),
    category: String(row.category || "system"),
  };
}

function rowUser(row: QueryResultRow, permissions: string[] = []): RbacUser {
  return {
    userId: String(row.user_id),
    username: String(row.username || ""),
    displayName: String(row.display_name || ""),
    email: typeof row.email === "string" ? row.email : undefined,
    orgId: String(row.org_id || "local"),
    orgName: String(row.org_name || "Local"),
    roleIds: stringArray(row.role_ids),
    departmentIds: stringArray(row.department_ids),
    primaryDepartmentId: row.primary_department_id ? String(row.primary_department_id) : null,
    permissions,
    lastSeenAt: nowIso(row.last_seen_at),
  };
}

function rowAudit(row: QueryResultRow): RbacAuditEntry {
  return {
    id: String(row.id),
    actorUserId: String(row.actor_user_id || ""),
    actorDisplayName:
      typeof row.actor_display_name === "string" ? row.actor_display_name : undefined,
    action: String(row.action || ""),
    resourceType: String(row.resource_type || ""),
    resourceId: String(row.resource_id || ""),
    resourceName: typeof row.resource_name === "string" ? row.resource_name : undefined,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: nowIso(row.created_at),
  };
}

function clampPagination(options: RbacUserListOptions): { cursor: number; limit: number } {
  const cursor = Math.max(0, Math.floor(Number(options.cursor || 0)));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 25))));
  return { cursor, limit };
}

async function seedSystemRecords(db: Db): Promise<void> {
  await db.query(
    `insert into rbac_permissions (key, name, description, category)
     values ($1, $2, $3, $4)
     on conflict (key) do update set
       name = excluded.name,
       description = excluded.description,
       category = excluded.category`,
    [RBAC_ADMIN_PERMISSION, "进入管理后台", "允许进入管理后台并进行管理操作", "system"],
  );
  await db.query(
    `insert into rbac_departments (id, parent_id, name, sort_order, source)
     values ($1, null, $2, 0, 'system')
     on conflict (id) do update set
       name = excluded.name,
       updated_at = now(),
       deleted_at = null`,
    [RBAC_ROOT_DEPARTMENT_ID, "默认组织"],
  );
  await db.query(
    `insert into rbac_roles (id, name, description, system)
     values ($1, $2, $3, true)
     on conflict (id) do update set
       name = excluded.name,
       description = excluded.description,
       system = true,
       updated_at = now(),
       deleted_at = null`,
    [RBAC_SYSTEM_ADMIN_ROLE_ID, "系统管理员", "拥有系统管理后台访问权限"],
  );
  await db.query(
    `insert into rbac_role_permissions (role_id, permission_key)
     values ($1, $2)
     on conflict do nothing`,
    [RBAC_SYSTEM_ADMIN_ROLE_ID, RBAC_ADMIN_PERMISSION],
  );
  await db.query(
    `insert into app_system_settings (key, value)
     values ('registration.enabled', 'true'::jsonb)
     on conflict (key) do nothing`,
  );
}

async function upsertUser(db: Db, user: AuthenticatedUser): Promise<void> {
  await db.query(
    `insert into rbac_users (user_id, username, display_name, email, org_id, org_name, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (user_id) do update set
       username = excluded.username,
       display_name = excluded.display_name,
       email = excluded.email,
       org_id = excluded.org_id,
       org_name = excluded.org_name,
       last_seen_at = now(),
       updated_at = now()`,
    [user.userId, user.username, user.displayName, user.email || null, user.orgId, user.orgName],
  );
}

export class RbacStore {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool =
      pool || new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async bootstrapUser(user: AuthenticatedUser): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('piwork-rbac-bootstrap'))");
      await seedSystemRecords(client);
      await upsertUser(client, user);
      const departmentCount = await client.query(
        `select count(*)::int as count from rbac_user_departments where user_id = $1`,
        [user.userId],
      );
      if (Number(departmentCount.rows[0]?.count || 0) === 0) {
        await client.query(
          `insert into rbac_user_departments (user_id, department_id, primary_department)
           values ($1, $2, true)
           on conflict (user_id, department_id) do update set primary_department = true`,
          [user.userId, RBAC_ROOT_DEPARTMENT_ID],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getPrincipal(user: AuthenticatedUser): Promise<RbacPrincipal> {
    const userRow = await this.pool.query(`select * from rbac_users where user_id = $1`, [
      user.userId,
    ]);
    const row = userRow.rows[0] || {
      user_id: user.userId,
      username: user.username,
      display_name: user.displayName,
      org_id: user.orgId,
      org_name: user.orgName,
    };
    const roles = await this.pool.query(
      `with recursive user_depts as (
         select d.id, d.parent_id
         from rbac_user_departments ud
         join rbac_departments d on d.id = ud.department_id
         where ud.user_id = $1 and d.deleted_at is null
       ), dept_tree as (
         select id, parent_id from user_depts
         union
         select parent.id, parent.parent_id
         from rbac_departments parent
         join dept_tree child on child.parent_id = parent.id
         where parent.deleted_at is null
       ), role_ids as (
         select role_id from rbac_user_roles where user_id = $1
         union
         select dr.role_id from rbac_department_roles dr join dept_tree dt on dt.id = dr.department_id
       )
       select distinct r.id, r.name
       from role_ids ri
       join rbac_roles r on r.id = ri.role_id
       where r.deleted_at is null
       order by r.name`,
      [user.userId],
    );
    const permissions = await this.getEffectivePermissionKeys(user.userId);
    const departments = await this.pool.query(
      `select d.id, d.parent_id, d.name, ud.primary_department
       from rbac_user_departments ud
       join rbac_departments d on d.id = ud.department_id
       where ud.user_id = $1 and d.deleted_at is null
       order by ud.primary_department desc, d.name`,
      [user.userId],
    );
    return {
      userId: user.userId,
      username: String(row.username || user.username),
      displayName: String(row.display_name || user.displayName),
      orgId: String(row.org_id || user.orgId),
      orgName: String(row.org_name || user.orgName),
      roles: roles.rows.map((role: QueryResultRow) => String(role.name)),
      permissions,
      departments: departments.rows.map((dept: QueryResultRow): RbacPrincipalDepartment => ({
        id: String(dept.id),
        name: String(dept.name),
        parentId: dept.parent_id ? String(dept.parent_id) : null,
        primary: dept.primary_department === true,
      })),
    };
  }

  async getEffectivePermissionKeys(userId: string): Promise<string[]> {
    const result = await this.pool.query(
      `with recursive user_depts as (
         select d.id, d.parent_id
         from rbac_user_departments ud
         join rbac_departments d on d.id = ud.department_id
         where ud.user_id = $1 and d.deleted_at is null
       ), dept_tree as (
         select id, parent_id from user_depts
         union
         select parent.id, parent.parent_id
         from rbac_departments parent
         join dept_tree child on child.parent_id = parent.id
         where parent.deleted_at is null
       ), role_ids as (
         select role_id from rbac_user_roles where user_id = $1
         union
         select dr.role_id from rbac_department_roles dr join dept_tree dt on dt.id = dr.department_id
       )
       select distinct rp.permission_key
       from role_ids ri
       join rbac_roles r on r.id = ri.role_id and r.deleted_at is null
       join rbac_role_permissions rp on rp.role_id = r.id
       join rbac_permissions p on p.key = rp.permission_key
       order by rp.permission_key`,
      [userId],
    );
    return result.rows.map((row: QueryResultRow) => String(row.permission_key));
  }

  async listBootstrap(current: RbacPrincipal): Promise<RbacBootstrap> {
    const [departments, roles, permissions, users, audit, settings] = await Promise.all([
      this.listDepartments(),
      this.listRoles(),
      this.listPermissions(),
      Promise.resolve([]),
      this.listAudit(50),
      this.getSystemSettings(),
    ]);
    return { current, departments, roles, permissions, users, audit, settings };
  }

  async getSystemSettings(): Promise<RbacSystemSettings> {
    await seedSystemRecords(this.pool);
    const result = await this.pool.query(
      `select value from app_system_settings where key = 'registration.enabled'`,
    );
    return {
      registrationEnabled: booleanSetting(result.rows[0]?.value, true),
    };
  }

  async updateSystemSettings(
    actor: string,
    settings: Partial<RbacSystemSettings>,
  ): Promise<RbacSystemSettings> {
    if (typeof settings.registrationEnabled === "boolean") {
      await this.pool.query(
        `insert into app_system_settings (key, value, updated_by, updated_at)
         values ('registration.enabled', $1::jsonb, $2, now())
         on conflict (key) do update set
           value = excluded.value,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [JSON.stringify(settings.registrationEnabled), actor],
      );
      await this.audit(actor, "system.settings.update", "settings", "registration.enabled", {
        registrationEnabled: settings.registrationEnabled,
      });
    }
    return this.getSystemSettings();
  }

  async listDepartments(): Promise<RbacDepartment[]> {
    const result = await this.pool.query(
      `select d.*,
         coalesce(array_agg(distinct dr.role_id) filter (where dr.role_id is not null), '{}') as role_ids,
         count(distinct ud.user_id)::int as user_count
       from rbac_departments d
       left join rbac_department_roles dr on dr.department_id = d.id
       left join rbac_user_departments ud on ud.department_id = d.id
       where d.deleted_at is null
       group by d.id
       order by d.parent_id nulls first, d.sort_order, d.name`,
    );
    return result.rows.map(rowDepartment);
  }

  async listRoles(): Promise<RbacRole[]> {
    const result = await this.pool.query(
      `select r.*,
         coalesce(array_agg(rp.permission_key order by rp.permission_key) filter (where rp.permission_key is not null), '{}') as permission_keys
       from rbac_roles r
       left join rbac_role_permissions rp on rp.role_id = r.id
       where r.deleted_at is null
       group by r.id
       order by r.system desc, r.name`,
    );
    return result.rows.map(rowRole);
  }

  async listPermissions(): Promise<RbacPermission[]> {
    const result = await this.pool.query(`select * from rbac_permissions order by category, key`);
    return result.rows.map(rowPermission);
  }

  async listUsers(): Promise<RbacUser[]> {
    return (await this.listUsersPage({ cursor: 0, limit: 100 })).users;
  }

  async listUsersPage(options: RbacUserListOptions = {}): Promise<RbacUserPage> {
    const { cursor, limit } = clampPagination(options);
    const params: unknown[] = [];
    const filters: string[] = [];
    const query = options.query?.trim();
    if (options.departmentId && options.departmentId !== "all") {
      params.push(options.departmentId);
      filters.push(`exists (
        select 1 from rbac_user_departments filter_ud
        where filter_ud.user_id = u.user_id and filter_ud.department_id = $${params.length}
      )`);
    }
    if (query) {
      params.push(`%${query}%`);
      filters.push(`(
        u.display_name ilike $${params.length}
        or u.username ilike $${params.length}
        or coalesce(u.email, '') ilike $${params.length}
      )`);
    }
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const count = await this.pool.query(
      `select count(*)::int as count from rbac_users u ${where}`,
      params,
    );
    const pageParams = [...params, limit, cursor];
    const result = await this.pool.query(
      `select u.*,
         coalesce(array_agg(distinct ur.role_id) filter (where ur.role_id is not null), '{}') as role_ids,
         coalesce(array_agg(distinct ud.department_id) filter (where ud.department_id is not null), '{}') as department_ids,
         max(ud.department_id) filter (where ud.primary_department = true) as primary_department_id
       from rbac_users u
       left join rbac_user_roles ur on ur.user_id = u.user_id
       left join rbac_user_departments ud on ud.user_id = u.user_id
       ${where}
       group by u.user_id
       order by u.last_seen_at desc, u.display_name
       limit $${params.length + 1} offset $${params.length + 2}`,
      pageParams,
    );
    const users = await Promise.all(
      result.rows.map(async (row: QueryResultRow) =>
        rowUser(row, await this.getEffectivePermissionKeys(String(row.user_id))),
      ),
    );
    const total = Number(count.rows[0]?.count || 0);
    const nextCursor = cursor + users.length;
    const hasMore = nextCursor < total;
    return {
      users,
      total,
      cursor,
      limit,
      nextCursor: hasMore ? nextCursor : cursor,
      hasMore,
    };
  }

  async createUser(
    actor: string,
    user: AuthenticatedUser,
    input: {
      departmentIds?: string[];
      roleIds?: string[];
    } = {},
  ): Promise<RbacUser> {
    const departmentIds = Array.from(
      new Set(input.departmentIds?.length ? input.departmentIds : [RBAC_ROOT_DEPARTMENT_ID]),
    );
    const primaryDepartmentId = departmentIds[0];
    const roleIds = Array.from(new Set(input.roleIds || []));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await seedSystemRecords(client);
      await upsertUser(client, user);
      for (const departmentId of departmentIds) {
        await client.query(
          `insert into rbac_user_departments (user_id, department_id, primary_department)
           values ($1, $2, $3)
           on conflict (user_id, department_id) do update set primary_department = excluded.primary_department`,
          [user.userId, departmentId, departmentId === primaryDepartmentId],
        );
      }
      for (const roleId of roleIds) {
        await client.query(
          `insert into rbac_user_roles (user_id, role_id) values ($1, $2)
           on conflict do nothing`,
          [user.userId, roleId],
        );
      }
      await this.insertAudit(client, actor, "user.create", "user", user.userId, {
        departmentIds,
        roleIds,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const created = await this.findUser(user.userId);
    if (!created) throw new Error("User not found.");
    return created;
  }

  async listAudit(limit = 50): Promise<RbacAuditEntry[]> {
    const result = await this.pool.query(
      `select audit.*,
         actor.display_name as actor_display_name,
         coalesce(resource_user.display_name, resource_department.name, resource_role.name) as resource_name
       from rbac_audit_log audit
       left join rbac_users actor on actor.user_id = audit.actor_user_id
       left join rbac_users resource_user on audit.resource_type = 'user' and resource_user.user_id = audit.resource_id
       left join rbac_departments resource_department on audit.resource_type = 'department' and resource_department.id = audit.resource_id
       left join rbac_roles resource_role on audit.resource_type = 'role' and resource_role.id = audit.resource_id
       order by audit.created_at desc
       limit $1`,
      [Math.max(1, Math.min(200, Math.floor(limit)))],
    );
    return result.rows.map(rowAudit);
  }

  async createDepartment(
    actor: string,
    input: { name: string; parentId?: string | null; sortOrder?: number },
  ): Promise<RbacDepartment> {
    const id = `dept-${randomUUID()}`;
    await this.pool.query(
      `insert into rbac_departments (id, parent_id, name, sort_order, source)
       values ($1, $2, $3, $4, 'local')`,
      [
        id,
        input.parentId || RBAC_ROOT_DEPARTMENT_ID,
        input.name.trim(),
        Math.floor(input.sortOrder || 0),
      ],
    );
    await this.audit(actor, "department.create", "department", id, input);
    return (await this.listDepartments()).find((department) => department.id === id)!;
  }

  async updateDepartment(
    actor: string,
    id: string,
    input: { name?: string; parentId?: string | null; sortOrder?: number },
  ): Promise<RbacDepartment> {
    if (id === RBAC_ROOT_DEPARTMENT_ID && input.parentId !== undefined && input.parentId !== null) {
      throw new Error("Root department cannot be reparented.");
    }
    if (input.parentId && input.parentId === id)
      throw new Error("Department cannot be its own parent.");
    if (input.parentId && (await this.isDepartmentDescendant(input.parentId, id))) {
      throw new Error("Department cannot be moved under its descendant.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query(
        `update rbac_departments set
           name = coalesce($2, name),
           parent_id = case when $3::text = '__unchanged__' then parent_id else $3::text end,
           sort_order = coalesce($4, sort_order),
           updated_at = now()
         where id = $1 and deleted_at is null`,
        [
          id,
          typeof input.name === "string" ? input.name.trim() : null,
          Object.prototype.hasOwnProperty.call(input, "parentId")
            ? input.parentId
            : "__unchanged__",
          typeof input.sortOrder === "number" ? Math.floor(input.sortOrder) : null,
        ],
      );
      if ((result.rowCount || 0) === 0) throw new Error("Department not found.");
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(client, actor, "department.update", "department", id, input);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const department = (await this.listDepartments()).find((item) => item.id === id);
    if (!department) throw new Error("Department not found.");
    return department;
  }

  async deleteDepartment(actor: string, id: string): Promise<void> {
    if (id === RBAC_ROOT_DEPARTMENT_ID) throw new Error("Root department cannot be deleted.");
    const children = await this.pool.query(
      `select count(*)::int as count from rbac_departments where parent_id = $1 and deleted_at is null`,
      [id],
    );
    if (Number(children.rows[0]?.count || 0) > 0)
      throw new Error("Department has child departments.");
    const users = await this.pool.query(
      `select count(*)::int as count from rbac_user_departments where department_id = $1`,
      [id],
    );
    if (Number(users.rows[0]?.count || 0) > 0) throw new Error("Department still has users.");
    await this.pool.query(
      `update rbac_departments set deleted_at = now(), updated_at = now() where id = $1`,
      [id],
    );
    await this.audit(actor, "department.delete", "department", id, {});
  }

  async createRole(
    actor: string,
    input: { name: string; description?: string },
  ): Promise<RbacRole> {
    const id = `role-${randomUUID()}`;
    await this.pool.query(
      `insert into rbac_roles (id, name, description, system) values ($1, $2, $3, false)`,
      [id, input.name.trim(), input.description?.trim() || ""],
    );
    await this.audit(actor, "role.create", "role", id, input);
    return (await this.listRoles()).find((role) => role.id === id)!;
  }

  async updateRole(
    actor: string,
    id: string,
    input: { name?: string; description?: string },
  ): Promise<RbacRole> {
    await this.assertRoleEditable(id, { allowSystemRename: false });
    await this.pool.query(
      `update rbac_roles set
         name = coalesce($2, name),
         description = coalesce($3, description),
         updated_at = now()
       where id = $1 and deleted_at is null`,
      [
        id,
        typeof input.name === "string" ? input.name.trim() : null,
        typeof input.description === "string" ? input.description.trim() : null,
      ],
    );
    await this.audit(actor, "role.update", "role", id, input);
    const role = (await this.listRoles()).find((item) => item.id === id);
    if (!role) throw new Error("Role not found.");
    return role;
  }

  async deleteRole(actor: string, id: string): Promise<void> {
    await this.assertRoleEditable(id);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update rbac_roles set deleted_at = now(), updated_at = now() where id = $1`,
        [id],
      );
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(client, actor, "role.delete", "role", id, {});
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceRolePermissions(
    actor: string,
    roleId: string,
    permissionKeys: string[],
  ): Promise<RbacRole> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from rbac_role_permissions where role_id = $1`, [roleId]);
      for (const key of Array.from(new Set(permissionKeys))) {
        await client.query(
          `insert into rbac_role_permissions (role_id, permission_key) values ($1, $2)`,
          [roleId, key],
        );
      }
      await client.query(`update rbac_roles set updated_at = now() where id = $1`, [roleId]);
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(client, actor, "role.permissions.replace", "role", roleId, {
        permissionKeys,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const role = (await this.listRoles()).find((item) => item.id === roleId);
    if (!role) throw new Error("Role not found.");
    return role;
  }

  async replaceUserRoles(actor: string, userId: string, roleIds: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from rbac_user_roles where user_id = $1`, [userId]);
      for (const roleId of Array.from(new Set(roleIds))) {
        await client.query(`insert into rbac_user_roles (user_id, role_id) values ($1, $2)`, [
          userId,
          roleId,
        ]);
      }
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(client, actor, "user.roles.replace", "user", userId, { roleIds });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceUserDepartments(
    actor: string,
    userId: string,
    departmentIds: string[],
  ): Promise<void> {
    const ids = Array.from(
      new Set(departmentIds.length ? departmentIds : [RBAC_ROOT_DEPARTMENT_ID]),
    );
    const primary = ids[0];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from rbac_user_departments where user_id = $1`, [userId]);
      for (const departmentId of ids) {
        await client.query(
          `insert into rbac_user_departments (user_id, department_id, primary_department) values ($1, $2, $3)`,
          [userId, departmentId, departmentId === primary],
        );
      }
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(client, actor, "user.departments.replace", "user", userId, {
        departmentIds: ids,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceDepartmentRoles(
    actor: string,
    departmentId: string,
    roleIds: string[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from rbac_department_roles where department_id = $1`, [
        departmentId,
      ]);
      for (const roleId of Array.from(new Set(roleIds))) {
        await client.query(
          `insert into rbac_department_roles (department_id, role_id) values ($1, $2)`,
          [departmentId, roleId],
        );
      }
      await this.ensureAtLeastOneAdmin(client);
      await this.insertAudit(
        client,
        actor,
        "department.roles.replace",
        "department",
        departmentId,
        { roleIds },
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async auditDenied(actor: string, permission: string, path: string): Promise<void> {
    await this.audit(actor, "authorization.denied", "permission", permission, { path });
  }

  async auditPasswordReset(actor: string, userId: string): Promise<void> {
    await this.audit(actor, "user.password.reset", "user", userId, {});
  }

  private async findUser(userId: string): Promise<RbacUser | null> {
    const result = await this.pool.query(
      `select u.*,
         coalesce(array_agg(distinct ur.role_id) filter (where ur.role_id is not null), '{}') as role_ids,
         coalesce(array_agg(distinct ud.department_id) filter (where ud.department_id is not null), '{}') as department_ids,
         max(ud.department_id) filter (where ud.primary_department = true) as primary_department_id
       from rbac_users u
       left join rbac_user_roles ur on ur.user_id = u.user_id
       left join rbac_user_departments ud on ud.user_id = u.user_id
       where u.user_id = $1
       group by u.user_id`,
      [userId],
    );
    const row = result.rows[0];
    return row ? rowUser(row, await this.getEffectivePermissionKeys(userId)) : null;
  }

  private async audit(
    actor: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.insertAudit(this.pool, actor, action, resourceType, resourceId, metadata);
  }

  private async insertAudit(
    db: Db,
    actor: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.query(
      `insert into rbac_audit_log (id, actor_user_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [`audit-${randomUUID()}`, actor, action, resourceType, resourceId, JSON.stringify(metadata)],
    );
  }

  private async assertRoleEditable(
    id: string,
    options: { allowSystemRename?: boolean } = {},
  ): Promise<void> {
    const role = await this.pool.query(
      `select system from rbac_roles where id = $1 and deleted_at is null`,
      [id],
    );
    if (!role.rows[0]) throw new Error("Role not found.");
    if (role.rows[0].system === true && !options.allowSystemRename) {
      throw new Error("System roles cannot be modified this way.");
    }
  }

  private async isDepartmentDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `with recursive tree as (
         select id, parent_id from rbac_departments where id = $1 and deleted_at is null
         union all
         select parent.id, parent.parent_id
         from rbac_departments parent
         join tree child on child.parent_id = parent.id
         where parent.deleted_at is null
       )
       select 1 from tree where id = $2 limit 1`,
      [candidateId, ancestorId],
    );
    return (result.rowCount || 0) > 0;
  }

  private async ensureAtLeastOneAdmin(db: Db): Promise<void> {
    const count = await this.countUsersWithPermission(db, RBAC_ADMIN_PERMISSION);
    if (count < 1) throw new Error("At least one administrator must keep admin access.");
  }

  private async countUsersWithPermission(db: Db, permissionKey: string): Promise<number> {
    const result = await db.query(
      `with recursive dept_ancestors as (
         select ud.user_id, d.id as department_id, d.parent_id
         from rbac_user_departments ud
         join rbac_departments d on d.id = ud.department_id
         where d.deleted_at is null
         union
         select da.user_id, parent.id, parent.parent_id
         from dept_ancestors da
         join rbac_departments parent on da.parent_id = parent.id
         where parent.deleted_at is null
       ), role_users as (
         select user_id, role_id from rbac_user_roles
         union
         select da.user_id, dr.role_id
         from dept_ancestors da
         join rbac_department_roles dr on dr.department_id = da.department_id
       )
       select count(distinct ru.user_id)::int as count
       from role_users ru
       join rbac_roles r on r.id = ru.role_id and r.deleted_at is null
       join rbac_role_permissions rp on rp.role_id = r.id
       where rp.permission_key = $1`,
      [permissionKey],
    );
    return Number(result.rows[0]?.count || 0);
  }
}
