import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_PRIVACY_POLICY_URL,
  CLOUDFLARE_TERMS_OF_SERVICE_URL,
  HttpAppCloudflareAccountClient,
  UnconfiguredAppCloudflareAccountClient,
  createPkceMaterial,
  hashOAuthState,
  normalizeConnectionScope,
  solvePreviewChallengeInWorker,
  validatePreviewChallenge,
} from "./apps-cloudflare-account-client.js";

describe("Cloudflare temporary account client", () => {
  it("bounds proof-of-work inputs and solves valid challenges off-thread", async () => {
    const seed = randomBytes(32).toString("base64url");
    expect(() =>
      validatePreviewChallenge({ challengeToken: "c", seed, k: 8_001, g: 8_000 }),
    ).toThrow(/64,000,000/);
    expect(() =>
      validatePreviewChallenge({ challengeToken: "c", seed: "bad", k: 1, g: 1 }),
    ).toThrow(/32 bytes/);

    const result = await solvePreviewChallengeInWorker({
      challengeToken: "challenge",
      seed,
      k: 2,
      g: 3,
    });
    expect(result.challengeToken).toBe("challenge");
    expect(Buffer.from(result.solution.checkpoints, "base64")).toHaveLength(3 * 32);
  });

  it("performs challenge then provisioning with the exact accepted policy fields", async () => {
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              challengeToken: "challenge",
              seed: randomBytes(32).toString("base64url"),
              k: 1,
              g: 1,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              account: {
                id: "account-1",
                name: "preview-account",
                apiToken: "temporary-secret-token",
                tokenId: "token-1",
                expiresAt,
              },
              claim: {
                url: "https://dash.cloudflare.com/claim-preview?claimToken=claim-secret",
                expiresAt,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new HttpAppCloudflareAccountClient({
      fetch: request,
      challengeTimeoutMs: 5_000,
    });

    const result = await client.provisionTemporaryAccount({
      termsOfService: CLOUDFLARE_TERMS_OF_SERVICE_URL,
      privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
      acceptTermsOfService: "yes",
    });

    expect(result.accountId).toBe("account-1");
    expect(request).toHaveBeenCalledTimes(2);
    const createBody = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(createBody).toMatchObject({
      termsOfService: CLOUDFLARE_TERMS_OF_SERVICE_URL,
      privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
      acceptTermsOfService: "yes",
      challengeToken: "challenge",
      solution: { checkpoints: expect.any(String) },
    });
  });

  it("builds S256 OAuth URLs and keeps token exchange behind injected fetch", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          token_type: "Bearer",
          scope: "workers.write account.read",
          expires_in: 3600,
          account_id: "account-1",
          account_name: "Account",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new HttpAppCloudflareAccountClient({
      oauthClientId: "client-id",
      oauthRedirectUri: "https://piwork.example/api/apps/cloudflare/oauth/callback",
      fetch: request,
    });
    const authorization = new URL(
      client.authorizationUrl({
        state: "state",
        codeChallenge: "challenge",
        redirectUri: client.oauthRedirectUri,
        scopes: ["provider.workers.write", "provider.account.read"],
      }),
    );
    expect(authorization.origin).toBe("https://dash.cloudflare.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBe("state");

    const token = await client.exchangeAuthorizationCode({
      code: "authorization-code",
      codeVerifier: "verifier",
      redirectUri: client.oauthRedirectUri,
    });
    expect(token).toMatchObject({
      accountId: "account-1",
      accountName: "Account",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      grantedScopes: ["workers.write", "account.read"],
    });
    expect(String(request.mock.calls[0][1]?.body)).toContain("code_verifier=verifier");
  });

  it("loads provider scope name-to-ID mappings only with the user's bearer token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "provider.workers.write", name: "Workers Scripts Write" }],
          result_info: { total_count: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new HttpAppCloudflareAccountClient({ fetch: request });
    await expect(client.listOAuthScopes("user-oauth-secret")).resolves.toEqual([
      { id: "provider.workers.write", name: "Workers Scripts Write" },
    ]);
    expect(request).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/oauth/scopes",
      expect.objectContaining({
        headers: { authorization: "Bearer user-oauth-secret" },
      }),
    );
  });

  it("covers disabled clients, PKCE material, and connection-scope validation", async () => {
    const disabled = new UnconfiguredAppCloudflareAccountClient();
    expect(disabled.oauthRedirectUri).toBe("");
    expect(() => disabled.authorizationUrl()).toThrow(/not configured/);
    expect(() => disabled.listZones()).toThrow(/not configured/);
    expect(() => disabled.revokeToken()).toThrow(/not configured/);

    const pkce = createPkceMaterial();
    expect(pkce.state).toBeTruthy();
    expect(pkce.verifier).toBeTruthy();
    expect(pkce.challenge).toBeTruthy();
    expect(pkce.stateHash).toBe(hashOAuthState(pkce.state));
    expect(normalizeConnectionScope("user")).toBe("user");
    expect(normalizeConnectionScope("tenant")).toBe("tenant");
    expect(() => normalizeConnectionScope("invalid")).toThrow(/scope must be/);
  });

  it("refreshes tokens, resolves an account, lists zones, and revokes tokens", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-secret",
            scope: ["workers.write", "workers.write"],
            expires_in: 60,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "account-1", name: "Account" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "zone-1", name: "example.com", status: "active" }],
            result_info: { total_count: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = new HttpAppCloudflareAccountClient({
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      fetch: request,
    });

    await expect(client.refreshAccessToken("old-refresh", ["account.read"])).resolves.toMatchObject({
      accountId: "account-1",
      accountName: "Account",
      accessToken: "access-secret",
      refreshToken: "old-refresh",
      grantedScopes: ["workers.write"],
    });
    await expect(client.listZones("access-secret")).resolves.toEqual([
      { id: "zone-1", name: "example.com", status: "active" },
    ]);
    await expect(client.revokeToken("access-secret")).resolves.toBeUndefined();
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain("grant_type=refresh_token");
    expect(
      (request.mock.calls[0]?.[1]?.headers as Headers).get("authorization"),
    ).toMatch(/^Basic /u);
  });

  it("rejects unsafe redirect URLs and incomplete provider responses", async () => {
    expect(
      () =>
        new HttpAppCloudflareAccountClient({
          oauthRedirectUri: "http://localhost/callback",
        }),
    ).toThrow(/HTTPS/);
    const client = new HttpAppCloudflareAccountClient({ oauthClientId: "client-id" });
    expect(() =>
      client.authorizationUrl({
        state: "state",
        codeChallenge: "challenge",
        redirectUri: "https://piwork.example/callback",
        scopes: [],
      }),
    ).not.toThrow();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const failing = new HttpAppCloudflareAccountClient({ fetch: request });
    await expect(
      failing.provisionTemporaryAccount({
        termsOfService: "invalid" as never,
        privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
        acceptTermsOfService: "yes",
      }),
    ).rejects.toThrow(/policies/);
  });
});
