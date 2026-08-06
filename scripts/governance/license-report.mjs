#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const policy = JSON.parse(readFileSync(join(root, ".governance/license-policy.json"), "utf8"));
const exceptions = JSON.parse(readFileSync(join(root, ".governance/exceptions.json"), "utf8"));
const manifests = ["package.json", "web/package.json", "landing-page/package.json"];
const failures = [];
const report = [];

function packageLicense(parsed) {
  if (typeof parsed.license === "string" && parsed.license.trim()) return parsed.license.trim();
  if (typeof parsed.license?.type === "string" && parsed.license.type.trim()) {
    return parsed.license.type.trim();
  }
  if (Array.isArray(parsed.licenses) && parsed.licenses.length === 1) {
    const value = parsed.licenses[0];
    if (typeof value === "string") return value.trim();
    if (value && typeof value.type === "string") return value.type.trim();
  }
  return "UNKNOWN";
}

function dependencyManifest(projectManifest, dependency, specification) {
  const projectRoot = dirname(join(root, projectManifest));
  const candidates = [];
  if (typeof specification === "string" && specification.startsWith("file:")) {
    candidates.push(resolve(projectRoot, specification.slice("file:".length), "package.json"));
  }
  candidates.push(join(projectRoot, "node_modules", dependency, "package.json"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hasActiveException(scope) {
  const now = Date.now();
  return (exceptions.exceptions || []).some(
    (item) =>
      item.control === "license-compliance" &&
      item.scope === scope &&
      Date.parse(item.expiresAt || "") > now,
  );
}

function checkDependencyLicense(projectManifest, dependency, specification) {
  const path = dependencyManifest(projectManifest, dependency, specification);
  const license = path ? packageLicense(JSON.parse(readFileSync(path, "utf8"))) : "UNKNOWN";
  const scope = `${projectManifest.replace(/\/package\.json$/, "") || "."}:${dependency}`;
  report.push({ manifest: projectManifest, dependency, license, packageManifest: path });
  if (!policy.allowedSpdx.includes(license) && !hasActiveException(scope)) {
    failures.push(`${scope}: dependency license ${license} requires maintainer review`);
  }
}

for (const manifest of manifests) {
  const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  const license = packageLicense(parsed);
  if (!policy.allowedSpdx.includes(license) && !hasActiveException(`${manifest}:package`)) {
    failures.push(`${manifest}: package license ${license} requires maintainer review`);
  }
  report.push({ manifest, license });
  for (const [dependency, specification] of Object.entries(parsed.dependencies || {})) {
    checkDependencyLicense(manifest, dependency, specification);
  }
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
