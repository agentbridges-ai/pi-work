#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const immutableActionRef = /^[^/@\s]+\/[^@\s]+(?:\/[^@\s]+)*@([0-9a-f]{40})$/;
const versionComment = /^v\d+\.\d+\.\d+$/;

function workflowFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...workflowFiles(path));
    else if ([".yml", ".yaml"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

export function findMutableExternalActionUses(files) {
  const failures = [];
  let externalUses = 0;
  for (const file of files) {
    const lines = file.source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
      if (!match) continue;
      const [rawAction, rawComment = ""] = match[1].split(/\s+#\s*/, 2);
      const action = rawAction.trim().replace(/^['"]|['"]$/g, "");
      if (action.startsWith("./") || action.startsWith("docker://")) continue;
      externalUses += 1;
      const immutable = action.match(immutableActionRef);
      if (!immutable) {
        failures.push(`${file.path}:${index + 1}: external Action is not pinned to a full SHA`);
        continue;
      }
      if (!versionComment.test(rawComment.trim())) {
        failures.push(
          `${file.path}:${index + 1}: pinned Action is missing an exact version comment`,
        );
      }
    }
  }
  return { externalUses, failures };
}

export function scanGithubActionPins(repositoryRoot = root) {
  const files = [
    ...workflowFiles(join(repositoryRoot, ".github", "actions")),
    ...workflowFiles(join(repositoryRoot, ".github", "workflows")),
  ].map((path) => ({ path: relative(repositoryRoot, path), source: readFileSync(path, "utf8") }));
  return findMutableExternalActionUses(files);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const result = scanGithubActionPins();
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`[actions-pinning] ${failure}`);
    process.exit(1);
  }
  console.log(`[actions-pinning] verified ${result.externalUses} immutable external Action refs`);
}
