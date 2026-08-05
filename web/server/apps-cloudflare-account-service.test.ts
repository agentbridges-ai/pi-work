import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  CLOUDFLARE_PRIVACY_POLICY_URL,
  CLOUDFLARE_TERMS_OF_SERVICE_URL,
  type AppCloudflareAccountClient,
} from "./apps-cloudflare-account-client.js";
import {
  AppCloudflareAccountService,
  AppCloudflareNeedsOAuthError,
} from "./apps-cloudflare-account-service.js";
import {
  CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
  CLOUDFLARE_PERMISSION_NAMES,
  hashCloudflareOAuthScopeEntries,
  parseCloudflareOAuthScopeCatalog,
} from "./apps-cloudflare-oauth-scopes.js";
import { encryptSecret } from "./secret-cipher.js";

const context = {
  tenantId: "tenant-1",
  userId: "user-1",
  membershipId: "member-1",
};
const masterKey = Buffer.alloc(32, 7).toString("base64");
const providerScopes = [
  { name: CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite, id: "provider.workers.write" },
  { name: CLOUDFLARE_PERMISSION_NAMES.zoneRead, id: "provider.zone.read" },
];
const scopeCatalog = parseCloudflareOAuthScopeCatalog({
  version: 1,
  source: CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
  generatedAt: "2026-08-04T08:00:00.000Z",
  scopes: providerScopes,
  hash: hashCloudflareOAuthScopeEntries(providerScopes),
});
const enabled = {
  temporaryEnabled: () => true,
  byocEnabled: () => true,
  scopeCatalog: () => scopeCatalog,
};

function clientFixture(): AppCloudflareAccountClient {
  return {
    oauthRedirectUri: "https://piwork.example/api/apps/cloudflare/oauth/callback",
    provisionTemporaryAccount: vi.fn(),
    authorizationUrl: vi.fn(
      ({ state }) => `https://dash.cloudflare.com/oauth2/auth?state=${state}`,
    ),
    exchangeAuthorizationCode: vi.fn(),
    refreshAccessToken: vi.fn(),
    listOAuthScopes: vi.fn().mockResolvedValue(providerScopes),
    listZones: vi.fn().mockResolvedValue([]),
    revokeToken: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AppCloudflareAccountService", () => {
  it("never sends policy acceptance unless the user accepted both policies", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "member-1" }] });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
    });

    await expect(
      service.provisionTemporaryAccount(context, {
        deploymentId: "deployment-1",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: false,
      }),
    ).rejects.toThrow(/both be explicitly accepted/);
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("encrypts temporary API and claim credentials and returns only safe metadata", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            owner_user_id: "user-1",
            phase: "awaiting_target",
            target_kind: "unassigned",
            temporary_preview_id: null,
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementationOnce((_sql: string, values: unknown[]) => ({
        rows: [
          {
            id: values[13],
            app_id: "app-1",
            tenant_id: "tenant-1",
            owner_user_id: "user-1",
            owner_membership_id: "member-1",
            account_id: "cf-account",
            account_name: "Preview",
            status: "ready",
            account_expires_at: expiresAt,
            claim_expires_at: expiresAt,
            expires_at: expiresAt,
            claim_ciphertext: values[6],
            claim_iv: values[7],
            claim_auth_tag: values[8],
            claimed_connection_id: null,
            policies_accepted_at: now,
            created_at: now,
            updated_at: now,
          },
        ],
      }))
      .mockResolvedValueOnce({ rows: [] });
    const client = clientFixture();
    vi.mocked(client.provisionTemporaryAccount).mockResolvedValue({
      accountId: "cf-account",
      accountName: "Preview",
      apiToken: "temporary-api-secret",
      tokenId: "token-id",
      accountExpiresAt: expiresAt,
      claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=claim-secret",
      claimExpiresAt: expiresAt,
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    const result = await service.provisionTemporaryAccount(context, {
      deploymentId: "deployment-1",
      ipAddress: "192.0.2.1",
      acceptedTermsOfService: true,
      acceptedPrivacyPolicy: true,
    });

    expect(client.provisionTemporaryAccount).toHaveBeenCalledWith({
      termsOfService: CLOUDFLARE_TERMS_OF_SERVICE_URL,
      privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
      acceptTermsOfService: "yes",
    });
    expect(result).toMatchObject({ accountId: "cf-account", claimAvailable: true });
    expect(JSON.stringify(result)).not.toContain("temporary-api-secret");
    expect(JSON.stringify(result)).not.toContain("claim-secret");
    const persistedValues = query.mock.calls[7][1] as unknown[];
    expect(persistedValues.join(" ")).not.toContain("temporary-api-secret");
    expect(persistedValues.join(" ")).not.toContain("claim-secret");
    expect(String(persistedValues[2])).not.toBe("temporary-api-secret");
    expect(String(persistedValues[6])).not.toContain("claim-secret");
  });

  it("reuses the concurrent winner when the provisioning reservation conflicts", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    let reusableReads = 0;
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              owner_user_id: "user-1",
              phase: "awaiting_target",
              target_kind: "unassigned",
              temporary_preview_id: null,
              manifest: {
                version: 1,
                runtime: "cloudflare-workers",
                exposure: { workersDev: true },
              },
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("expired_previews as")) return { rows: [], rowCount: 0 };
      if (sql.includes("update cloudflare_oauth_states")) return { rows: [], rowCount: 0 };
      if (sql.includes("status='ready' and expires_at")) {
        reusableReads += 1;
        return reusableReads === 1
          ? { rows: [] }
          : {
              rows: [
                {
                  id: "preview-winner",
                  app_id: "app-1",
                  tenant_id: "tenant-1",
                  owner_user_id: "user-1",
                  owner_membership_id: "member-1",
                  account_id: "winner-account",
                  account_name: "Winner",
                  status: "ready",
                  expires_at: expiresAt,
                  account_expires_at: expiresAt,
                  claim_expires_at: expiresAt,
                  claim_ciphertext: "encrypted",
                  policies_accepted_at: now,
                  created_at: now,
                  updated_at: now,
                },
              ],
            };
      }
      if (sql.includes("insert into cloudflare_temporary_previews")) {
        throw new Error("duplicate key value violates unique constraint");
      }
      if (sql.includes("last_error_code='provisioning_failed'")) return { rows: [] };
      throw new Error(`Unexpected concurrent provisioning query: ${sql}`);
    });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(
      service.provisionTemporaryAccount(context, {
        deploymentId: "deployment-1",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      }),
    ).resolves.toMatchObject({ id: "preview-winner", accountId: "winner-account" });
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
  });

  it("keeps one active preview per user when the membership context changes", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const switchedContext = { ...context, membershipId: "member-2" };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-2" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-2",
              app_id: "app-2",
              owner_user_id: context.userId,
              phase: "awaiting_target",
              target_kind: "unassigned",
              temporary_preview_id: null,
              manifest: {
                version: 1,
                runtime: "cloudflare-workers",
                exposure: { workersDev: true },
              },
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("with abandoned_previews")) return { rows: [], rowCount: 0 };
      if (sql.includes("update cloudflare_oauth_states")) return { rows: [], rowCount: 0 };
      if (sql.includes("status='ready' and expires_at")) {
        expect(sql).not.toContain("owner_membership_id");
        expect(values).toEqual([context.tenantId, context.userId, now.toISOString()]);
        return {
          rows: [
            {
              id: "preview-1",
              app_id: "app-1",
              tenant_id: context.tenantId,
              owner_user_id: context.userId,
              owner_membership_id: context.membershipId,
              account_id: "account-1",
              account_name: "Preview",
              status: "ready",
              expires_at: expiresAt,
              account_expires_at: expiresAt,
              claim_expires_at: expiresAt,
              claim_ciphertext: "encrypted",
              policies_accepted_at: now,
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      throw new Error(`Unexpected membership-switch query: ${sql}`);
    });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(
      service.provisionTemporaryAccount(switchedContext, {
        deploymentId: "deployment-2",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      }),
    ).rejects.toThrow(/already has an active Cloudflare temporary preview/);
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
  });

  it("discards only a preview that is still unreferenced after target selection fails", async () => {
    const credential = encryptSecret(
      JSON.stringify({ apiToken: "temporary-api-secret", tokenId: "token-1" }),
      masterKey,
      1,
      "apps-cloudflare:temporary:tenant-1:preview-1:credential",
    );
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("select p.* from cloudflare_temporary_previews")) {
        expect(sql).toContain("not exists");
        return {
          rows: [
            {
              id: "preview-1",
              account_id: "account-1",
              credential_ciphertext: credential.ciphertext,
              credential_iv: credential.iv,
              credential_auth_tag: credential.authTag,
              credential_key_version: credential.keyVersion,
            },
          ],
        };
      }
      if (sql.includes("last_error_code='target_selection_failed'")) {
        return { rows: [{ id: "preview-1" }] };
      }
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected preview release query: ${sql}`);
    });
    const client = clientFixture();
    client.discardTemporaryAccount = vi.fn().mockResolvedValue(undefined);
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      { ...enabled, client, masterKey: () => masterKey },
    );

    await expect(
      service.releaseUnassignedTemporaryAccount(context, "deployment-1", "preview-1"),
    ).resolves.toBe(true);
    expect(client.discardTemporaryAccount).toHaveBeenCalledWith({
      accountId: "account-1",
      apiToken: "temporary-api-secret",
    });
  });

  it.each([
    {
      label: "stateful resources",
      manifest: {
        version: 1,
        runtime: "cloudflare-workers",
        resources: { kv: [{ key: "cache" }] },
        exposure: { workersDev: true },
      },
    },
    {
      label: "a custom domain",
      manifest: {
        version: 1,
        runtime: "cloudflare-workers",
        exposure: { workersDev: true, requestedCustomDomain: "app.example.com" },
      },
    },
  ])("rejects $label before requesting a temporary Cloudflare account", async ({ manifest }) => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            owner_user_id: "user-1",
            phase: "awaiting_target",
            target_kind: "unassigned",
            manifest,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
    });

    await expect(
      service.provisionTemporaryAccount(context, {
        deploymentId: "deployment-1",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      }),
    ).rejects.toThrow(/temporary Cloudflare preview is unavailable/i);
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
  });

  it("rejects a rollback preview before requesting a temporary Cloudflare account", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-rollback",
            app_id: "app-1",
            owner_user_id: "user-1",
            phase: "awaiting_target",
            rollback_of_deployment_id: "deployment-old",
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
    });

    await expect(
      service.provisionTemporaryAccount(context, {
        deploymentId: "deployment-rollback",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      }),
    ).rejects.toThrow(/rollback requires.*OAuth BYOC/i);
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
  });

  it("requires Turnstile before a non-loopback temporary account request when enabled", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            owner_user_id: "user-1",
            phase: "awaiting_target",
            target_kind: "unassigned",
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] });
    const client = clientFixture();
    const verifyTurnstile = vi.fn().mockResolvedValue(false);
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      turnstileEnabled: () => true,
      verifyTurnstile,
    });

    await expect(
      service.provisionTemporaryAccount(context, {
        deploymentId: "deployment-1",
        ipAddress: "192.0.2.1",
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
        turnstileToken: "browser-proof",
      }),
    ).rejects.toThrow(/Turnstile verification failed/);
    expect(verifyTurnstile).toHaveBeenCalledWith("browser-proof", "192.0.2.1");
    expect(client.provisionTemporaryAccount).not.toHaveBeenCalled();
  });

  it("persists only hashed OAuth state and an encrypted PKCE verifier", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            app_generation: 1,
            owner_user_id: "user-1",
            phase: "awaiting_target",
            binding_manifest: { kv: [], d1: [], r2: [], durableObjects: [], exposure: {} },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ id: "deployment-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = clientFixture();
    let rawState = "";
    vi.mocked(client.authorizationUrl).mockImplementation((input) => {
      rawState = input.state;
      return `https://dash.cloudflare.com/oauth2/auth?state=${input.state}`;
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    const result = await service.startOAuth(context, {
      purpose: "direct",
      scope: "user",
      deploymentId: "deployment-1",
      returnPath: "/apps",
    });

    expect(result.authorizationUrl).toContain("https://dash.cloudflare.com/");
    expect(String(query.mock.calls[3][0])).toContain("update app_deployments d set phase=$1");
    expect(query.mock.calls[3][1]?.[0]).toBe("awaiting_oauth");
    const insert = query.mock.calls[4];
    const values = insert[1] as unknown[];
    expect(String(insert[0])).toContain("cloudflare_oauth_states");
    expect(values).not.toContain(rawState);
    expect(values[5]).toBe("direct");
    expect(values[10]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(values[11]).not.toContain(rawState);
    expect(values[15]).toBe(JSON.stringify(["provider.workers.write"]));
  });

  it("rejects a claim purpose without an exact temporary account binding", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            app_generation: 1,
            owner_user_id: "user-1",
            phase: "claim_pending",
            binding_manifest: { kv: [], d1: [], r2: [], durableObjects: [], exposure: {} },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
    });

    await expect(
      service.startOAuth(context, {
        purpose: "claim",
        scope: "user",
        deploymentId: "deployment-1",
      }),
    ).rejects.toThrow(/requires a temporary account/);
    expect(client.authorizationUrl).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into"))).toBe(false);
  });

  it("rejects receipt metadata that could persist credentials", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "member-1" }] });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });
    await expect(
      service.recordResourceReceipt(context, {
        appId: "app-1",
        deploymentId: "deployment-1",
        appGeneration: 1,
        leaseToken: "lease-1",
        logicalKey: "worker:main",
        resourceKind: "worker",
        mode: "create",
        ownership: "created",
        stepStatus: "ready",
        externalId: "worker-1",
        metadata: { apiToken: "must-not-persist" },
      }),
    ).rejects.toThrow(/forbidden secret field/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "a long bearer token in an error",
      errorMessage: "Cloudflare failed: Authorization: Bearer cf_access_1234567890abcdefghijklmnop",
      metadata: undefined,
    },
    {
      label: "a nested Cloudflare API token assignment",
      errorMessage: undefined,
      metadata: {
        response: { detail: "CLOUDFLARE_API_TOKEN=0123456789abcdefghijklmnopqrstuvwxyz" },
      },
    },
    {
      label: "a claim token embedded in a URL",
      errorMessage: undefined,
      metadata: {
        providerMessage: "https://dash.cloudflare.com/claim?claimToken=secret-value-123",
      },
    },
  ])("rejects $label before persisting a receipt", async ({ errorMessage, metadata }) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "member-1" }] });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });

    await expect(
      service.recordResourceReceipt(context, {
        appId: "app-1",
        deploymentId: "deployment-1",
        appGeneration: 1,
        leaseToken: "lease-1",
        logicalKey: "worker:main",
        resourceKind: "worker",
        mode: "create",
        ownership: "created",
        stepStatus: "failed",
        ...(errorMessage ? { errorMessage } : {}),
        ...(metadata ? { metadata } : {}),
      }),
    ).rejects.toThrow(/credential|secret/i);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects deployment phase skips before touching authoritative state", async () => {
    const query = vi.fn();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });

    await expect(
      service.transitionDeploymentPhase(context, {
        deploymentId: "deployment-1",
        appGeneration: 1,
        leaseToken: "lease-1",
        from: "queued",
        to: "ready",
      }),
    ).rejects.toThrow(/invalid App deployment phase transition/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("queues the deployment outbox atomically with target selection", async () => {
    const expiresAt = "2026-08-04T09:00:00.000Z";
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              owner_user_id: "user-1",
              phase: "awaiting_target",
              target_kind: "unassigned",
              rollback_of_deployment_id: null,
              idempotency_key: "deploy-idempotency",
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("from cloudflare_temporary_previews")) {
        return {
          rows: [
            {
              id: "preview-1",
              status: "ready",
              expires_at: expiresAt,
            },
          ],
        };
      }
      if (sql.includes("update app_deployments set target_kind")) {
        return { rows: [{ id: "deployment-1" }] };
      }
      if (sql.includes("update apps set target_kind")) return { rows: [{ id: "app-1" }] };
      if (sql.includes("insert into app_operation_outbox")) return { rows: [] };
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected target query: ${sql}`);
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      {
        ...enabled,
        client: clientFixture(),
        masterKey: () => masterKey,
        now: () => new Date("2026-08-04T08:00:00.000Z"),
      },
    );

    await expect(
      service.selectDeploymentTarget(context, "deployment-1", {
        target: "temporary",
        temporaryAccountId: "preview-1",
      }),
    ).resolves.toMatchObject({ phase: "queued", target: "temporary" });
    const outbox = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into app_operation_outbox"),
    );
    expect(outbox).toBeTruthy();
    const values = outbox?.[1] as unknown[];
    expect(values[3]).toBe("deploy");
    expect(JSON.parse(String(values[4]))).toEqual({
      userId: "user-1",
      membershipId: "member-1",
      deploymentId: "deployment-1",
      target: "temporary",
      connectionId: null,
      temporaryAccountId: "preview-1",
    });
    expect(values[5]).toBe(3);
    expect(values[6]).toBe("deploy-idempotency");
    expect(
      query.mock.calls.findIndex(([sql]) => String(sql).includes("update app_deployments")),
    ).toBeLessThan(
      query.mock.calls.findIndex(([sql]) =>
        String(sql).includes("insert into app_operation_outbox"),
      ),
    );
  });

  it("returns structured incremental OAuth requirements before selecting BYOC", async () => {
    const expandedScopes = [
      ...providerScopes,
      {
        name: CLOUDFLARE_PERMISSION_NAMES.workersKvStorageWrite,
        id: "provider.kv.write",
      },
    ];
    const expandedCatalog = parseCloudflareOAuthScopeCatalog({
      version: 1,
      source: CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
      generatedAt: "2026-08-04T08:00:00.000Z",
      scopes: expandedScopes,
      hash: hashCloudflareOAuthScopeEntries(expandedScopes),
    });
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              owner_user_id: "user-1",
              phase: "awaiting_target",
              target_kind: "unassigned",
              rollback_of_deployment_id: null,
              idempotency_key: "deploy-idempotency",
              binding_manifest: {
                kv: [{ key: "cache" }],
                d1: [],
                r2: [],
                durableObjects: [],
                exposure: {},
              },
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("select * from cloudflare_connections")) {
        return {
          rows: [
            {
              id: "connection-1",
              tenant_id: "tenant-1",
              scope: "user",
              owner_user_id: "user-1",
              granted_scopes: ["provider.workers.write"],
              status: "active",
            },
          ],
        };
      }
      throw new Error(`Unexpected BYOC preflight query: ${sql}`);
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      {
        ...enabled,
        scopeCatalog: () => expandedCatalog,
        client: clientFixture(),
        masterKey: () => masterKey,
      },
    );

    const error = await service
      .selectDeploymentTarget(context, "deployment-1", {
        target: "byoc",
        connectionId: "connection-1",
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppCloudflareNeedsOAuthError);
    expect(error).toMatchObject({
      code: "needs_oauth",
      requiredPermissionNames: [
        CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite,
        CLOUDFLARE_PERMISSION_NAMES.workersKvStorageWrite,
      ],
    });
    expect(JSON.stringify(error)).not.toMatch(/token|credential|cipher/i);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("app_operation_outbox"))).toBe(
      false,
    );
  });

  it("rejects temporary targets for rollback deployments before provisioning linkage", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-rollback",
              app_id: "app-1",
              app_generation: 4,
              owner_user_id: "user-1",
              phase: "awaiting_target",
              rollback_of_deployment_id: "deployment-old",
              idempotency_key: "rollback-idempotency",
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      throw new Error(`Unexpected rollback target query: ${sql}`);
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      { ...enabled, client: clientFixture(), masterKey: () => masterKey },
    );

    await expect(
      service.selectDeploymentTarget(context, "deployment-rollback", {
        target: "temporary",
        temporaryAccountId: "preview-1",
      }),
    ).rejects.toThrow(/rollback requires.*OAuth BYOC/i);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("app_operation_outbox"))).toBe(
      false,
    );
  });

  it("never resolves credentials for a stale App generation", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });

    await expect(
      service.resolveDeploymentCredential(context, "app-1", "deployment-1", 7),
    ).rejects.toThrow(/credential authority is stale/i);
    expect(query.mock.calls[1][1]).toEqual(["deployment-1", "app-1", 7, "tenant-1"]);
  });

  it("resolves creator-owned Temporary and BYOC credentials only from matching authority", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const temporarySecret = encryptSecret(
      JSON.stringify({ apiToken: "temporary-token", tokenId: "temporary-token-id" }),
      masterKey,
      1,
      "apps-cloudflare:temporary:tenant-1:preview-1:credential",
    );
    const oauthSecret = encryptSecret(
      JSON.stringify({
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T09:00:00.000Z",
      }),
      masterKey,
      1,
      "apps-cloudflare:connection:tenant-1:connection-1:credential",
    );
    const connection = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write"],
      status: "active",
      credential_ciphertext: oauthSecret.ciphertext,
      credential_iv: oauthSecret.iv,
      credential_auth_tag: oauthSecret.authTag,
      credential_key_version: oauthSecret.keyVersion,
      access_expires_at: "2026-08-04T09:00:00.000Z",
    };
    const temporary = {
      id: "preview-1",
      app_id: "app-1",
      tenant_id: "tenant-1",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "temporary-account-1",
      status: "ready",
      expires_at: "2026-08-04T09:00:00.000Z",
      credential_ciphertext: temporarySecret.ciphertext,
      credential_iv: temporarySecret.iv,
      credential_auth_tag: temporarySecret.authTag,
      credential_key_version: temporarySecret.keyVersion,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 7,
              generation: 7,
              target_kind: "temporary",
              temporary_preview_id: "preview-1",
              binding_manifest: {},
            },
          ],
        };
      }
      if (sql.includes("from cloudflare_temporary_previews")) return { rows: [temporary] };
      if (sql.includes("from cloudflare_connections")) return { rows: [connection] };
      if (sql.includes("from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              owner_user_id: "user-1",
              target_kind: "byoc",
              cloudflare_connection_id: "connection-1",
            },
          ],
        };
      }
      if (sql.includes("scoped_role_assignments")) return { rows: [{ allowed: true }] };
      throw new Error(`Unexpected credential query: ${sql}`);
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(
      service.resolveDeploymentCredential(context, "app-1", "deployment-1", 7),
    ).resolves.toEqual({
      target: "temporary",
      accountId: "temporary-account-1",
      apiToken: "temporary-token",
      connectionId: null,
      temporaryAccountId: "preview-1",
      expiresAt: "2026-08-04T09:00:00.000Z",
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 7,
              generation: 7,
              target_kind: "byoc",
              cloudflare_connection_id: "connection-1",
              binding_manifest: {},
            },
          ],
        };
      }
      if (sql.includes("from cloudflare_connections")) return { rows: [connection] };
      if (sql.includes("from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              owner_user_id: "user-1",
              target_kind: "byoc",
              cloudflare_connection_id: "connection-1",
            },
          ],
        };
      }
      if (sql.includes("scoped_role_assignments")) return { rows: [{ allowed: true }] };
      throw new Error(`Unexpected BYOC credential query: ${sql}`);
    });

    await expect(
      service.resolveDeploymentCredential(context, "app-1", "deployment-1", 7),
    ).resolves.toMatchObject({
      target: "byoc",
      accountId: "account-1",
      apiToken: "oauth-access-token",
      connectionId: "connection-1",
      temporaryAccountId: null,
    });
    await expect(
      service.resolveConnectionCredential(context, "app-1", "connection-1"),
    ).resolves.toMatchObject({
      target: "byoc",
      accountId: "account-1",
      apiToken: "oauth-access-token",
      connectionId: "connection-1",
    });
  });

  it("single-flights concurrent refreshes and rotates credentials with a DB CAS", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const oldCredential = encryptSecret(
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T08:01:00.000Z",
      }),
      masterKey,
      1,
      "apps-cloudflare:connection:tenant-1:connection-1:credential",
    );
    const oldRow = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write"],
      status: "refresh_required",
      credential_ciphertext: oldCredential.ciphertext,
      credential_iv: oldCredential.iv,
      credential_auth_tag: oldCredential.authTag,
      credential_key_version: oldCredential.keyVersion,
      access_expires_at: "2026-08-04T08:01:00.000Z",
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("select * from cloudflare_connections")) return { rows: [oldRow] };
      if (sql.includes("update cloudflare_connections set account_name")) {
        return {
          rows: [
            {
              ...oldRow,
              account_name: "Refreshed Account",
              status: "active",
              credential_ciphertext: values?.[2],
              credential_iv: values?.[3],
              credential_auth_tag: values?.[4],
              credential_key_version: values?.[5],
              access_expires_at: "2026-08-04T09:00:00.000Z",
              updated_at: now,
            },
          ],
        };
      }
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected refresh query: ${sql}`);
    });
    let finishRefresh!: (
      value: Awaited<ReturnType<AppCloudflareAccountClient["refreshAccessToken"]>>,
    ) => void;
    const refreshResult = new Promise<
      Awaited<ReturnType<AppCloudflareAccountClient["refreshAccessToken"]>>
    >((resolve) => {
      finishRefresh = resolve;
    });
    const client = clientFixture();
    vi.mocked(client.refreshAccessToken).mockReturnValue(refreshResult);
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    const first = service.refreshConnection(context, "connection-1");
    const second = service.refreshConnection(context, "connection-1");
    await vi.waitFor(() => expect(client.refreshAccessToken).toHaveBeenCalledTimes(1));
    finishRefresh({
      accountId: "account-1",
      accountName: "Refreshed Account",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ id: "connection-1", status: "active" }),
      expect.objectContaining({ id: "connection-1", status: "active" }),
    ]);
    expect(client.refreshAccessToken).toHaveBeenCalledTimes(1);
    const rotation = query.mock.calls.find(([sql]) =>
      String(sql).includes("update cloudflare_connections set account_name"),
    );
    expect(String(rotation?.[0])).toContain("credential_ciphertext=$11");
    expect(String(rotation?.[0])).toContain("credential_key_version=$14");
    expect(rotation?.[1]?.[10]).toBe(oldCredential.ciphertext);
    expect(rotation?.[1]?.[13]).toBe(oldCredential.keyVersion);
  });

  it("does not overwrite a newer refresh token when the credential CAS loses", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const aad = "apps-cloudflare:connection:tenant-1:connection-1:credential";
    const oldCredential = encryptSecret(
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T08:01:00.000Z",
      }),
      masterKey,
      1,
      aad,
    );
    const newerCredential = encryptSecret(
      JSON.stringify({
        accessToken: "winner-access",
        refreshToken: "winner-refresh",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T10:00:00.000Z",
      }),
      masterKey,
      1,
      aad,
    );
    const baseRow = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write"],
      status: "refresh_required",
      credential_ciphertext: oldCredential.ciphertext,
      credential_iv: oldCredential.iv,
      credential_auth_tag: oldCredential.authTag,
      credential_key_version: oldCredential.keyVersion,
      access_expires_at: "2026-08-04T08:01:00.000Z",
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
    let connectionReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("select * from cloudflare_connections")) {
        connectionReads += 1;
        return connectionReads === 1
          ? { rows: [baseRow] }
          : {
              rows: [
                {
                  ...baseRow,
                  account_name: "Winner Account",
                  status: "active",
                  credential_ciphertext: newerCredential.ciphertext,
                  credential_iv: newerCredential.iv,
                  credential_auth_tag: newerCredential.authTag,
                  credential_key_version: newerCredential.keyVersion,
                  access_expires_at: "2026-08-04T10:00:00.000Z",
                },
              ],
            };
      }
      if (sql.includes("update cloudflare_connections set account_name")) return { rows: [] };
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected stale refresh query: ${sql}`);
    });
    const client = clientFixture();
    vi.mocked(client.refreshAccessToken).mockResolvedValue({
      accountId: "account-1",
      accountName: "Losing Account",
      accessToken: "losing-access",
      refreshToken: "losing-refresh",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.refreshConnection(context, "connection-1")).resolves.toMatchObject({
      accountName: "Winner Account",
      status: "active",
    });
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes("set account_name")),
    ).toHaveLength(1);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("insert into cloudflare_connections")),
    ).toBe(false);
  });

  it("moves a temporary deployment to claim_pending with an idempotent owner-scoped CAS", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const claim = encryptSecret(
      JSON.stringify({ claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=secret" }),
      masterKey,
      1,
      "apps-cloudflare:temporary:tenant-1:preview-1:claim",
    );
    let bindingReads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_temporary_previews")) {
        return {
          rows: [
            {
              id: "preview-1",
              app_id: "app-1",
              tenant_id: "tenant-1",
              owner_user_id: "user-1",
              owner_membership_id: "member-1",
              status: "claiming",
              expires_at: expiresAt,
              claim_ciphertext: claim.ciphertext,
              claim_iv: claim.iv,
              claim_auth_tag: claim.authTag,
              claim_key_version: claim.keyVersion,
            },
          ],
        };
      }
      if (sql.includes("from app_deployments d")) {
        bindingReads += 1;
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              phase: bindingReads === 1 ? "temporary_ready" : "claim_pending",
              stable_url: "https://preview.example",
              current_deployment_id: null,
            },
          ],
        };
      }
      if (sql.includes("set phase='claim_pending'")) return { rows: [{ id: "deployment-1" }] };
      if (sql.includes("set status='claiming'") || sql.includes("control_plane_audit_log")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected claim query: ${sql}`);
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      {
        ...enabled,
        client: clientFixture(),
        masterKey: () => masterKey,
        now: () => now,
      },
    );

    await expect(service.getTemporaryClaimUrl(context, "preview-1")).resolves.toMatchObject({
      expiresAt,
    });
    await expect(service.getTemporaryClaimUrl(context, "preview-1")).resolves.toMatchObject({
      expiresAt,
    });
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes("set phase='claim_pending'")),
    ).toHaveLength(1);
    expect(
      query.mock.calls.find(([sql]) => String(sql).includes("owner_membership_id=$4")),
    ).toBeTruthy();
  });

  it("binds OAuth state to the original user and never exchanges a stolen callback", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) {
        return {
          rows: [
            {
              id: "oauth-1",
              tenant_id: "tenant-1",
              user_id: "another-user",
              membership_id: "another-member",
              status: "pending",
              consumed_at: null,
              expires_at: "2026-08-04T08:10:00.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const cloudflare = clientFixture();
    const service = new AppCloudflareAccountService(pool, {
      ...enabled,
      client: cloudflare,
      masterKey: () => masterKey,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    await expect(service.finishOAuth(context, { state: "stolen", code: "code" })).rejects.toThrow(
      /state is invalid/,
    );
    expect(cloudflare.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("commits expiry cleanup before rejecting an expired one-time OAuth state", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) {
        return {
          rows: [
            {
              id: "oauth-1",
              tenant_id: "tenant-1",
              user_id: "user-1",
              membership_id: "member-1",
              purpose: "direct",
              status: "pending",
              consumed_at: null,
              expires_at: "2026-08-04T07:59:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("set status='expired'")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() };
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      {
        ...enabled,
        client: clientFixture(),
        masterKey: () => masterKey,
        now: () => new Date("2026-08-04T08:00:00.000Z"),
      },
    );

    await expect(service.finishOAuth(context, { state: "expired", code: "code" })).rejects.toThrow(
      /state has expired/,
    );
    expect(clientQuery).toHaveBeenCalledWith("commit");
    expect(
      clientQuery.mock.calls.some(([sql]) => String(sql).includes("verifier_ciphertext=null")),
    ).toBe(true);
  });

  it.each([
    {
      purpose: "direct" as const,
      temporaryAccountId: null,
      initialPhase: "awaiting_oauth",
      retryPhase: "awaiting_oauth",
    },
    {
      purpose: "claim" as const,
      temporaryAccountId: "preview-1",
      initialPhase: "claim_pending",
      retryPhase: "claim_pending",
    },
  ])(
    "keeps a cancelled $purpose OAuth deployment retryable",
    async ({ purpose, temporaryAccountId, initialPhase, retryPhase }) => {
      const query = vi.fn(async (sql: string, _values?: unknown[]) => {
        if (sql === "begin" || sql === "commit") return { rows: [] };
        if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
        if (sql.includes("from cloudflare_oauth_states")) {
          return {
            rows: [
              {
                id: `oauth-${purpose}`,
                tenant_id: "tenant-1",
                user_id: "user-1",
                membership_id: "member-1",
                purpose,
                temporary_account_id: temporaryAccountId,
                app_id: "app-1",
                deployment_id: "deployment-1",
                app_generation: 3,
                status: "pending",
                consumed_at: null,
                return_path: "/apps",
              },
            ],
          };
        }
        if (sql.includes("select d.id,d.app_id,d.app_generation")) {
          return {
            rows: [
              {
                id: "deployment-1",
                app_id: "app-1",
                app_generation: 3,
                phase: initialPhase,
                temporary_preview_id: temporaryAccountId,
              },
            ],
          };
        }
        if (sql.includes("update app_deployments set phase=$1")) {
          return { rows: [{ id: "deployment-1" }] };
        }
        if (
          sql.includes("update apps set status='needs_action'") ||
          sql.includes("update cloudflare_oauth_states") ||
          sql.includes("control_plane_audit_log")
        ) {
          return { rows: [] };
        }
        throw new Error(`Unexpected OAuth cancel query: ${sql}`);
      });
      const service = new AppCloudflareAccountService(
        { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
        { ...enabled, client: clientFixture(), masterKey: () => masterKey },
      );

      await expect(service.cancelOAuth(context, `state-${purpose}`)).resolves.toEqual({
        returnPath: "/apps",
      });
      const deploymentUpdate = query.mock.calls.find(([sql]) =>
        String(sql).includes("error_code='oauth_cancelled'"),
      );
      expect(deploymentUpdate?.[1]?.[0]).toBe(retryPhase);
      expect(
        query.mock.calls.some(
          ([sql]) =>
            String(sql).includes("status='needs_action'") &&
            String(sql).includes("status_reason=$1"),
        ),
      ).toBe(true);
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes("last_error_code='oauth_cancelled'")),
      ).toBe(true);
    },
  );

  it("expires preview authority, linked deployments, and the current App atomically", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "preview-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });

    await expect(service.cleanupExpired()).resolves.toEqual({
      temporaryAccounts: 1,
      oauthAttempts: 0,
    });
    const expirySql = String(query.mock.calls[0][0]);
    expect(expirySql).toContain("last_error_code='provisioning_abandoned'");
    expect(expirySql).toContain("expired_previews as");
    expect(expirySql).toContain("update app_deployments d set phase='expired',stable_url=null");
    expect(expirySql).toContain("error_code='temporary_account_expired'");
    expect(expirySql).toContain("update apps a set status='needs_action'");
    expect(expirySql).toContain("stable_url=null,target_kind='unassigned'");
  });

  it("expires a due preview before projecting deployment state to the browser", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "preview-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            version: 1,
            phase: "expired",
            target_kind: "temporary",
            source_digest: "a".repeat(64),
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true, requestedCustomDomain: "app.example.com" },
            },
            cloudflare_version_id: "version-1",
            stable_url: null,
            error_code: "temporary_account_expired",
            error_message: "Cloudflare temporary account expired.",
            created_by: "user-1",
            created_at: now,
            deployed_at: now,
            current_deployment_id: "deployment-1",
            preview_id: "preview-1",
            preview_expires_at: "2026-08-04T07:59:00.000Z",
            preview_claim_expires_at: "2026-08-04T07:59:00.000Z",
            preview_claim_ciphertext: null,
            preview_status: "expired",
            preview_owner_user_id: "user-1",
            preview_owner_membership_id: "member-1",
          },
        ],
      });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.getDeployment(context, "deployment-1")).resolves.toMatchObject({
      phase: "expired",
      stableUrl: null,
      errorCode: "temporary_account_expired",
      requestedCustomDomain: "app.example.com",
      temporaryPreview: { id: "preview-1", claimAvailable: false },
    });
    expect(String(query.mock.calls[1][0])).toContain("expired_previews as");
    expect(String(query.mock.calls[3][0])).toContain("from app_deployments d join apps a");
  });

  it("projects a temporary account mismatch as retryable claim_pending history", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "member-1" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "deployment-1",
            app_id: "app-1",
            version: 1,
            phase: "claim_pending",
            target_kind: "temporary",
            source_digest: "a".repeat(64),
            manifest: {
              version: 1,
              runtime: "cloudflare-workers",
              exposure: { workersDev: true },
            },
            stable_url: "https://preview.example",
            error_code: "temporary_account_mismatch",
            error_message: "Select the claimed account.",
            created_by: "user-1",
            created_at: now,
            deployed_at: now,
            current_deployment_id: "deployment-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "audit-1",
            action: "app.cloudflare.temporary.account_mismatch",
            created_at: now,
          },
        ],
      });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.listDeploymentEvents(context, "deployment-1")).resolves.toEqual([
      {
        id: "audit-1",
        deploymentId: "deployment-1",
        phase: "claim_pending",
        timestamp: now.toISOString(),
        code: null,
      },
    ]);
  });

  it("rejects a persisted OAuth purpose/account mismatch before token exchange", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) {
        return {
          rows: [
            {
              id: "oauth-1",
              tenant_id: "tenant-1",
              user_id: "user-1",
              membership_id: "member-1",
              purpose: "direct",
              temporary_account_id: "preview-1",
              status: "pending",
              consumed_at: null,
              expires_at: "2026-08-04T08:10:00.000Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() };
    const cloudflare = clientFixture();
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      {
        ...enabled,
        client: cloudflare,
        masterKey: () => masterKey,
        now: () => new Date("2026-08-04T08:00:00.000Z"),
      },
    );

    await expect(service.finishOAuth(context, { state: "state", code: "code" })).rejects.toThrow(
      /purpose binding is invalid/,
    );
    expect(cloudflare.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("restores a direct OAuth deployment as BYOC queued with a durable outbox", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const verifier = encryptSecret(
      JSON.stringify({ verifier: "pkce-verifier" }),
      masterKey,
      1,
      "apps-cloudflare:oauth:tenant-1:oauth-direct:verifier",
    );
    const oauthRow = {
      id: "oauth-direct",
      tenant_id: "tenant-1",
      user_id: "user-1",
      membership_id: "member-1",
      connection_scope: "user",
      purpose: "direct",
      app_id: "app-1",
      deployment_id: "deployment-1",
      app_generation: 3,
      temporary_account_id: null,
      status: "pending",
      consumed_at: null,
      expires_at: "2026-08-04T08:10:00.000Z",
      redirect_uri: "https://piwork.example/api/apps/cloudflare/oauth/callback",
      return_path: "/apps",
      requested_scopes: ["provider.workers.write"],
      requested_scope_names: [CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite],
      verifier_ciphertext: verifier.ciphertext,
      verifier_iv: verifier.iv,
      verifier_auth_tag: verifier.authTag,
      verifier_key_version: verifier.keyVersion,
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) return { rows: [oauthRow] };
      if (sql.includes("set status='exchanging'")) return { rows: [] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              phase: "awaiting_oauth",
              rollback_of_deployment_id: null,
              idempotency_key: "deploy-idempotency",
            },
          ],
        };
      }
      if (sql.includes("select id from cloudflare_connections")) return { rows: [] };
      if (sql.includes("insert into cloudflare_connections")) {
        return {
          rows: [
            {
              id: values?.[0],
              tenant_id: "tenant-1",
              scope: "user",
              owner_user_id: "user-1",
              owner_membership_id: "member-1",
              account_id: "account-1",
              account_name: "Account",
              granted_scopes: ["provider.workers.write"],
              status: "active",
              access_expires_at: "2026-08-04T09:00:00.000Z",
              last_refreshed_at: now,
              created_at: now,
              updated_at: now,
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.includes("phase='queued',target_kind='byoc'")) {
        return { rows: [{ id: "deployment-1" }] };
      }
      if (sql.includes("update apps set target_kind='byoc'")) {
        return { rows: [{ id: "app-1" }] };
      }
      if (sql.includes("insert into app_operation_outbox")) return { rows: [] };
      if (sql.includes("set status='completed'")) return { rows: [{ id: "oauth-direct" }] };
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected direct OAuth query: ${sql}`);
    });
    const cloudflare = clientFixture();
    vi.mocked(cloudflare.exchangeAuthorizationCode).mockResolvedValue({
      accountId: "account-1",
      accountName: "Account",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      {
        ...enabled,
        client: cloudflare,
        masterKey: () => masterKey,
        now: () => now,
      },
    );

    await expect(
      service.finishOAuth(context, { state: "state", code: "code" }),
    ).resolves.toMatchObject({
      returnPath: "/apps",
      connection: { accountId: "account-1" },
    });
    const outbox = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into app_operation_outbox"),
    );
    expect(outbox).toBeTruthy();
    expect(JSON.parse(String(outbox?.[1]?.[4]))).toEqual({
      userId: "user-1",
      membershipId: "member-1",
      deploymentId: "deployment-1",
      target: "byoc",
      connectionId: expect.any(String),
      temporaryAccountId: null,
    });
    expect(outbox?.[1]?.[6]).toBe("deploy-idempotency");
  });

  it("allows claim OAuth to retry against the retained temporary preview", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const credential = encryptSecret(
      JSON.stringify({ apiToken: "temporary-api-secret", tokenId: "token-1" }),
      masterKey,
      1,
      "apps-cloudflare:temporary:tenant-1:preview-1:credential",
    );
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              owner_user_id: "user-1",
              phase: "claim_pending",
              temporary_preview_id: "preview-1",
              binding_manifest: { kv: [], d1: [], r2: [], durableObjects: [], exposure: {} },
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("from cloudflare_temporary_previews")) {
        return {
          rows: [
            {
              id: "preview-1",
              status: "claiming",
              expires_at: "2026-08-04T08:30:00.000Z",
              credential_ciphertext: credential.ciphertext,
              credential_iv: credential.iv,
              credential_auth_tag: credential.authTag,
              credential_key_version: credential.keyVersion,
            },
          ],
        };
      }
      if (sql.includes("update app_deployments d set phase=$1")) {
        return { rows: [{ id: "deployment-1" }] };
      }
      if (sql.includes("insert into cloudflare_oauth_states")) return { rows: [] };
      throw new Error(`Unexpected claim retry query: ${sql}`);
    });
    const client = clientFixture();
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(
      service.startOAuth(context, {
        purpose: "claim",
        scope: "user",
        deploymentId: "deployment-1",
        temporaryAccountId: "preview-1",
      }),
    ).resolves.toMatchObject({ authorizationUrl: expect.stringContaining("dash.cloudflare.com") });
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into cloudflare_oauth_states"),
    );
    expect(insert?.[1]?.[5]).toBe("claim");
    expect(insert?.[1]?.[9]).toBe("preview-1");
  });

  it("normalizes a successful claim to one BYOC connection without redeploying", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const verifier = encryptSecret(
      JSON.stringify({ verifier: "pkce-verifier" }),
      masterKey,
      1,
      "apps-cloudflare:oauth:tenant-1:oauth-claim:verifier",
    );
    const oauthRow = {
      id: "oauth-claim",
      tenant_id: "tenant-1",
      user_id: "user-1",
      membership_id: "member-1",
      connection_scope: "user",
      purpose: "claim",
      app_id: "app-1",
      deployment_id: "deployment-1",
      app_generation: 3,
      temporary_account_id: "preview-1",
      status: "pending",
      consumed_at: null,
      expires_at: "2026-08-04T08:10:00.000Z",
      redirect_uri: "https://piwork.example/api/apps/cloudflare/oauth/callback",
      return_path: "/apps",
      requested_scopes: ["provider.workers.write"],
      requested_scope_names: [CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite],
      verifier_ciphertext: verifier.ciphertext,
      verifier_iv: verifier.iv,
      verifier_auth_tag: verifier.authTag,
      verifier_key_version: verifier.keyVersion,
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) return { rows: [oauthRow] };
      if (sql.includes("set status='exchanging'")) return { rows: [] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 3,
              phase: "claim_pending",
            },
          ],
        };
      }
      if (sql.includes("from cloudflare_temporary_previews")) {
        return { rows: [{ id: "preview-1", account_id: "account-1" }] };
      }
      if (sql.includes("set phase='verifying_claim'")) {
        return { rows: [{ id: "deployment-1" }] };
      }
      if (sql.includes("select id from cloudflare_connections")) return { rows: [] };
      if (sql.includes("insert into cloudflare_connections")) {
        return {
          rows: [
            {
              id: values?.[0],
              tenant_id: "tenant-1",
              scope: "user",
              owner_user_id: "user-1",
              owner_membership_id: "member-1",
              account_id: "account-1",
              account_name: "Account",
              granted_scopes: ["provider.workers.write"],
              status: "active",
              access_expires_at: "2026-08-04T09:00:00.000Z",
              last_refreshed_at: now,
              created_at: now,
              updated_at: now,
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.includes("update cloudflare_temporary_previews set status='claimed'")) {
        return { rows: [{ id: "preview-1" }] };
      }
      if (sql.includes("phase='ready',target_kind='byoc'")) {
        expect(sql).toContain("temporary_preview_id=null");
        return { rows: [{ id: "deployment-1" }] };
      }
      if (sql.includes("update apps set target_kind='byoc'")) {
        return { rows: [{ id: "app-1" }] };
      }
      if (sql.includes("set status='completed'")) return { rows: [{ id: "oauth-claim" }] };
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected successful claim query: ${sql}`);
    });
    const cloudflare = clientFixture();
    vi.mocked(cloudflare.exchangeAuthorizationCode).mockResolvedValue({
      accountId: "account-1",
      accountName: "Account",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    const service = new AppCloudflareAccountService(
      { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool,
      { ...enabled, client: cloudflare, masterKey: () => masterKey, now: () => now },
    );

    await expect(
      service.finishOAuth(context, { state: "state", code: "code" }),
    ).resolves.toMatchObject({
      connection: { accountId: "account-1" },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("app_operation_outbox"))).toBe(
      false,
    );
  });

  it("fails closed when OAuth selects a different account than the temporary preview", async () => {
    const verifier = encryptSecret(
      JSON.stringify({ verifier: "pkce-verifier" }),
      masterKey,
      1,
      "apps-cloudflare:oauth:tenant-1:oauth-1:verifier",
    );
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_oauth_states")) {
        return {
          rows: [
            {
              id: "oauth-1",
              tenant_id: "tenant-1",
              user_id: "user-1",
              membership_id: "member-1",
              connection_scope: "user",
              purpose: "claim",
              app_id: "app-1",
              deployment_id: "deployment-1",
              app_generation: 1,
              temporary_account_id: "preview-1",
              status: "pending",
              consumed_at: null,
              expires_at: "2026-08-04T08:10:00.000Z",
              redirect_uri: "https://piwork.example/api/apps/cloudflare/oauth/callback",
              return_path: "/apps",
              requested_scopes: ["provider.workers.write"],
              requested_scope_names: [CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite],
              verifier_ciphertext: verifier.ciphertext,
              verifier_iv: verifier.iv,
              verifier_auth_tag: verifier.authTag,
              verifier_key_version: verifier.keyVersion,
            },
          ],
        };
      }
      if (sql.includes("status='exchanging'")) return { rows: [] };
      if (sql.includes("from app_deployments d join apps a")) {
        return {
          rows: [
            {
              id: "deployment-1",
              app_id: "app-1",
              app_generation: 1,
              phase: "claim_pending",
              current_app_generation: 1,
              current_deployment_id: null,
            },
          ],
        };
      }
      if (sql.includes("from cloudflare_temporary_previews")) {
        return { rows: [{ account_id: "temporary-account" }] };
      }
      if (
        sql.includes("temporary_account_mismatch") ||
        sql.includes("update apps set") ||
        sql.includes("control_plane_audit_log")
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    });
    const cloudflare = clientFixture();
    vi.mocked(cloudflare.exchangeAuthorizationCode).mockResolvedValue({
      accountId: "different-account",
      accountName: "Different Account",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    const service = new AppCloudflareAccountService(
      {
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
      } as unknown as Pool,
      {
        ...enabled,
        client: cloudflare,
        masterKey: () => masterKey,
        now: () => new Date("2026-08-04T08:00:00.000Z"),
      },
    );

    await expect(service.finishOAuth(context, { state: "state", code: "code" })).rejects.toThrow(
      /does not match the temporary preview/,
    );
    expect(cloudflare.revokeToken).toHaveBeenCalledWith("access-secret");
    expect(
      clientQuery.mock.calls.some(([sql]) => String(sql).includes("temporary_account_mismatch")),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(
        ([sql]) =>
          String(sql).includes("owner_membership_id=$5") &&
          String(sql).includes("from cloudflare_temporary_previews"),
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(
        ([sql]) =>
          String(sql).includes("set phase='claim_pending'") &&
          String(sql).includes("temporary_account_mismatch"),
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(
        ([sql]) =>
          String(sql).includes("status='needs_action'") &&
          String(sql).includes("temporary_preview_id=$5"),
      ),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("update cloudflare_temporary_previews"),
      ),
    ).toBe(false);
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("insert into cloudflare_connections"),
      ),
    ).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("status='completed'"))).toBe(
      false,
    );
  });

  it("projects only scoped connection and temporary-account metadata", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const connectionCredential = encryptSecret(
      JSON.stringify({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write", "provider.zone.read"],
        accessExpiresAt: "2026-08-04T09:00:00.000Z",
      }),
      masterKey,
      1,
      "apps-cloudflare:connection:tenant-1:connection-1:credential",
    );
    const connectionRow = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write", "provider.zone.read"],
      status: "active",
      access_expires_at: "2026-08-04T09:00:00.000Z",
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
      revoked_at: null,
      credential_ciphertext: connectionCredential.ciphertext,
      credential_iv: connectionCredential.iv,
      credential_auth_tag: connectionCredential.authTag,
      credential_key_version: connectionCredential.keyVersion,
    };
    const temporaryRow = {
      id: "preview-1",
      app_id: "app-1",
      tenant_id: "tenant-1",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "temporary-account",
      account_name: "Temporary",
      status: "ready",
      account_expires_at: "2026-08-04T08:30:00.000Z",
      claim_expires_at: "2026-08-04T08:20:00.000Z",
      expires_at: "2026-08-04T08:20:00.000Z",
      claim_ciphertext: "claim-ciphertext",
      claim_iv: "claim-iv",
      claim_auth_tag: "claim-auth-tag",
      claimed_connection_id: null,
      policies_accepted_at: now,
      created_at: now,
      updated_at: now,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("with abandoned_previews")) return { rows: [], rowCount: 0 };
      if (sql.includes("update cloudflare_oauth_states")) return { rows: [], rowCount: 0 };
      if (sql.includes("from cloudflare_connections where id")) {
        return { rows: [connectionRow] };
      }
      if (sql.includes("from cloudflare_connections") && sql.includes("where tenant_id")) {
        return { rows: [connectionRow] };
      }
      if (sql.includes("from cloudflare_temporary_previews")) {
        return { rows: [temporaryRow] };
      }
      throw new Error(`Unexpected projection query: ${sql}`);
    });
    const client = clientFixture();
    vi.mocked(client.listZones).mockResolvedValue([
      { id: "zone-1", name: "example.com", status: "active" },
    ]);
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.listConnections(context)).resolves.toMatchObject([
      { id: "connection-1", accountId: "account-1", status: "active" },
    ]);
    await expect(service.getConnection(context, "connection-1")).resolves.toMatchObject({
      id: "connection-1",
      grantedScopes: ["provider.workers.write", "provider.zone.read"],
    });
    await expect(service.listConnectionZones(context, "connection-1")).resolves.toEqual([
      { id: "zone-1", name: "example.com", status: "active" },
    ]);
    expect(client.listZones).toHaveBeenCalledWith("access-secret");
    await expect(service.listTemporaryAccounts(context)).resolves.toMatchObject([
      {
        id: "preview-1",
        accountId: "temporary-account",
        claimAvailable: true,
        ownerMembershipId: "member-1",
      },
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("access-secret");
  });

  it("rejects stale connection authority and refreshes an expiring credential", async () => {
    const staleQuery = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              owner_user_id: "user-1",
              target_kind: "unassigned",
              cloudflare_connection_id: null,
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      throw new Error(`Unexpected stale connection query: ${sql}`);
    });
    const staleService = new AppCloudflareAccountService({ query: staleQuery } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
    });
    await expect(
      staleService.resolveConnectionCredential(context, "app-1", "connection-1"),
    ).rejects.toThrow(/connection authority is stale/i);

    const now = new Date("2026-08-04T08:00:00.000Z");
    const oldCredential = encryptSecret(
      JSON.stringify({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T08:00:30.000Z",
      }),
      masterKey,
      1,
      "apps-cloudflare:connection:tenant-1:connection-1:credential",
    );
    const oldConnection = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write"],
      status: "active",
      credential_ciphertext: oldCredential.ciphertext,
      credential_iv: oldCredential.iv,
      credential_auth_tag: oldCredential.authTag,
      credential_key_version: oldCredential.keyVersion,
      access_expires_at: "2026-08-04T08:00:30.000Z",
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
    let connectionReads = 0;
    let refreshedConnection: typeof oldConnection | undefined;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from apps where")) {
        return {
          rows: [
            {
              id: "app-1",
              owner_user_id: "user-1",
              target_kind: "byoc",
              cloudflare_connection_id: "connection-1",
            },
          ],
        };
      }
      if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
      if (sql.includes("select * from cloudflare_connections")) {
        connectionReads += 1;
        if (connectionReads === 1) return { rows: [oldConnection] };
        return { rows: [refreshedConnection || oldConnection] };
      }
      if (sql.includes("update cloudflare_connections set account_name")) {
        refreshedConnection = {
          ...oldConnection,
          account_name: "Refreshed Account",
          access_expires_at: "2026-08-04T09:00:00.000Z",
          credential_ciphertext: String(values?.[2]),
          credential_iv: String(values?.[3]),
          credential_auth_tag: String(values?.[4]),
          credential_key_version: Number(values?.[5]),
        };
        return { rows: [refreshedConnection] };
      }
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected refresh-on-resolve query: ${sql}`);
    });
    const client = clientFixture();
    vi.mocked(client.refreshAccessToken).mockResolvedValue({
      accountId: "account-1",
      accountName: "Refreshed Account",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      grantedScopes: ["provider.workers.write"],
      accessExpiresAt: "2026-08-04T09:00:00.000Z",
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });
    await expect(
      service.resolveConnectionCredential(context, "app-1", "connection-1"),
    ).resolves.toMatchObject({
      target: "byoc",
      accountId: "account-1",
      apiToken: "new-access",
      connectionId: "connection-1",
    });
    expect(client.refreshAccessToken).toHaveBeenCalledWith("old-refresh", [
      "provider.workers.write",
    ]);
  });

  it("revokes a connection and clears App targets after remote confirmation", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const credential = encryptSecret(
      JSON.stringify({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenType: "Bearer",
        grantedScopes: ["provider.workers.write"],
        accessExpiresAt: "2026-08-04T09:00:00.000Z",
      }),
      masterKey,
      1,
      "apps-cloudflare:connection:tenant-1:connection-1:credential",
    );
    const connection = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      account_id: "account-1",
      account_name: "Account",
      granted_scopes: ["provider.workers.write"],
      status: "active",
      credential_ciphertext: credential.ciphertext,
      credential_iv: credential.iv,
      credential_auth_tag: credential.authTag,
      credential_key_version: credential.keyVersion,
      access_expires_at: "2026-08-04T09:00:00.000Z",
      last_refreshed_at: now,
      created_at: now,
      updated_at: now,
      revoked_at: null,
    };
    const initialQuery = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from cloudflare_connections where id")) return { rows: [connection] };
      throw new Error(`Unexpected revoke query: ${sql}`);
    });
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.includes("cloudflare_connections set status='revoked'")) return { rows: [] };
      if (sql.includes("update apps set target_kind='unassigned'")) return { rows: [] };
      if (sql.includes("control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected revoke transaction query: ${sql}`);
    });
    const client = clientFixture();
    const pool = {
      query: initialQuery,
      connect: vi.fn().mockResolvedValue({ query: transactionQuery, release: vi.fn() }),
    } as unknown as Pool;
    const service = new AppCloudflareAccountService(pool, {
      ...enabled,
      client,
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.revokeConnection(context, "connection-1")).resolves.toBeUndefined();
    expect(client.revokeToken).toHaveBeenCalledWith("access-secret");
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("credential_ciphertext=null"),
      ),
    ).toBe(true);
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("temporary_preview_id=null"),
      ),
    ).toBe(true);
  });

  it("sets and reads unassigned, temporary, and BYOC App targets", async () => {
    const app = { id: "app-1", tenant_id: "tenant-1", owner_user_id: "user-1" };
    const connection = {
      id: "connection-1",
      tenant_id: "tenant-1",
      scope: "user",
      owner_user_id: "user-1",
      status: "active",
      account_id: "account-1",
      account_name: "Account",
    };
    const temporary = {
      id: "preview-1",
      tenant_id: "tenant-1",
      owner_user_id: "user-1",
      owner_membership_id: "member-1",
      app_id: "app-1",
      status: "ready",
      expires_at: "2026-08-04T09:00:00.000Z",
      account_id: "temporary-account",
      account_name: "Temporary",
    };
    const appWithTarget = (target: string, targetId: string | null = null) => ({
      ...app,
      target_kind: target,
      cloudflare_connection_id: target === "byoc" ? targetId : null,
      temporary_preview_id: target === "temporary" ? targetId : null,
    });
    const makeTransactionClient = (target: "unassigned" | "temporary" | "byoc") => {
      const selected = target === "temporary" ? temporary : target === "byoc" ? connection : null;
      const targetId = selected?.id || null;
      const clientQuery = vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
        if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
        if (sql.includes("from scoped_role_assignments")) return { rows: [{ allowed: true }] };
        if (sql.includes("from apps where id=$1 and tenant_id=$2 for update")) {
          return { rows: [app] };
        }
        if (sql.includes("from cloudflare_connections where id")) return { rows: [connection] };
        if (sql.includes("select account_id,account_name from cloudflare_temporary_previews")) {
          return { rows: [{ account_id: "temporary-account", account_name: "Temporary" }] };
        }
        if (sql.includes("from cloudflare_temporary_previews") && sql.includes("limit 1")) {
          return { rows: [temporary] };
        }
        if (sql.includes("update apps set target_kind")) {
          return { rows: [appWithTarget(target, targetId)] };
        }
        if (sql.includes("control_plane_audit_log")) return { rows: [] };
        throw new Error(`Unexpected target transaction query: ${sql}`);
      });
      return { query: clientQuery, release: vi.fn() };
    };
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("from apps where id=$1 and tenant_id=$2 limit 1")) {
        return { rows: [appWithTarget("temporary", "preview-1")] };
      }
      if (sql.includes("from cloudflare_temporary_previews where id")) {
        return { rows: [{ account_id: "temporary-account", account_name: "Temporary" }] };
      }
      throw new Error(`Unexpected target read query: ${sql}`);
    });
    const pool = {
      query: poolQuery,
      connect: vi
        .fn()
        .mockResolvedValueOnce(makeTransactionClient("unassigned"))
        .mockResolvedValueOnce(makeTransactionClient("temporary"))
        .mockResolvedValueOnce(makeTransactionClient("byoc")),
    } as unknown as Pool;
    const service = new AppCloudflareAccountService(pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
      now: () => new Date("2026-08-04T08:00:00.000Z"),
    });

    await expect(service.setAppTarget(context, "app-1", { target: "unassigned" })).resolves.toEqual(
      {
        appId: "app-1",
        target: "unassigned",
        connectionId: null,
        temporaryAccountId: null,
        accountId: null,
        accountName: null,
      },
    );
    await expect(
      service.setAppTarget(context, "app-1", {
        target: "temporary",
        temporaryAccountId: "preview-1",
      }),
    ).resolves.toMatchObject({ target: "temporary", accountId: "temporary-account" });
    await expect(
      service.setAppTarget(context, "app-1", { target: "byoc", connectionId: "connection-1" }),
    ).resolves.toMatchObject({ target: "byoc", accountId: "account-1" });
    await expect(service.getAppTarget(context, "app-1")).resolves.toEqual({
      appId: "app-1",
      target: "temporary",
      connectionId: null,
      temporaryAccountId: "preview-1",
      accountId: "temporary-account",
      accountName: "Temporary",
    });
  });

  it("projects deployment receipts and falls back to the current deployment event", async () => {
    const now = new Date("2026-08-04T08:00:00.000Z");
    const receipt = {
      id: "receipt-1",
      app_id: "app-1",
      deployment_id: "deployment-1",
      target_kind: "byoc",
      cloudflare_connection_id: "connection-1",
      temporary_preview_id: null,
      logical_key: "worker",
      resource_kind: "worker",
      mode: "create",
      ownership: "created",
      external_id: "worker-1",
      external_name: "piwork-worker",
      step_status: "ready",
      metadata: { route: "worker" },
      error_code: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    const deployment = {
      id: "deployment-1",
      app_id: "app-1",
      version: 2,
      phase: "ready",
      target_kind: "byoc",
      source_digest: "a".repeat(64),
      manifest: {
        version: 1,
        runtime: "cloudflare-workers",
        exposure: { workersDev: true },
      },
      cloudflare_version_id: "version-1",
      stable_url: "https://app.example.com",
      error_code: null,
      error_message: null,
      created_by: "user-1",
      created_at: now,
      deployed_at: now,
      current_deployment_id: "deployment-1",
      preview_id: null,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from tenant_memberships")) return { rows: [{ id: "member-1" }] };
      if (sql.includes("with abandoned_previews")) return { rows: [], rowCount: 0 };
      if (sql.includes("update cloudflare_oauth_states")) return { rows: [], rowCount: 0 };
      if (sql.includes("from app_resource_receipts")) return { rows: [receipt] };
      if (sql.includes("from app_deployments d join apps a")) {
        return { rows: [deployment] };
      }
      if (sql.includes("from control_plane_audit_log")) return { rows: [] };
      throw new Error(`Unexpected deployment projection query: ${sql}`);
    });
    const service = new AppCloudflareAccountService({ query } as unknown as Pool, {
      ...enabled,
      client: clientFixture(),
      masterKey: () => masterKey,
      now: () => now,
    });

    await expect(service.listDeploymentReceipts(context, "deployment-1")).resolves.toEqual([
      {
        id: "receipt-1",
        appId: "app-1",
        deploymentId: "deployment-1",
        target: "byoc",
        connectionId: "connection-1",
        temporaryAccountId: null,
        logicalKey: "worker",
        resourceKind: "worker",
        mode: "create",
        ownership: "created",
        externalId: "worker-1",
        externalName: "piwork-worker",
        stepStatus: "ready",
        metadata: { route: "worker" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        errorCode: null,
        errorMessage: null,
      },
    ]);
    await expect(service.listDeploymentEvents(context, "deployment-1")).resolves.toEqual([
      {
        id: "deployment-1:current",
        deploymentId: "deployment-1",
        phase: "ready",
        timestamp: now.toISOString(),
        code: null,
      },
    ]);
  });
});
