#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findMutableExternalActionUses } from "../verify-github-actions-pinning.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const controls = JSON.parse(readFileSync(join(root, ".governance/controls.json"), "utf8"));
const trackedOutputs = spawnSync("git", ["ls-files", "--", "outputs"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(trackedOutputs.status, 0);
assert.equal(trackedOutputs.stdout.trim(), "", "generated outputs must stay out of Git history");

const titlePattern =
  /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+$/;
assert.match("feat(governance): simplify repository policy", titlePattern);
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
  if (/^\s*(?:\*|all|global)\s*$/i.test(item.scope || "")) errors.push("scope-expanded");
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
assert.doesNotMatch(
  codeowners,
  /@(?!agentbridges-ai\/piwork-(?:core|leads)\b|earendil-works\/pi-coding-agent\b)[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?/,
);
assert.doesNotMatch(codeowners, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
assert.equal(new Set(policy.requiredChecks).size, policy.requiredChecks.length);
assert.equal(policy.maintainerTeam, "piwork-core");
assert.equal(policy.releaseTeam, "piwork-leads");
assert.equal(policy.ordinaryApprovals, 1);
assert.equal(policy.highRiskApprovals, 2);
assert.deepEqual(policy.requiredRepositorySecrets, ["PIWORK_RELEASE_TOKEN"]);
assert.equal(policy.mergeQueue.enabled, false);
assert.equal(policy.stackedPullRequests.enabled, false);
assert.equal(controls.controls.length, 30);
assert.ok(
  controls.controls.every(
    (control) => control.owner === "maintainers" || control.owner === "core-team",
  ),
);

for (const file of ["README.md", "CONTRIBUTING.md", "GOVERNANCE.md", "SECURITY.md"]) {
  const text = readFileSync(join(root, file), "utf8");
  assert.doesNotMatch(
    text,
    /@(?!agentbridges-ai\/piwork-(?:core|leads)\b|earendil-works\/pi-coding-agent\b)[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?/,
  );
  assert.doesNotMatch(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
}

console.log(
  "[governance-fixtures] policy, controls, exceptions, public ownership, PR titles, and action pins passed",
);
