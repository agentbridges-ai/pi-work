import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { getRuntimeDbContext, isCompleteRuntimeDbContext } from "./runtime-db-context.js";
import { withRuntimeDbScope } from "./runtime-db-scope.js";

type QueryArgs =
  | [queryText: string, values?: unknown[]]
  | [config: QueryConfig<unknown[]>]
  | [queryText: string, values: unknown[], callback: (...args: unknown[]) => void];

/**
 * Pool facade used by product services. A normal query is executed in a short
 * transaction with the current RLS scope; explicit `connect()` transactions
 * receive the same scope on their first statement. Migrations use the raw
 * platform Pool and never pass through this facade.
 */
export class ScopedDatabase {
  constructor(private readonly pool: Pool) {}

  query<T extends QueryResultRow = any>(...args: QueryArgs): Promise<QueryResult<T>> {
    const context = getRuntimeDbContext();
    if (!context)
      return (this.pool.query as (...input: QueryArgs) => Promise<QueryResult<T>>)(...args);
    if (isCompleteRuntimeDbContext(context)) {
      return withRuntimeDbScope(this.pool, context, (client) =>
        (client.query as (...input: QueryArgs) => Promise<QueryResult<T>>)(...args),
      );
    }
    return this.withUserScope(context.userId, args);
  }

  async connect(): Promise<PoolClient> {
    const client = await this.pool.connect();
    const context = getRuntimeDbContext();
    if (!context) return client;
    let initialized = false;
    const originalQuery = client.query.bind(client) as (...args: QueryArgs) => Promise<unknown>;
    const setScope = async (): Promise<void> => {
      await originalQuery(
        `select set_config('piwork.tenant_id', $1, true),
                set_config('piwork.user_id', $2, true),
                set_config('piwork.membership_id', $3, true),
                set_config('piwork.org_node_id', $4, true)`,
        [
          context.tenantId || "",
          context.userId,
          context.membershipId || "",
          context.orgNodeId || "",
        ],
      );
      initialized = true;
    };
    const initialize = async (alreadyInTransaction: boolean): Promise<void> => {
      if (initialized) return;
      if (!alreadyInTransaction) await originalQuery("begin");
      await setScope();
    };
    const proxy = new Proxy(client, {
      get: (target, property, receiver) => {
        if (property === "query") {
          return async (...args: QueryArgs) => {
            const first = String(args[0] || "")
              .trim()
              .toLowerCase()
              .replace(/;\s*$/u, "");
            if (!initialized && first === "begin") {
              const result = await originalQuery(...args);
              await setScope();
              return result as unknown;
            }
            await initialize(false);
            const result = await originalQuery(...args);
            if (first === "commit" || first === "rollback") initialized = false;
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return proxy;
  }

  private async withUserScope<T extends QueryResultRow>(
    userId: string,
    args: QueryArgs,
  ): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("begin");
      await client.query(
        `select set_config('piwork.tenant_id', '', true),
                set_config('piwork.user_id', $1, true),
                set_config('piwork.membership_id', '', true),
                set_config('piwork.org_node_id', '', true)`,
        [userId],
      );
      const result = await (client.query as (...input: QueryArgs) => Promise<QueryResult<T>>)(
        ...args,
      );
      await client.query("commit");
      committed = true;
      return result;
    } finally {
      if (!committed) await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }
}
