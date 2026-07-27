import {
  type IndexedWorkspaceContentSearchResult,
  type IndexedWorkspaceEntry,
  type IndexedWorkspaceList,
} from "./user-space-index.js";
import {
  classifyWorkspacePreviewKind,
  previewKindForWorkspacePath,
  TsUserSpaceMetadataIndex,
} from "./user-space-ts-index.js";
import { runtimeContextCoordinator } from "./runtime-context.js";

type FileSystemHandleKind = "file" | "directory";
type PermissionMode = "read" | "readwrite";

interface BrowserFileSystemHandle {
  kind: FileSystemHandleKind;
  name: string;
  queryPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionState>;
}

interface BrowserFileSystemFileHandle extends BrowserFileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
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
}

export interface UserSpaceRuntime {
  rebuild(): Promise<UserSpaceMetadataSnapshot>;
  addEntries(entries: IndexedWorkspaceEntry[]): Promise<void>;
  removePath(path: string): Promise<void>;
  indexSubtree(
    path: string,
    maxDepth?: number,
  ): Promise<{ entryCount: number; fileCount: number; lastIndexedAt: number }>;
  clearIndex(): Promise<void>;
  listDir(
    path: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): Promise<IndexedWorkspaceList>;
  searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): Promise<IndexedWorkspaceList>;
  walkTree(
    path: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): Promise<IndexedWorkspaceList>;
  searchContent(input: {
    query: string;
    mode: "text" | "regex";
    pathPrefix?: string;
    includeHidden?: boolean;
    ignoreCase?: boolean;
    invert?: boolean;
    limit: number;
    contextLines: number;
  }): Promise<IndexedWorkspaceContentSearchResult>;
  drop(): void;
}

export type UserSpaceMetadataSnapshot = {
  fileCount: number;
  entryCount: number;
  lastIndexedAt: number;
};

export interface UserSpaceMetadataIndexAdapter {
  begin(): void | Promise<void>;
  addBatch(entries: IndexedWorkspaceEntry[]): void | Promise<void>;
  upsertBatch(entries: IndexedWorkspaceEntry[]): void | Promise<void>;
  removePath(path: string): void | Promise<void>;
  commit():
    { fileCount: number; entryCount: number } | Promise<{ fileCount: number; entryCount: number }>;
  abort(): void | Promise<void>;
  clear(): void | Promise<void>;
  listChildren(
    parentPath: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): IndexedWorkspaceList | Promise<IndexedWorkspaceList>;
  searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): IndexedWorkspaceList | Promise<IndexedWorkspaceList>;
  walkTree(
    path: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): IndexedWorkspaceList | Promise<IndexedWorkspaceList>;
  searchContent(input: {
    query: string;
    mode: "text" | "regex";
    pathPrefix?: string;
    includeHidden?: boolean;
    ignoreCase?: boolean;
    invert?: boolean;
    limit: number;
    contextLines: number;
  }): IndexedWorkspaceContentSearchResult | Promise<IndexedWorkspaceContentSearchResult>;
  stats():
    | { fileCount: number; entryCount: number; building: boolean }
    | Promise<{ fileCount: number; entryCount: number; building: boolean }>;
}

const TEXT_PROBE_BYTES = 4096;
const SCAN_BATCH_SIZE = 128;
const USER_SPACE_RUNTIME_DISPOSED_CODE = "USER_SPACE_RUNTIME_DISPOSED";
const CONTEXT_RECOVERY_ATTEMPTS = 3;

export class UserSpaceRuntimeDisposedError extends Error {
  readonly code = USER_SPACE_RUNTIME_DISPOSED_CODE;

  constructor() {
    super(USER_SPACE_RUNTIME_DISPOSED_CODE);
    this.name = "UserSpaceRuntimeDisposedError";
  }
}

export function isUserSpaceRuntimeDisposedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  return (
    candidate.code === USER_SPACE_RUNTIME_DISPOSED_CODE ||
    candidate.name === "UserSpaceRuntimeDisposedError" ||
    // Accept the pre-code error so an already-open tab can recover after HMR.
    candidate.message === "User space runtime disposed."
  );
}

export function createUserSpaceRuntime(
  mountId: string,
  root: BrowserFileSystemDirectoryHandle,
): UserSpaceRuntime {
  return new ContextScopedUserSpaceRuntime(() => createRawUserSpaceRuntime(mountId, root));
}

function createRawUserSpaceRuntime(
  mountId: string,
  root: BrowserFileSystemDirectoryHandle,
): UserSpaceRuntime {
  if (canUseWorkspaceWorker(root)) {
    try {
      return new WorkerUserSpaceRuntime(mountId, root);
    } catch {
      return new InlineUserSpaceRuntime(root, new TsUserSpaceMetadataIndex(mountId));
    }
  }
  return new InlineUserSpaceRuntime(root, new TsUserSpaceMetadataIndex(mountId));
}

/**
 * Keeps a mounted directory handle at user scope while binding its active
 * worker/index runtime to exactly one agent/session epoch. Disposing the
 * old context terminates the worker and rejects its pending requests; the next
 * context lazily creates a fresh runtime from the still-authorized handle.
 */
export class ContextScopedUserSpaceRuntime implements UserSpaceRuntime {
  private delegate: UserSpaceRuntime | null = null;
  private ownerEpoch: number | null = null;
  private detachScope: (() => void) | null = null;
  private dropped = false;

  constructor(private readonly factory: () => UserSpaceRuntime) {}

  rebuild(): Promise<UserSpaceMetadataSnapshot> {
    return this.run((runtime) => runtime.rebuild());
  }

  addEntries(entries: IndexedWorkspaceEntry[]): Promise<void> {
    return this.run((runtime) => runtime.addEntries(entries));
  }

  removePath(path: string): Promise<void> {
    return this.run((runtime) => runtime.removePath(path));
  }

  indexSubtree(
    path: string,
    maxDepth?: number,
  ): Promise<{ entryCount: number; fileCount: number; lastIndexedAt: number }> {
    return this.run((runtime) => runtime.indexSubtree(path, maxDepth));
  }

  clearIndex(): Promise<void> {
    return this.run((runtime) => runtime.clearIndex());
  }

  listDir(
    path: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): Promise<IndexedWorkspaceList> {
    return this.run((runtime) => runtime.listDir(path, limit, cursor, includeHidden));
  }

  searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden?: boolean,
  ): Promise<IndexedWorkspaceList> {
    return this.run((runtime) => runtime.searchPaths(query, limit, cursor, includeHidden));
  }

  walkTree(
    path: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): Promise<IndexedWorkspaceList> {
    return this.run((runtime) => runtime.walkTree(path, options));
  }

  searchContent(input: {
    query: string;
    mode: "text" | "regex";
    pathPrefix?: string;
    includeHidden?: boolean;
    ignoreCase?: boolean;
    invert?: boolean;
    limit: number;
    contextLines: number;
  }): Promise<IndexedWorkspaceContentSearchResult> {
    return this.run((runtime) => runtime.searchContent(input));
  }

  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.releaseDelegate();
  }

  private async run<T>(operation: (runtime: UserSpaceRuntime) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONTEXT_RECOVERY_ATTEMPTS; attempt++) {
      const runtime = this.current();
      const ownerEpoch = this.ownerEpoch;
      try {
        return await operation(runtime);
      } catch (error) {
        lastError = error;
        if (
          this.dropped ||
          !isUserSpaceRuntimeDisposedError(error) ||
          (this.delegate === runtime && this.ownerEpoch === ownerEpoch)
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private current(): UserSpaceRuntime {
    if (this.dropped) throw new UserSpaceRuntimeDisposedError();
    const lease = runtimeContextCoordinator.current();
    const epoch = lease?.context.epoch ?? null;
    if (this.delegate && this.ownerEpoch === epoch) return this.delegate;

    this.releaseDelegate();
    const runtime = this.factory();
    this.delegate = runtime;
    this.ownerEpoch = epoch;
    if (lease) {
      this.detachScope = lease.scope.add(() => {
        if (this.delegate !== runtime) return;
        this.delegate = null;
        this.ownerEpoch = null;
        this.detachScope = null;
        runtime.drop();
      });
    }
    return runtime;
  }

  private releaseDelegate(): void {
    const runtime = this.delegate;
    const detach = this.detachScope;
    this.delegate = null;
    this.ownerEpoch = null;
    this.detachScope = null;
    detach?.();
    runtime?.drop();
  }
}

export class InlineUserSpaceRuntime implements UserSpaceRuntime {
  private generation = 0;

  constructor(
    private readonly root: BrowserFileSystemDirectoryHandle,
    private readonly index: UserSpaceMetadataIndexAdapter,
  ) {}

  async rebuild(): Promise<UserSpaceMetadataSnapshot> {
    const generation = ++this.generation;
    await this.index.begin();
    const batch: IndexedWorkspaceEntry[] = [];
    try {
      await this.scanDirectory(this.root, "", 0, generation, batch, "replace");
      if (generation !== this.generation) {
        await this.index.abort();
        return { ...(await this.index.stats()), lastIndexedAt: Date.now() };
      }
      await flushBatch(this.index, batch);
      const committed = await this.index.commit();
      return {
        ...committed,
        lastIndexedAt: Date.now(),
      };
    } catch (error) {
      await this.index.abort();
      throw error;
    }
  }

  async addEntries(entries: IndexedWorkspaceEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.index.upsertBatch(entries);
  }

  async removePath(path: string): Promise<void> {
    await this.index.removePath(path);
  }

  async indexSubtree(
    path: string,
    maxDepth?: number,
  ): Promise<{ entryCount: number; fileCount: number; lastIndexedAt: number }> {
    const generation = ++this.generation;
    const batch: IndexedWorkspaceEntry[] = [];
    const root = await this.getDirectory(path);
    let entryCount = 0;
    let fileCount = 0;
    try {
      const maxAbsoluteDepth =
        maxDepth === undefined ? undefined : splitUserPath(path).length + maxDepth;
      const result = await this.scanDirectory(
        root,
        path,
        splitUserPath(path).length,
        generation,
        batch,
        "upsert",
        maxAbsoluteDepth,
      );
      if (generation !== this.generation)
        return { entryCount: 0, fileCount: 0, lastIndexedAt: Date.now() };
      entryCount = result.entryCount;
      fileCount = result.fileCount;
      await flushUpsertBatch(this.index, batch);
      return { entryCount, fileCount, lastIndexedAt: Date.now() };
    } catch (error) {
      throw error;
    }
  }

  async clearIndex(): Promise<void> {
    this.generation++;
    await this.index.clear();
  }

  async listDir(
    path: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): Promise<IndexedWorkspaceList> {
    return this.index.listChildren(path, limit, cursor, includeHidden);
  }

  async searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): Promise<IndexedWorkspaceList> {
    return this.index.searchPaths(query, limit, cursor, includeHidden);
  }

  async walkTree(
    path: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): Promise<IndexedWorkspaceList> {
    return this.index.walkTree(path, options);
  }

  async searchContent(input: {
    query: string;
    mode: "text" | "regex";
    pathPrefix?: string;
    includeHidden?: boolean;
    ignoreCase?: boolean;
    invert?: boolean;
    limit: number;
    contextLines: number;
  }): Promise<IndexedWorkspaceContentSearchResult> {
    return this.index.searchContent(input);
  }

  drop(): void {
    this.generation++;
    void this.index.clear();
  }

  private async getDirectory(path: string): Promise<BrowserFileSystemDirectoryHandle> {
    let dir = this.root;
    for (const part of splitUserPath(path)) {
      dir = await dir.getDirectoryHandle(part);
    }
    return dir;
  }

  private async scanDirectory(
    dir: BrowserFileSystemDirectoryHandle,
    basePath: string,
    depth: number,
    generation: number,
    batch: IndexedWorkspaceEntry[],
    mode: "replace" | "upsert",
    maxDepth?: number,
  ): Promise<{ entryCount: number; fileCount: number }> {
    let entryCount = 0;
    let fileCount = 0;
    for await (const handle of iterateDirectory(dir)) {
      if (generation !== this.generation) return { entryCount, fileCount };
      const path = joinUserPath(basePath, handle.name);
      if (handle.kind === "directory") {
        const directoryHandle = handle as BrowserFileSystemDirectoryHandle;
        const entry = entryFromDirectoryHandle(path, directoryHandle, depth + 1);
        batch.push(entry);
        entryCount++;
        if (batch.length >= SCAN_BATCH_SIZE) await flushScanBatchAndYield(this.index, batch, mode);
        if (maxDepth === undefined || depth + 1 < maxDepth) {
          const child = await this.scanDirectory(
            directoryHandle,
            path,
            depth + 1,
            generation,
            batch,
            mode,
            maxDepth,
          );
          entryCount += child.entryCount;
          fileCount += child.fileCount;
        }
        continue;
      }
      const entry = await entryFromFileHandle(
        path,
        handle as BrowserFileSystemFileHandle,
        depth + 1,
      );
      if (!entry) continue;
      batch.push(entry);
      entryCount++;
      fileCount++;
      if (batch.length >= SCAN_BATCH_SIZE) await flushScanBatchAndYield(this.index, batch, mode);
    }
    return { entryCount, fileCount };
  }
}

class WorkerUserSpaceRuntime implements UserSpaceRuntime {
  private worker: Worker;
  private nextRequestId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private ready: Promise<void>;
  private dropped = false;

  constructor(mountId: string, root: BrowserFileSystemDirectoryHandle) {
    this.worker = new Worker(new URL("./user-space-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) =>
      this.handleMessage(event.data),
    );
    this.worker.addEventListener("error", (event) => {
      for (const request of this.pending.values())
        request.reject(event.error || new Error(event.message));
      this.pending.clear();
    });
    this.ready = this.request("init", { mountId, root }).then(() => undefined);
    this.ready.catch(() => undefined);
  }

  async rebuild(): Promise<UserSpaceMetadataSnapshot> {
    await this.ready;
    return this.request("rebuild", {}) as Promise<UserSpaceMetadataSnapshot>;
  }

  async addEntries(entries: IndexedWorkspaceEntry[]): Promise<void> {
    await this.ready;
    await this.request("addEntries", { entries });
  }

  async removePath(path: string): Promise<void> {
    await this.ready;
    await this.request("removePath", { path });
  }

  async indexSubtree(
    path: string,
    maxDepth?: number,
  ): Promise<{ entryCount: number; fileCount: number; lastIndexedAt: number }> {
    await this.ready;
    return this.request("indexSubtree", { path, maxDepth }) as Promise<{
      entryCount: number;
      fileCount: number;
      lastIndexedAt: number;
    }>;
  }

  async clearIndex(): Promise<void> {
    await this.ready;
    await this.request("clear", {});
  }

  async listDir(
    path: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): Promise<IndexedWorkspaceList> {
    await this.ready;
    return this.request("listDir", {
      path,
      limit,
      cursor,
      includeHidden,
    }) as Promise<IndexedWorkspaceList>;
  }

  async searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): Promise<IndexedWorkspaceList> {
    await this.ready;
    return this.request("searchPaths", {
      query,
      limit,
      cursor,
      includeHidden,
    }) as Promise<IndexedWorkspaceList>;
  }

  async walkTree(
    path: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): Promise<IndexedWorkspaceList> {
    await this.ready;
    return this.request("walkTree", { path, options }) as Promise<IndexedWorkspaceList>;
  }

  async searchContent(input: {
    query: string;
    mode: "text" | "regex";
    pathPrefix?: string;
    includeHidden?: boolean;
    ignoreCase?: boolean;
    invert?: boolean;
    limit: number;
    contextLines: number;
  }): Promise<IndexedWorkspaceContentSearchResult> {
    await this.ready;
    return this.request("searchContent", { input }) as Promise<IndexedWorkspaceContentSearchResult>;
  }

  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    const error = new UserSpaceRuntimeDisposedError();
    for (const request of this.pending.values()) request.reject(error);
    this.worker.terminate();
    this.pending.clear();
  }

  private request(type: WorkerRequest["type"], payload: Record<string, unknown>): Promise<unknown> {
    if (this.dropped) return Promise.reject(new UserSpaceRuntimeDisposedError());
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage({ requestId, type, ...payload });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private handleMessage(response: WorkerResponse): void {
    if (this.dropped) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || "User space worker failed."));
  }
}

type WorkerRequest =
  | { requestId: number; type: "init"; mountId: string; root: BrowserFileSystemDirectoryHandle }
  | { requestId: number; type: "rebuild" }
  | { requestId: number; type: "addEntries"; entries: IndexedWorkspaceEntry[] }
  | { requestId: number; type: "removePath"; path: string }
  | { requestId: number; type: "indexSubtree"; path: string; maxDepth?: number }
  | { requestId: number; type: "clear" }
  | {
      requestId: number;
      type: "listDir";
      path: string;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    }
  | {
      requestId: number;
      type: "searchPaths";
      query: string;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    }
  | {
      requestId: number;
      type: "walkTree";
      path: string;
      options: {
        includeRoot?: boolean;
        maxDepth?: number;
        limit: number;
        cursor?: string;
        includeHidden?: boolean;
      };
    }
  | {
      requestId: number;
      type: "searchContent";
      input: {
        query: string;
        mode: "text" | "regex";
        pathPrefix?: string;
        includeHidden?: boolean;
        ignoreCase?: boolean;
        invert?: boolean;
        limit: number;
        contextLines: number;
      };
    }
  | { requestId: number; type: "drop" };

type WorkerResponse =
  | { requestId: number; ok: true; result: unknown }
  | { requestId: number; ok: false; error: string };

export type UserSpaceWorkerRequest = WorkerRequest;
export type UserSpaceWorkerResponse = WorkerResponse;
export type UserSpaceDirectoryHandle = BrowserFileSystemDirectoryHandle;

export async function metadataEntryFromFile(
  path: string,
  file: File,
  options: { indexContent?: boolean } = {},
): Promise<IndexedWorkspaceEntry | null> {
  const knownPreviewKind = await previewKindForWorkspacePath(path);
  const previewKind = await previewKindForFile(path, file, knownPreviewKind);
  const name = basename(path);
  const ext = getExtension(path);
  const content =
    options.indexContent !== false && previewKind === "text"
      ? await file.text().catch(() => undefined)
      : undefined;
  return {
    name,
    path,
    parentPath: dirname(path),
    kind: "file",
    size: file.size,
    lastModified: file.lastModified,
    ext,
    depth: splitUserPath(path).length,
    previewKind,
    hidden: isHiddenWorkspacePath(path),
    contentIndexed: typeof content === "string",
    content,
  };
}

async function entryFromFileHandle(
  path: string,
  handle: BrowserFileSystemFileHandle,
  depth: number,
): Promise<IndexedWorkspaceEntry | null> {
  const file = await handle.getFile();
  const entry = await metadataEntryFromFile(path, file);
  return entry ? { ...entry, name: handle.name, depth } : null;
}

function entryFromDirectoryHandle(
  path: string,
  handle: BrowserFileSystemDirectoryHandle,
  depth: number,
): IndexedWorkspaceEntry {
  return {
    name: handle.name,
    path,
    parentPath: dirname(path),
    kind: "directory",
    ext: "",
    depth,
    previewKind: "binary",
    hidden: isHiddenWorkspacePath(path),
    contentIndexed: false,
  };
}

async function flushBatchAndYield(
  index: UserSpaceMetadataIndexAdapter,
  batch: IndexedWorkspaceEntry[],
): Promise<void> {
  await flushBatch(index, batch);
  await yieldToBrowser();
}

async function flushBatch(
  index: UserSpaceMetadataIndexAdapter,
  batch: IndexedWorkspaceEntry[],
): Promise<void> {
  if (batch.length === 0) return;
  await index.addBatch(batch.splice(0, batch.length));
}

async function flushUpsertBatchAndYield(
  index: UserSpaceMetadataIndexAdapter,
  batch: IndexedWorkspaceEntry[],
): Promise<void> {
  await flushUpsertBatch(index, batch);
  await yieldToBrowser();
}

async function flushUpsertBatch(
  index: UserSpaceMetadataIndexAdapter,
  batch: IndexedWorkspaceEntry[],
): Promise<void> {
  if (batch.length === 0) return;
  await index.upsertBatch(batch.splice(0, batch.length));
}

function flushScanBatchAndYield(
  index: UserSpaceMetadataIndexAdapter,
  batch: IndexedWorkspaceEntry[],
  mode: "replace" | "upsert",
): Promise<void> {
  return mode === "replace"
    ? flushBatchAndYield(index, batch)
    : flushUpsertBatchAndYield(index, batch);
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

async function previewKindForFile(
  path: string,
  file: File,
  knownPreviewKind?: IndexedWorkspaceEntry["previewKind"] | null,
): Promise<IndexedWorkspaceEntry["previewKind"]> {
  const known = knownPreviewKind ?? (await previewKindForWorkspacePath(path));
  if (known) return known;
  try {
    const sample =
      file.size === 0
        ? new Uint8Array()
        : new Uint8Array(await file.slice(0, Math.min(file.size, TEXT_PROBE_BYTES)).arrayBuffer());
    return await classifyWorkspacePreviewKind(path, sample, file.size);
  } catch {
    return "binary";
  }
}

export function canUseWorkspaceWorker(root: BrowserFileSystemDirectoryHandle): boolean {
  if (typeof Worker === "undefined" || typeof window === "undefined") return false;
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  if (/jsdom/i.test(userAgent)) return false;
  const nativeDirectoryHandle = (
    globalThis as unknown as {
      FileSystemDirectoryHandle?: { new (): unknown };
    }
  ).FileSystemDirectoryHandle;
  return typeof nativeDirectoryHandle === "function" && root instanceof nativeDirectoryHandle;
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

function dirname(path: string): string {
  const parts = splitUserPath(path);
  parts.pop();
  return parts.join("/");
}

function basename(path: string): string {
  return splitUserPath(path).pop() || path;
}

function getExtension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1);
}

async function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
