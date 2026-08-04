#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const webPackage = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8"));
const errors = [];
if (!existsSync(join(root, "release-please-config.json")))
  errors.push("release-please-config.json is missing");
if (!existsSync(join(root, "CHANGELOG.md"))) errors.push("CHANGELOG.md is missing");
if (!existsSync(join(root, "scripts/governance/release-evidence.mjs")))
  errors.push("release evidence generator is missing");
if (rootPackage.version !== webPackage.version)
  errors.push(`root/web version mismatch: ${rootPackage.version} != ${webPackage.version}`);
if (rootPackage.license !== "MIT") errors.push("root package must remain MIT");
if (rootPackage.private !== true)
  errors.push("root package must remain private; Piwork is not published to npm");
if (existsSync(join(root, "release-please-config.json"))) {
  const releaseConfig = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
  if (releaseConfig["include-component-in-tag"] !== false)
    errors.push("Release Please must use a single vX.Y.Z tag");
  if (releaseConfig["changelog-path"] !== "CHANGELOG.md")
    errors.push("Release Please must write the root CHANGELOG.md");
}
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(
  `[release] Piwork ${rootPackage.version}, CHANGELOG, Release Please, and npm publication boundary verified`,
);
