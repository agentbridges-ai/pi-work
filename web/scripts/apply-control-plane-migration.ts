import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getDatabaseUrl } from "../server/better-auth.js";

const root = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(root, "../server/migrations/control-plane.sql");
const databaseUrl = getDatabaseUrl();
if (!databaseUrl) throw new Error("DATABASE_URL is required for control-plane migrations.");

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query(await readFile(migrationPath, "utf-8"));
  console.log(`[control-plane-migrate] Applied ${migrationPath}`);
} finally {
  await pool.end();
}
