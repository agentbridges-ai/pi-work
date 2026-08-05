#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findMutableExternalActionUses } from "../verify-github-actions-pinning.mjs";
import {
  approvedReviewersForHead,
  isCoreAuthor,
  requiredApprovalsForAuthor,
} from "./review-policy.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));

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
assert.equal(policy.leaderApprovals, 1);
assert.equal(policy.nonLeaderCoreApprovals, 2);
assert.deepEqual(policy.requiredRepositorySecrets, ["PIWORK_RELEASE_TOKEN"]);
assert.equal(requiredApprovalsForAuthor(policy.leader, policy), 1);
assert.equal(isCoreAuthor("another-core-dev", policy, "MEMBER"), true);
assert.equal(requiredApprovalsForAuthor("another-core-dev", policy, "MEMBER"), 2);
assert.equal(isCoreAuthor("community-contributor", policy, "CONTRIBUTOR"), false);
assert.equal(
  requiredApprovalsForAuthor("community-contributor", policy, "CONTRIBUTOR"),
  policy.ordinaryApprovals,
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

console.log(
  "[governance-fixtures] exceptions, expansion, path classification, PR title, CODEOWNERS, and Action pin fixtures passed",
);
