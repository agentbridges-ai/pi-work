import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentMode, PiModelRef, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import { PI_THINKING_LEVELS } from "./pi-rpc-contract.js";
import { PiJsonlFrameError, StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGE_SIZE = 200;
const READ_CHUNK_BYTES = 64 * 1024;
const PI_SESSION_RELATIVE_PATH_PATTERN = /^pi-sessions\/([A-Za-z0-9][A-Za-z0-9._-]{0,254}\.jsonl)$/;

export type PiSessionEntryType =
  | "message"
  | "thinking_level_change"
  | "model_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export interface PiSessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface PiSessionEntry {
  type: PiSessionEntryType;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface PiSessionDocument {
  header: PiSessionHeader;
  entries: PiSessionEntry[];
  bytes: number;
}

export interface PiSessionHistoryLimits {
  maxFileBytes?: number;
  maxLineBytes?: number;
  maxEntries?: number;
  defaultPageSize?: number;
  maxPageSize?: number;
}

export interface ReadPiSessionHistoryOptions {
  /** Absolute directory for the current Piwork product session. */
  sessionDir: string;
  /** Persisted exact path relative to sessionDir: pi-sessions/<file>.jsonl. */
  piSessionRelativePath: string;
  expectedPiSessionId?: string;
  expectedCwd?: string;
  limits?: PiSessionHistoryLimits;
}

export interface ReadPiSessionHistoryPageOptions extends ReadPiSessionHistoryOptions {
  /** Stable Pi entry id; the returned page begins strictly after it. */
  cursor?: string;
  limit?: number;
}

export interface PiSessionHistoryPage {
  header: PiSessionHeader;
  entries: PiSessionEntry[];
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  totalEntries: number;
  bytes: number;
  piSessionRelativePath: string;
}

export interface RestoredPiSessionState {
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
}

export type PiSessionHistoryErrorCode =
  | "file_changed"
  | "file_too_large"
  | "invalid_cursor"
  | "invalid_header"
  | "invalid_json"
  | "invalid_path"
  | "invalid_schema"
  | "line_too_large"
  | "not_found"
  | "not_regular_file"
  | "symlink_forbidden"
  | "too_many_entries"
  | "unterminated_line";

export class PiSessionHistoryError extends Error {
  readonly code: PiSessionHistoryErrorCode;

  constructor(code: PiSessionHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSessionHistoryError";
    this.code = code;
  }
}

interface ResolvedLimits {
  maxFileBytes: number;
  maxLineBytes: number;
  maxEntries: number;
  defaultPageSize: number;
  maxPageSize: number;
}

interface ResolvedSessionFile {
  filePath: string;
  piSessionsRoot: string;
  relativePath: string;
  identity: Stats;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function resolveLimits(limits: PiSessionHistoryLimits = {}): ResolvedLimits {
  const resolved = {
    maxFileBytes: positiveInteger(limits.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxLineBytes: positiveInteger(limits.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes"),
    maxEntries: positiveInteger(limits.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
    defaultPageSize: positiveInteger(limits.defaultPageSize, DEFAULT_PAGE_SIZE, "defaultPageSize"),
    maxPageSize: positiveInteger(limits.maxPageSize, DEFAULT_MAX_PAGE_SIZE, "maxPageSize"),
  };
  if (resolved.defaultPageSize > resolved.maxPageSize) {
    throw new TypeError("defaultPageSize cannot exceed maxPageSize.");
  }
  return resolved;
}

function exactPiSessionFileName(value: string): string {
  const match =
    typeof value === "string" &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !isAbsolute(value)
      ? PI_SESSION_RELATIVE_PATH_PATTERN.exec(value)
      : null;
  if (!match) {
    throw new PiSessionHistoryError(
      "invalid_path",
      "Pi session history path must be an exact JSONL child of pi-sessions.",
    );
  }
  return match[1]!;
}

async function lstatOrHistoryError(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PiSessionHistoryError(
      code === "ENOENT" ? "not_found" : "invalid_path",
      code === "ENOENT"
        ? "Pi session history file was not found."
        : "Pi session history path could not be inspected.",
      { cause: error },
    );
  }
}

async function resolveSessionFile(
  options: ReadPiSessionHistoryOptions,
): Promise<ResolvedSessionFile> {
  if (!isAbsolute(options.sessionDir) || options.sessionDir.includes("\0")) {
    throw new PiSessionHistoryError("invalid_path", "Current session directory must be absolute.");
  }
  const fileName = exactPiSessionFileName(options.piSessionRelativePath);
  const sessionStat = await lstatOrHistoryError(options.sessionDir);
  if (sessionStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Current session directory cannot be a symbolic link.",
    );
  }
  if (!sessionStat.isDirectory()) {
    throw new PiSessionHistoryError("invalid_path", "Current session path is not a directory.");
  }
  const canonicalSessionDir = await realpath(options.sessionDir);
  const piSessionsRoot = join(canonicalSessionDir, "pi-sessions");
  const rootStat = await lstatOrHistoryError(piSessionsRoot);
  if (rootStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Pi sessions directory cannot be a symbolic link.",
    );
  }
  if (!rootStat.isDirectory()) {
    throw new PiSessionHistoryError("invalid_path", "Pi sessions path is not a directory.");
  }
  const cursor = join(piSessionsRoot, fileName);
  const fileStat = await lstatOrHistoryError(cursor);
  if (fileStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Pi session history cannot traverse symbolic links.",
    );
  }
  if (!fileStat.isFile() || fileStat.nlink !== 1) {
    throw new PiSessionHistoryError(
      "not_regular_file",
      "Pi session history must be an ordinary single-link file.",
    );
  }
  const canonicalRoot = await realpath(piSessionsRoot);
  const canonicalFile = await realpath(cursor);
  const rel = relative(canonicalRoot, canonicalFile);
  if (rel !== fileName || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new PiSessionHistoryError(
      "invalid_path",
      "Pi session history escapes the current session.",
    );
  }
  return {
    filePath: canonicalFile,
    piSessionsRoot: canonicalRoot,
    relativePath: `pi-sessions/${fileName}`,
    identity: await lstatOrHistoryError(canonicalFile),
  };
}

function lstatOrHistoryErrorSync(path: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PiSessionHistoryError(
      code === "ENOENT" ? "not_found" : "invalid_path",
      code === "ENOENT"
        ? "Pi session history file was not found."
        : "Pi session history path could not be inspected.",
      { cause: error },
    );
  }
}

function resolveSessionFileSync(options: ReadPiSessionHistoryOptions): ResolvedSessionFile {
  if (!isAbsolute(options.sessionDir) || options.sessionDir.includes("\0")) {
    throw new PiSessionHistoryError("invalid_path", "Current session directory must be absolute.");
  }
  const fileName = exactPiSessionFileName(options.piSessionRelativePath);
  const sessionStat = lstatOrHistoryErrorSync(options.sessionDir);
  if (sessionStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Current session directory cannot be a symbolic link.",
    );
  }
  if (!sessionStat.isDirectory()) {
    throw new PiSessionHistoryError("invalid_path", "Current session path is not a directory.");
  }
  const canonicalSessionDir = realpathSync(options.sessionDir);
  const piSessionsRoot = join(canonicalSessionDir, "pi-sessions");
  const rootStat = lstatOrHistoryErrorSync(piSessionsRoot);
  if (rootStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Pi sessions directory cannot be a symbolic link.",
    );
  }
  if (!rootStat.isDirectory()) {
    throw new PiSessionHistoryError("invalid_path", "Pi sessions path is not a directory.");
  }
  const filePath = join(piSessionsRoot, fileName);
  const fileStat = lstatOrHistoryErrorSync(filePath);
  if (fileStat.isSymbolicLink()) {
    throw new PiSessionHistoryError(
      "symlink_forbidden",
      "Pi session history cannot traverse symbolic links.",
    );
  }
  if (!fileStat.isFile() || fileStat.nlink !== 1) {
    throw new PiSessionHistoryError(
      "not_regular_file",
      "Pi session history must be an ordinary single-link file.",
    );
  }
  const canonicalRoot = realpathSync(piSessionsRoot);
  const canonicalFile = realpathSync(filePath);
  const rel = relative(canonicalRoot, canonicalFile);
  if (rel !== fileName || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new PiSessionHistoryError(
      "invalid_path",
      "Pi session history escapes the current session.",
    );
  }
  return {
    filePath: canonicalFile,
    piSessionsRoot: canonicalRoot,
    relativePath: `pi-sessions/${fileName}`,
    identity: lstatOrHistoryErrorSync(canonicalFile),
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function assertOpenedSessionFile(resolved: ResolvedSessionFile, opened: Stats): void {
  if (!opened.isFile() || opened.nlink !== 1) {
    throw new PiSessionHistoryError(
      "not_regular_file",
      "Pi session history must be an ordinary single-link file.",
    );
  }
  if (!sameIdentity(resolved.identity, opened)) {
    throw new PiSessionHistoryError(
      "file_changed",
      "Pi session history changed while it was opened.",
    );
  }
}

function pushJsonlChunk(decoder: StrictLfJsonlDecoder, lines: string[], chunk: Buffer): void {
  try {
    lines.push(...decoder.push(chunk));
  } catch (error) {
    if (error instanceof PiJsonlFrameError) {
      throw new PiSessionHistoryError(
        error.code === "frame_too_large" ? "line_too_large" : "invalid_schema",
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

function finishJsonl(decoder: StrictLfJsonlDecoder): void {
  try {
    decoder.end();
  } catch (error) {
    throw new PiSessionHistoryError("unterminated_line", "Pi session history must end with LF.", {
      cause: error,
    });
  }
}

function readExactFileSync(
  resolved: ResolvedSessionFile,
  limits: ResolvedLimits,
): { lines: string[]; bytes: number } {
  if (resolved.identity.size > limits.maxFileBytes) {
    throw new PiSessionHistoryError(
      "file_too_large",
      "Pi session history exceeds the configured file limit.",
    );
  }
  let fd: number | undefined;
  try {
    const flags = constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0);
    fd = openSync(resolved.filePath, flags);
    const opened = fstatSync(fd);
    assertOpenedSessionFile(resolved, opened);
    const decoder = new StrictLfJsonlDecoder(limits.maxLineBytes);
    const lines: string[] = [];
    let position = 0;
    while (position < opened.size) {
      const length = Math.min(READ_CHUNK_BYTES, opened.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (bytesRead <= 0) {
        throw new PiSessionHistoryError(
          "file_changed",
          "Pi session history was truncated while reading.",
        );
      }
      position += bytesRead;
      pushJsonlChunk(decoder, lines, chunk.subarray(0, bytesRead));
    }
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, opened.size) !== 0) {
      throw new PiSessionHistoryError("file_changed", "Pi session history grew while reading.");
    }
    finishJsonl(decoder);
    const after = fstatSync(fd);
    if (!sameIdentity(opened, after)) {
      throw new PiSessionHistoryError("file_changed", "Pi session history changed while reading.");
    }
    return { lines, bytes: opened.size };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function readExactFile(
  resolved: ResolvedSessionFile,
  limits: ResolvedLimits,
): Promise<{ lines: string[]; bytes: number }> {
  if (resolved.identity.size > limits.maxFileBytes) {
    throw new PiSessionHistoryError(
      "file_too_large",
      "Pi session history exceeds the configured file limit.",
    );
  }
  let handle: FileHandle | undefined;
  try {
    const flags = constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0);
    handle = await open(resolved.filePath, flags);
    const opened = await handle.stat();
    assertOpenedSessionFile(resolved, opened);
    const decoder = new StrictLfJsonlDecoder(limits.maxLineBytes);
    const lines: string[] = [];
    let position = 0;
    while (position < opened.size) {
      const length = Math.min(READ_CHUNK_BYTES, opened.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) {
        throw new PiSessionHistoryError(
          "file_changed",
          "Pi session history was truncated while reading.",
        );
      }
      position += bytesRead;
      pushJsonlChunk(decoder, lines, chunk.subarray(0, bytesRead));
    }
    const probe = Buffer.allocUnsafe(1);
    if ((await handle.read(probe, 0, 1, opened.size)).bytesRead !== 0) {
      throw new PiSessionHistoryError("file_changed", "Pi session history grew while reading.");
    }
    finishJsonl(decoder);
    const after = await handle.stat();
    if (!sameIdentity(opened, after)) {
      throw new PiSessionHistoryError("file_changed", "Pi session history changed while reading.");
    }
    return { lines, bytes: opened.size };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function timestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function parseJson(line: string, lineNumber: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) throw new Error("record expected");
    return parsed;
  } catch (error) {
    throw new PiSessionHistoryError(
      "invalid_json",
      `Pi session history line ${lineNumber} is not a JSON object.`,
      { cause: error },
    );
  }
}

function parseHeader(
  value: Record<string, unknown>,
  options: ReadPiSessionHistoryOptions,
  piSessionsRoot: string,
): PiSessionHeader {
  const cwd = value.cwd;
  const parentSession = value.parentSession;
  if (
    value.type !== "session" ||
    value.version !== 3 ||
    !nonEmptyString(value.id) ||
    !timestamp(value.timestamp) ||
    !nonEmptyString(cwd) ||
    !isAbsolute(cwd) ||
    (parentSession !== undefined && (!nonEmptyString(parentSession) || !isAbsolute(parentSession)))
  ) {
    throw new PiSessionHistoryError(
      "invalid_header",
      "Pi session history header is not a pinned v3 header.",
    );
  }
  if (options.expectedPiSessionId && value.id !== options.expectedPiSessionId) {
    throw new PiSessionHistoryError(
      "invalid_header",
      "Pi session history id does not match the current session.",
    );
  }
  if (options.expectedCwd && resolve(cwd) !== resolve(options.expectedCwd)) {
    throw new PiSessionHistoryError(
      "invalid_header",
      "Pi session history cwd does not match the current session.",
    );
  }
  if (typeof parentSession === "string") {
    const rel = relative(piSessionsRoot, resolve(parentSession));
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new PiSessionHistoryError(
        "invalid_header",
        "Pi parent session escapes the current session store.",
      );
    }
  }
  return value as unknown as PiSessionHeader;
}

function hasEntryBase(value: Record<string, unknown>): boolean {
  return (
    nonEmptyString(value.id) &&
    (value.parentId === null || nonEmptyString(value.parentId)) &&
    timestamp(value.timestamp)
  );
}

function validateEntryPayload(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "message":
      return isRecord(value.message);
    case "thinking_level_change":
      return (
        typeof value.thinkingLevel === "string" &&
        (PI_THINKING_LEVELS as readonly string[]).includes(value.thinkingLevel)
      );
    case "model_change":
      return nonEmptyString(value.provider) && nonEmptyString(value.modelId);
    case "compaction":
      return (
        typeof value.summary === "string" &&
        nonEmptyString(value.firstKeptEntryId) &&
        Number.isFinite(value.tokensBefore) &&
        (value.tokensBefore as number) >= 0
      );
    case "branch_summary":
      return nonEmptyString(value.fromId) && typeof value.summary === "string";
    case "custom":
      return nonEmptyString(value.customType);
    case "custom_message":
      return (
        nonEmptyString(value.customType) &&
        (typeof value.content === "string" || Array.isArray(value.content)) &&
        typeof value.display === "boolean"
      );
    case "label":
      return (
        nonEmptyString(value.targetId) &&
        (value.label === undefined || typeof value.label === "string")
      );
    case "session_info":
      return value.name === undefined || typeof value.name === "string";
    default:
      return false;
  }
}

function parseDocument(
  lines: string[],
  bytes: number,
  options: ReadPiSessionHistoryOptions,
  resolved: ResolvedSessionFile,
  limits: ResolvedLimits,
): PiSessionDocument {
  if (lines.length === 0) {
    throw new PiSessionHistoryError("invalid_header", "Pi session history is empty.");
  }
  const header = parseHeader(parseJson(lines[0]!, 1), options, resolved.piSessionsRoot);
  if (lines.length - 1 > limits.maxEntries) {
    throw new PiSessionHistoryError(
      "too_many_entries",
      "Pi session history exceeds the configured entry limit.",
    );
  }
  const entries: PiSessionEntry[] = [];
  const ids = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    const value = parseJson(lines[index]!, index + 1);
    if (value.type === "session" || !hasEntryBase(value) || !validateEntryPayload(value)) {
      throw new PiSessionHistoryError(
        "invalid_schema",
        `Pi session history entry ${index} failed schema validation.`,
      );
    }
    const id = value.id as string;
    const parentId = value.parentId as string | null;
    if (ids.has(id)) {
      throw new PiSessionHistoryError(
        "invalid_schema",
        "Pi session history contains a duplicate entry id.",
      );
    }
    if (parentId !== null && !ids.has(parentId)) {
      throw new PiSessionHistoryError(
        "invalid_schema",
        "Pi session history contains a missing or forward parent reference.",
      );
    }
    ids.add(id);
    entries.push(value as unknown as PiSessionEntry);
  }
  return { header, entries, bytes };
}

function activeBranch(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: PiSessionEntry[] = [];
  let current = entries.at(-1);
  while (current) {
    branch.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return branch.reverse();
}

/**
 * Project the model, thinking level and trusted-extension mode from Pi's
 * currently selected branch. These values deliberately never come from
 * session.json.
 */
export function restoredPiSessionState(entries: readonly PiSessionEntry[]): RestoredPiSessionState {
  const state: RestoredPiSessionState = {};
  for (const entry of activeBranch(entries)) {
    if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      state.model = {
        key: `${entry.provider}/${entry.modelId}`,
        provider: entry.provider,
        modelId: entry.modelId,
      };
      continue;
    }
    if (entry.type === "message" && isRecord(entry.message)) {
      const message = entry.message;
      if (
        message.role === "assistant" &&
        typeof message.provider === "string" &&
        typeof message.model === "string"
      ) {
        state.model = {
          key: `${message.provider}/${message.model}`,
          provider: message.provider,
          modelId: message.model,
        };
      }
      continue;
    }
    if (
      entry.type === "thinking_level_change" &&
      typeof entry.thinkingLevel === "string" &&
      (PI_THINKING_LEVELS as readonly string[]).includes(entry.thinkingLevel)
    ) {
      state.thinkingLevel = entry.thinkingLevel as ThinkingLevel;
      continue;
    }
    if (
      entry.type === "custom" &&
      entry.customType === "piwork.mode" &&
      isRecord(entry.data) &&
      (entry.data.mode === "agent" || entry.data.mode === "plan")
    ) {
      state.mode = entry.data.mode;
    }
  }
  return state;
}

export async function readPiSessionDocument(
  options: ReadPiSessionHistoryOptions,
): Promise<PiSessionDocument> {
  const limits = resolveLimits(options.limits);
  const resolved = await resolveSessionFile(options);
  const { lines, bytes } = await readExactFile(resolved, limits);
  return parseDocument(lines, bytes, options, resolved, limits);
}

/**
 * Startup-only synchronous counterpart used before an inactive session is
 * published. It shares the same exact path, framing and schema validators.
 */
export function readPiSessionDocumentSync(options: ReadPiSessionHistoryOptions): PiSessionDocument {
  const limits = resolveLimits(options.limits);
  const resolved = resolveSessionFileSync(options);
  const { lines, bytes } = readExactFileSync(resolved, limits);
  return parseDocument(lines, bytes, options, resolved, limits);
}

export async function readPiSessionHistoryPage(
  options: ReadPiSessionHistoryPageOptions,
): Promise<PiSessionHistoryPage> {
  const limits = resolveLimits(options.limits);
  const limit = positiveInteger(options.limit, limits.defaultPageSize, "limit");
  if (limit > limits.maxPageSize) {
    throw new TypeError("limit exceeds maxPageSize.");
  }
  const resolved = await resolveSessionFile(options);
  const { lines, bytes } = await readExactFile(resolved, limits);
  const document = parseDocument(lines, bytes, options, resolved, limits);
  let start = 0;
  if (options.cursor !== undefined) {
    if (!nonEmptyString(options.cursor)) {
      throw new PiSessionHistoryError("invalid_cursor", "Pi history cursor is invalid.");
    }
    const cursorIndex = document.entries.findIndex((entry) => entry.id === options.cursor);
    if (cursorIndex < 0) {
      throw new PiSessionHistoryError(
        "invalid_cursor",
        "Pi history cursor does not exist in this session.",
      );
    }
    start = cursorIndex + 1;
  }
  const entries = document.entries.slice(start, start + limit);
  const hasMore = start + entries.length < document.entries.length;
  return {
    header: document.header,
    entries,
    cursor: options.cursor,
    nextCursor: hasMore ? entries.at(-1)?.id : undefined,
    hasMore,
    totalEntries: document.entries.length,
    bytes: document.bytes,
    piSessionRelativePath: resolved.relativePath,
  };
}
