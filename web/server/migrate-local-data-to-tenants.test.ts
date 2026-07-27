import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  dataRoot: string;
  scriptPath: string;
  userId: string;
  sessionId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "piwork-tenant-migrate-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const userId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const userRoot = join(dataRoot, userId);
  mkdirSync(join(userRoot, "pi-resources", "skills"), { recursive: true });
  writeFileSync(join(userRoot, "pi-resources", "skills", "SKILL.md"), "# governed\n");
  mkdirSync(join(userRoot, sessionId), { recursive: true });
  writeFileSync(join(userRoot, sessionId, "session.json"), "{}\n");
  writeFileSync(join(userRoot, "preferences.json"), "{}\n");
  mkdirSync(join(dataRoot, "tenants"), { recursive: true });
  return {
    dataRoot,
    scriptPath: fileURLToPath(
      new URL("../scripts/migrate-local-data-to-tenants.ts", import.meta.url),
    ),
    userId,
    sessionId,
  };
}

function run(dataRoot: string, scriptPath: string, execute = false) {
  return spawnSync("bun", [scriptPath, ...(execute ? ["--execute"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PIWORK_DATA_ROOT: dataRoot,
    },
  });
}

describe("local tenant data migration CLI", () => {
  it("keeps Pi resources at user scope and classifies sessions during dry-run", () => {
    const value = fixture();
    const result = run(value.dataRoot, value.scriptPath);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[tenant-migrate] Dry run");

    const manifest = JSON.parse(
      readFileSync(join(value.dataRoot, "tenant-migration-manifest.json"), "utf8"),
    ) as {
      execute: boolean;
      operations: Array<{ source: string; target: string; kind: string }>;
    };
    expect(manifest.execute).toBe(false);
    expect(manifest.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "profile",
          source: join(value.dataRoot, value.userId, "pi-resources"),
          target: join(
            value.dataRoot,
            "tenants",
            `personal-${value.userId}`,
            "users",
            value.userId,
            "pi-resources",
          ),
        }),
        expect.objectContaining({
          kind: "session",
          source: join(value.dataRoot, value.userId, value.sessionId),
          target: join(
            value.dataRoot,
            "tenants",
            `personal-${value.userId}`,
            "users",
            value.userId,
            "sessions",
            value.sessionId,
          ),
        }),
      ]),
    );
    expect(existsSync(join(value.dataRoot, value.userId, "pi-resources"))).toBe(true);
  });

  it("moves the classified entries only after explicit execution", () => {
    const value = fixture();
    const result = run(value.dataRoot, value.scriptPath, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[tenant-migrate] Executed");
    const tenantUserRoot = join(
      value.dataRoot,
      "tenants",
      `personal-${value.userId}`,
      "users",
      value.userId,
    );
    expect(existsSync(join(tenantUserRoot, "pi-resources", "skills", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tenantUserRoot, "sessions", value.sessionId, "session.json"))).toBe(
      true,
    );
    expect(existsSync(join(tenantUserRoot, "profile", "preferences.json"))).toBe(true);
    expect(existsSync(join(value.dataRoot, value.userId, "pi-resources"))).toBe(false);
  });
});
