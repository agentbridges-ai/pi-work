#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : "release-evidence.json";
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const webPackage = JSON.parse(readFileSync(join(root, "web/package.json"), "utf8"));
const manifest = readFileSync(join(root, ".release-please-manifest.json"));
const checks = (process.env.REQUIRED_CHECK_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY || "agentbridges-ai/pi-work",
  commit: process.env.GITHUB_SHA || "local-dry-run",
  version: rootPackage.version,
  webVersion: webPackage.version,
  tag: `v${rootPackage.version}`,
  requiredCheckUrls: checks,
  toolchain: Object.fromEntries(
    readFileSync(join(root, ".tool-versions"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/, 2)),
  ),
  releaseManifestDigest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
};

const destination = resolve(root, output);
writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`[release-evidence] wrote ${destination}`);
