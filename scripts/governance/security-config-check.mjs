#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const failures = [];

function source(file) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`${file}: required security source is missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

const environment = source("web/server/environment.ts");
for (const variable of ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
  if (!environment.includes(`"${variable}"`)) {
    failures.push(`environment.ts: production validation does not name ${variable}`);
  }
}
if (!environment.includes("PIWORK_MCP_MASTER_KEY")) {
  failures.push("environment.ts: production Control Plane key validation is missing");
}
if (!environment.includes("validateProductionEnvironment")) {
  failures.push("environment.ts: fail-fast production validation entrypoint is missing");
}

for (const route of [
  "web/server/routes/metrics-routes.ts",
  "web/server/routes/diagnostics-routes.ts",
]) {
  const text = source(route);
  if (!text.includes("authorize"))
    failures.push(`${route}: runtime authorization boundary is missing`);
  if (!text.includes("403")) failures.push(`${route}: default-deny response is missing`);
}

const routes = source("web/server/routes.ts");
if (!routes.includes('"runtime:view"'))
  failures.push("routes.ts: runtime:view permission is not wired");

const tests = [
  "web/server/environment.test.ts",
  "web/server/routes/metrics-routes.test.ts",
  "web/server/routes/diagnostics-routes.test.ts",
];
for (const test of tests) {
  const testSource = source(test);
  if (!testSource.includes("authorization") && !testSource.includes("fails closed")) {
    failures.push(`${test}: focused security regression test is missing`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(
  "[security-config] production fail-fast configuration and runtime-view authorization verified",
);
