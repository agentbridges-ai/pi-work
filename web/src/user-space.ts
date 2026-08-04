import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  UserSpaceAccess,
  UserSpaceMount,
  UserSpaceOperation,
} from "./types.js";
import {
  canUseWorkspaceWorker,
  createUserSpaceRuntime,
  metadataEntryFromFile,
  type UserSpaceRuntime,
} from "./user-space-runtime.js";
import type { IndexedWorkspaceContentMatch, IndexedWorkspaceEntry } from "./user-space-index.js";
import { uiCopy } from "./ui-copy.js";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { applyTextEditsLikePi, readTextLikePi, type PiTextEdit } from "./user-space-pi-tools.js";
import {
  findPersistedRecordByWorkspaceName,
  isPersistedRecordInScope,
  mountFromPersistedRecord,
  UserSpacePersistence,
  type PersistedUserSpaceRecord as PersistedUserSpaceRecordData,
  type UserSpacePersistenceAdapter as UserSpacePersistenceAdapterData,
  type UserSpacePersistenceScope,
} from "./user-space-persistence.js";

export type { UserSpacePersistenceScope } from "./user-space-persistence.js";
import {
  executeUserSpaceShell,
  isShellBinaryEncoding,
  isShellMountRoot,
  isShellVirtualRoot,
  normalizeShellPath,
  normalizeShellWriteContent,
  shellMountPathForName,
  shellPathToUserPath,
  shellWriteEncoding,
  userPathToShellPath,
  type UserSpaceShellFileSystem,
  type UserSpaceShellVisibility,
} from "./user-space-shell/index.js";
import { USER_SPACE_BASH_MOUNT_NAME } from "../shared/user-space-shell-contract.js";
import {
  createRuokCleanupScript,
  createRuokSetupScript,
  formatRuokCaseReport,
  formatRuokStats,
  RUOK_COMMAND_MATRIX,
  RUOK_SHELL_LIKE_MATRIX,
  type ShellSelfTestCase,
} from "./user-space-shell-self-test.js";

export {
  createRuokCleanupScript,
  createRuokSetupScript,
  formatRuokCaseReport,
  formatRuokStats,
  RUOK_COMMAND_MATRIX,
  RUOK_SHELL_LIKE_MATRIX,
};
export type { ShellSelfTestCase };

type ShellDirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

type ShellReadFileOptions = { encoding?: BufferEncoding | null };
type ShellWriteFileOptions = { encoding?: BufferEncoding };

type PermissionMode = "read" | "readwrite";
type FileSystemHandleKind = "file" | "directory";

type TestWorkspaceSpec = {
  name?: string;
  directories?: string[];
  files?: Record<string, string>;
};

interface BrowserFileSystemHandle {
  kind: FileSystemHandleKind;
  name: string;
  isSameEntry?: (other: BrowserFileSystemHandle) => Promise<boolean>;
  queryPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
}

interface BrowserFileSystemWritableFileStream {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
}

interface BrowserFileSystemFileHandle extends BrowserFileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<BrowserFileSystemWritableFileStream>;
}

interface BrowserFileSystemDirectoryHandle extends BrowserFileSystemHandle {
  kind: "directory";
  values?: () => AsyncIterable<BrowserFileSystemHandle>;
  entries?: () => AsyncIterable<[string, BrowserFileSystemHandle]>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

type PersistedUserSpaceRecord = PersistedUserSpaceRecordData<BrowserFileSystemDirectoryHandle>;
type UserSpacePersistenceAdapter =
  UserSpacePersistenceAdapterData<BrowserFileSystemDirectoryHandle>;

interface UserSpaceEntry {
  name: string;
  path: string;
  kind: FileSystemHandleKind;
  size?: number;
  lastModified?: number;
  previewKind?: IndexedWorkspaceEntry["previewKind"];
  supportsLineEdit?: boolean;
  hidden?: boolean;
  contentIndexed?: boolean;
}

interface MountedWorkspace {
  mount: UserSpaceMount;
  root: BrowserFileSystemDirectoryHandle;
  directoryGeneration: number;
  persistenceScope: UserSpacePersistenceScope | null;
  dirHandles: Map<string, BrowserFileSystemDirectoryHandle>;
  fileHandles: Map<string, BrowserFileSystemFileHandle>;
  recentOperations: UserSpaceOperationRecord[];
  recentFileChanges: UserSpaceFileChangeRecord[];
  indexing: boolean;
  indexGeneration: number;
  runtime: UserSpaceRuntime;
}

interface UserSpaceWorkspaceLease {
  runtimeGeneration: number;
  directoryGeneration: number;
  mountId: string;
  workspace: MountedWorkspace;
  root: BrowserFileSystemDirectoryHandle;
}

export type UserSpaceMountProgress =
  | { phase: "picking" }
  | { phase: "permission"; rootName: string }
  | { phase: "indexing"; rootName: string }
  | { phase: "ready"; rootName: string; fileCount?: number; lastIndexedAt?: number };

export type UserSpaceMountNameConflict = {
  name: string;
  existingNames: string[];
};

export interface UserSpaceOperationRecord {
  id: string;
  mountId?: string;
  operation: UserSpaceOperation;
  path?: string;
  changedDirs?: string[];
  status: "ok" | "error";
  message: string;
  timestamp: number;
}

export interface UserSpaceFileChangeRecord {
  id: string;
  mountId: string;
  changedDirs: string[];
  timestamp: number;
}

export interface UserSpaceSnapshot {
  supported: boolean;
  mounts: UserSpaceMount[];
  indexing: Record<string, boolean>;
  recentOperations: UserSpaceOperationRecord[];
  recentFileChanges: UserSpaceFileChangeRecord[];
}

type TransportMessage = Extract<
  BrowserOutgoingMessage,
  | { type: "user_space_mount" }
  | { type: "user_space_status" }
  | { type: "user_space_index_update" }
  | { type: "user_space_unmount" }
>;

type BlobCheckoutRequest = Extract<
  BrowserIncomingMessage,
  { type: "user_space_blob_checkout_request" }
>;
type BlobCheckinRequest = Extract<
  BrowserIncomingMessage,
  { type: "user_space_blob_checkin_request" }
>;

const TEST_WORKSPACE_STORAGE_KEY = "piwork:test-user-space";
const DIR_HANDLE_CACHE_LIMIT = 256;
const FILE_HANDLE_CACHE_LIMIT = 128;
const MAX_USER_SPACE_MUTATION_ENTRIES = 1_000;
const DEFAULT_USER_SPACE_SHELL_MOUNT_NAME = "user-dir";
const mounts = new Map<string, MountedWorkspace>();
const sessionMounts = new Map<string, Set<string>>();
const lastSessionStatusSignatures = new Map<string, string>();
const listeners = new Set<() => void>();
interface BackgroundIndexTimer {
  timer: ReturnType<typeof setTimeout>;
  ownerEpoch: number | null;
  detachScope: (() => void) | null;
}
const backgroundIndexTimers = new Map<string, BackgroundIndexTimer>();
let transport: ((sessionId: string, message: TransportMessage) => void) | null = null;
let operationCounter = 0;
let fileChangeCounter = 0;
let snapshotVersion = 0;
let cachedSnapshot: UserSpaceSnapshot | null = null;
let cachedSnapshotVersion = -1;
let cachedSnapshotSupported = false;
let userSpaceRuntimeGeneration = 0;
let nextWorkspaceDirectoryGeneration = 0;
const workspaceMutationChains = new Map<string, Promise<void>>();
const userSpacePersistence = new UserSpacePersistence<BrowserFileSystemDirectoryHandle>(
  isSameDirectoryHandle,
);

function staleUserSpaceOperation(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("User Space runtime was disposed.", "AbortError");
  }
  const error = new Error("User Space runtime was disposed.");
  error.name = "AbortError";
  return error;
}

function assertUserSpaceGeneration(generation: number): void {
  if (generation !== userSpaceRuntimeGeneration) throw staleUserSpaceOperation();
}

function captureWorkspaceLease(workspace: MountedWorkspace): UserSpaceWorkspaceLease {
  const lease = {
    runtimeGeneration: userSpaceRuntimeGeneration,
    directoryGeneration: workspace.directoryGeneration,
    mountId: workspace.mount.mountId,
    workspace,
    root: workspace.root,
  };
  assertWorkspaceLease(lease);
  return lease;
}

function isWorkspaceLeaseCurrent(lease: UserSpaceWorkspaceLease): boolean {
  return (
    lease.runtimeGeneration === userSpaceRuntimeGeneration &&
    mounts.get(lease.mountId) === lease.workspace &&
    lease.workspace.directoryGeneration === lease.directoryGeneration &&
    lease.workspace.root === lease.root
  );
}

function assertWorkspaceLease(lease: UserSpaceWorkspaceLease): void {
  if (!isWorkspaceLeaseCurrent(lease)) throw staleUserSpaceOperation();
}

function assertCurrentWorkspace(workspace: MountedWorkspace): void {
  assertWorkspaceLease(captureWorkspaceLease(workspace));
}

async function prepareWorkspaceWrite(lease: UserSpaceWorkspaceLease): Promise<void> {
  assertWorkspaceLease(lease);
  requireWritableWorkspace(lease.workspace);
  await ensurePermission(lease.root, "readwrite");
  assertWorkspaceLease(lease);
  requireWritableWorkspace(lease.workspace);
}

async function assertWorkspaceWritePermission(lease: UserSpaceWorkspaceLease): Promise<void> {
  assertWorkspaceLease(lease);
  requireWritableWorkspace(lease.workspace);
  const permission = await queryPermission(lease.root, "readwrite");
  assertWorkspaceLease(lease);
  requireWritableWorkspace(lease.workspace);
  if (permission !== undefined && permission !== "granted") {
    throw new Error("Directory permission was not granted.");
  }
}

async function assertWorkspaceReadPermission(lease: UserSpaceWorkspaceLease): Promise<void> {
  assertWorkspaceLease(lease);
  const permission = await queryPermission(lease.root, "read");
  assertWorkspaceLease(lease);
  if (permission !== undefined && permission !== "granted") {
    throw new Error("Directory permission was not granted.");
  }
}

async function commitWritableFile(
  lease: UserSpaceWorkspaceLease,
  writable: BrowserFileSystemWritableFileStream,
  data: string | Blob | BufferSource,
  onCommitted?: () => void,
  beforeClose?: () => Promise<void>,
): Promise<void> {
  let closed = false;
  try {
    await assertWorkspaceWritePermission(lease);
    await writable.write(data);
    await assertWorkspaceWritePermission(lease);
    await beforeClose?.();
    await assertWorkspaceWritePermission(lease);
    await writable.close();
    closed = true;
    onCommitted?.();
    assertWorkspaceLease(lease);
  } catch (error) {
    if (!closed && writable.abort) await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export function isUserSpaceSupported(): boolean {
  return (
    getTestWorkspaceSpec() !== null ||
    (typeof window !== "undefined" &&
      typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker ===
        "function")
  );
}

export function isUserSpacePickerAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === "AbortError" ||
    (typeof message === "string" && /user aborted a request/i.test(message))
  );
}

export function setUserSpaceTransport(
  sender: (sessionId: string, message: TransportMessage) => void,
): void {
  transport = sender;
}

export function subscribeUserSpace(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUserSpaceSnapshot(): UserSpaceSnapshot {
  const supported = isUserSpaceSupported();
  if (
    cachedSnapshot &&
    cachedSnapshotVersion === snapshotVersion &&
    cachedSnapshotSupported === supported
  ) {
    return cachedSnapshot;
  }

  const recentOperations = Array.from(mounts.values())
    .flatMap((workspace) => workspace.recentOperations)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20);
  const recentFileChanges = Array.from(mounts.values())
    .flatMap((workspace) => workspace.recentFileChanges)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50);

  cachedSnapshot = {
    supported,
    mounts: getMountedUserSpaces(),
    indexing: Object.fromEntries(
      Array.from(mounts.values())
        .filter((workspace) => workspace.indexing)
        .map((workspace) => [workspace.mount.mountId, true]),
    ),
    recentOperations,
    recentFileChanges,
  };
  cachedSnapshotVersion = snapshotVersion;
  cachedSnapshotSupported = supported;
  return cachedSnapshot;
}

export function getMountedUserSpaces(): UserSpaceMount[] {
  return Array.from(mounts.values()).map((workspace) => ({ ...workspace.mount }));
}

export async function restorePersistedUserSpaces(
  scope: UserSpacePersistenceScope,
  expectedMounts?: UserSpaceMount[],
  options: { requestPermission?: boolean } = {},
): Promise<UserSpaceMount[]> {
  const generation = userSpaceRuntimeGeneration;
  const adapter = userSpacePersistence.getAdapter();
  if (!adapter)
    return expectedMounts?.map((mount) => ({ ...mount, status: "offline" as const })) || [];

  let allRecords: PersistedUserSpaceRecord[] | null = null;
  const recordForExpectedMount = async (
    mount: UserSpaceMount,
  ): Promise<PersistedUserSpaceRecord | null> => {
    const exact = await adapter.get(scope, mount.mountId);
    assertUserSpaceGeneration(generation);
    if (exact && isPersistedRecordInScope(exact, scope)) return exact;
    allRecords ??= (await adapter.getAll(scope)).filter((record) =>
      isPersistedRecordInScope(record, scope),
    );
    assertUserSpaceGeneration(generation);
    return findPersistedRecordByWorkspaceName(allRecords, mount, scope);
  };

  const records = expectedMounts?.length
    ? await Promise.all(
        expectedMounts.map(async (mount) => ({
          expected: mount,
          record: await recordForExpectedMount(mount),
        })),
      )
    : (await adapter.getAll(scope))
        .filter((record) => isPersistedRecordInScope(record, scope))
        .map((record) => ({ expected: undefined, record }));
  assertUserSpaceGeneration(generation);

  const restored: UserSpaceMount[] = [];
  for (const item of records) {
    const expected = item.expected;
    const record = item.record;
    if (!record) {
      if (expected) restored.push({ ...expected, status: "offline" });
      continue;
    }

    const mount = mountFromPersistedRecord(record, expected);
    try {
      const mode = permissionModeForAccess(mount.access);
      const permission = await queryPermission(record.root, mode);
      assertUserSpaceGeneration(generation);
      if (
        permission === "granted" ||
        (permission === undefined && !record.root.requestPermission)
      ) {
        const registered = registerMountedWorkspace(
          withPermissionSnapshot(mount, permission || "granted"),
          record.root,
          scope,
        );
        restored.push(await restoreUserSpaceMetadata(registered.mountId, generation));
        continue;
      }
      if (options.requestPermission) {
        await ensurePermission(record.root, mode);
        assertUserSpaceGeneration(generation);
        const registered = registerMountedWorkspace(
          withPermissionSnapshot(mount, "granted"),
          record.root,
          scope,
        );
        restored.push(await restoreUserSpaceMetadata(registered.mountId, generation));
        continue;
      }
      restored.push(
        withPermissionSnapshot({ ...mount, status: "offline" }, permission || "prompt"),
      );
    } catch {
      assertUserSpaceGeneration(generation);
      restored.push(withPermissionSnapshot({ ...mount, status: "offline" }, "denied"));
    }
  }
  return restored;
}

export async function restorePersistedUserSpace(
  scope: UserSpacePersistenceScope,
  mount: UserSpaceMount,
  options: { requestPermission?: boolean } = {},
): Promise<UserSpaceMount | null> {
  const restored = await restorePersistedUserSpaces(scope, [mount], options);
  return restored[0] || null;
}

export async function forgetPersistedUserSpace(
  scope: UserSpacePersistenceScope,
  mountId: string,
): Promise<void> {
  await userSpacePersistence.forget(scope, mountId);
}

export function configureUserSpacePersistenceForTests(
  adapter: UserSpacePersistenceAdapter | null | undefined,
): void {
  userSpacePersistence.configureAdapterForTests(adapter);
}

export function disposeUserSpaceRuntimeState(): void {
  userSpaceRuntimeGeneration++;
  for (const mountId of Array.from(mounts.keys())) disposeMountedWorkspace(mountId);
  mounts.clear();
  sessionMounts.clear();
  lastSessionStatusSignatures.clear();
  userSpacePersistence.clearPendingWrites();
  workspaceMutationChains.clear();
  operationCounter = 0;
  notify();
}

export function resetUserSpaceStateForTests(): void {
  disposeUserSpaceRuntimeState();
}

export async function mountUserSpace(
  access: UserSpaceAccess = "readwrite",
  options: {
    onProgress?: (progress: UserSpaceMountProgress) => void;
    existingRootNames?: readonly string[];
    onNameConflict?: (conflict: UserSpaceMountNameConflict) => Promise<string | null>;
    persistenceScope?: UserSpacePersistenceScope;
  } = {},
): Promise<UserSpaceMount> {
  const generation = userSpaceRuntimeGeneration;
  if (!isUserSpaceSupported()) {
    throw new Error("This browser does not support directory mounting.");
  }

  const mode = permissionModeForAccess(access);
  options.onProgress?.({ phase: "picking" });
  assertUserSpaceGeneration(generation);
  const root =
    getTestWorkspaceRoot() ||
    (await (
      window as unknown as {
        showDirectoryPicker(options?: {
          mode?: PermissionMode;
        }): Promise<BrowserFileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode }));
  assertUserSpaceGeneration(generation);
  options.onProgress?.({ phase: "permission", rootName: root.name });
  assertUserSpaceGeneration(generation);
  await ensurePermission(root, mode);
  assertUserSpaceGeneration(generation);
  const duplicate = await findMountedWorkspaceByRoot(root, options.persistenceScope || null);
  assertUserSpaceGeneration(generation);
  if (duplicate) {
    options.onProgress?.({
      phase: "ready",
      rootName: duplicate.mount.rootName,
      fileCount: duplicate.mount.fileCount,
      lastIndexedAt: duplicate.mount.lastIndexedAt,
    });
    assertUserSpaceGeneration(generation);
    return { ...duplicate.mount };
  }

  const existingRootNames = options.existingRootNames || [];
  let rootName = root.name;
  if (hasUserSpaceRootNameConflict(rootName, existingRootNames)) {
    const renamed = await options.onNameConflict?.({
      name: rootName,
      existingNames: [...existingRootNames],
    });
    assertUserSpaceGeneration(generation);
    if (renamed === null || renamed === undefined) {
      throw new DOMException("User cancelled duplicate folder rename.", "AbortError");
    }
    rootName = renamed.trim();
    if (!rootName || hasUserSpaceRootNameConflict(rootName, existingRootNames)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.mountNameConflict(rootName || root.name));
    }
  }

  const mountId = `uw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const mount: UserSpaceMount = {
    mountId,
    name: rootName,
    rootName,
    status: "mounted",
    access,
    canRead: true,
    canWrite: access === "readwrite",
    permissionState: "granted",
    lastPermissionCheckedAt: Date.now(),
    includeHidden: true,
  };

  const mounted = registerMountedWorkspace(mount, root, options.persistenceScope || null);
  await queuePersistMountedWorkspace(mounted, root).catch(() => undefined);
  assertUserSpaceGeneration(generation);
  startBackgroundWorkspaceIndex(mounted.mountId);
  options.onProgress?.({
    phase: "ready",
    rootName: mounted.rootName,
    fileCount: mounted.fileCount,
    lastIndexedAt: mounted.lastIndexedAt,
  });
  assertUserSpaceGeneration(generation);
  return mounted;
}

function hasUserSpaceRootNameConflict(name: string, existingNames: readonly string[]): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return existingNames.some((item) => item.trim().toLocaleLowerCase() === normalized);
}

export async function remountUserSpace(
  expected: UserSpaceMount,
  options: {
    onProgress?: (progress: UserSpaceMountProgress) => void;
    persistenceScope?: UserSpacePersistenceScope;
  } = {},
): Promise<UserSpaceMount> {
  const generation = userSpaceRuntimeGeneration;
  if (!isUserSpaceSupported()) {
    throw new Error("This browser does not support directory mounting.");
  }

  const access = expected.access || "readwrite";
  const mode = permissionModeForAccess(access);
  options.onProgress?.({ phase: "picking" });
  assertUserSpaceGeneration(generation);
  const root =
    getTestWorkspaceRoot() ||
    (await (
      window as unknown as {
        showDirectoryPicker(options?: {
          mode?: PermissionMode;
        }): Promise<BrowserFileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode }));
  assertUserSpaceGeneration(generation);
  options.onProgress?.({ phase: "permission", rootName: root.name });
  assertUserSpaceGeneration(generation);
  await ensurePermission(root, mode);
  assertUserSpaceGeneration(generation);

  const mount: UserSpaceMount = {
    ...expected,
    mountId: expected.mountId,
    name: root.name,
    rootName: root.name,
    status: "mounted",
    access,
    canRead: true,
    canWrite: access === "readwrite",
    permissionState: "granted",
    lastPermissionCheckedAt: Date.now(),
    includeHidden: true,
  };

  const mounted = registerMountedWorkspace(mount, root, options.persistenceScope || null);
  await queuePersistMountedWorkspace(mounted, root).catch(() => undefined);
  assertUserSpaceGeneration(generation);
  startBackgroundWorkspaceIndex(mounted.mountId);
  options.onProgress?.({
    phase: "ready",
    rootName: mounted.rootName,
    fileCount: mounted.fileCount,
    lastIndexedAt: mounted.lastIndexedAt,
  });
  assertUserSpaceGeneration(generation);
  return mounted;
}

export async function updateUserSpaceAccess(
  mountId: string,
  access: UserSpaceAccess,
): Promise<UserSpaceMount> {
  const workspace = requireWorkspace(mountId);
  const lease = captureWorkspaceLease(workspace);
  const mode = permissionModeForAccess(access);
  await ensurePermission(workspace.root, mode);
  assertWorkspaceLease(lease);
  const updated = withPermissionSnapshot(
    {
      ...workspace.mount,
      access,
      status: "mounted",
    },
    "granted",
  );
  workspace.mount = updated;
  await queuePersistMountedWorkspace(updated, workspace.root).catch(() => undefined);
  assertWorkspaceLease(lease);
  notifyMountChanged(mountId);
  return { ...updated };
}

export async function renameUserSpaceMount(
  mountId: string,
  rootName: string,
): Promise<UserSpaceMount> {
  const workspace = requireWorkspace(mountId);
  const nextRootName = rootName.trim();
  if (!nextRootName) throw new Error(uiCopy.userSpace.mountNameConflictDialog.enterName);
  const existingNames = Array.from(mounts.values())
    .filter((item) => item.mount.mountId !== mountId)
    .map((item) => item.mount.rootName);
  if (hasUserSpaceRootNameConflict(nextRootName, existingNames)) {
    throw new Error(uiCopy.userSpace.runtimeErrors.mountNameConflict(nextRootName));
  }
  workspace.mount = {
    ...workspace.mount,
    name: nextRootName,
    rootName: nextRootName,
  };
  await queuePersistMountedWorkspace(workspace.mount, workspace.root).catch(() => undefined);
  notifyMountChanged(mountId);
  return { ...workspace.mount };
}

export async function discardUnattachedUserSpaceMount(mountId: string): Promise<void> {
  if (isMountedWorkspaceReferenced(mountId)) return;
  const workspace = mounts.get(mountId);
  if (!workspace) return;
  if (workspace.persistenceScope) {
    await userSpacePersistence.forget(workspace.persistenceScope, mountId).catch(() => undefined);
  }
  releaseMountedWorkspace(mountId);
}

export function attachUserSpaceMountsToSession(sessionId: string, mountIds: string[]): void {
  const known = mountIds.filter((mountId) => mounts.has(mountId));
  if (known.length === 0) return;
  const previous = sessionMounts.get(sessionId) || new Set<string>();
  const next = new Set(known);
  const removed = [...previous].filter((mountId) => !next.has(mountId));
  const changed = previous.size !== next.size || known.some((mountId) => !previous.has(mountId));
  if (!changed) return;
  sessionMounts.set(sessionId, next);
  sendSessionStatus(sessionId);
  for (const mountId of removed) {
    if (!isMountedWorkspaceReferenced(mountId)) releaseMountedWorkspace(mountId);
  }
}

export function resendSessionUserSpaces(
  sessionId: string,
  options: { force?: boolean } = {},
): void {
  if (options.force) lastSessionStatusSignatures.delete(sessionId);
  sendSessionStatus(sessionId);
}

export async function syncUserSpaceMetadata(mountId: string): Promise<UserSpaceMount> {
  return rebuildUserSpaceMetadata(mountId);
}

export function syncSessionUserSpaces(sessionId: string, expectedMounts?: UserSpaceMount[]): void {
  if (!expectedMounts?.length) return;
  const expectedIds = expectedMounts.map((mount) => mount.mountId);
  const set = sessionMounts.get(sessionId) || new Set<string>();
  let changed = !sessionMounts.has(sessionId);
  for (const mountId of expectedIds) {
    if (set.has(mountId)) continue;
    set.add(mountId);
    changed = true;
  }
  if (changed) sessionMounts.set(sessionId, set);
  const mounted = expectedIds.filter((mountId) => mounts.has(mountId));
  if (mounted.length === 0) return;
  if (
    changed ||
    expectedMounts.some((mount) => mount.status !== "mounted" && mounts.has(mount.mountId))
  ) {
    sendSessionStatus(sessionId);
  }
}

export function detachUserSpaceFromSession(sessionId: string, mountId: string): void {
  const set = sessionMounts.get(sessionId);
  set?.delete(mountId);
  if (set && set.size === 0) sessionMounts.delete(sessionId);
  lastSessionStatusSignatures.delete(sessionId);
  transport?.(sessionId, { type: "user_space_unmount", mountId });
  if (!isMountedWorkspaceReferenced(mountId)) releaseMountedWorkspace(mountId);
}

export async function getUserSpaceFile(mountId: string, path: string): Promise<File> {
  const workspace = requireWorkspace(mountId);
  const lease = captureWorkspaceLease(workspace);
  const file = await getFileSnapshot(workspace, normalizeRequiredPath(path));
  assertWorkspaceLease(lease);
  return file;
}

export async function saveUserSpaceFile(
  mountId: string,
  path: string,
  file: Blob,
  options: { create?: boolean } = {},
): Promise<{ mountId: string; path: string; bytesWritten: number; mtime: number }> {
  const workspace = requireWorkspace(mountId);
  requireWritableWorkspace(workspace);
  const normalizedPath = normalizeRequiredPath(path);
  return withUserSpaceFileMutation(workspace, normalizedPath, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const handle = await getFileHandle(workspace, normalizedPath, options.create === true, lease);
    assertWorkspaceLease(lease);
    const writable = await handle.createWritable();
    await commitWritableFile(lease, writable, file);
    const updated = await handle.getFile();
    assertWorkspaceLease(lease);
    await upsertFileMetadata(workspace, normalizedPath, handle);
    assertWorkspaceLease(lease);
    notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(normalizedPath));
    recordOperation(
      { mountId: workspace.mount.mountId, path: normalizedPath },
      "write_file",
      "ok",
      "Saved preview file",
      undefined,
      lease,
    );
    return {
      mountId: workspace.mount.mountId,
      path: normalizedPath,
      bytesWritten: updated.size,
      mtime: updated.lastModified,
    };
  });
}

export async function handleUserSpaceBlobCheckoutRequest(
  request: BlobCheckoutRequest,
): Promise<void> {
  let lease: UserSpaceWorkspaceLease | undefined;
  try {
    const workspace = requireWorkspace(request.mountId);
    lease = captureWorkspaceLease(workspace);
    const path = normalizeRequiredPath(request.path);
    await assertWorkspaceReadPermission(lease);
    const file = await getFileSnapshot(workspace, path);
    assertWorkspaceLease(lease);
    if (file.size > request.maxBytes) {
      throw new Error(`File exceeds the ${request.maxBytes}-byte User Space transfer limit.`);
    }
    const uploadInit: RequestInit = {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      credentials: "include",
      body: file,
    };
    const upload = await fetch(request.uploadUrl, uploadInit);
    await assertWorkspaceReadPermission(lease);
    if (!upload.ok) throw new Error(await responseErrorText(upload, "Checkout upload failed."));
    await completeBlobTransfer(request.completeUrl, {
      ok: true,
      size: file.size,
      mtime: file.lastModified,
      mime: file.type || undefined,
    });
    assertWorkspaceLease(lease);
    recordOperation(
      { mountId: request.mountId, path },
      "read_file",
      "ok",
      "Blob checkout uploaded",
      undefined,
      lease,
    );
  } catch (error) {
    await completeBlobTransfer(request.completeUrl, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    recordOperation(
      { mountId: request.mountId, path: request.path },
      "read_file",
      "error",
      error instanceof Error ? error.message : String(error),
      undefined,
      lease,
    );
    throw error;
  }
}

export async function handleUserSpaceBlobCheckinRequest(
  request: BlobCheckinRequest,
): Promise<void> {
  let commitLease: string | undefined;
  let committedResult: Record<string, unknown> | undefined;
  let terminalSuccessAttempted = false;
  let lease: UserSpaceWorkspaceLease | undefined;
  try {
    const workspace = requireWorkspace(request.mountId);
    lease = captureWorkspaceLease(workspace);
    requireWritableWorkspace(workspace);
    const path = normalizeRequiredPath(request.path);
    await withUserSpaceFileMutation(workspace, path, async (mutationLease) => {
      lease = mutationLease;
      const assertCheckinBaseUnchanged = async () => {
        if (request.create === true) {
          await assertUserSpacePathAvailable(workspace, path);
          assertWorkspaceLease(mutationLease);
          return;
        }
        const current = await getFileSnapshot(workspace, path);
        assertWorkspaceLease(mutationLease);
        const currentHash = await sha256Blob(current);
        assertWorkspaceLease(mutationLease);
        if (currentHash !== request.baseHash) {
          throw new Error(uiCopy.userSpace.runtimeErrors.checkoutChanged);
        }
        if (typeof request.baseMtime === "number" && current.lastModified !== request.baseMtime) {
          throw new Error(uiCopy.userSpace.runtimeErrors.checkoutTimestampChanged);
        }
      };
      await assertCheckinBaseUnchanged();

      const download = await fetch(request.downloadUrl, {
        credentials: "include",
      });
      assertWorkspaceLease(mutationLease);
      if (!download.ok)
        throw new Error(await responseErrorText(download, "Checkin download failed."));
      const blob = await download.blob();
      if (blob.size !== request.size) {
        throw new Error(
          `Downloaded checkin size did not match manifest (${blob.size} !== ${request.size}).`,
        );
      }
      const hash = await sha256Blob(blob);
      if (hash !== request.hash) {
        throw new Error("Downloaded checkin content hash did not match manifest.");
      }

      // Authorization is the cross-process point of no return. The server keeps
      // runtime revocation draining until this browser reports a terminal result.
      const authorizedCommitLease = await authorizeBlobCheckinCommit(request.commitUrl);
      commitLease = authorizedCommitLease;
      await prepareWorkspaceWrite(mutationLease);
      // The user or another browser process can change the remote file while
      // download, hashing, and commit authorization are awaiting. Re-check at
      // the last safe point before createWritable() so stale checkout bytes do
      // not silently overwrite that newer content.
      await assertCheckinBaseUnchanged();
      const handle = await getFileHandle(workspace, path, request.create === true, mutationLease);
      assertWorkspaceLease(mutationLease);
      const writable = await handle.createWritable();
      await commitWritableFile(mutationLease, writable, blob, () => {
        committedResult = {
          ok: true,
          size: request.size,
          hash,
          commitLease: authorizedCommitLease,
        };
      });
      const updated = await handle.getFile();
      assertWorkspaceLease(mutationLease);
      committedResult = {
        ok: true,
        size: updated.size,
        mtime: updated.lastModified,
        hash,
        commitLease: authorizedCommitLease,
      };
      terminalSuccessAttempted = true;
      await completeBlobTransfer(request.completeUrl, committedResult);
      assertWorkspaceLease(mutationLease);
      await upsertFileMetadata(workspace, path, handle);
      assertWorkspaceLease(mutationLease);
      notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(path));
      recordOperation(
        { mountId: request.mountId, path },
        "write_file",
        "ok",
        "Blob checkin wrote file",
        undefined,
        mutationLease,
      );
    });
  } catch (error) {
    if (committedResult) {
      // close() is the irreversible native filesystem boundary. Once crossed,
      // never downgrade the broker outcome to failure: either report the same
      // success manifest or leave it pending so revocation fails closed.
      if (!terminalSuccessAttempted) {
        terminalSuccessAttempted = true;
        await completeBlobTransfer(request.completeUrl, committedResult).catch(() => undefined);
      }
    } else {
      await completeBlobTransfer(request.completeUrl, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(commitLease ? { commitLease } : {}),
      }).catch(() => undefined);
    }
    recordOperation(
      { mountId: request.mountId, path: request.path },
      "write_file",
      "error",
      error instanceof Error ? error.message : String(error),
      undefined,
      lease,
    );
    throw error;
  }
}

export async function executeUserSpaceOperation(
  operation: UserSpaceOperation,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const initialWorkspace =
    typeof input.mountId === "string" ? mounts.get(input.mountId) : undefined;
  const lease = initialWorkspace ? captureWorkspaceLease(initialWorkspace) : undefined;
  try {
    const result = await executeOperation(operation, input);
    recordOperation(input, operation, "ok", "Completed", result, lease);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordOperation(input, operation, "error", message, undefined, lease);
    throw error;
  }
}

async function executeOperation(
  operation: UserSpaceOperation,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "list_mounts":
      return { mounts: getMountedUserSpaces() };
    case "list_dir":
      return listDir(input);
    case "read_file":
      return readFile(input);
    case "search_paths":
      return searchWorkspacePaths(input);
    case "search":
      return searchWorkspace(input);
    case "glob":
      return globWorkspacePaths(input);
    case "shell_exec":
      return executeShell(input);
    case "create_entry":
      return createEntry(input);
    case "rename_entry":
      return renameEntry(input);
    case "copy_entry":
      return copyEntry(input);
    case "copy_entries":
      return copyEntries(input);
    case "duplicate_entry":
      return duplicateEntry(input);
    case "move_entries":
      return moveEntries(input);
    case "write_file":
      return writeFile(input);
    case "replace_text":
      return replaceText(input);
    case "delete_entry":
      return deleteEntry(input);
    default:
      throw new Error(uiCopy.userSpace.runtimeErrors.unsupportedOperation(operation));
  }
}

async function listDir(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  const path = normalizeUserSpacePath(typeof input.path === "string" ? input.path : "");
  const includeHidden = input.includeHidden === true;
  const limit = clampNumber(input.limit, 1, 200, 80);
  const offset = clampNumber(input.cursor, 0, Number.MAX_SAFE_INTEGER, 0);

  return directListDir(workspace, path, limit, offset, includeHidden);
}

async function directListDir(
  workspace: MountedWorkspace,
  path: string,
  limit: number,
  offset: number,
  includeHidden: boolean,
): Promise<{
  mountId: string;
  path: string;
  entries: UserSpaceEntry[];
  nextCursor?: string;
  loaded: number;
  total?: number;
}> {
  const page = await readDirectoryPage(workspace, path, limit, offset, includeHidden);
  void workspace.runtime
    .addEntries(page.entries.map(workspaceEntryToIndexedEntry))
    .catch(() => undefined);
  return {
    mountId: workspace.mount.mountId,
    path,
    entries: page.entries,
    nextCursor: page.nextCursor,
    loaded: page.loaded,
  };
}

async function readFile(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  const path = normalizeRequiredPath(input.path);
  const file = await getFileSnapshot(workspace, path);
  const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
  const isBinary = looksBinary(sample);

  if (isBinary) {
    return {
      kind: "blob",
      mountId: workspace.mount.mountId,
      path,
      size: file.size,
      mtime: file.lastModified,
      mime: file.type || undefined,
      isBinary: true,
      canCheckout: false,
      hint: "Use checkout rootName/path to obtain a session-relative Agent Space shared/path, then leave user-space bash and process it with normal Agent Space tools. Use checkin shared/path rootName/path to return it explicitly.",
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(input, "startLine") ||
    Object.prototype.hasOwnProperty.call(input, "endLine")
  ) {
    throw new Error(
      "read_file uses only pi's 1-based offset plus limit; startLine/endLine are not supported.",
    );
  }
  const offset = optionalPositiveInteger(input.offset, "offset");
  const limit = optionalPositiveInteger(input.limit, "limit");
  const result = readTextLikePi(await file.text(), path, offset, limit);

  return {
    mountId: workspace.mount.mountId,
    path,
    size: file.size,
    bytesRead: file.size,
    truncated: result.truncated,
    truncatedBy: result.truncatedBy,
    totalLines: result.totalLines,
    outputLines: result.outputLines,
    nextOffset: result.nextOffset,
    isBinary: false,
    content: result.content,
  };
}

async function searchWorkspacePaths(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  const query = requireString(input.query, "query");
  const includeHidden = input.includeHidden === true;
  const limit = clampNumber(input.limit, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
  await workspace.runtime.indexSubtree("");
  return {
    mountId: workspace.mount.mountId,
    query,
    ...(await workspace.runtime.searchPaths(query, limit, cursor, includeHidden)),
  };
}

async function globWorkspacePaths(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  const pattern = requireString(input.pattern, "pattern");
  const pathPrefix = normalizeUserSpacePath(
    typeof input.pathPrefix === "string" ? input.pathPrefix : "",
  );
  const includeHidden = input.includeHidden === true;
  const filesOnly = input.filesOnly === true;
  const directoriesOnly = input.directoriesOnly === true;
  if (filesOnly && directoriesOnly)
    throw new Error("glob cannot combine filesOnly and directoriesOnly.");
  const limit = clampNumber(input.limit, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const matcher = globToRegExp(pattern);
  const entries: IndexedWorkspaceEntry[] = [];
  let cursor: string | undefined;
  let truncated = false;

  await workspace.runtime.indexSubtree(pathPrefix);
  do {
    const page = await workspace.runtime.walkTree(pathPrefix, {
      includeRoot: false,
      limit: Math.min(1000, Math.max(1, limit - entries.length)),
      cursor,
      includeHidden,
    });
    for (const entry of page.entries) {
      const relativePath =
        pathPrefix && entry.path.startsWith(`${pathPrefix}/`)
          ? entry.path.slice(pathPrefix.length + 1)
          : entry.path;
      if (filesOnly && entry.kind !== "file") continue;
      if (directoriesOnly && entry.kind !== "directory") continue;
      if (!matcher.test(relativePath)) continue;
      entries.push(entry);
      if (entries.length >= limit) {
        truncated =
          Boolean(page.nextCursor) || page.entries.indexOf(entry) < page.entries.length - 1;
        break;
      }
    }
    if (entries.length >= limit) break;
    cursor = page.nextCursor;
  } while (cursor);

  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { mountId: workspace.mount.mountId, pattern, pathPrefix, entries, truncated };
}

async function searchWorkspace(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  const query = requireString(input.query, "query");
  const mode = input.mode === "regex" ? "regex" : "text";
  const pathPrefix = normalizeUserSpacePath(
    typeof input.pathPrefix === "string" ? input.pathPrefix : "",
  );
  const includeHidden = input.includeHidden === true;
  const ignoreCase = input.ignoreCase === true;
  const invert = input.invert === true;
  const includeMatchers = toStringArray(input.includeGlobs).map(createWorkspaceGlobMatcher);
  const excludeMatchers = toStringArray(input.excludeGlobs).map(createWorkspaceGlobMatcher);
  const limit = clampNumber(input.limit, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const contextLines = clampNumber(input.contextLines, 0, 10, 2);
  const matcher = mode === "regex" ? new RegExp(query, ignoreCase ? "i" : "") : null;
  const textQuery = ignoreCase ? query.toLowerCase() : query;
  const matches: Array<{
    path: string;
    lineNumber: number;
    line: string;
    contextBefore: string[];
    contextAfter: string[];
  }> = [];
  let visited = 0;

  const startEntry = pathPrefix ? await findShellEntry(workspace, pathPrefix) : null;
  if (startEntry?.kind !== "file" && includeMatchers.length === 0 && excludeMatchers.length === 0) {
    await workspace.runtime.indexSubtree(pathPrefix);
    return {
      mountId: workspace.mount.mountId,
      query,
      mode,
      ...(await workspace.runtime.searchContent({
        query,
        mode,
        pathPrefix,
        includeHidden,
        ignoreCase,
        invert,
        limit,
        contextLines,
      })),
    };
  }
  const source =
    startEntry?.kind === "file"
      ? singleWorkspaceFile(pathPrefix, startEntry.size)
      : walkWorkspace(workspace, pathPrefix);

  for await (const item of source) {
    if (item.kind !== "file") continue;
    if (!includeHidden && isHiddenWorkspacePath(item.path)) continue;
    if (
      includeMatchers.length > 0 &&
      !includeMatchers.some((matcher) => matchesWorkspaceGlob(matcher, item.path))
    )
      continue;
    if (excludeMatchers.some((matcher) => matchesWorkspaceGlob(matcher, item.path))) continue;

    visited++;

    const file = await getFileSnapshot(workspace, item.path);
    const firstBytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (looksBinary(firstBytes)) continue;

    const text = await file.text();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const hit = matcher
        ? matcher.test(line)
        : (ignoreCase ? line.toLowerCase() : line).includes(textQuery);
      if (invert ? hit : !hit) continue;
      matches.push({
        path: item.path,
        lineNumber: index + 1,
        line,
        contextBefore: lines.slice(Math.max(0, index - contextLines), index),
        contextAfter: lines.slice(index + 1, index + 1 + contextLines),
      });
      if (matches.length >= limit) {
        return { mountId: workspace.mount.mountId, query, mode, matches, truncated: true };
      }
    }
    if (visited % 50 === 0) await yieldToBrowser();
  }

  return { mountId: workspace.mount.mountId, query, mode, matches, truncated: false };
}

async function* singleWorkspaceFile(
  path: string,
  size?: number,
): AsyncGenerator<{ path: string; kind: FileSystemHandleKind; size?: number }> {
  yield { path, kind: "file", size };
}

async function executeShell(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  return executeUserSpaceShell({
    mountId: workspace.mount.mountId,
    rootName: workspace.mount.rootName,
    input,
    createFileSystem: (visibility) => new UserSpaceBashFs(workspace, visibility),
  });
}

class UserSpaceBashFs implements UserSpaceShellFileSystem {
  private readonly entryCache = new Map<string, IndexedWorkspaceEntry>();
  private readonly changedDirs = new Set<string>();
  private pathSnapshot: string[] = [];
  private readonly symlinks = new Map<string, string>();
  readonly userSpaceShellKind = "piwork-user-space" as const;
  readonly shellMountName: string;
  readonly shellMountPath: string;

  constructor(
    private readonly workspace: MountedWorkspace,
    private readonly visibility: UserSpaceShellVisibility,
  ) {
    this.shellMountName = shellMountNameForWorkspace(workspace);
    this.shellMountPath = shellMountPathForName(this.shellMountName);
  }

  changedDirectoryPaths(): string[] {
    return Array.from(this.changedDirs).sort((left, right) => left.localeCompare(right));
  }

  async primePathSnapshot(): Promise<void> {
    await this.workspace.runtime.indexSubtree("");
    const paths: string[] = ["/", this.shellMountPath];
    let cursor: string | undefined;
    do {
      const page = await this.workspace.runtime.walkTree("", {
        includeRoot: false,
        limit: 1000,
        cursor,
        includeHidden: this.visibility.searchHiddenEntries,
      });
      paths.push(
        ...page.entries.map((entry) => userPathToShellPath(entry.path, this.shellMountPath)),
      );
      cursor = page.nextCursor;
    } while (cursor);
    this.pathSnapshot = paths;
  }

  async indexSubtree(path: string, maxDepth?: number): Promise<void> {
    await this.workspace.runtime.indexSubtree(
      shellPathToIndexedUserPath(path, this.shellMountPath),
      maxDepth,
    );
  }

  async searchIndexedContent(input: {
    query: string;
    mode: "text" | "regex";
    path: string;
    ignoreCase: boolean;
    invert: boolean;
    limit: number;
    contextLines: number;
  }): Promise<{ matches: IndexedWorkspaceContentMatch[]; truncated?: boolean }> {
    const pathPrefix = shellPathToIndexedUserPath(input.path, this.shellMountPath);
    await this.workspace.runtime.indexSubtree(pathPrefix);
    return this.workspace.runtime.searchContent({
      query: input.query,
      mode: input.mode,
      pathPrefix,
      includeHidden: this.visibility.searchHiddenEntries,
      ignoreCase: input.ignoreCase,
      invert: input.invert,
      limit: input.limit,
      contextLines: input.contextLines,
    });
  }

  async globIndexedPaths(input: {
    pattern: string;
    path: string;
    filesOnly: boolean;
    directoriesOnly: boolean;
    limit: number;
  }): Promise<{ entries: IndexedWorkspaceEntry[]; truncated?: boolean }> {
    const result = (await globWorkspacePaths({
      mountId: this.workspace.mount.mountId,
      pattern: input.pattern,
      pathPrefix: shellPathToIndexedUserPath(input.path, this.shellMountPath),
      includeHidden: this.visibility.searchHiddenEntries,
      filesOnly: input.filesOnly,
      directoriesOnly: input.directoriesOnly,
      limit: input.limit,
    })) as { entries: IndexedWorkspaceEntry[]; truncated?: boolean };
    return { entries: result.entries, truncated: result.truncated };
  }

  async listEntries(path: string, includeHidden: boolean): Promise<IndexedWorkspaceEntry[]> {
    if (isShellVirtualRoot(path, this.shellMountPath))
      return [shellMountRootEntry(this.shellMountName)];
    return listShellEntries(
      this.workspace,
      shellPathToUserPath(path, this.shellMountPath),
      this.entryCache,
      includeHidden,
      true,
    );
  }

  includeHiddenForTree(): boolean {
    return this.visibility.showHiddenEntries;
  }

  includeHiddenForFind(): boolean {
    return this.visibility.searchHiddenEntries;
  }

  async findEntry(path: string): Promise<IndexedWorkspaceEntry | null> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      return shellMountRootEntry(this.shellMountName);
    return findShellEntry(
      this.workspace,
      shellPathToUserPath(path, this.shellMountPath),
      this.entryCache,
    );
  }

  async readFile(path: string, _options?: ShellReadFileOptions | BufferEncoding): Promise<string> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      throw new Error("Is a directory");
    const bytes = await this.readFileBuffer(this.resolveSymlinkPath(path));
    return new TextDecoder("utf-8").decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      throw new Error("Is a directory");
    return readShellFileBytes(
      this.workspace,
      shellPathToUserPath(this.resolveSymlinkPath(path), this.shellMountPath),
      this.entryCache,
    );
  }

  async readRawFileBuffer(path: string): Promise<Uint8Array> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      throw new Error("Is a directory");
    return readShellRawFileBytes(
      this.workspace,
      shellPathToUserPath(this.resolveSymlinkPath(path), this.shellMountPath),
      this.entryCache,
    );
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: ShellWriteFileOptions | BufferEncoding,
  ): Promise<void> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      throw new Error("Is a directory");
    const userPath = shellPathToUserPath(this.resolveSymlinkPath(path), this.shellMountPath);
    await writeShellFile(this.workspace, userPath, normalizeShellWriteContent(content, _options));
    this.markChangedFilePath(userPath);
    this.entryCache.clear();
    await this.primePathSnapshot();
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: ShellWriteFileOptions | BufferEncoding,
  ): Promise<void> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      throw new Error("Is a directory");
    const resolvedPath = this.resolveSymlinkPath(path);
    const userPath = shellPathToUserPath(resolvedPath, this.shellMountPath);
    await withUserSpaceFileMutation(this.workspace, userPath, async (lease) => {
      const nextContent = normalizeShellWriteContent(content, _options);
      let existing: Uint8Array = new Uint8Array();
      if (await this.exists(resolvedPath)) {
        existing = isShellBinaryEncoding(shellWriteEncoding(_options))
          ? await readShellRawFileBytes(this.workspace, userPath, this.entryCache)
          : await readShellFileBytes(this.workspace, userPath, this.entryCache);
      }
      const next = concatBytes(existing, fileContentToBytes(nextContent));
      assertWorkspaceLease(lease);
      await writeShellFileUnlocked(this.workspace, userPath, next, lease);
    });
    this.markChangedFilePath(userPath);
    this.entryCache.clear();
    await this.primePathSnapshot();
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeShellPath(path, "/");
    if (this.symlinks.has(normalized)) return true;
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      return directoryStat(this.workspace);
    const userPath = shellPathToUserPath(this.resolveSymlinkPath(path), this.shellMountPath);
    if (!userPath) return directoryStat(this.workspace);
    const entry = await requireShellEntry(this.workspace, userPath, this.entryCache);
    return entryToFsStat(entry, this.workspace);
  }

  async lstat(path: string): Promise<FsStat> {
    const normalized = normalizeShellPath(path, "/");
    if (this.symlinks.has(normalized)) {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: 0o777,
        size: this.symlinks.get(normalized)?.length || 0,
        mtime: new Date(0),
      };
    }
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      return;
    const userPath = shellPathToUserPath(path, this.shellMountPath);
    if (!userPath) return;
    requireWritableWorkspace(this.workspace);
    await withUserSpaceWorkspaceMutation(this.workspace, async (lease) => {
      await prepareWorkspaceWrite(lease);
      if (options?.recursive) {
        await getDirectory(this.workspace, userPath, true, lease);
      } else {
        const { parent, name } = await getParentDirectory(this.workspace, userPath, false, lease);
        await assertWorkspaceWritePermission(lease);
        const dir = await parent.getDirectoryHandle(name, { create: true });
        assertWorkspaceLease(lease);
        setCachedDirectoryHandle(this.workspace, userPath, dir);
      }
      this.entryCache.clear();
      await upsertDirectoryMetadata(this.workspace, userPath);
      assertWorkspaceLease(lease);
      this.markChangedDirectoryPath(userPath);
      await this.primePathSnapshot();
      assertWorkspaceLease(lease);
      notifyMountChanged(this.workspace.mount.mountId, this.changedDirectoryPaths());
    });
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = normalizeShellPath(path, "/");
    if (isShellVirtualRoot(normalized, this.shellMountPath)) return [this.shellMountName];
    const entries = (
      await listShellEntries(
        this.workspace,
        shellPathToUserPath(normalized, this.shellMountPath),
        this.entryCache,
        this.visibility.showHiddenEntries,
      )
    ).map((entry) => entry.name);
    return mergeShellEntryNames(
      entries,
      this.symlinkEntriesForDirectory(normalized).map((entry) => entry.name),
    );
  }

  async readdirWithFileTypes(path: string): Promise<ShellDirentEntry[]> {
    const normalized = normalizeShellPath(path, "/");
    if (isShellVirtualRoot(normalized, this.shellMountPath))
      return [shellMountRootDirent(this.shellMountName)];
    const physicalEntries = (
      await listShellEntries(
        this.workspace,
        shellPathToUserPath(normalized, this.shellMountPath),
        this.entryCache,
        this.visibility.showHiddenEntries,
      )
    ).map((entry) => ({
      name: entry.name,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "directory",
      isSymbolicLink: false,
    }));
    return mergeShellDirentEntries(physicalEntries, this.symlinkEntriesForDirectory(normalized));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalizedPath = normalizeShellPath(path, "/");
    if (this.symlinks.delete(normalizedPath)) {
      await this.primePathSnapshot();
      return;
    }
    const userPath = shellPathToUserPath(path, this.shellMountPath);
    if (!userPath) throw new Error("Cannot remove user-space root.");
    requireWritableWorkspace(this.workspace);
    await withUserSpaceFileMutation(this.workspace, userPath, async (lease) => {
      await prepareWorkspaceWrite(lease);
      try {
        const entry = await requireShellEntry(this.workspace, userPath, this.entryCache);
        assertWorkspaceLease(lease);
        if (entry.kind === "directory" && !options?.recursive) {
          const children = await listShellEntries(this.workspace, userPath, this.entryCache, true);
          assertWorkspaceLease(lease);
          if (children.length > 0) throw new Error("Directory not empty");
        }
        const { parent, name } = await getParentDirectory(this.workspace, userPath, false, lease);
        await assertWorkspaceWritePermission(lease);
        await parent.removeEntry(name, { recursive: options?.recursive === true });
        assertWorkspaceLease(lease);
        removeCachedPath(this.workspace, userPath);
        this.entryCache.clear();
        await this.workspace.runtime.removePath(userPath).catch(() => undefined);
        assertWorkspaceLease(lease);
        this.markChangedFilePath(userPath);
        await this.primePathSnapshot();
        markWorkspaceIndexMaybeStale(this.workspace);
        notifyMountChanged(this.workspace.mount.mountId, this.changedDirectoryPaths());
      } catch (error) {
        if (!isWorkspaceLeaseCurrent(lease)) throw error;
        if (options?.force) return;
        throw error;
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcPath = shellPathToUserPath(src, this.shellMountPath);
    if (isShellVirtualRoot(dest, this.shellMountPath))
      throw new Error(`cp destination must be inside ${this.shellMountPath}.`);
    let destPath = shellPathToUserPath(dest, this.shellMountPath);
    if (!srcPath) throw new Error("cp requires file paths inside a mount.");
    const srcEntry = await requireShellEntry(this.workspace, srcPath, this.entryCache);
    if (srcEntry.kind === "directory") {
      if (options?.recursive) throw new Error("Directory copy is not available for user-space v1.");
      throw new Error("Omitting directory.");
    }
    const destEntry = isShellMountRoot(dest, this.shellMountPath)
      ? shellMountRootEntry(this.shellMountName)
      : await findShellEntry(this.workspace, destPath, this.entryCache);
    if (destEntry?.kind === "directory")
      destPath = joinUserPath(destPath, basenameUserPath(srcPath));
    await writeShellFile(
      this.workspace,
      destPath,
      await readShellFileBytes(this.workspace, srcPath, this.entryCache),
    );
    this.markChangedFilePath(destPath);
    this.entryCache.clear();
    await this.primePathSnapshot();
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcPath = shellPathToUserPath(src, this.shellMountPath);
    if (isShellVirtualRoot(dest, this.shellMountPath))
      throw new Error(`mv destination must be inside ${this.shellMountPath}.`);
    let destPath = shellPathToUserPath(dest, this.shellMountPath);
    if (!srcPath) throw new Error("mv requires file paths inside a mount.");
    const srcEntry = await requireShellEntry(this.workspace, srcPath, this.entryCache);
    if (srcEntry.kind === "directory")
      throw new Error("Directory move is not available for user-space v1.");
    const destEntry = isShellMountRoot(dest, this.shellMountPath)
      ? shellMountRootEntry(this.shellMountName)
      : await findShellEntry(this.workspace, destPath, this.entryCache);
    if (destEntry?.kind === "directory")
      destPath = joinUserPath(destPath, basenameUserPath(srcPath));
    await writeShellFile(
      this.workspace,
      destPath,
      await readShellFileBytes(this.workspace, srcPath, this.entryCache),
    );
    this.markChangedFilePath(destPath);
    await this.rm(userPathToShellPath(srcPath, this.shellMountPath), { force: false });
    this.entryCache.clear();
    await this.primePathSnapshot();
  }

  resolvePath(base: string, path: string): string {
    return normalizeShellPath(path, base);
  }

  getAllPaths(): string[] {
    return Array.from(new Set([...this.pathSnapshot, ...Array.from(this.symlinks.keys())])).sort(
      (left, right) => left.localeCompare(right),
    );
  }

  async chmod(path: string): Promise<void> {
    await this.lstat(path);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalizedLink = normalizeShellPath(linkPath, "/");
    if (!normalizedLink || normalizedLink === "/" || normalizedLink === this.shellMountPath)
      throw new Error("Invalid symlink path.");
    shellPathToUserPath(normalizedLink, this.shellMountPath);
    if (await this.exists(normalizedLink)) throw new Error("File exists");
    this.symlinks.set(normalizedLink, target);
    await this.primePathSnapshot();
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const resolvedExisting = this.resolveSymlinkPath(existingPath);
    const srcPath = shellPathToUserPath(resolvedExisting, this.shellMountPath);
    if (
      isShellVirtualRoot(newPath, this.shellMountPath) ||
      isShellMountRoot(newPath, this.shellMountPath)
    )
      throw new Error("Invalid link path.");
    const destPath = shellPathToUserPath(newPath, this.shellMountPath);
    if (!srcPath || !destPath) throw new Error("link requires file paths inside a mount.");
    const srcEntry = await requireShellEntry(this.workspace, srcPath, this.entryCache);
    if (srcEntry.kind === "directory") throw new Error("Hard link not allowed for directory.");
    if (await this.exists(newPath)) throw new Error("File exists");
    await writeShellFile(
      this.workspace,
      destPath,
      await readShellFileBytes(this.workspace, srcPath, this.entryCache),
    );
    this.markChangedFilePath(destPath);
    this.entryCache.clear();
    await this.primePathSnapshot();
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizeShellPath(path, "/");
    const target = this.symlinks.get(normalized);
    if (target === undefined) throw new Error("Invalid argument");
    return target;
  }

  async realpath(path: string): Promise<string> {
    const normalized = this.resolveSymlinkPath(path);
    await this.stat(normalized);
    return normalized;
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    if (
      isShellVirtualRoot(path, this.shellMountPath) ||
      isShellMountRoot(path, this.shellMountPath)
    )
      return;
    const userPath = shellPathToUserPath(path, this.shellMountPath);
    if (!userPath) return;
    if (!(await this.exists(path))) {
      await writeShellFile(this.workspace, userPath, "");
      this.markChangedFilePath(userPath);
    }
    await this.primePathSnapshot();
  }

  private markChangedFilePath(path: string): void {
    this.markChangedDirectoryPath(dirnameUserPath(path));
  }

  private markChangedDirectoryPath(path: string): void {
    let current = normalizeUserSpacePath(path);
    while (true) {
      this.changedDirs.add(current);
      if (!current) return;
      current = dirnameUserPath(current);
    }
  }

  private resolveSymlinkPath(path: string, seen = new Set<string>()): string {
    const normalized = normalizeShellPath(path, "/");
    const target = this.symlinks.get(normalized);
    if (target === undefined) return normalized;
    if (seen.has(normalized)) throw new Error("Too many levels of symbolic links");
    seen.add(normalized);
    const parent = dirnameUserPath(shellPathToUserPath(normalized, this.shellMountPath));
    return this.resolveSymlinkPath(
      normalizeShellPath(target, userPathToShellPath(parent, this.shellMountPath)),
      seen,
    );
  }

  private symlinkEntriesForDirectory(path: string): ShellDirentEntry[] {
    if (isShellVirtualRoot(path, this.shellMountPath)) return [];
    const userPath = shellPathToUserPath(path, this.shellMountPath);
    return Array.from(this.symlinks.keys())
      .filter(
        (linkPath) =>
          dirnameUserPath(shellPathToUserPath(linkPath, this.shellMountPath)) === userPath,
      )
      .map((linkPath) => ({
        name: basenameUserPath(shellPathToUserPath(linkPath, this.shellMountPath)),
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
      }));
  }
}

function shellMountNameForWorkspace(workspace: MountedWorkspace): string {
  const raw = (
    workspace.mount.rootName ||
    workspace.mount.name ||
    USER_SPACE_BASH_MOUNT_NAME
  ).trim();
  return raw.replace(/\//g, "-").replace(/^\/+|\/+$/g, "") || USER_SPACE_BASH_MOUNT_NAME;
}

function shellPathToIndexedUserPath(path: string, shellMountPath: string): string {
  // `/` is the shell's virtual root. It contains exactly the active User Space
  // mount, so recursive index-backed commands should search that whole mount.
  if (isShellVirtualRoot(path, shellMountPath)) return "";
  return shellPathToUserPath(path, shellMountPath);
}

function directoryStat(workspace: MountedWorkspace): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    mode: shellDirectoryMode(workspace),
    size: 0,
    mtime: new Date(0),
  };
}

function entryToFsStat(entry: IndexedWorkspaceEntry, workspace: MountedWorkspace): FsStat {
  return {
    isFile: entry.kind === "file",
    isDirectory: entry.kind === "directory",
    isSymbolicLink: false,
    mode: entry.kind === "directory" ? shellDirectoryMode(workspace) : shellFileMode(workspace),
    size: entry.size || 0,
    mtime: new Date(entry.lastModified || 0),
  };
}

function shellDirectoryMode(workspace: MountedWorkspace): number {
  return workspace.mount.canWrite ? 0o755 : 0o555;
}

function shellFileMode(workspace: MountedWorkspace): number {
  return workspace.mount.canWrite ? 0o644 : 0o444;
}

function shellMountRootEntry(name = DEFAULT_USER_SPACE_SHELL_MOUNT_NAME): IndexedWorkspaceEntry {
  return {
    name,
    path: "",
    parentPath: "",
    kind: "directory",
    size: 0,
    lastModified: 0,
    ext: "",
    depth: 0,
    previewKind: "binary",
    hidden: false,
    contentIndexed: false,
  };
}

function shellMountRootDirent(name = DEFAULT_USER_SPACE_SHELL_MOUNT_NAME): ShellDirentEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
  };
}

function mergeShellEntryNames(left: string[], right: string[]): string[] {
  return Array.from(new Set([...left, ...right])).sort((a, b) => a.localeCompare(b));
}

function mergeShellDirentEntries(
  left: ShellDirentEntry[],
  right: ShellDirentEntry[],
): ShellDirentEntry[] {
  const byName = new Map<string, ShellDirentEntry>();
  for (const entry of left) byName.set(entry.name, entry);
  for (const entry of right) byName.set(entry.name, entry);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function requireShellEntry(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<IndexedWorkspaceEntry> {
  const entry = await findShellEntry(workspace, path, cache);
  if (!entry) throw new Error("No such file or directory");
  return entry;
}

async function findShellEntry(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<IndexedWorkspaceEntry | null> {
  return findShellEntryWithLookupMode(workspace, path, cache, false);
}

async function findShellEntryStrict(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<IndexedWorkspaceEntry | null> {
  return findShellEntryWithLookupMode(workspace, path, cache, true);
}

async function findShellEntryWithLookupMode(
  workspace: MountedWorkspace,
  path: string,
  cache: Map<string, IndexedWorkspaceEntry> | undefined,
  failClosed: boolean,
): Promise<IndexedWorkspaceEntry | null> {
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) return null;
  const cached = cache?.get(normalized);
  if (cached) return cached;
  const pending = readAllDirectoryEntries(workspace, dirnameUserPath(normalized), cache);
  const direct = failClosed ? await pending : await pending.catch(() => []);
  for (const item of direct) {
    const indexed = workspaceEntryToIndexedEntry(item);
    cache?.set(indexed.path, indexed);
  }
  const found = direct.find((item) => item.name === basenameUserPath(normalized));
  return found ? workspaceEntryToIndexedEntry(found) : null;
}

async function listShellEntries(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
  includeHidden = true,
  preferIndex = false,
): Promise<IndexedWorkspaceEntry[]> {
  const normalized = normalizeUserSpacePath(path);
  if (normalized) {
    const entry = await requireShellEntry(workspace, normalized, cache);
    if (entry.kind !== "directory") throw new Error("Not a directory");
  }
  if (preferIndex || workspace.mount.lastIndexedAt) {
    const entries = await readAllRuntimeDirectoryEntries(workspace, normalized, includeHidden);
    for (const entry of entries) cache?.set(entry.path, entry);
    return entries;
  }
  const entries = (await readAllDirectoryEntries(workspace, normalized, cache)).map(
    workspaceEntryToIndexedEntry,
  );
  const visibleEntries = includeHidden ? entries : entries.filter((entry) => !entry.hidden);
  for (const entry of entries) cache?.set(entry.path, entry);
  return visibleEntries;
}

async function readAllRuntimeDirectoryEntries(
  workspace: MountedWorkspace,
  path: string,
  includeHidden: boolean,
): Promise<IndexedWorkspaceEntry[]> {
  const entries: IndexedWorkspaceEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await workspace.runtime.listDir(path, 500, cursor, includeHidden);
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

function workspaceEntryToIndexedEntry(entry: UserSpaceEntry): IndexedWorkspaceEntry {
  return {
    name: entry.name,
    path: entry.path,
    parentPath: dirnameUserPath(entry.path),
    kind: entry.kind,
    size: entry.size,
    lastModified: entry.lastModified,
    ext: extensionForUserPath(entry.path),
    depth: splitUserPath(entry.path).length,
    previewKind: entry.previewKind || (entry.kind === "file" ? "text" : "binary"),
    hidden: entry.hidden ?? isHiddenWorkspacePath(entry.path),
    contentIndexed: entry.contentIndexed === true,
  };
}

function extensionForUserPath(path: string): string {
  const name = basenameUserPath(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1);
}

async function readShellFileBytes(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<Uint8Array> {
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) throw new Error("Path must refer to a file.");
  const entry = await requireShellEntry(workspace, normalized, cache);
  if (entry.kind !== "file") throw new Error("Is a directory");
  if (entry.previewKind !== "text") {
    throw new Error(
      `File is ${entry.previewKind}; use checkout and process the returned session-relative shared/path with normal Agent Space tools.`,
    );
  }
  const file = await getFileSnapshot(workspace, normalized);
  const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
  if (looksBinary(sample))
    throw new Error(
      "File appears to be binary; use checkout and process the returned session-relative shared/path with normal Agent Space tools.",
    );
  return new Uint8Array(await file.arrayBuffer());
}

async function readShellRawFileBytes(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<Uint8Array> {
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) throw new Error("Path must refer to a file.");
  const entry = await requireShellEntry(workspace, normalized, cache);
  if (entry.kind !== "file") throw new Error("Is a directory");
  const file = await getFileSnapshot(workspace, normalized);
  return new Uint8Array(await file.arrayBuffer());
}

async function writeShellFile(
  workspace: MountedWorkspace,
  path: string,
  content: FileContent,
): Promise<void> {
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) throw new Error("Path must refer to a file.");
  requireWritableWorkspace(workspace);
  return withUserSpaceFileMutation(workspace, normalized, (lease) =>
    writeShellFileUnlocked(workspace, normalized, content, lease),
  );
}

async function writeShellFileUnlocked(
  workspace: MountedWorkspace,
  path: string,
  content: FileContent,
  lease: UserSpaceWorkspaceLease,
): Promise<void> {
  await prepareWorkspaceWrite(lease);
  const bytes = fileContentToBytes(content);
  const handle = await getFileHandle(workspace, path, true, lease);
  assertWorkspaceLease(lease);
  const writable = await handle.createWritable();
  let writeContent: string | Blob;
  if (typeof content === "string") {
    writeContent = content;
  } else {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    writeContent = new Blob([arrayBuffer]);
  }
  await commitWritableFile(lease, writable, writeContent);
  await upsertFileMetadata(workspace, path, handle);
  assertWorkspaceLease(lease);
  notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(path));
}

function fileContentToBytes(content: FileContent): Uint8Array<ArrayBuffer> {
  if (typeof content === "string") return new TextEncoder().encode(content);
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy;
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const next = new Uint8Array(first.byteLength + second.byteLength);
  next.set(first, 0);
  next.set(second, first.byteLength);
  return next;
}

function dirnameUserPath(path: string): string {
  const parts = splitUserPath(path);
  parts.pop();
  return parts.join("/");
}

function basenameUserPath(path: string): string {
  const parts = splitUserPath(path);
  return parts[parts.length - 1] || "";
}

async function createEntry(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const parentPath = normalizeUserSpacePath(
    typeof input.parentPath === "string" ? input.parentPath : "",
  );
  const name = normalizeUserSpaceEntryName(input.name, "name");
  const kind = input.kind === "directory" ? "directory" : "file";
  const path = joinUserPath(parentPath, name);
  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    if (await findShellEntry(workspace, path)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(path));
    }
    assertWorkspaceLease(lease);
    const parent = await getDirectory(workspace, parentPath, false, lease);
    if (kind === "directory") {
      await assertWorkspaceWritePermission(lease);
      const dir = await parent.getDirectoryHandle(name, { create: true });
      assertWorkspaceLease(lease);
      setCachedDirectoryHandle(workspace, path, dir);
    } else {
      await assertWorkspaceWritePermission(lease);
      const handle = await parent.getFileHandle(name, { create: true });
      assertWorkspaceLease(lease);
      const content = typeof input.content === "string" ? input.content : "";
      const writable = await handle.createWritable();
      await commitWritableFile(lease, writable, content);
      setCachedFileHandle(workspace, path, handle);
    }
    if (kind === "directory") await upsertDirectoryMetadata(workspace, path);
    else await upsertFileMetadata(workspace, path);
    assertWorkspaceLease(lease);
    notifyMountChanged(
      workspace.mount.mountId,
      kind === "directory" ? changedDirsForDirectoryPath(path) : changedDirsForFilePath(path),
    );
    return { mountId: workspace.mount.mountId, path, kind, created: true };
  });
}

async function renameEntry(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const path = normalizeRequiredPath(input.path);
  const nextName = normalizeUserSpaceEntryName(input.name, "name");
  const parentPath = dirnameUserPath(path);
  const nextPath = joinUserPath(parentPath, nextName);
  if (nextPath === path)
    return { mountId: workspace.mount.mountId, path, newPath: nextPath, renamed: false };
  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const entry = await requireShellEntry(workspace, path);
    assertWorkspaceLease(lease);
    if (entry.kind === "directory") {
      throw new Error(uiCopy.userSpace.runtimeErrors.renameFolderUnsupported);
    }
    if (await findShellEntry(workspace, nextPath)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(nextPath));
    }
    assertWorkspaceLease(lease);
    await copyFileEntry(workspace, path, nextPath, undefined, lease);
    const { parent, name } = await getParentDirectory(workspace, path, false, lease);
    await assertWorkspaceWritePermission(lease);
    await parent.removeEntry(name);
    assertWorkspaceLease(lease);
    removeCachedPath(workspace, path);
    await workspace.runtime.removePath(path).catch(() => undefined);
    assertWorkspaceLease(lease);
    await upsertFileMetadata(workspace, nextPath);
    assertWorkspaceLease(lease);
    notifyMountChanged(workspace.mount.mountId, [
      ...changedDirsForFilePath(path),
      ...changedDirsForFilePath(nextPath),
    ]);
    return { mountId: workspace.mount.mountId, path, newPath: nextPath, renamed: true };
  });
}

async function copyEntry(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const sourcePath = normalizeRequiredPath(input.sourcePath);
  const targetDirPath = normalizeUserSpacePath(
    typeof input.targetDirPath === "string" ? input.targetDirPath : dirnameUserPath(sourcePath),
  );
  const requestedName =
    typeof input.name === "string" && input.name.trim()
      ? normalizeUserSpaceEntryName(input.name, "name")
      : basenameUserPath(sourcePath);
  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const sourceEntry = await requireShellEntry(workspace, sourcePath);
    assertWorkspaceLease(lease);
    if (
      sourceEntry.kind === "directory" &&
      (targetDirPath === sourcePath || targetDirPath.startsWith(`${sourcePath}/`))
    ) {
      throw new Error(
        uiCopy.userSpace.runtimeErrors.copyFolderIntoSelf(
          sourceEntry.name || basenameUserPath(sourcePath),
        ),
      );
    }
    const targetDir = await getDirectory(workspace, targetDirPath, false, lease);
    let targetPath = joinUserPath(targetDirPath, requestedName);
    if (targetPath === sourcePath)
      targetPath = await nextAvailableCopyPath(workspace, targetDirPath, requestedName);
    assertWorkspaceLease(lease);
    const targetExists = await findShellEntryStrict(workspace, targetPath);
    assertWorkspaceLease(lease);
    if (targetExists) {
      if (input.conflict === "rename") {
        targetPath = await nextAvailableCopyPath(workspace, targetDirPath, requestedName);
        assertWorkspaceLease(lease);
      } else {
        throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
      }
    }
    if (sourceEntry.kind === "directory") {
      await copyDirectoryEntry(workspace, sourcePath, targetPath, targetDir, lease);
      assertWorkspaceLease(lease);
      notifyMountChanged(workspace.mount.mountId, changedDirsForDirectoryPath(targetPath));
    } else {
      await copyFileEntry(workspace, sourcePath, targetPath, targetDir, lease);
      await upsertFileMetadata(workspace, targetPath);
      assertWorkspaceLease(lease);
      notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(targetPath));
    }
    return { mountId: workspace.mount.mountId, sourcePath, path: targetPath, copied: true };
  });
}

async function copyEntries(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const rawPaths = Array.isArray(input.paths) ? input.paths : [];
  if (rawPaths.length > MAX_USER_SPACE_MUTATION_ENTRIES) {
    throw new Error(uiCopy.userSpace.runtimeErrors.batchTooLarge(MAX_USER_SPACE_MUTATION_ENTRIES));
  }
  const sourcePaths = Array.from(new Set(rawPaths.map((path) => normalizeRequiredPath(path))));
  if (sourcePaths.length === 0) {
    throw new Error(uiCopy.userSpace.runtimeErrors.copySelectionEmpty);
  }
  const targetDirPath = normalizeUserSpacePath(
    typeof input.targetDirPath === "string" ? input.targetDirPath : "",
  );

  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const targetDir = await getDirectory(workspace, targetDirPath, false, lease);
    const sourceEntries: Array<{ sourcePath: string; entry: IndexedWorkspaceEntry }> = [];
    for (const sourcePath of sourcePaths) {
      const entry = await requireShellEntry(workspace, sourcePath);
      assertWorkspaceLease(lease);
      sourceEntries.push({ sourcePath, entry });
    }
    const maximalSources = collapseUserSpaceMoveSources(sourceEntries);
    const reservedTargetPaths = new Set<string>();
    const plans: UserSpaceMovePlan[] = [];
    for (const { sourcePath, entry } of maximalSources) {
      if (
        entry.kind === "directory" &&
        (targetDirPath === sourcePath || targetDirPath.startsWith(`${sourcePath}/`))
      ) {
        throw new Error(
          uiCopy.userSpace.runtimeErrors.copyFolderIntoSelf(
            entry.name || basenameUserPath(sourcePath),
          ),
        );
      }
      const targetPath = await nextAvailableBatchCopyPath(
        workspace,
        sourcePath,
        targetDirPath,
        basenameUserPath(sourcePath),
        reservedTargetPaths,
      );
      reservedTargetPaths.add(targetPath);
      plans.push({ sourcePath, targetPath, entry });
    }

    const attempted: UserSpaceMovePlan[] = [];
    const completedCopies = new Map<UserSpaceMovePlan, WorkspaceCopyManifest>();
    let indexNeedsRebuild = false;
    try {
      for (const plan of plans) {
        let targetCreated = false;
        const onTargetCreated = () => {
          if (targetCreated) return;
          targetCreated = true;
          attempted.push(plan);
        };
        const onManifestReady = (manifest: WorkspaceCopyManifest) => {
          completedCopies.set(plan, manifest);
        };
        if (plan.entry.kind === "directory") {
          await copyDirectoryEntry(workspace, plan.sourcePath, plan.targetPath, targetDir, lease, {
            onTargetCreated,
            onManifestReady,
          });
        } else {
          await copyFileEntry(workspace, plan.sourcePath, plan.targetPath, targetDir, lease, {
            onTargetCreated,
            onManifestReady,
          });
          await upsertFileMetadata(workspace, plan.targetPath);
        }
        assertWorkspaceLease(lease);
      }
    } catch (error) {
      let cleanupFailed = false;
      for (const plan of [...attempted].reverse()) {
        const manifest = completedCopies.get(plan);
        if (!manifest) {
          cleanupFailed = true;
          continue;
        }
        try {
          const status = await removeWorkspaceEntryMatchingManifest(
            workspace,
            plan.targetPath,
            manifest,
            lease,
          );
          if (status === "changed") {
            cleanupFailed = true;
            continue;
          }
        } catch (cleanupError) {
          if (!(cleanupError instanceof DOMException && cleanupError.name === "NotFoundError")) {
            cleanupFailed = true;
            continue;
          }
        }
        removeCachedPath(workspace, plan.targetPath);
        await workspace.runtime.removePath(plan.targetPath).catch(() => {
          indexNeedsRebuild = true;
        });
      }
      assertWorkspaceLease(lease);
      markWorkspaceIndexMaybeStale(workspace);
      if (cleanupFailed || indexNeedsRebuild) {
        startBackgroundWorkspaceIndex(workspace.mount.mountId);
      }
      notifyMountChanged(workspace.mount.mountId, [targetDirPath]);
      if (cleanupFailed) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} ${uiCopy.userSpace.runtimeErrors.copyCleanupFailed}`);
      }
      throw error;
    }

    const changedDirs = Array.from(
      new Set(
        plans.flatMap(({ targetPath, entry }) =>
          entry.kind === "directory"
            ? changedDirsForDirectoryPath(targetPath)
            : changedDirsForFilePath(targetPath),
        ),
      ),
    ).sort((left, right) => left.localeCompare(right));
    assertWorkspaceLease(lease);
    markWorkspaceIndexMaybeStale(workspace);
    notifyMountChanged(workspace.mount.mountId, changedDirs);
    return {
      mountId: workspace.mount.mountId,
      moves: plans.map(({ sourcePath, targetPath, entry }) => ({
        sourcePath,
        path: targetPath,
        kind: entry.kind,
      })),
      changedDirs,
    };
  });
}

async function nextAvailableBatchCopyPath(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetDirPath: string,
  sourceName: string,
  reservedTargetPaths: Set<string>,
): Promise<string> {
  const directTarget = joinUserPath(targetDirPath, sourceName);
  if (
    directTarget !== sourcePath &&
    !reservedTargetPaths.has(directTarget) &&
    !(await findShellEntryStrict(workspace, directTarget))
  ) {
    return directTarget;
  }
  for (let index = 1; index <= 999; index++) {
    const candidate = joinUserPath(targetDirPath, copyNameCandidate(sourceName, index));
    if (reservedTargetPaths.has(candidate)) continue;
    if (!(await findShellEntryStrict(workspace, candidate))) return candidate;
  }
  throw new Error(uiCopy.userSpace.runtimeErrors.uniqueCopyNameFailed);
}

interface UserSpaceMovePlan {
  sourcePath: string;
  targetPath: string;
  entry: IndexedWorkspaceEntry;
}

function collapseUserSpaceMoveSources<T extends { sourcePath: string; entry: { kind: string } }>(
  entries: T[],
): T[] {
  const selectedDirectories = new Set(
    entries.filter(({ entry }) => entry.kind === "directory").map(({ sourcePath }) => sourcePath),
  );
  return entries.filter(({ sourcePath }) => {
    let parent = dirnameUserPath(sourcePath);
    while (parent) {
      if (selectedDirectories.has(parent)) return false;
      parent = dirnameUserPath(parent);
    }
    return true;
  });
}

async function moveEntries(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const rawPaths = Array.isArray(input.paths) ? input.paths : [];
  if (rawPaths.length > MAX_USER_SPACE_MUTATION_ENTRIES) {
    throw new Error(uiCopy.userSpace.runtimeErrors.batchTooLarge(MAX_USER_SPACE_MUTATION_ENTRIES));
  }
  const sourcePaths = Array.from(new Set(rawPaths.map((path) => normalizeRequiredPath(path))));
  if (sourcePaths.length === 0) {
    throw new Error(uiCopy.userSpace.runtimeErrors.moveSelectionEmpty);
  }
  const targetDirPath = normalizeUserSpacePath(
    typeof input.targetDirPath === "string" ? input.targetDirPath : "",
  );

  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const targetDir = await getDirectory(workspace, targetDirPath, false, lease);
    const sourceEntries: Array<{ sourcePath: string; entry: IndexedWorkspaceEntry }> = [];
    for (const sourcePath of sourcePaths) {
      const entry = await requireShellEntry(workspace, sourcePath);
      assertWorkspaceLease(lease);
      sourceEntries.push({ sourcePath, entry });
    }

    // Moving a selected directory also moves every selected descendant. Collapse
    // those descendants before planning so they cannot be copied or deleted twice.
    const maximalSources = collapseUserSpaceMoveSources(sourceEntries);

    if (maximalSources.some(({ sourcePath }) => dirnameUserPath(sourcePath) === targetDirPath)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.moveSameParent);
    }

    const plans: UserSpaceMovePlan[] = [];
    const targetPaths = new Set<string>();
    for (const { sourcePath, entry } of maximalSources) {
      if (
        entry.kind === "directory" &&
        (targetDirPath === sourcePath || targetDirPath.startsWith(`${sourcePath}/`))
      ) {
        throw new Error(
          uiCopy.userSpace.runtimeErrors.moveFolderIntoSelf(
            entry.name || basenameUserPath(sourcePath),
          ),
        );
      }
      const targetPath = joinUserPath(targetDirPath, basenameUserPath(sourcePath));
      if (targetPaths.has(targetPath)) {
        throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
      }
      targetPaths.add(targetPath);
      const targetEntry = await findShellEntryStrict(workspace, targetPath);
      assertWorkspaceLease(lease);
      if (targetEntry) {
        throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
      }
      plans.push({ sourcePath, targetPath, entry });
    }

    const changedDirs = Array.from(
      new Set(
        plans.flatMap(({ sourcePath, targetPath }) => [
          ...changedDirsForFilePath(sourcePath),
          ...changedDirsForFilePath(targetPath),
        ]),
      ),
    ).sort((left, right) => left.localeCompare(right));
    const attemptedCopies: UserSpaceMovePlan[] = [];
    const completedCopies = new Map<UserSpaceMovePlan, WorkspaceCopyManifest>();
    const deletionAttempts: UserSpaceMovePlan[] = [];
    let indexNeedsRebuild = false;

    try {
      for (const plan of plans) {
        let targetCreated = false;
        const onTargetCreated = () => {
          if (targetCreated) return;
          targetCreated = true;
          attemptedCopies.push(plan);
        };
        const onManifestReady = (manifest: WorkspaceCopyManifest) => {
          completedCopies.set(plan, manifest);
        };
        if (plan.entry.kind === "directory") {
          await copyDirectoryEntry(workspace, plan.sourcePath, plan.targetPath, targetDir, lease, {
            onTargetCreated,
            onManifestReady,
          });
        } else {
          await copyFileEntry(workspace, plan.sourcePath, plan.targetPath, targetDir, lease, {
            onTargetCreated,
            onManifestReady,
          });
          await upsertFileMetadata(workspace, plan.targetPath);
        }
        assertWorkspaceLease(lease);
      }
      // Do not remove a single source until every destination copy is durable.
      for (const plan of plans) {
        const manifest = completedCopies.get(plan);
        if (!manifest) {
          throw new Error(uiCopy.userSpace.runtimeErrors.moveSourceChanged(plan.sourcePath));
        }
        let deletionAttempted = false;
        const onSourceDeletionAttempt = () => {
          if (deletionAttempted) return;
          deletionAttempted = true;
          deletionAttempts.push(plan);
        };
        const removed = await removeWorkspaceSourceAfterVerifiedCopy(
          workspace,
          plan.sourcePath,
          plan.targetPath,
          manifest,
          lease,
          onSourceDeletionAttempt,
        );
        if (!removed) {
          throw new Error(uiCopy.userSpace.runtimeErrors.moveSourceChanged(plan.sourcePath));
        }
        assertWorkspaceLease(lease);
        removeCachedPath(workspace, plan.sourcePath);
        await workspace.runtime.removePath(plan.sourcePath).catch(() => {
          indexNeedsRebuild = true;
        });
        assertWorkspaceLease(lease);
      }
    } catch (error) {
      let rollbackFailed = false;
      const safeSources = new Set(
        plans.filter((plan) => !deletionAttempts.includes(plan)).map((plan) => plan.sourcePath),
      );

      // If deleting any source failed, first restore every source whose deletion
      // had begun. Only then is it safe to remove its destination copy.
      for (const plan of [...deletionAttempts].reverse()) {
        try {
          const manifest = completedCopies.get(plan);
          if (!manifest) {
            rollbackFailed = true;
            continue;
          }
          if (
            await restoreWorkspaceSourceFromTarget(
              workspace,
              plan.sourcePath,
              plan.targetPath,
              manifest,
              lease,
            )
          ) {
            safeSources.add(plan.sourcePath);
          } else {
            rollbackFailed = true;
          }
        } catch {
          rollbackFailed = true;
        }
      }

      for (const plan of [...attemptedCopies].reverse()) {
        // Keep the destination when source restoration failed: it is the only
        // copy we can still guarantee is complete.
        if (!safeSources.has(plan.sourcePath)) continue;
        const manifest = completedCopies.get(plan);
        if (!manifest) {
          rollbackFailed = true;
          continue;
        }
        try {
          const status = await removeWorkspaceEntryMatchingManifest(
            workspace,
            plan.targetPath,
            manifest,
            lease,
          );
          if (status === "changed") {
            rollbackFailed = true;
            continue;
          }
        } catch (cleanupError) {
          if (!(cleanupError instanceof DOMException && cleanupError.name === "NotFoundError")) {
            rollbackFailed = true;
            continue;
          }
        }
        removeCachedPath(workspace, plan.targetPath);
        await workspace.runtime.removePath(plan.targetPath).catch(() => {
          indexNeedsRebuild = true;
        });
      }
      try {
        assertWorkspaceLease(lease);
        markWorkspaceIndexMaybeStale(workspace);
        if (rollbackFailed || indexNeedsRebuild) {
          startBackgroundWorkspaceIndex(workspace.mount.mountId);
        }
        notifyMountChanged(workspace.mount.mountId, changedDirs);
      } catch {
        // A remount owns a different root and will publish its own fresh state.
      }
      if (rollbackFailed) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} ${uiCopy.userSpace.runtimeErrors.moveCleanupFailed}`);
      }
      throw error;
    }

    assertWorkspaceLease(lease);
    markWorkspaceIndexMaybeStale(workspace);
    if (indexNeedsRebuild) startBackgroundWorkspaceIndex(workspace.mount.mountId);
    notifyMountChanged(workspace.mount.mountId, changedDirs);
    return {
      mountId: workspace.mount.mountId,
      moves: plans.map(({ sourcePath, targetPath, entry }) => ({
        sourcePath,
        path: targetPath,
        kind: entry.kind,
      })),
      changedDirs,
    };
  });
}

async function duplicateEntry(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const sourcePath = normalizeRequiredPath(input.path);
  return withUserSpaceWorkspaceMutation(workspace, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const sourceEntry = await requireShellEntry(workspace, sourcePath);
    assertWorkspaceLease(lease);
    if (sourceEntry.kind === "directory") {
      throw new Error(uiCopy.userSpace.runtimeErrors.duplicateFolderUnsupported);
    }
    const parentPath = dirnameUserPath(sourcePath);
    const targetPath = await nextAvailableCopyPath(
      workspace,
      parentPath,
      basenameUserPath(sourcePath),
    );
    assertWorkspaceLease(lease);
    await copyFileEntry(workspace, sourcePath, targetPath, undefined, lease);
    await upsertFileMetadata(workspace, targetPath);
    assertWorkspaceLease(lease);
    notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(targetPath));
    return { mountId: workspace.mount.mountId, sourcePath, path: targetPath, duplicated: true };
  });
}

async function writeFile(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const path = normalizeRequiredPath(input.path);
  const content = requireString(input.content, "content");
  const createParents = input.createParents !== false;
  return withUserSpaceFileMutation(workspace, path, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const handle = await getFileHandle(workspace, path, createParents, lease);
    assertWorkspaceLease(lease);
    const writable = await handle.createWritable();
    await commitWritableFile(lease, writable, content);
    await upsertFileMetadata(workspace, path, handle);
    assertWorkspaceLease(lease);
    notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(path));
    return {
      mountId: workspace.mount.mountId,
      path,
      bytesWritten: new TextEncoder().encode(content).byteLength,
      message: `Successfully wrote ${content.length} bytes to ${path}`,
    };
  });
}

async function replaceText(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const path = normalizeRequiredPath(input.path);
  const edits = parsePiTextEdits(input);
  return withUserSpaceFileMutation(workspace, path, async (lease) => {
    const file = await getFileSnapshot(workspace, path);
    assertWorkspaceLease(lease);
    const result = applyTextEditsLikePi(await file.text(), edits, path);
    assertWorkspaceLease(lease);
    await prepareWorkspaceWrite(lease);
    const handle = await getFileHandle(workspace, path, false, lease);
    assertWorkspaceLease(lease);
    const writable = await handle.createWritable();
    await commitWritableFile(lease, writable, result.content);
    await upsertFileMetadata(workspace, path, handle);
    assertWorkspaceLease(lease);
    notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(path));
    return {
      mountId: workspace.mount.mountId,
      path,
      replacements: edits.length,
      message: `Successfully replaced ${edits.length} block(s) in ${path}.`,
      diff: result.diff,
      patch: result.patch,
      firstChangedLine: result.firstChangedLine,
    };
  });
}

function parsePiTextEdits(input: Record<string, unknown>): PiTextEdit[] {
  let rawEdits = input.edits;
  if (typeof rawEdits === "string") {
    try {
      rawEdits = JSON.parse(rawEdits);
    } catch {
      // The aligned validation error below is more actionable than JSON internals.
    }
  }
  if (Array.isArray(rawEdits)) {
    return rawEdits.map((edit, index) => {
      if (!edit || typeof edit !== "object") throw new Error(`edits[${index}] must be an object.`);
      const value = edit as Record<string, unknown>;
      return {
        oldText: requireString(value.oldText, `edits[${index}].oldText`),
        newText: requireString(value.newText, `edits[${index}].newText`),
      };
    });
  }
  const oldText = typeof input.oldText === "string" ? input.oldText : input.oldString;
  const newText = typeof input.newText === "string" ? input.newText : input.newString;
  if (typeof oldText === "string" && typeof newText === "string") return [{ oldText, newText }];
  throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
}

async function withUserSpaceWorkspaceMutation<T>(
  workspace: MountedWorkspace,
  mutate: (lease: UserSpaceWorkspaceLease) => Promise<T>,
): Promise<T> {
  const lease = captureWorkspaceLease(workspace);
  const key = workspace.mount.mountId;
  const previous = workspaceMutationChains.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  workspaceMutationChains.set(key, chained);
  await previous.catch(() => undefined);
  try {
    assertWorkspaceLease(lease);
    const result = await mutate(lease);
    assertWorkspaceLease(lease);
    return result;
  } finally {
    release();
    if (workspaceMutationChains.get(key) === chained) workspaceMutationChains.delete(key);
  }
}

async function withUserSpaceFileMutation<T>(
  workspace: MountedWorkspace,
  _path: string,
  mutate: (lease: UserSpaceWorkspaceLease) => Promise<T>,
): Promise<T> {
  // Structural moves copy and then remove whole subtrees. A per-file lock cannot
  // protect a descendant write from being lost between those phases, so every
  // mutation within one mounted directory shares the same ordered queue.
  return withUserSpaceWorkspaceMutation(workspace, mutate);
}

async function deleteEntry(input: Record<string, unknown>): Promise<unknown> {
  const workspace = requireWorkspace(input.mountId);
  requireWritableWorkspace(workspace);
  const path = normalizeRequiredPath(input.path);
  const recursive = input.recursive === true;
  return withUserSpaceFileMutation(workspace, path, async (lease) => {
    await prepareWorkspaceWrite(lease);
    const { parent, name } = await getParentDirectory(workspace, path, false, lease);
    await assertWorkspaceWritePermission(lease);
    await parent.removeEntry(name, { recursive });
    assertWorkspaceLease(lease);
    removeCachedPath(workspace, path);
    await workspace.runtime.removePath(path).catch(() => undefined);
    assertWorkspaceLease(lease);
    markWorkspaceIndexMaybeStale(workspace);
    notifyMountChanged(workspace.mount.mountId, changedDirsForFilePath(path));
    return { mountId: workspace.mount.mountId, path, deleted: true };
  });
}

async function readDirectoryPage(
  workspace: MountedWorkspace,
  path: string,
  limit: number,
  offset: number,
  includeHidden: boolean,
): Promise<{ entries: UserSpaceEntry[]; nextCursor?: string; loaded: number }> {
  const dir = await getDirectory(workspace, path, false);
  const entries: UserSpaceEntry[] = [];
  let processed = 0;
  let visible = 0;
  for await (const handle of iterateDirectory(dir)) {
    processed++;
    const childPath = joinUserPath(path, handle.name);
    const entry = await entryFromHandle(childPath, handle);
    if (!entry) {
      if (processed % 80 === 0) await yieldToBrowser();
      continue;
    }
    if (!includeHidden && entry.hidden) {
      if (processed % 80 === 0) await yieldToBrowser();
      continue;
    }
    cacheHandle(workspace, childPath, handle);
    if (visible++ < offset) {
      if (processed % 80 === 0) await yieldToBrowser();
      continue;
    }
    entries.push(entry);
    if (entries.length > limit) break;
    if (processed % 80 === 0) await yieldToBrowser();
  }
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  const loaded = offset + page.length;
  return {
    entries: sortEntries(page),
    nextCursor: hasMore ? String(loaded) : undefined,
    loaded,
  };
}

async function readAllDirectoryEntries(
  workspace: MountedWorkspace,
  path: string,
  cache?: Map<string, IndexedWorkspaceEntry>,
): Promise<UserSpaceEntry[]> {
  const dir = await getDirectory(workspace, path, false);
  const entries: UserSpaceEntry[] = [];
  let processed = 0;
  for await (const handle of iterateDirectory(dir)) {
    processed++;
    const childPath = joinUserPath(path, handle.name);
    const entry = await entryFromHandle(childPath, handle, cache?.get(childPath));
    if (!entry) {
      if (processed % 80 === 0) await yieldToBrowser();
      continue;
    }
    cacheHandle(workspace, childPath, handle);
    entries.push(entry);
    if (processed % 80 === 0) await yieldToBrowser();
  }
  const sorted = sortEntries(entries);
  void workspace.runtime
    .addEntries(sorted.map(workspaceEntryToIndexedEntry))
    .catch(() => undefined);
  return sorted;
}

async function getDirectory(
  workspace: MountedWorkspace,
  path: string,
  createParents: boolean,
  lease?: UserSpaceWorkspaceLease,
): Promise<BrowserFileSystemDirectoryHandle> {
  if (createParents && !lease) throw new Error("A current workspace lease is required to write.");
  if (lease) assertWorkspaceLease(lease);
  const normalized = normalizeUserSpacePath(path);
  const cached = getCachedHandle(workspace.dirHandles, normalized);
  if (cached) return cached;

  let dir = workspace.root;
  let current = "";
  for (const part of splitUserPath(normalized)) {
    current = joinUserPath(current, part);
    const cachedPart = getCachedHandle(workspace.dirHandles, current);
    if (cachedPart) {
      dir = cachedPart;
      continue;
    }
    if (createParents && lease) await assertWorkspaceWritePermission(lease);
    dir = await dir.getDirectoryHandle(part, { create: createParents });
    if (lease) assertWorkspaceLease(lease);
    setCachedDirectoryHandle(workspace, current, dir);
  }
  return dir;
}

async function getFileHandle(
  workspace: MountedWorkspace,
  path: string,
  create: boolean,
  lease?: UserSpaceWorkspaceLease,
): Promise<BrowserFileSystemFileHandle> {
  if (create && !lease) throw new Error("A current workspace lease is required to write.");
  if (lease) assertWorkspaceLease(lease);
  const normalized = normalizeRequiredPath(path);
  const cached = getCachedHandle(workspace.fileHandles, normalized);
  if (cached && !create) return cached;
  const { parent, name } = await getParentDirectory(workspace, normalized, create, lease);
  if (create && lease) await assertWorkspaceWritePermission(lease);
  const handle = await parent.getFileHandle(name, { create });
  if (lease) assertWorkspaceLease(lease);
  setCachedFileHandle(workspace, normalized, handle);
  return handle;
}

async function assertUserSpacePathAvailable(
  workspace: MountedWorkspace,
  path: string,
): Promise<void> {
  const normalized = normalizeRequiredPath(path);
  try {
    await getFileHandle(workspace, normalized, false);
    throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(normalized));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === uiCopy.userSpace.runtimeErrors.entryExists(normalized)
    )
      throw error;
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

async function getParentDirectory(
  workspace: MountedWorkspace,
  path: string,
  createParents: boolean,
  lease?: UserSpaceWorkspaceLease,
): Promise<{ parent: BrowserFileSystemDirectoryHandle; name: string }> {
  const parts = splitUserPath(path);
  const name = parts.pop();
  if (!name) throw new Error("Path must refer to an entry inside the mounted directory.");
  return { parent: await getDirectory(workspace, parts.join("/"), createParents, lease), name };
}

async function getFileSnapshot(workspace: MountedWorkspace, path: string): Promise<File> {
  const normalized = normalizeRequiredPath(path);
  const handle = await getFileHandle(workspace, normalized, false);
  return handle.getFile();
}

async function* walkWorkspace(
  workspace: MountedWorkspace,
  startPath: string,
): AsyncGenerator<{ path: string; kind: FileSystemHandleKind; size?: number }> {
  const root = await getDirectory(workspace, startPath, false);
  yield* walkDirectory(workspace, root, startPath);
}

async function* walkDirectory(
  workspace: MountedWorkspace,
  dir: BrowserFileSystemDirectoryHandle,
  basePath: string,
): AsyncGenerator<{ path: string; kind: FileSystemHandleKind; size?: number }> {
  let processed = 0;
  for await (const handle of iterateDirectory(dir)) {
    processed++;
    const path = joinUserPath(basePath, handle.name);
    const entry = await entryFromHandle(path, handle);
    if (!entry) {
      if (processed % 80 === 0) await yieldToBrowser();
      continue;
    }
    cacheHandle(workspace, path, handle);
    yield { path, kind: handle.kind, size: entry.size };
    if (handle.kind === "directory") {
      yield* walkDirectory(workspace, handle as BrowserFileSystemDirectoryHandle, path);
    }
    if (processed % 80 === 0) await yieldToBrowser();
  }
}

async function* iterateDirectory(
  dir: BrowserFileSystemDirectoryHandle,
): AsyncGenerator<BrowserFileSystemHandle> {
  if (dir.values) {
    for await (const handle of dir.values()) yield handle;
    return;
  }
  if (dir.entries) {
    for await (const [, handle] of dir.entries()) yield handle;
    return;
  }
  throw new Error("Directory handle does not support iteration.");
}

function cacheHandle(
  workspace: MountedWorkspace,
  path: string,
  handle: BrowserFileSystemHandle,
): void {
  if (handle.kind === "file") {
    setCachedFileHandle(workspace, path, handle as BrowserFileSystemFileHandle);
  } else {
    setCachedDirectoryHandle(workspace, path, handle as BrowserFileSystemDirectoryHandle);
  }
}

function getCachedHandle<T>(cache: Map<string, T>, path: string): T | undefined {
  const value = cache.get(path);
  if (!value) return undefined;
  cache.delete(path);
  cache.set(path, value);
  return value;
}

function setCachedDirectoryHandle(
  workspace: MountedWorkspace,
  path: string,
  handle: BrowserFileSystemDirectoryHandle,
): void {
  workspace.dirHandles.set(path, handle);
  trimHandleCache(workspace.dirHandles, DIR_HANDLE_CACHE_LIMIT, "");
}

function setCachedFileHandle(
  workspace: MountedWorkspace,
  path: string,
  handle: BrowserFileSystemFileHandle,
): void {
  workspace.fileHandles.set(path, handle);
  trimHandleCache(workspace.fileHandles, FILE_HANDLE_CACHE_LIMIT);
}

function trimHandleCache<T>(cache: Map<string, T>, limit: number, pinnedPath?: string): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    if (oldest === pinnedPath) {
      const pinned = cache.get(oldest);
      cache.delete(oldest);
      if (pinned !== undefined) cache.set(oldest, pinned);
      continue;
    }
    cache.delete(oldest);
  }
}

function removeCachedPath(workspace: MountedWorkspace, path: string): void {
  workspace.fileHandles.delete(path);
  workspace.dirHandles.delete(path);
  for (const key of Array.from(workspace.fileHandles.keys())) {
    if (key.startsWith(`${path}/`)) workspace.fileHandles.delete(key);
  }
  for (const key of Array.from(workspace.dirHandles.keys())) {
    if (key.startsWith(`${path}/`)) workspace.dirHandles.delete(key);
  }
}

async function entryFromHandle(
  path: string,
  handle: BrowserFileSystemHandle,
  cached?: IndexedWorkspaceEntry,
): Promise<UserSpaceEntry | null> {
  if (cached && cached.kind === handle.kind) return runtimeEntryToWorkspaceEntry(cached);
  if (handle.kind === "directory") {
    return {
      name: handle.name,
      path,
      kind: handle.kind,
      hidden: isHiddenWorkspacePath(path),
      contentIndexed: false,
    };
  }
  const file = await (handle as BrowserFileSystemFileHandle).getFile();
  const entry = await metadataEntryFromFile(path, file, { indexContent: false });
  return entry ? runtimeEntryToWorkspaceEntry({ ...entry, name: handle.name }) : null;
}

function sortEntries(entries: UserSpaceEntry[]): UserSpaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function findMountedWorkspaceByRoot(
  root: BrowserFileSystemDirectoryHandle,
  persistenceScope: UserSpacePersistenceScope | null,
): Promise<MountedWorkspace | null> {
  for (const workspace of mounts.values()) {
    if (!samePersistenceScope(workspace.persistenceScope, persistenceScope)) continue;
    if (workspace.root === root) return workspace;
    try {
      if (root.isSameEntry && (await root.isSameEntry(workspace.root))) return workspace;
      if (workspace.root.isSameEntry && (await workspace.root.isSameEntry(root))) return workspace;
    } catch {
      // Some browser handles can fail identity checks after permission changes.
      // In that case, keep looking and let the normal mount flow handle errors.
    }
  }
  return null;
}

function registerMountedWorkspace(
  mount: UserSpaceMount,
  root: BrowserFileSystemDirectoryHandle,
  persistenceScope: UserSpacePersistenceScope | null,
): UserSpaceMount {
  const mounted = withPermissionSnapshot(
    { ...mount, status: "mounted" as const, includeHidden: true as const },
    mount.permissionState || "granted",
  );
  disposeMountedWorkspace(mounted.mountId);
  mounts.set(mounted.mountId, {
    mount: mounted,
    root,
    directoryGeneration: ++nextWorkspaceDirectoryGeneration,
    persistenceScope: persistenceScope ? { ...persistenceScope } : null,
    dirHandles: new Map([["", root]]),
    fileHandles: new Map(),
    recentOperations: [],
    recentFileChanges: [],
    indexing: false,
    indexGeneration: 0,
    runtime: createUserSpaceRuntime(mounted.mountId, root),
  });
  notifyMountChanged(mounted.mountId);
  return { ...mounted };
}

function disposeMountedWorkspace(mountId: string): void {
  const existing = mounts.get(mountId);
  cancelBackgroundIndexTimer(mountId);
  if (!existing) return;
  existing.indexGeneration++;
  existing.indexing = false;
  existing.dirHandles.clear();
  existing.fileHandles.clear();
  existing.runtime.drop();
}

function releaseMountedWorkspace(mountId: string): void {
  if (!mounts.has(mountId)) return;
  disposeMountedWorkspace(mountId);
  mounts.delete(mountId);
  notify();
}

function isMountedWorkspaceReferenced(mountId: string): boolean {
  for (const set of sessionMounts.values()) {
    if (set.has(mountId)) return true;
  }
  return false;
}

async function restoreUserSpaceMetadata(
  mountId: string,
  generation: number,
): Promise<UserSpaceMount> {
  assertUserSpaceGeneration(generation);
  const workspace = mounts.get(mountId);
  if (!workspace) throw new Error(uiCopy.userSpace.runtimeErrors.mountNotFound(mountId));
  workspace.indexing = false;
  workspace.mount = withPermissionSnapshot(
    {
      ...workspace.mount,
      status: "mounted",
      fileCount: undefined,
      lastIndexedAt: undefined,
    },
    workspace.mount.permissionState || "granted",
  );
  await queuePersistMountedWorkspace(workspace.mount, workspace.root).catch(() => undefined);
  assertUserSpaceGeneration(generation);
  if (mounts.get(mountId) !== workspace) throw staleUserSpaceOperation();
  notify();
  startBackgroundWorkspaceIndex(mountId);
  return { ...workspace.mount };
}

function startBackgroundWorkspaceIndex(mountId: string): void {
  const workspace = mounts.get(mountId);
  if (!workspace || !canUseWorkspaceWorker(workspace.root)) return;
  cancelBackgroundIndexTimer(mountId);
  const lease = runtimeContextCoordinator.current();
  const record: BackgroundIndexTimer = {
    timer: 0 as unknown as ReturnType<typeof setTimeout>,
    ownerEpoch: lease?.context.epoch ?? null,
    detachScope: null,
  };
  const run = () => {
    if (backgroundIndexTimers.get(mountId) !== record) return;
    backgroundIndexTimers.delete(mountId);
    record.detachScope?.();
    record.detachScope = null;
    if (
      record.ownerEpoch !== null &&
      !runtimeContextCoordinator.isCurrent({ epoch: record.ownerEpoch })
    )
      return;
    void rebuildUserSpaceMetadata(mountId).catch(() => undefined);
  };
  record.timer = setTimeout(run, 0);
  backgroundIndexTimers.set(mountId, record);
  if (lease) {
    record.detachScope = lease.scope.add(() => {
      if (backgroundIndexTimers.get(mountId) !== record) return;
      clearTimeout(record.timer);
      backgroundIndexTimers.delete(mountId);
      record.detachScope = null;
    });
  }
}

async function rebuildUserSpaceMetadata(mountId: string): Promise<UserSpaceMount> {
  cancelBackgroundIndexTimer(mountId);
  const workspace = mounts.get(mountId);
  if (!workspace) throw new Error(uiCopy.userSpace.runtimeErrors.mountNotFound(mountId));
  const generation = workspace.indexGeneration + 1;
  const lease = runtimeContextCoordinator.current();
  const ownerEpoch = lease?.context.epoch ?? null;
  const isCurrent = () =>
    workspace.indexGeneration === generation &&
    (ownerEpoch === null || runtimeContextCoordinator.isCurrent({ epoch: ownerEpoch }));
  workspace.indexGeneration = generation;
  workspace.indexing = true;
  notify();
  const detachScope = lease?.scope.add(() => {
    if (workspace.indexGeneration !== generation) return;
    workspace.indexGeneration++;
    workspace.indexing = false;
    notify();
  });

  try {
    const result = await workspace.runtime.rebuild();
    if (!isCurrent()) return { ...workspace.mount };
    const indexedAt = result.lastIndexedAt || Date.now();
    const nextMount = withPermissionSnapshot(
      {
        ...workspace.mount,
        status: "mounted",
        fileCount: result.fileCount,
        lastIndexedAt: indexedAt,
      },
      workspace.mount.permissionState || "granted",
    );
    await queuePersistMountedWorkspace(nextMount, workspace.root).catch(() => undefined);
    if (!isCurrent()) return { ...workspace.mount };
    workspace.indexing = false;
    workspace.mount = nextMount;
    notify();
    sendWorkspaceIndexUpdate(workspace.mount.mountId);
    return { ...workspace.mount };
  } catch (error) {
    if (ownerEpoch !== null && !runtimeContextCoordinator.isCurrent({ epoch: ownerEpoch })) {
      return { ...workspace.mount };
    }
    if (workspace.indexGeneration === generation) {
      workspace.indexing = false;
      notify();
    }
    throw error;
  } finally {
    detachScope?.();
  }
}

function cancelBackgroundIndexTimer(mountId: string): void {
  const record = backgroundIndexTimers.get(mountId);
  if (!record) return;
  backgroundIndexTimers.delete(mountId);
  clearTimeout(record.timer);
  const detach = record.detachScope;
  record.detachScope = null;
  detach?.();
}

function runtimeEntryToWorkspaceEntry(entry: {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  lastModified?: number;
  previewKind?: IndexedWorkspaceEntry["previewKind"];
  hidden?: boolean;
  contentIndexed?: boolean;
}): UserSpaceEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    lastModified: entry.lastModified,
    previewKind: entry.previewKind,
    supportsLineEdit: entry.kind === "file" && entry.previewKind === "text",
    hidden: entry.hidden ?? isHiddenWorkspacePath(entry.path),
    contentIndexed: entry.contentIndexed === true,
  };
}

function markWorkspaceIndexMaybeStale(workspace: MountedWorkspace): void {
  assertCurrentWorkspace(workspace);
  workspace.indexGeneration++;
  workspace.indexing = false;
  workspace.mount = {
    ...workspace.mount,
    fileCount: undefined,
    lastIndexedAt: undefined,
  };
  void queuePersistMountedWorkspace(workspace.mount, workspace.root).catch(() => undefined);
  notify();
}

async function upsertDirectoryMetadata(workspace: MountedWorkspace, path: string): Promise<void> {
  const lease = captureWorkspaceLease(workspace);
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) return;
  const handle = await getDirectory(workspace, normalized, false, lease);
  assertWorkspaceLease(lease);
  await workspace.runtime.addEntries([
    workspaceEntryToIndexedEntry({
      name: handle.name || basenameUserPath(normalized),
      path: normalized,
      kind: "directory",
      hidden: isHiddenWorkspacePath(normalized),
      contentIndexed: false,
    }),
  ]);
  assertWorkspaceLease(lease);
  markWorkspaceIndexMaybeStale(workspace);
}

async function upsertFileMetadata(
  workspace: MountedWorkspace,
  path: string,
  handle?: BrowserFileSystemFileHandle,
): Promise<void> {
  const lease = captureWorkspaceLease(workspace);
  const normalized = normalizeUserSpacePath(path);
  if (!normalized) return;
  const fileHandle = handle || (await getFileHandle(workspace, normalized, false, lease));
  const file = await fileHandle.getFile();
  assertWorkspaceLease(lease);
  const entry = await metadataEntryFromFile(normalized, file);
  assertWorkspaceLease(lease);
  if (entry)
    await workspace.runtime.addEntries([{ ...entry, name: fileHandle.name || entry.name }]);
  assertWorkspaceLease(lease);
  markWorkspaceIndexMaybeStale(workspace);
}

function queuePersistMountedWorkspace(
  mount: UserSpaceMount,
  root: BrowserFileSystemDirectoryHandle,
): Promise<void> {
  const persistenceScope = mounts.get(mount.mountId)?.persistenceScope;
  if (!persistenceScope) return Promise.resolve();
  return userSpacePersistence.queueMount(persistenceScope, mount, root);
}

function samePersistenceScope(
  left: UserSpacePersistenceScope | null,
  right: UserSpacePersistenceScope | null,
): boolean {
  if (!left || !right) return left === right;
  return left.userId === right.userId && (left.tenantId || "") === (right.tenantId || "");
}

async function isSameDirectoryHandle(
  a: BrowserFileSystemDirectoryHandle,
  b: BrowserFileSystemDirectoryHandle,
): Promise<boolean> {
  if (a === b) return true;
  try {
    if (a.isSameEntry && (await a.isSameEntry(b))) return true;
  } catch {
    return false;
  }
  try {
    if (b.isSameEntry && (await b.isSameEntry(a))) return true;
  } catch {
    return false;
  }
  return false;
}

async function queryPermission(
  handle: BrowserFileSystemHandle,
  mode: PermissionMode,
): Promise<PermissionState | undefined> {
  return handle.queryPermission?.({ mode });
}

function permissionModeForAccess(access: UserSpaceAccess): PermissionMode {
  return access === "readonly" ? "read" : "readwrite";
}

function withPermissionSnapshot(
  mount: UserSpaceMount,
  permissionState: PermissionState | "unknown",
): UserSpaceMount {
  const canRead = permissionState === "granted" && mount.status === "mounted";
  const canWrite = canRead && mount.access === "readwrite";
  return {
    ...mount,
    canRead,
    canWrite,
    permissionState,
    lastPermissionCheckedAt: Date.now(),
  };
}

function requireWorkspace(value: unknown): MountedWorkspace {
  const mountId = requireString(value, "mountId");
  const workspace = mounts.get(mountId);
  if (!workspace) throw new Error(uiCopy.userSpace.runtimeErrors.mountNotFound(mountId));
  return workspace;
}

function requireWritableWorkspace(workspace: MountedWorkspace): void {
  if (!workspace.mount.canWrite) {
    throw new Error(uiCopy.userSpace.runtimeErrors.readwriteRequired(workspace.mount.name));
  }
}

async function ensurePermission(
  handle: BrowserFileSystemHandle,
  mode: PermissionMode,
): Promise<void> {
  const descriptor = { mode };
  const queried = await handle.queryPermission?.(descriptor);
  if (queried === "granted" || !handle.requestPermission) return;
  const requested = await handle.requestPermission(descriptor);
  if (requested !== "granted") throw new Error("Directory permission was not granted.");
}

export function normalizeUserSpacePath(path: string): string {
  const raw = path;
  if (!raw || raw === ".") return "";
  if (raw.startsWith("/")) throw new Error(uiCopy.userSpace.runtimeErrors.absolutePathUnsupported);
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw new Error("Path traversal outside the mounted directory is not allowed.");
    parts.push(part);
  }
  return parts.join("/");
}

function normalizeRequiredPath(value: unknown): string {
  const path = normalizeUserSpacePath(requireString(value, "path"));
  if (!path) throw new Error("Path must not be empty.");
  return path;
}

function isHiddenWorkspacePath(path: string): boolean {
  return splitUserPath(path).some((part) => part.startsWith("."));
}

function splitUserPath(path: string): string[] {
  return path ? path.split("/") : [];
}

function joinUserPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function normalizeUserSpaceEntryName(value: unknown, name: string): string {
  const entryName = requireString(value, name).trim();
  if (!entryName) throw new Error(`${name} must not be empty.`);
  if (entryName === "." || entryName === "..")
    throw new Error(`${name} must be a file or folder name.`);
  if (entryName.includes("/") || entryName.includes("\\"))
    throw new Error(`${name} must not contain path separators.`);
  if (entryName.includes("\0")) throw new Error(`${name} must not contain null bytes.`);
  if (entryName.length > 255) throw new Error(`${name} is too long.`);
  return entryName;
}

interface WorkspaceCopyOptions {
  onTargetCreated?: () => void;
  onManifestReady?: (manifest: WorkspaceCopyManifest) => void;
}

type WorkspaceCopyManifest =
  | {
      kind: "file";
      sourceHandle: BrowserFileSystemFileHandle;
      targetHandle: BrowserFileSystemFileHandle;
      sourceSnapshot: File;
      targetSnapshot: File;
    }
  | {
      kind: "directory";
      sourceHandle: BrowserFileSystemDirectoryHandle;
      targetHandle: BrowserFileSystemDirectoryHandle;
      children: Map<string, WorkspaceCopyManifest>;
    };

type UncachedWorkspaceHandleLookup =
  | { status: "found"; handle: BrowserFileSystemHandle }
  | { status: "missing" }
  | { status: "conflict" };

const WORKSPACE_COMPARE_CHUNK_BYTES = 1024 * 1024;

function fileSystemErrorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function isFileSystemNotFound(error: unknown): boolean {
  return fileSystemErrorName(error) === "NotFoundError";
}

function isFileSystemTypeMismatch(error: unknown): boolean {
  return fileSystemErrorName(error) === "TypeMismatchError";
}

async function assertWorkspaceEntryAbsent(
  parent: BrowserFileSystemDirectoryHandle,
  name: string,
  targetPath: string,
  lease: UserSpaceWorkspaceLease,
): Promise<void> {
  try {
    await parent.getFileHandle(name);
    throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === uiCopy.userSpace.runtimeErrors.entryExists(targetPath)
    ) {
      throw error;
    }
    if (isFileSystemTypeMismatch(error)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
    }
    if (!isFileSystemNotFound(error)) throw error;
  }
  assertWorkspaceLease(lease);
  try {
    await parent.getDirectoryHandle(name);
    throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === uiCopy.userSpace.runtimeErrors.entryExists(targetPath)
    ) {
      throw error;
    }
    if (isFileSystemTypeMismatch(error)) {
      throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
    }
    if (!isFileSystemNotFound(error)) throw error;
  }
  assertWorkspaceLease(lease);
}

async function lookupUncachedWorkspaceHandle(
  workspace: MountedWorkspace,
  path: string,
  kind: FileSystemHandleKind,
  lease: UserSpaceWorkspaceLease,
): Promise<UncachedWorkspaceHandleLookup> {
  const parts = splitUserPath(normalizeRequiredPath(path));
  const name = parts.pop();
  if (!name) return { status: "missing" };
  let parent = workspace.root;
  for (const part of parts) {
    try {
      parent = await parent.getDirectoryHandle(part);
    } catch (error) {
      if (isFileSystemNotFound(error)) return { status: "missing" };
      if (isFileSystemTypeMismatch(error)) return { status: "conflict" };
      throw error;
    }
    assertWorkspaceLease(lease);
  }
  try {
    const handle =
      kind === "directory"
        ? await parent.getDirectoryHandle(name)
        : await parent.getFileHandle(name);
    assertWorkspaceLease(lease);
    return { status: "found", handle };
  } catch (error) {
    if (isFileSystemNotFound(error)) return { status: "missing" };
    if (isFileSystemTypeMismatch(error)) return { status: "conflict" };
    throw error;
  }
}

async function getUncachedWorkspaceParent(
  workspace: MountedWorkspace,
  path: string,
  lease: UserSpaceWorkspaceLease,
): Promise<{ parent: BrowserFileSystemDirectoryHandle; name: string }> {
  const parts = splitUserPath(normalizeRequiredPath(path));
  const name = parts.pop();
  if (!name) throw new Error("Path must refer to an entry inside the mounted directory.");
  let parent = workspace.root;
  for (const part of parts) {
    parent = await parent.getDirectoryHandle(part);
    assertWorkspaceLease(lease);
  }
  return { parent, name };
}

async function readDirectoryShape(
  directory: BrowserFileSystemDirectoryHandle,
  lease: UserSpaceWorkspaceLease,
): Promise<Map<string, FileSystemHandleKind>> {
  const shape = new Map<string, FileSystemHandleKind>();
  let processed = 0;
  for await (const handle of iterateDirectory(directory)) {
    shape.set(handle.name, handle.kind);
    processed++;
    if (processed % 80 === 0) await yieldToBrowser();
    assertWorkspaceLease(lease);
  }
  return shape;
}

function directoryShapesMatch(
  left: Map<string, FileSystemHandleKind>,
  right: Map<string, FileSystemHandleKind>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [name, kind] of left) {
    if (right.get(name) !== kind) return false;
  }
  return true;
}

async function getDirectoryChildHandle(
  directory: BrowserFileSystemDirectoryHandle,
  name: string,
  kind: FileSystemHandleKind,
  lease: UserSpaceWorkspaceLease,
): Promise<BrowserFileSystemHandle | null> {
  try {
    const handle =
      kind === "directory"
        ? await directory.getDirectoryHandle(name)
        : await directory.getFileHandle(name);
    assertWorkspaceLease(lease);
    return handle;
  } catch (error) {
    if (isFileSystemNotFound(error) || isFileSystemTypeMismatch(error)) return null;
    throw error;
  }
}

async function fileSnapshotsMatch(
  source: File,
  target: File,
  lease: UserSpaceWorkspaceLease,
): Promise<boolean> {
  if (source.size !== target.size) return false;
  for (let offset = 0; offset < source.size; offset += WORKSPACE_COMPARE_CHUNK_BYTES) {
    const end = Math.min(source.size, offset + WORKSPACE_COMPARE_CHUNK_BYTES);
    const [sourceChunk, targetChunk] = await Promise.all([
      source.slice(offset, end).arrayBuffer(),
      target.slice(offset, end).arrayBuffer(),
    ]);
    const sourceBytes = new Uint8Array(sourceChunk);
    const targetBytes = new Uint8Array(targetChunk);
    if (sourceBytes.length !== targetBytes.length) return false;
    for (let index = 0; index < sourceBytes.length; index++) {
      if (sourceBytes[index] !== targetBytes[index]) return false;
    }
    assertWorkspaceLease(lease);
    if (offset > 0 && offset % (WORKSPACE_COMPARE_CHUNK_BYTES * 16) === 0) {
      await yieldToBrowser();
      assertWorkspaceLease(lease);
    }
  }
  return true;
}

async function workspaceHandleMatchesManifest(
  handle: BrowserFileSystemHandle,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
  side: "source" | "target" = "target",
): Promise<boolean> {
  if (handle.kind !== manifest.kind) return false;
  if (manifest.kind === "file") {
    const fileHandle = handle as BrowserFileSystemFileHandle;
    const snapshot = side === "source" ? manifest.sourceSnapshot : manifest.targetSnapshot;
    const current = await fileHandle.getFile();
    assertWorkspaceLease(lease);
    if (!(await fileSnapshotsMatch(snapshot, current, lease))) return false;
    const final = await fileHandle.getFile();
    assertWorkspaceLease(lease);
    return (
      final.size === current.size &&
      final.lastModified === current.lastModified &&
      (await fileSnapshotsMatch(snapshot, final, lease))
    );
  }

  const directory = handle as BrowserFileSystemDirectoryHandle;
  const initialShape = await readDirectoryShape(directory, lease);
  if (initialShape.size !== manifest.children.size) return false;
  for (const [name, childManifest] of manifest.children) {
    if (initialShape.get(name) !== childManifest.kind) return false;
    const child = await getDirectoryChildHandle(directory, name, childManifest.kind, lease);
    if (!child || !(await workspaceHandleMatchesManifest(child, childManifest, lease, side))) {
      return false;
    }
  }
  const finalShape = await readDirectoryShape(directory, lease);
  return directoryShapesMatch(initialShape, finalShape);
}

async function workspaceHandleMetadataMatchesManifest(
  handle: BrowserFileSystemHandle,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
  side: "source" | "target" = "target",
): Promise<boolean> {
  if (handle.kind !== manifest.kind) return false;
  if (manifest.kind === "file") {
    const snapshot = side === "source" ? manifest.sourceSnapshot : manifest.targetSnapshot;
    const current = await (handle as BrowserFileSystemFileHandle).getFile();
    assertWorkspaceLease(lease);
    return current.size === snapshot.size && current.lastModified === snapshot.lastModified;
  }

  const directory = handle as BrowserFileSystemDirectoryHandle;
  const initialShape = await readDirectoryShape(directory, lease);
  if (initialShape.size !== manifest.children.size) return false;
  for (const [name, childManifest] of manifest.children) {
    if (initialShape.get(name) !== childManifest.kind) return false;
    const child = await getDirectoryChildHandle(directory, name, childManifest.kind, lease);
    if (
      !child ||
      !(await workspaceHandleMetadataMatchesManifest(child, childManifest, lease, side))
    ) {
      return false;
    }
  }
  const finalShape = await readDirectoryShape(directory, lease);
  return directoryShapesMatch(initialShape, finalShape);
}

async function isSameWorkspaceHandle(
  left: BrowserFileSystemHandle,
  right: BrowserFileSystemHandle,
): Promise<boolean> {
  if (left === right) return true;
  try {
    if (left.isSameEntry && (await left.isSameEntry(right))) return true;
  } catch {
    // Try the reverse comparison when one wrapper rejects the call.
  }
  try {
    return Boolean(right.isSameEntry && (await right.isSameEntry(left)));
  } catch {
    return false;
  }
}

async function workspaceEntryManifestStatus(
  workspace: MountedWorkspace,
  path: string,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
): Promise<"missing" | "matching" | "changed"> {
  const lookup = await lookupUncachedWorkspaceHandle(workspace, path, manifest.kind, lease);
  if (lookup.status === "missing") return "missing";
  if (lookup.status === "conflict") return "changed";
  if (!(await isSameWorkspaceHandle(manifest.targetHandle, lookup.handle))) return "changed";
  if (!(await workspaceHandleMatchesManifest(lookup.handle, manifest, lease))) return "changed";
  if (!(await workspaceHandleMetadataMatchesManifest(lookup.handle, manifest, lease))) {
    return "changed";
  }
  const finalLookup = await lookupUncachedWorkspaceHandle(workspace, path, manifest.kind, lease);
  return finalLookup.status === "found" &&
    (await isSameWorkspaceHandle(lookup.handle, finalLookup.handle))
    ? "matching"
    : "changed";
}

async function restoreWorkspaceSourceFromTarget(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetPath: string,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
): Promise<boolean> {
  if ((await workspaceEntryManifestStatus(workspace, targetPath, manifest, lease)) !== "matching") {
    return false;
  }
  return restoreWorkspaceSourceManifestEntries(workspace, sourcePath, targetPath, manifest, lease);
}

async function restoreWorkspaceSourceManifestEntries(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetPath: string,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
): Promise<boolean> {
  const sourceLookup = await lookupUncachedWorkspaceHandle(
    workspace,
    sourcePath,
    manifest.kind,
    lease,
  );
  if (sourceLookup.status === "conflict") return false;
  if (sourceLookup.status === "missing") {
    const sourceParent = (await getUncachedWorkspaceParent(workspace, sourcePath, lease)).parent;
    let restoredManifest: WorkspaceCopyManifest;
    if (manifest.kind === "directory") {
      restoredManifest = await copyDirectoryEntry(
        workspace,
        targetPath,
        sourcePath,
        sourceParent,
        lease,
      );
    } else {
      restoredManifest = await copyFileEntry(
        workspace,
        targetPath,
        sourcePath,
        sourceParent,
        lease,
      );
      await upsertFileMetadata(workspace, sourcePath);
    }
    const restored = await lookupUncachedWorkspaceHandle(
      workspace,
      sourcePath,
      manifest.kind,
      lease,
    );
    return (
      restored.status === "found" &&
      (await isSameWorkspaceHandle(restoredManifest.targetHandle, restored.handle)) &&
      (await workspaceHandleMatchesManifest(restored.handle, manifest, lease, "source"))
    );
  }

  if (!(await isSameWorkspaceHandle(manifest.sourceHandle, sourceLookup.handle))) return false;

  if (manifest.kind === "file") {
    return (
      (await workspaceHandleMatchesManifest(sourceLookup.handle, manifest, lease, "source")) &&
      (await workspaceHandleMetadataMatchesManifest(sourceLookup.handle, manifest, lease, "source"))
    );
  }

  // A partially deleted source directory may now contain unrelated external
  // additions. Preserve those entries and restore only missing manifest paths;
  // an existing expected file must still match its original bytes.
  for (const [name, childManifest] of manifest.children) {
    if (
      !(await restoreWorkspaceSourceManifestEntries(
        workspace,
        joinUserPath(sourcePath, name),
        joinUserPath(targetPath, name),
        childManifest,
        lease,
      ))
    ) {
      return false;
    }
  }
  const finalSource = await lookupUncachedWorkspaceHandle(
    workspace,
    sourcePath,
    manifest.kind,
    lease,
  );
  return (
    finalSource.status === "found" &&
    (await isSameWorkspaceHandle(manifest.sourceHandle, finalSource.handle))
  );
}

async function removeWorkspaceEntryMatchingManifest(
  workspace: MountedWorkspace,
  path: string,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
): Promise<"missing" | "removed" | "changed"> {
  const lookup = await lookupUncachedWorkspaceHandle(workspace, path, manifest.kind, lease);
  if (lookup.status === "missing") return "missing";
  if (lookup.status === "conflict") return "changed";
  const handle = lookup.handle;
  if (!(await isSameWorkspaceHandle(manifest.targetHandle, handle))) return "changed";

  if (manifest.kind === "directory") {
    const directory = handle as BrowserFileSystemDirectoryHandle;
    const shape = await readDirectoryShape(directory, lease);
    if (shape.size !== manifest.children.size) return "changed";
    for (const [name, childManifest] of manifest.children) {
      if (shape.get(name) !== childManifest.kind) return "changed";
    }
    const names = Array.from(manifest.children.keys()).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of names) {
      const childManifest = manifest.children.get(name);
      if (!childManifest) return "changed";
      const childStatus = await removeWorkspaceEntryMatchingManifest(
        workspace,
        joinUserPath(path, name),
        childManifest,
        lease,
      );
      if (childStatus !== "removed") return "changed";
    }
    if ((await readDirectoryShape(directory, lease)).size !== 0) return "changed";
  } else {
    if (!(await workspaceHandleMatchesManifest(handle, manifest, lease, "target"))) {
      return "changed";
    }
    if (!(await workspaceHandleMetadataMatchesManifest(handle, manifest, lease, "target"))) {
      return "changed";
    }
  }

  const finalLookup = await lookupUncachedWorkspaceHandle(workspace, path, manifest.kind, lease);
  if (
    finalLookup.status !== "found" ||
    !(await isSameWorkspaceHandle(manifest.targetHandle, finalLookup.handle))
  ) {
    return "changed";
  }
  const { parent, name } = await getUncachedWorkspaceParent(workspace, path, lease);
  await assertWorkspaceWritePermission(lease);
  const immediateTarget = await getDirectoryChildHandle(parent, name, manifest.kind, lease);
  if (!immediateTarget || !(await isSameWorkspaceHandle(manifest.targetHandle, immediateTarget))) {
    return "changed";
  }
  // Deliberately omit recursive:true. If another process adds an entry after
  // our per-child validation, the browser must fail this remove instead of
  // deleting that new external content.
  // File System Access has no conditional "remove this exact handle" primitive,
  // so an external replacement can still land in the narrow interval between
  // this final identity check and the name-based removeEntry() call.
  await parent.removeEntry(name);
  assertWorkspaceLease(lease);
  return "removed";
}

async function removeWorkspaceSourceAfterVerifiedCopy(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetPath: string,
  manifest: WorkspaceCopyManifest,
  lease: UserSpaceWorkspaceLease,
  onSourceDeletionAttempt: () => void,
): Promise<boolean> {
  const [sourceLookup, targetLookup] = await Promise.all([
    lookupUncachedWorkspaceHandle(workspace, sourcePath, manifest.kind, lease),
    lookupUncachedWorkspaceHandle(workspace, targetPath, manifest.kind, lease),
  ]);
  if (sourceLookup.status !== "found" || targetLookup.status !== "found") return false;
  const sourceHandle = sourceLookup.handle;
  const targetHandle = targetLookup.handle;
  if (
    !(await isSameWorkspaceHandle(manifest.sourceHandle, sourceHandle)) ||
    !(await isSameWorkspaceHandle(manifest.targetHandle, targetHandle))
  ) {
    return false;
  }

  if (manifest.kind === "directory") {
    const sourceDirectory = sourceHandle as BrowserFileSystemDirectoryHandle;
    const targetDirectory = targetHandle as BrowserFileSystemDirectoryHandle;
    const [sourceShape, targetShape] = await Promise.all([
      readDirectoryShape(sourceDirectory, lease),
      readDirectoryShape(targetDirectory, lease),
    ]);
    if (
      sourceShape.size !== manifest.children.size ||
      targetShape.size !== manifest.children.size
    ) {
      return false;
    }
    for (const [name, childManifest] of manifest.children) {
      if (
        sourceShape.get(name) !== childManifest.kind ||
        targetShape.get(name) !== childManifest.kind
      )
        return false;
    }
    const names = Array.from(manifest.children.keys()).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of names) {
      const childManifest = manifest.children.get(name);
      if (
        !childManifest ||
        !(await removeWorkspaceSourceAfterVerifiedCopy(
          workspace,
          joinUserPath(sourcePath, name),
          joinUserPath(targetPath, name),
          childManifest,
          lease,
          onSourceDeletionAttempt,
        ))
      ) {
        return false;
      }
    }
    if ((await readDirectoryShape(sourceDirectory, lease)).size !== 0) return false;
    const finalTargetShape = await readDirectoryShape(targetDirectory, lease);
    if (!directoryShapesMatch(targetShape, finalTargetShape)) return false;
  } else {
    if (!(await workspaceHandleMatchesManifest(targetHandle, manifest, lease, "target"))) {
      return false;
    }
    if (!(await workspaceHandleMetadataMatchesManifest(targetHandle, manifest, lease, "target"))) {
      return false;
    }
    // Validate the source last, immediately before the identity recheck and
    // non-recursive removal. Deep directories call this per file, so an early
    // file is no longer exposed throughout validation of every later sibling.
    if (!(await workspaceHandleMatchesManifest(sourceHandle, manifest, lease, "source"))) {
      return false;
    }
    if (!(await workspaceHandleMetadataMatchesManifest(sourceHandle, manifest, lease, "source"))) {
      return false;
    }
  }

  const [finalSource, finalTarget] = await Promise.all([
    lookupUncachedWorkspaceHandle(workspace, sourcePath, manifest.kind, lease),
    lookupUncachedWorkspaceHandle(workspace, targetPath, manifest.kind, lease),
  ]);
  if (
    finalSource.status !== "found" ||
    finalTarget.status !== "found" ||
    !(await isSameWorkspaceHandle(manifest.sourceHandle, finalSource.handle)) ||
    !(await isSameWorkspaceHandle(manifest.targetHandle, finalTarget.handle))
  ) {
    return false;
  }
  const { parent, name } = await getUncachedWorkspaceParent(workspace, sourcePath, lease);
  await assertWorkspaceWritePermission(lease);
  const immediateTarget = await lookupUncachedWorkspaceHandle(
    workspace,
    targetPath,
    manifest.kind,
    lease,
  );
  if (
    immediateTarget.status !== "found" ||
    !(await isSameWorkspaceHandle(manifest.targetHandle, immediateTarget.handle))
  ) {
    return false;
  }
  const immediateSource = await getDirectoryChildHandle(parent, name, manifest.kind, lease);
  if (!immediateSource || !(await isSameWorkspaceHandle(manifest.sourceHandle, immediateSource))) {
    return false;
  }
  // removeEntry() is name-based rather than a conditional handle delete. The
  // exact source and destination identities are rechecked as late as possible,
  // but File System Access cannot close the final check-to-remove race with an
  // external process.
  onSourceDeletionAttempt();
  await parent.removeEntry(name);
  assertWorkspaceLease(lease);
  return true;
}

async function copyFileEntry(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetPath: string,
  targetParent: BrowserFileSystemDirectoryHandle | undefined,
  lease: UserSpaceWorkspaceLease,
  options: WorkspaceCopyOptions = {},
): Promise<WorkspaceCopyManifest> {
  const sourceHandle = await getFileHandle(workspace, sourcePath, false, lease);
  const file = await sourceHandle.getFile();
  assertWorkspaceLease(lease);
  const parent =
    targetParent || (await getParentDirectory(workspace, targetPath, false, lease)).parent;
  const targetName = basenameUserPath(targetPath);
  await assertWorkspaceWritePermission(lease);
  // File System Access has no atomic "create only if absent" primitive. Keep
  // the authoritative absence lookup adjacent to create:true, then inspect the
  // returned entry before opening a writer. An externally-created empty file is
  // indistinguishable from the empty file create:true just created; exclusive
  // writer locking plus the final pre-close evidence check narrows, but cannot
  // eliminate, that platform-level race with processes outside this origin.
  await assertWorkspaceEntryAbsent(parent, targetName, targetPath, lease);
  const handle = await parent.getFileHandle(targetName, { create: true });
  assertWorkspaceLease(lease);
  const initialTarget = await handle.getFile();
  assertWorkspaceLease(lease);
  if (initialTarget.size !== 0) {
    throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
  }
  options.onTargetCreated?.();
  const writable = await handle.createWritable({ mode: "exclusive" });
  await commitWritableFile(lease, writable, file, undefined, async () => {
    const currentTarget = await handle.getFile();
    assertWorkspaceLease(lease);
    if (
      currentTarget.size !== initialTarget.size ||
      currentTarget.lastModified !== initialTarget.lastModified ||
      !(await fileSnapshotsMatch(initialTarget, currentTarget, lease))
    ) {
      throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
    }
  });
  const committedTarget = await handle.getFile();
  assertWorkspaceLease(lease);
  if (!(await fileSnapshotsMatch(file, committedTarget, lease))) {
    throw new Error(uiCopy.userSpace.runtimeErrors.moveSourceChanged(sourcePath));
  }
  setCachedFileHandle(workspace, targetPath, handle);
  // File objects are immutable snapshots. Keep evidence from both sides so a
  // final source check can detect edits made while a deep directory is copied,
  // while rollback cleanup can independently protect a changed destination.
  const manifest: WorkspaceCopyManifest = {
    kind: "file",
    sourceHandle,
    targetHandle: handle,
    sourceSnapshot: file,
    targetSnapshot: committedTarget,
  };
  options.onManifestReady?.(manifest);
  return manifest;
}

async function copyDirectoryEntry(
  workspace: MountedWorkspace,
  sourcePath: string,
  targetPath: string,
  targetParent: BrowserFileSystemDirectoryHandle | undefined,
  lease: UserSpaceWorkspaceLease,
  options: WorkspaceCopyOptions = {},
): Promise<WorkspaceCopyManifest> {
  const sourceDir = await getDirectory(workspace, sourcePath, false, lease);
  const parent =
    targetParent || (await getParentDirectory(workspace, targetPath, false, lease)).parent;
  const targetName = basenameUserPath(targetPath);
  await assertWorkspaceWritePermission(lease);
  // Directories have the same no-replace limitation. The immediate empty-shape
  // probe detects a non-empty interloper without mutating it; an externally
  // created empty directory cannot be distinguished by this API.
  await assertWorkspaceEntryAbsent(parent, targetName, targetPath, lease);
  const targetDir = await parent.getDirectoryHandle(targetName, { create: true });
  assertWorkspaceLease(lease);
  const initialTargetShape = await readDirectoryShape(targetDir, lease);
  if (initialTargetShape.size !== 0) {
    throw new Error(uiCopy.userSpace.runtimeErrors.entryExists(targetPath));
  }
  options.onTargetCreated?.();
  const children = new Map<string, WorkspaceCopyManifest>();
  const manifest: WorkspaceCopyManifest = {
    kind: "directory",
    sourceHandle: sourceDir,
    targetHandle: targetDir,
    children,
  };
  // Publish the mutable manifest as soon as the durable top-level directory
  // exists. Each completed child is registered before metadata indexing, so a
  // later indexing failure can still clean up only bytes proven to be ours.
  options.onManifestReady?.(manifest);
  setCachedDirectoryHandle(workspace, targetPath, targetDir);
  await upsertDirectoryMetadata(workspace, targetPath);
  assertWorkspaceLease(lease);

  let processed = 0;
  for await (const handle of iterateDirectory(sourceDir)) {
    processed++;
    const sourceChildPath = joinUserPath(sourcePath, handle.name);
    const targetChildPath = joinUserPath(targetPath, handle.name);
    const onChildManifestReady = (childManifest: WorkspaceCopyManifest) => {
      children.set(handle.name, childManifest);
    };
    if (handle.kind === "directory") {
      await copyDirectoryEntry(workspace, sourceChildPath, targetChildPath, targetDir, lease, {
        onManifestReady: onChildManifestReady,
      });
    } else {
      await copyFileEntry(workspace, sourceChildPath, targetChildPath, targetDir, lease, {
        onManifestReady: onChildManifestReady,
      });
      await upsertFileMetadata(workspace, targetChildPath);
    }
    assertWorkspaceLease(lease);
    if (processed % 80 === 0) await yieldToBrowser();
    assertWorkspaceLease(lease);
  }
  return manifest;
}

async function nextAvailableCopyPath(
  workspace: MountedWorkspace,
  parentPath: string,
  sourceName: string,
): Promise<string> {
  for (let index = 1; index <= 999; index++) {
    const candidate = joinUserPath(parentPath, copyNameCandidate(sourceName, index));
    if (!(await findShellEntryStrict(workspace, candidate))) return candidate;
  }
  throw new Error(uiCopy.userSpace.runtimeErrors.uniqueCopyNameFailed);
}

function copyNameCandidate(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return index === 1
    ? `${stem} ${uiCopy.userSpace.copySuffix}${extension}`
    : `${stem} ${uiCopy.userSpace.copySuffix} ${index}${extension}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

async function completeBlobTransfer(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!response.ok)
    throw new Error(await responseErrorText(response, "Blob transfer completion failed."));
}

async function authorizeBlobCheckinCommit(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(
          await responseErrorText(
            response,
            uiCopy.userSpace.runtimeErrors.commitAuthorizationFailed,
          ),
        );
      }
      const result = (await response.json().catch(() => null)) as {
        commitLease?: unknown;
      } | null;
      if (result && typeof result.commitLease === "string" && result.commitLease) {
        return result.commitLease;
      }
      lastError = new Error(uiCopy.userSpace.runtimeErrors.commitLeaseMissing);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(uiCopy.userSpace.runtimeErrors.commitAuthorizationFailed);
}

async function responseErrorText(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : text;
  } catch {
    return text;
  }
}

async function sha256Blob(blob: Blob): Promise<string> {
  if (!crypto?.subtle) throw new Error(uiCopy.userSpace.runtimeErrors.sha256Unsupported);
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end !== -1) {
        let body = glob.slice(index + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        source += `[${body.replace(/\\/g, "\\\\")}]`;
        index = end;
        continue;
      }
    }
    if (char === "{") {
      const end = glob.indexOf("}", index + 1);
      if (end !== -1) {
        const alternatives = glob.slice(index + 1, end).split(",");
        if (alternatives.length > 1) {
          source += `(?:${alternatives.map((alternative) => globToRegExp(alternative).source.slice(1, -1)).join("|")})`;
          index = end;
          continue;
        }
      }
    }
    source += /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

function createWorkspaceGlobMatcher(pattern: string): { regex: RegExp; basenameOnly: boolean } {
  return { regex: globToRegExp(pattern), basenameOnly: !pattern.includes("/") };
}

function matchesWorkspaceGlob(
  matcher: { regex: RegExp; basenameOnly: boolean },
  path: string,
): boolean {
  return matcher.regex.test(matcher.basenameOnly ? basenameUserPath(path) : path);
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function yieldToBrowser(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function recordOperation(
  input: Record<string, unknown>,
  operation: UserSpaceOperation,
  status: "ok" | "error",
  message: string,
  result?: unknown,
  lease?: UserSpaceWorkspaceLease,
): void {
  if (lease && !isWorkspaceLeaseCurrent(lease)) return;
  const mountId = typeof input.mountId === "string" ? input.mountId : undefined;
  const path = typeof input.path === "string" ? input.path : undefined;
  const changedDirs = extractChangedDirs(result);
  const record: UserSpaceOperationRecord = {
    id: `uwo-${Date.now()}-${++operationCounter}`,
    mountId,
    operation,
    path,
    ...(changedDirs ? { changedDirs } : {}),
    status,
    message,
    timestamp: Date.now(),
  };
  if (mountId && mounts.has(mountId)) {
    const workspace = mounts.get(mountId)!;
    if (lease && workspace !== lease.workspace) return;
    workspace.recentOperations = [record, ...workspace.recentOperations].slice(0, 20);
  }
  notify();
}

function recordFileChange(mountId: string, changedDirs: string[]): void {
  const workspace = mounts.get(mountId);
  if (!workspace) return;
  const normalizedDirs = normalizeChangedDirs(changedDirs);
  if (!normalizedDirs) return;
  const timestamp = Date.now();
  workspace.recentFileChanges = [
    {
      id: `uwfc-${timestamp}-${++fileChangeCounter}`,
      mountId,
      changedDirs: normalizedDirs,
      timestamp,
    },
    ...workspace.recentFileChanges,
  ].slice(0, 50);
}

function extractChangedDirs(result: unknown): string[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const rawChangedDirs = (result as { changedDirs?: unknown }).changedDirs;
  return normalizeChangedDirs(rawChangedDirs);
}

function normalizeChangedDirs(rawChangedDirs: unknown): string[] | undefined {
  if (!Array.isArray(rawChangedDirs)) return undefined;
  const normalizedDirs: string[] = [];
  for (const path of rawChangedDirs) {
    if (typeof path !== "string") continue;
    try {
      normalizedDirs.push(normalizeUserSpacePath(path));
    } catch {
      // Ignore malformed change hints so change notification never fails completed work.
    }
  }
  const changedDirs = Array.from(new Set(normalizedDirs)).sort((left, right) =>
    left.localeCompare(right),
  );
  return changedDirs.length > 0 ? changedDirs : undefined;
}

function changedDirsForFilePath(path: string): string[] {
  return changedDirsForDirectoryPath(dirnameUserPath(path));
}

function changedDirsForDirectoryPath(path: string): string[] {
  const dirs: string[] = [];
  let current = normalizeUserSpacePath(path);
  while (true) {
    dirs.push(current);
    if (!current) return dirs;
    current = dirnameUserPath(current);
  }
}

function notifyMountChanged(mountId: string, changedDirs?: string[]): void {
  if (changedDirs?.length) recordFileChange(mountId, changedDirs);
  notify();
  for (const [sessionId, set] of sessionMounts) {
    if (set.has(mountId)) sendSessionStatus(sessionId);
  }
}

function sendSessionStatus(sessionId: string): void {
  const mountIds = sessionMounts.get(sessionId);
  if (!mountIds?.size) return;
  const sessionMountList = Array.from(mountIds)
    .map((mountId) => mounts.get(mountId)?.mount)
    .filter((mount): mount is UserSpaceMount => Boolean(mount))
    .map((mount) => ({ ...mount, status: "mounted" as const }));
  if (sessionMountList.length === 0 || !transport) return;
  const signature = JSON.stringify(sessionMountList);
  if (lastSessionStatusSignatures.get(sessionId) === signature) return;
  lastSessionStatusSignatures.set(sessionId, signature);
  transport(sessionId, { type: "user_space_mount", mounts: sessionMountList });
}

function sendWorkspaceIndexUpdate(mountId: string): void {
  const workspace = mounts.get(mountId);
  if (!workspace?.mount.lastIndexedAt || typeof workspace.mount.fileCount !== "number") return;
  for (const [sessionId, set] of sessionMounts) {
    if (!set.has(mountId)) continue;
    transport?.(sessionId, {
      type: "user_space_index_update",
      mountId,
      fileCount: workspace.mount.fileCount,
      lastIndexedAt: workspace.mount.lastIndexedAt,
    });
  }
}

function notify(): void {
  snapshotVersion++;
  cachedSnapshot = null;
  for (const listener of listeners) listener();
}

function getTestWorkspaceRoot(): BrowserFileSystemDirectoryHandle | null {
  const spec = getTestWorkspaceSpec();
  return spec ? createTestDirectoryHandle(spec) : null;
}

function getTestWorkspaceSpec(): TestWorkspaceSpec | null {
  if (typeof window === "undefined") return null;
  const injected = (
    window as unknown as {
      __PIWORK_TEST_USER_SPACE__?: TestWorkspaceSpec;
    }
  ).__PIWORK_TEST_USER_SPACE__;
  if (injected) return injected;

  try {
    const raw = window.localStorage?.getItem(TEST_WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TestWorkspaceSpec;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function createTestDirectoryHandle(spec: TestWorkspaceSpec): BrowserFileSystemDirectoryHandle {
  const root = new TestDirectoryHandle(spec.name || "Test Workspace");
  for (const directory of spec.directories || [])
    root.ensureDirectory(normalizeUserSpacePath(directory));
  for (const [path, content] of Object.entries(spec.files || {})) {
    root.ensureFile(normalizeRequiredPath(path), String(content));
  }
  return root;
}

class TestFileHandle implements BrowserFileSystemFileHandle {
  kind = "file" as const;
  private lastModified = Date.now();

  constructor(
    public name: string,
    private content: string,
  ) {}

  async queryPermission(): Promise<PermissionState> {
    return "granted";
  }

  async requestPermission(): Promise<PermissionState> {
    return "granted";
  }

  async getFile(): Promise<File> {
    return new File([this.content], this.name, {
      lastModified: this.lastModified,
      type: "text/plain",
    });
  }

  async createWritable(): Promise<BrowserFileSystemWritableFileStream> {
    return {
      write: async (data) => {
        if (typeof data === "string") {
          this.content = data;
        } else if (data instanceof Blob) {
          this.content = await data.text();
        } else {
          this.content = new TextDecoder().decode(data);
        }
        this.lastModified = Date.now();
      },
      close: async () => {},
    };
  }
}

class TestDirectoryHandle implements BrowserFileSystemDirectoryHandle {
  kind = "directory" as const;
  private entriesMap = new Map<string, TestDirectoryHandle | TestFileHandle>();

  constructor(public name: string) {}

  async queryPermission(): Promise<PermissionState> {
    return "granted";
  }

  async requestPermission(): Promise<PermissionState> {
    return "granted";
  }

  async *values(): AsyncIterable<BrowserFileSystemHandle> {
    for (const handle of this.entriesMap.values()) yield handle;
  }

  async *entries(): AsyncIterable<[string, BrowserFileSystemHandle]> {
    for (const [name, handle] of this.entriesMap) yield [name, handle];
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileSystemDirectoryHandle> {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === "directory") return existing;
    if (!options?.create) throw new DOMException("Not found", "NotFoundError");
    const directory = new TestDirectoryHandle(name);
    this.entriesMap.set(name, directory);
    return directory;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BrowserFileSystemFileHandle> {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === "file") return existing;
    if (!options?.create) throw new DOMException("Not found", "NotFoundError");
    const file = new TestFileHandle(name, "");
    this.entriesMap.set(name, file);
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entriesMap.delete(name)) throw new DOMException("Not found", "NotFoundError");
  }

  ensureDirectory(path: string): TestDirectoryHandle {
    let directory: TestDirectoryHandle = this;
    for (const part of splitUserPath(path)) {
      const existing = directory.entriesMap.get(part);
      if (existing?.kind === "directory") {
        directory = existing;
        continue;
      }
      const next = new TestDirectoryHandle(part);
      directory.entriesMap.set(part, next);
      directory = next;
    }
    return directory;
  }

  ensureFile(path: string, content: string): void {
    const parts = splitUserPath(path);
    const name = parts.pop();
    if (!name) throw new Error("Test workspace file path must not be empty.");
    this.ensureDirectory(parts.join("/")).entriesMap.set(name, new TestFileHandle(name, content));
  }
}
