import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(import.meta.dirname, "migrations", "control-plane.sql"), "utf8");

describe("Apps control-plane migration", () => {
  it("defines the authoritative lifecycle, immutable versions, Cloudflare receipts and queues", () => {
    for (const table of [
      "apps",
      "app_deployments",
      "app_custom_domains",
      "app_operation_outbox",
      "app_leases",
      "cloudflare_connections",
      "cloudflare_oauth_states",
      "cloudflare_temporary_previews",
      "app_resource_receipts",
    ]) {
      expect(sql).toContain(`create table if not exists ${table}`);
    }
    expect(sql).toContain("unique (tenant_id, slug)");
    expect(sql).toContain("unique (app_id, version)");
    expect(sql).toContain("unique (app_id, idempotency_key)");
    expect(sql).toContain(
      "status in ('building', 'needs_action', 'deploying', 'preview', 'ready', 'failed', 'archived')",
    );
    expect(sql).toContain("'temporary_ready', 'claim_pending', 'verifying_claim', 'ready'");
    expect(sql).toContain(
      "check (operation in ('deploy', 'rollback', 'domain_set', 'claim_verify'))",
    );
    expect(sql).toContain("step_status text not null default 'planned'");
    expect(sql).toContain("row_number() over");
    expect(sql).toContain("last_error_code='superseded_active_owner'");
    expect(sql).toContain("idx_cloudflare_temporary_previews_active_owner");
    expect(sql).toContain(
      "on cloudflare_temporary_previews(tenant_id, owner_user_id)\n  where status in ('provisioning', 'ready', 'claiming')",
    );
    expect(sql).toContain("partition by tenant_id, owner_user_id");
  });

  it("gives active members publish/manage-own permissions without manage-all", () => {
    expect(sql).toContain("('role-template-member', 'app:publish')");
    expect(sql).toContain("('role-template-member', 'app:manage-own')");
    expect(sql).not.toContain("('role-template-member', 'app:manage-all')");
  });
});
