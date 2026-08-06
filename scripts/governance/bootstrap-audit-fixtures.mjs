#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditBootstrapPolicy,
  auditRulesetReadback,
  bootstrapExpiresAt,
  isDocsOnlyPullRequest,
} from "./bootstrap-audit.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const auditSource = readFileSync(join(root, "scripts/governance/bootstrap-audit.mjs"), "utf8");
const auditWorkflow = readFileSync(
  join(root, ".github/workflows/governance-bootstrap-audit.yml"),
  "utf8",
);

assert.deepEqual(policy.reviewEnforcement.coreReviewerLogins, [policy.leader]);
assert.doesNotMatch(auditSource, /method:\s*["'](?:POST|PUT|PATCH)/);
assert.doesNotMatch(auditSource, /--apply|createCommitStatus|createIssue/);
assert.doesNotMatch(auditWorkflow, /(?:contents|pull-requests|issues|actions):\s*write/);
assert.match(auditWorkflow, /workflow_dispatch:/);

const healthy = auditBootstrapPolicy(policy, "2026-08-06T00:00:00Z");
assert.equal(healthy.ok, true, "single-Leader bootstrap is healthy at its start");
assert.equal(healthy.state, "leader-only");
assert.equal(healthy.coreReviewerCount, 1);
assert.equal(healthy.threshold, 3);
assert.equal(healthy.expiresAt, "2026-11-04T00:00:00.000Z");
assert.equal(bootstrapExpiresAt(policy.bootstrap)?.toISOString(), "2026-11-04T00:00:00.000Z");

const expired = auditBootstrapPolicy(policy, "2026-11-05T00:00:00Z");
assert.equal(expired.ok, false);
assert.equal(expired.transitionRequired, true);
assert.match(expired.errors.join("\n"), /expired/);

const expanded = auditBootstrapPolicy(
  { ...policy, bootstrap: { ...policy.bootstrap, expiresAfterDays: 91 } },
  "2026-08-06T00:00:00Z",
);
assert.equal(expanded.ok, false);
assert.match(expanded.errors.join("\n"), /exactly 90/);

const thresholdPolicy = {
  ...policy,
  reviewEnforcement: {
    ...policy.reviewEnforcement,
    coreReviewerLogins: [policy.leader, "core-a", "core-b"],
  },
};
const threshold = auditBootstrapPolicy(thresholdPolicy, "2026-08-06T00:00:00Z");
assert.equal(threshold.ok, false);
assert.equal(threshold.transitionRequired, true);
assert.match(threshold.errors.join("\n"), /signed transition/);

const fullCorePolicy = {
  ...thresholdPolicy,
  bootstrap: { ...policy.bootstrap, enabled: false, state: "full-core" },
  reviewEnforcement: {
    ...thresholdPolicy.reviewEnforcement,
    reviewerAllowlist: {
      ...thresholdPolicy.reviewEnforcement.reviewerAllowlist,
      bootstrapState: "full-core",
    },
  },
};
assert.equal(auditBootstrapPolicy(fullCorePolicy, "2026-11-05T00:00:00Z").ok, true);

const nativeParameters = policy.reviewEnforcement.nativeRuleset;
function pullRequestRule() {
  return {
    type: "pull_request",
    parameters: {
      dismiss_stale_reviews_on_push: nativeParameters.dismissStaleReviewsOnPush,
      require_code_owner_review: nativeParameters.requireCodeOwnerReview,
      require_last_push_approval: nativeParameters.requireLastPushApproval,
      required_approving_review_count: nativeParameters.requiredApprovingReviewCount,
      required_review_thread_resolution: nativeParameters.requiredReviewThreadResolution,
      required_reviewers: [],
    },
  };
}
const healthyRulesets = [
  {
    name: "Piwork main governance",
    enforcement: "active",
    rules: [
      pullRequestRule(),
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: policy.requiredChecks.map((context) => ({
            context,
            integration_id: policy.requiredStatusCheckIntegrationId,
          })),
        },
      },
    ],
  },
  { name: "Piwork high-risk review", enforcement: "active", rules: [pullRequestRule()] },
];
assert.deepEqual(auditRulesetReadback(policy, healthyRulesets), []);

const reviewerDrift = structuredClone(healthyRulesets);
reviewerDrift[0].rules[0].parameters.required_reviewers = [{ type: "Team", id: 1 }];
assert.ok(auditRulesetReadback(policy, reviewerDrift).some((item) => /reviewers/.test(item)));

assert.equal(isDocsOnlyPullRequest(["docs/engineering/change-management.md", "README.md"]), true);
assert.equal(
  isDocsOnlyPullRequest(["docs/engineering/change-management.md", "web/server/index.ts"]),
  false,
);
assert.equal(isDocsOnlyPullRequest([]), false);

console.log(
  "[bootstrap-audit-fixtures] healthy, expired, expanded, threshold, full-core transition, ruleset drift, and docs-only no-op fixtures passed",
);
