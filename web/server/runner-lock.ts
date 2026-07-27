import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PIWORK_HOME } from "./paths.js";
import { ENV, environment } from "./environment.js";

interface RunnerLockPayload {
  hostName: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  version: string;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STALE_MS = 45_000;

function getLockPath(): string {
  return environment.value(ENV.PIWORK_RUNNER_LOCK_PATH) || join(PIWORK_HOME, "runner.lock");
}

function getMaintenanceLockPath(): string {
  const configured = environment.value(ENV.PIWORK_MAINTENANCE_LOCK_DIR)?.trim();
  if (configured) return resolve(configured);
  const packageRoot = environment.packageRoot || resolve(import.meta.dir, "..");
  return resolve(packageRoot, "..", ".runtime", "maintenance-backup.lock");
}

function getHostName(): string {
  return environment.value(ENV.HOSTNAME) || "local";
}

function getVersion(): string {
  return (
    environment.value(ENV.npm_package_version) || environment.value(ENV.PIWORK_VERSION) || "unknown"
  );
}

function makePayload(startedAt: number): RunnerLockPayload {
  return {
    hostName: getHostName(),
    pid: process.pid,
    startedAt,
    heartbeatAt: Date.now(),
    version: getVersion(),
  };
}

function readLock(path: string): RunnerLockPayload | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunnerLockPayload;
  } catch {
    return null;
  }
}

function isStale(lock: RunnerLockPayload | null, staleMs: number): boolean {
  if (!lock?.heartbeatAt) return true;
  return Date.now() - lock.heartbeatAt > staleMs;
}

export interface RunnerLockHandle {
  path: string;
  release(): void;
}

export function acquireRunnerLock(): RunnerLockHandle | null {
  const path = getLockPath();
  const maintenanceLockPath = getMaintenanceLockPath();
  if (existsSync(maintenanceLockPath)) {
    throw new Error(
      `Piwork maintenance lock is active at ${maintenanceLockPath}; refusing to start a writer`,
    );
  }
  const staleMs = environment.number(ENV.PIWORK_RUNNER_LOCK_STALE_MS, DEFAULT_STALE_MS);
  const heartbeatMs = environment.number(ENV.PIWORK_RUNNER_LOCK_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const existing = readLock(path);
    if (!isStale(existing, staleMs)) {
      const owner = existing ? `${existing.hostName}/${existing.pid}` : "unknown owner";
      throw new Error(
        `Piwork runner lock is active at ${path} (${owner}); refusing to start a second writer`,
      );
    }
    rmSync(path, { force: true });
  }

  const startedAt = Date.now();
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);

  // Close the check-then-create race with maintenance backup startup. If the
  // backup acquired its lock after our first check but before this writer lock,
  // it will either observe this file or we will observe its directory here.
  if (existsSync(maintenanceLockPath)) {
    rmSync(path, { force: true });
    throw new Error(
      `Piwork maintenance lock became active at ${maintenanceLockPath}; refusing to start a writer`,
    );
  }

  const writeHeartbeat = () => {
    writeFileSync(path, JSON.stringify(makePayload(startedAt), null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  };
  writeHeartbeat();
  const timer = setInterval(writeHeartbeat, heartbeatMs);
  timer.unref?.();

  return {
    path,
    release() {
      clearInterval(timer);
      rmSync(path, { force: true });
    },
  };
}
