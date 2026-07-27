import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, environment } from "./environment.js";
import { requireSessionId } from "./path-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

export const PI_SESSION_DIRECTORY_NAMES = Object.freeze([
  "workspace",
  "home",
  "tmp",
  "pi-config",
  "pi-sessions",
  "recordings",
  "user-space-checkouts",
] as const);

export interface PiSessionPaths {
  root: string;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
  piConfigDir: string;
  piSessionsDir: string;
  recordingsDir: string;
  userSpaceCheckoutsDir: string;
  sessionFile: string;
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return existsSync(path) ? realpathSync(path) : path;
}

function cleanUserId(value: string): string {
  const userId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    throw new Error(`Invalid user id: ${value}`);
  }
  return userId;
}

export function requireTenantId(value: string): string {
  const tenantId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new Error(`Invalid tenant id: ${value}`);
  return tenantId;
}

export function getLocalDataRoot(): string {
  const configured = environment.optionalString(ENV.PIWORK_DATA_ROOT, false)?.trim();
  return ensureDir(resolve(configured || join(repoRoot, "data")));
}

export function getUserDataRoot(uuid: string): string {
  const expected = join(getLocalDataRoot(), cleanUserId(uuid));
  mkdirSync(expected, { recursive: true, mode: 0o700 });
  const actual = realpathSync(expected);
  if (actual !== expected) {
    throw new Error(`User data root must not be a symbolic link: ${uuid}`);
  }
  try {
    chmodSync(actual, 0o700);
  } catch {}
  return actual;
}

export function getTenantsDataRoot(): string {
  return ensureDir(join(getLocalDataRoot(), "tenants"));
}

export function getTenantDataRoot(tenantId: string): string {
  const expected = join(getTenantsDataRoot(), requireTenantId(tenantId));
  mkdirSync(expected, { recursive: true, mode: 0o700 });
  const actual = realpathSync(expected);
  if (actual !== expected)
    throw new Error(`Tenant data root must not be a symbolic link: ${tenantId}`);
  return actual;
}

export function getTenantUserDataRoot(tenantId: string, uuid: string): string {
  const expected = join(getTenantDataRoot(tenantId), "users", cleanUserId(uuid));
  mkdirSync(expected, { recursive: true, mode: 0o700 });
  const actual = realpathSync(expected);
  if (actual !== expected) throw new Error(`Tenant user root must not be a symbolic link: ${uuid}`);
  return actual;
}

export function getTenantSessionDir(tenantId: string, uuid: string, sessionId: string): string {
  return join(getTenantUserDataRoot(tenantId, uuid), "sessions", requireSessionId(sessionId));
}

export function getTenantKnowledgeRoot(tenantId: string, knowledgeRootId: string): string {
  return join(getTenantDataRoot(tenantId), "knowledge", requireTenantId(knowledgeRootId));
}

export function resolveTenantKnowledgePath(tenantId: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid tenant knowledge path.");
  }
  const root = join(getTenantDataRoot(tenantId), "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = resolve(root, relativePath);
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = realpathSync(target);
  if (!canonicalTarget.startsWith(`${canonicalRoot}/`))
    throw new Error("Knowledge path escapes tenant root.");
  return canonicalTarget;
}

export function getUserProfilePath(uuid: string): string {
  return join(getUserDataRoot(uuid), "profile.json");
}

export function getUserPreferencesPath(uuid: string): string {
  return join(getUserDataRoot(uuid), "preferences.json");
}

export function getUserSpaceStatePath(uuid: string): string {
  return join(getUserDataRoot(uuid), "workspace-state.json");
}

export function getSessionDir(uuid: string, sessionId: string): string {
  const expected = join(getUserDataRoot(uuid), requireSessionId(sessionId));
  try {
    const stat = lstatSync(expected);
    if (stat.isSymbolicLink() || realpathSync(expected) !== expected) {
      throw new Error(`Session directory must not be a symbolic link: ${sessionId}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Session path must be a directory: ${sessionId}`);
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : "";
    if (code !== "ENOENT") throw error;
  }
  return expected;
}

export function getSessionFilePath(uuid: string, sessionId: string): string {
  return join(getSessionDir(uuid, sessionId), "session.json");
}

/**
 * Returns the fixed Pi v1 session layout without creating any of its children.
 * Callers that own session preparation decide when those directories are
 * created and which permissions apply.
 */
export function getPiSessionPaths(sessionRoot: string): PiSessionPaths {
  const root = resolve(sessionRoot);
  return {
    root,
    workspaceDir: join(root, "workspace"),
    homeDir: join(root, "home"),
    tmpDir: join(root, "tmp"),
    piConfigDir: join(root, "pi-config"),
    piSessionsDir: join(root, "pi-sessions"),
    recordingsDir: join(root, "recordings"),
    userSpaceCheckoutsDir: join(root, "user-space-checkouts"),
    sessionFile: join(root, "session.json"),
  };
}

export function getUserPiSessionPaths(uuid: string, sessionId: string): PiSessionPaths {
  return getPiSessionPaths(getSessionDir(uuid, sessionId));
}

export function getTenantPiSessionPaths(
  tenantId: string,
  uuid: string,
  sessionId: string,
): PiSessionPaths {
  return getPiSessionPaths(getTenantSessionDir(tenantId, uuid, sessionId));
}

export function getUserPiResourcesRoot(uuid: string): string {
  return join(getUserDataRoot(uuid), "pi-resources");
}

export function getUserPiSkillsRoot(uuid: string): string {
  return join(getUserPiResourcesRoot(uuid), "skills");
}

export function getTenantUserPiResourcesRoot(tenantId: string, uuid: string): string {
  return join(getTenantUserDataRoot(tenantId, uuid), "pi-resources");
}

export function getTenantUserPiSkillsRoot(tenantId: string, uuid: string): string {
  return join(getTenantUserPiResourcesRoot(tenantId, uuid), "skills");
}
