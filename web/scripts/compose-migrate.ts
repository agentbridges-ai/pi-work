import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const commands = [
  [
    "bun",
    [
      "-e",
      [
        'import { getMigrations } from "better-auth/db/migration";',
        'import { auth, betterAuthPool } from "./server/better-auth.js";',
        "try {",
        "  const { runMigrations } = await getMigrations(auth.options);",
        "  await runMigrations();",
        "} finally {",
        "  await betterAuthPool.end();",
        "}",
      ].join("\n"),
    ],
  ],
  ["bun", ["scripts/apply-rbac-migration.ts"]],
  ["bun", ["scripts/apply-control-plane-migration.ts"]],
] as const;

for (const [command, args] of commands) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal || code})`));
    });
  });
}

const appUser = (process.env.PIWORK_POSTGRES_APP_USER || "piwork_web").trim();
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(appUser)) {
  throw new Error("PIWORK_POSTGRES_APP_USER is invalid");
}
const passwordFile = process.env.PIWORK_POSTGRES_APP_PASSWORD_FILE;
if (!passwordFile) throw new Error("PIWORK_POSTGRES_APP_PASSWORD_FILE is required");
const appPassword = readFileSync(passwordFile, "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,256}$/.test(appPassword)) {
  throw new Error("Postgres application password file is invalid");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for platform migrations");
const pool = new Pool({ connectionString: databaseUrl });
try {
  const quotedUser = (await pool.query("select quote_ident($1) value", [appUser])).rows[0]
    ?.value as string | undefined;
  const quotedPassword = (await pool.query("select quote_literal($1) value", [appPassword])).rows[0]
    ?.value as string | undefined;
  if (!quotedUser || !quotedPassword) throw new Error("Could not quote Postgres application role");
  const roleExists = await pool.query("select 1 from pg_roles where rolname=$1", [appUser]);
  if (roleExists.rowCount) {
    await pool.query(
      `alter role ${quotedUser} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${quotedPassword}`,
    );
  } else {
    await pool.query(
      `create role ${quotedUser} with login nosuperuser nocreatedb nocreaterole nobypassrls password ${quotedPassword}`,
    );
  }
  await pool.query(`grant usage on schema public to ${quotedUser}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${quotedUser}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${quotedUser}`,
  );
  await pool.query(
    `grant execute on function piwork_cleanup_cloudflare_expired() to ${quotedUser}`,
  );
  const currentRole = String(
    (await pool.query("select quote_ident(current_user) value")).rows[0]?.value || "",
  );
  if (!currentRole) throw new Error("Could not resolve migration role");
  await pool.query(
    `alter default privileges for role ${currentRole} in schema public grant select, insert, update, delete on tables to ${quotedUser}`,
  );
  await pool.query(
    `alter default privileges for role ${currentRole} in schema public grant usage, select, update on sequences to ${quotedUser}`,
  );
} finally {
  await pool.end();
}
