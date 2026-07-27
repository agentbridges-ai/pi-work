import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import type { Pointer } from "bun:ffi";

const ENCODED_PATH_SYNTAX = /%[0-9a-f]{2}/i;
const MODE_PRIVATE_FILE = 0o600;
const MODE_PRIVATE_DIRECTORY = 0o700;

const PLATFORM_CONSTANTS =
  process.platform === "darwin"
    ? {
        atRemoveDir: 0x0080,
        closeOnExec: 0x01000000,
        renameNoReplace: 0x00000004,
        direntNameLengthOffset: 18,
        direntNameOffset: 21,
      }
    : process.platform === "linux"
      ? {
          atRemoveDir: 0x0200,
          closeOnExec: 0x00080000,
          renameNoReplace: 0x00000001,
          direntNameLengthOffset: -1,
          direntNameOffset: 19,
        }
      : null;

interface NativeFunctions {
  open(path: Uint8Array, flags: number, mode: number): number;
  openat(dirFd: number, path: Uint8Array, flags: number, mode: number): number;
  mkdirat(dirFd: number, path: Uint8Array, mode: number): number;
  unlinkat(dirFd: number, path: Uint8Array, flags: number): number;
  renameNoReplace(
    oldDirFd: number,
    oldPath: Uint8Array,
    newDirFd: number,
    newPath: Uint8Array,
    flags: number,
  ): number;
  fdopendir(fd: number): Pointer | null;
  readdir(dir: Pointer): Pointer | null;
  closedir(dir: Pointer): number;
  errno(): number;
  listNamesForTest?(fd: number): string[];
}

let nativeFunctions: NativeFunctions | null | undefined;
let bunFfi: typeof import("bun:ffi") | undefined;

function loadBunFfi(): typeof import("bun:ffi") {
  if (bunFfi) return bunFfi;
  const require = createRequire(import.meta.url);
  bunFfi = require("bun:ffi") as typeof import("bun:ffi");
  return bunFfi;
}

export class PosixDirFdError extends Error {
  readonly code?: string;
  readonly status: 400 | 403;

  constructor(message: string, options: { code?: string; status?: 400 | 403 } = {}) {
    super(message);
    this.name = "PosixDirFdError";
    this.code = options.code;
    this.status = options.status ?? 403;
  }
}

export interface PosixEntryStat {
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}

export interface PosixFileSnapshot {
  bytes: Uint8Array;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PosixDirectoryEntry extends PosixEntryStat {
  name: string;
  children?: PosixDirectoryEntry[];
}

export interface PosixEntryIdentity {
  device: number;
  inode: number;
}

export interface PosixEntryInspection {
  identity: PosixEntryIdentity;
  stat: PosixEntryStat;
}

export interface PinnedDirectoryByDirFd {
  statEntry(name: string): PosixEntryStat | null;
  inspectEntry(name: string): PosixEntryInspection | null;
  renameEntryFromPathNoReplace(sourcePath: string, targetName: string): PosixEntryIdentity;
  renameEntryToDirectoryNoReplace(
    sourceName: string,
    targetDirectory: PinnedDirectoryByDirFd,
    targetName: string,
    expectedIdentity: PosixEntryIdentity,
  ): PosixEntryIdentity;
  renameEntryToPathNoReplace(
    sourceName: string,
    targetPath: string,
    expectedIdentity: PosixEntryIdentity,
  ): void;
  matchesPath(rawPath: string): boolean;
}

interface ScopedPath {
  lexicalPath: string;
  canonicalRoot: string;
  components: string[];
}

interface OpenedParent {
  fd: number;
  leaf: string;
  scoped: ScopedPath;
}

interface OpenedEntry {
  fd: number;
  stat: PosixEntryStat;
}

interface PinnedDirectoryState {
  fd: number;
  scoped: ScopedPath;
}

const pinnedDirectoryStates = new WeakMap<PinnedDirectoryByDirFd, PinnedDirectoryState>();

/** Lower-level test seam used to deterministically swap a pathname after its
 * parent descriptor has been pinned. Production callers do not pass it. */
export interface PosixDirFdTestHooks {
  afterParentOpened?(): void;
}

function libcPath(): string | null {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform !== "linux") return null;
  if (process.arch === "x64") return "/lib/x86_64-linux-gnu/libc.so.6";
  if (process.arch === "arm64") return "/lib/aarch64-linux-gnu/libc.so.6";
  return null;
}

function loadNativeFunctions(): NativeFunctions {
  if (nativeFunctions) return nativeFunctions;
  if (nativeFunctions === null || !PLATFORM_CONSTANTS) {
    throw new PosixDirFdError("Secure POSIX directory-descriptor operations are unavailable");
  }

  const libraryPath = libcPath();
  if (!libraryPath) {
    nativeFunctions = null;
    throw new PosixDirFdError("Secure POSIX directory-descriptor operations are unavailable");
  }

  try {
    const { cc, dlopen, read } = loadBunFfi();
    const openAtWrapper = cc({
      source: new URL("./posix-dirfd-open.c", import.meta.url),
      symbols: {
        piwork_openat4: {
          args: ["i32", "ptr", "i32", "u32"],
          returns: "i32",
        },
      },
    } as const);
    if (process.platform === "darwin") {
      const library = dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
        unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
        renameatx_np: {
          args: ["i32", "ptr", "i32", "ptr", "u32"],
          returns: "i32",
        },
        fdopendir: { args: ["i32"], returns: "ptr" },
        readdir: { args: ["ptr"], returns: "ptr" },
        closedir: { args: ["ptr"], returns: "i32" },
        __error: { args: [], returns: "ptr" },
      } as const);
      nativeFunctions = {
        open: (path, flags, mode) => library.symbols.open(path, flags, mode),
        openat: (dirFd, path, flags, mode) =>
          openAtWrapper.symbols.piwork_openat4(dirFd, path, flags, mode),
        mkdirat: (dirFd, path, mode) => library.symbols.mkdirat(dirFd, path, mode),
        unlinkat: (dirFd, path, flags) => library.symbols.unlinkat(dirFd, path, flags),
        renameNoReplace: (oldDirFd, oldPath, newDirFd, newPath, flags) =>
          library.symbols.renameatx_np(oldDirFd, oldPath, newDirFd, newPath, flags),
        fdopendir: (fd) => library.symbols.fdopendir(fd),
        readdir: (dir) => library.symbols.readdir(dir),
        closedir: (dir) => library.symbols.closedir(dir),
        errno: () => {
          const pointer = library.symbols.__error();
          return pointer ? read.i32(pointer, 0) : -1;
        },
      };
    } else {
      const library = dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
        unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
        renameat2: {
          args: ["i32", "ptr", "i32", "ptr", "u32"],
          returns: "i32",
        },
        fdopendir: { args: ["i32"], returns: "ptr" },
        readdir: { args: ["ptr"], returns: "ptr" },
        closedir: { args: ["ptr"], returns: "i32" },
        __errno_location: { args: [], returns: "ptr" },
      } as const);
      nativeFunctions = {
        open: (path, flags, mode) => library.symbols.open(path, flags, mode),
        openat: (dirFd, path, flags, mode) =>
          openAtWrapper.symbols.piwork_openat4(dirFd, path, flags, mode),
        mkdirat: (dirFd, path, mode) => library.symbols.mkdirat(dirFd, path, mode),
        unlinkat: (dirFd, path, flags) => library.symbols.unlinkat(dirFd, path, flags),
        renameNoReplace: (oldDirFd, oldPath, newDirFd, newPath, flags) =>
          library.symbols.renameat2(oldDirFd, oldPath, newDirFd, newPath, flags),
        fdopendir: (fd) => library.symbols.fdopendir(fd),
        readdir: (dir) => library.symbols.readdir(dir),
        closedir: (dir) => library.symbols.closedir(dir),
        errno: () => {
          const pointer = library.symbols.__errno_location();
          return pointer ? read.i32(pointer, 0) : -1;
        },
      };
    }
  } catch {
    if (
      !process.versions.bun &&
      process.env.VITEST === "true" &&
      (process.env.VITEST_WORKER_ID !== undefined || process.env.VITEST_POOL_ID !== undefined)
    ) {
      nativeFunctions = createNodeTestBackend();
      return nativeFunctions;
    }
    nativeFunctions = null;
    throw new PosixDirFdError("Secure POSIX directory-descriptor operations are unavailable");
  }

  return nativeFunctions;
}

/** Vitest executes under Node even when launched through Bun. This test-only
 * backend preserves ordinary behavior for the broad route suite; dedicated
 * tests separately execute the real Bun/libc backend. It is never enabled in
 * a server process. */
function createNodeTestBackend(): NativeFunctions {
  const fdPaths = new Map<number, string>();
  const fdRoots = new Map<number, string>();
  let lastErrno = 0;

  function decodePath(bytes: Uint8Array): string {
    const end = bytes.indexOf(0);
    return Buffer.from(end >= 0 ? bytes.subarray(0, end) : bytes).toString("utf-8");
  }

  function capture<T>(operation: () => T, failure: T): T {
    try {
      return operation();
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).errno;
      lastErrno = typeof errno === "number" ? Math.abs(errno) : -1;
      return failure;
    }
  }

  function opened(path: string, flags: number, mode: number, rootPath = path): number {
    return capture(() => {
      const fd = openSync(path, flags, mode);
      fdPaths.set(fd, path);
      fdRoots.set(fd, rootPath);
      return fd;
    }, -1);
  }

  function sameFileIdentity(
    left: { dev: number | bigint; ino: number | bigint },
    right: { dev: number | bigint; ino: number | bigint },
  ): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  function findDescriptorPath(path: string, identity: ReturnType<typeof fstatSync>): string | null {
    let info: NonNullable<ReturnType<typeof lstatSync>>;
    try {
      info = lstatSync(path);
    } catch {
      return null;
    }
    if (sameFileIdentity(identity, info)) return path;
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    for (const name of readdirSync(path)) {
      const found = findDescriptorPath(resolve(path, name), identity);
      if (found) return found;
    }
    return null;
  }

  function descriptorPath(fd: number): string {
    const stored = fdPaths.get(fd);
    if (!stored) throw Object.assign(new Error("unknown test descriptor"), { errno: -9 });
    const identity = fstatSync(fd);
    try {
      if (sameFileIdentity(identity, lstatSync(stored))) return stored;
    } catch {
      // The pathname may have moved while the descriptor remains valid.
    }
    const root = fdRoots.get(fd);
    const relocated = root ? findDescriptorPath(root, identity) : null;
    if (!relocated) return stored;
    fdPaths.set(fd, relocated);
    return relocated;
  }

  function childPath(fd: number, bytes: Uint8Array): string {
    return resolve(descriptorPath(fd), decodePath(bytes));
  }

  return {
    open: (path, flags, mode) => {
      const decoded = decodePath(path);
      return opened(decoded, flags, mode, decoded);
    },
    openat: (dirFd, path, flags, mode) =>
      capture(
        () =>
          opened(childPath(dirFd, path), flags, mode, fdRoots.get(dirFd) || descriptorPath(dirFd)),
        -1,
      ),
    mkdirat: (dirFd, path, mode) =>
      capture(() => {
        mkdirSync(childPath(dirFd, path), { mode });
        return 0;
      }, -1),
    unlinkat: (dirFd, path, flags) =>
      capture(() => {
        const target = childPath(dirFd, path);
        if (flags === PLATFORM_CONSTANTS!.atRemoveDir) rmdirSync(target);
        else unlinkSync(target);
        return 0;
      }, -1),
    renameNoReplace: (oldDirFd, oldPath, newDirFd, newPath) =>
      capture(() => {
        const target = childPath(newDirFd, newPath);
        try {
          lstatSync(target);
          lastErrno = 17;
          return -1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        renameSync(childPath(oldDirFd, oldPath), target);
        return 0;
      }, -1),
    fdopendir: () => null,
    readdir: () => null,
    closedir: () => 0,
    errno: () => lastErrno,
    listNamesForTest: (fd) => readdirSync(descriptorPath(fd)),
  };
}

function cString(value: string): Uint8Array {
  if (value.includes("\0")) throw new PosixDirFdError("Path contains a null byte", { status: 400 });
  return Buffer.from(`${value}\0`, "utf-8");
}

function errnoCode(errno: number): string | undefined {
  if (errno === 2) return "ENOENT";
  if (errno === 17) return "EEXIST";
  if (errno === 20) return "ENOTDIR";
  if (errno === 21) return "EISDIR";
  if (errno === 13) return "EACCES";
  if (errno === 1) return "EPERM";
  if (process.platform === "darwin") {
    if (errno === 62) return "ELOOP";
    if (errno === 66) return "ENOTEMPTY";
    if (errno === 78) return "ENOSYS";
  } else {
    if (errno === 40) return "ELOOP";
    if (errno === 39) return "ENOTEMPTY";
    if (errno === 38) return "ENOSYS";
  }
  return undefined;
}

function nativeError(message: string, errno: number): PosixDirFdError {
  const code = errnoCode(errno);
  return new PosixDirFdError(message, {
    code,
    status: code === "ENOENT" || code === "EEXIST" ? 400 : 403,
  });
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scopePath(rawPath: string, allowedRoots: readonly string[]): ScopedPath {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    ENCODED_PATH_SYNTAX.test(rawPath)
  ) {
    throw new PosixDirFdError("Invalid scoped path", { status: 400 });
  }

  const lexicalPath = resolve(rawPath);
  const lexicalRoots = allowedRoots
    .map((root) => resolve(root))
    .filter((root) => isPathInside(root, lexicalPath))
    .sort((left, right) => right.length - left.length);
  const lexicalRoot = lexicalRoots[0];
  if (!lexicalRoot) throw new PosixDirFdError("Path outside allowed directories");

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch {
    throw new PosixDirFdError("Allowed directory does not exist", { code: "ENOENT", status: 400 });
  }

  const rel = relative(lexicalRoot, lexicalPath);
  const components = rel ? rel.split(/[\\/]+/) : [];
  if (components.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new PosixDirFdError("Invalid scoped path", { status: 400 });
  }
  return { lexicalPath, canonicalRoot, components };
}

function directoryOpenFlags(): number {
  if (
    !PLATFORM_CONSTANTS ||
    typeof constants.O_DIRECTORY !== "number" ||
    typeof constants.O_NOFOLLOW !== "number"
  ) {
    throw new PosixDirFdError("Secure POSIX directory-descriptor operations are unavailable");
  }
  return (
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    PLATFORM_CONSTANTS.closeOnExec
  );
}

function fileOpenFlags(access: number): number {
  if (!PLATFORM_CONSTANTS || typeof constants.O_NOFOLLOW !== "number") {
    throw new PosixDirFdError("Secure POSIX directory-descriptor operations are unavailable");
  }
  return access | constants.O_NOFOLLOW | constants.O_NONBLOCK | PLATFORM_CONSTANTS.closeOnExec;
}

function openRoot(scoped: ScopedPath): number {
  const native = loadNativeFunctions();
  const fd = native.open(cString(scoped.canonicalRoot), directoryOpenFlags(), 0);
  if (fd < 0) throw nativeError("Could not securely open allowed directory", native.errno());
  try {
    if (!fstatSync(fd).isDirectory()) {
      throw new PosixDirFdError("Allowed root is not a directory");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openChildDirectory(parentFd: number, name: string): number {
  const native = loadNativeFunctions();
  const fd = native.openat(parentFd, cString(name), directoryOpenFlags(), 0);
  if (fd < 0) throw nativeError("Directory path contains an unsafe component", native.errno());
  try {
    if (!fstatSync(fd).isDirectory()) {
      throw new PosixDirFdError("Directory path contains a non-directory component");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openOrCreateChildDirectory(parentFd: number, name: string): number {
  try {
    return openChildDirectory(parentFd, name);
  } catch (openError) {
    const native = loadNativeFunctions();
    if (native.mkdirat(parentFd, cString(name), MODE_PRIVATE_DIRECTORY) < 0) {
      // Another creator may have won. Reopening is both the EEXIST handling
      // and the no-follow/type validation for that case.
      try {
        return openChildDirectory(parentFd, name);
      } catch {
        throw openError;
      }
    }
    return openChildDirectory(parentFd, name);
  }
}

function openParent(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { createParents?: boolean } = {},
): OpenedParent {
  const scoped = scopePath(rawPath, allowedRoots);
  if (scoped.components.length === 0) {
    throw new PosixDirFdError("Operation requires a path below the allowed root", { status: 400 });
  }
  let currentFd = openRoot(scoped);
  try {
    for (const component of scoped.components.slice(0, -1)) {
      const nextFd = options.createParents
        ? openOrCreateChildDirectory(currentFd, component)
        : openChildDirectory(currentFd, component);
      closeSync(currentFd);
      currentFd = nextFd;
    }
    return {
      fd: currentFd,
      leaf: scoped.components[scoped.components.length - 1]!,
      scoped,
    };
  } catch (error) {
    closeSync(currentFd);
    throw error;
  }
}

function openDirectoryPath(rawPath: string, allowedRoots: readonly string[]): number {
  const scoped = scopePath(rawPath, allowedRoots);
  let currentFd = openRoot(scoped);
  try {
    for (const component of scoped.components) {
      const nextFd = openChildDirectory(currentFd, component);
      closeSync(currentFd);
      currentFd = nextFd;
    }
    return currentFd;
  } catch (error) {
    closeSync(currentFd);
    throw error;
  }
}

function statFromFd(fd: number): PosixEntryStat {
  const info = fstatSync(fd);
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
  if (!kind) throw new PosixDirFdError("Entry is not a regular file or directory");
  if (kind === "file" && info.nlink !== 1) {
    throw new PosixDirFdError("Target is not a private regular file");
  }
  return {
    kind,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    nlink: info.nlink,
  };
}

function identityFromFd(fd: number): PosixEntryIdentity {
  const info = fstatSync(fd);
  return { device: info.dev, inode: info.ino };
}

function identitiesMatch(left: PosixEntryIdentity, right: PosixEntryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function requirePinnedEntryName(name: string): string {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new PosixDirFdError("Invalid pinned directory entry name", { status: 400 });
  }
  return name;
}

function openEntryAt(parentFd: number, name: string): OpenedEntry {
  const native = loadNativeFunctions();
  const nameBytes = cString(name);
  const directoryFd = native.openat(parentFd, nameBytes, directoryOpenFlags(), 0);
  if (directoryFd >= 0) {
    try {
      return { fd: directoryFd, stat: statFromFd(directoryFd) };
    } catch (error) {
      closeSync(directoryFd);
      throw error;
    }
  }

  const fileFd = native.openat(parentFd, nameBytes, fileOpenFlags(constants.O_RDONLY), 0);
  if (fileFd < 0) throw nativeError("Could not securely open entry", native.errno());
  try {
    const stat = statFromFd(fileFd);
    if (stat.kind !== "file") throw new PosixDirFdError("Entry is not a regular file");
    return { fd: fileFd, stat };
  } catch (error) {
    closeSync(fileFd);
    throw error;
  }
}

function sameSnapshot(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export function ensureDirectoryByDirFd(rawPath: string, allowedRoots: readonly string[]): string {
  const scoped = scopePath(rawPath, allowedRoots);
  let currentFd = openRoot(scoped);
  try {
    for (const component of scoped.components) {
      const nextFd = openOrCreateChildDirectory(currentFd, component);
      closeSync(currentFd);
      currentFd = nextFd;
    }
    return scoped.lexicalPath;
  } finally {
    closeSync(currentFd);
  }
}

export function createDirectoryByDirFd(
  rawPath: string,
  allowedRoots: readonly string[],
  hooks: PosixDirFdTestHooks = {},
): PosixEntryStat {
  const parent = openParent(rawPath, allowedRoots);
  try {
    hooks.afterParentOpened?.();
    const native = loadNativeFunctions();
    if (native.mkdirat(parent.fd, cString(parent.leaf), MODE_PRIVATE_DIRECTORY) < 0) {
      const errno = native.errno();
      if (errnoCode(errno) === "EEXIST") {
        let existing: OpenedEntry | null = null;
        try {
          existing = openEntryAt(parent.fd, parent.leaf);
        } finally {
          if (existing) closeSync(existing.fd);
        }
      }
      throw nativeError("Could not create directory", errno);
    }
    const createdFd = openChildDirectory(parent.fd, parent.leaf);
    try {
      return statFromFd(createdFd);
    } finally {
      closeSync(createdFd);
    }
  } finally {
    closeSync(parent.fd);
  }
}

export function writeFileByDirFd(
  rawPath: string,
  content: string | Uint8Array,
  allowedRoots: readonly string[],
  options: { exclusive?: boolean; hooks?: PosixDirFdTestHooks } = {},
): void {
  const parent = openParent(rawPath, allowedRoots);
  let fd = -1;
  try {
    options.hooks?.afterParentOpened?.();
    const native = loadNativeFunctions();
    const leaf = cString(parent.leaf);
    fd = native.openat(parent.fd, leaf, fileOpenFlags(constants.O_WRONLY), 0);
    if (fd >= 0) {
      if (options.exclusive) {
        throw new PosixDirFdError("Target already exists", { code: "EEXIST", status: 400 });
      }
    } else {
      const openErrno = native.errno();
      if (errnoCode(openErrno) !== "ENOENT") {
        throw nativeError("Could not securely open file", openErrno);
      }
      fd = native.openat(
        parent.fd,
        leaf,
        fileOpenFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
        MODE_PRIVATE_FILE,
      );
      if (fd < 0) {
        const createError = nativeError("Could not securely create file", native.errno());
        // The no-follow open failed, yet exclusive creation says the leaf
        // exists. Treat this as an unsafe special leaf (usually a dangling
        // symlink), not as an ordinary missing-parent validation error.
        if (createError.code === "EEXIST") {
          throw new PosixDirFdError("Target is not a private regular file", {
            code: createError.code,
            status: 403,
          });
        }
        throw createError;
      }
    }

    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {
      throw new PosixDirFdError("Target is not a private regular file");
    }
    const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) throw new PosixDirFdError("Secure file write did not make progress");
      offset += written;
    }
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new PosixDirFdError("Target changed during secure write");
    }
  } finally {
    if (fd >= 0) closeSync(fd);
    closeSync(parent.fd);
  }
}

export function readFileByDirFd(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { maxBytes?: number; hooks?: PosixDirFdTestHooks } = {},
): PosixFileSnapshot {
  const parent = openParent(rawPath, allowedRoots);
  let fd = -1;
  try {
    options.hooks?.afterParentOpened?.();
    const native = loadNativeFunctions();
    fd = native.openat(parent.fd, cString(parent.leaf), fileOpenFlags(constants.O_RDONLY), 0);
    if (fd < 0) throw nativeError("Could not securely open file", native.errno());
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {
      throw new PosixDirFdError("Target is not a private regular file");
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new PosixDirFdError("File size is not safe to read", { status: 400 });
    }
    if (options.maxBytes !== undefined && before.size > options.maxBytes) {
      throw new PosixDirFdError("File is too large for secure read", { status: 400 });
    }

    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== bytes.byteLength || !sameSnapshot(before, after)) {
      throw new PosixDirFdError("Target changed during secure read");
    }
    return {
      bytes,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    };
  } finally {
    if (fd >= 0) closeSync(fd);
    closeSync(parent.fd);
  }
}

export function statEntryByDirFd(rawPath: string, allowedRoots: readonly string[]): PosixEntryStat {
  const scoped = scopePath(rawPath, allowedRoots);
  if (scoped.components.length === 0) {
    const rootFd = openRoot(scoped);
    try {
      return statFromFd(rootFd);
    } finally {
      closeSync(rootFd);
    }
  }
  const parent = openParent(rawPath, allowedRoots);
  try {
    const entry = openEntryAt(parent.fd, parent.leaf);
    try {
      return entry.stat;
    } finally {
      closeSync(entry.fd);
    }
  } finally {
    closeSync(parent.fd);
  }
}

export function deleteEntryByDirFd(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { recursive?: boolean; hooks?: PosixDirFdTestHooks } = {},
): void {
  const parent = openParent(rawPath, allowedRoots);
  let entry: OpenedEntry | null = null;
  try {
    options.hooks?.afterParentOpened?.();
    entry = openEntryAt(parent.fd, parent.leaf);
    const isDirectory = entry.stat.kind === "directory";
    if (isDirectory && options.recursive) {
      deleteOpenedDirectoryContents(entry.fd);
      entry = null;
    }
    const native = loadNativeFunctions();
    const flags = isDirectory ? PLATFORM_CONSTANTS!.atRemoveDir : 0;
    if (native.unlinkat(parent.fd, cString(parent.leaf), flags) < 0) {
      throw nativeError("Could not securely delete entry", native.errno());
    }
  } finally {
    if (entry) closeSync(entry.fd);
    closeSync(parent.fd);
  }
}

export function renameEntryByDirFdNoReplace(
  sourcePath: string,
  targetPath: string,
  allowedRoots: readonly string[],
  hooks: PosixDirFdTestHooks = {},
): void {
  const sourceParent = openParent(sourcePath, allowedRoots);
  let targetParent: OpenedParent | null = null;
  let sourceEntry: OpenedEntry | null = null;
  try {
    targetParent = openParent(targetPath, allowedRoots);
    if (sourceParent.scoped.canonicalRoot !== targetParent.scoped.canonicalRoot) {
      throw new PosixDirFdError("Cross-root rename is not allowed");
    }
    hooks.afterParentOpened?.();
    sourceEntry = openEntryAt(sourceParent.fd, sourceParent.leaf);
    const native = loadNativeFunctions();
    if (
      native.renameNoReplace(
        sourceParent.fd,
        cString(sourceParent.leaf),
        targetParent.fd,
        cString(targetParent.leaf),
        PLATFORM_CONSTANTS!.renameNoReplace,
      ) < 0
    ) {
      throw nativeError("Could not securely rename entry without replacement", native.errno());
    }
  } finally {
    if (sourceEntry) closeSync(sourceEntry.fd);
    if (targetParent) closeSync(targetParent.fd);
    closeSync(sourceParent.fd);
  }
}

/**
 * Keep one destination directory descriptor open for a multi-step mutation.
 * Every rename is resolved relative to that descriptor, so replacing the
 * destination pathname cannot split a batch across different directories.
 */
export async function withPinnedDirectoryByDirFd<T>(
  rawPath: string,
  allowedRoots: readonly string[],
  operation: (directory: PinnedDirectoryByDirFd) => Promise<T> | T,
): Promise<T> {
  const scoped = scopePath(rawPath, allowedRoots);
  const fd = openDirectoryPath(rawPath, allowedRoots);
  const pinnedIdentity = identityFromFd(fd);

  const directory: PinnedDirectoryByDirFd = {
    statEntry(name) {
      return this.inspectEntry(name)?.stat ?? null;
    },

    inspectEntry(name) {
      const entryName = requirePinnedEntryName(name);
      let entry: OpenedEntry | null = null;
      try {
        entry = openEntryAt(fd, entryName);
        return { identity: identityFromFd(entry.fd), stat: entry.stat };
      } catch (error) {
        if (error instanceof PosixDirFdError && error.code === "ENOENT") return null;
        throw error;
      } finally {
        if (entry) closeSync(entry.fd);
      }
    },

    renameEntryFromPathNoReplace(sourcePath, targetName) {
      const entryName = requirePinnedEntryName(targetName);
      const sourceParent = openParent(sourcePath, allowedRoots);
      let sourceEntry: OpenedEntry | null = null;
      try {
        if (sourceParent.scoped.canonicalRoot !== scoped.canonicalRoot) {
          throw new PosixDirFdError("Cross-root rename is not allowed");
        }
        sourceEntry = openEntryAt(sourceParent.fd, sourceParent.leaf);
        const identity = identityFromFd(sourceEntry.fd);
        const native = loadNativeFunctions();
        if (
          native.renameNoReplace(
            sourceParent.fd,
            cString(sourceParent.leaf),
            fd,
            cString(entryName),
            PLATFORM_CONSTANTS!.renameNoReplace,
          ) < 0
        ) {
          throw nativeError("Could not securely rename entry without replacement", native.errno());
        }
        return identity;
      } finally {
        if (sourceEntry) closeSync(sourceEntry.fd);
        closeSync(sourceParent.fd);
      }
    },

    renameEntryToDirectoryNoReplace(sourceName, targetDirectory, targetName, expectedIdentity) {
      const sourceEntryName = requirePinnedEntryName(sourceName);
      const targetEntryName = requirePinnedEntryName(targetName);
      const targetState = pinnedDirectoryStates.get(targetDirectory);
      if (!targetState) {
        throw new PosixDirFdError("Target pinned directory is no longer active");
      }
      if (targetState.scoped.canonicalRoot !== scoped.canonicalRoot) {
        throw new PosixDirFdError("Cross-root rename is not allowed");
      }
      let sourceEntry: OpenedEntry | null = null;
      try {
        sourceEntry = openEntryAt(fd, sourceEntryName);
        const identity = identityFromFd(sourceEntry.fd);
        if (!identitiesMatch(identity, expectedIdentity)) {
          throw new PosixDirFdError("Pinned move entry identity changed before rename", {
            code: "ESTALE",
          });
        }
        const native = loadNativeFunctions();
        if (
          native.renameNoReplace(
            fd,
            cString(sourceEntryName),
            targetState.fd,
            cString(targetEntryName),
            PLATFORM_CONSTANTS!.renameNoReplace,
          ) < 0
        ) {
          throw nativeError("Could not securely rename entry without replacement", native.errno());
        }
        return identity;
      } finally {
        if (sourceEntry) closeSync(sourceEntry.fd);
      }
    },

    renameEntryToPathNoReplace(sourceName, targetPath, expectedIdentity) {
      const entryName = requirePinnedEntryName(sourceName);
      const targetParent = openParent(targetPath, allowedRoots);
      let sourceEntry: OpenedEntry | null = null;
      try {
        if (targetParent.scoped.canonicalRoot !== scoped.canonicalRoot) {
          throw new PosixDirFdError("Cross-root rename is not allowed");
        }
        sourceEntry = openEntryAt(fd, entryName);
        if (!identitiesMatch(identityFromFd(sourceEntry.fd), expectedIdentity)) {
          throw new PosixDirFdError("Pinned move entry identity changed before rollback", {
            code: "ESTALE",
          });
        }
        const native = loadNativeFunctions();
        if (
          native.renameNoReplace(
            fd,
            cString(entryName),
            targetParent.fd,
            cString(targetParent.leaf),
            PLATFORM_CONSTANTS!.renameNoReplace,
          ) < 0
        ) {
          throw nativeError("Could not securely rename entry without replacement", native.errno());
        }
      } finally {
        if (sourceEntry) closeSync(sourceEntry.fd);
        closeSync(targetParent.fd);
      }
    },

    matchesPath(candidatePath) {
      let candidateFd = -1;
      try {
        const candidateScoped = scopePath(candidatePath, allowedRoots);
        if (candidateScoped.canonicalRoot !== scoped.canonicalRoot) return false;
        candidateFd = openDirectoryPath(candidatePath, allowedRoots);
        return identitiesMatch(identityFromFd(candidateFd), pinnedIdentity);
      } catch {
        return false;
      } finally {
        if (candidateFd >= 0) closeSync(candidateFd);
      }
    },
  };

  pinnedDirectoryStates.set(directory, { fd, scoped });
  try {
    return await operation(directory);
  } finally {
    pinnedDirectoryStates.delete(directory);
    closeSync(fd);
  }
}

function directoryEntryName(pointer: Pointer): string | null {
  if (!PLATFORM_CONSTANTS) return null;
  const { CString, read } = loadBunFfi();
  const length =
    PLATFORM_CONSTANTS.direntNameLengthOffset >= 0
      ? read.u16(pointer, PLATFORM_CONSTANTS.direntNameLengthOffset)
      : undefined;
  const name = new CString(pointer, PLATFORM_CONSTANTS.direntNameOffset, length).toString();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    return null;
  }
  return name;
}

function forEachDirectoryNameOwned(fd: number, visit: (name: string) => void): void {
  const native = loadNativeFunctions();
  if (native.listNamesForTest) {
    try {
      for (const name of native.listNamesForTest(fd)) visit(name);
    } finally {
      closeSync(fd);
    }
    return;
  }

  const dir = native.fdopendir(fd);
  if (!dir) {
    closeSync(fd);
    throw nativeError("Could not enumerate secure directory descriptor", native.errno());
  }
  try {
    while (true) {
      const pointer = native.readdir(dir);
      if (!pointer) break;
      const name = directoryEntryName(pointer);
      if (name) visit(name);
    }
  } finally {
    native.closedir(dir);
  }
}

function deleteOpenedDirectoryContents(fd: number): void {
  const native = loadNativeFunctions();
  forEachDirectoryNameOwned(fd, (name) => {
    const entry = openEntryAt(fd, name);
    if (entry.stat.kind === "directory") {
      deleteOpenedDirectoryContents(entry.fd);
      if (native.unlinkat(fd, cString(name), PLATFORM_CONSTANTS!.atRemoveDir) < 0) {
        throw nativeError("Could not securely delete child directory", native.errno());
      }
      return;
    }

    closeSync(entry.fd);
    if (native.unlinkat(fd, cString(name), 0) < 0) {
      throw nativeError("Could not securely delete child file", native.errno());
    }
  });
}

function listOpenedDirectory(fd: number, depth: number): PosixDirectoryEntry[] {
  const entries: PosixDirectoryEntry[] = [];
  forEachDirectoryNameOwned(fd, (name) => {
    let opened: OpenedEntry;
    try {
      opened = openEntryAt(fd, name);
    } catch {
      // Symlinks, special files, multiply-linked files, and entries racing
      // with enumeration are intentionally omitted.
      return;
    }
    if (opened.stat.kind === "directory" && depth > 1) {
      entries.push({
        name,
        ...opened.stat,
        children: listOpenedDirectory(opened.fd, depth - 1),
      });
    } else {
      entries.push({ name, ...opened.stat });
      closeSync(opened.fd);
    }
  });
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return entries;
}

export function listDirectoryByDirFd(
  rawPath: string,
  allowedRoots: readonly string[],
  options: { depth?: number } = {},
): PosixDirectoryEntry[] {
  const depth = options.depth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 256) {
    throw new PosixDirFdError("Invalid secure directory traversal depth", { status: 400 });
  }
  return listOpenedDirectory(openDirectoryPath(rawPath, allowedRoots), depth);
}
