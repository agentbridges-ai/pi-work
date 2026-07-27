import type {
  IndexedWorkspaceContentSearchResult,
  IndexedWorkspaceEntry,
  IndexedWorkspaceList,
} from "./user-space-index.js";
import type { UserSpaceMetadataIndexAdapter } from "./user-space-runtime.js";
import {
  USER_SPACE_AUDIO_EXTENSIONS,
  USER_SPACE_IMAGE_EXTENSIONS,
  USER_SPACE_OFFICE_EXTENSIONS,
  USER_SPACE_TEXT_EXTENSIONS,
  USER_SPACE_VIDEO_EXTENSIONS,
} from "./user-space-file-types.js";

type MountIndex = {
  entries: Map<string, IndexedWorkspaceEntry>;
  children: Map<string, string[]>;
  dirtyParents: Set<string>;
};

type MountState = {
  active: MountIndex;
  building: MountIndex | null;
};

type ContentMatcher = (line: string) => boolean;

const mountStates = new Map<string, MountState>();
const knownPreviewKindCache = new Map<string, IndexedWorkspaceEntry["previewKind"] | null>();

const BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "aar",
  "bin",
  "bz2",
  "class",
  "dat",
  "db",
  "dll",
  "dmg",
  "dylib",
  "eot",
  "exe",
  "gz",
  "heic",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "o",
  "otf",
  "pkl",
  "png",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "woff",
  "woff2",
  "xz",
  "zip",
  "zst",
]);

export class TsUserSpaceMetadataIndex implements UserSpaceMetadataIndexAdapter {
  constructor(private readonly mountId: string) {}

  static async create(mountId: string): Promise<TsUserSpaceMetadataIndex> {
    return new TsUserSpaceMetadataIndex(mountId);
  }

  begin(): void {
    this.state().building = createMountIndex();
  }

  addBatch(entries: IndexedWorkspaceEntry[]): void {
    const state = this.state();
    const target = state.building ?? createMountIndex();
    state.building = target;
    // A rebuild sorts once at commit. Sorting every 128-entry worker batch
    // repeatedly re-sorts growing sibling arrays and becomes near-quadratic at
    // large directory sizes.
    upsertBatch(target, entries, false);
  }

  upsertBatch(entries: IndexedWorkspaceEntry[]): void {
    upsertBatch(this.state().active, entries);
  }

  commit(): { fileCount: number; entryCount: number } {
    const state = this.state();
    if (!state.building) throw new Error("No building index for mount");
    sortAllChildren(state.building);
    state.active = state.building;
    state.building = null;
    return {
      fileCount: fileCount(state.active),
      entryCount: state.active.entries.size,
    };
  }

  abort(): void {
    this.state().building = null;
  }

  clear(): void {
    mountStates.delete(this.mountId);
  }

  removePath(path: string): void {
    const index = this.state().active;
    const normalized = normalizePath(path);
    if (!normalized) return;
    const prefix = `${normalized}/`;
    const paths = Array.from(index.entries.keys()).filter(
      (candidate) => candidate === normalized || candidate.startsWith(prefix),
    );
    for (const candidate of paths) {
      const existing = index.entries.get(candidate);
      index.entries.delete(candidate);
      index.children.delete(candidate);
      if (existing) removeChildPath(index, existing.parentPath, candidate);
    }
  }

  listChildren(
    parentPath: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): IndexedWorkspaceList {
    const index = this.state().active;
    const parent = normalizePath(parentPath);
    const childPaths = sortedChildren(index, parent).filter((path) => {
      const entry = index.entries.get(path);
      return entry && (includeHidden || !entry.hidden);
    });
    const start = cursorToNumber(cursor, childPaths.length);
    const take = positiveLimit(limit);
    const pagePaths = childPaths.slice(start, start + take);
    const end = start + pagePaths.length;
    return {
      entries: pagePaths.map((path) => publicEntry(index.entries.get(path))).filter(isIndexedEntry),
      total: childPaths.length,
      nextCursor: end < childPaths.length ? String(end) : undefined,
    };
  }

  searchPaths(
    query: string,
    limit: number,
    cursor?: string,
    includeHidden = true,
  ): IndexedWorkspaceList {
    const needle = query.toLowerCase();
    const matches = sortedEntryPaths(this.state().active).filter((path) => {
      const entry = this.state().active.entries.get(path);
      return entry && (includeHidden || !entry.hidden) && entry.name.toLowerCase().includes(needle);
    });
    const start = cursorToNumber(cursor, matches.length);
    const take = positiveLimit(limit);
    const pagePaths = matches.slice(start, start + take);
    const end = start + pagePaths.length;
    return {
      entries: pagePaths
        .map((path) => publicEntry(this.state().active.entries.get(path)))
        .filter(isIndexedEntry),
      nextCursor: end < matches.length ? String(end) : undefined,
    };
  }

  walkTree(
    rootPath: string,
    options: {
      includeRoot?: boolean;
      maxDepth?: number;
      limit: number;
      cursor?: string;
      includeHidden?: boolean;
    },
  ): IndexedWorkspaceList {
    const index = this.state().active;
    const root = normalizePath(rootPath);
    const maxDepth = typeof options.maxDepth === "number" ? Math.floor(options.maxDepth) : -1;
    const includeHidden = options.includeHidden !== false;
    const paths: string[] = [];
    if (!root) {
      collectChildTreePaths(index, "", 0, maxDepth, includeHidden, paths);
    } else {
      const rootEntry = index.entries.get(root);
      if (rootEntry && (includeHidden || !rootEntry.hidden)) {
        if (options.includeRoot === true) paths.push(root);
        if (rootEntry.kind === "directory" && maxDepth !== 0) {
          collectChildTreePaths(index, root, 0, maxDepth, includeHidden, paths);
        }
      }
    }
    const start = cursorToNumber(options.cursor, paths.length);
    const take = positiveLimit(options.limit);
    const pagePaths = paths.slice(start, start + take);
    const end = start + pagePaths.length;
    return {
      entries: pagePaths.map((path) => publicEntry(index.entries.get(path))).filter(isIndexedEntry),
      total: paths.length,
      nextCursor: end < paths.length ? String(end) : undefined,
    };
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
  }): IndexedWorkspaceContentSearchResult {
    const matcher = createContentMatcher(input.query, input.mode, input.ignoreCase === true);
    const index = this.state().active;
    const includeHidden = input.includeHidden !== false;
    const pathPrefix = normalizePath(input.pathPrefix || "");
    const take = positiveLimit(input.limit);
    const context = Math.min(Math.max(0, Math.floor(input.contextLines)), 10);
    const matches: IndexedWorkspaceContentSearchResult["matches"] = [];
    let truncated = false;

    for (const path of sortedEntryPaths(index)) {
      const entry = index.entries.get(path);
      if (
        !entry ||
        entry.kind !== "file" ||
        !entry.contentIndexed ||
        typeof entry.content !== "string"
      )
        continue;
      if (!includeHidden && entry.hidden) continue;
      if (pathPrefix && entry.path !== pathPrefix && !entry.path.startsWith(`${pathPrefix}/`))
        continue;

      const lines = splitLines(entry.content);
      for (let indexInFile = 0; indexInFile < lines.length; indexInFile++) {
        const line = lines[indexInFile];
        const hit = matcher(line);
        if (input.invert === true ? hit : !hit) continue;
        if (matches.length >= take) {
          truncated = true;
          break;
        }
        matches.push({
          path: entry.path,
          lineNumber: indexInFile + 1,
          line,
          contextBefore: lines.slice(Math.max(0, indexInFile - context), indexInFile),
          contextAfter: lines.slice(
            indexInFile + 1,
            Math.min(lines.length, indexInFile + 1 + context),
          ),
        });
      }
      if (truncated) break;
    }

    return { matches, truncated };
  }

  stats(): { fileCount: number; entryCount: number; building: boolean } {
    const state = this.state();
    return {
      fileCount: fileCount(state.active),
      entryCount: state.active.entries.size,
      building: state.building !== null,
    };
  }

  private state(): MountState {
    let state = mountStates.get(this.mountId);
    if (!state) {
      state = { active: createMountIndex(), building: null };
      mountStates.set(this.mountId, state);
    }
    return state;
  }
}

export async function previewKindForWorkspacePath(
  path: string,
): Promise<IndexedWorkspaceEntry["previewKind"] | null> {
  const cacheKey = previewKindCacheKey(path);
  if (knownPreviewKindCache.has(cacheKey)) return knownPreviewKindCache.get(cacheKey) ?? null;
  const kind = knownPreviewKindForPath(path);
  knownPreviewKindCache.set(cacheKey, kind);
  return kind;
}

export async function classifyWorkspacePreviewKind(
  path: string,
  sample: Uint8Array,
  fileSize: number,
): Promise<IndexedWorkspaceEntry["previewKind"]> {
  return (
    knownPreviewKindForPath(path) ??
    (Math.max(0, Math.floor(fileSize)) === 0 || !looksBinary(sample) ? "text" : "binary")
  );
}

function createMountIndex(): MountIndex {
  return { entries: new Map(), children: new Map(), dirtyParents: new Set() };
}

function upsertBatch(index: MountIndex, entries: IndexedWorkspaceEntry[], sortDirty = true): void {
  for (const entry of entries) upsertEntry(index, entry);
  if (!sortDirty) return;
  for (const parentPath of index.dirtyParents) sortChildren(index, parentPath);
  index.dirtyParents.clear();
}

function upsertEntry(index: MountIndex, rawEntry: IndexedWorkspaceEntry): void {
  const path = normalizePath(rawEntry.path);
  const parentPath = normalizePath(rawEntry.parentPath || parentOf(path));
  const existing = index.entries.get(path);
  const entry: IndexedWorkspaceEntry = {
    ...rawEntry,
    name: rawEntry.name || basename(path),
    path,
    parentPath,
    ext: rawEntry.ext ?? extension(path),
    depth: Number.isFinite(rawEntry.depth) ? rawEntry.depth : splitUserPath(path).length,
    previewKind: rawEntry.previewKind ?? "binary",
    hidden: rawEntry.hidden ?? isHiddenWorkspacePath(path),
    contentIndexed: rawEntry.contentIndexed ?? typeof rawEntry.content === "string",
    content: rawEntry.content,
  };

  const parentChanged = !!existing && existing.parentPath !== parentPath;
  if (existing) {
    if (parentChanged) removeChildPath(index, existing.parentPath, path);
    if (entry.content === undefined && existing.content !== undefined) {
      entry.content = existing.content;
      entry.contentIndexed = existing.contentIndexed;
    }
  }

  const children = index.children.get(parentPath) ?? [];
  // The entries map is the membership index. Avoid an O(siblings) includes()
  // scan for every new file in very large directories.
  if (!existing || parentChanged) children.push(path);
  index.children.set(parentPath, children);
  index.dirtyParents.add(parentPath);

  if (entry.kind === "directory" && !index.children.has(path)) index.children.set(path, []);
  index.entries.set(path, entry);
}

function removeChildPath(index: MountIndex, parentPath: string, path: string): void {
  const parent = normalizePath(parentPath);
  const children = index.children.get(parent);
  if (!children) return;
  const next = children.filter((child) => child !== path);
  if (next.length === children.length) return;
  index.children.set(parent, next);
  index.dirtyParents.add(parent);
}

function collectChildTreePaths(
  index: MountIndex,
  parentPath: string,
  depth: number,
  maxDepth: number,
  includeHidden: boolean,
  output: string[],
): void {
  if (maxDepth >= 0 && depth >= maxDepth) return;
  for (const childPath of sortedChildren(index, parentPath)) {
    const entry = index.entries.get(childPath);
    if (!entry) continue;
    if (!includeHidden && entry.hidden) continue;
    output.push(childPath);
    if (entry.kind === "directory") {
      collectChildTreePaths(index, childPath, depth + 1, maxDepth, includeHidden, output);
    }
  }
}

function sortedChildren(index: MountIndex, parentPath: string): string[] {
  const parent = normalizePath(parentPath);
  if (index.dirtyParents.has(parent)) {
    sortChildren(index, parent);
    index.dirtyParents.delete(parent);
  }
  return index.children.get(parent) ?? [];
}

function sortAllChildren(index: MountIndex): void {
  for (const parentPath of index.children.keys()) sortChildren(index, parentPath);
  index.dirtyParents.clear();
}

function sortChildren(index: MountIndex, parentPath: string): void {
  const children = index.children.get(parentPath);
  if (!children) return;
  children.sort((leftPath, rightPath) => {
    const left = index.entries.get(leftPath);
    const right = index.entries.get(rightPath);
    if (!left || !right) return leftPath.localeCompare(rightPath);
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  });
}

function sortedEntryPaths(index: MountIndex): string[] {
  return Array.from(index.entries.keys()).sort((left, right) => left.localeCompare(right));
}

function publicEntry(entry: IndexedWorkspaceEntry | undefined): IndexedWorkspaceEntry | undefined {
  if (!entry) return undefined;
  const { content: _content, ...publicFields } = entry;
  return publicFields;
}

function isIndexedEntry(entry: IndexedWorkspaceEntry | undefined): entry is IndexedWorkspaceEntry {
  return entry !== undefined;
}

function fileCount(index: MountIndex): number {
  let count = 0;
  for (const entry of index.entries.values()) {
    if (entry.kind === "file") count++;
  }
  return count;
}

function createContentMatcher(
  query: string,
  mode: "text" | "regex",
  ignoreCase = false,
): ContentMatcher {
  if (mode !== "regex") {
    const needle = ignoreCase ? query.toLowerCase() : query;
    return (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  try {
    const regex = new RegExp(query, ignoreCase ? "i" : "");
    return (line) => regex.test(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid search regex: ${detail}`);
  }
}

function knownPreviewKindForPath(path: string): IndexedWorkspaceEntry["previewKind"] | null {
  const ext = extension(path.toLowerCase());
  if (!ext) return null;
  if (USER_SPACE_IMAGE_EXTENSIONS.has(ext)) return "image";
  if (USER_SPACE_AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (USER_SPACE_VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (USER_SPACE_OFFICE_EXTENSIONS.has(ext)) return "office";
  if (USER_SPACE_TEXT_EXTENSIONS.has(ext)) return "text";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return null;
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

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n/);
  if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function cursorToNumber(cursor: string | undefined, max: number): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, Math.floor(parsed)), max);
}

function positiveLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
}

function parentOf(path: string): string {
  const parts = splitUserPath(path);
  parts.pop();
  return parts.join("/");
}

function splitUserPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized ? normalized.split("/") : [];
}

function basename(path: string): string {
  return splitUserPath(path).pop() || path;
}

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1);
}

function isHiddenWorkspacePath(path: string): boolean {
  return splitUserPath(path).some((part) => part.startsWith("."));
}

function previewKindCacheKey(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return `name:${name}`;
  return `ext:${name.slice(dot + 1)}`;
}
