import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPathInside } from "./path-scope.js";

export interface PiSessionLayout {
  sessionRoot: string;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
  piConfigDir: string;
  piRuntimeConfigDir: string;
  piSessionsDir: string;
  piResourcesDir: string;
  managedSkillsDir: string;
  recordingsDir: string;
  userSpaceCheckoutsDir: string;
  sessionJsonPath: string;
}

const FIXED_DIRECTORIES = [
  "workspace",
  "home",
  "tmp",
  "pi-config",
  "pi-sessions",
  "recordings",
  "user-space-checkouts",
] as const;

function prospectiveCanonicalPath(path: string): string {
  let cursor = path;
  const missing: string[] = [];
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`Pi runtime path must not traverse symbolic links: ${path}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Pi runtime path has a non-directory ancestor: ${path}`);
      }
      return resolve(realpathSync(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function ensureRealDirectory(path: string, root?: string, preserveSealedMode = false): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Pi runtime path must be a real directory: ${path}`);
  }
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error(`Pi runtime path must not be redirected: ${path}`);
  }
  if (root && !isPathInside(root, canonical)) {
    throw new Error(`Pi runtime path escapes the session root: ${path}`);
  }
  if (!preserveSealedMode || (before.mode & 0o222) !== 0) {
    chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function preparePiSessionLayout(sessionRoot: string): PiSessionLayout {
  if (!isAbsolute(sessionRoot) || sessionRoot.includes("\0")) {
    throw new Error("Pi session root must be absolute");
  }
  const requested = resolve(sessionRoot);
  if (dirname(requested) === requested) {
    throw new Error("Pi session root must not be the filesystem root");
  }
  if (prospectiveCanonicalPath(requested) !== requested) {
    throw new Error("Pi session root must not traverse symbolic-link aliases");
  }
  const parent = dirname(requested);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(parent);
  if (canonicalParent !== parent) {
    throw new Error("Pi session root parent must not be redirected");
  }
  const canonicalRoot = ensureRealDirectory(requested);
  if (canonicalRoot !== requested) {
    throw new Error("Pi session root must not be redirected");
  }

  const directories = new Map<string, string>();
  for (const name of FIXED_DIRECTORIES) {
    directories.set(name, ensureRealDirectory(join(canonicalRoot, name), canonicalRoot));
  }
  const piResourcesDir = ensureRealDirectory(
    join(directories.get("pi-config")!, "piwork-resources"),
    canonicalRoot,
    true,
  );
  const piRuntimeConfigDir = ensureRealDirectory(
    join(directories.get("pi-config")!, "runtime"),
    canonicalRoot,
  );
  const managedSkillsDir = ensureRealDirectory(join(piResourcesDir, "skills"), canonicalRoot, true);
  return {
    sessionRoot: canonicalRoot,
    workspaceDir: directories.get("workspace")!,
    homeDir: directories.get("home")!,
    tmpDir: directories.get("tmp")!,
    piConfigDir: directories.get("pi-config")!,
    piRuntimeConfigDir,
    piSessionsDir: directories.get("pi-sessions")!,
    piResourcesDir,
    managedSkillsDir,
    recordingsDir: directories.get("recordings")!,
    userSpaceCheckoutsDir: directories.get("user-space-checkouts")!,
    sessionJsonPath: join(canonicalRoot, "session.json"),
  };
}

function readFirstLfFrame(fd: number, maxBytes = 64 * 1024): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, maxBytes + 1 - total));
    const bytes = readSync(fd, chunk, 0, chunk.length, null);
    if (bytes === 0) break;
    const value = chunk.subarray(0, bytes);
    const lf = value.indexOf(0x0a);
    if (lf >= 0) {
      chunks.push(value.subarray(0, lf));
      total += lf;
      const frame = Buffer.concat(chunks, total);
      if (frame.at(-1) === 0x0d) {
        throw new Error("Pi session JSONL header must use strict LF framing; CRLF is not accepted");
      }
      return frame.toString("utf8");
    }
    chunks.push(value);
    total += value.length;
  }
  if (total > maxBytes) throw new Error("Pi session header exceeds the frame limit");
  throw new Error("Pi session JSONL header must end with LF");
}

function canonicalExpectedCwd(expectedCwd: string): string {
  if (!isAbsolute(expectedCwd) || expectedCwd.includes("\0")) {
    throw new Error("Expected Pi session cwd must be absolute");
  }
  const normalizedCwd = resolve(expectedCwd);
  const cwdInfo = lstatSync(normalizedCwd);
  const canonicalCwd = realpathSync(normalizedCwd);
  if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink() || canonicalCwd !== normalizedCwd) {
    throw new Error("Expected Pi session cwd must be a canonical real directory");
  }
  return canonicalCwd;
}

/**
 * Resolve an exact Pi v3 JSONL file owned by this session.
 *
 * The direct-child rule intentionally rejects Pi's global/default session
 * lookup shapes and prevents a partial id from selecting another conversation.
 */
export function resolvePiResumeFile(
  layout: PiSessionLayout,
  candidate: string,
  expectedCwd = layout.workspaceDir,
): string {
  if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error("Pi resume path must be an absolute JSONL path");
  }
  const normalized = resolve(candidate);
  if (
    dirname(normalized) !== layout.piSessionsDir ||
    !normalized.endsWith(".jsonl") ||
    relative(layout.piSessionsDir, normalized).includes("..")
  ) {
    throw new Error(
      "Pi resume file must be a direct child of this session's pi-sessions directory",
    );
  }

  const canonicalCwd = canonicalExpectedCwd(expectedCwd);

  let fd: number | undefined;
  try {
    fd = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Pi resume file must be regular");
    const canonical = realpathSync(normalized);
    if (canonical !== normalized || !isPathInside(layout.piSessionsDir, canonical)) {
      throw new Error("Pi resume file escaped the session directory");
    }
    const first = readFirstLfFrame(fd);
    const header: unknown = JSON.parse(first);
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      throw new Error("Invalid Pi session header");
    }
    const record = header as Record<string, unknown>;
    if (
      record.type !== "session" ||
      record.version !== 3 ||
      typeof record.id !== "string" ||
      !record.id
    ) {
      throw new Error("Only Pi v3 JSONL sessions can be resumed");
    }
    if (
      typeof record.cwd !== "string" ||
      !isAbsolute(record.cwd) ||
      record.cwd.includes("\0") ||
      resolve(record.cwd) !== canonicalCwd
    ) {
      throw new Error("Pi session cwd does not match this launch working directory");
    }
    return canonical;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create (or recover after an interrupted launch) the exact Pi v3 JSONL file
 * for a product session. Native Pi intentionally delays creating a
 * --session-id file until the first assistant message; Piwork needs a stable
 * source-of-truth path before exposing the runtime as ready, so it initializes
 * only Pi's canonical header and then lets Pi own every subsequent entry.
 */
export function ensurePiSessionFile(
  layout: PiSessionLayout,
  sessionId: string,
  expectedCwd = layout.workspaceDir,
): string {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Invalid Pi session id");
  const canonicalCwd = canonicalExpectedCwd(expectedCwd);
  const path = join(layout.piSessionsDir, `${sessionId.toLowerCase()}.jsonl`);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(
      fd,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId.toLowerCase(),
        timestamp: new Date().toISOString(),
        cwd: canonicalCwd,
      })}\n`,
      "utf8",
    );
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return resolvePiResumeFile(layout, path, canonicalCwd);
}

export function assertPiSessionFileFromState(
  layout: PiSessionLayout,
  sessionFile: unknown,
  expectedCwd = layout.workspaceDir,
): string {
  if (typeof sessionFile !== "string") throw new Error("Pi did not report a session file");
  return resolvePiResumeFile(layout, sessionFile, expectedCwd);
}
