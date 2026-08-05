import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type Scope = {
  tenantId: string;
  userId: string;
  membershipId: string;
  orgNodeId: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function withScope<T>(pool: Pool, scope: Scope, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("begin");
    await client.query(
      `select set_config('piwork.tenant_id', $1, true),
              set_config('piwork.user_id', $2, true),
              set_config('piwork.membership_id', $3, true),
              set_config('piwork.org_node_id', $4, true)`,
      [scope.tenantId, scope.userId, scope.membershipId, scope.orgNodeId],
    );
    const result = await action(client);
    await client.query("commit");
    committed = true;
    return result;
  } finally {
    if (!committed) await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

async function countSessions(pool: Pool, scope: Scope): Promise<number> {
  return withScope(pool, scope, async (client) => {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from runtime_session_index",
    );
    return Number(result.rows[0]?.count || 0);
  });
}

async function expectRlsDenied(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") return;
    throw error;
  }
  throw new Error("Expected PostgreSQL RLS to deny the cross-tenant write");
}

const appUser = required("PIWORK_POSTGRES_APP_USER");
const passwordFile = required("PIWORK_POSTGRES_APP_PASSWORD_FILE");
const password = readFileSync(passwordFile, "utf8").trim();
if (!password) throw new Error("Postgres application password is empty");

const suffix = randomUUID();
const userA = `rls-canary-user-a-${suffix}`;
const userB = `rls-canary-user-b-${suffix}`;
const tenantA = `rls-canary-tenant-a-${suffix}`;
const tenantB = `rls-canary-tenant-b-${suffix}`;
const scopeA: Scope = {
  tenantId: tenantA,
  userId: userA,
  membershipId: `rls-canary-membership-a-${suffix}`,
  orgNodeId: `rls-canary-org-a-${suffix}`,
};
const scopeB: Scope = {
  tenantId: tenantB,
  userId: userB,
  membershipId: `rls-canary-membership-b-${suffix}`,
  orgNodeId: `rls-canary-org-b-${suffix}`,
};
const partialA: Scope = { ...scopeA, tenantId: "", membershipId: "", orgNodeId: "" };
const unknown: Scope = {
  tenantId: "",
  userId: `rls-canary-unknown-${suffix}`,
  membershipId: "",
  orgNodeId: "",
};

const pool = new Pool({
  host: process.env.PIWORK_POSTGRES_HOST || "postgres",
  port: Number(process.env.PIWORK_POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || "piwork",
  user: appUser,
  password,
  max: 2,
});

async function createCanaryScope(scope: Scope): Promise<void> {
  await withScope(pool, scope, async (client) => {
    await client.query(`insert into tenants (id, type, name) values ($1, 'team', $2)`, [
      scope.tenantId,
      scope.tenantId,
    ]);
    await client.query(
      `insert into tenant_memberships (id, tenant_id, user_id, status)
       values ($1, $2, $3, 'active')`,
      [scope.membershipId, scope.tenantId, scope.userId],
    );
    await client.query(
      `insert into org_nodes (id, tenant_id, name, is_root)
       values ($1, $2, $3, true)`,
      [scope.orgNodeId, scope.tenantId, scope.orgNodeId],
    );
    await client.query(
      `insert into membership_org_nodes (membership_id, org_node_id, primary_org)
       values ($1, $2, true)`,
      [scope.membershipId, scope.orgNodeId],
    );
    await client.query(
      `insert into runtime_session_index
        (tenant_id, user_id, membership_id, org_node_id, session_id, generation, lifecycle)
       values ($1, $2, $3, $4, $5, 1, 'ready')`,
      [
        scope.tenantId,
        scope.userId,
        scope.membershipId,
        scope.orgNodeId,
        `session-${scope.tenantId}`,
      ],
    );
  });
}

try {
  const role = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    "select rolbypassrls, rolsuper from pg_roles where rolname = current_user",
  );
  if (role.rows[0]?.rolbypassrls || role.rows[0]?.rolsuper) {
    throw new Error("Compose Web database role must not have SUPERUSER or BYPASSRLS");
  }

  await createCanaryScope(scopeA);
  await createCanaryScope(scopeB);
  if ((await countSessions(pool, scopeA)) !== 1) throw new Error("Tenant A RLS read failed");
  if ((await countSessions(pool, scopeB)) !== 1) throw new Error("Tenant B RLS read failed");
  if ((await countSessions(pool, partialA)) !== 1) throw new Error("Partial user RLS read failed");
  if ((await countSessions(pool, unknown)) !== 0)
    throw new Error("Unknown user RLS read leaked data");

  await expectRlsDenied(() =>
    withScope(pool, scopeA, (client) =>
      client.query(
        `insert into runtime_session_index
            (tenant_id, user_id, membership_id, org_node_id, session_id, generation, lifecycle)
           values ($1, $2, $3, $4, $5, 1, 'ready')`,
        [
          scopeB.tenantId,
          scopeB.userId,
          scopeB.membershipId,
          scopeB.orgNodeId,
          `cross-tenant-${suffix}`,
        ],
      ),
    ),
  );

  console.log(
    JSON.stringify({
      contract: "piwork-runtime-rls-v1",
      role: appUser,
      tenantA: "isolated",
      tenantB: "isolated",
      partialUserScope: "passed",
      unknownUser: "denied",
      crossTenantWrite: "denied",
    }),
  );
} finally {
  for (const scope of [scopeA, scopeB]) {
    await withScope(pool, scope, (client) =>
      client.query("delete from tenants where id = $1", [scope.tenantId]),
    ).catch(() => undefined);
  }
  await pool.end();
}
