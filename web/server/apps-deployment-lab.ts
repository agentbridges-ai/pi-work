/**
 * Sanitised provider fixtures for the development-only Apps Deployment Lab.
 * The lab is a state/event replay surface, never a Cloudflare runtime and never
 * a place to supply credentials. Keeping this data as plain values also makes
 * it safe to render in tests and screenshots.
 */
export const APP_DEPLOYMENT_LAB_SCENARIOS = [
  "temporary_success",
  "temporary_expired",
  "pow_rate_limited",
  "claim_not_completed",
  "oauth_cancelled",
  "oauth_account_mismatch",
  "byoc_all_resources",
  "byoc_partial_resource_failure",
  "domain_conflict",
  "token_refresh",
] as const;

export type AppsDeploymentLabScenario = (typeof APP_DEPLOYMENT_LAB_SCENARIOS)[number];

export type AppsDeploymentLabEventStatus =
  | "building"
  | "awaiting_target"
  | "queued"
  | "provisioning"
  | "deploying"
  | "temporary_ready"
  | "claim_pending"
  | "awaiting_oauth"
  | "verifying_claim"
  | "ready"
  | "failed"
  | "expired";

export interface AppsDeploymentLabEvent {
  at: string;
  phase: AppsDeploymentLabEventStatus;
  messageKey: string;
  provider: "cloudflare-temporary" | "cloudflare-byoc" | "cloudflare-oauth";
  detail?: string;
  retryAfterSeconds?: number;
}

export interface AppsDeploymentLabHttpFixture {
  method: "GET" | "POST" | "PUT";
  path: string;
  status: number;
  /** Public shape only; bearer values are intentionally absent. */
  response: Record<string, unknown>;
}

export interface AppsDeploymentLabFixture {
  scenario: AppsDeploymentLabScenario;
  titleKey: string;
  events: AppsDeploymentLabEvent[];
  http: AppsDeploymentLabHttpFixture[];
}

const event = (
  at: string,
  phase: AppsDeploymentLabEventStatus,
  messageKey: string,
  provider: AppsDeploymentLabEvent["provider"],
  detail?: string,
): AppsDeploymentLabEvent => ({ at, phase, messageKey, provider, ...(detail ? { detail } : {}) });

const base = {
  challenge: {
    method: "POST" as const,
    path: "/client/v4/provisioning/previews/challenge",
    status: 200,
    response: {
      success: true,
      result: { challengeToken: "<redacted>", seed: "<redacted>", k: 2, g: 3 },
    },
  },
  preview: {
    method: "POST" as const,
    path: "/client/v4/provisioning/previews",
    status: 200,
    response: {
      success: true,
      result: {
        account: {
          id: "account-public-id",
          name: "temporary-preview",
          expiresAt: "2030-01-01T01:00:00.000Z",
        },
        claim: { url: "<delivered-by-authenticated-302>", expiresAt: "2030-01-01T01:00:00.000Z" },
      },
    },
  },
} satisfies Record<string, AppsDeploymentLabHttpFixture>;

const fixtures: Record<AppsDeploymentLabScenario, AppsDeploymentLabFixture> = {
  temporary_success: {
    scenario: "temporary_success",
    titleKey: "apps.lab.scenarios.temporarySuccess",
    events: [
      event("2026-01-01T00:00:00.000Z", "queued", "apps.lab.events.queued", "cloudflare-temporary"),
      event(
        "2026-01-01T00:00:01.000Z",
        "provisioning",
        "apps.lab.events.provisioning",
        "cloudflare-temporary",
      ),
      event(
        "2026-01-01T00:00:02.000Z",
        "deploying",
        "apps.lab.events.deploying",
        "cloudflare-temporary",
      ),
      event(
        "2026-01-01T00:00:03.000Z",
        "temporary_ready",
        "apps.lab.events.temporaryReady",
        "cloudflare-temporary",
      ),
      event(
        "2026-01-01T00:00:04.000Z",
        "claim_pending",
        "apps.lab.events.claimPending",
        "cloudflare-temporary",
      ),
    ],
    http: [base.challenge, base.preview],
  },
  temporary_expired: {
    scenario: "temporary_expired",
    titleKey: "apps.lab.scenarios.temporaryExpired",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "temporary_ready",
        "apps.lab.events.temporaryReady",
        "cloudflare-temporary",
      ),
      event(
        "2026-01-01T01:00:00.000Z",
        "expired",
        "apps.lab.events.expired",
        "cloudflare-temporary",
      ),
    ],
    http: [
      {
        method: "GET",
        path: "/api/apps/deployments/deployment-1",
        status: 200,
        response: { phase: "expired", claimUrl: null },
      },
    ],
  },
  pow_rate_limited: {
    scenario: "pow_rate_limited",
    titleKey: "apps.lab.scenarios.powRateLimited",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "failed",
        "apps.lab.events.rateLimited",
        "cloudflare-temporary",
        "retry-after",
      ),
    ],
    http: [
      { ...base.challenge, status: 429, response: { success: false, errors: [{ code: 4290 }] } },
    ],
  },
  claim_not_completed: {
    scenario: "claim_not_completed",
    titleKey: "apps.lab.scenarios.claimNotCompleted",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "claim_pending",
        "apps.lab.events.claimPending",
        "cloudflare-temporary",
      ),
      event(
        "2026-01-01T01:00:00.000Z",
        "expired",
        "apps.lab.events.claimNotCompleted",
        "cloudflare-temporary",
      ),
    ],
    http: [
      {
        method: "GET",
        path: "/api/apps/deployments/deployment-1/claim",
        status: 409,
        response: { errorCode: "claim_not_completed" },
      },
    ],
  },
  oauth_cancelled: {
    scenario: "oauth_cancelled",
    titleKey: "apps.lab.scenarios.oauthCancelled",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "awaiting_oauth",
        "apps.lab.events.oauthCancelled",
        "cloudflare-oauth",
      ),
    ],
    http: [
      {
        method: "GET",
        path: "/api/cloudflare/oauth/callback",
        status: 302,
        response: { result: "cancelled" },
      },
    ],
  },
  oauth_account_mismatch: {
    scenario: "oauth_account_mismatch",
    titleKey: "apps.lab.scenarios.oauthAccountMismatch",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "claim_pending",
        "apps.lab.events.accountMismatch",
        "cloudflare-oauth",
      ),
    ],
    http: [
      {
        method: "GET",
        path: "/api/cloudflare/oauth/callback",
        status: 409,
        response: { errorCode: "temporary_account_mismatch", retryable: true },
      },
    ],
  },
  byoc_all_resources: {
    scenario: "byoc_all_resources",
    titleKey: "apps.lab.scenarios.byocAllResources",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "provisioning",
        "apps.lab.events.resourcesReady",
        "cloudflare-byoc",
      ),
      event(
        "2026-01-01T00:00:01.000Z",
        "deploying",
        "apps.lab.events.deploying",
        "cloudflare-byoc",
      ),
      event("2026-01-01T00:00:02.000Z", "ready", "apps.lab.events.ready", "cloudflare-byoc"),
    ],
    http: [
      {
        method: "PUT",
        path: "/accounts/account-public-id/workers/scripts/app-1",
        status: 200,
        response: { result: { versionId: "version-public-id" } },
      },
    ],
  },
  byoc_partial_resource_failure: {
    scenario: "byoc_partial_resource_failure",
    titleKey: "apps.lab.scenarios.byocPartialResourceFailure",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "provisioning",
        "apps.lab.events.resourcesPartial",
        "cloudflare-byoc",
        "needs_cleanup",
      ),
      event("2026-01-01T00:00:01.000Z", "failed", "apps.lab.events.failed", "cloudflare-byoc"),
    ],
    http: [
      {
        method: "POST",
        path: "/accounts/account-public-id/d1/database",
        status: 403,
        response: { success: false, errors: [{ code: 10000 }] },
      },
    ],
  },
  domain_conflict: {
    scenario: "domain_conflict",
    titleKey: "apps.lab.scenarios.domainConflict",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "failed",
        "apps.lab.events.domainConflict",
        "cloudflare-byoc",
      ),
    ],
    http: [
      {
        method: "PUT",
        path: "/accounts/account-public-id/workers/domains",
        status: 409,
        response: { errorCode: "hostname_conflict" },
      },
    ],
  },
  token_refresh: {
    scenario: "token_refresh",
    titleKey: "apps.lab.scenarios.tokenRefresh",
    events: [
      event(
        "2026-01-01T00:00:00.000Z",
        "awaiting_oauth",
        "apps.lab.events.tokenRefresh",
        "cloudflare-oauth",
      ),
      event("2026-01-01T00:00:01.000Z", "ready", "apps.lab.events.ready", "cloudflare-byoc"),
    ],
    http: [
      {
        method: "POST",
        path: "/oauth/token",
        status: 200,
        response: { accountId: "account-public-id", accessExpiresAt: "2030-01-01T01:00:00.000Z" },
      },
    ],
  },
};

export function getAppsDeploymentLabFixture(
  scenario: AppsDeploymentLabScenario,
): AppsDeploymentLabFixture {
  const fixture = fixtures[scenario];
  if (!fixture) throw new Error("Unknown Apps Deployment Lab scenario");
  return structuredClone(fixture);
}

export function listAppsDeploymentLabFixtures(): AppsDeploymentLabFixture[] {
  return APP_DEPLOYMENT_LAB_SCENARIOS.map(getAppsDeploymentLabFixture);
}

export function appsDeploymentLabEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_ENV !== "production" &&
    (env.PIWORK_APPS_LAB_ENABLED === "1" || env.PIWORK_APPS_LAB_ENABLED === "true")
  );
}
