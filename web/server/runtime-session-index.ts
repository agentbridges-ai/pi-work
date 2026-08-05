import { Pool, type PoolClient } from "pg";
import { getDatabaseUrl } from "./database-url.js";
import type { RuntimeScope } from "./runtime-control-protocol.js";
import { withRuntimeDbScope } from "./runtime-db-scope.js";

export type RuntimeIndexLifecycle =
  "preparing" | "starting" | "connecting" | "ready" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeSessionIndexStoreOptions {
  database?: Pick<Pool, "connect">;
}

/**
 * Rebuildable diagnostic projection. It is intentionally not consulted when
 * authorizing a session; session.json plus the pinned Pi authority remain the
 * source of truth.
 */
export class RuntimeSessionIndexStore {
  private readonly ownsPool: boolean;
  private readonly database: Pick<Pool, "connect">;

  constructor(options: RuntimeSessionIndexStoreOptions = {}) {
    this.ownsPool = !options.database;
    this.database =
      options.database ||
      new Pool({ connectionString: getDatabaseUrl() || "postgres://missing-database-url" });
  }

  async upsert(scope: RuntimeScope, lifecycle: RuntimeIndexLifecycle): Promise<void> {
    await withRuntimeDbScope(this.database, scope, async (client) => {
      await this.upsertOnClient(client, scope, lifecycle);
    });
  }

  async markStopped(
    scope: RuntimeScope,
    lifecycle: Extract<RuntimeIndexLifecycle, "stopped" | "failed"> = "stopped",
  ): Promise<void> {
    await this.upsert(scope, lifecycle);
  }

  /** Replace one tenant's projection from a Runtime/filesystem scan result. */
  async rebuild(
    tenantScope: RuntimeScope,
    rows: ReadonlyArray<{ scope: RuntimeScope; lifecycle: RuntimeIndexLifecycle }>,
  ): Promise<void> {
    await withRuntimeDbScope(this.database, tenantScope, async (client) => {
      await client.query("delete from runtime_session_index where tenant_id=$1", [
        tenantScope.tenantId,
      ]);
      for (const row of rows) {
        if (row.scope.tenantId !== tenantScope.tenantId) {
          throw new Error("Runtime index rebuild crossed tenant scope");
        }
        await this.upsertOnClient(client, row.scope, row.lifecycle);
      }
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await (this.database as Pool).end();
  }

  private async upsertOnClient(
    client: Pick<PoolClient, "query">,
    scope: RuntimeScope,
    lifecycle: RuntimeIndexLifecycle,
  ): Promise<void> {
    await client.query(
      `insert into runtime_session_index
         (tenant_id, user_id, membership_id, org_node_id, session_id, generation, lifecycle, last_seen_at)
       values ($1,$2,$3,$4,$5,$6,$7,now())
       on conflict (tenant_id, session_id) do update set
         user_id=excluded.user_id,
         membership_id=excluded.membership_id,
         org_node_id=excluded.org_node_id,
         generation=excluded.generation,
         lifecycle=excluded.lifecycle,
         updated_at=now(),
         last_seen_at=now()
       where runtime_session_index.generation <= excluded.generation`,
      [
        scope.tenantId,
        scope.userId,
        scope.membershipId,
        scope.orgNodeId,
        scope.sessionId,
        scope.generation,
        lifecycle,
      ],
    );
  }
}
