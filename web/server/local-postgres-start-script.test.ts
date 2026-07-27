import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repoRoot, "scripts/try-start-local-postgres.sh");
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function makeMockBin(name: string, body: string) {
  const directory = await mkdtemp(resolve(tmpdir(), "piwork-postgres-start-"));
  temporaryDirectories.push(directory);
  const path = await writeMockCommand(directory, name, body);
  if (name !== "pg_isready") {
    await writeMockCommand(directory, "pg_isready", "exit 2");
  }
  return { directory, path };
}

async function writeMockCommand(directory: string, name: string, body: string) {
  const path = resolve(directory, name);
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function runScript(databaseUrl: string, env: Record<string, string> = {}) {
  try {
    const result = await execFileAsync(scriptPath, [databaseUrl], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PGDATA: "",
        PIWORK_POSTGRES_DATA_DIR: "",
        PIWORK_PG_CTL_BIN: "",
        ...env,
      },
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local Postgres startup helper", () => {
  it("requires explicit Postgres startup paths", async () => {
    const { directory } = await makeMockBin("pg_ctl", "exit 99");

    const result = await runScript("postgres://user:pass@127.0.0.1:5432/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires PIWORK_POSTGRES_DATA_DIR and PIWORK_PG_CTL_BIN");
  });

  it("does not attempt to start a service for a remote database", async () => {
    const { directory } = await makeMockBin("pg_ctl", "exit 99");

    const result = await runScript("postgres://user:pass@db.example.com:5432/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not local");
  });

  it("recognizes an IPv6 loopback database as local", async () => {
    const createdDirectory = await mkdtemp(resolve(tmpdir(), "piwork-ipv6-pgdata-"));
    temporaryDirectories.push(createdDirectory);
    const dataDirectory = await realpath(createdDirectory);
    const callsPath = resolve(dataDirectory, "calls");
    const { directory, path } = await makeMockBin("pg_ctl", `printf '%s\\n' "$*" > "${callsPath}"`);

    const result = await runScript("postgres://user:pass@[::1]:5432/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PIWORK_POSTGRES_DATA_DIR: dataDirectory,
      PIWORK_PG_CTL_BIN: path,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(callsPath, "utf8")).toContain(`-D ${dataDirectory}`);
  });

  it("does not use PGDATA or a pg_ctl discovered from PATH", async () => {
    const { directory } = await makeMockBin("pg_ctl", "exit 99");

    const result = await runScript("postgresql://localhost/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PGDATA: "/tmp/piwork-test-pgdata",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires PIWORK_POSTGRES_DATA_DIR and PIWORK_PG_CTL_BIN");
  });

  it("uses explicitly configured data and pg_ctl paths", async () => {
    const createdDirectory = await mkdtemp(resolve(tmpdir(), "piwork-custom-pgdata-"));
    temporaryDirectories.push(createdDirectory);
    const dataDirectory = await realpath(createdDirectory);
    const callsPath = resolve(dataDirectory, "pg-ctl-calls");
    const { directory, path } = await makeMockBin(
      "custom-pg-ctl",
      `printf '%s\\n' "$*" > "${callsPath}"`,
    );

    const result = await runScript("postgresql://localhost/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PIWORK_POSTGRES_DATA_DIR: dataDirectory,
      PIWORK_PG_CTL_BIN: path,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(callsPath, "utf8")).toContain(`-D ${dataDirectory}`);
  });

  it("backs up a stale postmaster.pid before retrying startup", async () => {
    const createdDirectory = await mkdtemp(resolve(tmpdir(), "piwork-stale-pgdata-"));
    temporaryDirectories.push(createdDirectory);
    const dataDirectory = await realpath(createdDirectory);
    const pidFile = resolve(dataDirectory, "postmaster.pid");
    await writeFile(pidFile, `424242\n${dataDirectory}\n1700000000\n5432\n/tmp\n*\n`);
    const callsPath = resolve(dataDirectory, "pg-ctl-calls");
    const { directory, path } = await makeMockBin(
      "pg_ctl",
      `printf '%s\\n' "$*" >> "${callsPath}"\nif [[ -f "${pidFile}" ]]; then exit 1; fi`,
    );
    await writeMockCommand(
      directory,
      "ps",
      "printf '%s\\n' '/System/Library/localspeechrecognition'",
    );

    const result = await runScript("postgresql://localhost/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PIWORK_POSTGRES_DATA_DIR: dataDirectory,
      PIWORK_PG_CTL_BIN: path,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Backing up stale Postgres lock file");
    await expect(readFile(pidFile)).rejects.toThrow();
    const backupPath = result.stdout.match(/moved to (.+)/)?.[1]?.trim();
    expect(backupPath).toBeTruthy();
    temporaryDirectories.push(backupPath!);
    expect((await readFile(callsPath, "utf8")).match(/-D /g)).toHaveLength(2);
  });

  it("never moves a lock whose PID is a Postgres process", async () => {
    const createdDirectory = await mkdtemp(resolve(tmpdir(), "piwork-live-pgdata-"));
    temporaryDirectories.push(createdDirectory);
    const dataDirectory = await realpath(createdDirectory);
    const pidFile = resolve(dataDirectory, "postmaster.pid");
    await writeFile(pidFile, `424242\n${dataDirectory}\n1700000000\n5432\n/tmp\n*\n`);
    const { directory, path } = await makeMockBin("pg_ctl", "exit 1");
    await writeMockCommand(
      directory,
      "ps",
      `printf '%s\\n' '/opt/postgresql/bin/postgres -D ${dataDirectory}'`,
    );

    const result = await runScript("postgresql://localhost/piwork", {
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      PIWORK_POSTGRES_DATA_DIR: dataDirectory,
      PIWORK_PG_CTL_BIN: path,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PID 424242 is a Postgres process");
    expect(await readFile(pidFile, "utf8")).toContain("424242");
  });
});
