import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getDatabaseUrl } from "../server/better-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../server/migrations/rbac.sql");
const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for RBAC migrations.");
}

const sql = await readFile(migrationPath, "utf-8");
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(sql);
  console.log(`[rbac-migrate] Applied ${migrationPath}`);
} finally {
  await pool.end();
}
