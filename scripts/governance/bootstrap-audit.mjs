#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const MAX_BOOTSTRAP_DAYS = 90;
const EXPECTED_BOOTSTRAP_SCOPE = "non-leader-core-review";
const EXPECTED_BOOTSTRAP_STATE = "leader-only";
const FULL_CORE_STATE = "full-core";

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().startsWith(`${value}T`) ? date : null;
}

export function bootstrapExpiresAt(bootstrap) {
  const startsAt = parseDateOnly(bootstrap?.startsAt);
  const days = bootstrap?.expiresAfterDays;
  if (!startsAt || !Number.isSafeInteger(days) || days < 1) return null;
  const expires = new Date(startsAt.getTime());
  expires.setUTCDate(expires.getUTCDate() + days);
  return expires;
}

function explicitReviewerLogins(policy) {
  const reviewers = policy?.reviewEnforcement?.coreReviewerLogins;
  return Array.isArray(reviewers) ? reviewers : [];
}

/**
 * Validate the local, signed-policy bootstrap contract without querying GitHub.
 * The function intentionally consumes only the explicit reviewer allowlist; it
 * never infers Core membership from an organization or Team API.
 */
export function auditBootstrapPolicy(policy, now = new Date()) {
  const errors = [];
  const warnings = [];
  const bootstrap = policy?.bootstrap;
  const reviewers = explicitReviewerLogins(policy);
  const reviewerSet = new Set(reviewers);
  const current = asDate(now);
  const threshold = bootstrap?.activateFullCoreReviewersAt;
  const startsAt = parseDateOnly(bootstrap?.startsAt);
  const expiresAt = bootstrapExpiresAt(bootstrap);

  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    errors.push("bootstrap configuration is missing");
  }
  if (bootstrap?.scope !== EXPECTED_BOOTSTRAP_SCOPE) {
    errors.push(`bootstrap scope must remain ${EXPECTED_BOOTSTRAP_SCOPE}`);
  }
  if (bootstrap?.expiresAfterDays !== MAX_BOOTSTRAP_DAYS) {
    errors.push(`bootstrap expiresAfterDays must be exactly ${MAX_BOOTSTRAP_DAYS}`);
  }
  if (bootstrap?.activateFullCoreReviewersAt !== 3) {
    errors.push(
      "bootstrap activation threshold must remain exactly three explicit Core identities",
    );
  }
  if (bootstrap?.expiredBehavior !== "fail-closed") {
    errors.push("bootstrap expiredBehavior must be fail-closed");
  }
  if (bootstrap?.transitionBehavior !== "signed-policy-pr") {
    errors.push("bootstrap transitionBehavior must require a signed policy PR");
  }
  if (!startsAt) errors.push("bootstrap startsAt must be an ISO calendar date");
  if (!expiresAt) errors.push("bootstrap expiry cannot be calculated");
  if (!current) errors.push("bootstrap audit time is invalid");
  if (startsAt && current && current < startsAt) {
    errors.push("bootstrap startsAt is in the future");
  }
  if (reviewers.length === 0 || reviewers.some((login) => typeof login !== "string" || !login)) {
    errors.push("coreReviewerLogins must be a non-empty explicit login allowlist");
  }
  if (reviewerSet.size !== reviewers.length) errors.push("coreReviewerLogins contains duplicates");
  if (!reviewerSet.has(policy?.leader)) {
    errors.push("coreReviewerLogins must include the configured Leader");
  }
  const recordedState = policy?.reviewEnforcement?.reviewerAllowlist?.bootstrapState;
  if (recordedState !== bootstrap?.state) {
    errors.push("reviewerAllowlist.bootstrapState must match bootstrap.state");
  }

  let transitionRequired = false;
  let state = "invalid";
  if (bootstrap?.state === EXPECTED_BOOTSTRAP_STATE && bootstrap?.enabled === true) {
    state = EXPECTED_BOOTSTRAP_STATE;
    if (reviewers.length >= threshold) {
      transitionRequired = true;
      errors.push(
        `bootstrap requires a signed transition: ${reviewers.length} explicit Core identities reach ${threshold}`,
      );
    }
    if (expiresAt && current && current >= expiresAt) {
      transitionRequired = true;
      errors.push(`bootstrap expired at ${expiresAt.toISOString().slice(0, 10)}`);
    }
  } else if (bootstrap?.state === FULL_CORE_STATE && bootstrap?.enabled === false) {
    state = FULL_CORE_STATE;
    if (reviewers.length < threshold) {
      errors.push(
        `full-core state requires at least ${threshold} explicit Core identities before disabling bootstrap`,
      );
    }
    warnings.push(
      "full-core state is active; future Core allowlist changes still require a signed policy PR",
    );
  } else {
    errors.push("bootstrap state/enabled combination is unknown or expanded");
  }

  return {
    ok: errors.length === 0,
    state,
    transitionRequired,
    errors,
    warnings,
    coreReviewerCount: reviewers.length,
    threshold,
    startsAt: startsAt?.toISOString() || null,
    expiresAt: expiresAt?.toISOString() || null,
  };
}

function nativeReviewDrift(parameters, native, label) {
  const drift = [];
  if (!parameters || typeof parameters !== "object") {
    drift.push(`${label} pull-request reviewer parameters are missing`);
    return drift;
  }
  if (parameters.required_approving_review_count !== native.requiredApprovingReviewCount) {
    drift.push(`${label} native approving review count differs from policy`);
  }
  if (
    !Array.isArray(parameters.required_reviewers) ||
    parameters.required_reviewers.length !== native.requiredReviewers.length
  ) {
    drift.push(`${label} native required reviewers must remain empty`);
  }
  if (parameters.require_code_owner_review !== native.requireCodeOwnerReview) {
    drift.push(`${label} native CODEOWNER reviewer requirement differs from policy`);
  }
  if (parameters.require_last_push_approval !== native.requireLastPushApproval) {
    drift.push(`${label} native last-push reviewer requirement differs from policy`);
  }
  if (parameters.dismiss_stale_reviews_on_push !== native.dismissStaleReviewsOnPush) {
    drift.push(`${label} stale-review dismissal differs from policy`);
  }
  if (parameters.required_review_thread_resolution !== native.requiredReviewThreadResolution) {
    drift.push(`${label} required review-thread resolution differs from policy`);
  }
  return drift;
}

function statusCheckKey(status) {
  return `${status?.context || ""}\u0000${status?.integration_id ?? ""}`;
}

/**
 * Check read-only GitHub Ruleset and legacy branch-protection readback.
 * This function is pure so fixtures can exercise reviewer drift without API
 * calls or any ability to modify remote configuration.
 */
export function auditRulesetReadback(policy, rulesets, branchProtection = null) {
  const drift = [];
  const byName = new Map(
    (Array.isArray(rulesets) ? rulesets : [])
      .filter((ruleset) => ruleset && typeof ruleset.name === "string")
      .map((ruleset) => [ruleset.name, ruleset]),
  );
  const native = policy?.reviewEnforcement?.nativeRuleset;
  const names = ["Piwork main governance", "Piwork high-risk review"];
  for (const name of names) {
    const ruleset = byName.get(name);
    if (!ruleset || ruleset.enforcement !== "active") {
      drift.push(`ruleset ${name} is missing or inactive`);
      continue;
    }
    const pullRequest = ruleset.rules?.find((rule) => rule.type === "pull_request");
    drift.push(...nativeReviewDrift(pullRequest?.parameters, native, name));
  }

  const main = byName.get("Piwork main governance");
  const statuses = main?.rules?.find((rule) => rule.type === "required_status_checks")?.parameters
    ?.required_status_checks;
  const expectedStatuses = (policy?.requiredChecks || []).map((context) => ({
    context,
    integration_id: policy.requiredStatusCheckIntegrationId,
  }));
  const actualStatusKeys = new Set((Array.isArray(statuses) ? statuses : []).map(statusCheckKey));
  const expectedStatusKeys = new Set(expectedStatuses.map(statusCheckKey));
  if (
    actualStatusKeys.size !== expectedStatusKeys.size ||
    [...expectedStatusKeys].some((key) => !actualStatusKeys.has(key))
  ) {
    drift.push("main ruleset required checks are not bound to the policy Actions integration");
  }

  const legacyReview = branchProtection?.required_pull_request_reviews;
  if (legacyReview) {
    if (legacyReview.required_approving_review_count > 0) {
      drift.push("legacy main branch protection still requires approving reviewers");
    }
    if (legacyReview.require_code_owner_reviews === true) {
      drift.push("legacy main branch protection still requires CODEOWNER approval");
    }
    if (legacyReview.require_last_push_approval === true) {
      drift.push("legacy main branch protection still requires last-push approval");
    }
  }
  return drift;
}

export function isDocumentationPath(path) {
  return typeof path === "string" && (path.startsWith("docs/") || /^[^/]+\.md$/i.test(path));
}

export function isDocsOnlyPullRequest(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(isDocumentationPath);
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const apiBase = process.env.GITHUB_API_URL || "https://api.github.com";
const repository = process.env.GITHUB_REPOSITORY || "agentbridges-ai/pi-work";
const defaultBranch = "main";
const token = process.env.GITHUB_TOKEN;

async function githubJson(path, { allowNotFound = false } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read ${path} failed: ${response.status}`);
  return response.json();
}

function eventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  try {
    return JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    throw new Error(
      `GitHub event metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readRulesets() {
  const response = await githubJson(`/repos/${repository}/rulesets?includes_parents=false`);
  const summaries = Array.isArray(response) ? response : response?.rulesets || [];
  const rulesets = [];
  for (const summary of summaries) {
    rulesets.push(
      summary?.id ? await githubJson(`/repos/${repository}/rulesets/${summary.id}`) : summary,
    );
  }
  return rulesets;
}

async function readPullRequest(number) {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const metadata = await githubJson(`/repos/${repository}/pulls/${number}`);
  const files = [];
  for (let page = 1; ; page += 1) {
    const pageFiles = await githubJson(
      `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(pageFiles)) throw new Error("GitHub pull request files response is invalid");
    files.push(...pageFiles.map((file) => file.filename || file.path).filter(Boolean));
    if (pageFiles.length < 100) break;
  }
  return { metadata, files };
}

async function main() {
  if (
    repository !== "agentbridges-ai/pi-work" ||
    policy.repository !== repository ||
    policy.defaultBranch !== defaultBranch ||
    !repositoryPattern.test(repository)
  ) {
    throw new Error("GITHUB_REPOSITORY does not match the checked-in governance policy");
  }
  const now = process.env.PIWORK_BOOTSTRAP_AUDIT_NOW || new Date().toISOString();
  const local = auditBootstrapPolicy(policy, now);
  console.log(
    `[governance-bootstrap-audit] state=${local.state} core=${local.coreReviewerCount}/${local.threshold} expires=${local.expiresAt || "invalid"}`,
  );
  for (const warning of local.warnings)
    console.warn(`[governance-bootstrap-audit] warning: ${warning}`);
  for (const error of local.errors) console.error(`[governance-bootstrap-audit] ${error}`);

  const event = eventPayload();
  const eventName = process.env.GITHUB_EVENT_NAME || "local";
  const offline = process.argv.includes("--offline");
  const pullRequestNumber = Number(process.env.PIWORK_PULL_REQUEST_NUMBER);
  if (eventName === "merge_group") {
    console.log(
      "[governance-bootstrap-audit] merge_group has no pull_request metadata; deterministic no-op after trusted policy/ruleset readback",
    );
  } else if (event.pull_request && !offline) {
    if (!token) throw new Error("GITHUB_TOKEN is required for pull request metadata readback");
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
      throw new Error("PIWORK_PULL_REQUEST_NUMBER is invalid");
    }
    if (Number(event.pull_request.number) !== pullRequestNumber) {
      throw new Error("event pull request number does not match PIWORK_PULL_REQUEST_NUMBER");
    }
    const pullRequest = await readPullRequest(pullRequestNumber);
    const docsOnly = isDocsOnlyPullRequest(pullRequest?.files || []);
    console.log(
      `[governance-bootstrap-audit] ${docsOnly ? "docs-only PR no-op" : "PR metadata read"}; bootstrap transition is policy-only and is never inferred from changed files`,
    );
  } else if (event.pull_request && offline) {
    console.log(
      "[governance-bootstrap-audit] offline policy fixture; PR metadata readback is a deterministic no-op",
    );
  } else if (
    eventName === "schedule" ||
    eventName === "workflow_dispatch" ||
    eventName === "push"
  ) {
    console.log(`[governance-bootstrap-audit] ${eventName} audit has no PR scope`);
  }

  // `GITHUB_TOKEN` is injected automatically on Actions runners. The explicit
  // offline flag must therefore short-circuit before any remote read rather
  // than merely treating a missing token as offline.
  if (offline) {
    if (!local.ok) process.exitCode = 1;
    return;
  }
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required for Ruleset readback; use --offline only for local fixtures",
    );
  }
  const [rulesets, branchProtection, workflowPermissions] = await Promise.all([
    readRulesets(),
    githubJson(`/repos/${repository}/branches/${defaultBranch}/protection`, {
      allowNotFound: true,
    }),
    githubJson(`/repos/${repository}/actions/permissions/workflow`),
  ]);
  const drift = auditRulesetReadback(policy, rulesets, branchProtection);
  if (
    workflowPermissions?.default_workflow_permissions !== policy.workflowPermissions?.default ||
    workflowPermissions?.can_approve_pull_request_reviews !==
      policy.workflowPermissions?.canApprovePullRequestReviews
  ) {
    drift.push("repository workflow permissions are not read-only/non-approving");
  }
  for (const item of drift) console.error(`[governance-bootstrap-audit] drift: ${item}`);
  if (!local.ok || drift.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    "[governance-bootstrap-audit] policy and remote readback passed; no remote mutation performed",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(
      `[governance-bootstrap-audit] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
