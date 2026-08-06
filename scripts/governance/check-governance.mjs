#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const fail = [];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    fail.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function requireFile(file) {
  if (!existsSync(join(root, file))) fail.push(`${file}: required governance file is missing`);
}

for (const file of [
  "CONTRIBUTING.md",
  "SECURITY.md",
  "GOVERNANCE.md",
  "CHANGELOG.md",
  "LICENSE",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".governance/controls.json",
  ".governance/github-policy.json",
  ".governance/license-policy.json",
  ".governance/exceptions.json",
])
  requireFile(file);

const controls = readJson(".governance/controls.json");
const controlIds = new Set(controls?.controls?.map((control) => control.id) || []);
if (controls) {
  const statuses = new Set(controls.statuses || []);
  const ids = new Set();
  for (const control of controls.controls || []) {
    if (ids.has(control.id)) fail.push(`controls.json: duplicate control ${control.id}`);
    ids.add(control.id);
    if (!statuses.has(control.status)) fail.push(`controls.json: invalid status for ${control.id}`);
    if (!control.owner || !control.evidence?.length)
      fail.push(`controls.json: missing owner/evidence for ${control.id}`);
    for (const evidence of control.evidence || []) {
      if (!evidence.startsWith("http") && !existsSync(join(root, evidence))) {
        fail.push(`controls.json: ${control.id} evidence is missing: ${evidence}`);
      }
    }
  }
  if (controls.controls?.length !== 30) {
    fail.push(`controls.json: expected 30 controls, found ${controls.controls?.length ?? 0}`);
  }
}

const policy = readJson(".governance/github-policy.json");
if (policy) {
  if (policy.leader !== "Misakago") fail.push("github-policy.json: leader must remain Misakago");
  if (policy.coreTeam !== "piwork-core" || policy.leadsTeam !== "piwork-leads") {
    fail.push("github-policy.json: unexpected governance team slug");
  }
  if (policy.productionEnvironment !== "production" || policy.productionBranch !== "main") {
    fail.push("github-policy.json: production environment must be main-only");
  }
  if (
    policy.releaseAutomation !== "github-actions" ||
    policy.workflowPermissions?.default !== "read" ||
    policy.workflowPermissions?.canApprovePullRequestReviews !== false
  ) {
    fail.push(
      "github-policy.json: workflow permissions or release automation policy is incomplete",
    );
  }
  if (
    policy.leaderApprovals !== 0 ||
    policy.leaderReviewMode !== "self-or-exempt" ||
    policy.nonLeaderCoreApprovals !== 2
  ) {
    fail.push(
      "github-policy.json: Leader must use self-or-exempt governance mode and non-Leader Core authors require two",
    );
  }
  if (!policy.requiredRepositorySecrets?.includes("PIWORK_RELEASE_TOKEN")) {
    fail.push("github-policy.json: PIWORK_RELEASE_TOKEN repository secret is required");
  }
  if (!Array.isArray(policy.securityFeatures) || policy.securityFeatures.length < 5) {
    fail.push("github-policy.json: security feature policy is incomplete");
  }
  for (const check of policy.requiredChecks || []) {
    if (!/^[a-z0-9-]+$/.test(check)) fail.push(`github-policy.json: invalid check name ${check}`);
  }
  if (!Array.isArray(policy.highRiskPaths) || policy.highRiskPaths.length < 10) {
    fail.push("github-policy.json: high-risk path policy is incomplete");
  }
}

const exceptions = readJson(".governance/exceptions.json");
if (exceptions) {
  const now = Date.now();
  const ids = new Set();
  for (const item of exceptions.exceptions || []) {
    if (ids.has(item.id)) fail.push(`exceptions.json: duplicate exception ${item.id}`);
    ids.add(item.id);
    if (!controlIds.has(item.control)) fail.push(`${item.id}: unknown control ${item.control}`);
    if (/^\s*(?:\*|all|global|全仓库|全局)\s*$/i.test(item.scope || "")) {
      fail.push(`${item.id}: exception scope is expanded beyond an explicit target`);
    }
    if (!item.trackingIssue?.startsWith("https://github.com/"))
      fail.push(`${item.id}: trackingIssue must be a GitHub URL`);
    if (!item.owner || !item.approvedBy || !item.approvedAt || !item.expiresAt)
      fail.push(`${item.id}: incomplete approval metadata`);
    const expires = Date.parse(item.expiresAt || "");
    const approved = Date.parse(item.approvedAt || "");
    if (!Number.isFinite(expires) || expires <= now) fail.push(`${item.id}: exception is expired`);
    if (!Number.isFinite(approved) || !Number.isFinite(expires) || expires <= approved)
      fail.push(`${item.id}: invalid exception date range`);
    const maxDays = item.severity === "high" || item.severity === "critical" ? 30 : 90;
    if (
      Number.isFinite(approved) &&
      Number.isFinite(expires) &&
      expires - approved > maxDays * 86_400_000 + 60_000
    ) {
      fail.push(`${item.id}: exception exceeds ${maxDays}-day maximum`);
    }
  }
}

const codeowners = existsSync(join(root, ".github/CODEOWNERS"))
  ? readFileSync(join(root, ".github/CODEOWNERS"), "utf8")
  : "";
if (!codeowners.includes("@agentbridges-ai/piwork-core"))
  fail.push("CODEOWNERS: Core Team is missing");
if (!codeowners.includes("@Misakago")) fail.push("CODEOWNERS: Leader is missing");

const titlePattern =
  /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .+$/;
for (const title of ["feat(governance): 建立工程治理基线", "fix: 修复运行态权限"]) {
  if (!titlePattern.test(title)) fail.push(`PR title fixture does not match: ${title}`);
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

for (const file of walk(join(root, "docs"))) {
  // The Pi source tree is a pinned read-only submodule. Its upstream
  // documentation and fixtures follow Pi's own governance contract, not
  // Piwork's local frontmatter/link policy.
  if (
    file === join(root, "docs/upstream") ||
    file.startsWith(`${join(root, "docs/upstream")}${sep}`)
  ) {
    continue;
  }
  if (!file.endsWith(".md") || file.endsWith("README.md")) continue;
  const text = readFileSync(file, "utf8");
  if (text.startsWith("---\n")) {
    const header = text.split("---\n", 3)[1] || "";
    for (const key of ["owner", "status", "last_reviewed", "review_cycle_days"]) {
      if (!new RegExp(`^${key}:\\s*.+$`, "m").test(header)) {
        fail.push(`${relative(root, file)}: missing frontmatter ${key}`);
      }
    }
  }
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (target.startsWith("http") || target.startsWith("mailto:")) continue;
    const resolved = resolve(file, "..", target);
    if (!existsSync(resolved) && !existsSync(`${resolved}.md`))
      fail.push(`${relative(root, file)}: broken link ${target}`);
  }
}

if (fail.length) {
  console.error(fail.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(
  "[governance] policy, controls, exceptions, CODEOWNERS, PR fixtures, and docs metadata verified",
);
