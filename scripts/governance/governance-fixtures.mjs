#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findMutableExternalActionUses } from "../verify-github-actions-pinning.mjs";
import {
  approvalCountForHead,
  approvedReviewersForHead,
  classifyDependabotFiles,
  countableReviewersForHead,
  dependabotApprovalForHead,
  coreReviewerLogins,
  isCoreAuthor,
  isDependabotAuthor,
  isCountableReviewer,
  leaderIsLastPusher,
  leaderParticipated,
  leaderReviewMode,
  leaderSelfReviewForHead,
  requiredApprovalsForAuthor,
} from "./review-policy.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const fixturePolicy = {
  ...policy,
  reviewEnforcement: {
    ...policy.reviewEnforcement,
    coreReviewerLogins: [policy.leader, "core-a", "core-b", "reviewer-a"],
  },
};

const titlePattern =
  /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+$/;
assert.match("feat(governance): 建立工程治理基线", titlePattern);
assert.doesNotMatch("governance baseline", titlePattern);

function globToRegExp(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") expression += "[^/]*";
    else expression += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

assert.ok(
  policy.highRiskPaths.some((pattern) =>
    globToRegExp(pattern).test("web/server/pi-rpc-transport.ts"),
  ),
);
assert.ok(
  policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test("web/shared/api-contracts.ts")),
);
assert.ok(!policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test("docs/README.md")));
assert.ok(
  policy.highRiskPaths.length <= 15,
  "GitHub required reviewer rules allow at most 15 file patterns per reviewer",
);

function exceptionErrors(item, now = Date.parse("2026-08-04T00:00:00Z")) {
  const errors = [];
  const approved = Date.parse(item.approvedAt || "");
  const expires = Date.parse(item.expiresAt || "");
  if (!Number.isFinite(expires) || expires <= now) errors.push("expired");
  const maxDays = item.severity === "high" || item.severity === "critical" ? 30 : 90;
  if (
    Number.isFinite(approved) &&
    Number.isFinite(expires) &&
    expires - approved > maxDays * 86_400_000
  ) {
    errors.push("expanded");
  }
  if (/^\s*(?:\*|all|global|全仓库|全局)\s*$/i.test(item.scope || "")) {
    errors.push("scope-expanded");
  }
  return errors;
}

assert.deepEqual(
  exceptionErrors({ approvedAt: "2026-08-01", expiresAt: "2026-08-02", severity: "high" }),
  ["expired"],
);
assert.deepEqual(
  exceptionErrors({ approvedAt: "2026-08-01", expiresAt: "2026-09-01", severity: "high" }),
  ["expanded"],
);
assert.deepEqual(
  exceptionErrors({ approvedAt: "2026-08-01", expiresAt: "2026-08-30", severity: "high" }),
  [],
);
assert.deepEqual(
  exceptionErrors({ scope: "*", approvedAt: "2026-08-01", expiresAt: "2026-08-30" }),
  ["scope-expanded"],
);

const pinResult = findMutableExternalActionUses([
  { path: "fixture.yml", source: "- uses: actions/checkout@v4\n" },
]);
assert.equal(pinResult.failures.length, 1);
assert.equal(pinResult.externalUses, 1);

const codeowners = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
assert.match(codeowners, /@agentbridges-ai\/piwork-core/);
assert.match(codeowners, /@Misakago/);
assert.equal(new Set(policy.requiredChecks).size, policy.requiredChecks.length);
assert.equal(policy.leaderApprovals, 0);
assert.equal(policy.leaderReviewMode, "self-or-exempt");
assert.equal(policy.nonLeaderCoreApprovals, 2);
assert.deepEqual(policy.requiredRepositorySecrets, ["PIWORK_RELEASE_TOKEN"]);
assert.equal(policy.reviewEnforcement.statusCheck, "governance-review");
assert.equal(policy.reviewEnforcement.mode, "trusted-pull-request-target");
assert.equal(policy.reviewEnforcement.failClosed, true);
assert.equal(policy.reviewEnforcement.ownershipMetadata, "CODEOWNERS");
assert.equal(policy.reviewEnforcement.lastPushApprovalEnforcement, "governance-review");
assert.equal(policy.reviewEnforcement.authorAwareLastPush.enforcedBy, "governance-review");
assert.equal(policy.reviewEnforcement.authorAwareLastPush.requireCurrentHeadReview, true);
assert.equal(policy.reviewEnforcement.authorAwareLastPush.leaderAuthorExempt, true);
assert.deepEqual(policy.reviewEnforcement.coreReviewerLogins, [policy.leader]);
assert.equal(policy.reviewEnforcement.unknownReviewerBehavior, "reject");
assert.equal(policy.reviewEnforcement.nativeRuleset.requiredApprovingReviewCount, 0);
assert.deepEqual(policy.reviewEnforcement.nativeRuleset.requiredReviewers, []);
assert.equal(policy.reviewEnforcement.nativeRuleset.requireCodeOwnerReview, false);
assert.equal(policy.reviewEnforcement.nativeRuleset.requireLastPushApproval, false);
assert.equal(policy.reviewEnforcement.nativeRuleset.requiredReviewThreadResolution, true);
assert.equal(policy.reviewEnforcement.authorAwareRules.nonLeaderCore.requiredApprovals, 2);
assert.equal(policy.reviewEnforcement.authorAwareRules.community.requiredApprovals, 1);
assert.equal(policy.reviewEnforcement.authorAwareRules.dependabot.requiredReviewer, policy.leader);
assert.equal(policy.reviewEnforcement.authorAwareRules.dependabot.currentHead, true);
assert.equal(coreReviewerLogins(policy).has(policy.leader), true);
assert.equal(isCountableReviewer("unknown-reviewer", policy), false);
assert.equal(policy.dependabotReview.enabled, true);
assert.deepEqual(policy.dependabotReview.authorLogins, ["dependabot[bot]", "app/dependabot"]);
assert.equal(policy.dependabotReview.leader, policy.leader);
assert.equal(policy.dependabotReview.requiredApprovals, 1);
assert.equal(policy.dependabotReview.workflowActionPinOnly, true);
assert.ok(policy.dependabotReview.allowedPathGlobs.includes("**/package.json"));
assert.ok(
  policy.dependabotReview.allowedPathGlobs.includes("scripts/governance/dependabot-fixtures.mjs"),
);
assert.ok(policy.dependabotReview.excludedPathGlobs.includes("web/server/**"));
assert.ok(policy.dependabotReview.excludedPathGlobs.includes(".github/workflows/deploy.yml"));
assert.ok(policy.dependabotReview.workflowActionPinPaths.includes(".github/workflows/codeql.yml"));
assert.ok(policy.dependabotReview.excludedWorkflowPaths.includes(".github/workflows/deploy.yml"));
assert.ok(
  policy.dependabotReview.excludedWorkflowPaths.includes(".github/workflows/governance.yml"),
);
assert.equal(policy.dependabotReview.lastPushApprovalEnforcement, "governance-review");
assert.equal(policy.dependabotReview.signedCommitsRequired, true);
assert.equal(policy.dependabotReview.requiredChecks, "requiredChecks");
for (const excludedClass of ["high-risk", "product", "security", "release"]) {
  assert.ok(policy.dependabotReview.excludedPathClasses.includes(excludedClass));
}
assert.equal(leaderReviewMode(policy), "self-or-exempt");
assert.equal(requiredApprovalsForAuthor(policy.leader, policy), 0);
const leaderNoReviewCount = approvalCountForHead({
  reviews: [],
  headSha: "head",
  authorLogin: policy.leader,
  policy,
});
assert.equal(leaderNoReviewCount, 0);
assert.ok(
  leaderNoReviewCount >= requiredApprovalsForAuthor(policy.leader, policy),
  "Misakago author passes with no Review under self-or-exempt mode",
);
const leaderSelfReview = {
  state: "APPROVED",
  commit: { oid: "head" },
  author: { login: policy.leader },
};
assert.equal(leaderSelfReviewForHead([leaderSelfReview], "head", policy.leader, policy), true);
assert.equal(
  approvalCountForHead({
    reviews: [leaderSelfReview],
    headSha: "head",
    authorLogin: policy.leader,
    policy,
  }),
  1,
  "an existing Leader self-review may be displayed but is not fabricated",
);
assert.deepEqual(approvedReviewersForHead([leaderSelfReview], "head", policy.leader), []);
assert.equal(isCoreAuthor("another-core-dev", policy, "MEMBER"), true);
assert.equal(requiredApprovalsForAuthor("another-core-dev", policy, "MEMBER"), 2);
assert.equal(
  approvalCountForHead({
    reviews: [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "core-a" } },
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "core-b" } },
    ],
    headSha: "head",
    authorLogin: "another-core-dev",
    policy: fixturePolicy,
  }),
  2,
);
assert.equal(isCoreAuthor("community-contributor", policy, "CONTRIBUTOR"), false);
assert.equal(
  requiredApprovalsForAuthor("community-contributor", policy, "CONTRIBUTOR"),
  policy.ordinaryApprovals,
);
assert.equal(
  approvalCountForHead({
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: "reviewer-a" } }],
    headSha: "head",
    authorLogin: "community-contributor",
    policy: fixturePolicy,
  }),
  1,
);
assert.equal(
  approvalCountForHead({
    reviews: [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "unknown-reviewer" } },
    ],
    headSha: "head",
    authorLogin: "community-contributor",
    policy,
  }),
  0,
  "unknown reviewer identities cannot satisfy community approval",
);
assert.deepEqual(
  countableReviewersForHead(
    [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "reviewer-a" } },
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "unknown-reviewer" } },
    ],
    "head",
    fixturePolicy,
  ),
  ["reviewer-a"],
);
assert.equal(
  approvalCountForHead({
    reviews: [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "another-core-dev" } },
    ],
    headSha: "head",
    authorLogin: "another-core-dev",
    policy,
  }),
  0,
  "an author approval cannot satisfy the non-Leader Core rule",
);
assert.equal(
  leaderParticipated({ authorLogin: policy.leader, reviews: [], headSha: "head", policy }),
  true,
);
assert.equal(
  leaderParticipated({
    authorLogin: "another-core-dev",
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: policy.leader } }],
    headSha: "head",
    policy,
  }),
  true,
);
assert.equal(
  leaderParticipated({
    authorLogin: "another-core-dev",
    reviews: [{ state: "APPROVED", commit: { oid: "old" }, author: { login: policy.leader } }],
    headSha: "head",
    policy,
  }),
  false,
);
assert.deepEqual(
  approvedReviewersForHead(
    [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "reviewer-a" } },
      { state: "APPROVED", commit: { oid: "old" }, author: { login: "reviewer-b" } },
      { state: "COMMENTED", commit: { oid: "head" }, author: { login: "reviewer-c" } },
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "reviewer-a" } },
    ],
    "head",
  ),
  ["reviewer-a"],
);

const actionPinPatch = `@@ -1 +1 @@\n-        uses: github/codeql-action/init@${"a".repeat(40)} # v4.37.4\n+        uses: github/codeql-action/init@${"b".repeat(40)} # v4.37.5`;
const fixturePatch = `@@ -1 +1 @@\n-  "${"a".repeat(40)}",\n+  "${"b".repeat(40)}",`;
assert.equal(isDependabotAuthor("dependabot[bot]", policy), true);
assert.equal(isDependabotAuthor("app/dependabot", policy), true);
assert.equal(isDependabotAuthor("community-contributor", policy), false);
assert.deepEqual(
  classifyDependabotFiles(
    [
      { path: ".github/workflows/codeql.yml", patch: actionPinPatch },
      { path: "scripts/governance/dependabot-fixtures.mjs", patch: fixturePatch },
    ],
    policy,
  ),
  {
    eligible: true,
    reason: "SHA-pinned workflow action update (with optional exact SHA fixture)",
  },
);
assert.equal(
  classifyDependabotFiles(
    [{ path: "web/package.json", patch: '@@ -1 +1 @@\n-  "x": 1\n+  "x": 2' }],
    policy,
  ).eligible,
  true,
);
for (const forbiddenPath of ["web/server/index.ts", "release/onlyoffice-release-manifest.json"])
  assert.equal(
    classifyDependabotFiles([{ path: forbiddenPath, patch: "@@ -1 +1 @@\n-a\n+b" }], policy)
      .eligible,
    false,
    `${forbiddenPath} must remain outside Dependabot low-risk scope`,
  );
assert.equal(
  requiredApprovalsForAuthor("app/dependabot", policy, "BOT"),
  policy.ordinaryApprovals,
  "out-of-scope Dependabot changes fall back to the ordinary author-aware rule",
);
assert.equal(
  classifyDependabotFiles(
    [
      {
        path: ".github/workflows/codeql.yml",
        patch: "@@ -1 +1 @@\n-        run: old\n+        run: new",
      },
    ],
    policy,
  ).eligible,
  false,
  "workflow code changes are not action-pin-only",
);
assert.equal(
  classifyDependabotFiles([{ path: ".github/workflows/deploy.yml", patch: actionPinPatch }], policy)
    .eligible,
  false,
  "deploy workflow action pins remain high-risk",
);
assert.equal(
  classifyDependabotFiles(
    [{ path: "scripts/governance/dependabot-fixtures.mjs", patch: fixturePatch }],
    policy,
  ).eligible,
  false,
  "fixture-only changes cannot opt into low-risk review",
);
const dependabotLeaderReview = {
  state: "APPROVED",
  commit: { oid: "head" },
  author: { login: policy.leader },
};
assert.equal(
  dependabotApprovalForHead({
    reviews: [dependabotLeaderReview],
    headSha: "head",
    policy,
    headCommit: { authorLogin: "dependabot[bot]", committerLogin: "dependabot[bot]" },
  }).satisfied,
  true,
  "Dependabot PR accepts one current-head Leader approval when Leader is not the pusher",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [dependabotLeaderReview],
    headSha: "head",
    policy,
    headCommit: { authorLogin: policy.leader, committerLogin: policy.leader },
  }).satisfied,
  false,
  "Leader cannot self-count governance current-head approval for a manually replayed head",
);
assert.equal(leaderIsLastPusher({ authorLogin: policy.leader }, policy), true);
assert.equal(
  dependabotApprovalForHead({
    reviews: [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "another-core-dev" } },
    ],
    headSha: "head",
    policy,
    headCommit: { authorLogin: "dependabot[bot]", committerLogin: "dependabot[bot]" },
  }).satisfied,
  false,
  "a non-Leader approval cannot satisfy the Dependabot-only Leader rule",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: "app/dependabot" } }],
    headSha: "head",
    policy,
    headCommit: { authorLogin: "dependabot[bot]", committerLogin: "dependabot[bot]" },
  }).satisfied,
  false,
  "an author approval cannot satisfy the Dependabot-only Leader rule",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [{ ...dependabotLeaderReview, commit: { oid: "old" } }],
    headSha: "head",
    policy,
    headCommit: { authorLogin: "dependabot[bot]", committerLogin: "dependabot[bot]" },
  }).satisfied,
  false,
  "an approval on an old head cannot satisfy Dependabot review",
);

console.log(
  "[governance-fixtures] exceptions, expansion, path classification, PR title, CODEOWNERS, Action pin, and Dependabot review fixtures passed",
);
