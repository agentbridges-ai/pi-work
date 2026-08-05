import { installClipboardWriteFallback } from "./clipboard.js";

export type Route =
  | { page: "home"; userUuid?: string; agentId?: string }
  | { page: "session"; sessionId: string; userUuid?: string; agentId?: string }
  | { page: "rbacAdmin" }
  | { page: "apps" }
  | { page: "projectionLab" };

let clipboardFallbackInitialized = false;
let routeContext: RouteContext = {};

export interface RouteLocation {
  pathname: string;
  search?: string;
  hash?: string;
}

export interface RouteContext {
  userUuid?: string | null;
  agentId?: string | null;
}

function ensureClipboardFallbackInstalled(): void {
  if (clipboardFallbackInitialized) return;
  installClipboardWriteFallback();
  clipboardFallbackInitialized = true;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function getCurrentLocation(): RouteLocation {
  if (typeof window === "undefined") return { pathname: "/", search: "", hash: "" };
  return {
    pathname: window.location.pathname || "/",
    search: window.location.search || "",
    hash: window.location.hash || "",
  };
}

function dispatchRouteChange(): void {
  if (typeof window === "undefined") return;
  const event =
    typeof PopStateEvent === "function"
      ? new PopStateEvent("popstate", { state: history.state })
      : new Event("popstate");
  window.dispatchEvent(event);
}

function updateLocationPath(nextPath: string, replace: boolean): void {
  if (typeof window === "undefined") return;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentPath === nextPath) return;
  if (replace) {
    history.replaceState(null, "", nextPath);
  } else {
    history.pushState(null, "", nextPath);
  }
  dispatchRouteChange();
}

function normalizeContext(context?: RouteContext): Required<RouteContext> {
  const hasUserUuid = !!context && Object.prototype.hasOwnProperty.call(context, "userUuid");
  const hasAgentId = !!context && Object.prototype.hasOwnProperty.call(context, "agentId");
  return {
    userUuid: hasUserUuid ? context.userUuid || null : routeContext.userUuid || null,
    agentId: hasAgentId ? context.agentId || null : routeContext.agentId || null,
  };
}

export function setRouteContext(context: RouteContext): void {
  routeContext = { ...context };
}

function parsePath(pathname: string): Route {
  const path = pathname.split("?")[0] || "/";
  const segments = path.split("/").filter(Boolean).map(decodeSegment);

  if (segments.length === 0) return { page: "home" };

  if (segments[0] === "admin" && segments[1] === "rbac") {
    return { page: "rbacAdmin" };
  }

  if (segments.length === 1 && segments[0] === "apps") {
    return { page: "apps" };
  }
  if (import.meta.env.DEV && segments[0] === "lab" && segments[1] === "projection") {
    return { page: "projectionLab" };
  }

  if (segments[0] === "session" && segments[1]) {
    return { page: "session", sessionId: segments[1] };
  }

  if (segments.length >= 4 && segments[2] === "session" && segments[3]) {
    return {
      page: "session",
      userUuid: segments[0],
      agentId: segments[1],
      sessionId: segments[3],
    };
  }

  if (segments.length === 2 && segments[1]) {
    return { page: "home", userUuid: segments[0], agentId: segments[1] };
  }

  return { page: "home" };
}

function parseLegacyHash(hash: string): Route {
  void hash;
  return { page: "home" };
}

export function parseRoute(location: RouteLocation = getCurrentLocation()): Route {
  ensureClipboardFallbackInstalled();

  const pathRoute = parsePath(location.pathname || "/");
  if (pathRoute.page !== "home") return pathRoute;

  const hash = location.hash || "";
  if (hash && !hash.startsWith("#/session/")) return parseLegacyHash(hash);

  return pathRoute;
}

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  ensureClipboardFallbackInstalled();
  return parseLegacyHash(hash);
}

export function sessionPath(sessionId: string, context?: RouteContext): string {
  const { userUuid, agentId } = normalizeContext(context);
  if (userUuid && agentId) {
    return `/${encodeSegment(userUuid)}/${encodeSegment(agentId)}/session/${encodeSegment(sessionId)}`;
  }
  return `/session/${encodeSegment(sessionId)}`;
}

/**
 * Navigate to a session by updating the URL path.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateToSession(
  sessionId: string,
  replace = false,
  context?: RouteContext,
): void {
  ensureClipboardFallbackInstalled();

  const nextPath = sessionPath(sessionId, context);
  updateLocationPath(nextPath, replace);
}

/**
 * Navigate to the home page (no session selected) by updating the URL path.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateHome(replace = false, context?: RouteContext): void {
  ensureClipboardFallbackInstalled();

  const { userUuid, agentId } = normalizeContext(context);
  const nextPath =
    userUuid && agentId ? `/${encodeSegment(userUuid)}/${encodeSegment(agentId)}` : "/";
  updateLocationPath(nextPath, replace);
}

export function navigateRbacAdmin(replace = false): void {
  ensureClipboardFallbackInstalled();
  updateLocationPath("/admin/rbac", replace);
}

export function navigateApps(replace = false): void {
  ensureClipboardFallbackInstalled();
  updateLocationPath("/apps", replace);
}
