import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildE2EEnvironment,
  connectE2EDatabase,
  databaseNameFromE2EUrl,
  defaultE2ERunnerDependencies,
  e2eSteps,
  isDedicatedE2EDatabaseName,
  runBetterAuthE2E,
  runBunStep,
  runtimePaths,
  type E2EDatabase,
  type E2ERunnerDependencies,
} from "./run-better-auth-e2e.js";

function fakeDatabase(actualName = "piwork_e2e") {
  const database: E2EDatabase = {
    currentDatabaseName: vi.fn(async () => actualName),
    acquireRunLock: vi.fn(async () => true),
    resetRows: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return database;
}

function fakeDependencies(database: E2EDatabase) {
  const dependencies: E2ERunnerDependencies = {
    connect: vi.fn(async () => database),
    createRunRoot: vi.fn(() => "/tmp/piwork-e2e-test-run"),
    prepareRunDirectories: vi.fn(),
    removeRunRoot: vi.fn(),
    runStep: vi.fn(async () => undefined),
  };
  return dependencies;
}

describe("dedicated E2E database validation", () => {
  it("accepts only PostgreSQL URLs with a standalone e2e database-name segment", () => {
    expect(databaseNameFromE2EUrl("postgres://user:pass@localhost/piwork_e2e")).toBe("piwork_e2e");
    expect(databaseNameFromE2EUrl("postgresql://localhost/e2e-local")).toBe("e2e-local");
    expect(isDedicatedE2EDatabaseName("team-e2e-ci")).toBe(true);
    expect(isDedicatedE2EDatabaseName("piwork_e2eproduction")).toBe(false);

    for (const url of [
      "not a url",
      "https://localhost/piwork_e2e",
      "postgres://localhost",
      "postgres://localhost/piwork",
      "postgres://localhost/piwork_e2e/other",
      "postgres://localhost/piwork_e2e%2Fother",
      "postgres://localhost/piwork_e2e%ZZ",
    ]) {
      expect(() => databaseNameFromE2EUrl(url), url).toThrow();
    }
  });

  it("requires the explicit E2E URL instead of falling back to DATABASE_URL", async () => {
    await expect(
      runBetterAuthE2E(
        { DATABASE_URL: "postgres://localhost/piwork_e2e" },
        fakeDependencies(fakeDatabase()),
      ),
    ).rejects.toThrow(/PIWORK_E2E_DATABASE_URL is required/);
  });

  it("does not lock, reset, or create directories when the connected database differs", async () => {
    const database = fakeDatabase("production");
    const dependencies = fakeDependencies(database);
    await expect(
      runBetterAuthE2E(
        { PIWORK_E2E_DATABASE_URL: "postgres://localhost/piwork_e2e" },
        dependencies,
      ),
    ).rejects.toThrow(/does not match/);

    expect(database.acquireRunLock).not.toHaveBeenCalled();
    expect(database.resetRows).not.toHaveBeenCalled();
    expect(dependencies.createRunRoot).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("fails closed without resetting rows when another run owns the advisory lock", async () => {
    const database = fakeDatabase();
    vi.mocked(database.acquireRunLock).mockResolvedValue(false);
    const dependencies = fakeDependencies(database);
    await expect(
      runBetterAuthE2E(
        { PIWORK_E2E_DATABASE_URL: "postgres://localhost/piwork_e2e" },
        dependencies,
      ),
    ).rejects.toThrow(/already using database/);

    expect(database.resetRows).not.toHaveBeenCalled();
    expect(dependencies.createRunRoot).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalledOnce();
  });
});

describe("isolated E2E lifecycle", () => {
  it("uses isolated paths, migrates, runs Playwright, then cleans rows and directories", async () => {
    const database = fakeDatabase();
    const dependencies = fakeDependencies(database);
    const source = {
      PIWORK_E2E_DATABASE_URL: "postgres://localhost/piwork_e2e",
      PIWORK_E2E_REUSE_SERVER: "1",
      PIWORK_DATA_ROOT: "/unsafe/data",
      PIWORK_HOME: "/unsafe/home",
    };

    await runBetterAuthE2E(source, dependencies);

    expect(database.resetRows).toHaveBeenCalledTimes(2);
    expect(dependencies.prepareRunDirectories).toHaveBeenCalledWith(
      runtimePaths("/tmp/piwork-e2e-test-run"),
    );
    expect(dependencies.runStep).toHaveBeenCalledTimes(e2eSteps.length);
    expect(vi.mocked(dependencies.runStep).mock.calls.map(([step]) => step.label)).toEqual(
      e2eSteps.map((step) => step.label),
    );
    const childEnv = vi.mocked(dependencies.runStep).mock.calls[0][1];
    expect(childEnv).toMatchObject({
      NODE_ENV: "test",
      DATABASE_URL: source.PIWORK_E2E_DATABASE_URL,
      PIWORK_E2E_REUSE_SERVER: "0",
      PIWORK_DATA_ROOT: "/tmp/piwork-e2e-test-run/data",
      PIWORK_HOME: "/tmp/piwork-e2e-test-run/home",
      PIWORK_RUNNER_LOCK_PATH: "/tmp/piwork-e2e-test-run/runner.lock",
      PIWORK_MAINTENANCE_LOCK_DIR: "/tmp/piwork-e2e-test-run/maintenance-backup.lock",
    });
    expect(dependencies.removeRunRoot).toHaveBeenCalledWith("/tmp/piwork-e2e-test-run");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("cleans the database and run root after a migration or Playwright failure", async () => {
    const database = fakeDatabase();
    const dependencies = fakeDependencies(database);
    vi.mocked(dependencies.runStep).mockRejectedValueOnce(new Error("playwright failed"));

    await expect(
      runBetterAuthE2E(
        { PIWORK_E2E_DATABASE_URL: "postgres://localhost/piwork_e2e" },
        dependencies,
      ),
    ).rejects.toThrow("playwright failed");
    expect(database.resetRows).toHaveBeenCalledTimes(2);
    expect(database.close).toHaveBeenCalledOnce();
    expect(dependencies.removeRunRoot).toHaveBeenCalledOnce();
  });

  it("still closes the database and removes the run root when final row cleanup fails", async () => {
    const database = fakeDatabase();
    vi.mocked(database.resetRows)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("truncate failed"));
    const dependencies = fakeDependencies(database);

    await expect(
      runBetterAuthE2E(
        { PIWORK_E2E_DATABASE_URL: "postgres://localhost/piwork_e2e" },
        dependencies,
      ),
    ).rejects.toThrow(/database cleanup failed: truncate failed/);
    expect(database.close).toHaveBeenCalledOnce();
    expect(dependencies.removeRunRoot).toHaveBeenCalledOnce();
  });

  it("creates only data and home directories and removes the complete run root", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-e2e-runner-test-"));
    const paths = runtimePaths(root);
    defaultE2ERunnerDependencies.prepareRunDirectories(paths);
    expect(existsSync(paths.dataRoot)).toBe(true);
    expect(existsSync(paths.home)).toBe(true);
    expect(existsSync(paths.runnerLock)).toBe(false);
    expect(existsSync(paths.maintenanceLock)).toBe(false);
    defaultE2ERunnerDependencies.removeRunRoot(root);
    expect(existsSync(root)).toBe(false);
  });

  it("keeps the canonical runtime path short enough for the protected Unix socket", () => {
    const root = defaultE2ERunnerDependencies.createRunRoot();
    try {
      const socketPath = join(
        realpathSync(root),
        "data",
        ".runtime",
        `us-${process.pid}-${"a".repeat(24)}.sock`,
      );
      expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThanOrEqual(100);
    } finally {
      defaultE2ERunnerDependencies.removeRunRoot(root);
    }
  });

  it("overrides unsafe ambient runtime paths", () => {
    const paths = runtimePaths("/tmp/safe-e2e");
    expect(
      buildE2EEnvironment(
        {
          DATABASE_URL: "postgres://localhost/production",
          PIWORK_RUNNER_LOCK_PATH: "/unsafe/runner.lock",
        },
        "postgres://localhost/piwork_e2e",
        paths,
      ),
    ).toMatchObject({
      DATABASE_URL: "postgres://localhost/piwork_e2e",
      PIWORK_RUNNER_LOCK_PATH: paths.runnerLock,
      PIWORK_MAINTENANCE_LOCK_DIR: paths.maintenanceLock,
    });
  });
});

describe("PostgreSQL and child-process adapters", () => {
  it("holds one advisory-locked connection and truncates every non-system table", async () => {
    const sql: string[] = [];
    const client = {
      async query<Row extends Record<string, unknown>>(statement: string) {
        sql.push(statement.replace(/\s+/g, " ").trim());
        if (statement.includes("current_database")) {
          return { rows: [{ database_name: "piwork_e2e" }] as unknown as Row[] };
        }
        if (statement.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] as unknown as Row[] };
        }
        if (statement.includes("string_agg")) {
          return {
            rows: [{ qualified_tables: 'public."user", public.session' }] as unknown as Row[],
          };
        }
        return { rows: [] as Row[] };
      },
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const database = await connectE2EDatabase("postgres://localhost/piwork_e2e", () => pool);

    expect(await database.currentDatabaseName()).toBe("piwork_e2e");
    expect(await database.acquireRunLock()).toBe(true);
    await database.resetRows();
    await database.close();
    await database.close();

    expect(sql).toContain('truncate table public."user", public.session restart identity cascade');
    expect(sql).toContain("commit");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rolls back a failed truncate and closes a pool whose initial connection fails", async () => {
    const sql: string[] = [];
    const client = {
      async query<Row extends Record<string, unknown>>(statement: string) {
        sql.push(statement);
        if (statement.includes("string_agg")) throw new Error("catalog failed");
        return { rows: [] as Row[] };
      },
      release: vi.fn(),
    };
    const database = await connectE2EDatabase("postgres://localhost/piwork_e2e", () => ({
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    }));
    await expect(database.resetRows()).rejects.toThrow("catalog failed");
    expect(sql).toContain("rollback");
    await database.close();

    const end = vi.fn(async () => undefined);
    await expect(
      connectE2EDatabase("postgres://localhost/piwork_e2e", () => ({
        connect: vi.fn(async () => {
          throw new Error("connect failed");
        }),
        end,
      })),
    ).rejects.toThrow("connect failed");
    expect(end).toHaveBeenCalledOnce();
  });

  it("propagates Bun child exit failures", async () => {
    await runBunStep({ label: "passing probe", args: ["-e", "process.exit(0)"] }, process.env);
    await expect(
      runBunStep({ label: "failing probe", args: ["-e", "process.exit(7)"] }, process.env),
    ).rejects.toThrow("failing probe failed with exit code 7");
  });
});
