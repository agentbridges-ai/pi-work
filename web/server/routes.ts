import { Hono, type Context } from "hono";
import type { ServerWebSocket } from "bun";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";
import type { SessionOrchestrator } from "./session-orchestrator.js";
import type { PiLauncher, PiSessionInfo } from "./pi-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SocketData } from "./ws-bridge.js";
import { SessionNameStore } from "./session-names.js";
import { registerAgentSpaceRoutes } from "./routes/agent-space-routes.js";
import { registerSkillRoutes } from "./routes/skills-routes.js";
import { registerMetricsRoutes } from "./routes/metrics-routes.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics-routes.js";
import { registerRbacRoutes } from "./routes/rbac-routes.js";
import { registerControlPlaneRoutes } from "./routes/control-plane-routes.js";
import type { ControlPlaneService } from "./control-plane-service.js";
import type { TenantRuntimeDriver } from "./tenant-runtime-driver.js";
import { isRecordingHubEnabled } from "./recording-hub/hub-config.js";
import { registerHubRoutes } from "./recording-hub/hub-routes.js";
import type { UserSpaceBroker } from "./user-space-broker.js";
import { registerUserSpaceTransferRoutes } from "./user-space-broker.js";
import type { UserSpaceMount } from "./session-types.js";
import { publicUserSpaceFromMount } from "./user-space-session-state.js";
import type { WorkspaceStateStore, WorkspaceState } from "./workspace-state-store.js";
import { ENV, environment } from "./environment.js";
import type { AuthenticatedUser } from "./auth-types.js";
import type { RbacService } from "./rbac-service.js";
import {
  getTenantUserDataRoot,
  getTenantUserPiSkillsRoot,
  getUserDataRoot,
  getUserPiSkillsRoot,
} from "./local-paths.js";
import { requireSessionId } from "./path-policy.js";
import { sanitizePublicSessionCreateRequest } from "./public-session-create.js";
import type { UserDiskQuota } from "./user-disk-quota.js";
import { isRuntimeContextId } from "../shared/api-contracts.js";
import { registerAgentBrowserRoutes } from "./routes/agent-browser-routes.js";
import type { AgentBrowserBridgeService } from "./agent-browser-bridge-service.js";
import type { BrowserControlCoordinator } from "./browser-control-session.js";
import type { PiProviderVault } from "./pi-provider-vault.js";
import type { PiLaunchOptionsBuilder } from "./pi-launch-options-builder.js";
import { PiSessionHistoryError, readPiSessionHistoryPage } from "./pi-session-history.js";
import type { PiModelCandidate } from "./pi-model-policy.js";
import { PI_THINKING_LEVELS, type PiThinkingLevel } from "./pi-rpc-contract.js";

function supportedThinkingLevels(candidate: PiModelCandidate): PiThinkingLevel[] {
  if (!candidate.reasoning) return ["off"];
  const map = candidate.thinkingLevelMap;
  return PI_THINKING_LEVELS.filter((level) => {
    if (level === "off") return true;
    if (level === "xhigh" || level === "max") {
      return map?.[level] !== undefined && map[level] !== null;
    }
    return map?.[level] !== null;
  });
}

interface UserSpaceCreateMetadata {
  mountId?: unknown;
  name?: unknown;
  rootName?: unknown;
  access?: unknown;
  canRead?: unknown;
  canWrite?: unknown;
  permissionState?: unknown;
  lastPermissionCheckedAt?: unknown;
  includeHidden?: unknown;
  fileCount?: unknown;
  lastIndexedAt?: unknown;
}

function normalizeUserSpaceMetadata(value: unknown): UserSpaceMount[] {
  if (!Array.isArray(value)) return [];
  const mounts: UserSpaceMount[] = [];
  const seen = new Set<string>();
  for (const raw of value as UserSpaceCreateMetadata[]) {
    if (!raw || typeof raw !== "object") continue;
    const mountId = typeof raw.mountId === "string" ? raw.mountId.trim() : "";
    if (!mountId || seen.has(mountId)) continue;
    seen.add(mountId);

    const rootName =
      typeof raw.rootName === "string" && raw.rootName.trim() ? raw.rootName.trim() : "user-space";
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : rootName;
    const fileCount =
      typeof raw.fileCount === "number" && Number.isFinite(raw.fileCount)
        ? raw.fileCount
        : undefined;
    const lastIndexedAt =
      typeof raw.lastIndexedAt === "number" && Number.isFinite(raw.lastIndexedAt)
        ? raw.lastIndexedAt
        : undefined;

    mounts.push({
      mountId,
      name,
      rootName,
      status: "expected",
      access: raw.access === "readonly" ? "readonly" : "readwrite",
      canRead: typeof raw.canRead === "boolean" ? raw.canRead : true,
      canWrite: typeof raw.canWrite === "boolean" ? raw.canWrite : raw.access !== "readonly",
      permissionState:
        typeof raw.permissionState === "string"
          ? (raw.permissionState as UserSpaceMount["permissionState"])
          : "unknown",
      lastPermissionCheckedAt:
        typeof raw.lastPermissionCheckedAt === "number" ? raw.lastPermissionCheckedAt : undefined,
      includeHidden: true,
      fileCount,
      lastIndexedAt,
    });
  }
  return mounts;
}

function selectActiveUserSpaceMount(mounts: UserSpaceMount[]): UserSpaceMount | null {
  if (mounts.length === 0) return null;
  return (
    [...mounts].sort((left, right) => {
      if (left.status !== right.status) {
        if (left.status === "mounted") return -1;
        if (right.status === "mounted") return 1;
        if (left.status === "expected") return -1;
        if (right.status === "expected") return 1;
      }
      const leftSeen = Math.max(left.lastPermissionCheckedAt || 0, left.lastIndexedAt || 0);
      const rightSeen = Math.max(right.lastPermissionCheckedAt || 0, right.lastIndexedAt || 0);
      return rightSeen - leftSeen;
    })[0] || null
  );
}

function normalizeUserSpaceConfiguration(value: unknown): UserSpaceMount[] {
  const rawList = Array.isArray(value) ? value : value ? [value] : [];
  return normalizeUserSpaceMetadata(rawList);
}

function configureUserSpaceForSession(
  body: { backend?: unknown; userSpace?: unknown; activeMountId?: unknown },
  result: { sessionId: string },
  wsBridge: WsBridge,
  userSpaceBroker: UserSpaceBroker | undefined,
  _port?: number,
): void {
  if (!userSpaceBroker) return;
  if ((body.backend ?? "pi") !== "pi") return;

  const mounts = normalizeUserSpaceConfiguration(body.userSpace);

  const activeMountId =
    typeof body.activeMountId === "string" ? body.activeMountId.trim() : undefined;
  const configured = userSpaceBroker.configureSession(result.sessionId, mounts, activeMountId);
  wsBridge.setUserSpaces(result.sessionId, configured.mounts);
}

interface CreateRoutesOptions {
  getCurrentUser?: () => AuthenticatedUser | null;
  rbac?: RbacService;
  controlPlane?: ControlPlaneService;
  runtimeDriver?: TenantRuntimeDriver;
  diskQuota?: UserDiskQuota;
  agentBrowserBridge?: AgentBrowserBridgeService;
  browserControl?: BrowserControlCoordinator;
  providerVault?: PiProviderVault;
  launchBuilder?: PiLaunchOptionsBuilder;
  onSessionBound?: (sessionId: string) => void;
}

function getCurrentUserSnapshot(options?: CreateRoutesOptions): AuthenticatedUser {
  const current = options?.getCurrentUser?.();
  if (current) return current;
  return {
    userId: environment.value(ENV.PIWORK_USER_ID) || "local-user",
    uuid: environment.value(ENV.PIWORK_USER_ID) || "local-user",
    username: environment.value(ENV.PIWORK_USERNAME) || environment.value(ENV.USER) || "local-user",
    displayName:
      environment.value(ENV.PIWORK_USER_DISPLAY_NAME) ||
      environment.value(ENV.USER) ||
      "Local User",
    orgId: environment.value(ENV.PIWORK_ORG_ID) || "local",
    orgName: environment.value(ENV.PIWORK_ORG_NAME) || "Local",
    roles: ["local"],
    permissions: [],
    departments: [],
  };
}

async function resolveGovernedSessionLaunch(
  body: Record<string, unknown>,
  options: CreateRoutesOptions,
): Promise<Awaited<ReturnType<ControlPlaneService["resolveSessionAuthority"]>> | undefined> {
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const currentUser = getCurrentUserSnapshot(options);
  if (!agentId || !options.controlPlane || !currentUser.tenantId) return undefined;
  return options.controlPlane.resolveSessionAuthority(
    currentUser.userId,
    currentUser.tenantId,
    agentId,
  );
}

async function prepareSessionCreate(body: unknown, options: CreateRoutesOptions) {
  if (
    body &&
    typeof body === "object" &&
    "backend" in body &&
    body.backend !== undefined &&
    body.backend !== "pi"
  ) {
    return { error: "Only the native Pi backend is supported", status: 400 };
  }
  const requestBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const publicLaunch = sanitizePublicSessionCreateRequest(requestBody);
  try {
    const resolvedLaunch = await resolveGovernedSessionLaunch(requestBody, options);
    const authority = resolvedLaunch?.authority;
    const governedLaunch = resolvedLaunch?.launch;
    return {
      authority,
      creationBody: {
        ...publicLaunch,
        backend: "pi" as const,
        ...(authority ? { authority } : {}),
        ...(governedLaunch ? { resolvedSandbox: governedLaunch } : {}),
      },
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause), status: 403 };
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = raw !== undefined ? Number(raw) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseCursor(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number(raw) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function sortSessionsNewestFirst(sessions: PiSessionInfo[]): PiSessionInfo[] {
  return [...sessions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getEnrichedSessions(
  orchestrator: SessionOrchestrator,
  launcher: PiLauncher,
  sessionNameStore: SessionNameStore,
) {
  const sessions = launcher.listSessions();
  const names = sessionNameStore.getAllNames();
  return sessions.map((s) => {
    return {
      ...s,
      name: names[s.sessionId] ?? s.name,
      lifecycleState: orchestrator.getLifecycleState(s.sessionId),
      runtimeState: orchestrator.getRuntimeState(s.sessionId),
    };
  });
}

function getSessionListPage(
  sessions: PiSessionInfo[],
  options: {
    cursor?: number;
    limit?: number;
    agentId?: string;
    workspaceState?: WorkspaceState;
    archived?: boolean;
  } = {},
) {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const cursor = Math.max(0, Math.floor(options.cursor ?? 0));
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  let ordered: PiSessionInfo[];

  if (options.agentId && options.workspaceState) {
    const pinned = options.workspaceState.agentSessionIds?.[options.agentId] || "";
    const ids = [
      pinned,
      ...(options.workspaceState.agentSessionHistoryIds?.[options.agentId] || []),
    ].filter(Boolean);
    const seen = new Set<string>();
    ordered = ids
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        const session = sessionById.get(id);
        return !!session && Boolean(session.archived) === Boolean(options.archived);
      })
      .map((id) => sessionById.get(id)!)
      .filter((session) => Boolean(session.archived) === Boolean(options.archived));
  } else {
    ordered = sortSessionsNewestFirst(sessions).filter(
      (session) => Boolean(session.archived) === Boolean(options.archived),
    );
  }

  const page = ordered.slice(cursor, cursor + limit);
  return {
    sessions: page,
    total: ordered.length,
    cursor,
    nextCursor: cursor + page.length,
    hasMore: cursor + page.length < ordered.length,
    agentId: options.agentId,
  };
}

function getBootstrapSessions(sessions: PiSessionInfo[], workspaceState: WorkspaceState) {
  const limit = parsePositiveInt(environment.value(ENV.PIWORK_BOOTSTRAP_SESSION_LIMIT), 100, 500);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const selectedIds = new Set<string>();
  if (workspaceState.currentSessionId) selectedIds.add(workspaceState.currentSessionId);
  for (const sessionId of Object.values(workspaceState.agentSessionIds || {})) {
    if (sessionId) selectedIds.add(sessionId);
  }

  const picked: PiSessionInfo[] = [];
  for (const sessionId of selectedIds) {
    const session = sessionById.get(sessionId);
    if (session && !session.archived) picked.push(session);
  }
  const pickedIds = new Set(picked.map((session) => session.sessionId));
  for (const session of sortSessionsNewestFirst(sessions)) {
    if (picked.length >= limit) break;
    if (session.archived || pickedIds.has(session.sessionId)) continue;
    picked.push(session);
    pickedIds.add(session.sessionId);
  }

  const total = sessions.filter((session) => !session.archived).length;
  return {
    sessions: picked,
    total,
    hasMore: picked.length < total,
  };
}

function extractAgentId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { agentId?: unknown }).agentId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface UserSpaceBrowserContextAuthority {
  session: ReturnType<WsBridge["getSession"]>;
  socket: ServerWebSocket<SocketData> | null;
  epoch?: number;
  contextId?: string;
}

function negotiatedBrowserSockets(
  session: NonNullable<ReturnType<WsBridge["getSession"]>>,
): ServerWebSocket<SocketData>[] {
  return [...session.browserSockets].filter(
    (socket) => socket.data.kind === "browser" && socket.data.protocolVersion === 1,
  );
}

function captureUserSpaceBrowserContext(
  wsBridge: WsBridge,
  sessionId: string,
  rawEpoch: string | undefined,
  rawContextId: string | undefined,
): UserSpaceBrowserContextAuthority | null {
  const epochText = rawEpoch?.trim() || "";
  const contextId = rawContextId?.trim() || "";
  const hasEpoch = epochText.length > 0;
  const hasContextId = contextId.length > 0;
  if (hasEpoch !== hasContextId) return null;
  const epoch = hasEpoch ? Number(epochText) : undefined;
  if (
    epoch !== undefined &&
    (!Number.isSafeInteger(epoch) || epoch < 0 || !isRuntimeContextId(contextId))
  )
    return null;
  const session = wsBridge.getSession(sessionId);
  if (!session) return epoch === undefined ? { session: undefined, socket: null } : null;
  const sockets = negotiatedBrowserSockets(session);
  if (epoch === undefined) {
    return sockets.length === 0 ? { session, socket: null } : null;
  }
  const socket = sockets.find(
    (candidate) =>
      candidate.data.kind === "browser" &&
      candidate.data.contextEpoch === epoch &&
      candidate.data.contextId === contextId,
  );
  return socket ? { session, socket, epoch, contextId } : null;
}

function validateUserSpaceBrowserContext(
  wsBridge: WsBridge,
  sessionId: string,
  authority: UserSpaceBrowserContextAuthority,
): boolean {
  const current = wsBridge.getSession(sessionId);
  if (authority.session && current !== authority.session) return false;
  if (!current) return authority.session === undefined;
  if (authority.socket) {
    return (
      current.browserSockets.has(authority.socket) &&
      authority.socket.data.kind === "browser" &&
      authority.socket.data.contextEpoch === authority.epoch &&
      authority.socket.data.contextId === authority.contextId
    );
  }
  return authority.epoch === undefined && negotiatedBrowserSockets(current).length === 0;
}

export function createRoutes(
  orchestrator: SessionOrchestrator,
  launcher: PiLauncher,
  wsBridge: WsBridge,
  recorder?: import("./recorder.js").RecorderManager,
  port?: number,
  userSpaceBroker?: UserSpaceBroker,
  workspaceStateStore?: WorkspaceStateStore,
  sessionNameStore = new SessionNameStore(),
  options: CreateRoutesOptions = {},
) {
  const api = new Hono();

  // Every session-scoped API is resolved again inside this Better Auth user's
  // runtime. A syntactically valid/guessed id is not authority by itself.
  api.use("/sessions/:id/*", async (c, next) => {
    // Hono's wildcard route also matches collection actions such as
    // /sessions/create-stream. Those actions do not address an existing
    // session and must reach their dedicated handlers below.
    if (["create", "create-stream", "archived"].includes(c.req.param("id"))) {
      await next();
      return;
    }
    let sessionId: string;
    try {
      sessionId = requireSessionId(c.req.param("id"));
    } catch {
      return c.json({ error: "Invalid session id" }, 400);
    }
    const persistedDelete = c.req.method === "DELETE" && orchestrator.hasSessionData(sessionId);
    if (!launcher.getSession(sessionId) && !wsBridge.getSession(sessionId) && !persistedDelete) {
      return c.json({ error: "Session not found" }, 404);
    }
    await next();
  });

  if (userSpaceBroker) {
    registerUserSpaceTransferRoutes(api, userSpaceBroker);
  }

  if (options.agentBrowserBridge) {
    registerAgentBrowserRoutes(api, {
      bridge: options.agentBrowserBridge,
      control: options.browserControl,
    });
  }

  registerAgentSpaceRoutes(api, {
    getCurrentUser: () => getCurrentUserSnapshot(options),
    userSpaceBroker,
    diskQuota: options.diskQuota,
  });

  api.get("/me", (c) => {
    const runtimeMode = environment.runtimeMode;
    return c.json({
      runtimeMode,
      user: getCurrentUserSnapshot(options),
    });
  });

  if (options.rbac && options.getCurrentUser) {
    registerRbacRoutes(api, { rbac: options.rbac, getCurrentUser: options.getCurrentUser });
  }
  if (options.controlPlane && options.getCurrentUser) {
    registerControlPlaneRoutes(api, {
      service: options.controlPlane,
      getCurrentUser: options.getCurrentUser,
      runtimeDriver: options.runtimeDriver,
    });
  }

  // ─── Native Pi sessions ────────────────────────────────────────────

  if (workspaceStateStore) {
    api.get("/workspace/bootstrap", (c) => {
      const allSessions = getEnrichedSessions(orchestrator, launcher, sessionNameStore);
      const workspaceState = workspaceStateStore.get();
      const bootstrapSessions = getBootstrapSessions(allSessions, workspaceState);
      return c.json({
        user: getCurrentUserSnapshot(options),
        sessions: bootstrapSessions.sessions,
        sessionsTotal: bootstrapSessions.total,
        sessionsHasMore: bootstrapSessions.hasMore,
        workspaceState,
      });
    });

    api.get("/workspace/session-state", (c) => {
      return c.json(workspaceStateStore.get());
    });

    api.put("/workspace/session-state", async (c) => {
      const body = await c.req.json().catch(() => ({}) as Partial<WorkspaceState>);
      return c.json(workspaceStateStore.put(body));
    });
  }

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prepared = await prepareSessionCreate(body, options);
    if ("error" in prepared)
      return c.json({ error: prepared.error }, prepared.status === 400 ? 400 : 403);
    const { authority, creationBody } = prepared;
    const result = await orchestrator.createSession(creationBody);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as any);
    }
    options.onSessionBound?.(result.session.sessionId);
    configureUserSpaceForSession(creationBody, result.session, wsBridge, userSpaceBroker, port);
    const agentId = extractAgentId(body);
    const workspaceState =
      agentId && workspaceStateStore
        ? workspaceStateStore.bindSession(agentId, result.session.sessionId)
        : undefined;
    if (authority) {
      orchestrator.pinSessionAuthority(result.session.sessionId, authority);
    }
    return c.json({ ...result.session, authority, workspaceState });
  });

  // ─── SSE Session Creation (with progress streaming) ─────────────────────

  api.post("/sessions/create-stream", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const prepared = await prepareSessionCreate(body, options);
    if ("error" in prepared)
      return c.json({ error: prepared.error }, prepared.status === 400 ? 400 : 403);
    const { authority, creationBody } = prepared;

    return streamSSE(c, async (stream) => {
      const result = await orchestrator.createSessionStreaming(
        creationBody,
        async (step, label, status, detail) => {
          await stream.writeSSE({
            event: "progress",
            data: JSON.stringify({ step, label, status, detail }),
          });
        },
      );

      if (!result.ok) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: result.error }),
        });
        return;
      }

      options.onSessionBound?.(result.session.sessionId);
      configureUserSpaceForSession(creationBody, result.session, wsBridge, userSpaceBroker, port);
      const agentId = extractAgentId(body);
      const workspaceState =
        agentId && workspaceStateStore
          ? workspaceStateStore.bindSession(agentId, result.session.sessionId)
          : undefined;
      if (authority) {
        orchestrator.pinSessionAuthority(result.session.sessionId, authority);
      }

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          sessionId: result.session.sessionId,
          state: result.session.state,
          cwd: result.session.cwd,
          backendType: result.session.backendType,
          transport: result.session.transport,
          model: result.session.model,
          thinkingLevel: result.session.thinkingLevel,
          mode: result.session.mode,
          authority,
          workspaceState,
        }),
      });
    });
  });

  api.get("/sessions", (c) => {
    const hasPagingQuery =
      c.req.query("cursor") !== undefined ||
      c.req.query("limit") !== undefined ||
      c.req.query("agentId") !== undefined ||
      c.req.query("archived") !== undefined;
    const archived = c.req.query("archived") === "true" || c.req.query("archived") === "1";
    const sessions = getEnrichedSessions(orchestrator, launcher, sessionNameStore);
    if (!hasPagingQuery)
      return c.json(sortSessionsNewestFirst(sessions).filter((session) => !session.archived));
    return c.json(
      getSessionListPage(sessions, {
        cursor: parseCursor(c.req.query("cursor")),
        limit: parsePositiveInt(c.req.query("limit"), 100, 500),
        agentId: c.req.query("agentId"),
        workspaceState: workspaceStateStore?.get(),
        archived,
      }),
    );
  });

  api.get("/sessions/archived", (c) => {
    const sessions = getEnrichedSessions(orchestrator, launcher, sessionNameStore);
    return c.json(
      getSessionListPage(sessions, {
        cursor: parseCursor(c.req.query("cursor")),
        limit: parsePositiveInt(c.req.query("limit"), 100, 500),
        workspaceState: workspaceStateStore?.get(),
        archived: true,
      }),
    );
  });

  api.get("/sessions/:id", (c) => {
    let id: string;
    try {
      id = requireSessionId(c.req.param("id"));
    } catch {
      return c.json({ error: "Invalid session id" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({
      ...session,
      lifecycleState: orchestrator.getLifecycleState(id),
      runtimeState: orchestrator.getRuntimeState(id),
    });
  });

  api.get("/sessions/:id/history", async (c) => {
    const id = requireSessionId(c.req.param("id"));
    const persisted = orchestrator.getPersistedSession(id);
    const sessionDir = orchestrator.getSessionDirectory(id);
    if (!persisted?.piSessionRelativePath || !sessionDir) {
      return c.json({ error: "Pi session history not found" }, 404);
    }
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    try {
      const page = await readPiSessionHistoryPage({
        sessionDir,
        piSessionRelativePath: persisted.piSessionRelativePath,
        expectedPiSessionId: id,
        expectedCwd: join(sessionDir, "workspace"),
        cursor: c.req.query("cursor"),
        limit,
      });
      return c.json({ sessionId: id, ...page });
    } catch (error) {
      if (error instanceof PiSessionHistoryError) {
        const status =
          error.code === "not_found" ? 404 : error.code === "invalid_cursor" ? 400 : 409;
        return c.json({ error: error.message, code: error.code }, status);
      }
      throw error;
    }
  });

  async function handleConfigureUserSpace(c: Context) {
    const id = c.req.param("id") || "";
    const contextAuthority = captureUserSpaceBrowserContext(
      wsBridge,
      id,
      c.req.header("X-Piwork-Context-Epoch"),
      c.req.header("X-Piwork-Context-Id"),
    );
    if (!contextAuthority) {
      return c.json({ error: "Stale browser runtime context" }, 409);
    }
    let body: { userSpace?: unknown; activeMountId?: unknown };
    try {
      const parsed: unknown = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.json({ error: "Invalid User Space configuration body" }, 400);
      }
      body = parsed as { userSpace?: unknown; activeMountId?: unknown };
    } catch {
      return c.json({ error: "Invalid User Space configuration body" }, 400);
    }
    const launchedSession = launcher.getSession(id);
    const bridgeSession = wsBridge.getSession(id);
    if (!launchedSession && !bridgeSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    const backend = bridgeSession?.state.backendType || launchedSession?.backendType || "pi";

    if (
      c.req.raw.signal.aborted ||
      !validateUserSpaceBrowserContext(wsBridge, id, contextAuthority)
    ) {
      return c.json({ error: "Stale browser runtime context" }, 409);
    }

    configureUserSpaceForSession(
      { backend, userSpace: body.userSpace, activeMountId: body.activeMountId },
      { sessionId: id },
      wsBridge,
      userSpaceBroker,
      port,
    );

    const sessionState = wsBridge.getSession(id)?.state;
    return c.json({
      user_space:
        sessionState?.userSpace ??
        publicUserSpaceFromMount(selectActiveUserSpaceMount(sessionState?.userSpaces || [])),
      user_spaces: sessionState?.userSpaces || [],
    });
  }

  api.post("/sessions/:id/user-space/configure", handleConfigureUserSpace);

  api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const name = body.name.trim();
    try {
      sessionNameStore.setName(id, name);
      orchestrator.markSessionNameManual(id);
      wsBridge.broadcastNameUpdate(id, name);
      return c.json({ ok: true, name });
    } catch (error) {
      return sessionNameMutationError(c, error);
    }
  });

  api.post("/sessions/:id/name/generate", async (c) => {
    const id = c.req.param("id");
    if (!launcher.getSession(id)) return c.json({ error: "Session not found" }, 404);
    try {
      const name = await orchestrator.generateSessionName(id);
      if (!name) return c.json({ error: "Session title could not be generated" }, 503);
      return c.json({ ok: true, name });
    } catch (error) {
      return sessionNameMutationError(c, error);
    }
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    userSpaceBroker?.revokeInternalCapability(id);
    const result = await orchestrator.killSession(id);
    if (!result.ok) return c.json({ error: "Session not found or already exited" }, 404);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = c.req.param("id");
    const result = await orchestrator.relaunchSession(id);
    if (!result.ok) {
      const status =
        result.status === 400 ||
        result.status === 403 ||
        result.status === 404 ||
        result.status === 409 ||
        result.status === 429 ||
        result.status === 503 ||
        result.status === 507
          ? result.status
          : result.error?.includes("not found") || result.error?.includes("Session not found")
            ? 404
            : 503;
      return c.json({ error: result.error || "Relaunch failed" }, status);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/activate", async (c) => {
    const id = c.req.param("id");
    const result = await orchestrator.activateSession(id);
    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          lifecycleState: result.lifecycleState,
          phase: result.phase,
          runtimeState: orchestrator.getRuntimeState(id),
        },
        result.status as any,
      );
    }
    return c.json({
      ok: true,
      session: result.session,
      lifecycleState: result.lifecycleState,
      phase: result.phase,
      runtimeState: orchestrator.getRuntimeState(id),
    });
  });

  api.delete("/sessions/:id", async (c) => {
    let id: string;
    try {
      id = requireSessionId(c.req.param("id"));
    } catch {
      return c.json({ error: "Invalid session id" }, 400);
    }
    const result = await orchestrator.hardDeleteSession(id);
    if (!result.ok) {
      return c.json({ error: result.error || "Session deletion was not committed" }, 409);
    }
    if (orchestrator.hasSessionData(id)) {
      return c.json({ error: "Failed to remove session data directory" }, 500);
    }
    userSpaceBroker?.removeSession(id);
    workspaceStateStore?.removeSession(id);
    return c.json({
      ok: true,
      removedSessionDir: result.removedSessionDir,
      removedRecordings: result.removedRecordings,
    });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    userSpaceBroker?.revokeInternalCapability(id);
    const result = await orchestrator.archiveSession(id);
    if (!result.ok) {
      return c.json({ error: result.error || "Session archive was not committed" }, 409);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    orchestrator.unarchiveSession(id);
    return c.json({ ok: true });
  });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    return c.json([
      {
        id: "pi",
        name: "Pi Agent",
        available: (options.providerVault?.modelCandidates().length ?? 0) > 0,
      },
    ]);
  });

  api.get("/backends/pi/models", async (c) => {
    const agentId = c.req.query("agentId")?.trim() || "";
    if (!agentId) return c.json({ error: "agentId is required" }, 400);
    if (!options.controlPlane || !options.launchBuilder) {
      return c.json({ error: "Pi model probe is unavailable" }, 503);
    }
    const current = getCurrentUserSnapshot(options);
    if (!current.tenantId) {
      return c.json({ error: "A tenant-bound Agent is required" }, 400);
    }
    try {
      const resolved = await options.controlPlane.resolveSessionAuthority(
        current.userId,
        current.tenantId,
        agentId,
      );
      const probe = await options.launchBuilder.probeModels(
        resolved.authority.agentDefinitionId,
        resolved.launch,
        c.req.raw.signal,
      );
      return c.json(
        probe.models.map((candidate) => ({
          model: {
            key: candidate.key,
            provider: candidate.provider,
            modelId: candidate.modelId,
          },
          label: candidate.name || candidate.key,
          thinkingLevels: supportedThinkingLevels(candidate),
        })),
      );
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 403);
    }
  });

  const currentUser = getCurrentUserSnapshot(options);
  const userRoot = currentUser.tenantId
    ? getTenantUserDataRoot(currentUser.tenantId, currentUser.uuid)
    : getUserDataRoot(currentUser.uuid);
  const skillsDir = currentUser.tenantId
    ? getTenantUserPiSkillsRoot(currentUser.tenantId, currentUser.uuid)
    : getUserPiSkillsRoot(currentUser.uuid);
  registerSkillRoutes(api, {
    skillsDir,
    diskQuota: options.diskQuota,
  });
  registerMetricsRoutes(api, { gaugeProvider: wsBridge });
  registerDiagnosticsRoutes(api, {
    launcher,
    gaugeProvider: wsBridge,
    recorder,
    runtimeStateProvider: orchestrator,
  });

  // ─── Recording Hub (hidden feature: PIWORK_RECORDING_HUB=1) ──────
  if (isRecordingHubEnabled()) {
    registerHubRoutes(api, {
      wsBridge,
      recordingsDir: recorder?.getRecordingsDir() ?? "",
      baseDir: join(userRoot, "recording-hub"),
      diskQuota: options.diskQuota,
    });
  }

  return api;
}

function sessionNameMutationError(c: Context, error: unknown) {
  const candidate = (error as { status?: unknown })?.status;
  const status = candidate === 400 || candidate === 507 ? candidate : 500;
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    status as 400 | 500 | 507,
  );
}
