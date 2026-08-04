import type { PoolClient } from "pg";
import type { RuntimeScope } from "./runtime-control-protocol.js";

/**
 * Apply the immutable Web/Runtime authority to one database transaction.
 * PostgreSQL RLS reads these transaction-local settings; they are never left
 * on a pooled connection for the next principal.
 */
export async function withRuntimeDbScope<T>(
  database: { connect(): Promise<PoolClient> },
  scope: Pick<RuntimeScope, "tenantId" | "userId" | "membershipId" | "orgNodeId">,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
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
    const result = await operation(client);
    await client.query("commit");
    committed = true;
    return result;
  } finally {
    if (!committed) await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
