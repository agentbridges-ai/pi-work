import { join } from "node:path";
import { PIWORK_HOME } from "./paths.js";
import { ENV, environment } from "./environment.js";
import type { UserSpaceMount } from "./session-types.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

export interface WorkspaceState {
  selectedAgentId: string;
  currentSessionId: string | null;
  agentSessionIds: Record<string, string>;
  agentSessionHistoryIds: Record<string, string[]>;
  agentUserSpaces: Record<string, UserSpaceMount[]>;
  updatedAt: string;
}

const DEFAULT_SELECTED_AGENT_ID = "agent";

function defaultWorkspaceState(): WorkspaceState {
  return {
    selectedAgentId: DEFAULT_SELECTED_AGENT_ID,
    currentSessionId: null,
    agentSessionIds: {},
    agentSessionHistoryIds: {},
    agentUserSpaces: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSessionId(value: unknown): string | null {
  const sessionId = cleanString(value);
  return sessionId || null;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = cleanString(key);
    const cleanValue = cleanString(raw);
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  }
  return out;
}

function normalizeHistory(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [key, rawList] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = cleanString(key);
    if (!cleanKey || !Array.isArray(rawList)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of rawList) {
      const sessionId = cleanString(raw);
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      list.push(sessionId);
    }
    out[cleanKey] = list;
  }
  return out;
}

function normalizeWorkspaceAccess(value: unknown): UserSpaceMount["access"] {
  return value === "readonly" ? "readonly" : "readwrite";
}

function normalizeWorkspaceStatus(value: unknown): UserSpaceMount["status"] {
  return value === "expected" || value === "mounted" || value === "offline" ? value : "offline";
}

function normalizeUserSpaceMount(value: unknown): UserSpaceMount | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UserSpaceMount>;
  const mountId = cleanString(raw.mountId);
  const name = cleanString(raw.name);
  const rootName = cleanString(raw.rootName) || name;
  if (!mountId || !name || !rootName) return null;
  const access = normalizeWorkspaceAccess(raw.access);
  const canRead = raw.canRead === false ? false : true;
  const canWrite = access === "readwrite" && raw.canWrite !== false;
  const permissionState =
    raw.permissionState === "granted" ||
    raw.permissionState === "denied" ||
    raw.permissionState === "prompt"
      ? raw.permissionState
      : "unknown";
  return {
    mountId,
    name,
    rootName,
    status: normalizeWorkspaceStatus(raw.status),
    access,
    canRead,
    canWrite,
    permissionState,
    lastPermissionCheckedAt:
      typeof raw.lastPermissionCheckedAt === "number" ? raw.lastPermissionCheckedAt : undefined,
    includeHidden: true,
    fileCount: typeof raw.fileCount === "number" ? raw.fileCount : undefined,
    lastIndexedAt: typeof raw.lastIndexedAt === "number" ? raw.lastIndexedAt : undefined,
  };
}

function normalizeAgentUserSpaces(value: unknown): Record<string, UserSpaceMount[]> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, UserSpaceMount[]> = {};
  for (const [key, rawList] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = cleanString(key);
    if (!cleanKey || !Array.isArray(rawList)) continue;
    const mounts = rawList
      .map(normalizeUserSpaceMount)
      .filter((mount): mount is UserSpaceMount => Boolean(mount));
    if (mounts.length > 0) out[cleanKey] = mounts;
  }
  return out;
}

export function normalizeWorkspaceState(value: unknown): WorkspaceState {
  const raw = value && typeof value === "object" ? (value as Partial<WorkspaceState>) : {};
  const selectedAgentId = cleanString(raw.selectedAgentId) || DEFAULT_SELECTED_AGENT_ID;
  const agentSessionIds = normalizeStringMap(raw.agentSessionIds);
  const agentSessionHistoryIds = normalizeHistory(raw.agentSessionHistoryIds);
  const agentUserSpaces = normalizeAgentUserSpaces(raw.agentUserSpaces);
  const currentSessionId = normalizeSessionId(raw.currentSessionId);
  const updatedAt = cleanString(raw.updatedAt) || new Date(0).toISOString();

  return {
    selectedAgentId,
    currentSessionId,
    agentSessionIds,
    agentSessionHistoryIds,
    agentUserSpaces,
    updatedAt,
  };
}

export class WorkspaceStateStore {
  private readonly filePath: string;
  private readonly store: AtomicJsonStore<WorkspaceState>;

  constructor(
    filePath = environment.value(ENV.PIWORK_WORKSPACE_STATE_PATH) ||
      join(PIWORK_HOME, "workspace-state.json"),
  ) {
    this.filePath = filePath;
    this.store = new AtomicJsonStore(filePath, {
      schemaVersion: 1,
      normalize: normalizeWorkspaceState,
      defaultValue: defaultWorkspaceState,
    });
  }

  get(): WorkspaceState {
    return this.store.readValue() ?? defaultWorkspaceState();
  }

  put(next: Partial<WorkspaceState>): WorkspaceState {
    const merged = normalizeWorkspaceState({
      ...this.get(),
      ...next,
      updatedAt: new Date().toISOString(),
    });
    this.write(merged);
    return merged;
  }

  bindSession(agentId: string, sessionId: string): WorkspaceState {
    const cleanAgentId = cleanString(agentId) || DEFAULT_SELECTED_AGENT_ID;
    const cleanSessionId = cleanString(sessionId);
    if (!cleanSessionId) return this.get();
    const state = this.get();
    const history = state.agentSessionHistoryIds[cleanAgentId] || [];
    return this.put({
      selectedAgentId: cleanAgentId,
      currentSessionId: cleanSessionId,
      agentSessionIds: {
        ...state.agentSessionIds,
        [cleanAgentId]: cleanSessionId,
      },
      agentSessionHistoryIds: {
        ...state.agentSessionHistoryIds,
        [cleanAgentId]: [cleanSessionId, ...history.filter((id) => id !== cleanSessionId)],
      },
    });
  }

  removeSession(sessionId: string): WorkspaceState {
    const cleanSessionId = cleanString(sessionId);
    if (!cleanSessionId) return this.get();
    const state = this.get();
    const agentSessionIds = { ...state.agentSessionIds };
    for (const [agentId, boundSessionId] of Object.entries(agentSessionIds)) {
      if (boundSessionId === cleanSessionId) agentSessionIds[agentId] = "";
    }
    const agentSessionHistoryIds = Object.fromEntries(
      Object.entries(state.agentSessionHistoryIds).map(([agentId, history]) => [
        agentId,
        history.filter((id) => id !== cleanSessionId),
      ]),
    );
    return this.put({
      currentSessionId: state.currentSessionId === cleanSessionId ? null : state.currentSessionId,
      agentSessionIds,
      agentSessionHistoryIds,
    });
  }

  private write(state: WorkspaceState): void {
    this.store.write(state);
  }

  get path(): string {
    return this.filePath;
  }
}
