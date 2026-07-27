import type {
  AgentBrowserBridgeStatus,
  AgentBrowserVerification,
  AgentMode,
  BackendType,
  BrowserControlState,
  CreationProgressEvent,
  PiHistoryEntry,
  PiModelRef,
  PiSessionInfo,
  ThinkingLevel,
  UserSpaceMount,
} from "./types.js";
import type { AgentId } from "./agents.js";
import { captureEvent, captureException } from "./analytics.js";
import { authClient } from "./auth-client.js";
import { isAbortError, runtimeContextCoordinator } from "./runtime-context.js";
import { uiCopy } from "./ui-copy.js";
import type {
  ApiError as ApiErrorContract,
  ApiErrorCategory,
  ApiErrorResponse,
} from "../shared/api-contracts.js";

export type { CreationProgressEvent } from "./types.js";

const BASE = "/api";
const EXPECTED_TENANT_ID_HEADER = "X-Piwork-Tenant-Id";
const EXPECTED_MEMBERSHIP_ID_HEADER = "X-Piwork-Membership-Id";
const RUNTIME_CONTEXT_EPOCH_HEADER = "X-Piwork-Context-Epoch";
const RUNTIME_CONTEXT_ID_HEADER = "X-Piwork-Context-Id";

interface ExpectedTenantPrincipal {
  tenantId: string;
  membershipId: string;
}

let expectedTenantPrincipal: ExpectedTenantPrincipal | null = null;

export function setExpectedTenantRequestPrincipal(
  value: Pick<CurrentUser, "tenantId" | "membershipId"> | TenantMembership | null,
): void {
  const tenantId = value?.tenantId?.trim() || "";
  const membershipId =
    value && "membershipId" in value
      ? value.membershipId?.trim() || ""
      : value && "id" in value
        ? value.id.trim()
        : "";
  expectedTenantPrincipal = tenantId && membershipId ? { tenantId, membershipId } : null;
}

function sameExpectedTenantPrincipal(
  left: ExpectedTenantPrincipal | null,
  right: ExpectedTenantPrincipal | null,
): boolean {
  return left?.tenantId === right?.tenantId && left?.membershipId === right?.membershipId;
}

function expectedTenantHeaders(principal: ExpectedTenantPrincipal | null): Record<string, string> {
  return principal
    ? {
        [EXPECTED_TENANT_ID_HEADER]: principal.tenantId,
        [EXPECTED_MEMBERSHIP_ID_HEADER]: principal.membershipId,
      }
    : {};
}

function getAuthHeaders(): Record<string, string> {
  return {};
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** Context captured by the caller; defaults to the active runtime epoch. */
  contextEpoch?: number;
  /** Exact capability identifier paired with contextEpoch for authority-bearing requests. */
  contextId?: string;
}

export class ApiError extends Error implements ApiErrorContract {
  readonly category: ApiErrorCategory;
  readonly code: string;
  readonly status: number;
  readonly requestId: string;

  constructor(input: ApiErrorContract, options?: ErrorOptions) {
    super(input.message, options);
    this.name = "ApiError";
    this.category = input.category;
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
  }
}

interface RequestContextToken {
  epoch?: number;
  contextId?: string;
  userId?: string;
  tenantPrincipal: ExpectedTenantPrincipal | null;
}

function handle401(status: number, context: RequestContextToken): void {
  if (status === 401 && typeof window !== "undefined") {
    if (
      context.epoch !== undefined &&
      !runtimeContextCoordinator.isCurrent({ epoch: context.epoch })
    )
      return;
    // Dynamic import to avoid circular dependency
    import("./store.js")
      .then(({ useStore }) => {
        if (
          context.epoch !== undefined &&
          !runtimeContextCoordinator.isCurrent({ epoch: context.epoch })
        )
          return;
        const store = useStore.getState();
        const currentUserId = store.currentUser?.uuid || store.currentUser?.userId || "";
        if (context.userId !== undefined && currentUserId !== context.userId) return;
        if (!sameExpectedTenantPrincipal(context.tenantPrincipal, expectedTenantPrincipal)) return;
        setExpectedTenantRequestPrincipal(null);
        store.logout();
      })
      .catch(() => {});
  }
}

function captureRequestContext(
  epochOverride?: number,
  contextIdOverride?: string,
): RequestContextToken {
  const activeContext = runtimeContextCoordinator.current()?.context;
  const epoch = epochOverride ?? activeContext?.epoch;
  const contextId =
    contextIdOverride ??
    (activeContext && activeContext.epoch === epoch ? activeContext.contextId : undefined);
  return {
    epoch,
    ...(contextId !== undefined ? { contextId } : {}),
    tenantPrincipal: expectedTenantPrincipal ? { ...expectedTenantPrincipal } : null,
    ...(activeContext && activeContext.epoch === epoch ? { userId: activeContext.userId } : {}),
  };
}

function runtimeContextHeaders(
  options: ApiRequestOptions,
  context: RequestContextToken,
): Record<string, string> {
  if (options.contextEpoch === undefined) return {};
  return {
    [RUNTIME_CONTEXT_EPOCH_HEADER]: String(options.contextEpoch),
    ...(context.contextId !== undefined ? { [RUNTIME_CONTEXT_ID_HEADER]: context.contextId } : {}),
  };
}

function requireCurrentRuntimeContext(options: ApiRequestOptions = {}): ApiRequestOptions {
  const current = runtimeContextCoordinator.current()?.context;
  const contextEpoch = options.contextEpoch ?? current?.epoch;
  const contextId = options.contextId ?? current?.contextId;
  if (!current || contextEpoch !== current.epoch || contextId !== current.contextId) {
    throw new DOMException("Runtime context is stale", "AbortError");
  }
  return { ...options, contextEpoch, contextId };
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function trackApiSuccess(method: string, path: string, durationMs: number, status: number): void {
  captureEvent("api_request_succeeded", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
  });
}

function trackApiFailure(
  method: string,
  path: string,
  durationMs: number,
  error: unknown,
  status?: number,
): void {
  captureEvent("api_request_failed", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { method, path, status });
}

function defaultErrorCategory(status: number): ApiErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "validation";
  return "server";
}

function isApiErrorCategory(value: unknown): value is ApiErrorCategory {
  return (
    value === "auth" ||
    value === "forbidden" ||
    value === "validation" ||
    value === "not_found" ||
    value === "conflict" ||
    value === "network" ||
    value === "cancelled" ||
    value === "server"
  );
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  const payload = (await res.json().catch(() => null)) as unknown;
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const response = record as Partial<ApiErrorResponse> & Record<string, unknown>;
  const nested =
    response.error && typeof response.error === "object" && !Array.isArray(response.error)
      ? (record.error as Record<string, unknown>)
      : null;
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : res.statusText || "Request failed";
  const requestIdHeader =
    typeof res.headers?.get === "function"
      ? res.headers.get("x-request-id") || res.headers.get("request-id") || ""
      : "";
  return new ApiError({
    category: isApiErrorCategory(nested?.category)
      ? nested.category
      : isApiErrorCategory(record.category)
        ? record.category
        : defaultErrorCategory(res.status),
    code:
      typeof nested?.code === "string"
        ? nested.code
        : typeof record.code === "string"
          ? record.code
          : `http_${res.status}`,
    status: res.status,
    requestId:
      typeof nested?.requestId === "string"
        ? nested.requestId
        : typeof record.requestId === "string"
          ? record.requestId
          : requestIdHeader,
    message,
  });
}

function networkApiError(error: unknown): ApiError {
  return new ApiError(
    {
      category: "network",
      code: "network_error",
      status: 0,
      requestId: "",
      message: error instanceof Error ? error.message : "Network request failed",
    },
    error instanceof Error ? { cause: error } : undefined,
  );
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object,
  options: ApiRequestOptions = {},
): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  const requestContext = captureRequestContext(options.contextEpoch, options.contextId);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...runtimeContextHeaders(options, requestContext),
        ...expectedTenantHeaders(requestContext.tenantPrincipal),
        ...getAuthHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
    if (!res.ok) {
      handle401(res.status, requestContext);
      const apiError = await errorFromResponse(res);
      trackApiFailure(method, path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess(method, path, nowMs() - startedAt, res.status);
    return res.json() as Promise<T>;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (!failureTracked) {
      trackApiFailure(method, path, nowMs() - startedAt, error);
    }
    if (error instanceof ApiError) throw error;
    throw networkApiError(error);
  }
}

async function post<T = unknown>(
  path: string,
  body?: object,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>("POST", path, body, options);
}

async function get<T = unknown>(path: string, options?: ApiRequestOptions): Promise<T> {
  return request<T>("GET", path, undefined, options);
}

async function put<T = unknown>(
  path: string,
  body?: object,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>("PUT", path, body, options);
}

async function patch<T = unknown>(
  path: string,
  body?: object,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>("PATCH", path, body, options);
}

async function del<T = unknown>(
  path: string,
  body?: object,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>("DELETE", path, body, options);
}

export interface UserSpaceCreateMetadata {
  mountId: string;
  name: string;
  rootName: string;
  access: "readonly" | "readwrite";
  canRead?: boolean;
  canWrite?: boolean;
  permissionState?: PermissionState | "unknown";
  lastPermissionCheckedAt?: number;
  includeHidden: true;
  fileCount?: number;
  lastIndexedAt?: number;
}

export interface CreateSessionOpts {
  agentId: string;
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
  backend?: BackendType;
  userSpace?: UserSpaceCreateMetadata | UserSpaceCreateMetadata[] | null;
}

export interface BackendModelInfo {
  model: PiModelRef;
  label: string;
  description?: string;
  thinkingLevels: ThinkingLevel[];
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  children?: TreeNode[];
}

export interface AgentSpaceMetadata {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  mtime: number;
  sha256?: string;
}

export interface AgentSpaceTransferResult {
  ok: boolean;
  files: Array<{
    source: string;
    target: string;
    status: "ok" | "exists" | "error";
    size?: number;
    error?: string;
  }>;
}

export interface AgentSpaceMutationResult {
  ok: boolean;
  path: string;
  kind?: "file" | "directory";
  newPath?: string;
  size?: number;
  mtime?: number;
  sha256?: string;
}

export interface AgentSpaceMoveResult {
  ok: boolean;
  moves: Array<{
    path: string;
    newPath: string;
  }>;
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

// ─── SSE Session Creation ────────────────────────────────────────────────────

export interface CreateSessionStreamResult {
  sessionId: string;
  state: PiSessionInfo["state"];
  cwd: string;
  backendType: "pi";
  transport: "pi-rpc";
  model: PiModelRef;
  thinkingLevel: ThinkingLevel;
  mode: AgentMode;
  workspaceState?: WorkspaceSessionState;
}

const CREATE_SESSION_RESULT_KEYS = new Set([
  "sessionId",
  "state",
  "cwd",
  "backendType",
  "transport",
  "model",
  "thinkingLevel",
  "mode",
  "authority",
  "workspaceState",
]);
const CREATION_PROGRESS_KEYS = new Set(["step", "label", "status", "detail"]);
const SESSION_CREATE_ERROR_KEYS = new Set(["error"]);
const PI_MODEL_REF_KEYS = new Set(["key", "provider", "modelId"]);
const SESSION_AUTHORITY_KEYS = new Set([
  "tenantId",
  "userId",
  "agentDefinitionId",
  "agentVersionId",
  "effectivePolicyHash",
]);
const WORKSPACE_STATE_KEYS = new Set([
  "selectedAgentId",
  "currentSessionId",
  "agentSessionIds",
  "agentSessionHistoryIds",
  "agentUserSpaces",
  "updatedAt",
]);
const USER_SPACE_MOUNT_KEYS = new Set([
  "mountId",
  "name",
  "rootName",
  "status",
  "access",
  "canRead",
  "canWrite",
  "permissionState",
  "lastPermissionCheckedAt",
  "includeHidden",
  "fileCount",
  "lastIndexedAt",
]);
const SESSION_STATES = new Set<PiSessionInfo["state"]>([
  "starting",
  "connected",
  "running",
  "exited",
]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const AGENT_MODES = new Set<AgentMode>(["agent", "plan"]);
const CREATION_STEPS = new Set<CreationProgressEvent["step"]>([
  "resolving_env",
  "launching_pi",
  "restoring_history",
  "waiting_for_ready",
]);
const CREATION_STATUSES = new Set<CreationProgressEvent["status"]>([
  "in_progress",
  "done",
  "error",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function isSessionId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/u.test(value);
}

function isPiModelRef(value: unknown): value is PiModelRef {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, PI_MODEL_REF_KEYS) ||
    !isBoundedString(value.key, 2_048) ||
    !isBoundedString(value.provider, 512) ||
    !isBoundedString(value.modelId, 1_535)
  ) {
    return false;
  }
  return (
    !value.provider.includes("/") &&
    !value.modelId.startsWith("/") &&
    !value.modelId.endsWith("/") &&
    value.key === `${value.provider}/${value.modelId}`
  );
}

function isSessionAuthority(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, SESSION_AUTHORITY_KEYS) &&
    isBoundedString(value.tenantId, 1_024) &&
    isBoundedString(value.userId, 1_024) &&
    isBoundedString(value.agentDefinitionId, 1_024) &&
    isBoundedString(value.agentVersionId, 1_024) &&
    isBoundedString(value.effectivePolicyHash, 1_024)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUserSpaceMount(value: unknown): value is UserSpaceMount {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, USER_SPACE_MOUNT_KEYS) &&
    isBoundedString(value.mountId, 1_024) &&
    isBoundedString(value.name, 1_024) &&
    isBoundedString(value.rootName, 1_024) &&
    (value.status === "expected" || value.status === "mounted" || value.status === "offline") &&
    (value.access === "readonly" || value.access === "readwrite") &&
    (value.canRead === undefined || typeof value.canRead === "boolean") &&
    (value.canWrite === undefined || typeof value.canWrite === "boolean") &&
    (value.permissionState === undefined ||
      value.permissionState === "granted" ||
      value.permissionState === "denied" ||
      value.permissionState === "prompt" ||
      value.permissionState === "unknown") &&
    (value.lastPermissionCheckedAt === undefined ||
      isNonNegativeFiniteNumber(value.lastPermissionCheckedAt)) &&
    value.includeHidden === true &&
    (value.fileCount === undefined || isNonNegativeSafeInteger(value.fileCount)) &&
    (value.lastIndexedAt === undefined || isNonNegativeFiniteNumber(value.lastIndexedAt))
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(([key, entry]) => isBoundedString(key, 1_024) && isSessionId(entry))
  );
}

function isSessionHistoryRecord(value: unknown): value is Record<string, string[]> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([key, entries]) =>
        isBoundedString(key, 1_024) &&
        Array.isArray(entries) &&
        entries.every((entry) => isSessionId(entry)),
    )
  );
}

function isAgentUserSpaces(value: unknown): value is Record<AgentId, UserSpaceMount[]> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([key, mounts]) =>
        isBoundedString(key, 1_024) && Array.isArray(mounts) && mounts.every(isUserSpaceMount),
    )
  );
}

function parseWorkspaceSessionState(
  value: unknown,
  sessionId: string,
): WorkspaceSessionState | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, WORKSPACE_STATE_KEYS) ||
    !isBoundedString(value.selectedAgentId, 1_024) ||
    (value.currentSessionId !== null && !isSessionId(value.currentSessionId)) ||
    !isStringRecord(value.agentSessionIds) ||
    !isSessionHistoryRecord(value.agentSessionHistoryIds) ||
    (value.agentUserSpaces !== undefined && !isAgentUserSpaces(value.agentUserSpaces)) ||
    (value.updatedAt !== undefined && !isBoundedString(value.updatedAt, 1_024)) ||
    value.currentSessionId !== sessionId
  ) {
    throw new Error(uiCopy.piRuntime.invalidSessionCreateResponse);
  }

  return {
    selectedAgentId: value.selectedAgentId as AgentId,
    currentSessionId: value.currentSessionId,
    agentSessionIds: { ...value.agentSessionIds } as Record<AgentId, string>,
    agentSessionHistoryIds: Object.fromEntries(
      Object.entries(value.agentSessionHistoryIds).map(([key, entries]) => [key, [...entries]]),
    ) as Record<AgentId, string[]>,
    ...(value.agentUserSpaces
      ? {
          agentUserSpaces: Object.fromEntries(
            Object.entries(value.agentUserSpaces).map(([key, mounts]) => [
              key,
              mounts.map((mount) => ({ ...mount })),
            ]),
          ) as Record<AgentId, UserSpaceMount[]>,
        }
      : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
}

function parseCreationProgressEvent(value: unknown): CreationProgressEvent {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, CREATION_PROGRESS_KEYS) ||
    !CREATION_STEPS.has(value.step as CreationProgressEvent["step"]) ||
    !isBoundedString(value.label, 2_048) ||
    !CREATION_STATUSES.has(value.status as CreationProgressEvent["status"]) ||
    (value.detail !== undefined && !isBoundedString(value.detail, 4_096))
  ) {
    throw new Error(uiCopy.piRuntime.invalidSessionCreateResponse);
  }
  return {
    step: value.step as CreationProgressEvent["step"],
    label: value.label,
    status: value.status as CreationProgressEvent["status"],
    ...(value.detail ? { detail: value.detail } : {}),
  };
}

function parseSessionCreateError(value: unknown): string {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, SESSION_CREATE_ERROR_KEYS) ||
    !isBoundedString(value.error, 4_096)
  ) {
    throw new Error(uiCopy.piRuntime.sessionCreationFailed);
  }
  return value.error;
}

function parseCreateSessionStreamResult(value: unknown): CreateSessionStreamResult {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, CREATE_SESSION_RESULT_KEYS) ||
    !isSessionId(value.sessionId) ||
    !SESSION_STATES.has(value.state as PiSessionInfo["state"]) ||
    !isBoundedString(value.cwd, 4_096) ||
    !value.cwd.startsWith("/") ||
    value.backendType !== "pi" ||
    value.transport !== "pi-rpc" ||
    !isPiModelRef(value.model) ||
    !THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel) ||
    !AGENT_MODES.has(value.mode as AgentMode) ||
    (value.authority !== undefined && !isSessionAuthority(value.authority))
  ) {
    throw new Error(uiCopy.piRuntime.invalidSessionCreateResponse);
  }

  const workspaceState = parseWorkspaceSessionState(value.workspaceState, value.sessionId);
  return {
    sessionId: value.sessionId,
    state: value.state as PiSessionInfo["state"],
    cwd: value.cwd,
    backendType: "pi",
    transport: "pi-rpc",
    model: value.model,
    thinkingLevel: value.thinkingLevel as ThinkingLevel,
    mode: value.mode as AgentMode,
    ...(workspaceState ? { workspaceState } : {}),
  };
}

export interface ActivateSessionResponse {
  ok: true;
  session: PiSessionInfo;
  lifecycleState: "enabled" | "closed";
  phase: string | null;
}

export interface CurrentUser {
  userId: string;
  uuid?: string;
  username: string;
  displayName: string;
  orgId: string;
  orgName: string;
  roles: string[];
  email?: string;
  permissions?: string[];
  departments?: RbacPrincipalDepartment[];
  tenantId?: string;
  tenantName?: string;
  tenantType?: "enterprise" | "team" | "personal";
  membershipId?: string;
}

export interface TenantMembership {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType: "enterprise" | "team" | "personal";
  userId: string;
  status: "invited" | "active" | "suspended" | "removed";
  isDefault: boolean;
}

export interface GovernedAgent {
  id: string;
  tenantId: string;
  ownerMembershipId: string | null;
  kind: "enterprise_shared" | "team_shared" | "personal_custom" | "general";
  name: string;
  description: string;
  immutable: boolean;
  currentVersionId: string | null;
  draft: {
    instructions?: string;
    knowledgeRootIds: string[];
    skillPackageIds: string[];
    mcpConnectionIds: string[];
    networkPolicyId?: string;
    modelAllowlist: string[];
    defaultModel?: PiModelRef;
    defaultThinkingLevel: ThinkingLevel;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RbacPrincipalDepartment {
  id: string;
  name: string;
  parentId: string | null;
  primary: boolean;
}

export interface RbacPrincipal {
  userId: string;
  username: string;
  displayName: string;
  orgId: string;
  orgName: string;
  roles: string[];
  permissions: string[];
  departments: RbacPrincipalDepartment[];
}

export interface RbacDepartment {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  source: string;
  externalId: string | null;
  roleIds: string[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RbacRole {
  id: string;
  name: string;
  description: string;
  system: boolean;
  permissionKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RbacPermission {
  key: string;
  name: string;
  description: string;
  category: string;
}

export interface RbacUser {
  userId: string;
  username: string;
  displayName: string;
  email?: string;
  orgId: string;
  orgName: string;
  roleIds: string[];
  departmentIds: string[];
  primaryDepartmentId: string | null;
  permissions: string[];
  lastSeenAt: string;
}

export interface RbacSystemSettings {
  registrationEnabled: boolean;
}

export interface RbacAuditEntry {
  id: string;
  actorUserId: string;
  actorDisplayName?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RbacBootstrap {
  current: RbacPrincipal;
  departments: RbacDepartment[];
  roles: RbacRole[];
  permissions: RbacPermission[];
  users: RbacUser[];
  audit: RbacAuditEntry[];
  settings: RbacSystemSettings;
}

export interface RbacUserPage {
  users: RbacUser[];
  total: number;
  cursor: number;
  limit: number;
  nextCursor: number;
  hasMore: boolean;
}

export interface AuthModeResponse {
  mode: "better-auth" | "unsupported";
  runtimeMode: string;
  emailAndPassword?: boolean;
  signUpEnabled?: boolean;
}

export interface MeResponse {
  user: CurrentUser;
  runtimeMode: string;
}

export type FilePreviewPreference = "preview" | "alternate";
export type FilePreviewPreferenceKey = "html" | "markdown" | "word" | "ppt" | "excel";

export interface UserPreferences {
  filePreviewDefaults: Record<FilePreviewPreferenceKey, FilePreviewPreference>;
  userSpace: {
    showHiddenEntries: boolean;
    searchHiddenEntries: boolean;
  };
  updatedAt?: string;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  filePreviewDefaults: {
    html: "preview",
    markdown: "preview",
    word: "preview",
    ppt: "preview",
    excel: "preview",
  },
  userSpace: {
    showHiddenEntries: false,
    searchHiddenEntries: true,
  },
  updatedAt: "",
};

export interface WorkspaceSessionState {
  selectedAgentId: AgentId;
  currentSessionId: string | null;
  agentSessionIds: Record<AgentId, string>;
  agentSessionHistoryIds: Record<AgentId, string[]>;
  agentUserSpaces?: Record<AgentId, import("./types.js").UserSpaceMount[]>;
  updatedAt?: string;
}

export interface WorkspaceBootstrapResponse {
  user: CurrentUser;
  sessions: PiSessionInfo[];
  sessionsTotal?: number;
  sessionsHasMore?: boolean;
  workspaceState: WorkspaceSessionState;
}

export interface SessionListPage {
  sessions: PiSessionInfo[];
  total: number;
  cursor: number;
  nextCursor: number;
  hasMore: boolean;
  agentId?: string;
}

export interface SessionMessageHistoryPage {
  sessionId: string;
  totalEntries: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  entries: PiHistoryEntry[];
}

/**
 * Create a session with real-time progress streaming via SSE.
 * Uses fetch + ReadableStream (EventSource is GET-only, this is POST).
 */
export async function createSessionStream(
  opts: CreateSessionOpts | undefined,
  onProgress: (progress: CreationProgressEvent) => void,
  requestOptions: ApiRequestOptions = {},
): Promise<CreateSessionStreamResult> {
  const requestContext = captureRequestContext(
    requestOptions.contextEpoch,
    requestOptions.contextId,
  );
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...runtimeContextHeaders(requestOptions, requestContext),
      ...expectedTenantHeaders(requestContext.tenantPrincipal),
      ...getAuthHeaders(),
    },
    body: JSON.stringify(opts ?? {}),
    signal: requestOptions.signal,
  });

  if (!res.ok || !res.body) {
    handle401(res.status, requestContext);
    throw await errorFromResponse(res);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateSessionStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: split on double newlines
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error(
          eventType === "error"
            ? uiCopy.piRuntime.sessionCreationFailed
            : uiCopy.piRuntime.invalidSessionCreateResponse,
        );
      }
      if (eventType === "progress") {
        onProgress(parseCreationProgressEvent(parsed));
      } else if (eventType === "done") {
        if (result) throw new Error(uiCopy.piRuntime.invalidSessionCreateResponse);
        result = parseCreateSessionStreamResult(parsed);
      } else if (eventType === "error") {
        throw new Error(parseSessionCreateError(parsed));
      } else {
        throw new Error(uiCopy.piRuntime.invalidSessionCreateResponse);
      }
    }
  }

  if (!result) {
    throw new Error(uiCopy.piRuntime.sessionCreateStreamEnded);
  }

  return result;
}

export async function getAuthMode(options?: ApiRequestOptions): Promise<AuthModeResponse> {
  return get<AuthModeResponse>("/auth/mode", options);
}

export async function logoutSession(): Promise<void> {
  try {
    await authClient.signOut().catch(() => {});
  } finally {
    setExpectedTenantRequestPrincipal(null);
  }
}

export async function destroyWorkspaceAndLogout(): Promise<void> {
  await logoutSession();
}

export async function getMe(options?: ApiRequestOptions): Promise<MeResponse> {
  return get<MeResponse>("/me", options);
}

export const api = {
  // Auth
  getAuthMode,
  logoutSession,
  destroyWorkspaceAndLogout,
  getMe,
  completeOnboarding: (input: {
    type: "personal" | "team" | "enterprise";
    workspaceName?: string;
  }) =>
    post<{
      onboarding: {
        tenantId: string;
        tenantName: string;
        tenantType: "personal" | "team" | "enterprise";
        completed: true;
      };
    }>("/onboarding/complete", input),
  getTenants: () =>
    get<{ memberships: TenantMembership[]; active: TenantMembership | null }>("/tenants"),
  switchTenant: (tenantId: string) =>
    put<{ active: TenantMembership }>("/tenants/active", { tenantId }),
  listGovernedAgents: () =>
    get<{ agents: GovernedAgent[]; tenant: TenantMembership }>("/control-plane/agents"),
  updateGovernedAgentDraft: (id: string, draft: GovernedAgent["draft"]) =>
    put<{ agent: GovernedAgent }>(`/control-plane/agents/${encodeURIComponent(id)}/draft`, draft),
  publishGovernedAgent: (id: string) =>
    post<{ version: { id: string; version: number; effectivePolicyHash: string } }>(
      `/control-plane/agents/${encodeURIComponent(id)}/publish`,
      {},
    ),
  getPreferences: (options?: ApiRequestOptions) =>
    get<{ preferences: UserPreferences }>("/preferences", options),
  putPreferences: (preferences: UserPreferences, options?: ApiRequestOptions) =>
    put<{ preferences: UserPreferences }>("/preferences", { preferences }, options),
  getWorkspaceBootstrap: (options?: ApiRequestOptions) =>
    get<WorkspaceBootstrapResponse>("/workspace/bootstrap", options),
  getWorkspaceSessionState: (options?: ApiRequestOptions) =>
    get<WorkspaceSessionState>("/workspace/session-state", options),
  putWorkspaceSessionState: (state: WorkspaceSessionState, options?: ApiRequestOptions) =>
    put<WorkspaceSessionState>("/workspace/session-state", state, options),

  // Browser bridge
  getBrowserBridgeStatus: (options?: ApiRequestOptions) =>
    get<AgentBrowserBridgeStatus>("/browser-bridge/status", options),
  startBrowserBridge: (options?: ApiRequestOptions) =>
    post<AgentBrowserBridgeStatus>("/browser-bridge/start", undefined, options),
  verifyBrowserBridge: (options?: ApiRequestOptions) =>
    post<AgentBrowserVerification>("/browser-bridge/verify", undefined, options),
  getBrowserControl: (sessionId: string, options?: ApiRequestOptions) =>
    get<BrowserControlState>(`/sessions/${encodeURIComponent(sessionId)}/browser-control`, options),
  takeOverBrowserControl: (sessionId: string, options?: ApiRequestOptions) =>
    post<BrowserControlState>(
      `/sessions/${encodeURIComponent(sessionId)}/browser-control/takeover`,
      undefined,
      options,
    ),
  resumeBrowserControl: (sessionId: string, summary: string, options?: ApiRequestOptions) =>
    post<BrowserControlState>(
      `/sessions/${encodeURIComponent(sessionId)}/browser-control/resume`,
      { summary },
      options,
    ),
  stopBrowserControl: (sessionId: string, options?: ApiRequestOptions) =>
    post<BrowserControlState>(
      `/sessions/${encodeURIComponent(sessionId)}/browser-control/stop`,
      undefined,
      options,
    ),

  // RBAC
  getRbacBootstrap: () => get<RbacBootstrap>("/rbac/bootstrap"),
  listRbacUsers: (opts?: {
    cursor?: number;
    limit?: number;
    departmentId?: string | null;
    query?: string;
  }) => {
    const params = new URLSearchParams();
    params.set("cursor", String(Math.max(0, Math.floor(opts?.cursor ?? 0))));
    params.set("limit", String(Math.max(1, Math.floor(opts?.limit ?? 25))));
    if (opts?.departmentId && opts.departmentId !== "all")
      params.set("departmentId", opts.departmentId);
    if (opts?.query?.trim()) params.set("query", opts.query.trim());
    return get<RbacUserPage>(`/rbac/users?${params.toString()}`);
  },
  createRbacUser: (input: {
    displayName: string;
    email: string;
    password: string;
    departmentIds?: string[];
    roleIds?: string[];
  }) => post<{ user: RbacUser }>("/rbac/users", input),
  createRbacDepartment: (input: { name: string; parentId?: string | null; sortOrder?: number }) =>
    post<{ department: RbacDepartment }>("/rbac/departments", input),
  updateRbacDepartment: (
    id: string,
    input: { name?: string; parentId?: string | null; sortOrder?: number },
  ) => patch<{ department: RbacDepartment }>(`/rbac/departments/${encodeURIComponent(id)}`, input),
  deleteRbacDepartment: (id: string) =>
    del<{ ok: boolean }>(`/rbac/departments/${encodeURIComponent(id)}`),
  putRbacDepartmentRoles: (id: string, roleIds: string[]) =>
    put<{ ok: boolean }>(`/rbac/departments/${encodeURIComponent(id)}/roles`, { roleIds }),
  createRbacRole: (input: { name: string; description?: string }) =>
    post<{ role: RbacRole }>("/rbac/roles", input),
  updateRbacRole: (id: string, input: { name?: string; description?: string }) =>
    patch<{ role: RbacRole }>(`/rbac/roles/${encodeURIComponent(id)}`, input),
  deleteRbacRole: (id: string) => del<{ ok: boolean }>(`/rbac/roles/${encodeURIComponent(id)}`),
  putRbacRolePermissions: (id: string, permissionKeys: string[]) =>
    put<{ role: RbacRole }>(`/rbac/roles/${encodeURIComponent(id)}/permissions`, {
      permissionKeys,
    }),
  putRbacUserDepartments: (userId: string, departmentIds: string[]) =>
    put<{ ok: boolean }>(`/rbac/users/${encodeURIComponent(userId)}/departments`, {
      departmentIds,
    }),
  putRbacUserRoles: (userId: string, roleIds: string[]) =>
    put<{ ok: boolean }>(`/rbac/users/${encodeURIComponent(userId)}/roles`, { roleIds }),
  putRbacUserPassword: (userId: string, newPassword: string) =>
    put<{ ok: boolean }>(`/rbac/users/${encodeURIComponent(userId)}/password`, { newPassword }),
  getRbacAudit: () => get<{ audit: RbacAuditEntry[] }>("/rbac/audit"),
  putRbacSettings: (settings: Partial<RbacSystemSettings>) =>
    put<{ settings: RbacSystemSettings }>("/rbac/settings", settings),

  createSession: (opts?: CreateSessionOpts, options?: ApiRequestOptions) =>
    post<CreateSessionStreamResult>("/sessions/create", opts, options),

  configureUserSpace: async (
    sessionId: string,
    userSpace: UserSpaceCreateMetadata | UserSpaceCreateMetadata[] | null,
    activeMountId?: string,
    options?: ApiRequestOptions,
  ) => {
    const contextOptions = requireCurrentRuntimeContext(options);
    return await post<{
      user_space: import("./types.js").ActiveUserSpace | null;
      user_spaces: import("./types.js").UserSpaceMount[];
    }>(
      `/sessions/${encodeURIComponent(sessionId)}/user-space/configure`,
      {
        userSpace,
        ...(activeMountId ? { activeMountId } : {}),
      },
      contextOptions,
    );
  },

  listSessions: (options?: ApiRequestOptions) => get<PiSessionInfo[]>("/sessions", options),
  listSessionsPage: (opts?: { cursor?: number; limit?: number; agentId?: string }) => {
    const params = new URLSearchParams();
    params.set("cursor", String(Math.max(0, Math.floor(opts?.cursor ?? 0))));
    params.set("limit", String(Math.max(1, Math.floor(opts?.limit ?? 100))));
    if (opts?.agentId) params.set("agentId", opts.agentId);
    return get<SessionListPage>(`/sessions?${params.toString()}`);
  },
  getSession: (sessionId: string, options?: ApiRequestOptions) =>
    get<PiSessionInfo>(`/sessions/${encodeURIComponent(sessionId)}`, options),
  getSessionMessageHistory: (
    sessionId: string,
    opts?: { cursor?: string; limit?: number },
    requestOptions?: ApiRequestOptions,
  ) => {
    const limit = Math.max(1, Math.floor(opts?.limit ?? 200));
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts?.cursor) params.set("cursor", opts.cursor);
    return get<SessionMessageHistoryPage>(
      `/sessions/${encodeURIComponent(sessionId)}/history?${params.toString()}`,
      requestOptions,
    );
  },
  listArchivedSessions: (opts?: { cursor?: number; limit?: number }) => {
    const cursor = Math.max(0, Math.floor(opts?.cursor ?? 0));
    const limit = Math.max(1, Math.floor(opts?.limit ?? 100));
    return get<SessionListPage>(
      `/sessions/archived?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
    );
  },

  killSession: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) => del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  activateSession: (sessionId: string, options?: ApiRequestOptions) =>
    post<ActivateSessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/activate`,
      undefined,
      options,
    ),

  archiveSession: (sessionId: string) => post(`/sessions/${encodeURIComponent(sessionId)}/archive`),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(`/sessions/${encodeURIComponent(sessionId)}/name`, {
      name,
    }),

  generateSessionName: (sessionId: string) =>
    post<{ ok: boolean; name: string }>(`/sessions/${encodeURIComponent(sessionId)}/name/generate`),

  // Pi model probe
  getBackendModels: (agentId: string) =>
    get<BackendModelInfo[]>(`/backends/pi/models?agentId=${encodeURIComponent(agentId)}`),

  // Session-generated files and document outputs
  getAgentSpaceTree: (sessionId: string) =>
    get<{ path: string; rootName: "workspace"; tree: TreeNode[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/list?recursive=1`,
    ),
  readAgentSpaceFile: (sessionId: string, path: string) =>
    get<{ path: string; content: string; size: number; mtime: number; sha256: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/read?path=${encodeURIComponent(path)}`,
    ),
  getAgentSpaceMetadata: (sessionId: string, path: string) =>
    get<AgentSpaceMetadata>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/metadata?path=${encodeURIComponent(path)}`,
    ),
  getAgentSpaceBlob: async (
    sessionId: string,
    path: string,
  ): Promise<{ url: string; metadata: AgentSpaceMetadata }> => {
    const requestContext = captureRequestContext();
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/agent-space/raw?path=${encodeURIComponent(path)}`,
      {
        headers: {
          ...expectedTenantHeaders(requestContext.tenantPrincipal),
          ...getAuthHeaders(),
        },
      },
    );
    if (!res.ok) {
      handle401(res.status, requestContext);
      throw await errorFromResponse(res);
    }
    const blob = await res.blob();
    return {
      url: URL.createObjectURL(blob),
      metadata: {
        path,
        name: path.split("/").filter(Boolean).pop() || path,
        kind: "file",
        size: Number(res.headers.get("X-Piwork-Agent-Space-Size") || blob.size),
        mtime: Number(res.headers.get("X-Piwork-Agent-Space-Mtime") || 0),
        sha256: res.headers.get("X-Piwork-Agent-Space-Sha256") || undefined,
      },
    };
  },
  getAgentSpaceFile: async (
    sessionId: string,
    path: string,
  ): Promise<{ file: File; metadata: AgentSpaceMetadata }> => {
    const requestContext = captureRequestContext();
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/agent-space/raw?path=${encodeURIComponent(path)}`,
      {
        headers: {
          ...expectedTenantHeaders(requestContext.tenantPrincipal),
          ...getAuthHeaders(),
        },
      },
    );
    if (!res.ok) {
      handle401(res.status, requestContext);
      throw await errorFromResponse(res);
    }
    const blob = await res.blob();
    const metadata: AgentSpaceMetadata = {
      path,
      name: path.split("/").filter(Boolean).pop() || path,
      kind: "file",
      size: Number(res.headers.get("X-Piwork-Agent-Space-Size") || blob.size),
      mtime: Number(res.headers.get("X-Piwork-Agent-Space-Mtime") || 0),
      sha256: res.headers.get("X-Piwork-Agent-Space-Sha256") || undefined,
    };
    return {
      file: new File([blob], metadata.name, { type: blob.type || undefined }),
      metadata,
    };
  },
  writeAgentSpaceFile: (sessionId: string, path: string, content: string) =>
    put<{ ok: boolean; path: string; size: number; mtime: number; sha256: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/write`,
      { path, content },
    ),
  createAgentSpaceEntry: (
    sessionId: string,
    path: string,
    kind: "file" | "directory",
    content?: string,
  ) =>
    post<AgentSpaceMutationResult>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/create`,
      { path, kind, ...(content !== undefined ? { content } : {}) },
    ),
  deleteAgentSpaceEntry: (sessionId: string, path: string, recursive = false) =>
    del<AgentSpaceMutationResult>(`/sessions/${encodeURIComponent(sessionId)}/agent-space/delete`, {
      path,
      recursive,
    }),
  renameAgentSpaceEntry: (sessionId: string, path: string, newPath: string) =>
    post<AgentSpaceMutationResult>(
      `/sessions/${encodeURIComponent(sessionId)}/agent-space/rename`,
      { path, newPath },
    ),
  moveAgentSpaceEntries: (sessionId: string, paths: string[], targetDirPath: string) =>
    post<AgentSpaceMoveResult>(`/sessions/${encodeURIComponent(sessionId)}/agent-space/move`, {
      paths,
      targetDirPath,
    }),
  transferUserToAgent: (sessionId: string, path: string) =>
    post<AgentSpaceTransferResult>(
      `/sessions/${encodeURIComponent(sessionId)}/transfer/user-to-agent`,
      { path },
    ),
  transferAgentToUser: (sessionId: string, path: string) =>
    post<AgentSpaceTransferResult>(
      `/sessions/${encodeURIComponent(sessionId)}/transfer/agent-to-user`,
      { path },
    ),
  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Skills
  listSkills: () =>
    get<{ slug: string; name: string; description: string; path: string }[]>("/skills"),
};
