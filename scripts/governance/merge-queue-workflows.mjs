#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const failures = [];

const requiredWorkflowJobs = {
  governance: [".github/workflows/governance.yml", "governance"],
  quality: [".github/workflows/verify.yml", "quality"],
  "better-auth-e2e": [".github/workflows/verify.yml", "better-auth-e2e"],
  "srt-production-canaries": [".github/workflows/srt-linux.yml", "srt-production-canaries"],
  verify: [".github/workflows/deep-verify.yml", "verify"],
  "landing-quality": [".github/workflows/landing-quality.yml", "landing-quality"],
  "dependency-review": [".github/workflows/dependency-review.yml", "dependency-review"],
  "governance-review": [".github/workflows/leader-review.yml", "governance-review"],
};

function readWorkflow(file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch (error) {
    failures.push(
      file +
        ": unable to read workflow (" +
        (error instanceof Error ? error.message : String(error)) +
        ")",
    );
    return "";
  }
}

function hasMergeGroupTrigger(file, text) {
  const onStart = text.indexOf("on:");
  const jobsStart = text.indexOf("\njobs:", onStart);
  const onBlock = text.slice(onStart, jobsStart === -1 ? undefined : jobsStart);
  if (!/^  merge_group:\s*(?:#.*)?$/m.test(onBlock)) {
    failures.push(file + ": required-status workflow must trigger on merge_group");
  }
}

function hasJob(file, text, job) {
  const escaped = job.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  if (!new RegExp("^  " + escaped + ":\\s*$", "m").test(text)) {
    failures.push(file + ": required job " + job + " is missing");
  }
}

function requirePattern(file, text, pattern, message) {
  if (!pattern.test(text)) failures.push(file + ": " + message);
}

if (!Array.isArray(policy.requiredChecks)) {
  failures.push("github-policy.json: requiredChecks must be an array");
} else {
  const policyChecks = new Set(policy.requiredChecks);
  const mappedChecks = new Set(Object.keys(requiredWorkflowJobs));
  if (
    policyChecks.size !== mappedChecks.size ||
    [...policyChecks].some((check) => !mappedChecks.has(check))
  ) {
    failures.push(
      "github-policy.json: requiredChecks must map exactly to the audited required-status workflow jobs",
    );
  }
}

for (const [check, [file, job]] of Object.entries(requiredWorkflowJobs)) {
  const text = readWorkflow(file);
  hasMergeGroupTrigger(file, text);
  hasJob(file, text, job);
  if (!policy.requiredChecks?.includes(check)) {
    failures.push(file + ": job " + job + " is not listed in github-policy.json requiredChecks");
  }
}

const deepVerify = readWorkflow(".github/workflows/deep-verify.yml");
requirePattern(
  ".github/workflows/deep-verify.yml",
  deepVerify,
  /EVENT_NAME.*merge_group/,
  "merge_group must take an explicit no-pull_request metadata branch",
);
requirePattern(
  ".github/workflows/deep-verify.yml",
  deepVerify,
  /merge_group\.(?:base_sha|head_sha)/,
  "OnlyOffice deep-verify range must use merge_group SHAs when PR metadata is absent",
);
requirePattern(
  ".github/workflows/deep-verify.yml",
  deepVerify,
  /PR-only coverage and explicit candidate integration remain intentionally skipped,/,
  "merge_group candidate/coverage behavior must be an explicit safe boundary",
);

const srtLinux = readWorkflow(".github/workflows/srt-linux.yml");
requirePattern(
  ".github/workflows/srt-linux.yml",
  srtLinux,
  /event_name.*merge_group/,
  "merge_group must explicitly classify the synthetic queue commit",
);

const verify = readWorkflow(".github/workflows/verify.yml");
requirePattern(
  ".github/workflows/verify.yml",
  verify,
  /event_name == 'merge_group'/,
  "merge_group must explicitly report the PR metadata boundary",
);
requirePattern(
  ".github/workflows/verify.yml",
  verify,
  /merge_group\.(?:base_sha|head_sha)/,
  "OnlyOffice event range must use merge_group SHAs when PR metadata is absent",
);

const dependencyReview = readWorkflow(".github/workflows/dependency-review.yml");
requirePattern(
  ".github/workflows/dependency-review.yml",
  dependencyReview,
  /Dependency review no-op for merge group/,
  "merge_group must not invoke the PR-only dependency-review action without PR metadata",
);
requirePattern(
  ".github/workflows/dependency-review.yml",
  dependencyReview,
  /event_name != 'pull_request' && github\.event_name != 'merge_group'/,
  "non-PR dependency-review no-op must not duplicate the merge_group branch",
);

const leaderReview = readWorkflow(".github/workflows/leader-review.yml");
requirePattern(
  ".github/workflows/leader-review.yml",
  leaderReview,
  /Governance review no-op for merge group/,
  "merge_group must not execute author-aware PR review without PR metadata",
);
requirePattern(
  ".github/workflows/leader-review.yml",
  leaderReview,
  /event_name != 'merge_group'/,
  "author-aware leader review must be skipped only for the merge_group boundary",
);

for (const file of [".github/workflows/deploy.yml", ".github/workflows/release-please.yml"]) {
  const text = readWorkflow(file);
  if (/^  merge_group:\s*$/m.test(text)) {
    failures.push(file + ": production/release workflow must not trigger on merge_group");
  }
}

if (policy.mergeQueue?.enabled !== false) {
  failures.push(
    "github-policy.json: mergeQueue.enabled must remain false until the deferred apply gate is satisfied",
  );
}
if (policy.mergeQueue?.recommendedConfiguration?.mergingStrategy !== "ALLGREEN") {
  failures.push("github-policy.json: merge queue recommendation must use ALLGREEN");
}
if (policy.mergeQueue?.recommendedConfiguration?.mergeMethod !== "SQUASH") {
  failures.push("github-policy.json: merge queue recommendation must use SQUASH");
}
if (policy.stackedPullRequests?.dependencyOrder?.join("->") !== "mise->feature->release") {
  failures.push("github-policy.json: stacked PR dependency order must remain mise -> feature -> release");
}

if (failures.length) {
  console.error(failures.map((failure) => "- " + failure).join("\n"));
  process.exit(1);
}

console.log(
  "[merge-queue-workflows] required statuses, merge_group metadata boundaries, production guards, and policy fixtures passed",
);
