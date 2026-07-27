import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getLocalDataRoot, requireTenantId } from "../server/local-paths.js";

const execute = process.argv.includes("--execute");
const dataRoot = getLocalDataRoot();
const entries = readdirSync(dataRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "tenants")
  .map((entry) => entry.name);

const operations = entries.flatMap((userId) => {
  const tenantId = requireTenantId(`personal-${userId}`);
  const sourceRoot = join(dataRoot, userId);
  const targetRoot = join(dataRoot, "tenants", tenantId, "users", userId);
  return readdirSync(sourceRoot, { withFileTypes: true }).map((entry) => {
    const source = join(sourceRoot, entry.name);
    const isSession = entry.isDirectory() && existsSync(join(source, "session.json"));
    const bucket = isSession ? "sessions" : entry.name === "pi-resources" ? "" : "profile";
    return {
      userId,
      tenantId,
      kind: isSession ? "session" : "profile",
      source,
      target: join(targetRoot, bucket, entry.name),
    };
  });
});
const manifestPath = resolve(dataRoot, "tenant-migration-manifest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), execute, operations }, null, 2)}\n`,
  { flag: "w" },
);

for (const operation of operations) {
  if (!execute) continue;
  if (existsSync(operation.target)) continue;
  if (lstatSync(operation.source).isSymbolicLink())
    throw new Error(`Refusing to migrate symbolic link: ${operation.source}`);
  mkdirSync(dirname(operation.target), { recursive: true, mode: 0o700 });
  renameSync(operation.source, operation.target);
}

console.log(`[tenant-migrate] ${execute ? "Executed" : "Dry run"}; manifest: ${manifestPath}`);
