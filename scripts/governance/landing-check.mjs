#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const landing = join(root, "landing-page");
const failures = [];

function run(args) {
  const result = spawnSync("bun", args, { cwd: landing, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) failures.push(`bun ${args.join(" ")} failed`);
}

if (!existsSync(join(landing, "bun.lock"))) failures.push("landing-page/bun.lock is missing");
run(["install", "--frozen-lockfile"]);
run(["run", "lint", "--", "--max-warnings=0"]);
run(["x", "tsc", "--noEmit"]);
run(["run", "build"]);

const index = join(landing, "out/index.html");
if (!existsSync(index)) failures.push("landing-page/out/index.html is missing after build");
else {
  const html = readFileSync(index, "utf8");
  if (!html.includes("<html")) failures.push("landing-page/out/index.html is not an HTML document");
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("[landing] frozen install, lint, typecheck, static build, and index smoke verified");
