import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRunnerLock } from "./runner-lock.js";

describe("runner/maintenance lock exclusion", () => {
  const root = join(tmpdir(), `piwork-lock-${process.pid}-${Date.now()}`);
  const runnerPath = join(root, "runner.lock");
  const maintenancePath = join(root, "maintenance.lock");
  let previousRunner: string | undefined;
  let previousMaintenance: string | undefined;

  beforeEach(() => {
    previousRunner = process.env.PIWORK_RUNNER_LOCK_PATH;
    previousMaintenance = process.env.PIWORK_MAINTENANCE_LOCK_DIR;
    process.env.PIWORK_RUNNER_LOCK_PATH = runnerPath;
    process.env.PIWORK_MAINTENANCE_LOCK_DIR = maintenancePath;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (previousRunner === undefined) delete process.env.PIWORK_RUNNER_LOCK_PATH;
    else process.env.PIWORK_RUNNER_LOCK_PATH = previousRunner;
    if (previousMaintenance === undefined) delete process.env.PIWORK_MAINTENANCE_LOCK_DIR;
    else process.env.PIWORK_MAINTENANCE_LOCK_DIR = previousMaintenance;
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a writer while maintenance owns the lock", () => {
    mkdirSync(maintenancePath, { recursive: true });
    expect(() => acquireRunnerLock()).toThrow("maintenance lock is active");
  });

  it("owns one writer lock until release", () => {
    const lock = acquireRunnerLock();
    expect(lock).not.toBeNull();
    expect(() => acquireRunnerLock()).toThrow("runner lock is active");
    lock?.release();
    const next = acquireRunnerLock();
    expect(next?.release).toBeTypeOf("function");
    next?.release();
  });
});
