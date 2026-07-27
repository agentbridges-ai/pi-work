import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getDatabaseUrl } from "./better-auth.js";
import { ScopedAuthorizationService } from "./scoped-authorization.js";

export class OrgService {
  private readonly pool: Pool;
  private readonly authorization: ScopedAuthorizationService;
  constructor(pool?: Pool, authorization?: ScopedAuthorizationService) {
    this.pool =
      pool || new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
    this.authorization = authorization || new ScopedAuthorizationService(this.pool);
  }

  async list(userId: string, tenantId: string) {
    await this.authorization.require(userId, "org:manage", { tenantId });
    const result = await this.pool.query(
      `select n.*, coalesce(array_agg(c.ancestor_id order by c.depth desc) filter (where c.ancestor_id is not null), '{}') ancestors
       from org_nodes n left join org_node_closure c on c.tenant_id = n.tenant_id and c.descendant_id = n.id
       where n.tenant_id = $1 and n.deleted_at is null group by n.id order by n.sort_order, n.name`,
      [tenantId],
    );
    return result.rows;
  }

  async create(
    userId: string,
    tenantId: string,
    input: { name: string; parentId?: string | null; sortOrder?: number },
  ) {
    const name = input.name.trim();
    if (!name) throw new Error("Organization node name is required.");
    await this.authorization.require(userId, "org:manage", {
      tenantId,
      ...(input.parentId ? { orgNodeId: input.parentId } : {}),
    });
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.parentId) {
        const parent = await client.query(
          `select 1 from org_nodes where id = $1 and tenant_id = $2 and deleted_at is null for share`,
          [input.parentId, tenantId],
        );
        if (!parent.rowCount) throw new Error("Parent organization node not found.");
      } else {
        const root = await client.query(
          `select 1 from org_nodes where tenant_id = $1 and is_root and deleted_at is null`,
          [tenantId],
        );
        if (root.rowCount) throw new Error("Tenant already has a root organization node.");
      }
      await client.query(
        `insert into org_nodes (id, tenant_id, parent_id, name, sort_order, is_root) values ($1,$2,$3,$4,$5,$6)`,
        [id, tenantId, input.parentId || null, name, input.sortOrder || 0, !input.parentId],
      );
      await client.query(
        `insert into org_node_closure (tenant_id, ancestor_id, descendant_id, depth) values ($1,$2,$2,0)`,
        [tenantId, id],
      );
      if (input.parentId) {
        await client.query(
          `insert into org_node_closure (tenant_id, ancestor_id, descendant_id, depth)
           select tenant_id, ancestor_id, $3, depth + 1 from org_node_closure
           where tenant_id = $1 and descendant_id = $2`,
          [tenantId, input.parentId, id],
        );
      }
      await client.query("commit");
      return {
        id,
        tenantId,
        parentId: input.parentId || null,
        name,
        sortOrder: input.sortOrder || 0,
        isRoot: !input.parentId,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(userId: string, tenantId: string, nodeId: string): Promise<void> {
    await this.authorization.require(userId, "org:manage", { tenantId, orgNodeId: nodeId });
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const node = await client.query(
        `select is_root from org_nodes where id = $1 and tenant_id = $2 and deleted_at is null for update`,
        [nodeId, tenantId],
      );
      if (!node.rows[0]) throw new Error("Organization node not found.");
      if (node.rows[0].is_root) throw new Error("Root organization node cannot be deleted.");
      const dependents = await client.query(
        `select exists(select 1 from org_nodes where tenant_id=$1 and parent_id=$2 and deleted_at is null)
          or exists(select 1 from membership_org_nodes where org_node_id=$2) blocked`,
        [tenantId, nodeId],
      );
      if (dependents.rows[0].blocked)
        throw new Error("Organization node still has children or members.");
      await client.query(
        `update org_nodes set deleted_at=now(), updated_at=now() where id=$1 and tenant_id=$2`,
        [nodeId, tenantId],
      );
      await client.query(
        `delete from org_node_closure where tenant_id=$1 and (ancestor_id=$2 or descendant_id=$2)`,
        [tenantId, nodeId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
