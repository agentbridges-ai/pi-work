#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const failures = [];

for (const directory of ["web", "landing-page"]) {
  const lock = join(root, directory, "bun.lock");
  if (!existsSync(lock))
    failures.push(
      `${directory}/bun.lock is missing; frozen security checks cannot be reproducible`,
    );
  const result = spawnSync("bun", ["audit", "--audit-level=high"], {
    cwd: join(root, directory),
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    failures.push(
      `${directory}: bun audit reported High/Critical findings\n${result.stdout || ""}${result.stderr || ""}`,
    );
  }
}

for (const manifest of ["package.json", "web/package.json", "landing-page/package.json"]) {
  const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  if (parsed.license && parsed.license !== "MIT")
    console.warn(`[license] ${manifest}: ${parsed.license}`);
}

const licensePolicy = join(root, ".governance/license-policy.json");
if (!existsSync(licensePolicy)) failures.push(".governance/license-policy.json is missing");
else {
  const policy = JSON.parse(readFileSync(licensePolicy, "utf8"));
  if (
    policy.owner !== "Misakago" ||
    !Array.isArray(policy.allowedSpdx) ||
    !Array.isArray(policy.reviewRequired)
  ) {
    failures.push(".governance/license-policy.json is incomplete");
  }
}

const licenseReport = spawnSync("node", [join(root, "scripts/governance/license-report.mjs")], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
});
if (licenseReport.status !== 0)
  failures.push(`${licenseReport.stdout || ""}${licenseReport.stderr || ""}`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("[security] frozen Bun lockfiles and High+ audit policy verified");
