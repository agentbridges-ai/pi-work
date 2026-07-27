#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [rawOutput] = process.argv.slice(2);
if (!rawOutput) {
  console.error("[backup] run-pg-dump.mjs requires an output path");
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL || "";
let url;
try {
  url = new URL(connectionString);
} catch {
  console.error("[backup] DATABASE_URL must be a postgresql:// or postgres:// URL");
  process.exit(1);
}
if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
  console.error("[backup] DATABASE_URL must use the postgresql:// or postgres:// scheme");
  process.exit(1);
}

const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  console.error("[backup] DATABASE_URL must identify a database");
  process.exit(1);
}

const env = { ...process.env };
env.PGHOST = url.searchParams.get("host") || decodeURIComponent(url.hostname);
if (url.port) env.PGPORT = url.port;
if (url.username) env.PGUSER = decodeURIComponent(url.username);
if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
env.PGDATABASE = database;

const parameterEnvironment = new Map([
  ["application_name", "PGAPPNAME"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["gssencmode", "PGGSSENCMODE"],
  ["options", "PGOPTIONS"],
  ["sslcert", "PGSSLCERT"],
  ["sslcrl", "PGSSLCRL"],
  ["sslkey", "PGSSLKEY"],
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
]);
for (const [parameter, variable] of parameterEnvironment) {
  const value = url.searchParams.get(parameter);
  if (value) env[variable] = value;
}

const result = spawnSync(
  "pg_dump",
  ["--format=custom", "--no-owner", "--no-privileges", `--file=${resolve(rawOutput)}`],
  {
    env,
    stdio: "inherit",
  },
);
if (result.error) {
  console.error(`[backup] failed to start pg_dump: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
