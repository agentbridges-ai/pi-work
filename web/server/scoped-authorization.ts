import { Pool } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import type { ControlPlanePermission } from "./control-plane-types.js";

export interface AuthorizationTarget {
  tenantId?: string;
  orgNodeId?: string;
}

export class ScopedAuthorizationService {
  private readonly pool: Pool;
  constructor(pool?: Pool) {
    this.pool =
      pool || new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
  }

  async permissions(userId: string, target: AuthorizationTarget = {}): Promise<string[]> {
    const result = await this.pool.query(
      `select distinct rp.permission_key
       from scoped_role_assignments a
       join scoped_roles r on r.id = a.role_id and r.deleted_at is null
       join scoped_role_permissions rp on rp.role_id = r.id
       where a.user_id = $1 and (
         (r.scope_kind = 'platform' and a.tenant_id is null)
         or (r.scope_kind = 'tenant' and a.tenant_id = $2)
         or (r.scope_kind = 'org_subtree' and a.tenant_id = $2 and $3::text is not null and exists (
           select 1 from org_node_closure c where c.tenant_id = $2
             and c.ancestor_id = a.org_node_id and c.descendant_id = $3
         ))
       ) order by rp.permission_key`,
      [userId, target.tenantId || null, target.orgNodeId || null],
    );
    return result.rows.map((row) => String(row.permission_key));
  }

  async can(
    userId: string,
    permission: ControlPlanePermission,
    target: AuthorizationTarget = {},
  ): Promise<boolean> {
    return (await this.permissions(userId, target)).includes(permission);
  }

  async require(
    userId: string,
    permission: ControlPlanePermission,
    target: AuthorizationTarget = {},
  ): Promise<void> {
    if (!(await this.can(userId, permission, target)))
      throw new Error("Forbidden by scoped authorization.");
  }
}
