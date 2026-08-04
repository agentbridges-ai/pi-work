#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/license-policy.json"), "utf8"));
const manifests = ["package.json", "web/package.json", "landing-page/package.json"];
const failures = [];
const report = [];

for (const manifest of manifests) {
  const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  if (parsed.license && !policy.allowedSpdx.includes(parsed.license)) {
    failures.push(`${manifest}: package license ${parsed.license} requires Leader review`);
  }
  report.push({ manifest, license: parsed.license || "UNKNOWN" });
}

for (const directory of ["web", "landing-page"]) {
  if (!existsSync(join(root, directory, "bun.lock")))
    failures.push(`${directory}/bun.lock is missing`);
}

console.log(
  JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), report }, null, 2),
);
if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
