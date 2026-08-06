#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findMutableExternalActionUses } from "../verify-github-actions-pinning.mjs";
import {
  approvalCountForHead,
  auditStatusWriterWorkflowChanges,
  auditStatusWriterWorkflowContents,
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
  pusherEvidenceDescription,
  requiredApprovalsForAuthor,
  selectLastPusherEvent,
  selectPersistedPusherStatus,
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
const leaderReviewWorkflow = readFileSync(
  join(root, ".github/workflows/leader-review.yml"),
  "utf8",
);
assert.doesNotMatch(leaderReviewWorkflow, /^\s*workflow_dispatch\s*:/m);
assert.match(leaderReviewWorkflow, /ref:\s*refs\/heads\/main\s*$/m);
assert.match(leaderReviewWorkflow, /^\s*actions:\s*read\s*$/m);
assert.match(
  leaderReviewWorkflow,
  /group:\s*governance-review-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/m,
);
assert.deepEqual(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/example.yml",
      patch: "@@ -1 +1 @@\n-  contents: read\n+  contents: read",
    },
  ]),
  { allowed: true, failures: [] },
  "ordinary workflow permission changes remain auditable",
);
assert.equal(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/example.yml",
      patch: "@@ -1 +1 @@\n-  contents: read\n+  statuses: write",
    },
  ]).allowed,
  false,
  "PR-controlled workflows cannot add statuses: write",
);
assert.equal(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/example.yml",
      patch: '@@ -1 +1 @@\n-  contents: read\n+  "statuses": "write"',
    },
  ]).allowed,
  false,
  "quoted status permission keys cannot evade the workflow audit",
);
assert.equal(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/example.yml",
      patch: '@@ -1 +1 @@\n-  contents: read\n+  "statuses": "wri\\u0074e"',
    },
  ]).allowed,
  false,
  "escaped YAML status permission values cannot evade the workflow audit",
);
assert.equal(
  auditStatusWriterWorkflowChanges([
    { path: ".github/workflows/example.yml", patch: "@@ -1 +1 @@\n+permissions: write-all" },
  ]).allowed,
  false,
  "PR-controlled workflows cannot add permissions: write-all",
);
assert.match(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/leader-review.yml",
      patch: "@@ -1 +1 @@\n-  pull_request_target:\n+  pull_request:\n",
    },
  ]).failures.join("\n"),
  /trusted pull_request_target entry point/,
);
assert.match(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/leader-review.yml",
      patch: "@@ -1 +1 @@\n+  workflow_dispatch:\n",
    },
  ]).failures.join("\n"),
  /trusted pull_request_target entry point/,
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/example.yml",
      source: "on:\n  pull_request:\npermissions:\n  contents: read\n",
    },
  ]).allowed,
  true,
  "ordinary workflows without status-writing permissions remain allowed",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/example.yml",
      source: "on:\n  pull_request:\npermissions:\n  statuses: write\n",
    },
  ]).allowed,
  false,
  "resulting PR workflows cannot reuse status-writing permissions",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/leader-review.yml",
      source:
        "on:\n  pull_request_target:\npermissions:\n  statuses: write\njobs:\n  review:\n    steps:\n      - uses: actions/checkout@sha\n        with:\n          ref: refs/heads/main\n      - run: node scripts/governance/leader-review.mjs\n",
    },
  ]).allowed,
  true,
  "trusted status writer structure is allowed",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/leader-review.yml",
      source:
        "on:\n  pull_request:\npermissions:\n  statuses: write\njobs:\n  review:\n    steps:\n      - run: curl https://api.github.com/statuses\n",
    },
  ]).allowed,
  false,
  "status writer trigger and direct status commands are rejected",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/example.yml",
      source: 'on:\n  pull_request:\npermissions:\n  "statuses": "write"\n',
    },
  ]).allowed,
  false,
  "quoted resulting status permission keys are rejected",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/example.yml",
      source: 'on:\n  pull_request:\npermissions:\n  "statuses": "wri\\u0074e"\n',
    },
  ]).allowed,
  false,
  "escaped YAML resulting status permission values are rejected",
);
assert.equal(
  auditStatusWriterWorkflowChanges([
    {
      path: ".github/workflows/example.yml",
      patch: "@@ -1 +1 @@\n-  contents: read\n+  statuses: >-\n+    write",
    },
  ]).allowed,
  false,
  "folded YAML status permission values cannot evade the workflow audit",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/example.yml",
      source: "on:\n  pull_request:\npermissions:\n  statuses: |\n    write\n",
    },
  ]).allowed,
  false,
  "block YAML resulting status permission values are rejected",
);
assert.equal(
  auditStatusWriterWorkflowContents([
    {
      path: ".github/workflows/leader-review.yml",
      source:
        "on:\n  pull_request_target:\n  push:\npermissions:\n  statuses: write\njobs:\n  review:\n    steps:\n      - uses: actions/checkout@sha\n        with:\n          ref: refs/heads/main\n      - run: node scripts/governance/leader-review.mjs\n",
    },
  ]).allowed,
  false,
  "push trigger additions to the status writer are rejected",
);
assert.equal(
  auditStatusWriterWorkflowChanges([{ path: ".github/workflows/example.yml" }]).allowed,
  false,
  "workflow changes without an auditable patch fail closed",
);
assert.equal(new Set(policy.requiredChecks).size, policy.requiredChecks.length);
assert.equal(policy.leaderApprovals, 0);
assert.equal(policy.leaderReviewMode, "self-or-exempt");
assert.equal(policy.nonLeaderCoreApprovals, 2);
assert.deepEqual(policy.requiredRepositorySecrets, ["PIWORK_RELEASE_TOKEN"]);
assert.equal(policy.requiredStatusCheckIntegrationId, 15368);
assert.equal(policy.reviewEnforcement.statusCheck, "governance-review");
assert.equal(policy.reviewEnforcement.mode, "trusted-pull-request-target");
assert.equal(policy.reviewEnforcement.failClosed, true);
assert.equal(policy.reviewEnforcement.ownershipMetadata, "CODEOWNERS");
assert.equal(policy.reviewEnforcement.lastPushApprovalEnforcement, "governance-review");
assert.equal(policy.reviewEnforcement.leaderVote.reviewer, policy.leader);
assert.equal(policy.reviewEnforcement.leaderVote.scope, "all-pull-requests-including-automation");
assert.equal(policy.reviewEnforcement.leaderVote.currentHead, true);
assert.equal(policy.reviewEnforcement.leaderVote.countsOnce, true);
assert.equal(policy.reviewEnforcement.leaderVote.authorRule, "self-or-exempt");
assert.equal(policy.reviewEnforcement.authorAwareLastPush.enforcedBy, "governance-review");
assert.equal(policy.reviewEnforcement.authorAwareLastPush.requireCurrentHeadReview, true);
assert.equal(policy.reviewEnforcement.authorAwareLastPush.leaderAuthorExempt, true);
assert.equal(policy.reviewEnforcement.authorAwareLastPush.nonLeaderCannotBeLastPusher, true);
assert.equal(
  policy.reviewEnforcement.authorAwareLastPush.lastPusherIdentitySource,
  "trusted-commit-status-or-head-repository-push-event-actor",
);
assert.equal(policy.reviewEnforcement.authorAwareLastPush.lastPusherFailClosed, true);
assert.deepEqual(policy.reviewEnforcement.authorAwareLastPush.pusherEvidenceStatus, {
  context: "governance-review-pusher",
  source: "trusted-leader-review-commit-status",
  retention: "commit-status",
  requiresReadOnlyWorkflowPermissions: true,
  format:
    "actual-pusher:v2:<sha256(repository\\u0000pullRequestNumber\\u0000headRef)>:<urlEncodedLogin>",
});
assert.deepEqual(policy.reviewEnforcement.coreReviewerLogins, [policy.leader]);
assert.equal(policy.reviewEnforcement.unknownReviewerBehavior, "reject");
assert.equal(policy.reviewEnforcement.reviewerAllowlist.minimumIdentitiesForNonLeaderCore, 2);
assert.equal(policy.reviewEnforcement.reviewerAllowlist.bootstrapState, "leader-only");
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
assert.deepEqual(
  selectLastPusherEvent(
    [
      {
        id: 10,
        type: "PushEvent",
        payload: { head: "head", ref: "refs/heads/feature" },
        actor: { login: "community-dev" },
        created_at: "2026-08-06T00:01:00Z",
      },
      {
        id: 11,
        type: "PushEvent",
        payload: { head: "head", ref: "refs/heads/other" },
        actor: { login: "unrelated-pusher" },
        created_at: "2026-08-06T00:02:00Z",
      },
      {
        id: 12,
        type: "PullRequestEvent",
        payload: { action: "opened", head: "head" },
        actor: { login: "opener" },
        created_at: "2026-08-06T00:03:00Z",
      },
    ],
    "head",
    "feature",
  ),
  { login: "community-dev", eventId: 10 },
  "repository PushEvent actor identifies the matching head branch pusher; PR opener is ignored",
);
assert.equal(
  selectLastPusherEvent(
    [
      {
        id: 13,
        type: "PushEvent",
        payload: { head: "other-head", ref: "refs/heads/feature" },
        actor: { login: "community-dev" },
      },
    ],
    "head",
    "feature",
  ),
  null,
  "missing matching PushEvent must fail closed",
);
assert.deepEqual(
  selectPersistedPusherStatus(
    [
      {
        id: 20,
        context: "governance-review-pusher",
        state: "success",
        description: `actual-pusher:v2:${pusherEvidenceDescription({
          repository: policy.repository,
          pullRequestNumber: 67,
          headRef: "feature",
          login: "community-dev",
        })}`,
        creator: { login: "github-actions[bot]" },
        created_at: "2026-08-06T00:01:00Z",
      },
      {
        id: 21,
        context: "governance-review-pusher",
        state: "success",
        description: `actual-pusher:v2:${pusherEvidenceDescription({
          repository: policy.repository,
          pullRequestNumber: 67,
          headRef: "feature",
          login: "Misakago",
        })}`,
        creator: { login: "github-actions[bot]" },
        created_at: "2026-08-06T00:02:00Z",
      },
      {
        id: 22,
        context: "governance-review-pusher",
        state: "success",
        description: `actual-pusher:v2:${pusherEvidenceDescription({
          repository: policy.repository,
          pullRequestNumber: 67,
          headRef: "feature",
          login: "spoofed",
        })}`,
        creator: { login: "write-capable-user" },
        created_at: "2026-08-06T00:03:00Z",
      },
    ],
    { repository: policy.repository, pullRequestNumber: 67, headRef: "feature" },
  ),
  {
    login: "Misakago",
    repository: policy.repository,
    pullRequestNumber: 67,
    headRef: "feature",
    statusId: 21,
  },
  "only trusted commit-status pusher evidence is retained and the latest record wins",
);
assert.equal(
  selectPersistedPusherStatus(
    [
      {
        id: 23,
        context: "governance-review-pusher",
        state: "success",
        description: `actual-pusher:v2:${pusherEvidenceDescription({
          repository: policy.repository,
          pullRequestNumber: 66,
          headRef: "feature",
          login: "wrong-pr",
        })}`,
        creator: { login: "github-actions[bot]" },
      },
    ],
    { repository: policy.repository, pullRequestNumber: 67, headRef: "feature" },
  ),
  null,
  "pusher evidence from another PR cannot be reused by SHA",
);
const compactPusherDescription = `actual-pusher:v2:${pusherEvidenceDescription({
  repository: policy.repository,
  pullRequestNumber: 67,
  headRef: `feature/${"long-branch-segment-".repeat(20)}`,
  login: "github-actions[bot]",
})}`;
assert.ok(
  compactPusherDescription.length <= 140,
  "compact pusher evidence remains within GitHub's commit-status description limit",
);
assert.equal(
  selectPersistedPusherStatus(
    [
      {
        id: 24,
        context: "governance-review-pusher",
        state: "success",
        description: "actual-pusher:v1:agentbridges-ai%2Fpi-work:67:feature:community-dev",
        creator: { login: "github-actions[bot]" },
      },
    ],
    { repository: policy.repository, pullRequestNumber: 67, headRef: "feature" },
  ),
  null,
  "legacy v1 pusher evidence is rejected",
);
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
  approvalCountForHead({
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: policy.leader } }],
    headSha: "head",
    authorLogin: "community-contributor",
    policy: fixturePolicy,
    lastPusher: { login: policy.leader, runId: 101 },
  }),
  0,
  "a Leader who pushed a non-Leader head cannot self-count that approval",
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
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: policy.leader } }],
    headSha: "head",
    policy,
    lastPusher: { login: policy.leader, runId: 101 },
  }),
  false,
  "Leader participation cannot be self-counted after pushing a non-Leader head",
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
assert.deepEqual(
  approvedReviewersForHead(
    [
      {
        state: "APPROVED",
        submittedAt: "2026-08-06T10:00:00Z",
        commit: { oid: "head" },
        author: { login: "reviewer-a" },
      },
      {
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-08-06T10:01:00Z",
        commit: { oid: "head" },
        author: { login: "reviewer-a" },
      },
    ],
    "head",
  ),
  [],
  "a later CHANGES_REQUESTED review supersedes an earlier approval",
);
assert.deepEqual(
  approvedReviewersForHead(
    [
      {
        state: "APPROVED",
        submittedAt: "2026-08-06T10:00:00Z",
        commit: { oid: "head" },
        author: { login: "reviewer-a" },
      },
      {
        state: "COMMENTED",
        submittedAt: "2026-08-06T10:01:00Z",
        commit: { oid: "head" },
        author: { login: "reviewer-a" },
      },
    ],
    "head",
  ),
  ["reviewer-a"],
  "a later COMMENTED review does not revoke an approval",
);

const actionPinPatch = `@@ -1 +1 @@\n--        uses: github/codeql-action/init@${"a".repeat(40)} # v4.37.4\n+-        uses: github/codeql-action/init@${"b".repeat(40)} # v4.37.5`;
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
    lastPusher: { login: "dependabot[bot]", runId: 101 },
  }).satisfied,
  true,
  "Dependabot PR accepts one current-head Leader approval when Leader is not the pusher",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [dependabotLeaderReview],
    headSha: "head",
    policy,
    lastPusher: { login: policy.leader, runId: 101 },
  }).satisfied,
  false,
  "Leader cannot self-count governance current-head approval for a manually replayed head",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [dependabotLeaderReview],
    headSha: "head",
    policy,
    lastPusher: null,
  }).satisfied,
  false,
  "missing actual last-pusher evidence must fail closed",
);
assert.equal(leaderIsLastPusher({ login: policy.leader }, policy), true);
assert.equal(
  dependabotApprovalForHead({
    reviews: [
      { state: "APPROVED", commit: { oid: "head" }, author: { login: "another-core-dev" } },
    ],
    headSha: "head",
    policy,
    lastPusher: { login: "dependabot[bot]", runId: 101 },
  }).satisfied,
  false,
  "a non-Leader approval cannot satisfy the Dependabot-only Leader rule",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [{ state: "APPROVED", commit: { oid: "head" }, author: { login: "app/dependabot" } }],
    headSha: "head",
    policy,
    lastPusher: { login: "dependabot[bot]", runId: 101 },
  }).satisfied,
  false,
  "an author approval cannot satisfy the Dependabot-only Leader rule",
);
assert.equal(
  dependabotApprovalForHead({
    reviews: [{ ...dependabotLeaderReview, commit: { oid: "old" } }],
    headSha: "head",
    policy,
    lastPusher: { login: "dependabot[bot]", runId: 101 },
  }).satisfied,
  false,
  "an approval on an old head cannot satisfy Dependabot review",
);

console.log(
  "[governance-fixtures] exceptions, expansion, path classification, PR title, CODEOWNERS, Action pin, and Dependabot review fixtures passed",
);
