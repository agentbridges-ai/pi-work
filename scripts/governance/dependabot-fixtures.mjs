#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const dependabot = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
const webPackage = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8"));

function updateBlock(ecosystem, directory) {
  const marker = "  - package-ecosystem: " + ecosystem + "\n    directory: " + directory;
  const start = dependabot.indexOf(marker);
  assert.notEqual(start, -1, "Dependabot update block is missing: " + ecosystem + " " + directory);
  const end = dependabot.indexOf("\n  - package-ecosystem:", start + marker.length);
  return dependabot.slice(start, end === -1 ? dependabot.length : end);
}

const web = updateBlock("bun", "/web");
for (const [name, version] of Object.entries({
  "@anthropic-ai/sandbox-runtime": "0.0.65",
  "@earendil-works/pi-ai": "0.82.1",
  "@earendil-works/pi-coding-agent": "0.82.1",
  "@modelcontextprotocol/sdk": "1.29.0",
})) {
  assert.equal(webPackage.dependencies?.[name], version, name + " must remain exact-pinned");
  const escaped = name.replaceAll("/", "\\/");
  assert.match(
    web,
    new RegExp("dependency-name:\\s*[\"']" + escaped + "[\"']"),
    name + " must be ignored by the web Dependabot update",
  );
}

const actions = updateBlock("github-actions", "/");
assert.match(
  actions,
  /groups:\s*[\s\S]*action-patches:/,
  "GitHub Actions updates must stay grouped",
);

for (const path of [".github/workflows/verify.yml", ".github/workflows/deep-verify.yml"]) {
  const workflow = readFileSync(join(root, path), "utf8");
  assert.match(workflow, /--allow-dependency-lockfile-drift/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*pull_request/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*merge_group/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*push/);
  assert.match(workflow, /refs\/heads\/main/);
}

const codeql = readFileSync(join(root, ".github/workflows/codeql.yml"), "utf8");
const codeqlRefs = [
  ...codeql.matchAll(/github\/codeql-action\/(?:init|autobuild|analyze)@([0-9a-f]{40})/g),
].map(([, sha]) => sha);
assert.deepEqual(
  codeqlRefs,
  [
    "f205ea1c3313d32999d8d6a48b4f6530d4437b38",
    "f205ea1c3313d32999d8d6a48b4f6530d4437b38",
    "f205ea1c3313d32999d8d6a48b4f6530d4437b38",
  ],
  "CodeQL init/analyze must use one v4 SHA",
);
assert.match(codeql, /build-mode:\s*none/);
assert.doesNotMatch(codeql, /codeql-action\/autobuild@/);

console.log(
  "[dependabot-fixtures] exact runtime pins, lockfile drift boundaries, and CodeQL v4 wiring passed",
);
