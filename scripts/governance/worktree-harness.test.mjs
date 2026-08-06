import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const harnessPath = resolve(testDirectory, "worktree-harness.mjs");
const policyPath = resolve(testDirectory, "../../.governance/worktree-policy.json");
const policyFixture = JSON.parse(readFileSync(policyPath, "utf8"));
const fixtures = new Set();

function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "piwork-worktree-harness-"));
  const remote = mkdtempSync(join(tmpdir(), "piwork-worktree-harness-remote-"));
  const stateDir = join(root, ".state");
  const worktreeRoot = mkdtempSync(join(tmpdir(), "piwork-worktree-harness-tasks-"));
  fixtures.add(root);
  fixtures.add(remote);
  fixtures.add(worktreeRoot);
  git(remote, ["init", "--bare"]);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Worktree Harness Fixture"]);
  git(root, ["config", "user.email", "worktree-harness@example.test"]);
  mkdirSync(join(root, ".governance"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "web/server"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".env\n.worktreeinclude\n.state/\n");
  writeFileSync(join(root, ".governance/worktree-policy.json"), readFileSync(policyPath));
  writeFileSync(join(root, "README.md"), "fixture\n");
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src/b.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "web/server/auth.ts"), "export const auth = true;\n");
  writeFileSync(join(root, "web/server/other.ts"), "export const other = true;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture baseline"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-u", "origin", "main"]);
  return {
    root,
    stateDir,
    worktreeRoot,
    baseSha: git(root, ["rev-parse", "HEAD"]),
    nextWorktree(name) {
      return join(worktreeRoot, name);
    },
  };
}

function invoke(fixtureValue, command, options = {}) {
  const args = [
    command,
    "--root",
    fixtureValue.root,
    "--policy",
    join(fixtureValue.root, ".governance/worktree-policy.json"),
    "--state-dir",
    fixtureValue.stateDir,
    "--json",
  ];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === undefined || value === null) continue;
    const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
    if (value === true) args.push(flag);
    else if (Array.isArray(value)) for (const item of value) args.push(flag, item);
    else args.push(flag, String(value));
  }
  const result = spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: fixtureValue.root,
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // Error paths intentionally use stderr when there is no safe result object.
  }
  return { ...result, json, output: `${result.stdout}${result.stderr}` };
}

function claimArgs(fixtureValue, id, scope, extra = {}) {
  return {
    taskId: id,
    threadId: `thread-${id}`,
    owner: "fixture-owner",
    branch: `misakago/${id}`,
    worktree: fixtureValue.nextWorktree(id),
    scope,
    milestone: "local-simulation",
    trackerIssue: 50,
    goal: "Prove isolated worktree governance locally",
    dueDate: "2099-12-31",
    dependsOn: ["none"],
    label: ["governance"],
    evidence: ["plan", "worktree-check", "fixtures"],
    ...extra,
  };
}

afterEach(() => {
  for (const path of [...fixtures]) {
    rmSync(path, { recursive: true, force: true });
    fixtures.delete(path);
  }
});

describe("isolated worktree harness", () => {
  it("requires risk-first Gate 0-3 orchestration and deterministic required statuses", () => {
    const orchestration = policyFixture.ciOrchestration;
    assert.equal(orchestration.riskFirst, true);
    assert.equal(orchestration.localPreflightRequired, true);
    assert.deepEqual(
      orchestration.gates.map((gate) => gate.id),
      ["gate-0", "gate-1", "gate-2", "gate-3"],
    );
    assert.equal(orchestration.requiredStatuses.alwaysEmit, true);
    assert.equal(orchestration.requiredStatuses.unrelatedChange, "deterministic-no-op");
    assert.equal(orchestration.requiredStatuses.relatedChange, "real-check");
    assert.equal(orchestration.dynamicOrdering.gatesCannotBeRemoved, true);
    assert.equal(orchestration.supersededCommitCancellation.enabled, true);
    assert.deepEqual(orchestration.stackedPr.sequence, ["mise", "feature", "release"]);
    assert.equal(orchestration.mergeQueue.purpose, "combined-validation-only");
    const surface = policyFixture.githubRepositorySurface;
    assert.equal(surface.harnessRemoteWrites, false);
    assert.deepEqual(surface.tabs.issues.requiredMetadata, [
      "labels",
      "milestone",
      "tracker-issue",
      "issue-forms",
      "public-read-issue-creation",
      "blank-issues",
    ]);
    assert.equal(surface.tabs.discussions.required, true);
    assert.deepEqual(surface.tabs.discussions.requiredMetadata, [
      "categories",
      "governance-entry",
      "moderation-owner",
    ]);
    assert.equal(surface.tabs.projects.mode, "optional-view-only");
    assert.equal(surface.tabs.settings.mode, "admin-only-readback");
  });

  it("rejects a policy that disables dynamic ordering or required no-op statuses", () => {
    const value = fixture();
    const policyFile = join(value.root, ".governance/worktree-policy.json");
    const policy = JSON.parse(readFileSync(policyFile, "utf8"));
    policy.ciOrchestration.dynamicOrdering.enabled = false;
    policy.ciOrchestration.requiredStatuses.unrelatedChange = "skip";
    writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
    const rejected = invoke(value, "check");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /risk-first Gate 0-3 orchestration/);
  });

  it("rejects a PR plan with no required label metadata", () => {
    const value = fixture();
    const missingLabel = invoke(value, "plan", {
      ...claimArgs(value, "missing-pr-metadata", "src/a.ts"),
      label: [],
    });
    assert.notEqual(missingLabel.status, 0);
    assert.match(missingLabel.output, /labels/);
  });

  it("keeps plan/claim preview read-only and refuses the root checkout", () => {
    const value = fixture();
    const rootBefore = git(value.root, ["status", "--porcelain"]);
    const preview = invoke(value, "claim", claimArgs(value, "preview", "src/a.ts"));
    assert.equal(preview.status, 0, preview.output);
    assert.equal(preview.json.applied, false);
    assert.equal(preview.json.candidate.coordination.milestone.id, "local-simulation");
    assert.equal(preview.json.candidate.coordination.milestone.githubMilestone.number, 1);
    assert.equal(
      preview.json.candidate.coordination.milestone.githubMilestone.title,
      "Engineering Governance Baseline v1",
    );
    assert.equal(
      preview.json.candidate.coordination.trackerIssue.repository,
      "agentbridges-ai/pi-work",
    );
    assert.equal(preview.json.candidate.coordination.trackerIssue.number, 50);
    assert.equal(preview.json.candidate.coordination.dependencies.length, 0);
    assert.equal(preview.json.candidate.coordination.pullRequest.assignee, "fixture-owner");
    assert.deepEqual(preview.json.candidate.coordination.pullRequest.reviewerTeams, [
      "piwork-core",
      "piwork-leads",
    ]);
    assert.deepEqual(preview.json.candidate.coordination.pullRequest.labels, ["governance"]);
    assert.deepEqual(
      preview.json.candidate.coordination.pullRequest.development.links.map((link) => link.type),
      ["tracker-issue", "depends-on", "stacked-pr"],
    );
    assert.equal(preview.json.candidate.coordination.pullRequest.project, null);
    assert.equal(
      preview.json.candidate.coordination.goal,
      "Prove isolated worktree governance locally",
    );
    assert.equal(preview.json.candidate.coordination.dueDate, "2099-12-31");
    assert.equal(preview.json.candidate.coordination.handoff.destination, "root-coordinator");
    const releaseMilestone = invoke(
      value,
      "plan",
      claimArgs(value, "release-milestone", "src/b.ts", { githubMilestone: 2 }),
    );
    assert.equal(releaseMilestone.status, 0, releaseMilestone.output);
    assert.equal(releaseMilestone.json.milestone.githubMilestone.number, 2);
    assert.equal(existsSync(value.stateDir), false);
    assert.equal(git(value.root, ["status", "--porcelain"]), rootBefore);

    const rejected = invoke(
      value,
      "claim",
      claimArgs(value, "root-write", "src/a.ts", { worktree: value.root, apply: true }),
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /root checkout is read-only|managed worktrees must live outside/);
    assert.equal(git(value.root, ["status", "--porcelain"]), rootBefore);
  });

  it("requires tracker, dependency, and blocked-status evidence", () => {
    const value = fixture();
    const missingTracker = claimArgs(value, "missing-tracker", "src/a.ts");
    delete missingTracker.trackerIssue;
    const trackerResult = invoke(value, "plan", missingTracker);
    assert.notEqual(trackerResult.status, 0);
    assert.match(trackerResult.output, /--tracker-issue/);

    const missingDependency = claimArgs(value, "missing-dependency", "src/b.ts");
    delete missingDependency.dependsOn;
    const dependencyResult = invoke(value, "plan", missingDependency);
    assert.notEqual(dependencyResult.status, 0);
    assert.match(dependencyResult.output, /--depends-on/);

    const blocked = invoke(
      value,
      "plan",
      claimArgs(value, "blocked", "src/a.ts", {
        status: "blocked",
        evidence: ["plan", "worktree-check", "fixtures"],
      }),
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.output, /blocked tasks require|blocked status evidence/);
  });

  it("blocks same-file and high-risk scope overlap", () => {
    const value = fixture();
    const first = invoke(value, "claim", claimArgs(value, "same-a", "src/a.ts", { apply: true }));
    assert.equal(first.status, 0, first.output);
    const sameFile = invoke(value, "plan", claimArgs(value, "same-b", "src/a.ts"));
    assert.notEqual(sameFile.status, 0, sameFile.output);
    assert.match(sameFile.output, /same-file scope overlap/);

    const highRiskClaim = invoke(
      value,
      "claim",
      claimArgs(value, "high-risk-a", "web/server/auth.ts", { apply: true }),
    );
    assert.equal(highRiskClaim.status, 0, highRiskClaim.output);
    assert.equal(highRiskClaim.json.entry.scope.highRisk, true, highRiskClaim.output);
    const highRisk = invoke(
      value,
      "plan",
      claimArgs(value, "high-risk-b", "web/server/other-auth.ts"),
    );
    assert.notEqual(highRisk.status, 0, highRisk.output);
    assert.match(highRisk.output, /high-risk scope overlap/);
  });

  it("detects a base ref that moved after a claim", () => {
    const value = fixture();
    const claimed = invoke(
      value,
      "claim",
      claimArgs(value, "stale-base", "src/a.ts", { apply: true }),
    );
    assert.equal(claimed.status, 0, claimed.output);
    writeFileSync(join(value.root, "README.md"), "fixture advanced\n");
    git(value.root, ["add", "README.md"]);
    git(value.root, ["commit", "-m", "advance fixture main"]);
    git(value.root, ["push", "origin", "main"]);
    const checked = invoke(value, "check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.output, /stale base/);
  });

  it("rejects missing milestone metadata and missing exit evidence", () => {
    const value = fixture();
    const missingMilestone = claimArgs(value, "missing-milestone", "src/a.ts");
    delete missingMilestone.milestone;
    const planned = invoke(value, "plan", missingMilestone);
    assert.notEqual(planned.status, 0);
    assert.match(planned.output, /requires --milestone/);

    const claimed = invoke(
      value,
      "claim",
      claimArgs(value, "missing-exit", "src/a.ts", { apply: true }),
    );
    assert.equal(claimed.status, 0, claimed.output);
    const manifestPath = join(value.stateDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.entries[0].coordination.evidence = ["plan", "worktree-check"];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const checked = invoke(value, "check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.output, /missing exit evidence/);
    const released = invoke(value, "release", { taskId: "missing-exit", apply: true });
    assert.notEqual(released.status, 0);
    assert.match(released.output, /missing exit evidence/);
  });

  it("rejects execution-thread merge and milestone-close attempts", () => {
    const value = fixture();
    for (const command of ["merge", "close-milestone", "complete-milestone"]) {
      const rejected = invoke(value, command);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.output, /cannot merge or close milestones/);
    }
  });

  it("reports dirty managed worktrees and retains them on release", () => {
    const value = fixture();
    const claimed = invoke(value, "claim", claimArgs(value, "dirty", "src/a.ts", { apply: true }));
    assert.equal(claimed.status, 0, claimed.output);
    writeFileSync(join(value.nextWorktree("dirty"), "src/a.ts"), "dirty\n");
    const checked = invoke(value, "check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.output, /dirty managed worktree retained/);
    const released = invoke(value, "release", { taskId: "dirty", apply: true });
    assert.equal(released.status, 0, released.output);
    assert.equal(released.json.retained, true);
    assert.equal(existsSync(value.nextWorktree("dirty")), true);
  });

  it("rejects missing metadata while allowing disjoint parallel scopes", () => {
    const value = fixture();
    const first = invoke(
      value,
      "claim",
      claimArgs(value, "parallel-a", "src/a.ts", { apply: true }),
    );
    const second = invoke(
      value,
      "claim",
      claimArgs(value, "parallel-b", "src/b.ts", { apply: true }),
    );
    assert.equal(first.status, 0, first.output);
    assert.equal(second.status, 0, second.output);
    const manifestPath = join(value.stateDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.entries[0].coordination;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const checked = invoke(value, "check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.output, /missing coordination/);
  });

  it("releases locks, honors TTL cleanup, and retains unpushed commits", () => {
    const value = fixture();
    const claimed = invoke(value, "claim", claimArgs(value, "ttl", "src/a.ts", { apply: true }));
    assert.equal(claimed.status, 0, claimed.output);
    const lockPath = join(value.stateDir, "locks.json");
    const locks = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(locks.locks[0].taskId, "ttl");
    locks.locks[0].expiresAt = new Date(0).toISOString();
    const manifest = JSON.parse(readFileSync(join(value.stateDir, "manifest.json"), "utf8"));
    manifest.entries[0].expiresAt = new Date(0).toISOString();
    writeFileSync(lockPath, `${JSON.stringify(locks)}\n`);
    writeFileSync(join(value.stateDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const cleaned = invoke(value, "cleanup", { apply: true });
    assert.equal(cleaned.status, 0, cleaned.output);
    assert.equal(cleaned.json.reclaimed.length, 1);

    const unpushed = invoke(
      value,
      "claim",
      claimArgs(value, "unpushed", "src/b.ts", { apply: true }),
    );
    assert.equal(unpushed.status, 0, unpushed.output);
    const unpushedPath = value.nextWorktree("unpushed");
    writeFileSync(join(unpushedPath, "src/b.ts"), "committed\n");
    git(unpushedPath, ["config", "user.name", "Worktree Harness Fixture"]);
    git(unpushedPath, ["config", "user.email", "worktree-harness@example.test"]);
    git(unpushedPath, ["add", "src/b.ts"]);
    git(unpushedPath, ["commit", "-m", "fixture unpushed commit"]);
    const unpushedManifestPath = join(value.stateDir, "manifest.json");
    const unpushedManifest = JSON.parse(readFileSync(unpushedManifestPath, "utf8"));
    unpushedManifest.entries.find((entry) => entry.taskId === "unpushed").expiresAt = new Date(
      0,
    ).toISOString();
    const unpushedLocks = JSON.parse(readFileSync(lockPath, "utf8"));
    unpushedLocks.locks.find((entry) => entry.taskId === "unpushed").expiresAt = new Date(
      0,
    ).toISOString();
    writeFileSync(unpushedManifestPath, `${JSON.stringify(unpushedManifest)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(unpushedLocks)}\n`);
    const retained = invoke(value, "cleanup", { taskId: "unpushed", apply: true });
    assert.equal(retained.status, 0, retained.output);
    assert.equal(retained.json.retained?.[0]?.reason, "unpushed", retained.output);
    assert.equal(existsSync(unpushedPath), true);
  });

  it("copies only gitignored .env files and never records their contents", () => {
    const value = fixture();
    const secret = "PIWORK_FIXTURE_SECRET_DO_NOT_RECORD";
    writeFileSync(join(value.root, ".env"), `API_KEY=${secret}\n`);
    writeFileSync(join(value.root, ".worktreeinclude"), ".env\n");
    const claimed = invoke(
      value,
      "claim",
      claimArgs(value, "env-copy", "src/a.ts", { apply: true }),
    );
    assert.equal(claimed.status, 0, claimed.output);
    const copied = readFileSync(join(value.nextWorktree("env-copy"), ".env"), "utf8");
    assert.equal(copied, `API_KEY=${secret}\n`);
    const stateText = `${readFileSync(join(value.stateDir, "manifest.json"), "utf8")}\n${readFileSync(
      join(value.stateDir, "locks.json"),
      "utf8",
    )}`;
    assert.equal(stateText.includes(secret), false);
    assert.equal(claimed.json.includedFiles, 1);
  });
});
