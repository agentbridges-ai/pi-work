import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("./migrations/control-plane.sql", import.meta.url), "utf8");

describe("control-plane migration contract", () => {
  it("defines tenant, scoped authorization, immutable Agent and resource boundaries", () => {
    for (const table of [
      "tenants",
      "tenant_memberships",
      "user_onboarding",
      "org_nodes",
      "org_node_closure",
      "scoped_role_assignments",
      "agent_definitions",
      "agent_versions",
      "agent_grants",
      "knowledge_roots",
      "skill_packages",
      "mcp_connections",
      "encrypted_secrets",
      "network_policies",
      "entitlements",
      "control_plane_audit_log",
    ])
      expect(sql).toContain(`create table if not exists ${table}`);
    expect(sql).toContain("check (type in ('enterprise', 'team', 'personal'))");
    expect(sql).toContain("check (scope_kind in ('platform', 'tenant', 'org_subtree'))");
    expect(sql).toContain("effective_policy_hash text not null");
    expect(sql).toContain("check (transport in ('stdio', 'sse', 'streamable-http'))");
    expect(sql).toContain('"modelAllowlist":["*/*"]');
    expect(sql).toContain('"defaultThinkingLevel":"medium"');
  });
});
