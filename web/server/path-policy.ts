import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  createDirectoryByDirFd,
  deleteEntryByDirFd,
  ensureDirectoryByDirFd,
  listDirectoryByDirFd,
  PosixDirFdError,
  readFileByDirFd,
  renameEntryByDirFdNoReplace,
  statEntryByDirFd,
  withPinnedDirectoryByDirFd,
  writeFileByDirFd,
  type PosixDirectoryEntry,
  type PosixEntryIdentity,
  type PosixEntryInspection,
  type PosixEntryStat,
  type PinnedDirectoryByDirFd,
} from "./posix-dirfd.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const ENCODED_PATH_SYNTAX = /%[0-9a-f]{2}/i;
const PROTECTED_RUNTIME_ROOT_SEGMENTS = new Set([
  ".operations",
  ".quarantine",
  "pi-resources",
  "profile",
  "recordings",
  "user-space-checkouts",
]);

// These files are application authority/state, not user-authored workspace
// content.  The generic browser filesystem API must never be able to read or
// replace them: several are consumed on the next runtime start and therefore
// turn a seemingly local file edit into a privileged server operation.
const PROTECTED_RUNTIME_FILES = new Set([
  "preferences.json",
  "profile.json",
  "session.json",
  "workspace-state.json",
]);
const PRIVATE_SESSION_SEGMENTS = new Set([
  "home",
  "tmp",
  "pi-config",
  "pi-sessions",
  "recordings",
  "user-space-checkouts",
]);

function isProtectedRuntimeFileComponent(component: string): boolean {
  for (const protectedName of PROTECTED_RUNTIME_FILES) {
    if (component === protectedName) return true;
    // AtomicJsonStore and the reconciler create dot-prefixed temporary files,
    // backups, corrupt quarantines, and recovery copies next to the authority
    // file. Treat every such derivative as equally private.
    if (component.startsWith(`${protectedName}.`) || component.startsWith(`.${protectedName}.`)) {
      return true;
    }
  }
  return false;
}

export class PathPolicyError extends Error {
  readonly status: 400 | 403;

  constructor(message: string, status: 400 | 403 = 400) {
    super(message);
    this.name = "PathPolicyError";
    this.status = status;
  }
}

/**
 * Validate the application-owned session directory segment.
 *
 * Route parameters have normally been URL-decoded once by Hono. Rejecting any
 * remaining percent escape also rejects double-encoded separators/traversal.
 */
export function requireSessionId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    ENCODED_PATH_SYNTAX.test(value) ||
    !SESSION_ID_PATTERN.test(value)
  ) {
    throw new PathPolicyError("Invalid session id");
  }
  return value;
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativePathComponents(path: string, root: string): string[] | null {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!isPathInside(absoluteRoot, absolutePath)) return null;
  const rel = relative(absoluteRoot, absolutePath);
  return rel
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((component) => component.toLowerCase());
}

function containsProtectedSessionEntry(components: string[], sessionIndex: number): boolean {
  const entry = components[sessionIndex + 1];
  if (!entry) return false;
  return (
    PROTECTED_RUNTIME_ROOT_SEGMENTS.has(entry) ||
    PRIVATE_SESSION_SEGMENTS.has(entry) ||
    isProtectedRuntimeFileComponent(entry)
  );
}

function containsProtectedRelativePath(components: string[]): boolean {
  const first = components[0];
  if (!first) return false;

  // Product authority and managed Pi resources live directly under a user root.
  if (PROTECTED_RUNTIME_ROOT_SEGMENTS.has(first) || isProtectedRuntimeFileComponent(first)) {
    return true;
  }

  // Tenant layout: profile state and the sessions registry are nested once
  // below the tenant-user root.
  if (first === "sessions") {
    const registryEntry = components[1];
    if (!registryEntry) return false;
    if (
      registryEntry === ".operations" ||
      registryEntry === ".quarantine" ||
      isProtectedRuntimeFileComponent(registryEntry)
    ) {
      return true;
    }
    return containsProtectedSessionEntry(components, 1);
  }

  // Local layout: session directories live directly under the user root.
  return containsProtectedSessionEntry(components, 0);
}

/**
 * Pi configuration, JSONL history, managed resources, recordings, and product
 * authority stay outside the generic browser filesystem surface. Compare path
 * components case-insensitively so this remains fail-closed on
 * case-insensitive filesystems.
 */
export function containsProtectedRuntimePath(
  path: string,
  allowedRoots: readonly string[],
): boolean {
  return allowedRoots.some((root) => {
    for (const candidateRoot of new Set([resolve(root), canonicalRoot(root)])) {
      const components = relativePathComponents(path, candidateRoot);
      if (components && containsProtectedRelativePath(components)) return true;
    }
    return false;
  });
}

function nearestExistingPath(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

function canonicalRoot(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** Compare a candidate to a root after resolving its nearest existing
 * ancestor. Unlike resolveScopedPath, the candidate need not be lexically
 * nested under the root, so this also detects in-root symlink aliases. */
export function isCanonicalPathInside(root: string, candidate: string): boolean {
  const absolute = resolve(candidate);
  const existing = nearestExistingPath(absolute);
  try {
    const canonicalCandidate = resolve(realpathSync(existing), relative(existing, absolute));
    return isPathInside(canonicalRoot(root), canonicalCandidate);
  } catch {
    return false;
  }
}

/**
 * Resolve a host path only when both its lexical location and its nearest
 * existing ancestor remain under an authorized root. The second check closes
 * the common symlink-parent escape for both existing files and new writes.
 */
export function resolveScopedPath(rawPath: string, allowedRoots: readonly string[]): string | null {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    ENCODED_PATH_SYNTAX.test(rawPath)
  ) {
    return null;
  }

  const absolute = resolve(rawPath);
  const roots = allowedRoots.map((root) => ({
    lexical: resolve(root),
    canonical: canonicalRoot(root),
  }));
  if (!roots.some((root) => isPathInside(root.lexical, absolute))) return null;

  const existing = nearestExistingPath(absolute);
  if (!existsSync(existing)) return null;
  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync(existing);
  } catch {
    return null;
  }
  const canonicalCandidate = resolve(canonicalExisting, relative(existing, absolute));
  return roots.some((root) => isPathInside(root.canonical, canonicalCandidate)) ? absolute : null;
}

/** Resolve a generic browser path while excluding protected runtime trees,
 * including paths that reach one through an in-root symlink alias. */
export function resolveUnprotectedScopedPath(
  rawPath: string,
  allowedRoots: readonly string[],
): string | null {
  if (containsProtectedRuntimePath(rawPath, allowedRoots)) return null;
  const scoped = resolveScopedPath(rawPath, allowedRoots);
  if (!scoped) return null;
  const existing = nearestExistingPath(scoped);
  try {
    const canonicalCandidate = resolve(realpathSync(existing), relative(existing, scoped));
    return containsProtectedRuntimePath(canonicalCandidate, allowedRoots) ? null : scoped;
  } catch {
    return null;
  }
}

function translateDirFdError(error: unknown): never {
  if (!(error instanceof PosixDirFdError)) throw error;
  const translated = new PathPolicyError(error.message, error.status);
  if (error.code) Object.assign(translated, { code: error.code });
  throw translated;
}

/**
 * Create a directory one component at a time beneath a pinned canonical root
 * descriptor. Every existing component is opened with O_NOFOLLOW|O_DIRECTORY,
 * and new components are created with mkdirat before being opened the same way.
 */
export async function ensureScopedDirectoryNoSymlink(
  rawPath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  try {
    return ensureDirectoryByDirFd(rawPath, allowedRoots);
  } catch (error) {
    translateDirFdError(error);
  }
}

/**
 * Write through a leaf descriptor opened relative to a pinned parent
 * descriptor. No pathname is reopened after the root walk.
 */
export async function writeScopedFileNoFollow(
  rawPath: string,
  content: string | Uint8Array,
  allowedRoots: readonly string[],
  options: { exclusive?: boolean } = {},
): Promise<void> {
  try {
    writeFileByDirFd(rawPath, content, allowedRoots, options);
  } catch (error) {
    translateDirFdError(error);
  }
}

export interface ScopedFileSnapshot {
  bytes: Uint8Array;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** Read a regular file and its metadata through one descriptor opened relative
 * to its already-pinned parent descriptor. */
export async function readScopedFileSnapshotNoFollow(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { maxBytes?: number } = {},
): Promise<ScopedFileSnapshot> {
  try {
    return readFileByDirFd(rawPath, allowedRoots, options);
  } catch (error) {
    translateDirFdError(error);
  }
}

export type ScopedEntryStat = PosixEntryStat;
export type ScopedDirectoryEntry = PosixDirectoryEntry;

export async function createScopedDirectoryNoSymlink(
  rawPath: string,
  allowedRoots: readonly string[],
): Promise<ScopedEntryStat> {
  try {
    return createDirectoryByDirFd(rawPath, allowedRoots);
  } catch (error) {
    translateDirFdError(error);
  }
}

export async function statScopedEntryNoFollow(
  rawPath: string,
  allowedRoots: readonly string[],
): Promise<ScopedEntryStat> {
  try {
    return statEntryByDirFd(rawPath, allowedRoots);
  } catch (error) {
    translateDirFdError(error);
  }
}

export async function listScopedDirectoryNoFollow(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { depth?: number } = {},
): Promise<ScopedDirectoryEntry[]> {
  try {
    return listDirectoryByDirFd(rawPath, allowedRoots, options);
  } catch (error) {
    translateDirFdError(error);
  }
}

export async function deleteScopedEntryNoFollow(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { recursive?: boolean } = {},
): Promise<void> {
  try {
    deleteEntryByDirFd(rawPath, allowedRoots, options);
  } catch (error) {
    translateDirFdError(error);
  }
}

export async function renameScopedEntryNoReplace(
  sourcePath: string,
  targetPath: string,
  allowedRoots: readonly string[],
): Promise<void> {
  try {
    renameEntryByDirFdNoReplace(sourcePath, targetPath, allowedRoots);
  } catch (error) {
    translateDirFdError(error);
  }
}

export type ScopedEntryIdentity = PosixEntryIdentity;
export type ScopedEntryInspection = PosixEntryInspection;

export interface PinnedScopedDirectory {
  statEntry(name: string): Promise<ScopedEntryStat | null>;
  inspectEntry(name: string): Promise<ScopedEntryInspection | null>;
  renameEntryFromPathNoReplace(
    sourcePath: string,
    targetName: string,
  ): Promise<ScopedEntryIdentity>;
  renameEntryToDirectoryNoReplace(
    sourceName: string,
    targetDirectory: PinnedScopedDirectory,
    targetName: string,
    expectedIdentity: ScopedEntryIdentity,
  ): Promise<ScopedEntryIdentity>;
  renameEntryToPathNoReplace(
    sourceName: string,
    targetPath: string,
    expectedIdentity: ScopedEntryIdentity,
  ): Promise<void>;
  matchesPath(rawPath: string): Promise<boolean>;
}

const pinnedScopedDirectoryStates = new WeakMap<PinnedScopedDirectory, PinnedDirectoryByDirFd>();

/** Keep a verified directory descriptor pinned across a multi-entry mutation. */
export async function withPinnedScopedDirectory<T>(
  rawPath: string,
  allowedRoots: readonly string[],
  operation: (directory: PinnedScopedDirectory) => Promise<T> | T,
): Promise<T> {
  try {
    return await withPinnedDirectoryByDirFd(
      rawPath,
      allowedRoots,
      async (directory: PinnedDirectoryByDirFd) => {
        const scopedDirectory: PinnedScopedDirectory = {
          async statEntry(name) {
            try {
              return directory.statEntry(name);
            } catch (error) {
              translateDirFdError(error);
            }
          },
          async inspectEntry(name) {
            try {
              return directory.inspectEntry(name);
            } catch (error) {
              translateDirFdError(error);
            }
          },
          async renameEntryFromPathNoReplace(sourcePath, targetName) {
            try {
              return directory.renameEntryFromPathNoReplace(sourcePath, targetName);
            } catch (error) {
              translateDirFdError(error);
            }
          },
          async renameEntryToDirectoryNoReplace(
            sourceName,
            targetDirectory,
            targetName,
            expectedIdentity,
          ) {
            const target = pinnedScopedDirectoryStates.get(targetDirectory);
            if (!target) {
              throw new PathPolicyError("Target pinned directory is no longer active", 403);
            }
            try {
              return directory.renameEntryToDirectoryNoReplace(
                sourceName,
                target,
                targetName,
                expectedIdentity,
              );
            } catch (error) {
              translateDirFdError(error);
            }
          },
          async renameEntryToPathNoReplace(sourceName, targetPath, expectedIdentity) {
            try {
              directory.renameEntryToPathNoReplace(sourceName, targetPath, expectedIdentity);
            } catch (error) {
              translateDirFdError(error);
            }
          },
          async matchesPath(candidatePath) {
            return directory.matchesPath(candidatePath);
          },
        };
        pinnedScopedDirectoryStates.set(scopedDirectory, directory);
        try {
          return await operation(scopedDirectory);
        } finally {
          pinnedScopedDirectoryStates.delete(scopedDirectory);
        }
      },
    );
  } catch (error) {
    translateDirFdError(error);
  }
}

/** Pin several directory identities for the lifetime of one scoped operation. */
export async function withPinnedScopedDirectories<T>(
  rawPaths: readonly string[],
  allowedRoots: readonly string[],
  operation: (directories: readonly PinnedScopedDirectory[]) => Promise<T> | T,
): Promise<T> {
  const directories: PinnedScopedDirectory[] = [];
  const visit = async (index: number): Promise<T> => {
    if (index >= rawPaths.length) return operation(directories);
    return withPinnedScopedDirectory(rawPaths[index]!, allowedRoots, async (directory) => {
      directories.push(directory);
      try {
        return await visit(index + 1);
      } finally {
        directories.pop();
      }
    });
  };
  return visit(0);
}

/** Convenience wrapper for callers that only need the immutable byte snapshot. */
export async function readScopedFileNoFollow(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { maxBytes?: number } = {},
): Promise<Uint8Array> {
  return (await readScopedFileSnapshotNoFollow(rawPath, allowedRoots, options)).bytes;
}
