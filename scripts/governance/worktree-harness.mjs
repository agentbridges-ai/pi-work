#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_VERSION = 1;
export const DEFAULT_POLICY_PATH = ".governance/worktree-policy.json";
export const DEFAULT_STATE_DIR = ".git/piwork-worktree-harness";
export const DEFAULT_INCLUDE_FILE = ".worktreeinclude";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SHA_RE = /^[0-9a-f]{40}$/;
const SECRET_KEY_RE = /(secret|token|password|api[-_]?key|credential)/i;
const REQUIRED_METADATA = [
  "taskId",
  "threadId",
  "owner",
  "branch",
  "worktreePath",
  "baseSha",
  "scope",
  "coordination",
];

class HarnessError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "HarnessError";
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode = 2) {
  throw new HarnessError(message, exitCode);
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function parseIso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runGit(args, cwd, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr ? `: ${stderr}` : "";
    fail(`git ${args.join(" ")} failed${detail}`);
  }
}

function pathIsInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalPath(path) {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function parseWorktreeList(text) {
  const result = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      if (current) result.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: canonicalPath(line.slice("worktree ".length)) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  if (current) result.push(current);
  return result.filter((entry) => entry.path && !entry.bare);
}

function discoverRepository(currentPath) {
  const currentRoot = canonicalPath(currentPath);
  const commonDirValue = runGit(["rev-parse", "--git-common-dir"], currentRoot);
  const commonDir = canonicalPath(
    isAbsolute(commonDirValue) ? commonDirValue : join(currentRoot, commonDirValue),
  );
  const worktrees = parseWorktreeList(runGit(["worktree", "list", "--porcelain"], currentRoot));
  if (!worktrees.length) fail("git returned no worktrees");
  const mainWorktree =
    worktrees.find((entry) => entry.branch === "main") ||
    worktrees.find((entry) => entry.branch === "master") ||
    worktrees[0];
  return { currentRoot, commonDir, mainRoot: mainWorktree.path, worktrees };
}

function loadPolicy(policyPath) {
  if (!existsSync(policyPath)) fail(`worktree policy is missing: ${policyPath}`);
  const policy = safeJsonParse(readFileSync(policyPath, "utf8"), policyPath);
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") fail("worktree policy must be an object");
  if (policy.version !== HARNESS_VERSION)
    fail(`unsupported worktree policy version: ${policy.version}`);
  if (policy.root?.readOnly !== true || policy.root?.mustRemainClean !== true) {
    fail("worktree policy must enforce a clean, read-only root checkout");
  }
  if (policy.branch?.prefix !== "misakago/" || typeof policy.branch?.pattern !== "string") {
    fail("worktree policy must use the misakago/ branch prefix and a branch pattern");
  }
  if (
    !Number.isInteger(policy.branch?.maxLength) ||
    policy.branch.maxLength < policy.branch.prefix.length
  ) {
    fail("worktree policy branch.maxLength is invalid");
  }
  if (
    typeof policy.paths?.worktreeRoot !== "string" ||
    typeof policy.paths?.stateDir !== "string"
  ) {
    fail("worktree policy paths.worktreeRoot and paths.stateDir are required");
  }
  if (typeof policy.base?.defaultRef !== "string" || policy.base.defaultRef.length === 0) {
    fail("worktree policy base.defaultRef is required");
  }
  if (
    policy.githubTracking?.repository !== "agentbridges-ai/pi-work" ||
    policy.githubTracking?.owner !== "root-coordinator" ||
    policy.githubTracking?.executionThreadsMayModify !== false ||
    policy.githubTracking?.writeApi !== false ||
    !Array.isArray(policy.githubTracking?.milestones) ||
    policy.githubTracking.milestones.length < 2
  ) {
    fail(
      "worktree policy must declare read-only GitHub milestone tracking for agentbridges-ai/pi-work",
    );
  }
  for (const githubMilestone of policy.githubTracking.milestones) {
    if (
      !Number.isInteger(githubMilestone.number) ||
      githubMilestone.number <= 0 ||
      typeof githubMilestone.stableId !== "string" ||
      typeof githubMilestone.title !== "string"
    ) {
      fail("GitHub milestone tracking entries must contain number, stableId, and title");
    }
  }
  if (
    policy.milestoneOps?.sourceOfTruth !== "github-milestone-and-tracker-issue" ||
    policy.milestoneOps?.requiredTrackerIssue !== true ||
    policy.milestoneOps?.requiredDependencyLinks !== true ||
    policy.milestoneOps?.dueDateRequired !== true ||
    policy.milestoneOps?.statusUpdateOnBlock !== true ||
    policy.milestoneOps?.scopeChangeRequiresRootReview !== true ||
    policy.milestoneOps?.milestoneCloseRequiresRoot !== true ||
    policy.milestoneOps?.labelsSparse !== true ||
    !Number.isInteger(policy.milestoneOps?.maxLabels) ||
    policy.milestoneOps.maxLabels <= 0 ||
    !Array.isArray(policy.milestoneOps?.blockedStatusEvidence) ||
    !policy.milestoneOps.blockedStatusEvidence.length ||
    !Array.isArray(policy.milestoneOps?.allowedLabels) ||
    !Array.isArray(policy.milestoneOps?.allowedStatuses) ||
    !policy.milestoneOps.allowedStatuses.length
  ) {
    fail(
      "worktree policy must make GitHub milestone/tracker operations, dependencies, due dates, blocked updates, and root review explicit",
    );
  }
  if (!Array.isArray(policy.scope?.highRiskPaths))
    fail("worktree policy scope.highRiskPaths is required");
  if (
    !Number.isFinite(policy.lock?.ttlMinutes) ||
    policy.lock.ttlMinutes <= 0 ||
    !Number.isFinite(policy.lock?.runtimeTtlSeconds) ||
    policy.lock.runtimeTtlSeconds <= 0
  ) {
    fail("worktree policy lock TTL values must be positive");
  }
  if (policy.workflow?.reviewBypass !== false) fail("worktree policy must not allow review bypass");
  if (policy.secrets?.worktreeIncludeOnlyGitignoredEnv !== true) {
    fail("worktree policy must restrict .worktreeinclude to gitignored .env files");
  }
  if (
    policy.coordinationModel?.rootUserFacingCoordinator !== true ||
    policy.coordinationModel?.manifestIsAuthority !== true ||
    policy.coordinationModel?.milestoneOwner !== "root-coordinator" ||
    policy.coordinationModel?.executionThreadsUseExclusiveWorktree !== true ||
    policy.coordinationModel?.requiredMilestoneEvidence !== true ||
    policy.coordinationModel?.requiredHandoff !== true ||
    policy.coordinationModel?.finalAudit?.humanInTheLoop !== true ||
    policy.coordinationModel?.finalAudit?.reviewBypass !== false
  ) {
    fail(
      "worktree policy must enforce root coordination, milestone evidence, handoff, and human review",
    );
  }
  if (!Array.isArray(policy.milestones) || !policy.milestones.length) {
    fail("worktree policy milestones are required");
  }
  if (
    !Array.isArray(policy.coordinationModel?.requiredHandoffEvidence) ||
    !policy.coordinationModel.requiredHandoffEvidence.length
  ) {
    fail("worktree policy required handoff evidence is missing");
  }
  for (const milestone of policy.milestones) {
    if (
      !milestone ||
      typeof milestone.id !== "string" ||
      typeof milestone.title !== "string" ||
      milestone.owner !== "root-coordinator" ||
      typeof milestone.objective !== "string" ||
      !Array.isArray(milestone.entryCriteria) ||
      !milestone.entryCriteria.length ||
      !Array.isArray(milestone.exitCriteria) ||
      !milestone.exitCriteria.length ||
      !Array.isArray(milestone.evidence) ||
      !milestone.evidence.length ||
      typeof milestone.humanReviewAt !== "string" ||
      typeof milestone.blockedEscalation !== "string" ||
      !Array.isArray(milestone.requiredEvidence) ||
      !milestone.requiredEvidence.length ||
      typeof milestone.githubMilestone !== "string"
    ) {
      fail(
        "every milestone must define objective, entry/exit criteria, evidence, owner, and escalation",
      );
    }
  }
  if (
    policy.roleBoundaries?.rootCoordinator?.userFacing !== true ||
    policy.roleBoundaries?.rootCoordinator?.ownsMerge !== true ||
    policy.roleBoundaries?.executionThread?.mayWriteRoot !== false ||
    policy.roleBoundaries?.executionThread?.mayWriteOtherWorktrees !== false ||
    policy.roleBoundaries?.executionThread?.mayChangeRemotePolicy !== false ||
    policy.roleBoundaries?.executionThread?.mayMergePullRequests !== false ||
    policy.roleBoundaries?.executionThread?.mustHandoffTo !== "root-coordinator"
  ) {
    fail(
      "worktree policy role boundaries must keep coordination and merge authority in the root coordinator",
    );
  }
  return policy;
}

function resolveGithubMilestone(policy, value, localMilestone) {
  const configured = value === undefined ? localMilestone.githubMilestone : String(value);
  const match = policy.githubTracking.milestones.find(
    (item) =>
      String(item.number) === configured ||
      item.stableId === configured ||
      item.title === configured,
  );
  if (!match) fail(`unknown GitHub milestone: ${configured}`);
  return structuredClone(match);
}

function resolveTrackerIssue(policy, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    fail("claim/plan requires --tracker-issue from the GitHub tracker");
  }
  const normalized = String(value).trim().replace(/^#/, "");
  const number = Number(normalized);
  if (!/^[1-9][0-9]*$/.test(normalized) || !Number.isSafeInteger(number)) {
    fail(`tracker issue must be a positive GitHub issue number: ${value}`);
  }
  return {
    repository: policy.githubTracking.repository,
    number,
    sourceOfTruth: policy.milestoneOps.sourceOfTruth,
  };
}

function githubMilestoneMatches(policy, value) {
  if (!value || typeof value !== "object") return false;
  return policy.githubTracking.milestones.some(
    (item) =>
      item.number === value.number &&
      item.stableId === value.stableId &&
      item.title === value.title,
  );
}

function resolveStateDir(repository, policy) {
  const configured = policy.paths.stateDir;
  if (isAbsolute(configured)) return canonicalPath(configured);
  if (
    configured === ".git" ||
    configured.startsWith(`.git${sep}`) ||
    configured.startsWith(".git/")
  ) {
    const relativeState = configured.replace(/^\.git[\\/]/, "");
    return canonicalPath(join(repository.commonDir, relativeState));
  }
  return canonicalPath(join(repository.mainRoot, configured));
}

export function getStatePaths(repository, policy) {
  const stateDir = resolveStateDir(repository, policy);
  return {
    stateDir,
    manifestPath: join(stateDir, "manifest.json"),
    lockPath: join(stateDir, "locks.json"),
    runtimeLockPath: join(stateDir, "runtime.lock"),
  };
}

function emptyManifest() {
  return { schemaVersion: HARNESS_VERSION, updatedAt: null, entries: [] };
}

function emptyLocks() {
  return { schemaVersion: HARNESS_VERSION, updatedAt: null, locks: [] };
}

function readStateFile(path, fallback, label) {
  if (!existsSync(path)) return structuredClone(fallback);
  const value = safeJsonParse(readFileSync(path, "utf8"), path);
  if (!value || typeof value !== "object" || value.schemaVersion !== HARNESS_VERSION) {
    fail(`${label} has an unsupported schema`);
  }
  return value;
}

export function readState(statePaths) {
  return {
    manifest: readStateFile(statePaths.manifestPath, emptyManifest(), "worktree manifest"),
    locks: readStateFile(statePaths.lockPath, emptyLocks(), "worktree lock file"),
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${relative(dirname(path), path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const descriptor = openSync(temporary, "r");
  try {
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function writeState(statePaths, state, now) {
  const stamp = nowIso(now);
  state.manifest.updatedAt = stamp;
  state.locks.updatedAt = stamp;
  atomicWriteJson(statePaths.manifestPath, state.manifest);
  atomicWriteJson(statePaths.lockPath, state.locks);
}

function normalizedScope(scope) {
  const values = Array.isArray(scope) ? scope : [scope];
  const paths = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().replaceAll("\\", "/"))
    .filter(Boolean);
  if (!paths.length) fail("scope must contain at least one repository-relative path or glob");
  const result = [];
  for (const value of paths) {
    if (isAbsolute(value) || value === "." || value.startsWith("../") || value.includes("/../")) {
      fail(`scope must be repository-relative: ${value}`);
    }
    const clean = normalize(value).replaceAll("\\", "/");
    if (clean === ".." || clean.startsWith("../") || clean.includes("/../")) {
      fail(`scope escapes the repository: ${value}`);
    }
    if (/(^|\/)\.env(?:\.[^/]+)?$/.test(clean)) {
      fail("scope must not contain secret-bearing environment files");
    }
    if (!result.includes(clean)) result.push(clean);
  }
  return result.sort();
}

function validateMetadata(entry, label = "worktree metadata", policy) {
  if (!policy) fail(`${label} cannot be validated without worktree policy`);
  if (!entry || typeof entry !== "object") fail(`${label} must be an object`);
  for (const key of REQUIRED_METADATA) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === "") {
      fail(`${label} is missing ${key}`);
    }
  }
  assertNoSecretKeys(entry, label);
  assertNoSecretValue(entry, label);
  if (
    typeof entry.taskId !== "string" ||
    typeof entry.threadId !== "string" ||
    typeof entry.owner !== "string"
  ) {
    fail(`${label} taskId, threadId, and owner must be strings`);
  }
  if (typeof entry.branch !== "string" || !branchMatchesPolicy(entry.branch, policy)) {
    fail(`${label} branch must use the misakago/ prefix`);
  }
  if (typeof entry.worktreePath !== "string" || !isAbsolute(entry.worktreePath)) {
    fail(`${label} worktreePath must be absolute`);
  }
  if (!SHA_RE.test(entry.baseSha)) fail(`${label} baseSha must be a full commit SHA`);
  if (
    !entry.scope ||
    !Array.isArray(entry.scope.paths) ||
    !entry.scope.paths.length ||
    typeof entry.scope.highRisk !== "boolean"
  ) {
    fail(`${label} scope.paths must be a non-empty array`);
  }
  for (const scopePath of entry.scope.paths) normalizedScope([scopePath]);
  const coordination = entry.coordination;
  if (!coordination || typeof coordination !== "object") {
    fail(`${label} is missing coordination metadata`);
  }
  if (coordination.role !== "execution-thread") {
    fail(`${label} must be owned by an execution-thread`);
  }
  const trackerIssue = coordination.trackerIssue;
  if (
    policy.milestoneOps.requiredTrackerIssue &&
    (!trackerIssue ||
      trackerIssue.repository !== policy.githubTracking.repository ||
      !Number.isInteger(trackerIssue.number) ||
      trackerIssue.number <= 0 ||
      trackerIssue.sourceOfTruth !== policy.milestoneOps.sourceOfTruth)
  ) {
    fail(`${label} is missing the required GitHub tracker issue binding`);
  }
  if (
    typeof coordination.goal !== "string" ||
    !coordination.goal.trim() ||
    (policy.milestoneOps.dueDateRequired &&
      (typeof coordination.dueDate !== "string" || parseIso(coordination.dueDate) === null))
  ) {
    fail(`${label} must include a goal and an ISO due date`);
  }
  if (
    policy.milestoneOps.requiredDependencyLinks &&
    (!Array.isArray(coordination.dependencies) ||
      coordination.dependencies.some(
        (dependency) => typeof dependency !== "string" || !dependency.trim(),
      ))
  ) {
    fail(`${label} must include explicit dependency links (use none for an independent task)`);
  }
  if (
    !Array.isArray(coordination.labels) ||
    coordination.labels.length > policy.milestoneOps.maxLabels ||
    new Set(coordination.labels).size !== coordination.labels.length ||
    coordination.labels.some(
      (labelValue) =>
        typeof labelValue !== "string" || !policy.milestoneOps.allowedLabels.includes(labelValue),
    )
  ) {
    fail(`${label} must use sparse, stable governance labels`);
  }
  if (
    typeof coordination.status !== "string" ||
    !policy.milestoneOps.allowedStatuses.includes(coordination.status)
  ) {
    fail(`${label} has an unsupported task status`);
  }
  if (
    policy.milestoneOps.statusUpdateOnBlock &&
    coordination.status === "blocked" &&
    (typeof coordination.statusUpdate !== "string" ||
      !coordination.statusUpdate.trim() ||
      policy.milestoneOps.blockedStatusEvidence.some(
        (item) => !Array.isArray(coordination.evidence) || !coordination.evidence.includes(item),
      ))
  ) {
    fail(`${label} blocked status requires a tracker update and status evidence`);
  }
  if (
    policy.milestoneOps.scopeChangeRequiresRootReview &&
    coordination.scopeChangeAuthority !== "root-coordinator-required"
  ) {
    fail(`${label} scope changes require root-coordinator review`);
  }
  if (!coordination.milestone || typeof coordination.milestone !== "object") {
    fail(`${label} is missing milestone metadata`);
  }
  const milestoneId = coordination.milestone.id;
  const milestone = policy.milestones.find((item) => item.id === milestoneId);
  if (!milestone) fail(`${label} references an unknown milestone: ${milestoneId || "missing"}`);
  if (
    coordination.milestone.owner !== "root-coordinator" ||
    coordination.milestone.title !== milestone.title ||
    coordination.milestone.objective !== milestone.objective ||
    JSON.stringify(coordination.milestone.entryCriteria) !==
      JSON.stringify(milestone.entryCriteria) ||
    JSON.stringify(coordination.milestone.exitCriteria) !==
      JSON.stringify(milestone.exitCriteria) ||
    JSON.stringify(coordination.milestone.evidence) !== JSON.stringify(milestone.evidence) ||
    JSON.stringify(coordination.milestone.requiredEvidence) !==
      JSON.stringify(milestone.requiredEvidence) ||
    coordination.milestone.humanReviewAt !== milestone.humanReviewAt ||
    coordination.milestone.blockedEscalation !== milestone.blockedEscalation
  ) {
    fail(`${label} has incomplete or tampered milestone metadata`);
  }
  if (!githubMilestoneMatches(policy, coordination.milestone.githubMilestone)) {
    fail(`${label} is missing a valid read-only GitHub milestone binding`);
  }
  if (!Array.isArray(coordination.evidence) || !coordination.evidence.length) {
    fail(`${label} is missing milestone evidence`);
  }
  const requiredEvidence = milestone.requiredEvidence || milestone.evidence;
  const missingEvidence = requiredEvidence.filter((item) => !coordination.evidence.includes(item));
  if (missingEvidence.length)
    fail(`${label} is missing exit evidence: ${missingEvidence.join(", ")}`);
  for (const evidence of coordination.evidence) {
    if (typeof evidence !== "string" || !evidence.trim())
      fail(`${label} has invalid milestone evidence`);
    if (/(secret|token|password|api[-_]?key)\s*[:=]/i.test(evidence)) {
      fail(`${label} milestone evidence looks like a secret`);
    }
  }
  if (
    coordination.handoff?.required !== true ||
    coordination.handoff?.destination !== "root-coordinator" ||
    !Array.isArray(coordination.handoff?.requiredEvidence) ||
    JSON.stringify(coordination.handoff.requiredEvidence) !==
      JSON.stringify(policy.coordinationModel.requiredHandoffEvidence || []) ||
    coordination.mergeAuthority !== "root-coordinator-only"
  ) {
    fail(
      `${label} must require handoff to the root coordinator and forbid execution-thread merges`,
    );
  }
  if (entry.expiresAt !== undefined && parseIso(entry.expiresAt) === null) {
    fail(`${label} expiresAt must be an ISO timestamp`);
  }
  return entry;
}

function assertNoSecretKeys(value, label, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) fail(`${label} contains a secret-shaped field: ${key}`);
    assertNoSecretKeys(nested, label, seen);
  }
}

function metadataForCandidate(candidate, now, ttlMinutes) {
  const stamp = nowIso(now);
  return {
    taskId: candidate.taskId,
    threadId: candidate.threadId,
    owner: candidate.owner,
    branch: candidate.branch,
    worktreePath: candidate.worktreePath,
    baseSha: candidate.baseSha,
    baseRef: candidate.baseRef || null,
    source: candidate.source,
    scope: { paths: [...candidate.scopePaths], highRisk: candidate.highRisk },
    coordination: {
      role: "execution-thread",
      trackerIssue: structuredClone(candidate.trackerIssue),
      goal: candidate.goal,
      dueDate: candidate.dueDate,
      dependencies: [...candidate.dependencies],
      status: candidate.status,
      statusUpdate: candidate.statusUpdate || null,
      labels: [...candidate.labels],
      scopeChangeAuthority: "root-coordinator-required",
      milestone: structuredClone(candidate.milestone),
      evidence: [...candidate.evidence],
      handoff: {
        required: true,
        destination: "root-coordinator",
        status: "pending",
        requiredEvidence: [...candidate.requiredHandoffEvidence],
      },
      mergeAuthority: "root-coordinator-only",
    },
    createdAt: stamp,
    expiresAt: nowIso(now + ttlMinutes * 60_000),
  };
}

function lockForEntry(entry, now) {
  return {
    lockId: `${entry.taskId}:${entry.branch}`,
    taskId: entry.taskId,
    threadId: entry.threadId,
    owner: entry.owner,
    branch: entry.branch,
    worktreePath: entry.worktreePath,
    baseSha: entry.baseSha,
    baseRef: entry.baseRef || null,
    source: entry.source,
    scope: structuredClone(entry.scope),
    coordination: structuredClone(entry.coordination),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    lockedAt: nowIso(now),
  };
}

function assertNoSecretValue(value, label) {
  const text = JSON.stringify(value);
  if (SECRET_KEY_RE.test(text)) {
    // Field names such as baseRef can contain ordinary words; only reject
    // values that look like credential assignments, never print the value.
    if (/(secret|token|password|api[-_]?key)\s*[:=]/i.test(text)) {
      fail(`${label} contains a secret-shaped value`);
    }
  }
}

function branchMatchesPolicy(branch, policy) {
  if (!branch.startsWith(policy.branch.prefix) || branch.length > policy.branch.maxLength)
    return false;
  try {
    return new RegExp(policy.branch.pattern).test(branch);
  } catch {
    fail("worktree policy branch.pattern is not a valid regular expression");
  }
}

function globSegments(value) {
  return value.split("/").filter((segment) => segment.length > 0);
}

function segmentMayOverlap(left, right) {
  if (left === right) return true;
  if (left === "**" || right === "**") return true;
  const hasGlob = (value) => /[*?[]/.test(value);
  if (!hasGlob(left) && !hasGlob(right)) return false;
  if (hasGlob(left) && !hasGlob(right))
    return new RegExp(`^${globSegmentToRegex(left)}$`).test(right);
  if (!hasGlob(left) && hasGlob(right))
    return new RegExp(`^${globSegmentToRegex(right)}$`).test(left);
  return true;
}

function globSegmentToRegex(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "*") result += ".*";
    else if (char === "?") result += ".";
    else result += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return result;
}

function patternsMayOverlap(left, right) {
  const a = globSegments(left);
  const b = globSegments(right);
  const memo = new Map();
  function walk(i, j) {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (i === a.length && j === b.length) result = true;
    else if (i === a.length) result = b.slice(j).every((segment) => segment === "**");
    else if (j === b.length) result = a.slice(i).every((segment) => segment === "**");
    else if (a[i] === "**") result = walk(i + 1, j) || walk(i, j + 1);
    else if (b[j] === "**") result = walk(i, j + 1) || walk(i + 1, j);
    else result = segmentMayOverlap(a[i], b[j]) && walk(i + 1, j + 1);
    memo.set(key, result);
    return result;
  }
  return walk(0, 0);
}

function scopeHasHighRisk(scopePaths, policy) {
  return scopePaths.some((scopePath) =>
    policy.scope.highRiskPaths.some((highRiskPath) => patternsMayOverlap(scopePath, highRiskPath)),
  );
}

function scopeConflicts(left, right, policy) {
  const sameFiles = [];
  for (const leftPath of left.scope.paths) {
    for (const rightPath of right.scope.paths) {
      if (patternsMayOverlap(leftPath, rightPath)) sameFiles.push(`${leftPath} ↔ ${rightPath}`);
    }
  }
  if (sameFiles.length) return { kind: "same-file", paths: sameFiles };
  if (
    policy.scope.rejectAnyHighRiskOverlap &&
    left.scope.highRisk === true &&
    right.scope.highRisk === true
  ) {
    return { kind: "high-risk", paths: [] };
  }
  return null;
}

function resolveCommit(root, ref) {
  if (!ref) fail("base ref is required");
  const commit = runGit(["rev-parse", "--verify", `${ref}^{commit}`], root, { allowFailure: true });
  if (!commit || !SHA_RE.test(commit)) fail(`base ref cannot be resolved to a commit: ${ref}`);
  return commit;
}

function resolvePullRequestRef(root, value) {
  const candidates = /^\d+$/.test(value)
    ? [`refs/remotes/origin/pr/${value}/head`, `origin/pr/${value}/head`, `refs/pull/${value}/head`]
    : [value];
  for (const candidate of candidates) {
    if (runGit(["rev-parse", "--verify", `${candidate}^{commit}`], root, { allowFailure: true })) {
      return candidate;
    }
  }
  fail(`pull request ref cannot be resolved locally: ${value}`);
}

function resolveBase(repository, policy, options) {
  if (options.pr !== undefined) {
    if (policy.base.allowPullRequestRef !== true) fail("pull request bases are disabled by policy");
    const baseRef = resolvePullRequestRef(repository.currentRoot, options.pr);
    return {
      baseRef,
      baseSha: resolveCommit(repository.currentRoot, baseRef),
      source: { type: "pr", ref: baseRef },
    };
  }
  if (options.base !== undefined) {
    const baseRef = options.baseRef || (SHA_RE.test(options.base) ? null : options.base);
    return {
      baseRef,
      baseSha: resolveCommit(repository.currentRoot, options.base),
      source: { type: "base", ref: baseRef || options.base },
    };
  }
  const baseRef = policy.base.defaultRef;
  return {
    baseRef,
    baseSha: resolveCommit(repository.currentRoot, baseRef),
    source: { type: "default", ref: baseRef },
  };
}

function defaultWorktreePath(repository, policy, branch) {
  const worktreeRoot = canonicalPath(resolve(repository.mainRoot, policy.paths.worktreeRoot));
  const branchSlug = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return join(worktreeRoot, branchSlug);
}

function inspectRoot(repository, policy) {
  const status = runGit(["status", "--porcelain", "--untracked-files=all"], repository.mainRoot);
  if (policy.root.mustRemainClean && status) {
    fail(`root checkout is not clean/read-only: ${repository.mainRoot}`, 1);
  }
  return {
    path: repository.mainRoot,
    clean: !status,
    statusEntries: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

function actualWorktreeFor(repository, entry) {
  const path = canonicalPath(entry.worktreePath);
  return repository.worktrees.find((worktree) => canonicalPath(worktree.path) === path) || null;
}

function gitStateForEntry(repository, entry) {
  if (!existsSync(entry.worktreePath))
    return { exists: false, available: false, dirty: false, unpushed: false, status: "missing" };
  const status = runGit(["status", "--porcelain", "--untracked-files=all"], entry.worktreePath, {
    allowFailure: true,
  });
  if (status === null)
    return { exists: true, available: false, dirty: false, unpushed: false, status: "unknown" };
  const head = runGit(["rev-parse", "HEAD"], entry.worktreePath, { allowFailure: true });
  if (!head)
    return {
      exists: true,
      available: false,
      dirty: false,
      unpushed: false,
      status: status || "unknown",
    };
  const upstream = runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    entry.worktreePath,
    {
      allowFailure: true,
    },
  );
  let ahead = 0;
  if (upstream) {
    const counts = runGit(
      ["rev-list", "--left-right", "--count", `${upstream}...HEAD`],
      entry.worktreePath,
      {
        allowFailure: true,
      },
    );
    if (counts) ahead = Number(counts.split(/\s+/)[1] || 0);
    else return { exists: true, available: false, dirty: Boolean(status), unpushed: false, status };
  } else {
    const count = runGit(["rev-list", "--count", `${entry.baseSha}..HEAD`], entry.worktreePath, {
      allowFailure: true,
    });
    if (count === null)
      return { exists: true, available: false, dirty: Boolean(status), unpushed: false, status };
    ahead = Number(count);
  }
  return {
    exists: true,
    available: true,
    dirty: Boolean(status),
    unpushed: ahead > 0,
    ahead,
    head,
    upstream,
    status: status || "clean",
  };
}

function baseIssues(repository, policy, entry) {
  const issues = [];
  if (entry.baseRef) {
    const current = runGit(
      ["rev-parse", "--verify", `${entry.baseRef}^{commit}`],
      repository.currentRoot,
      {
        allowFailure: true,
      },
    );
    if (!current) issues.push(`base ref is unavailable: ${entry.baseRef}`);
    else if (current !== entry.baseSha)
      issues.push(`stale base: ${entry.baseRef} moved from ${entry.baseSha} to ${current}`);
  }
  if (entry.source?.type === "default" && policy.base.requireFreshDefault) {
    const fresh = runGit(
      ["rev-parse", "--verify", `${policy.base.defaultRef}^{commit}`],
      repository.currentRoot,
      {
        allowFailure: true,
      },
    );
    if (fresh && fresh !== entry.baseSha) {
      issues.push(`stale default base: expected ${fresh}, recorded ${entry.baseSha}`);
    }
  }
  if (policy.base.requireExplicitBaseAncestorOfDefault && entry.source?.type !== "default") {
    const defaultSha = runGit(
      ["rev-parse", "--verify", `${policy.base.defaultRef}^{commit}`],
      repository.currentRoot,
      {
        allowFailure: true,
      },
    );
    const ancestorCheck = defaultSha
      ? runGit(["merge-base", "--is-ancestor", entry.baseSha, defaultSha], repository.currentRoot, {
          allowFailure: true,
        })
      : null;
    if (defaultSha && ancestorCheck === null) {
      issues.push(`base is not an ancestor of ${policy.base.defaultRef}`);
    }
  }
  return issues;
}

function validateStateEntries(repository, policy, state) {
  const issues = [];
  const entries = state.manifest.entries;
  const locks = state.locks.locks;
  if (!Array.isArray(entries)) issues.push("manifest.entries must be an array");
  if (!Array.isArray(locks)) issues.push("locks.locks must be an array");
  if (issues.length) return issues;
  const branchSet = new Set();
  const pathSet = new Set();
  for (const entry of entries) {
    try {
      validateMetadata(entry, "manifest entry", policy);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (branchSet.has(entry.branch)) issues.push(`duplicate branch in manifest: ${entry.branch}`);
    branchSet.add(entry.branch);
    const path = canonicalPath(entry.worktreePath);
    if (pathSet.has(path))
      issues.push(`duplicate worktree path in manifest: ${entry.worktreePath}`);
    pathSet.add(path);
    if (path === canonicalPath(repository.mainRoot))
      issues.push("manifest points at the root checkout; refusing writable root");
    else if (pathIsInside(canonicalPath(repository.mainRoot), path))
      issues.push(`managed worktree path is inside the root checkout: ${entry.worktreePath}`);
    if (!branchMatchesPolicy(entry.branch, policy))
      issues.push(`branch violates policy: ${entry.branch}`);
    const actual = actualWorktreeFor(repository, entry);
    if (!actual) issues.push(`managed worktree is not registered with git: ${entry.worktreePath}`);
    else if (actual.branch !== entry.branch)
      issues.push(`worktree branch mismatch at ${entry.worktreePath}`);
    issues.push(...baseIssues(repository, policy, entry));
    const state = gitStateForEntry(repository, entry);
    if (!state.exists) issues.push(`managed worktree is missing: ${entry.worktreePath}`);
    else if (!state.available)
      issues.push(`managed worktree state cannot be verified: ${entry.branch}`);
    if (state.dirty) issues.push(`dirty managed worktree retained: ${entry.branch}`);
    if (state.unpushed) issues.push(`unpushed commits retained: ${entry.branch} (${state.ahead})`);
  }
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const conflict = scopeConflicts(entries[left], entries[right], policy);
      if (conflict) {
        issues.push(
          `${conflict.kind} scope overlap: ${entries[left].branch} ↔ ${entries[right].branch}${
            conflict.paths.length ? ` (${conflict.paths.join(", ")})` : ""
          }`,
        );
      }
    }
  }
  const lockById = new Map();
  for (const lock of locks) {
    try {
      validateMetadata(lock, "lock entry", policy);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!lock.lockId) issues.push("lock entry is missing lockId");
    if (lockById.has(lock.lockId)) issues.push(`duplicate lock: ${lock.lockId}`);
    lockById.set(lock.lockId, lock);
    if (!entries.some((entry) => entry.taskId === lock.taskId && entry.branch === lock.branch)) {
      issues.push(`lock has no manifest entry: ${lock.lockId}`);
    }
  }
  for (const entry of entries) {
    const lockId = `${entry.taskId}:${entry.branch}`;
    if (!lockById.has(lockId)) issues.push(`manifest entry has no lock: ${lockId}`);
  }
  return issues;
}

function candidateFromOptions(repository, policy, options, now) {
  const taskId = options.taskId;
  const threadId = options.threadId;
  const owner = options.owner;
  const branch = options.branch;
  if (!taskId || !threadId || !owner || !branch) {
    fail("claim/plan requires --task-id, --thread-id, --owner, and --branch");
  }
  if (!options.milestone)
    fail("claim/plan requires --milestone metadata owned by the root coordinator");
  const milestone = policy.milestones.find((item) => item.id === options.milestone);
  const evidence = options.evidence
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!evidence.length) fail("claim/plan requires --evidence for the current milestone");
  if (options.handoffTo && options.handoffTo !== "root-coordinator") {
    fail("execution-thread handoff must target the root-coordinator");
  }
  if (!milestone) fail(`unknown coordination milestone: ${options.milestone}`);
  const trackerIssue = resolveTrackerIssue(policy, options.trackerIssue);
  const goal = typeof options.goal === "string" ? options.goal.trim() : "";
  if (!goal) fail("claim/plan requires --goal for the task objective");
  const dueDate = options.dueDate;
  if (policy.milestoneOps.dueDateRequired && (!dueDate || parseIso(dueDate) === null)) {
    fail("claim/plan requires --due-date as an ISO date or timestamp");
  }
  if (policy.milestoneOps.requiredDependencyLinks && !options.dependsOnProvided) {
    fail("claim/plan requires explicit --depends-on links; use --depends-on none when independent");
  }
  const dependencies = options.dependsOn
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter((value) => value && value !== "none");
  if (dependencies.some((dependency) => dependency === taskId)) {
    fail("a task cannot depend on itself");
  }
  const status = options.status || "ready";
  if (!policy.milestoneOps.allowedStatuses.includes(status)) {
    fail(`unsupported task status: ${status}`);
  }
  const statusUpdate = options.statusUpdate?.trim() || null;
  if (
    policy.milestoneOps.statusUpdateOnBlock &&
    status === "blocked" &&
    (!statusUpdate ||
      policy.milestoneOps.blockedStatusEvidence.some((item) => !evidence.includes(item)))
  ) {
    fail("blocked tasks require --status-update and blocked status evidence");
  }
  const labels = options.label
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    labels.length > policy.milestoneOps.maxLabels ||
    new Set(labels).size !== labels.length ||
    labels.some((label) => !policy.milestoneOps.allowedLabels.includes(label))
  ) {
    fail("task labels must be sparse and use the stable policy label set");
  }
  const requiredMilestoneEvidence = milestone.requiredEvidence || milestone.evidence;
  const missingMilestoneEvidence = requiredMilestoneEvidence.filter(
    (item) => !evidence.includes(item),
  );
  if (missingMilestoneEvidence.length) {
    fail(
      `milestone ${milestone.id} is missing exit evidence: ${missingMilestoneEvidence.join(", ")}`,
    );
  }
  if (!branchMatchesPolicy(branch, policy)) fail(`branch violates policy: ${branch}`);
  const scopePaths = normalizedScope(options.scope);
  const githubMilestone = resolveGithubMilestone(policy, options.githubMilestone, milestone);
  const base = resolveBase(repository, policy, options);
  const worktreePath = canonicalPath(
    options.worktree
      ? resolve(repository.currentRoot, options.worktree)
      : defaultWorktreePath(repository, policy, branch),
  );
  if (worktreePath === canonicalPath(repository.mainRoot))
    fail("root checkout is read-only; choose an isolated worktree path");
  if (pathIsInside(repository.mainRoot, worktreePath))
    fail("managed worktrees must live outside the root checkout");
  return {
    taskId,
    threadId,
    owner,
    branch,
    worktreePath,
    baseSha: base.baseSha,
    baseRef: base.baseRef,
    source: base.source,
    scopePaths,
    highRisk: scopeHasHighRisk(scopePaths, policy),
    trackerIssue,
    goal,
    dueDate,
    dependencies,
    status,
    statusUpdate,
    labels,
    milestone: { ...structuredClone(milestone), githubMilestone },
    evidence,
    requiredHandoffEvidence: [...policy.coordinationModel.requiredHandoffEvidence],
    now,
  };
}

function existingConflict(candidate, repository, policy, state) {
  const conflicts = [];
  for (const entry of state.manifest.entries) {
    if (entry.taskId === candidate.taskId) conflicts.push(`duplicate task id: ${candidate.taskId}`);
    if (entry.branch === candidate.branch) conflicts.push(`duplicate branch: ${candidate.branch}`);
    if (canonicalPath(entry.worktreePath) === candidate.worktreePath)
      conflicts.push(`duplicate worktree path: ${candidate.worktreePath}`);
    const candidateEntry = {
      scope: { paths: candidate.scopePaths, highRisk: candidate.highRisk },
    };
    const conflict = scopeConflicts(candidateEntry, entry, policy);
    if (conflict) {
      conflicts.push(
        `${conflict.kind} scope overlap with ${entry.branch}${conflict.paths.length ? ` (${conflict.paths.join(", ")})` : ""}`,
      );
    }
  }
  const actual = repository.worktrees.find(
    (worktree) => canonicalPath(worktree.path) === candidate.worktreePath,
  );
  if (actual)
    conflicts.push(`worktree path is already registered with git: ${candidate.worktreePath}`);
  if (
    runGit(["show-ref", "--verify", `refs/heads/${candidate.branch}`], repository.currentRoot, {
      allowFailure: true,
    })
  ) {
    conflicts.push(`branch already exists locally: ${candidate.branch}`);
  }
  if (
    runGit(
      ["show-ref", "--verify", `refs/remotes/origin/${candidate.branch}`],
      repository.currentRoot,
      { allowFailure: true },
    )
  ) {
    conflicts.push(`branch already exists on origin: ${candidate.branch}`);
  }
  if (existsSync(candidate.worktreePath))
    conflicts.push(`worktree path already exists: ${candidate.worktreePath}`);
  return [...new Set(conflicts)];
}

function readWorktreeInclude(repository, policy) {
  const includePath = resolve(
    repository.currentRoot,
    policy.paths.includeFile || DEFAULT_INCLUDE_FILE,
  );
  if (!existsSync(includePath)) return [];
  const lines = readFileSync(includePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const paths = [];
  for (const value of lines) {
    const normalized = value.replaceAll("\\", "/");
    if (
      isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../") ||
      !/(^|\/)\.env(?:\.[^/]+)?$/.test(normalized)
    ) {
      fail(`.worktreeinclude may contain only repository-relative .env files: ${value}`);
    }
    const source = resolve(repository.currentRoot, normalized);
    if (
      !pathIsInside(repository.currentRoot, source) ||
      !existsSync(source) ||
      !lstatSync(source).isFile()
    ) {
      fail(`.worktreeinclude file is missing: ${value}`);
    }
    const ignored = runGit(["check-ignore", "--quiet", "--", normalized], repository.currentRoot, {
      allowFailure: true,
    });
    if (ignored === null) fail(`.worktreeinclude file is not gitignored: ${value}`);
    paths.push({ relativePath: normalized, source });
  }
  return paths;
}

function copyIncludedEnvFiles(repository, policy, worktreePath) {
  const includes = readWorktreeInclude(repository, policy);
  for (const include of includes) {
    const destination = resolve(worktreePath, include.relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(include.source, destination);
    try {
      const descriptor = openSync(destination, "r");
      try {
        fchmodSync(descriptor, statSync(include.source).mode & 0o777);
      } finally {
        closeSync(descriptor);
      }
    } catch {
      // File mode is a convenience; the copy itself is still valid.
    }
  }
  return includes.length;
}

function runtimeLockMetadata(repository, policy, options, now) {
  const branch = options.branch || "maintenance";
  const baseSha =
    runGit(["rev-parse", "HEAD"], repository.currentRoot, { allowFailure: true }) || "0".repeat(40);
  const milestone = policy.milestones.find((item) => item.id === "local-simulation");
  return {
    taskId: options.taskId || `harness-${process.pid}`,
    threadId: options.threadId || "worktree-harness",
    owner: options.owner || "worktree-harness",
    branch: branch.startsWith("misakago/") ? branch : `misakago/${branch}`,
    worktreePath: repository.mainRoot,
    baseSha,
    scope: { paths: [".git/worktree-harness-runtime"], highRisk: false },
    coordination: {
      role: "execution-thread",
      milestone: {
        ...structuredClone(milestone),
        githubMilestone: resolveGithubMilestone(policy, undefined, milestone),
      },
      evidence: [...milestone.requiredEvidence],
      handoff: {
        required: true,
        destination: "root-coordinator",
        status: "pending",
        requiredEvidence: [...policy.coordinationModel.requiredHandoffEvidence],
      },
      mergeAuthority: "root-coordinator-only",
    },
    acquiredAt: nowIso(now),
  };
}

function withRuntimeLock(repository, policy, statePaths, options, callback, now = Date.now()) {
  const runtimePath = statePaths.runtimeLockPath;
  mkdirSync(dirname(runtimePath), { recursive: true, mode: 0o700 });
  if (existsSync(runtimePath)) {
    let previous = null;
    const lockFile = join(runtimePath, "lock.json");
    if (existsSync(lockFile)) previous = safeJsonParse(readFileSync(lockFile, "utf8"), lockFile);
    const expires = parseIso(previous?.expiresAt);
    if (!expires || expires > now) {
      fail(`worktree harness is locked until ${previous?.expiresAt || "an unknown time"}`);
    }
    rmSync(runtimePath, { recursive: true, force: true });
  }
  try {
    mkdirSync(runtimePath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("worktree harness lock was acquired by another process");
    throw error;
  }
  const metadata = runtimeLockMetadata(repository, policy, options, now);
  metadata.expiresAt = nowIso(now + policy.lock.runtimeTtlSeconds * 1000);
  atomicWriteJson(join(runtimePath, "lock.json"), metadata);
  try {
    return callback();
  } finally {
    rmSync(runtimePath, { recursive: true, force: true });
  }
}

function checkCommand(repository, policy, statePaths) {
  const root = inspectRoot(repository, policy);
  const state = readState(statePaths);
  const issues = validateStateEntries(repository, policy, state);
  const runtimeLock = existsSync(statePaths.runtimeLockPath)
    ? safeJsonParse(
        readFileSync(join(statePaths.runtimeLockPath, "lock.json"), "utf8"),
        statePaths.runtimeLockPath,
      )
    : null;
  if (
    runtimeLock &&
    (!runtimeLock.expiresAt || (parseIso(runtimeLock.expiresAt) || 0) <= Date.now())
  ) {
    issues.push("runtime lock is expired; run cleanup --apply to reclaim it");
  } else if (runtimeLock) {
    issues.push(`runtime lock is active until ${runtimeLock.expiresAt}`);
  }
  const result = {
    command: "check",
    ok: issues.length === 0,
    root,
    manifestPath: statePaths.manifestPath,
    lockPath: statePaths.lockPath,
    entries: state.manifest.entries.length,
    milestones: state.manifest.entries.map((entry) => entry.coordination?.milestone || null),
    issues,
  };
  if (issues.length) {
    const error = new HarnessError(
      `worktree governance check failed:\n- ${issues.join("\n- ")}`,
      1,
    );
    error.result = result;
    throw error;
  }
  return result;
}

function planCommand(repository, policy, statePaths, options, now) {
  const root = inspectRoot(repository, policy);
  const state = readState(statePaths);
  const candidate = candidateFromOptions(repository, policy, options, now);
  const conflicts = existingConflict(candidate, repository, policy, state);
  const entry = metadataForCandidate(candidate, now, policy.lock.ttlMinutes);
  assertNoSecretValue(entry, "worktree metadata");
  const result = {
    command: "plan",
    applyRequired: true,
    wouldWrite: [statePaths.manifestPath, statePaths.lockPath, candidate.worktreePath],
    root,
    candidate: entry,
    milestone: entry.coordination.milestone,
    conflicts,
    ok: conflicts.length === 0,
  };
  if (conflicts.length) {
    const error = new HarnessError(
      `worktree plan found conflicts:\n- ${conflicts.join("\n- ")}`,
      1,
    );
    error.result = result;
    throw error;
  }
  return result;
}

function claimCommand(repository, policy, statePaths, options, now) {
  const plan = planCommand(repository, policy, statePaths, options, now);
  if (!plan.ok) fail(`worktree claim rejected:\n- ${plan.conflicts.join("\n- ")}`, 1);
  if (!options.apply)
    return {
      ...plan,
      command: "claim",
      applied: false,
      message: "plan only; pass --apply to claim",
    };
  return withRuntimeLock(
    repository,
    policy,
    statePaths,
    options,
    () => {
      inspectRoot(repository, policy);
      const state = readState(statePaths);
      const candidate = plan.candidate;
      const baseProblems = baseIssues(repository, policy, candidate);
      if (baseProblems.length) fail(`worktree claim rejected:\n- ${baseProblems.join("\n- ")}`, 1);
      validateMetadata(candidate, "worktree claim metadata", policy);
      const conflicts = existingConflict(
        {
          ...candidate,
          scopePaths: candidate.scope.paths,
          highRisk: candidate.scope.highRisk,
        },
        repository,
        policy,
        state,
      );
      if (conflicts.length) fail(`worktree claim lost a race:\n- ${conflicts.join("\n- ")}`, 1);
      const parent = dirname(candidate.worktreePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      try {
        runGit(
          ["worktree", "add", "-b", candidate.branch, candidate.worktreePath, candidate.baseSha],
          repository.currentRoot,
        );
        const includedFiles = copyIncludedEnvFiles(repository, policy, candidate.worktreePath);
        const entry = candidate;
        state.manifest.entries.push(entry);
        state.locks.locks.push(lockForEntry(entry, now));
        writeState(statePaths, state, now);
        return {
          command: "claim",
          applied: true,
          root: plan.root,
          entry,
          includedFiles,
          manifestPath: statePaths.manifestPath,
          lockPath: statePaths.lockPath,
        };
      } catch (error) {
        if (existsSync(candidate.worktreePath)) {
          runGit(
            ["worktree", "remove", "--force", candidate.worktreePath],
            repository.currentRoot,
            { allowFailure: true },
          );
        }
        runGit(["branch", "-D", candidate.branch], repository.currentRoot, { allowFailure: true });
        throw error;
      }
    },
    now,
  );
}

function findEntry(state, options, policy) {
  const matches = state.manifest.entries.filter(
    (entry) =>
      (options.taskId ? entry.taskId === options.taskId : true) &&
      (options.threadId ? entry.threadId === options.threadId : true) &&
      (options.branch ? entry.branch === options.branch : true),
  );
  if (matches.length !== 1) {
    if (!matches.length)
      fail("managed worktree was not found; identify it with --task-id, --thread-id, or --branch");
    fail("worktree selector matches more than one entry; provide --task-id and --branch");
  }
  validateMetadata(matches[0], "managed worktree entry", policy);
  return matches[0];
}

function reclaimEntry(repository, policy, statePaths, state, entry, now, reason) {
  const managedPath = canonicalPath(entry.worktreePath);
  if (pathIsInside(canonicalPath(repository.mainRoot), managedPath)) {
    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      retained: true,
      reason: "root-path",
      message: `retained ${entry.branch}; refusing to operate inside the root checkout`,
    };
  }
  const actual = actualWorktreeFor(repository, entry);
  if (actual && actual.branch !== entry.branch) {
    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      retained: true,
      reason: "branch-mismatch",
      message: `retained ${entry.branch}; git registered ${actual.branch} at this path`,
    };
  }
  const gitState = gitStateForEntry(repository, entry);
  if (!gitState.exists || !gitState.available || gitState.dirty || gitState.unpushed) {
    const reasonCode = !gitState.exists
      ? "missing"
      : !gitState.available
        ? "unavailable"
        : gitState.dirty
          ? "dirty"
          : "unpushed";
    return {
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      retained: true,
      reason: reasonCode,
      message:
        reasonCode === "missing" || reasonCode === "unavailable"
          ? `retained ${entry.branch}; cannot verify a clean worktree before ${reason}`
          : `retained ${entry.branch}; clean the worktree and push commits before ${reason}`,
    };
  }
  if (existsSync(entry.worktreePath)) {
    const removed = runGit(
      ["worktree", "remove", "--force", entry.worktreePath],
      repository.currentRoot,
      { allowFailure: true },
    );
    if (removed === null && existsSync(entry.worktreePath)) {
      return {
        branch: entry.branch,
        worktreePath: entry.worktreePath,
        retained: true,
        reason: "worktree-remove-failed",
        message: `retained ${entry.branch}; git refused to remove the worktree`,
      };
    }
  }
  state.manifest.entries = state.manifest.entries.filter((item) => item !== entry);
  state.locks.locks = state.locks.locks.filter(
    (item) => item.taskId !== entry.taskId || item.branch !== entry.branch,
  );
  return {
    branch: entry.branch,
    worktreePath: entry.worktreePath,
    retained: false,
    reason: "reclaimed",
  };
}

function releaseCommand(repository, policy, statePaths, options, now) {
  inspectRoot(repository, policy);
  const state = readState(statePaths);
  const entry = findEntry(state, options, policy);
  const preview = reclaimEntryPreview(repository, entry);
  if (!options.apply)
    return {
      command: "release",
      applied: false,
      ...preview,
      message: "plan only; pass --apply to release",
    };
  return withRuntimeLock(
    repository,
    policy,
    statePaths,
    options,
    () => {
      const latest = readState(statePaths);
      const current = findEntry(latest, options, policy);
      const result = reclaimEntry(repository, policy, statePaths, latest, current, now, "release");
      if (!result.retained) writeState(statePaths, latest, now);
      return { command: "release", applied: true, ...result };
    },
    now,
  );
}

function reclaimEntryPreview(repository, entry) {
  const gitState = gitStateForEntry(repository, entry);
  const retained = !gitState.exists || !gitState.available || gitState.dirty || gitState.unpushed;
  return {
    branch: entry.branch,
    worktreePath: entry.worktreePath,
    retained,
    reason: !gitState.exists
      ? "missing"
      : !gitState.available
        ? "unavailable"
        : gitState.dirty
          ? "dirty"
          : gitState.unpushed
            ? "unpushed"
            : "reclaimable",
    dirty: gitState.dirty,
    unpushed: gitState.unpushed,
    available: gitState.available,
    exists: gitState.exists,
    ahead: gitState.ahead || 0,
  };
}

function cleanupCommand(repository, policy, statePaths, options, now) {
  inspectRoot(repository, policy);
  const state = readState(statePaths);
  const candidates = state.manifest.entries.filter((entry) => {
    if (options.taskId && entry.taskId !== options.taskId) return false;
    if (options.branch && entry.branch !== options.branch) return false;
    if (!policy.cleanup.expiredOnly && options.all) return true;
    return (parseIso(entry.expiresAt) || 0) <= now;
  });
  for (const entry of candidates) validateMetadata(entry, "cleanup manifest entry", policy);
  const preview = candidates.map((entry) => reclaimEntryPreview(repository, entry));
  if (!options.apply) {
    return {
      command: "cleanup",
      applied: false,
      candidates: preview,
      message: "plan only; pass --apply to reclaim expired clean worktrees",
    };
  }
  return withRuntimeLock(
    repository,
    policy,
    statePaths,
    options,
    () => {
      inspectRoot(repository, policy);
      const latest = readState(statePaths);
      const currentCandidates = latest.manifest.entries.filter((entry) => {
        if (options.taskId && entry.taskId !== options.taskId) return false;
        if (options.branch && entry.branch !== options.branch) return false;
        if (!policy.cleanup.expiredOnly && options.all) return true;
        return (parseIso(entry.expiresAt) || 0) <= now;
      });
      for (const entry of currentCandidates)
        validateMetadata(entry, "cleanup manifest entry", policy);
      const retained = [];
      const reclaimed = [];
      for (const entry of currentCandidates) {
        const result = reclaimEntry(repository, policy, statePaths, latest, entry, now, "cleanup");
        (result.retained ? retained : reclaimed).push(result);
      }
      if (reclaimed.length) writeState(statePaths, latest, now);
      return { command: "cleanup", applied: true, reclaimed, retained };
    },
    now,
  );
}

function formatResult(result) {
  const lines = [
    `[worktree-harness] ${result.command} ${result.ok === false ? "failed" : "complete"}`,
  ];
  if (result.message) lines.push(result.message);
  if (result.root)
    lines.push(`root: ${result.root.path} (${result.root.clean ? "clean/read-only" : "dirty"})`);
  if (result.candidate) {
    lines.push(`task: ${result.candidate.taskId}`);
    lines.push(`branch: ${result.candidate.branch}`);
    lines.push(`worktree: ${result.candidate.worktreePath}`);
    lines.push(
      `base: ${result.candidate.baseSha}${result.candidate.baseRef ? ` (${result.candidate.baseRef})` : ""}`,
    );
    lines.push(`scope: ${result.candidate.scope.paths.join(", ")}`);
    lines.push(
      `milestone: ${result.candidate.coordination.milestone.id} (${result.candidate.coordination.milestone.title})`,
    );
    if (result.conflicts?.length) lines.push(`conflicts: ${result.conflicts.join("; ")}`);
  }
  if (result.entry) lines.push(`claimed: ${result.entry.branch}`);
  if (result.includedFiles) lines.push(`copied gitignored .env files: ${result.includedFiles}`);
  if (result.issues?.length) lines.push(...result.issues.map((issue) => `- ${issue}`));
  if (Array.isArray(result.milestones)) {
    for (const milestone of result.milestones) {
      if (milestone)
        lines.push(`milestone: ${milestone.id} (${milestone.title}) owner=${milestone.owner}`);
    }
  }
  for (const key of ["reclaimed", "retained", "candidates"]) {
    if (Array.isArray(result[key])) {
      for (const item of result[key]) {
        lines.push(
          `${key}: ${item.branch || item.worktreePath} ${item.retained ? `retained (${item.reason})` : "reclaimed"}`,
        );
        if (item.message) lines.push(`  ${item.message}`);
      }
    }
  }
  return lines.join("\n");
}

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "check";
  const options = {
    command,
    apply: false,
    json: false,
    scope: [],
    evidence: [],
    dependsOn: [],
    label: [],
    dependsOnProvided: false,
  };
  const expectsValue = new Set([
    "root",
    "policy",
    "state-dir",
    "task-id",
    "thread-id",
    "owner",
    "branch",
    "worktree",
    "base",
    "base-ref",
    "pr",
    "milestone",
    "github-milestone",
    "tracker-issue",
    "goal",
    "due-date",
    "status",
    "status-update",
    "depends-on",
    "label",
    "evidence",
    "handoff-to",
    "scope",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (raw === "--apply") options.apply = true;
    else if (raw === "--json") options.json = true;
    else if (raw === "--all") options.all = true;
    else if (raw.startsWith("--")) {
      const [flag, inline] = raw.slice(2).split(/=(.*)/s, 2);
      if (!expectsValue.has(flag)) fail(`unknown option: --${flag}`);
      const value = inline ?? args[++index];
      if (!value) fail(`option requires a value: --${flag}`);
      const key = flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (key === "scope") options.scope.push(value);
      else if (key === "evidence") options.evidence.push(value);
      else if (key === "dependsOn") {
        options.dependsOn.push(value);
        options.dependsOnProvided = true;
      } else if (key === "label") options.label.push(value);
      else options[key] = value;
    } else fail(`unexpected argument: ${raw}`);
  }
  return options;
}

export function runHarness(argv = process.argv.slice(2), cwd = process.cwd(), clock = Date.now()) {
  const options = parseCliArgs(argv);
  if (["merge", "close-milestone", "complete-milestone"].includes(options.command)) {
    fail("execution-thread cannot merge or close milestones; handoff to the root-coordinator");
  }
  if (!["plan", "check", "claim", "release", "cleanup"].includes(options.command)) {
    fail(`unknown command: ${options.command}; expected plan, check, claim, release, or cleanup`);
  }
  const repository = discoverRepository(options.root || cwd);
  const policyPath = canonicalPath(
    resolve(options.root || cwd, options.policy || DEFAULT_POLICY_PATH),
  );
  const policy = loadPolicy(policyPath);
  const statePaths = getStatePaths(
    repository,
    options.stateDir
      ? { ...policy, paths: { ...policy.paths, stateDir: options.stateDir } }
      : policy,
  );
  let result;
  if (options.command === "check") result = checkCommand(repository, policy, statePaths);
  else if (options.command === "plan")
    result = planCommand(repository, policy, statePaths, options, clock);
  else if (options.command === "claim")
    result = claimCommand(repository, policy, statePaths, options, clock);
  else if (options.command === "release")
    result = releaseCommand(repository, policy, statePaths, options, clock);
  else result = cleanupCommand(repository, policy, statePaths, options, clock);
  assertNoSecretValue(result, "harness result");
  return result;
}

function main() {
  try {
    const result = runHarness();
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatResult(result)}\n`,
    );
    return 0;
  } catch (error) {
    const result = error?.result;
    if (process.argv.includes("--json") && result)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[worktree-harness] ${message}\n`);
    return error?.exitCode || 2;
  }
}

if (canonicalPath(process.argv[1] || "") === canonicalPath(SCRIPT_PATH)) process.exitCode = main();
