import { createHash, randomBytes } from "node:crypto";
import type {
  AppCloudflareConnectionScope,
  AppCloudflareZone,
} from "./apps-cloudflare-account-types.js";
import type { CloudflareProviderOAuthScope } from "./apps-cloudflare-oauth-scopes.js";
import {
  solveCloudflarePreviewChallenge,
  validateCloudflarePreviewChallenge,
  type CloudflarePreviewChallenge,
} from "./apps-cloudflare-pow.js";

export const CLOUDFLARE_TERMS_OF_SERVICE_URL = "https://www.cloudflare.com/terms/";
export const CLOUDFLARE_PRIVACY_POLICY_URL = "https://www.cloudflare.com/privacypolicy/";
export const CLOUDFLARE_TEMPORARY_ACCOUNT_LIFETIME_MS = 60 * 60 * 1_000;
export const CLOUDFLARE_OAUTH_ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;

export interface CloudflareTemporaryAccountResult {
  accountId: string;
  accountName: string;
  apiToken: string;
  tokenId?: string;
  accountExpiresAt: string;
  claimUrl: string;
  claimExpiresAt: string;
}

export interface CloudflareOAuthTokenResult {
  accountId: string;
  accountName: string;
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  grantedScopes: string[];
  accessExpiresAt?: string;
}

export interface CloudflareOAuthAuthorizationInput {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
}

export interface CloudflareOAuthExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * External Cloudflare operations are injected so control-plane tests never need
 * network access and credentials never cross into an Agent process.
 */
export interface AppCloudflareAccountClient {
  readonly oauthRedirectUri: string;
  provisionTemporaryAccount(input: {
    termsOfService: typeof CLOUDFLARE_TERMS_OF_SERVICE_URL;
    privacyPolicy: typeof CLOUDFLARE_PRIVACY_POLICY_URL;
    acceptTermsOfService: "yes";
  }): Promise<CloudflareTemporaryAccountResult>;
  discardTemporaryAccount?(input: { accountId: string; apiToken: string }): Promise<void>;
  authorizationUrl(input: CloudflareOAuthAuthorizationInput): string;
  exchangeAuthorizationCode(
    input: CloudflareOAuthExchangeInput,
  ): Promise<CloudflareOAuthTokenResult>;
  refreshAccessToken(
    refreshToken: string,
    previousScopes?: string[],
  ): Promise<CloudflareOAuthTokenResult>;
  listOAuthScopes(accessToken: string): Promise<CloudflareProviderOAuthScope[]>;
  listZones(accessToken: string): Promise<AppCloudflareZone[]>;
  revokeToken(token: string): Promise<void>;
}

export class UnconfiguredAppCloudflareAccountClient implements AppCloudflareAccountClient {
  readonly oauthRedirectUri = "";

  private unavailable(): never {
    throw new Error("Cloudflare account provisioning is not configured.");
  }

  provisionTemporaryAccount(): Promise<CloudflareTemporaryAccountResult> {
    return Promise.reject(this.unavailable());
  }

  authorizationUrl(): string {
    return this.unavailable();
  }

  exchangeAuthorizationCode(): Promise<CloudflareOAuthTokenResult> {
    return Promise.reject(this.unavailable());
  }

  refreshAccessToken(): Promise<CloudflareOAuthTokenResult> {
    return Promise.reject(this.unavailable());
  }

  listOAuthScopes(): Promise<CloudflareProviderOAuthScope[]> {
    return Promise.reject(this.unavailable());
  }

  listZones(): Promise<AppCloudflareZone[]> {
    return Promise.reject(this.unavailable());
  }

  revokeToken(): Promise<void> {
    return Promise.reject(this.unavailable());
  }
}

export interface HttpAppCloudflareAccountClientOptions {
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  dashboardBaseUrl?: string;
  challengeTimeoutMs?: number;
}

function jsonRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cloudflare returned an invalid response.");
  }
  return value as Record<string, any>;
}

function responseString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cloudflare response is missing ${field}.`);
  }
  return value.trim();
}

function responseScopes(value: unknown): string[] {
  const scopes = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return [...new Set(scopes.filter((item): item is string => typeof item === "string" && !!item))];
}

export function validatePreviewChallenge(value: unknown): CloudflarePreviewChallenge {
  const challenge = jsonRecord(value) as unknown as CloudflarePreviewChallenge;
  validateCloudflarePreviewChallenge(challenge);
  return challenge;
}

/** Compatibility wrapper around the shared worker-thread proof-of-work implementation. */
export function solvePreviewChallengeInWorker(
  challengeValue: unknown,
  timeoutMs = 5 * 60 * 1_000,
): ReturnType<typeof solveCloudflarePreviewChallenge> {
  return solveCloudflarePreviewChallenge(validatePreviewChallenge(challengeValue), { timeoutMs });
}

/** Real REST/OAuth adapter. Tests inject fetch and never contact Cloudflare. */
export class HttpAppCloudflareAccountClient implements AppCloudflareAccountClient {
  readonly oauthRedirectUri: string;
  private readonly oauthClientId: string;
  private readonly oauthClientSecret?: string;
  private readonly request: typeof globalThis.fetch;
  private readonly apiBaseUrl: string;
  private readonly dashboardBaseUrl: string;
  private readonly challengeTimeoutMs: number;

  constructor(options: HttpAppCloudflareAccountClientOptions) {
    this.oauthClientId = options.oauthClientId?.trim() || "";
    this.oauthClientSecret = options.oauthClientSecret?.trim() || undefined;
    this.oauthRedirectUri = options.oauthRedirectUri
      ? new URL(options.oauthRedirectUri).toString()
      : "";
    if (this.oauthRedirectUri && !this.oauthRedirectUri.startsWith("https://")) {
      throw new Error("Cloudflare OAuth redirect URI must use HTTPS.");
    }
    this.request = options.fetch || globalThis.fetch;
    this.apiBaseUrl = (options.apiBaseUrl || "https://api.cloudflare.com/client/v4").replace(
      /\/$/,
      "",
    );
    this.dashboardBaseUrl = (options.dashboardBaseUrl || "https://dash.cloudflare.com").replace(
      /\/$/,
      "",
    );
    this.challengeTimeoutMs = options.challengeTimeoutMs || 5 * 60 * 1_000;
  }

  private async json(url: string, init: RequestInit): Promise<Record<string, any>> {
    const response = await this.request(url, init);
    if (!response.ok) throw new Error(`Cloudflare request failed with status ${response.status}.`);
    return jsonRecord(await response.json());
  }

  private oauthHeaders(): Headers {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    if (this.oauthClientSecret) {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${this.oauthClientId}:${this.oauthClientSecret}`).toString("base64")}`,
      );
    }
    return headers;
  }

  async provisionTemporaryAccount(input: {
    termsOfService: typeof CLOUDFLARE_TERMS_OF_SERVICE_URL;
    privacyPolicy: typeof CLOUDFLARE_PRIVACY_POLICY_URL;
    acceptTermsOfService: "yes";
  }): Promise<CloudflareTemporaryAccountResult> {
    if (
      input.termsOfService !== CLOUDFLARE_TERMS_OF_SERVICE_URL ||
      input.privacyPolicy !== CLOUDFLARE_PRIVACY_POLICY_URL ||
      input.acceptTermsOfService !== "yes"
    ) {
      throw new Error("Cloudflare policies were not explicitly accepted.");
    }
    const challengeResponse = await this.json(
      `${this.apiBaseUrl}/provisioning/previews/challenge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (challengeResponse.success !== true) throw new Error("Cloudflare preview challenge failed.");
    const solved = await solvePreviewChallengeInWorker(
      challengeResponse.result,
      this.challengeTimeoutMs,
    );
    const createResponse = await this.json(`${this.apiBaseUrl}/provisioning/previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        termsOfService: CLOUDFLARE_TERMS_OF_SERVICE_URL,
        privacyPolicy: CLOUDFLARE_PRIVACY_POLICY_URL,
        acceptTermsOfService: "yes",
        challengeToken: solved.challengeToken,
        solution: solved.solution,
      }),
    });
    if (createResponse.success !== true) {
      throw new Error("Cloudflare temporary account creation failed.");
    }
    const result = jsonRecord(createResponse.result);
    const account = jsonRecord(result.account);
    const claim = jsonRecord(result.claim);
    return {
      accountId: responseString(account.id, "account.id"),
      accountName: responseString(account.name, "account.name"),
      apiToken: responseString(account.apiToken, "account.apiToken"),
      tokenId: typeof account.tokenId === "string" ? account.tokenId : undefined,
      accountExpiresAt: responseString(account.expiresAt, "account.expiresAt"),
      claimUrl: responseString(claim.url, "claim.url"),
      claimExpiresAt: responseString(claim.expiresAt, "claim.expiresAt"),
    };
  }

  authorizationUrl(input: CloudflareOAuthAuthorizationInput): string {
    if (!this.oauthClientId) throw new Error("Cloudflare OAuth client ID is not configured.");
    const url = new URL("/oauth2/auth", this.dashboardBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.oauthClientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeAuthorizationCode(
    input: CloudflareOAuthExchangeInput,
  ): Promise<CloudflareOAuthTokenResult> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.oauthClientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    return this.exchangeToken(body, undefined);
  }

  async refreshAccessToken(
    refreshToken: string,
    previousScopes: string[] = [],
  ): Promise<CloudflareOAuthTokenResult> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.oauthClientId,
      refresh_token: refreshToken,
    });
    return this.exchangeToken(body, refreshToken, previousScopes);
  }

  async listOAuthScopes(accessToken: string): Promise<CloudflareProviderOAuthScope[]> {
    const token = responseString(accessToken, "access token");
    const response = await this.json(`${this.apiBaseUrl}/oauth/scopes`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.success !== true || !Array.isArray(response.result)) {
      throw new Error("Cloudflare returned an invalid OAuth scope catalog.");
    }
    const scopes = response.result.map((value: unknown) => {
      const scope = jsonRecord(value);
      return {
        id: responseString(scope.id, "OAuth scope id"),
        name: responseString(scope.name, "OAuth scope name"),
      };
    });
    const total = Number(response.result_info?.total_count);
    if (Number.isFinite(total) && total > scopes.length) {
      throw new Error("Cloudflare returned an incomplete OAuth scope catalog.");
    }
    return scopes;
  }

  async listZones(accessToken: string): Promise<AppCloudflareZone[]> {
    const token = responseString(accessToken, "access token");
    const response = await this.json(`${this.apiBaseUrl}/zones?per_page=50`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.success !== true || !Array.isArray(response.result)) {
      throw new Error("Cloudflare returned an invalid zone list.");
    }
    const zones = response.result.map((value: unknown) => {
      const zone = jsonRecord(value);
      return {
        id: responseString(zone.id, "zone.id"),
        name: responseString(zone.name, "zone.name"),
        status: typeof zone.status === "string" ? zone.status : "unknown",
      };
    });
    const total = Number(response.result_info?.total_count);
    if (Number.isFinite(total) && total > zones.length) {
      throw new Error("Cloudflare zone list exceeds the supported page size.");
    }
    return zones;
  }

  private async exchangeToken(
    body: URLSearchParams,
    previousRefreshToken: string | undefined,
    previousScopes: string[] = [],
  ): Promise<CloudflareOAuthTokenResult> {
    if (!this.oauthClientId) throw new Error("Cloudflare OAuth client ID is not configured.");
    const token = await this.json(`${this.dashboardBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: this.oauthHeaders(),
      body,
    });
    const accessToken = responseString(token.access_token, "access_token");
    const refreshToken =
      typeof token.refresh_token === "string" && token.refresh_token
        ? token.refresh_token
        : responseString(previousRefreshToken, "refresh_token");
    const account = await this.resolveOAuthAccount(token, accessToken);
    const expiresIn = Number(token.expires_in);
    return {
      accountId: account.id,
      accountName: account.name,
      accessToken,
      refreshToken,
      tokenType: typeof token.token_type === "string" ? token.token_type : "Bearer",
      grantedScopes: token.scope === undefined ? [...previousScopes] : responseScopes(token.scope),
      accessExpiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1_000).toISOString()
          : undefined,
    };
  }

  private async resolveOAuthAccount(
    token: Record<string, any>,
    accessToken: string,
  ): Promise<{ id: string; name: string }> {
    if (typeof token.account_id === "string" && typeof token.account_name === "string") {
      return { id: token.account_id, name: token.account_name };
    }
    const response = await this.json(`${this.apiBaseUrl}/accounts?per_page=2`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (
      response.success !== true ||
      !Array.isArray(response.result) ||
      response.result.length !== 1
    ) {
      throw new Error("Cloudflare OAuth grant must resolve to exactly one account.");
    }
    const account = jsonRecord(response.result[0]);
    return {
      id: responseString(account.id, "account.id"),
      name: responseString(account.name, "account.name"),
    };
  }

  async revokeToken(token: string): Promise<void> {
    if (!this.oauthClientId) throw new Error("Cloudflare OAuth client ID is not configured.");
    const body = new URLSearchParams({ token, client_id: this.oauthClientId });
    const response = await this.request(`${this.dashboardBaseUrl}/oauth2/revoke`, {
      method: "POST",
      headers: this.oauthHeaders(),
      body,
    });
    if (!response.ok) throw new Error(`Cloudflare request failed with status ${response.status}.`);
  }
}

export function createPkceMaterial(): {
  state: string;
  stateHash: string;
  verifier: string;
  challenge: string;
} {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  return {
    state,
    stateHash: hashOAuthState(state),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

export function normalizeConnectionScope(value: unknown): AppCloudflareConnectionScope {
  if (value === "user" || value === "tenant") return value;
  throw new Error("Cloudflare connection scope must be user or tenant.");
}
