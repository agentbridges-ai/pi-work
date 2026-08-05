import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(import.meta.dirname, "migrations", "control-plane.sql"), "utf8");

describe("Apps Cloudflare account migration", () => {
  it("stores only credential envelopes and models one-time OAuth state", () => {
    expect(sql).toContain("create table if not exists cloudflare_connections");
    expect(sql).toContain("create table if not exists cloudflare_oauth_states");
    expect(sql).toContain("purpose text not null check (purpose in ('direct', 'claim'))");
    expect(sql).toContain("create table if not exists cloudflare_temporary_previews");
    expect(sql).toContain("credential_ciphertext text");
    expect(sql).toContain("claim_ciphertext text");
    expect(sql).toContain("state_hash text not null unique");
    expect(sql).not.toMatch(/\bapi_token\s+text\b/i);
    expect(sql).not.toMatch(/\bclaim_url\s+text\b/i);
    expect(sql).not.toMatch(/\bcode_verifier\s+text\b/i);
  });

  it("enforces the 60-minute preview and Worker/Assets-only receipt policy", () => {
    expect(sql).toContain("expires_at <= policies_accepted_at + interval '60 minutes'");
    expect(sql).toContain("resource_kind in ('worker', 'assets')");
    expect(sql).toContain("where status in ('provisioning', 'ready', 'claiming')");
    expect(sql).toContain("create table if not exists app_resource_receipts");
    expect(sql).toContain("'awaiting_target'");
    expect(sql).toContain("'queued'");
    expect(sql).toContain("'verifying_claim'");
  });
});
