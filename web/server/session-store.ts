import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentMessage } from "../shared/pi-browser-protocol.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import type { SessionAuthoritySnapshot } from "./control-plane-types.js";
import { log } from "./logger.js";
import { requireSessionId } from "./path-policy.js";

/**
 * A prompt accepted while the per-session Pi process is unavailable.
 *
 * This is intentionally the only message-shaped data allowed in session.json.
 * Once delivered to Pi it is removed; the corresponding Pi JSONL entry then
 * becomes the sole durable conversation record.
 */
export interface OfflineQueueEntry {
  clientMessageId: string;
  message: AgentMessage;
  queuedAt: number;
}

/**
 * Product authority and delivery metadata only. Pi JSONL is the single source
 * of truth for messages, model selection, compaction, plan state and todos.
 */
export interface PersistedSession {
  id: string;
  authority?: SessionAuthoritySnapshot;
  piSessionRelativePath?: string;
  offlineQueue: OfflineQueueEntry[];
  processedClientMessageIds: string[];
  archived?: boolean;
  archivedAt?: number;
}

const DEFAULT_DIR = join(tmpdir(), "piwork-pi-sessions");
const SESSION_SCHEMA_VERSION = 2;
const MAX_OFFLINE_QUEUE_ENTRIES = 100;
const MAX_PROCESSED_CLIENT_IDS = 4_096;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PI_SESSION_RELATIVE_PATH_PATTERN = /^pi-sessions\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.jsonl$/;
const PERSISTED_SESSION_FIELDS = new Set([
  "id",
  "authority",
  "piSessionRelativePath",
  "offlineQueue",
  "processedClientMessageIds",
  "archived",
  "archivedAt",
]);
const LEGACY_SESSION_FIELDS = [
  "state",
  "messages",
  "history",
  "messageHistory",
  "pendingMessages",
  "pendingPermission",
  "pendingPermissions",
  "eventBuffer",
  "nextEventSeq",
  "lastAckSeq",
  "launcher",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function normalizeAuthority(value: unknown): SessionAuthoritySnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid session authority");
  return {
    tenantId: requireString(value.tenantId, "authority tenant id"),
    userId: requireString(value.userId, "authority user id"),
    membershipId: requireString(value.membershipId, "authority membership id"),
    orgNodeId: requireString(value.orgNodeId, "authority org node id"),
    agentDefinitionId: requireString(value.agentDefinitionId, "authority agent definition id"),
    agentVersionId: requireString(value.agentVersionId, "authority agent version id"),
    effectivePolicyHash: requireString(value.effectivePolicyHash, "authority policy hash", 1_024),
  };
}

function normalizeMessagePart(value: unknown): AgentMessage["content"][number] {
  if (!isRecord(value)) throw new Error("Invalid offline message part");
  if (value.type === "text") {
    return {
      type: "text",
      text: requireString(value.text, "offline message text", 4 * 1024 * 1024),
    };
  }
  if (value.type === "image") {
    return {
      type: "image",
      mediaType: requireString(value.mediaType, "offline image media type", 255),
      data: requireString(value.data, "offline image data", 16 * 1024 * 1024),
    };
  }
  throw new Error("Only text and image parts may be queued offline");
}

function normalizeOfflineMessage(value: unknown): AgentMessage {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) {
    throw new Error("Offline queue entries must contain a user message");
  }
  const id = requireString(value.id, "offline message id", 256);
  if (!Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 0) {
    throw new Error("Invalid offline message timestamp");
  }
  const content = value.content.map(normalizeMessagePart);
  if (content.length === 0) throw new Error("Offline user messages cannot be empty");
  return {
    id,
    role: "user",
    content,
    timestamp: Number(value.timestamp),
  };
}

function normalizeOfflineQueue(value: unknown): OfflineQueueEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OFFLINE_QUEUE_ENTRIES) {
    throw new Error("Invalid offline queue");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Invalid offline queue entry");
    const clientMessageId = requireString(entry.clientMessageId, "client message id", 256);
    if (!CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId) || seen.has(clientMessageId)) {
      throw new Error("Invalid or duplicate offline client message id");
    }
    seen.add(clientMessageId);
    if (!Number.isSafeInteger(entry.queuedAt) || Number(entry.queuedAt) < 0) {
      throw new Error("Invalid offline queue timestamp");
    }
    return {
      clientMessageId,
      message: normalizeOfflineMessage(entry.message),
      queuedAt: Number(entry.queuedAt),
    };
  });
}

function normalizeProcessedClientMessageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PROCESSED_CLIENT_IDS) {
    throw new Error("Invalid processed client message ids");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = requireString(raw, "processed client message id", 256);
    if (!CLIENT_MESSAGE_ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error("Invalid or duplicate processed client message id");
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizePersistedSession(value: unknown, expectedId: string): PersistedSession {
  if (!isRecord(value)) throw new Error("Invalid persisted session");
  for (const field of LEGACY_SESSION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`Legacy session field is not accepted: ${field}`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!PERSISTED_SESSION_FIELDS.has(field)) {
      throw new Error(`Unsupported session.json field: ${field}`);
    }
  }

  const id = requireSessionId(requireString(value.id, "session id", 200));
  if (id !== expectedId) throw new Error("Persisted session id does not match its directory");

  let piSessionRelativePath: string | undefined;
  if (value.piSessionRelativePath !== undefined) {
    piSessionRelativePath = requireString(
      value.piSessionRelativePath,
      "Pi session relative path",
      512,
    );
    if (!PI_SESSION_RELATIVE_PATH_PATTERN.test(piSessionRelativePath)) {
      throw new Error("Pi session path must be an exact JSONL child of pi-sessions");
    }
  }

  let archived: boolean | undefined;
  let archivedAt: number | undefined;
  if (value.archived !== undefined) {
    if (typeof value.archived !== "boolean") throw new Error("Invalid archived state");
    archived = value.archived;
  }
  if (value.archivedAt !== undefined) {
    if (!Number.isSafeInteger(value.archivedAt) || Number(value.archivedAt) < 0) {
      throw new Error("Invalid archived timestamp");
    }
    archivedAt = Number(value.archivedAt);
  }
  if (archived === true && archivedAt === undefined) {
    throw new Error("Archived sessions require an archived timestamp");
  }
  if (archived !== true && archivedAt !== undefined) {
    throw new Error("Only archived sessions may have an archived timestamp");
  }

  return {
    id,
    authority: normalizeAuthority(value.authority),
    piSessionRelativePath,
    offlineQueue: normalizeOfflineQueue(value.offlineQueue),
    processedClientMessageIds: normalizeProcessedClientMessageIds(value.processedClientMessageIds),
    archived,
    archivedAt,
  };
}

export class SessionStore {
  private readonly dir: string;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingWrites = new Map<string, PersistedSession>();
  private readonly layout: "flat" | "session-dir";

  constructor(dir?: string, options: { layout?: "flat" | "session-dir" } = {}) {
    this.dir = dir || DEFAULT_DIR;
    this.layout = options.layout || "flat";
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private filePath(sessionId: string): string {
    const id = requireSessionId(sessionId);
    return this.layout === "session-dir"
      ? join(this.dir, id, "session.json")
      : join(this.dir, `${id}.json`);
  }

  private jsonStore(sessionId: string): AtomicJsonStore<PersistedSession> {
    const id = requireSessionId(sessionId);
    return new AtomicJsonStore<PersistedSession>(this.filePath(id), {
      schemaVersion: SESSION_SCHEMA_VERSION,
      normalize: (value) => normalizePersistedSession(value, id),
      pretty: false,
      backupLegacy: false,
    });
  }

  private pendingOrLoaded(sessionId: string): PersistedSession | null {
    const id = requireSessionId(sessionId);
    return this.pendingWrites.get(id) || this.load(id);
  }

  private cancelPending(sessionId: string): void {
    const id = requireSessionId(sessionId);
    const timer = this.debounceTimers.get(id);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(id);
    this.pendingWrites.delete(id);
  }

  private replaceAndSave(sessionId: string, update: (session: PersistedSession) => void): boolean {
    const id = requireSessionId(sessionId);
    const session = this.pendingOrLoaded(id);
    if (!session) return false;
    update(session);
    this.cancelPending(id);
    this.saveSync(session);
    return true;
  }

  getSessionDirectory(sessionId: string): string | null {
    const id = requireSessionId(sessionId);
    return this.layout === "session-dir" ? join(this.dir, id) : null;
  }

  hasSessionData(sessionId: string): boolean {
    const id = requireSessionId(sessionId);
    return existsSync(this.layout === "session-dir" ? join(this.dir, id) : this.filePath(id));
  }

  save(session: PersistedSession): void {
    const normalized = normalizePersistedSession(session, requireSessionId(session.id));
    this.cancelPending(normalized.id);
    this.pendingWrites.set(normalized.id, normalized);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(normalized.id);
      const pending = this.pendingWrites.get(normalized.id);
      this.pendingWrites.delete(normalized.id);
      if (!pending) return;
      try {
        this.saveSync(pending);
      } catch (error) {
        log.error("session-store", "Failed to save session", {
          sessionId: normalized.id,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }, 150);
    this.debounceTimers.set(normalized.id, timer);
  }

  saveSync(session: PersistedSession): void {
    const id = requireSessionId(session.id);
    this.cancelPending(id);
    const normalized = normalizePersistedSession(session, id);
    if (this.layout === "session-dir") {
      mkdirSync(join(this.dir, id), { recursive: true, mode: 0o700 });
    }
    this.jsonStore(id).write(normalized);
  }

  load(sessionId: string): PersistedSession | null {
    return this.jsonStore(sessionId).readValue();
  }

  setAuthority(sessionId: string, authority: SessionAuthoritySnapshot): boolean {
    return this.replaceAndSave(sessionId, (session) => {
      session.authority = normalizeAuthority(authority);
    });
  }

  setPiSessionRelativePath(sessionId: string, piSessionRelativePath: string): boolean {
    return this.replaceAndSave(sessionId, (session) => {
      session.piSessionRelativePath = piSessionRelativePath;
    });
  }

  enqueueOffline(sessionId: string, entry: OfflineQueueEntry): boolean {
    return this.replaceAndSave(sessionId, (session) => {
      if (session.offlineQueue.some((item) => item.clientMessageId === entry.clientMessageId))
        return;
      if (session.offlineQueue.length >= MAX_OFFLINE_QUEUE_ENTRIES) {
        throw new Error("Offline queue limit reached");
      }
      session.offlineQueue.push(entry);
    });
  }

  drainOffline(sessionId: string): OfflineQueueEntry[] {
    const session = this.pendingOrLoaded(sessionId);
    if (!session || session.offlineQueue.length === 0) return [];
    const entries = session.offlineQueue;
    session.offlineQueue = [];
    this.cancelPending(sessionId);
    this.saveSync(session);
    return entries;
  }

  markClientMessageProcessed(sessionId: string, clientMessageId: string): boolean {
    return this.replaceAndSave(sessionId, (session) => {
      if (session.processedClientMessageIds.includes(clientMessageId)) return;
      session.processedClientMessageIds.push(clientMessageId);
      if (session.processedClientMessageIds.length > MAX_PROCESSED_CLIENT_IDS) {
        session.processedClientMessageIds.splice(
          0,
          session.processedClientMessageIds.length - MAX_PROCESSED_CLIENT_IDS,
        );
      }
    });
  }

  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const entries = readdirSync(this.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (this.layout === "session-dir") {
          if (!entry.isDirectory() || !existsSync(join(this.dir, entry.name, "session.json")))
            continue;
          try {
            const session = this.load(entry.name);
            if (session) sessions.push(session);
          } catch {
            // Invalid directory names and corrupt authority files are ignored.
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = basename(entry.name, ".json");
        try {
          const session = this.load(id);
          if (session) sessions.push(session);
        } catch {
          // Invalid filenames and corrupt authority files are ignored.
        }
      }
    } catch {
      // The directory may have been removed during shutdown.
    }
    return sessions;
  }

  setArchived(sessionId: string, archived: boolean): boolean {
    return this.replaceAndSave(sessionId, (session) => {
      session.archived = archived;
      if (archived) session.archivedAt = Date.now();
      else delete session.archivedAt;
    });
  }

  remove(sessionId: string): void {
    const id = requireSessionId(sessionId);
    this.cancelPending(id);
    try {
      if (this.layout === "session-dir") rmSync(this.filePath(id), { force: true });
      else unlinkSync(this.filePath(id));
    } catch {
      // The authority file may not exist.
    }
  }

  removeSessionDirectory(sessionId: string): boolean {
    const id = requireSessionId(sessionId);
    if (this.layout !== "session-dir") {
      this.remove(id);
      return false;
    }
    this.cancelPending(id);
    const directory = join(this.dir, id);
    if (!existsSync(directory)) return false;
    try {
      rmSync(directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    const writes = [...this.pendingWrites.values()];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.pendingWrites.clear();
    for (const pending of writes) this.saveSync(pending);
  }

  get directory(): string {
    return this.dir;
  }
}
