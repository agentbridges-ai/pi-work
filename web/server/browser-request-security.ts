import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";
import { ENV, environment } from "./environment.js";
import type { AuthenticatedUser } from "./auth-types.js";
import { releaseReaderLockBestEffort } from "./web-stream-compat.js";

const MEBIBYTE = 1024 * 1024;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const USER_SPACE_UPLOAD_PATH = /^\/api\/user-space-transfer\/[^/]+\/blob\/checkout\/[^/]+\/upload$/;
const AGENT_SPACE_RAW_WRITE_PATH = /^\/api\/sessions\/[^/]+\/agent-space\/raw$/;
const NATIVE_FILE_ACTION_UPLOAD_PATH = /^\/api\/sessions\/[^/]+\/native-file-actions$/;

export const JSON_REQUEST_BODY_LIMIT_BYTES = MEBIBYTE;
export const USER_SPACE_BINARY_BODY_LIMIT_BYTES = 100 * MEBIBYTE;
export const HUB_UPLOAD_BODY_LIMIT_BYTES = 50 * MEBIBYTE;
export const EXPECTED_TENANT_ID_HEADER = "X-Piwork-Tenant-Id";
export const EXPECTED_MEMBERSHIP_ID_HEADER = "X-Piwork-Membership-Id";

export interface TrustedBrowserOriginInputs {
  betterAuthUrl?: string;
  apiPort: number;
  vitePort: number;
  includeDevelopmentOrigins: boolean;
}

export interface CookieApiSecurityLimits {
  jsonBytes: number;
  userSpaceBinaryBytes: number;
  hubUploadBytes: number;
}

export interface CookieApiSecurityOptions {
  trustedOrigins: readonly string[];
  limits?: Partial<CookieApiSecurityLimits>;
}

export type SecuredCookieApiRequest =
  { ok: true; request: Request } | { ok: false; response: Response };

export type CookieApiAuthenticationCheck = { ok: true } | { ok: false; response: Response };

export type TenantBoundRuntimePrincipal =
  { ok: true; user: AuthenticatedUser } | { ok: false; response: Response };

export interface TenantBoundRuntimePrincipalOptions {
  /** Existing session/capability owner, resolved server-side rather than from a browser header. */
  resourcePrincipal?: AuthenticatedUser | null;
}

interface BodyPolicy {
  kind: "json" | "better-auth" | "user-space-binary" | "hub-upload";
  maxBytes: number;
}

type CookieApiRequestPreflight =
  | {
      ok: true;
      passthrough: true;
    }
  | {
      ok: true;
      passthrough: false;
      hasBody: boolean;
      policy: BodyPolicy;
      type: string | null;
    }
  | { ok: false; response: Response };

const DEFAULT_LIMITS: CookieApiSecurityLimits = {
  jsonBytes: JSON_REQUEST_BODY_LIMIT_BYTES,
  userSpaceBinaryBytes: USER_SPACE_BINARY_BODY_LIMIT_BYTES,
  hubUploadBytes: HUB_UPLOAD_BODY_LIMIT_BYTES,
};

function normalizeHttpOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed.includes(",")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Build the complete, exact browser Origin allowlist used by API, WS, and Better Auth. */
export function buildTrustedBrowserOrigins(inputs: TrustedBrowserOriginInputs): string[] {
  const candidates = [inputs.betterAuthUrl];
  if (inputs.includeDevelopmentOrigins || !inputs.betterAuthUrl) {
    candidates.push(`http://127.0.0.1:${inputs.apiPort}`, `http://localhost:${inputs.apiPort}`);
  }
  if (inputs.includeDevelopmentOrigins) {
    candidates.push(`http://127.0.0.1:${inputs.vitePort}`, `http://localhost:${inputs.vitePort}`);
  }

  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const origin = normalizeHttpOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

export function trustedBrowserOrigins(): string[] {
  const defaultApiPort = environment.isProduction ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
  return buildTrustedBrowserOrigins({
    betterAuthUrl: environment.optionalString(ENV.BETTER_AUTH_URL, false)?.trim(),
    apiPort: environment.number(ENV.PORT, defaultApiPort),
    vitePort: environment.number(ENV.VITE_PORT, 3458),
    includeDevelopmentOrigins: !environment.isProduction,
  });
}

/** Browser WebSocket handshakes and unsafe Cookie API requests always require Origin. */
export function requestOriginAllowed(request: Request, trustedOrigins: readonly string[]): boolean {
  const origin = normalizeHttpOrigin(request.headers.get("origin") || "");
  if (!origin) return false;
  return trustedOrigins.some((candidate) => normalizeHttpOrigin(candidate) === origin);
}

export function isUnsafeHttpMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

function tenantContextConflict(): Response {
  return Response.json(
    {
      category: "conflict",
      code: "tenant_context_conflict",
      status: 409,
      message: "The active tenant changed before this request was received.",
    },
    {
      status: 409,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}

function allowsMissingTenantBinding(request: Request): boolean {
  const url = new URL(request.url);
  return (
    (request.method === "POST" && url.pathname === "/api/onboarding/complete") ||
    (request.method === "GET" &&
      (url.pathname === "/api/cloudflare/oauth/callback" ||
        url.pathname === "/api/apps/cloudflare/oauth/callback"))
  );
}

/**
 * Bind one Cookie API request to the exact active membership captured by the
 * browser. Header values are correlation inputs only: the live Better Auth
 * user and membership-backed resolver remain the authorization source.
 */
export async function resolveTenantBoundRuntimePrincipal(
  request: Request,
  authenticatedUser: AuthenticatedUser,
  resolveActiveUser: (user: AuthenticatedUser) => Promise<AuthenticatedUser>,
  options: TenantBoundRuntimePrincipalOptions = {},
): Promise<TenantBoundRuntimePrincipal> {
  const activeUser = await resolveActiveUser(authenticatedUser);
  if (
    activeUser.userId !== authenticatedUser.userId ||
    (authenticatedUser.uuid && activeUser.uuid !== authenticatedUser.uuid)
  ) {
    return { ok: false, response: jsonError(401, "Authenticated user changed") };
  }

  const tenantId = request.headers.get(EXPECTED_TENANT_ID_HEADER)?.trim() || "";
  const membershipId = request.headers.get(EXPECTED_MEMBERSHIP_ID_HEADER)?.trim() || "";
  if (!tenantId && !membershipId && allowsMissingTenantBinding(request)) {
    return { ok: true, user: activeUser };
  }

  const resourcePrincipal = options.resourcePrincipal;
  if (!tenantId && !membershipId && resourcePrincipal) {
    if (
      resourcePrincipal.userId !== authenticatedUser.userId ||
      resourcePrincipal.tenantId !== activeUser.tenantId ||
      resourcePrincipal.membershipId !== activeUser.membershipId
    ) {
      return { ok: false, response: tenantContextConflict() };
    }
    return { ok: true, user: activeUser };
  }

  if (
    !tenantId ||
    tenantId.length > 128 ||
    !membershipId ||
    membershipId.length > 240 ||
    activeUser.tenantId !== tenantId ||
    activeUser.membershipId !== membershipId
  ) {
    return { ok: false, response: tenantContextConflict() };
  }
  return { ok: true, user: activeUser };
}

function mediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  const value = contentType.split(";", 1)[0]?.trim().toLowerCase() || "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : null;
}

function isJsonMediaType(value: string | null): boolean {
  return (
    value === "application/json" ||
    (value !== null && /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(value))
  );
}

function bodyPolicy(pathname: string, method: string, limits: CookieApiSecurityLimits): BodyPolicy {
  if (
    (method === "PUT" &&
      (USER_SPACE_UPLOAD_PATH.test(pathname) || AGENT_SPACE_RAW_WRITE_PATH.test(pathname))) ||
    (method === "POST" && NATIVE_FILE_ACTION_UPLOAD_PATH.test(pathname))
  ) {
    return { kind: "user-space-binary", maxBytes: limits.userSpaceBinaryBytes };
  }
  if (method === "POST" && pathname === "/api/hub/recordings/upload") {
    return { kind: "hub-upload", maxBytes: limits.hubUploadBytes };
  }
  if (pathname.startsWith("/api/auth/")) {
    return { kind: "better-auth", maxBytes: limits.jsonBytes };
  }
  return { kind: "json", maxBytes: limits.jsonBytes };
}

function contentTypeAllowed(policy: BodyPolicy, value: string | null): boolean {
  if (policy.kind === "json") return isJsonMediaType(value);
  if (policy.kind === "better-auth") {
    return isJsonMediaType(value) || value === "application/x-www-form-urlencoded";
  }
  if (policy.kind === "hub-upload") {
    return value === "text/plain" || value === "multipart/form-data";
  }
  return value !== null;
}

function contentLength(request: Request): bigint | null | Response {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return jsonError(400, "Invalid Content-Length header");
  try {
    return BigInt(trimmed);
  } catch {
    return jsonError(400, "Invalid Content-Length header");
  }
}

async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | Response> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("Request body is too large").catch(() => undefined);
        return jsonError(413, `Request body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } catch {
    return jsonError(400, "Invalid request body");
  } finally {
    releaseReaderLockBestEffort(reader);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function reconstructedRequest(request: Request, body: Uint8Array<ArrayBuffer>): Request | Response {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  try {
    return new Request(request, { body, headers });
  } catch {
    return jsonError(400, "Invalid request body");
  }
}

function preflightCookieApiRequest(
  request: Request,
  options: CookieApiSecurityOptions,
): CookieApiRequestPreflight {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return { ok: true, passthrough: true };

  if (
    isUnsafeHttpMethod(request.method) &&
    !requestOriginAllowed(request, options.trustedOrigins)
  ) {
    return { ok: false, response: jsonError(403, "Request Origin is not allowed") };
  }

  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const policy = bodyPolicy(url.pathname, request.method.toUpperCase(), limits);
  const declaredLength = contentLength(request);
  if (declaredLength instanceof Response) return { ok: false, response: declaredLength };
  if (declaredLength !== null && declaredLength > BigInt(policy.maxBytes)) {
    return {
      ok: false,
      response: jsonError(413, `Request body exceeds the ${policy.maxBytes}-byte limit`),
    };
  }

  const hasBody = request.body !== null || (declaredLength !== null && declaredLength > 0n);
  const type = mediaType(request.headers.get("content-type"));
  if (hasBody && !contentTypeAllowed(policy, type)) {
    return { ok: false, response: jsonError(415, "Unsupported Content-Type") };
  }

  return { ok: true, passthrough: false, hasBody, policy, type };
}

async function bufferPreflightedCookieApiRequest(
  request: Request,
  preflight: Exclude<CookieApiRequestPreflight, { ok: false }>,
): Promise<SecuredCookieApiRequest> {
  if (preflight.passthrough || !preflight.hasBody) return { ok: true, request };

  const body = await readBody(request, preflight.policy.maxBytes);
  if (body instanceof Response) return { ok: false, response: body };

  if (
    (preflight.policy.kind === "json" || preflight.policy.kind === "better-auth") &&
    isJsonMediaType(preflight.type)
  ) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      JSON.parse(text);
    } catch {
      return { ok: false, response: jsonError(400, "Invalid JSON body") };
    }
  }

  const nextRequest = reconstructedRequest(request, body);
  return nextRequest instanceof Response
    ? { ok: false, response: nextRequest }
    : { ok: true, request: nextRequest };
}

/**
 * Validate an outer Cookie API request and, when it has a body, return a fresh
 * Request so existing downstream `req.json()`, `text()`, and `formData()` calls
 * can consume it normally.
 */
export async function secureCookieApiRequest(
  request: Request,
  options: CookieApiSecurityOptions,
): Promise<SecuredCookieApiRequest> {
  const preflight = preflightCookieApiRequest(request, options);
  if (!preflight.ok) return preflight;
  return bufferPreflightedCookieApiRequest(request, preflight);
}

/**
 * Apply cheap request-policy checks, authenticate without touching the body,
 * and only then buffer and validate it. Public Better Auth endpoints must use
 * `secureCookieApiRequest` directly because they intentionally have no session
 * yet. Callers should revalidate authentication after a potentially slow body
 * finishes so session revocation during upload remains fail-closed.
 */
export async function secureAuthenticatedCookieApiRequest(
  request: Request,
  options: CookieApiSecurityOptions,
  authenticate: (request: Request) => Promise<CookieApiAuthenticationCheck>,
): Promise<SecuredCookieApiRequest> {
  const preflight = preflightCookieApiRequest(request, options);
  if (!preflight.ok) return preflight;

  const authentication = await authenticate(request);
  if (!authentication.ok) return authentication;

  return bufferPreflightedCookieApiRequest(request, preflight);
}
