import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import type {
  AgentDraftConfig,
  AgentKind,
  AgentModelPolicySnapshot,
  ResolvedSessionAuthority,
  SessionAuthoritySnapshot,
  TenantMembership,
} from "./control-plane-types.js";
import type { ManagedMcpServerConfig } from "./managed-mcp.js";
import { modelPolicyFromDraft, normalizeAgentDraftConfig } from "./agent-draft-policy.js";
import { materializeManagedMcpServer } from "./control-plane-managed-mcp.js";
import { scanSkillSnapshot, type SkillFileSnapshot } from "./skill-security.js";
import { McpSecretService } from "./mcp-secret-service.js";

export { normalizeAgentDraftConfig } from "./agent-draft-policy.js";

function personalTenantId(userId: string): string {
  return `personal-${userId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
}

function membership(row: QueryResultRow): TenantMembership {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantName: String(row.tenant_name),
    tenantType: row.tenant_type,
    userId: String(row.user_id),
    status: row.status,
    isDefault: row.is_default === true,
  };
}

export class ControlPlaneService {
  private readonly pool: Pool;
  private readonly mcpSecrets: McpSecretService;
  private membershipRevoker?: (tenantId: string, userId: string) => Promise<void>;
  private membershipActivator?: (tenantId: string, userId: string) => Promise<void>;
  private readonly membershipLifecycleLocks = new Map<string, Promise<void>>();
  constructor(pool?: Pool) {
    this.pool =
      pool || new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
    this.mcpSecrets = new McpSecretService(this.pool);
  }

  setMembershipRevoker(revoker: (tenantId: string, userId: string) => Promise<void>): void {
    this.membershipRevoker = revoker;
  }

  setMembershipActivator(activator: (tenantId: string, userId: string) => Promise<void>): void {
    this.membershipActivator = activator;
  }

  private async withMembershipLifecycleLock<T>(
    tenantId: string,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${tenantId}:${userId}`;
    const previous = this.membershipLifecycleLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.membershipLifecycleLocks.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.membershipLifecycleLocks.get(key) === current) {
        this.membershipLifecycleLocks.delete(key);
      }
    }
  }

  async ensurePersonalTenant(userId: string, displayName: string): Promise<TenantMembership> {
    const tenantId = personalTenantId(userId);
    return this.withMembershipLifecycleLock(tenantId, userId, () =>
      this.ensurePersonalTenantLocked(userId, displayName, tenantId),
    );
  }

  private async ensurePersonalTenantLocked(
    userId: string,
    displayName: string,
    tenantId: string,
  ): Promise<TenantMembership> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("begin");
      await client.query(
        `insert into tenants (id, type, name) values ($1, 'personal', $2) on conflict (id) do nothing`,
        [tenantId, `${displayName || "Personal"} Workspace`],
      );
      const id = `membership-${tenantId}-${userId}`.slice(0, 240);
      await client.query(
        `insert into tenant_memberships (id, tenant_id, user_id, status, is_default)
         values ($1, $2, $3, 'active', not exists (select 1 from tenant_memberships where user_id = $3 and is_default))
         on conflict (tenant_id, user_id) do update set status = 'active'`,
        [id, tenantId, userId],
      );
      await client.query(
        `insert into user_tenant_context (user_id, tenant_id) values ($1, $2)
         on conflict (user_id) do nothing`,
        [userId, tenantId],
      );
      await this.ensureGeneralAgent(client, tenantId, id, userId);
      await client.query(
        `insert into scoped_role_assignments (id, role_id, user_id, tenant_id, created_by)
         values ($1, 'role-template-member', $2, $3, $2) on conflict (id) do nothing`,
        [`assignment-member-${id}`.slice(0, 240), userId, tenantId],
      );
      await client.query("commit");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    // Only an explicit, committed activation may clear a runtime tombstone.
    await this.membershipActivator?.(tenantId, userId);
    const memberships = await this.listMemberships(userId);
    const active = memberships.find((item) => item.tenantId === tenantId);
    if (!active) throw new Error("Personal tenant activation did not become visible.");
    return active;
  }

  async syncLegacySystemAdmin(userId: string, isAdmin: boolean): Promise<void> {
    const assignmentId = `assignment-platform-admin-${userId}`.slice(0, 240);
    if (isAdmin) {
      await this.pool.query(
        `insert into scoped_role_assignments (id, role_id, user_id, tenant_id, org_node_id, created_by)
         values ($1, 'role-platform-system-admin', $2, null, null, $2) on conflict (id) do nothing`,
        [assignmentId, userId],
      );
      return;
    }
    // Revoke only the deterministic compatibility grant created above. The
    // full predicate prevents an id collision from deleting an unrelated role.
    await this.pool.query(
      `delete from scoped_role_assignments
       where id=$1 and role_id='role-platform-system-admin' and user_id=$2
         and tenant_id is null and org_node_id is null`,
      [assignmentId, userId],
    );
  }

  async createTenant(actorUserId: string, input: { name: string; type: "enterprise" | "team" }) {
    const permitted = await this.pool.query(
      `select 1 from scoped_role_assignments a join scoped_role_permissions p on p.role_id=a.role_id
       where a.user_id=$1 and a.tenant_id is null and p.permission_key='tenant:manage' limit 1`,
      [actorUserId],
    );
    if (!permitted.rowCount) throw new Error("Forbidden by scoped authorization.");
    return this.createTenantUnchecked(actorUserId, input);
  }

  async completeOnboarding(
    userId: string,
    displayName: string,
    input: {
      type: "personal" | "team" | "enterprise";
      workspaceName?: string;
    },
  ) {
    const existing = await this.pool.query(
      `select o.registration_type,t.id,t.name,t.type from user_onboarding o join tenants t on t.id=o.tenant_id where o.user_id=$1`,
      [userId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      await this.switchTenant(userId, String(row.id));
      return {
        tenantId: String(row.id),
        tenantName: String(row.name),
        tenantType: row.type,
        completed: true,
      };
    }
    if (input.type === "personal") {
      const personal = await this.ensurePersonalTenant(userId, displayName);
      await this.pool.query(
        `insert into user_onboarding (user_id,registration_type,tenant_id) values ($1,'personal',$2)
         on conflict (user_id) do nothing`,
        [userId, personal.tenantId],
      );
      await this.switchTenant(userId, personal.tenantId);
      return {
        tenantId: personal.tenantId,
        tenantName: personal.tenantName,
        tenantType: personal.tenantType,
        completed: true,
      };
    }
    const workspaceName = input.workspaceName?.trim();
    if (!workspaceName)
      throw new Error(
        input.type === "team" ? "Team name is required." : "Organization name is required.",
      );
    const created = await this.createTenantUnchecked(userId, {
      name: workspaceName,
      type: input.type,
    });
    await this.pool.query(
      `insert into user_onboarding (user_id,registration_type,tenant_id) values ($1,$2,$3)
       on conflict (user_id) do nothing`,
      [userId, input.type, created.id],
    );
    await this.switchTenant(userId, created.id);
    return {
      tenantId: created.id,
      tenantName: created.name,
      tenantType: created.type,
      completed: true,
    };
  }

  private async createTenantUnchecked(
    actorUserId: string,
    input: { name: string; type: "enterprise" | "team" },
  ) {
    const name = input.name.trim();
    if (!name) throw new Error("Tenant name is required.");
    const tenantId = randomUUID();
    const membershipId = randomUUID();
    const rootId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(`insert into tenants (id,type,name) values ($1,$2,$3)`, [
        tenantId,
        input.type,
        name,
      ]);
      await client.query(
        `insert into tenant_memberships (id,tenant_id,user_id,status) values ($1,$2,$3,'active')`,
        [membershipId, tenantId, actorUserId],
      );
      await client.query(
        `insert into org_nodes (id,tenant_id,name,is_root) values ($1,$2,$3,true)`,
        [rootId, tenantId, name],
      );
      await client.query(
        `insert into org_node_closure (tenant_id,ancestor_id,descendant_id,depth) values ($1,$2,$2,0)`,
        [tenantId, rootId],
      );
      await client.query(
        `insert into scoped_role_assignments (id,role_id,user_id,tenant_id,created_by)
         values ($1,'role-template-tenant-admin',$2,$3,$2)`,
        [randomUUID(), actorUserId, tenantId],
      );
      await client.query("commit");
      return { id: tenantId, type: input.type, name, membershipId, rootOrgNodeId: rootId };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureGeneralAgent(
    db: PoolClient,
    tenantId: string,
    membershipId: string,
    userId: string,
  ): Promise<void> {
    const id = `general-${membershipId}`.slice(0, 240);
    const defaultDraft = normalizeAgentDraftConfig({
      knowledgeRootIds: [],
      skillPackageIds: [],
      mcpConnectionIds: [],
      modelAllowlist: ["*/*"],
      defaultThinkingLevel: "medium",
    });
    await db.query(
      `insert into agent_definitions
       (id, tenant_id, owner_membership_id, kind, name, description, immutable, draft, created_by)
       values ($1, $2, $3, 'general', '通用 Agent', '个人可配置的默认通用 Agent', true,
         $4::jsonb, $5)
       on conflict (id) do nothing`,
      [id, tenantId, membershipId, JSON.stringify(defaultDraft), userId],
    );
    const agent = await db.query(
      `select current_version_id, draft
       from agent_definitions
       where id=$1 and tenant_id=$2 and owner_membership_id=$3 and kind='general'
         and deleted_at is null
       for update`,
      [id, tenantId, membershipId],
    );
    if (!agent.rows[0] || agent.rows[0].current_version_id) return;

    const config = normalizeAgentDraftConfig(agent.rows[0].draft);
    const versionResult = await db.query(
      `select coalesce(max(version), 0) + 1 as version
       from agent_versions
       where agent_definition_id=$1`,
      [id],
    );
    const version = Number(versionResult.rows[0]?.version || 1);
    const versionId = randomUUID();
    const hash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    await db.query(
      `insert into agent_versions
       (id, agent_definition_id, version, config, effective_policy_hash, published_by)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [versionId, id, version, JSON.stringify(config), hash, userId],
    );
    await db.query(
      `update agent_definitions
       set current_version_id=$1, updated_at=now()
       where id=$2 and current_version_id is null`,
      [versionId, id],
    );
  }

  async listMemberships(userId: string): Promise<TenantMembership[]> {
    const result = await this.pool.query(
      `select m.*, t.name tenant_name, t.type tenant_type
       from tenant_memberships m join tenants t on t.id = m.tenant_id
       where m.user_id = $1 and m.status = 'active' and t.status = 'active'
       order by m.is_default desc, t.name`,
      [userId],
    );
    return result.rows.map(membership);
  }

  async getActiveMembership(userId: string): Promise<TenantMembership | null> {
    const result = await this.pool.query(
      `select m.*, t.name tenant_name, t.type tenant_type
       from tenant_memberships m join tenants t on t.id = m.tenant_id
       left join user_tenant_context c on c.user_id = m.user_id
       where m.user_id = $1 and m.status = 'active' and t.status = 'active'
       order by (m.tenant_id = c.tenant_id) desc, m.is_default desc limit 1`,
      [userId],
    );
    return result.rows[0] ? membership(result.rows[0]) : null;
  }

  private async canUseAgent(
    userId: string,
    tenantId: string,
    agentDefinitionId: string,
  ): Promise<boolean> {
    await this.requireMembership(userId, tenantId);
    const result = await this.pool.query(
      `select 1
       from agent_definitions a
       where a.id=$3 and a.tenant_id=$1 and a.deleted_at is null
         and (
           a.owner_membership_id in (
             select id from tenant_memberships
             where user_id=$2 and tenant_id=$1 and status='active'
           )
           or a.kind='team_shared'
           or exists (
             select 1 from agent_grants g
             where g.agent_definition_id=a.id and (
               (g.grantee_kind='tenant' and g.grantee_id=$1)
               or (
                 g.grantee_kind='membership'
                 and g.grantee_id in (
                   select id from tenant_memberships
                   where user_id=$2 and tenant_id=$1 and status='active'
                 )
               )
               or (
                 g.grantee_kind='role'
                 and g.grantee_id in (
                   select role_id from scoped_role_assignments
                   where user_id=$2 and tenant_id=$1
                 )
               )
               or (
                 g.grantee_kind='org_subtree'
                 and exists (
                   select 1
                   from tenant_memberships tm
                   join membership_org_nodes mo on mo.membership_id=tm.id
                   join org_node_closure oc
                     on oc.tenant_id=$1
                    and oc.ancestor_id=g.grantee_id
                    and oc.descendant_id=mo.org_node_id
                   where tm.user_id=$2 and tm.tenant_id=$1 and tm.status='active'
                 )
               )
             )
           )
         )
       limit 1`,
      [tenantId, userId, agentDefinitionId],
    );
    return Boolean(result.rowCount);
  }

  async isSessionAuthorityActive(authority: SessionAuthoritySnapshot): Promise<boolean> {
    try {
      if (
        !(await this.canUseAgent(authority.userId, authority.tenantId, authority.agentDefinitionId))
      ) {
        return false;
      }
      const pinned = await this.pool.query(
        `select 1
         from agent_definitions a
         join agent_versions v on v.agent_definition_id=a.id
         where a.id=$1 and a.tenant_id=$2 and a.deleted_at is null
           and v.id=$3 and v.effective_policy_hash=$4
         limit 1`,
        [
          authority.agentDefinitionId,
          authority.tenantId,
          authority.agentVersionId,
          authority.effectivePolicyHash,
        ],
      );
      return Boolean(pinned.rowCount);
    } catch {
      return false;
    }
  }

  async switchTenant(userId: string, tenantId: string): Promise<TenantMembership> {
    const result = await this.pool.query(
      `select m.*, t.name tenant_name, t.type tenant_type from tenant_memberships m
       join tenants t on t.id = m.tenant_id
       where m.user_id = $1 and m.tenant_id = $2 and m.status = 'active' and t.status = 'active'`,
      [userId, tenantId],
    );
    if (!result.rows[0]) throw new Error("Tenant membership not found.");
    await this.pool.query(
      `insert into user_tenant_context (user_id, tenant_id) values ($1, $2)
       on conflict (user_id) do update set tenant_id = excluded.tenant_id, updated_at = now()`,
      [userId, tenantId],
    );
    return membership(result.rows[0]);
  }

  async listAgents(userId: string, tenantId: string) {
    await this.requireMembership(userId, tenantId);
    const result = await this.pool.query(
      `select a.id, a.tenant_id, a.owner_membership_id, a.kind, a.name, a.description, a.immutable,
              a.current_version_id, a.draft, a.created_at, a.updated_at
       from agent_definitions a
       where a.tenant_id = $1 and a.deleted_at is null
         and (a.owner_membership_id in (select id from tenant_memberships where user_id = $2 and tenant_id = $1)
           or a.kind in ('team_shared')
           or exists (select 1 from agent_grants g where g.agent_definition_id = a.id and (
             (g.grantee_kind = 'tenant' and g.grantee_id = $1)
             or (g.grantee_kind = 'membership' and g.grantee_id in (select id from tenant_memberships where user_id=$2 and tenant_id=$1))
             or (g.grantee_kind = 'role' and g.grantee_id in (select role_id from scoped_role_assignments where user_id=$2 and tenant_id=$1))
             or (g.grantee_kind = 'org_subtree' and exists (
               select 1 from tenant_memberships tm join membership_org_nodes mo on mo.membership_id=tm.id
               join org_node_closure oc on oc.tenant_id=$1 and oc.ancestor_id=g.grantee_id and oc.descendant_id=mo.org_node_id
               where tm.user_id=$2 and tm.tenant_id=$1 and tm.status='active'
             ))
           )))
       order by a.kind = 'general' desc, a.name`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      ownerMembershipId: row.owner_membership_id,
      kind: row.kind as AgentKind,
      name: String(row.name),
      description: String(row.description),
      immutable: row.immutable === true,
      currentVersionId: row.current_version_id,
      draft: normalizeAgentDraftConfig(row.draft),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async createAgent(
    userId: string,
    tenantId: string,
    input: { name: string; description?: string; orgNodeId?: string },
  ) {
    const member = await this.requireMembership(userId, tenantId);
    const tenantResult = await this.pool.query(
      `select type from tenants where id=$1 and status='active'`,
      [tenantId],
    );
    const type = tenantResult.rows[0]?.type as "enterprise" | "team" | "personal" | undefined;
    if (!type) throw new Error("Tenant not found.");
    const shared = type !== "personal";
    if (shared && !(await this.hasTenantPermission(userId, tenantId, "agent:create"))) {
      if (
        !input.orgNodeId ||
        !(await this.hasOrgPermission(userId, tenantId, input.orgNodeId, "agent:create"))
      ) {
        throw new Error("Forbidden by scoped authorization.");
      }
    }
    if (!shared) {
      const entitlement = await this.pool.query(
        `select value from entitlements where tenant_id=$1 and key='agent.custom.limit'`,
        [tenantId],
      );
      const limit = Number(entitlement.rows[0]?.value ?? 3);
      const count = await this.pool.query(
        `select count(*)::int count from agent_definitions where tenant_id=$1 and owner_membership_id=$2
         and kind='personal_custom' and deleted_at is null`,
        [tenantId, member.id],
      );
      if (Number(count.rows[0].count) >= limit) throw new Error("Agent entitlement limit reached.");
    }
    const name = input.name.trim();
    if (!name) throw new Error("Agent name is required.");
    const id = randomUUID();
    const kind: AgentKind =
      type === "enterprise"
        ? "enterprise_shared"
        : type === "team"
          ? "team_shared"
          : "personal_custom";
    await this.pool.query(
      `insert into agent_definitions
       (id,tenant_id,owner_membership_id,kind,name,description,draft,created_by)
       values ($1,$2,$3,$4,$5,$6,'{"knowledgeRootIds":[],"skillPackageIds":[],"mcpConnectionIds":[],"modelAllowlist":["*/*"],"defaultThinkingLevel":"medium"}'::jsonb,$7)`,
      [
        id,
        tenantId,
        shared ? null : member.id,
        kind,
        name,
        input.description?.trim() || "",
        userId,
      ],
    );
    if (kind === "team_shared")
      await this.pool.query(
        `insert into agent_grants (id,agent_definition_id,grantee_kind,grantee_id,created_by)
       values ($1,$2,'tenant',$3,$4)`,
        [randomUUID(), id, tenantId, userId],
      );
    if (kind === "enterprise_shared" && input.orgNodeId)
      await this.pool.query(
        `insert into agent_grants (id,agent_definition_id,grantee_kind,grantee_id,created_by)
       values ($1,$2,'org_subtree',$3,$4)`,
        [randomUUID(), id, input.orgNodeId, userId],
      );
    return { id, tenantId, ownerMembershipId: shared ? null : member.id, kind, name };
  }

  async grantAgent(
    userId: string,
    tenantId: string,
    agentId: string,
    input: { kind: "tenant" | "org_subtree" | "role" | "membership"; id: string },
  ) {
    await this.requireTenantPermission(userId, tenantId, "agent:grant");
    const agent = await this.pool.query(
      `select 1 from agent_definitions where id=$1 and tenant_id=$2 and deleted_at is null`,
      [agentId, tenantId],
    );
    if (!agent.rowCount) throw new Error("Agent not found.");
    const id = randomUUID();
    await this.pool.query(
      `insert into agent_grants (id,agent_definition_id,grantee_kind,grantee_id,created_by)
       values ($1,$2,$3,$4,$5) on conflict (agent_definition_id,grantee_kind,grantee_id) do nothing`,
      [id, agentId, input.kind, input.id, userId],
    );
    return { id, agentId, granteeKind: input.kind, granteeId: input.id };
  }

  async registerKnowledgeRoot(
    userId: string,
    tenantId: string,
    input: { name: string; relativePath: string },
  ) {
    const active = await this.requireMembership(userId, tenantId);
    const tenant = await this.pool.query(`select type from tenants where id=$1`, [tenantId]);
    if (tenant.rows[0]?.type !== "personal")
      await this.requireTenantPermission(userId, tenantId, "knowledge:manage");
    if (
      !input.relativePath ||
      input.relativePath.startsWith("/") ||
      input.relativePath.split(/[\\/]/).includes("..")
    ) {
      throw new Error("Knowledge root must be a safe tenant-relative path.");
    }
    const id = randomUUID();
    await this.pool.query(
      `insert into knowledge_roots (id,tenant_id,name,relative_path,created_by) values ($1,$2,$3,$4,$5)`,
      [id, tenantId, input.name.trim() || input.relativePath, input.relativePath, userId],
    );
    return {
      id,
      tenantId,
      ownerMembershipId: tenant.rows[0]?.type === "personal" ? active.id : null,
      name: input.name,
      relativePath: input.relativePath,
    };
  }

  async createNetworkPolicy(
    userId: string,
    tenantId: string,
    input: { name: string; allowedDomains: string[]; deniedDomains: string[] },
  ) {
    const tenant = await this.pool.query(`select type from tenants where id=$1`, [tenantId]);
    if (tenant.rows[0]?.type !== "personal")
      await this.requireTenantPermission(userId, tenantId, "network-policy:manage");
    const normalize = (items: string[]) =>
      Array.from(
        new Set(
          items
            .map((item) => item.trim().toLowerCase())
            .filter((item) => /^[*A-Za-z0-9.-]+$/.test(item)),
        ),
      );
    const id = randomUUID();
    await this.pool.query(
      `insert into network_policies (id,tenant_id,name,allowed_domains,denied_domains,created_by)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        id,
        tenantId,
        input.name.trim(),
        JSON.stringify(normalize(input.allowedDomains)),
        JSON.stringify(normalize(input.deniedDomains)),
        userId,
      ],
    );
    return {
      id,
      tenantId,
      name: input.name,
      allowedDomains: normalize(input.allowedDomains),
      deniedDomains: normalize(input.deniedDomains),
    };
  }

  async addMembership(actorUserId: string, tenantId: string, targetUserId: string) {
    // Fail authorization before disclosing whether a target account exists;
    // the same permission is revalidated under the tenant row lock below.
    await this.requireTenantPermission(actorUserId, tenantId, "member:manage");
    const userExists = await this.pool.query(`select 1 from "user" where id=$1`, [targetUserId]);
    if (!userExists.rowCount) throw new Error("User not found.");
    return this.withMembershipLifecycleLock(tenantId, targetUserId, async () => {
      const client = await this.pool.connect();
      const candidateId = randomUUID();
      let membershipId: string = candidateId;
      let committed = false;
      try {
        await client.query("begin");
        const tenant = await client.query(
          `select id from tenants where id=$1 and status='active' for update`,
          [tenantId],
        );
        if (!tenant.rowCount) throw new Error("Tenant not found.");
        if (!(await this.hasTenantPermission(actorUserId, tenantId, "member:manage", client))) {
          throw new Error("Forbidden by scoped authorization.");
        }
        const activated = await client.query(
          `insert into tenant_memberships (id,tenant_id,user_id,status) values ($1,$2,$3,'active')
           on conflict (tenant_id,user_id) do update
             set status='active',updated_at=clock_timestamp()
           returning id`,
          [candidateId, tenantId, targetUserId],
        );
        membershipId = String(activated.rows[0]?.id || candidateId);
        await client.query(
          `insert into scoped_role_assignments (id,role_id,user_id,tenant_id,created_by)
           values ($1,'role-template-member',$2,$3,$4) on conflict (id) do nothing`,
          [
            `assignment-member-${tenantId}-${targetUserId}`.slice(0, 240),
            targetUserId,
            tenantId,
            actorUserId,
          ],
        );
        await client.query("commit");
        committed = true;
      } catch (error) {
        if (!committed) await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await this.membershipActivator?.(tenantId, targetUserId);
      return { id: membershipId, tenantId, userId: targetUserId, status: "active" };
    });
  }

  async removeMembership(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
  ): Promise<void> {
    if (actorUserId === targetUserId)
      throw new Error("Administrators cannot remove their own active membership.");
    await this.withMembershipLifecycleLock(tenantId, targetUserId, async () => {
      const client = await this.pool.connect();
      let committed = false;
      try {
        await client.query("begin");
        // A tenant row lock serializes removal of different administrators;
        // locking only each target membership permits two concurrent "not last"
        // checks to both succeed.
        const tenant = await client.query(
          `select id from tenants where id=$1 and status='active' for update`,
          [tenantId],
        );
        if (!tenant.rowCount) throw new Error("Tenant not found.");
        if (!(await this.hasTenantPermission(actorUserId, tenantId, "member:manage", client))) {
          throw new Error("Forbidden by scoped authorization.");
        }
        const target = await client.query(
          `select id from tenant_memberships
           where tenant_id=$1 and user_id=$2 and status='active' for update`,
          [tenantId, targetUserId],
        );
        if (!target.rowCount) throw new Error("Tenant membership not found.");
        const targetAdmin = await client.query(
          `select 1 from scoped_role_assignments
           where tenant_id=$1 and user_id=$2 and role_id='role-template-tenant-admin'`,
          [tenantId, targetUserId],
        );
        if (targetAdmin.rowCount) {
          const admins = await client.query(
            `select count(distinct a.user_id)::int count from scoped_role_assignments a
             join tenant_memberships m
               on m.tenant_id=a.tenant_id and m.user_id=a.user_id and m.status='active'
             where a.tenant_id=$1 and a.role_id='role-template-tenant-admin'`,
            [tenantId],
          );
          if (Number(admins.rows[0]?.count) <= 1) {
            throw new Error("The last tenant administrator cannot be removed.");
          }
        }
        await client.query(
          `update tenant_memberships
           set status='removed',is_default=false,updated_at=clock_timestamp()
           where tenant_id=$1 and user_id=$2 and status='active'`,
          [tenantId, targetUserId],
        );
        await client.query(
          `delete from scoped_role_assignments where tenant_id=$1 and user_id=$2`,
          [tenantId, targetUserId],
        );
        await client.query("commit");
        committed = true;
      } catch (error) {
        if (!committed) await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      // Database authority is revoked first; then close the runtime gate and
      // wait for all request/WS leases held by this principal to drain.
      await this.membershipRevoker?.(tenantId, targetUserId);
    });
  }

  private async requireTenantPermission(
    userId: string,
    tenantId: string,
    permission: string,
  ): Promise<void> {
    if (!(await this.hasTenantPermission(userId, tenantId, permission)))
      throw new Error("Forbidden by scoped authorization.");
  }

  private async hasTenantPermission(
    userId: string,
    tenantId: string,
    permission: string,
    database: Pick<PoolClient, "query"> = this.pool,
  ): Promise<boolean> {
    const result = await database.query(
      `select 1
       from scoped_role_assignments a
       join scoped_role_permissions p on p.role_id=a.role_id
       where a.user_id=$1 and p.permission_key=$3
         and (
           a.tenant_id is null
           or (
             a.tenant_id=$2
             and exists (
               select 1 from tenant_memberships m join tenants t on t.id=m.tenant_id
               where m.user_id=a.user_id and m.tenant_id=a.tenant_id
                 and m.status='active' and t.status='active'
             )
           )
         )
       limit 1`,
      [userId, tenantId, permission],
    );
    return Boolean(result.rowCount);
  }

  private async hasOrgPermission(
    userId: string,
    tenantId: string,
    orgNodeId: string,
    permission: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `select 1
       from scoped_role_assignments a
       join scoped_role_permissions p on p.role_id=a.role_id
       join org_node_closure c
         on c.tenant_id=a.tenant_id and c.ancestor_id=a.org_node_id and c.descendant_id=$3
       join tenant_memberships m
         on m.user_id=a.user_id and m.tenant_id=a.tenant_id and m.status='active'
       join tenants t on t.id=m.tenant_id and t.status='active'
       where a.user_id=$1 and a.tenant_id=$2 and p.permission_key=$4 limit 1`,
      [userId, tenantId, orgNodeId, permission],
    );
    return Boolean(result.rowCount);
  }

  async resolveSessionAuthority(
    userId: string,
    tenantId: string,
    agentDefinitionId: string,
  ): Promise<ResolvedSessionAuthority> {
    const resolvedAgentDefinitionId = await this.resolveRequestedAgentId(
      userId,
      tenantId,
      agentDefinitionId,
    );
    if (!(await this.canUseAgent(userId, tenantId, resolvedAgentDefinitionId))) {
      throw new Error("Agent not found or not granted.");
    }
    const result = await this.pool.query(
      `select a.id agent_definition_id, v.id agent_version_id, v.effective_policy_hash, v.config
       from agent_definitions a join agent_versions v on v.id = a.current_version_id
       where a.id = $1 and a.tenant_id = $2 and a.deleted_at is null`,
      [resolvedAgentDefinitionId, tenantId],
    );
    if (!result.rows[0]) throw new Error("Agent has no published version.");
    const authority = {
      tenantId,
      userId,
      agentDefinitionId: String(result.rows[0].agent_definition_id),
      agentVersionId: String(result.rows[0].agent_version_id),
      effectivePolicyHash: String(result.rows[0].effective_policy_hash),
    };
    return this.materializeSessionAuthority(authority, result.rows[0]);
  }

  /**
   * Resolve only non-secret model policy for the controlled Pi model probe.
   * Platform, credential, and network intersections remain runtime concerns.
   */
  async resolveAgentModelPolicy(
    userId: string,
    tenantId: string,
    agentDefinitionId: string,
  ): Promise<AgentModelPolicySnapshot> {
    const resolvedAgentDefinitionId = await this.resolveRequestedAgentId(
      userId,
      tenantId,
      agentDefinitionId,
    );
    if (!(await this.canUseAgent(userId, tenantId, resolvedAgentDefinitionId))) {
      throw new Error("Agent not found or not granted.");
    }
    const result = await this.pool.query(
      `select v.config
       from agent_definitions a
       join agent_versions v on v.id=a.current_version_id
       where a.id=$1 and a.tenant_id=$2 and a.deleted_at is null`,
      [resolvedAgentDefinitionId, tenantId],
    );
    if (!result.rows[0]) throw new Error("Agent has no published version.");
    return modelPolicyFromDraft(normalizeAgentDraftConfig(result.rows[0].config));
  }

  private async resolveRequestedAgentId(
    userId: string,
    tenantId: string,
    requestedAgentId: string,
  ): Promise<string> {
    if (requestedAgentId !== "agent") return requestedAgentId;
    const agents = await this.listAgents(userId, tenantId);
    return agents[0]?.id || requestedAgentId;
  }

  /**
   * Resolve the immutable Agent version recorded by session.json. Current
   * membership and grants are rechecked, while later Agent publications never
   * silently change a resumed session's policy.
   */
  async resolvePinnedSessionAuthority(
    authority: SessionAuthoritySnapshot,
  ): Promise<ResolvedSessionAuthority> {
    if (
      !authority ||
      [
        authority.tenantId,
        authority.userId,
        authority.agentDefinitionId,
        authority.agentVersionId,
      ].some((value) => typeof value !== "string" || !value || value.includes("\0")) ||
      !/^[a-f0-9]{64}$/u.test(authority.effectivePolicyHash)
    ) {
      throw new Error("Pinned Agent authority is invalid.");
    }
    if (
      !(await this.canUseAgent(authority.userId, authority.tenantId, authority.agentDefinitionId))
    ) {
      throw new Error("Agent not found or not granted.");
    }
    const result = await this.pool.query(
      `select a.id agent_definition_id, v.id agent_version_id, v.effective_policy_hash, v.config
       from agent_definitions a
       join agent_versions v on v.agent_definition_id=a.id
       where a.id=$1 and a.tenant_id=$2 and a.deleted_at is null
         and v.id=$3 and v.effective_policy_hash=$4`,
      [
        authority.agentDefinitionId,
        authority.tenantId,
        authority.agentVersionId,
        authority.effectivePolicyHash,
      ],
    );
    if (!result.rows[0]) throw new Error("Pinned Agent authority is no longer valid.");
    return this.materializeSessionAuthority({ ...authority }, result.rows[0]);
  }

  private async materializeSessionAuthority(
    authority: SessionAuthoritySnapshot,
    row: QueryResultRow,
  ): Promise<ResolvedSessionAuthority> {
    const config = normalizeAgentDraftConfig(row.config);
    const knowledge = config.knowledgeRootIds.length
      ? await this.pool.query(
          `select id,relative_path from knowledge_roots where tenant_id=$1 and id=any($2::text[]) and revoked_at is null`,
          [authority.tenantId, config.knowledgeRootIds],
        )
      : { rows: [] };
    const network = config.networkPolicyId
      ? await this.pool.query(
          `select allowed_domains,denied_domains from network_policies where id=$1 and (tenant_id is null or tenant_id=$2)
       order by version desc limit 1`,
          [config.networkPolicyId, authority.tenantId],
        )
      : { rows: [] };
    const skills = config.skillPackageIds.length
      ? await this.pool.query(
          `select id,content_snapshot from skill_packages where id=any($1::text[])
       and (tenant_id is null or tenant_id=$2) and scan_status='passed' and approval_status='approved'`,
          [config.skillPackageIds, authority.tenantId],
        )
      : { rows: [] };
    const mcp = config.mcpConnectionIds.length
      ? await this.pool.query(
          `select id,name,transport,config,secret_id from mcp_connections
       where tenant_id=$1 and id=any($2::text[]) and revoked_at is null
         and (
           owner_membership_id is null
           or owner_membership_id in (
             select id from tenant_memberships
             where tenant_id=$1 and user_id=$3 and status='active'
           )
         )`,
          [authority.tenantId, config.mcpConnectionIds, authority.userId],
        )
      : { rows: [] };
    if (knowledge.rows.length !== config.knowledgeRootIds.length) {
      throw new Error("Pinned Agent knowledge authority is no longer valid.");
    }
    if (config.networkPolicyId && network.rows.length !== 1) {
      throw new Error("Pinned Agent network authority is no longer valid.");
    }
    if (skills.rows.length !== config.skillPackageIds.length) {
      throw new Error("Pinned Agent Skill authority is no longer valid.");
    }
    if (mcp.rows.length !== config.mcpConnectionIds.length) {
      throw new Error("Pinned Agent MCP authority is no longer valid.");
    }
    const managedMcpServers: ManagedMcpServerConfig[] = [];
    const names = new Set<string>();
    for (const row of mcp.rows) {
      const name = String(row.name);
      if (names.has(name)) {
        throw new Error("Managed MCP server names must be unique.");
      }
      names.add(name);
      if (row.secret_id && row.transport === "stdio") {
        throw new Error("Managed MCP stdio credentials require an isolated capability channel.");
      }
      if (!row.secret_id) {
        managedMcpServers.push(materializeManagedMcpServer(row));
        continue;
      }
      materializeManagedMcpServer(row, "validation-only");
      const credential = await this.mcpSecrets.revealForRuntime(
        String(row.secret_id),
        authority.tenantId,
      );
      managedMcpServers.push(materializeManagedMcpServer(row, credential));
    }
    return {
      authority,
      launch: {
        instructions: config.instructions || "",
        knowledgeRelativePaths: knowledge.rows.map((row) => String(row.relative_path)),
        domainLayer: network.rows[0]
          ? {
              allowedDomains: Array.isArray(network.rows[0].allowed_domains)
                ? network.rows[0].allowed_domains
                : [],
              deniedDomains: Array.isArray(network.rows[0].denied_domains)
                ? network.rows[0].denied_domains
                : [],
            }
          : null,
        skillFiles: skills.rows.flatMap((row) => {
          const files = Array.isArray(row.content_snapshot?.files)
            ? row.content_snapshot.files
            : [];
          return files.map((file: SkillFileSnapshot) => ({
            packageId: String(row.id),
            path: file.path,
            content: file.content,
          }));
        }),
        modelPolicy: modelPolicyFromDraft(config),
        managedMcpServers,
      },
    };
  }

  async updateOwnedAgentDraft(userId: string, tenantId: string, agentId: string, draft: unknown) {
    const member = await this.requireMembership(userId, tenantId);
    const canEditShared = await this.hasTenantPermission(userId, tenantId, "agent:edit");
    const result = await this.pool.query(
      `update agent_definitions set draft = $1::jsonb, updated_at = now()
       where id = $2 and tenant_id = $3 and (owner_membership_id = $4 or (owner_membership_id is null and $5)) and deleted_at is null
       returning *`,
      [
        JSON.stringify(normalizeAgentDraftConfig(draft)),
        agentId,
        tenantId,
        member.id,
        canEditShared,
      ],
    );
    if (!result.rows[0]) throw new Error("Agent not found or not editable.");
    return result.rows[0];
  }

  async publishOwnedAgent(userId: string, tenantId: string, agentId: string) {
    const member = await this.requireMembership(userId, tenantId);
    const canPublishShared = await this.hasTenantPermission(userId, tenantId, "agent:publish");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const agentResult = await client.query(
        `select * from agent_definitions where id = $1 and tenant_id = $2
         and (owner_membership_id = $3 or (owner_membership_id is null and $4))
         and deleted_at is null for update`,
        [agentId, tenantId, member.id, canPublishShared],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw new Error("Agent not found or not publishable.");
      const draft = normalizeAgentDraftConfig(agent.draft);
      await this.validateDraftResources(
        client,
        tenantId,
        agent.owner_membership_id ? member.id : null,
        draft,
      );
      const versionResult = await client.query(
        `select coalesce(max(version), 0) + 1 as version from agent_versions where agent_definition_id = $1`,
        [agentId],
      );
      const version = Number(versionResult.rows[0].version);
      const hash = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
      const versionId = randomUUID();
      await client.query(
        `insert into agent_versions (id, agent_definition_id, version, config, effective_policy_hash, published_by)
         values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [versionId, agentId, version, JSON.stringify(draft), hash, userId],
      );
      await client.query(
        `update agent_definitions set current_version_id = $1, updated_at = now() where id = $2`,
        [versionId, agentId],
      );
      await client.query("commit");
      return {
        id: versionId,
        agentDefinitionId: agentId,
        version,
        config: draft,
        effectivePolicyHash: hash,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async importSkill(
    userId: string,
    tenantId: string,
    input: { sourceUrl: string; sourceCommit: string; files: SkillFileSnapshot[] },
  ) {
    const member = await this.requireMembership(userId, tenantId);
    if (!/^https:\/\//i.test(input.sourceUrl) || !input.sourceCommit.trim())
      throw new Error("A pinned HTTPS source and commit are required.");
    if (input.files.length === 0 || input.files.length > 100)
      throw new Error("Skill snapshot must contain 1-100 files.");
    const totalBytes = input.files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.content || "", "utf8"),
      0,
    );
    if (
      totalBytes > 1_048_576 ||
      input.files.some((file) => Buffer.byteLength(file.content || "", "utf8") > 262_144)
    ) {
      throw new Error("Skill snapshot exceeds the review size limit.");
    }
    const tenant = await this.pool.query(
      `select type from tenants where id=$1 and status='active'`,
      [tenantId],
    );
    const scan = scanSkillSnapshot(input.files);
    const id = randomUUID();
    const personal = tenant.rows[0]?.type === "personal";
    const approval = scan.passed && personal ? "approved" : "pending";
    await this.pool.query(
      `insert into skill_packages
       (id,tenant_id,owner_membership_id,source_url,source_commit,digest,scan_status,approval_status,approved_by,content_snapshot,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        id,
        tenantId,
        personal ? member.id : null,
        input.sourceUrl,
        input.sourceCommit,
        scan.digest,
        scan.passed ? "passed" : "failed",
        approval,
        approval === "approved" ? userId : null,
        JSON.stringify({ files: input.files, findings: scan.findings }),
        userId,
      ],
    );
    return {
      id,
      digest: scan.digest,
      scanStatus: scan.passed ? "passed" : "failed",
      approvalStatus: approval,
      findings: scan.findings,
    };
  }

  async approveSkill(userId: string, tenantId: string, skillId: string) {
    await this.requireTenantPermission(userId, tenantId, "skill:manage");
    const result = await this.pool.query(
      `update skill_packages set approval_status='approved', approved_by=$1
       where id=$2 and tenant_id=$3 and scan_status='passed' returning id,digest,approval_status`,
      [userId, skillId, tenantId],
    );
    if (!result.rows[0]) throw new Error("Skill not found or scan has not passed.");
    return result.rows[0];
  }

  private async validateDraftResources(
    db: PoolClient,
    tenantId: string,
    membershipId: string | null,
    draft: AgentDraftConfig,
  ): Promise<void> {
    const checks: Array<[string[], string, string]> = [
      [draft.knowledgeRootIds, "knowledge_roots", "id"],
    ];
    for (const [ids, table, column] of checks) {
      if (!ids.length) continue;
      const result = await db.query(
        `select ${column} id from ${table} where tenant_id = $1 and ${column} = any($2::text[]) and revoked_at is null`,
        [tenantId, ids],
      );
      if (result.rowCount !== ids.length)
        throw new Error(`Agent references missing or cross-tenant ${table}.`);
    }
    if (draft.mcpConnectionIds.length) {
      const result = await db.query(
        `select id from mcp_connections
         where tenant_id=$1 and id=any($2::text[]) and revoked_at is null
           and (
             owner_membership_id is null
             or ($3::text is not null and owner_membership_id=$3)
           )`,
        [tenantId, draft.mcpConnectionIds, membershipId],
      );
      if (result.rowCount !== draft.mcpConnectionIds.length) {
        throw new Error("Agent references unavailable managed MCP connections.");
      }
    }
    if (draft.skillPackageIds.length) {
      const result = await db.query(
        `select id from skill_packages where id = any($1::text[]) and (tenant_id is null or tenant_id = $2)
         and scan_status = 'passed' and approval_status = 'approved'`,
        [draft.skillPackageIds, tenantId],
      );
      if (result.rowCount !== draft.skillPackageIds.length)
        throw new Error("Agent references unapproved skills.");
    }
    if (draft.networkPolicyId) {
      const result = await db.query(
        `select 1 from network_policies where id = $1 and (tenant_id is null or tenant_id = $2)`,
        [draft.networkPolicyId, tenantId],
      );
      if (!result.rowCount)
        throw new Error("Agent references a missing or cross-tenant network policy.");
    }
  }

  private async requireMembership(userId: string, tenantId: string): Promise<TenantMembership> {
    const all = await this.listMemberships(userId);
    const found = all.find((item) => item.tenantId === tenantId);
    if (!found) throw new Error("Tenant membership not found.");
    return found;
  }
}
