import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const E2E_DATABASE_ENV = "PIWORK_E2E_DATABASE_URL";
const E2E_ADVISORY_LOCK = "piwork-better-auth-e2e";

export interface E2ERuntimePaths {
  root: string;
  dataRoot: string;
  home: string;
  runnerLock: string;
  maintenanceLock: string;
}

export interface E2EDatabase {
  currentDatabaseName(): Promise<string>;
  acquireRunLock(): Promise<boolean>;
  resetRows(): Promise<void>;
  close(): Promise<void>;
}

export interface E2EStep {
  label: string;
  args: string[];
}

export interface E2ERunnerDependencies {
  connect(databaseUrl: string): Promise<E2EDatabase>;
  createRunRoot(): string;
  prepareRunDirectories(paths: E2ERuntimePaths): void;
  removeRunRoot(root: string): void;
  runStep(step: E2EStep, env: NodeJS.ProcessEnv): Promise<void>;
}

interface QueryResultLike<Row> {
  rows: Row[];
}

interface PgClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<QueryResultLike<Row>>;
  release(destroy?: boolean): void;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

type PgPoolFactory = (databaseUrl: string) => PgPoolLike;

export const e2eSteps: readonly E2EStep[] = [
  {
    label: "Better Auth migration",
    // Use Better Auth's installed programmatic migration API so the frozen E2E
    // path never performs an implicit package install at runtime.
    args: [
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
  },
  {
    label: "RBAC migration",
    args: ["scripts/apply-rbac-migration.ts"],
  },
  {
    label: "control-plane migration",
    args: ["scripts/apply-control-plane-migration.ts"],
  },
  {
    label: "Playwright Better Auth E2E",
    args: ["run", "playwright", "test"],
  },
];

export function isDedicatedE2EDatabaseName(name: string): boolean {
  return /(?:^|[_-])e2e(?:$|[_-])/i.test(name);
}

export function databaseNameFromE2EUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`${E2E_DATABASE_ENV} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${E2E_DATABASE_ENV} must use postgres:// or postgresql://`);
  }
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error(`${E2E_DATABASE_ENV} contains an invalid encoded database name`);
  }
  if (!databaseName || databaseName.includes("/")) {
    throw new Error(`${E2E_DATABASE_ENV} must name exactly one PostgreSQL database`);
  }
  if (!isDedicatedE2EDatabaseName(databaseName)) {
    throw new Error(
      `${E2E_DATABASE_ENV} must target a dedicated database whose name contains a standalone e2e segment`,
    );
  }
  return databaseName;
}

export function runtimePaths(root: string): E2ERuntimePaths {
  return {
    root,
    dataRoot: join(root, "data"),
    home: join(root, "home"),
    runnerLock: join(root, "runner.lock"),
    maintenanceLock: join(root, "maintenance-backup.lock"),
  };
}

export function buildE2EEnvironment(
  source: NodeJS.ProcessEnv,
  databaseUrl: string,
  paths: E2ERuntimePaths,
): NodeJS.ProcessEnv {
  return {
    ...source,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    PIWORK_RUNTIME_MODE: "local",
    PIWORK_SERVE_FRONTEND: "0",
    PIWORK_RECORD: "0",
    PIWORK_E2E_REUSE_SERVER: "0",
    PIWORK_DATA_ROOT: paths.dataRoot,
    PIWORK_HOME: paths.home,
    PIWORK_RUNNER_LOCK_PATH: paths.runnerLock,
    PIWORK_MAINTENANCE_LOCK_DIR: paths.maintenanceLock,
  };
}

export async function connectE2EDatabase(
  databaseUrl: string,
  createPool: PgPoolFactory = (url) =>
    new Pool({ connectionString: url, max: 1 }) as unknown as PgPoolLike,
): Promise<E2EDatabase> {
  const pool = createPool(databaseUrl);
  let client: PgClientLike;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  let closed = false;

  return {
    async currentDatabaseName() {
      const result = await client.query<{ database_name: string }>(
        "select current_database() as database_name",
      );
      const name = result.rows[0]?.database_name;
      if (!name) throw new Error("PostgreSQL did not report current_database()");
      return name;
    },
    async acquireRunLock() {
      const result = await client.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtextextended('${E2E_ADVISORY_LOCK}', 0)) as acquired`,
      );
      return result.rows[0]?.acquired === true;
    },
    async resetRows() {
      await client.query("begin");
      try {
        await client.query("set local lock_timeout = '10s'");
        const result = await client.query<{ qualified_tables: string | null }>(`
          select string_agg(
            format('%I.%I', schemaname, tablename),
            ', ' order by schemaname, tablename
          ) as qualified_tables
          from pg_tables
          where schemaname <> 'information_schema'
            and schemaname not like 'pg_%'
        `);
        const qualifiedTables = result.rows[0]?.qualified_tables;
        if (qualifiedTables) {
          await client.query(`truncate table ${qualifiedTables} restart identity cascade`);
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      client.release(true);
      await pool.end();
    },
  };
}

export async function runBunStep(
  step: E2EStep,
  env: NodeJS.ProcessEnv,
  options: { executable?: string; cwd?: string } = {},
): Promise<void> {
  const executable = options.executable || process.execPath;
  const cwd = options.cwd || webRoot;
  await new Promise<void>((resolveStep, rejectStep) => {
    const child = spawn(executable, step.args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.once("error", rejectStep);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }
      rejectStep(
        new Error(
          `${step.label} failed ${signal ? `with signal ${signal}` : `with exit code ${code ?? 1}`}`,
        ),
      );
    });
  });
}

export const defaultE2ERunnerDependencies: E2ERunnerDependencies = {
  connect: connectE2EDatabase,
  // macOS reports a long per-user tmpdir. Its canonical path plus the
  // protected User Space socket name can exceed sockaddr_un.sun_path.
  createRunRoot: () => mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "nxe-")),
  prepareRunDirectories(paths) {
    for (const path of [paths.dataRoot, paths.home]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
  },
  removeRunRoot: (root) => rmSync(root, { recursive: true, force: true }),
  runStep: runBunStep,
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function appendFailure(current: Error | null, next: unknown, label: string): Error {
  const error = asError(next);
  const labeled = new Error(`${label}: ${error.message}`, { cause: error });
  if (!current) return labeled;
  return new AggregateError([current, labeled], "E2E execution and cleanup both failed");
}

export async function runBetterAuthE2E(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  dependencies: E2ERunnerDependencies = defaultE2ERunnerDependencies,
): Promise<void> {
  const databaseUrl = sourceEnv[E2E_DATABASE_ENV]?.trim();
  if (!databaseUrl) {
    throw new Error(
      `${E2E_DATABASE_ENV} is required; DATABASE_URL is intentionally not accepted for E2E`,
    );
  }
  const expectedDatabaseName = databaseNameFromE2EUrl(databaseUrl);
  let database: E2EDatabase | null = null;
  let ownsDatabase = false;
  let runRoot: string | null = null;
  let failure: Error | null = null;

  try {
    database = await dependencies.connect(databaseUrl);
    const actualDatabaseName = await database.currentDatabaseName();
    if (
      actualDatabaseName !== expectedDatabaseName ||
      !isDedicatedE2EDatabaseName(actualDatabaseName)
    ) {
      throw new Error(
        `Connected database ${JSON.stringify(actualDatabaseName)} does not match the dedicated E2E database in ${E2E_DATABASE_ENV}`,
      );
    }
    if (!(await database.acquireRunLock())) {
      throw new Error(`Another Piwork E2E run is already using database ${actualDatabaseName}`);
    }
    ownsDatabase = true;

    runRoot = dependencies.createRunRoot();
    const paths = runtimePaths(runRoot);
    dependencies.prepareRunDirectories(paths);
    const childEnv = buildE2EEnvironment(sourceEnv, databaseUrl, paths);

    await database.resetRows();
    for (const step of e2eSteps) await dependencies.runStep(step, childEnv);
  } catch (error) {
    failure = asError(error);
  } finally {
    if (database && ownsDatabase) {
      try {
        await database.resetRows();
      } catch (error) {
        failure = appendFailure(failure, error, "database cleanup failed");
      }
    }
    if (database) {
      try {
        await database.close();
      } catch (error) {
        failure = appendFailure(failure, error, "database connection cleanup failed");
      }
    }
    if (runRoot) {
      try {
        dependencies.removeRunRoot(runRoot);
      } catch (error) {
        failure = appendFailure(failure, error, "runtime directory cleanup failed");
      }
    }
  }

  if (failure) throw failure;
}

if (import.meta.main) {
  try {
    await runBetterAuthE2E();
  } catch (error) {
    console.error(asError(error).message);
    process.exitCode = 1;
  }
}
