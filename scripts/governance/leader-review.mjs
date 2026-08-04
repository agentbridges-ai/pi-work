#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/github-policy.json"), "utf8"));
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const pullRequest = event.pull_request;
if (!pullRequest || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
  console.log("[governance-review] no pull request event; nothing to evaluate");
  process.exit(0);
}

const apiBase = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  if (!response.ok)
    throw new Error(
      `${options.method || "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
  return response.json();
}

async function apiPages(path) {
  const pages = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await api(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error(`Expected a paginated array from ${path}`);
    pages.push(...items);
    if (items.length < 100) break;
  }
  return pages;
}

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

const files = await apiPages(`/pulls/${pullRequest.number}/files`);
const highRisk = files.some((file) =>
  policy.highRiskPaths.some((pattern) => globToRegExp(pattern).test(file.filename)),
);
const reviews = highRisk ? await apiPages(`/pulls/${pullRequest.number}/reviews`) : [];
const headSha = pullRequest.head.sha;
const leaderParticipated =
  pullRequest.user.login === policy.leader ||
  reviews.some(
    (review) =>
      review.user?.login === policy.leader &&
      review.state === "APPROVED" &&
      review.commit_id === headSha,
  );
const state = !highRisk || leaderParticipated ? "success" : "failure";
const description = !highRisk
  ? "普通改动：Leader 参与检查不适用"
  : leaderParticipated
    ? `高风险改动：${policy.leader} 已作为作者或最新提交批准者参与`
    : `高风险改动必须由 ${policy.leader} 作为作者或最新提交批准者参与`;

await api(`/statuses/${headSha}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    state,
    context: "governance-review",
    description: description.slice(0, 140),
    target_url: `https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${pullRequest.number}`,
  }),
});

if (state !== "success") process.exit(1);
console.log(`[governance-review] ${description}`);
