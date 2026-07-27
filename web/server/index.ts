import { ENV, environment } from "./environment.js";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
environment.set(ENV.PATH, getEnrichedPath());

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import {
  requestOriginAllowed,
  resolveTenantBoundRuntimePrincipal,
  secureAuthenticatedCookieApiRequest,
  secureCookieApiRequest,
  trustedBrowserOrigins,
  USER_SPACE_BINARY_BODY_LIMIT_BYTES,
} from "./browser-request-security.js";
import { cacheControlMiddleware } from "./cache-headers.js";
import { initLogFile, closeLogFile } from "./logger.js";
import { acquireRunnerLock } from "./runner-lock.js";
import { getBuildInfo } from "./build-info.js";
import {
  resolveOnlyOfficeFontAssetsDir,
  resolveOnlyOfficeGeneratedFontAsset,
} from "./onlyoffice-font-assets.js";
import {
  applyOnlyOfficeHostResponseHeaders,
  contentTypeForOnlyOfficeAsset,
  isOnlyOfficeBrowserAssetPath,
  isOnlyOfficeHostRequestHost,
  isOnlyOfficePrintPdfPath,
} from "./onlyoffice-runtime-assets.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";
import {
  ensureInternalFileTransportCertificate,
  INTERNAL_FILE_TRANSPORT_HOST,
  startInternalFileConnectProxy,
  type InternalFileConnectProxy,
} from "./internal-file-transport.js";
import { LocalAuth } from "./local-auth.js";
import {
  LocalRuntimeRegistry,
  type LocalRuntimeRegistryOptions,
} from "./local-runtime-registry.js";
import { assertBetterAuthDatabaseConfigured, checkBetterAuthDatabaseReady } from "./better-auth.js";
import { RbacService } from "./rbac-service.js";
import { ControlPlaneService } from "./control-plane-service.js";
import { EmbeddedTenantRuntimeDriver } from "./tenant-runtime-driver.js";
import { getLocalDataRoot } from "./local-paths.js";
import { livenessResponse, readinessResponse } from "./health.js";
import { isRuntimeContextId, WS_PROTOCOL_VERSION } from "../shared/api-contracts.js";
import { resolvePwaAssetPolicy } from "./pwa-assets.js";
import { assertSecureNetworkExposure, isLoopbackHost } from "./network-security.js";
import { socketAuthorizationMatches, startPeriodicSocketAuthorization } from "./websocket-auth.js";
import { websocketTransportLimits } from "./websocket-transport.js";
import { AgentBrowserBridgeService } from "./agent-browser-bridge-service.js";
import { reapStaleAgentBrowserSocketDirs } from "./agent-browser-runtime.js";
import {
  assertSupportedNodeVersion,
  resolvePinnedPiRuntime,
  resolvePinnedSrtRuntime,
} from "./pi-runtime-resolver.js";
import { loadPiProviderBootstrapFromInheritedFd, PiProviderVault } from "./pi-provider-vault.js";
import { ensurePiRuntimeLayout } from "./pi-runtime-layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = environment.packageRoot || resolve(__dirname, "..");
const repoRoot = resolve(packageRoot, "..");
const bundledFrontendDistDir = resolve(packageRoot, "dist");
const frontendPublicDir = resolve(packageRoot, "public");
const configuredOnlyOfficeBrowserDir = environment
  .optionalString(ENV.PIWORK_ONLYOFFICE_BROWSER_DIR, false)
  ?.trim();
const defaultOnlyOfficeBrowserDir = configuredOnlyOfficeBrowserDir
  ? resolve(configuredOnlyOfficeBrowserDir)
  : resolve(repoRoot, "onlyoffice-browser");
const defaultOnlyOfficeBrowserPublicDir = resolve(defaultOnlyOfficeBrowserDir, "dist");
const configuredOnlyOfficeBrowserPublicDir = environment
  .optionalString(ENV.PIWORK_ONLYOFFICE_BROWSER_PUBLIC_DIR, false)
  ?.trim();
const onlyOfficeBrowserPublicDir =
  configuredOnlyOfficeBrowserPublicDir ||
  (existsSync(defaultOnlyOfficeBrowserPublicDir) ? defaultOnlyOfficeBrowserPublicDir : "");
const onlyOfficeFontAssetsDir = resolveOnlyOfficeFontAssetsDir();
const onlyOfficeBrowserAssetBase =
  environment.optionalString(ENV.PIWORK_ONLYOFFICE_BROWSER_ASSET_BASE) || "";
import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = environment.isProduction ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = environment.number(ENV.PORT, defaultPort);
const host = environment.host;
const browserOriginAllowlist = trustedBrowserOrigins();
const servesBundledFrontend = environment.value(ENV.PIWORK_SERVE_FRONTEND) !== "0";
const dataRoot = getLocalDataRoot();
// This initializes only an empty/new root. A non-empty pre-Pi root fails
// closed and requires the explicit, confirmed reset command.
ensurePiRuntimeLayout(dataRoot);
assertSupportedNodeVersion();
const piRuntimeAvailable = (() => {
  try {
    resolvePinnedPiRuntime();
    resolvePinnedSrtRuntime();
    return true;
  } catch {
    return false;
  }
})();
const providerVault = new PiProviderVault(loadPiProviderBootstrapFromInheritedFd());
assertBetterAuthDatabaseConfigured();
const rbacService = new RbacService();
if (!isLoopbackHost(host)) {
  let registrationEnabled: boolean;
  try {
    registrationEnabled = await rbacService.isRegistrationEnabled();
  } catch (error) {
    throw new Error("Cannot verify registration policy for a non-loopback listener", {
      cause: error,
    });
  }
  assertSecureNetworkExposure({
    host,
    publicOrigin: environment.optionalString(ENV.BETTER_AUTH_URL, false)?.trim(),
    registrationEnabled,
    sessionSandbox: environment.value(ENV.PIWORK_SESSION_SANDBOX),
    requireSessionSandbox: environment.flag(ENV.PIWORK_REQUIRE_SESSION_SANDBOX),
  });
}
const controlPlaneService = new ControlPlaneService();
const runtimeDriver = new EmbeddedTenantRuntimeDriver(new URL(`http://127.0.0.1:${port}`));
const localAuth = new LocalAuth(rbacService, withActiveTenant, host);
const reapedAgentBrowserSocketDirs = reapStaleAgentBrowserSocketDirs();
if (reapedAgentBrowserSocketDirs > 0) {
  console.log(`[agent-browser] Reaped ${reapedAgentBrowserSocketDirs} stale socket directories`);
}
const agentBrowserBridge = new AgentBrowserBridgeService();
const internalRuntimeDir = join(dataRoot, ".runtime");
mkdirSync(internalRuntimeDir, { recursive: true, mode: 0o700 });
if (realpathSync(internalRuntimeDir) !== internalRuntimeDir) {
  throw new Error("Internal runtime directory must not be a symbolic link");
}
chmodSync(internalRuntimeDir, 0o700);
// Unix-domain socket paths are capped at roughly 104-108 bytes. Keep a
// 96-bit nonce while leaving enough room for ordinary absolute data roots.
const protectedTransport: NonNullable<LocalRuntimeRegistryOptions["internalTransport"]> = {};
const runtimeRegistry = new LocalRuntimeRegistry(
  port,
  rbacService,
  controlPlaneService,
  runtimeDriver,
  agentBrowserBridge,
  {
    providerVault,
    internalTransport: protectedTransport,
    dataRoot,
  },
);
agentBrowserBridge.setControlEventHandler((event) =>
  runtimeRegistry.handleAgentBrowserControlEvent(event).then((handled) => {
    if (!handled) {
      console.warn(
        `[agent-browser] Ignored control event for unknown owner session ${event.ownerSessionId}`,
      );
    }
  }),
);
controlPlaneService.setMembershipRevoker((tenantId, userId) =>
  runtimeRegistry.revokePrincipal(tenantId, userId),
);
controlPlaneService.setMembershipActivator((tenantId, userId) =>
  runtimeRegistry.activatePrincipal(tenantId, userId),
);
const runnerLock = acquireRunnerLock();
const buildInfo = getBuildInfo(packageRoot);
const personalTenantInitialization = new Map<string, Promise<void>>();

async function ensurePersonalTenantInitialized(
  user: import("./auth-types.js").AuthenticatedUser,
): Promise<void> {
  let pending = personalTenantInitialization.get(user.userId);
  if (!pending) {
    pending = controlPlaneService
      .ensurePersonalTenant(user.userId, user.displayName)
      .then(() => undefined)
      .catch((error) => {
        personalTenantInitialization.delete(user.userId);
        throw error;
      });
    personalTenantInitialization.set(user.userId, pending);
  }
  await pending;
}

async function withActiveTenant(user: import("./auth-types.js").AuthenticatedUser) {
  await controlPlaneService.syncLegacySystemAdmin(
    user.userId,
    user.permissions?.includes("admin:access") === true,
  );
  let active = await controlPlaneService.getActiveMembership(user.userId);
  if (!active) {
    await ensurePersonalTenantInitialized(user);
    active = await controlPlaneService.getActiveMembership(user.userId);
  } else if (active.tenantType === "personal") {
    await ensurePersonalTenantInitialized(user);
  }
  if (!active) throw new Error("Active tenant initialization did not become visible.");
  return {
    ...user,
    tenantId: active.tenantId,
    tenantName: active.tenantName,
    tenantType: active.tenantType,
    membershipId: active.id,
    // Compatibility fields for existing UI while tenant-aware APIs replace them.
    orgId: active.tenantId,
    orgName: active.tenantName,
  };
}

function runtimeResourcePrincipal(request: Request) {
  const pathname = new URL(request.url).pathname;
  const sessionId =
    pathname.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/|$)/i)?.[1] ||
    pathname.match(/^\/api\/user-space-transfer\/([a-f0-9-]+)(?:\/|$)/i)?.[1];
  return sessionId ? runtimeRegistry.getRuntimeForSession(sessionId)?.user || null : null;
}

console.log("[server] Native Pi + Better Auth + Postgres runtime enabled");

// ── Log file persistence — writes all log output to ~/.piwork/logs/ ───────
const logFileWriter = initLogFile();
if (logFileWriter) {
  console.log(
    `[server] Log file enabled (dir: ${logFileWriter.getLogsDir()}, max: ${logFileWriter.getMaxLines()} lines, file: ${logFileWriter.filePath})`,
  );
}

const app = new Hono();
let internalFileTransportAvailable = false;
const WS_AUTH_REVALIDATE_MS = 5_000;
const wsAuthTimers = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setInterval>>();
const wsAuthChecks = new WeakMap<ServerWebSocket<SocketData>, Promise<boolean>>();

async function validateAuthenticatedSocket(ws: ServerWebSocket<SocketData>): Promise<boolean> {
  const existing = wsAuthChecks.get(ws);
  if (existing) return existing;
  const check = (async () => {
    const data = ws.data;
    if (data.kind !== "browser") return true;
    if (!data.authUserId || !data.authTenantId) return false;
    const headers = new Headers();
    if (data.authCookie) headers.set("cookie", data.authCookie);
    if (data.authAuthorization) headers.set("authorization", data.authAuthorization);
    const identity = await localAuth.getSessionUser(headers);
    if (!identity) return false;
    const activeMembership = await controlPlaneService.getActiveMembership(identity.userId);

    const runtimeLease = runtimeRegistry.acquireSession(data.sessionId);
    if (!runtimeLease) return false;
    try {
      const runtime = runtimeLease.runtime;
      let authorityActive = true;
      const authority = runtime.wsBridge.getSession(data.sessionId)?.authority;
      if (
        authority &&
        (authority.userId !== data.authUserId || authority.tenantId !== data.authTenantId)
      ) {
        return false;
      }
      authorityActive = authority
        ? await controlPlaneService.isSessionAuthorityActive(authority)
        : true;
      if (
        !socketAuthorizationMatches(
          { userId: data.authUserId, tenantId: data.authTenantId },
          {
            identityUserId: identity.userId,
            activeTenantId: activeMembership?.tenantId || null,
            runtimeUserId: runtime.user.uuid,
            runtimeTenantId: runtime.user.tenantId || null,
            authorityActive,
          },
        )
      )
        return false;
      data.authValidatedAt = Date.now();
      return true;
    } finally {
      runtimeLease.release();
    }
  })()
    .catch(() => false)
    .finally(() => wsAuthChecks.delete(ws));
  wsAuthChecks.set(ws, check);
  return check;
}

function closeUnauthorizedSocket(ws: ServerWebSocket<SocketData>): void {
  try {
    ws.close(1008, "Authentication or authorization expired");
  } catch {}
}

function startSocketAuthRevalidation(ws: ServerWebSocket<SocketData>): void {
  if (ws.data.kind !== "browser") return;
  const timer = startPeriodicSocketAuthorization(
    () => validateAuthenticatedSocket(ws),
    () => closeUnauthorizedSocket(ws),
    WS_AUTH_REVALIDATE_MS,
  );
  wsAuthTimers.set(ws, timer);
}

function stopSocketAuthRevalidation(ws: ServerWebSocket<SocketData>): void {
  const timer = wsAuthTimers.get(ws);
  if (timer) clearInterval(timer);
  wsAuthTimers.delete(ws);
}

// ── Health endpoint — always unauthenticated (used by Fly.io + control plane) ─
const startTime = Date.now();
app.get("/health", (c) => {
  return c.json({
    ...livenessResponse(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

app.get("/health/live", (c) => c.json(livenessResponse()));

app.get("/build-info", (c) => {
  c.header("Cache-Control", "no-store, max-age=0");
  return c.json(buildInfo);
});

function isPiworkOnlyOfficeBrowserAssetPath(pathname: string): boolean {
  return isOnlyOfficeBrowserAssetPath(pathname, {
    assetBaseConfigured: Boolean(onlyOfficeBrowserAssetBase),
    localAssetRoots: [bundledFrontendDistDir, frontendPublicDir, onlyOfficeBrowserPublicDir],
  });
}

async function serveOnlyOfficeBrowserAsset(pathname: string): Promise<Response> {
  const generatedFontResponse = await serveGeneratedOnlyOfficeFontAsset(pathname);
  if (generatedFontResponse) return generatedFontResponse;

  const distResponse = await serveDistOnlyOfficeAsset(pathname);
  if (distResponse) return distResponse;

  const publicResponse = await serveFileFromRoot(frontendPublicDir, pathname);
  if (publicResponse) return publicResponse;

  const localResponse = await serveLocalOnlyOfficeBrowserAsset(pathname);
  if (localResponse) return localResponse;

  if (!onlyOfficeBrowserAssetBase) {
    return new Response(`OnlyOffice browser runtime asset is not configured: ${pathname}`, {
      status: 502,
    });
  }

  const target = new URL(pathname.slice(1), ensureTrailingSlash(onlyOfficeBrowserAssetBase));
  try {
    const upstream = await fetch(target);
    if (!upstream.ok || !upstream.body) {
      return new Response(`Failed to load OnlyOffice runtime asset: ${pathname}`, {
        status: upstream.status || 502,
      });
    }
    const headers = applyOnlyOfficeHostResponseHeaders(pathname, new Headers());
    headers.set("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
    headers.set("Cache-Control", "public, max-age=86400");
    if (pathname.endsWith(".br")) headers.set("Content-Encoding", "br");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    console.warn("[server] Failed to proxy OnlyOffice browser asset", target.toString(), error);
    return new Response("Failed to load OnlyOffice browser asset", { status: 502 });
  }
}

function serveMissingOnlyOfficePrintPdf(): Response {
  const headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  return new Response(
    "OnlyOffice print PDFs are transient and must be served from the editor host Service Worker cache.",
    {
      status: 410,
      headers,
    },
  );
}

function serveOnlyOfficeHostNotFound(): Response {
  const headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  return new Response("OnlyOffice host origin does not serve the Piwork application.", {
    status: 404,
    headers,
  });
}

async function serveGeneratedOnlyOfficeFontAsset(pathname: string): Promise<Response | null> {
  const target = resolveOnlyOfficeGeneratedFontAsset(onlyOfficeFontAssetsDir, pathname);
  if (!target) return null;
  const file = Bun.file(target);
  if (!(await file.exists())) return null;
  const headers = new Headers();
  headers.set("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(file, { headers });
}

async function serveDistOnlyOfficeAsset(pathname: string): Promise<Response | null> {
  return serveFileFromRoot(bundledFrontendDistDir, pathname);
}

async function serveLocalOnlyOfficeBrowserAsset(pathname: string): Promise<Response | null> {
  if (!onlyOfficeBrowserPublicDir) return null;
  return serveFileFromRoot(resolve(onlyOfficeBrowserPublicDir), pathname);
}

async function serveFileFromRoot(root: string, pathname: string): Promise<Response | null> {
  const target = resolve(root, `.${pathname}`);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) return null;
  const file = Bun.file(target);
  if (!(await file.exists())) return null;
  const headers = applyOnlyOfficeHostResponseHeaders(pathname, new Headers());
  headers.set("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (pathname.endsWith(".br")) headers.set("Content-Encoding", "br");
  return new Response(file, { headers });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function serveBundledPwaAsset(pathname: string): Promise<Response> {
  const policy = resolvePwaAssetPolicy(bundledFrontendDistDir, pathname);
  if (!policy) return new Response("Not Found", { status: 404 });
  const file = Bun.file(policy.filePath);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });
  const headers = new Headers({
    "Content-Type": policy.contentType,
    "Cache-Control": policy.cacheControl,
  });
  if (policy.serviceWorkerAllowed)
    headers.set("Service-Worker-Allowed", policy.serviceWorkerAllowed);
  return new Response(file, { headers });
}

// In production, serve built frontend using absolute path (works when installed as npm package)
if (environment.isProduction && servesBundledFrontend) {
  const distDir = bundledFrontendDistDir;
  const indexHtmlPath = resolve(distDir, "index.html");
  const serveIndexHtml = (c: Context) => {
    if (!existsSync(indexHtmlPath)) return c.text("Not Found", 404);
    c.header("Content-Type", "text/html; charset=utf-8");
    c.header("Cache-Control", "no-store, max-age=0");
    return c.body(readFileSync(indexHtmlPath, "utf-8"));
  };

  app.use("/*", cacheControlMiddleware());
  app.get("/", serveIndexHtml);
  app.get("/index.html", serveIndexHtml);
  const servePwaAsset = (c: Context) => serveBundledPwaAsset(new URL(c.req.url).pathname);
  app.get("/manifest.webmanifest", servePwaAsset);
  app.get("/piwork-sw.js", servePwaAsset);
  app.get("/offline.html", servePwaAsset);
  app.get("/favicon.svg", servePwaAsset);
  app.get("/icons/*", servePwaAsset);
  app.get("/screenshots/*", servePwaAsset);
  app.get("/__onlyoffice-browser-print__/*", () => serveMissingOnlyOfficePrintPdf());
  const serveFrontendAsset = serveStatic({ root: distDir });
  app.get("/assets/*", (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (isPiworkOnlyOfficeBrowserAssetPath(pathname)) return serveOnlyOfficeBrowserAsset(pathname);
    return serveFrontendAsset(c, next);
  });
  app.get("/fonts/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const localPath = resolve(distDir, `.${pathname}`);
    const rel = relative(distDir, localPath);
    if (
      !rel.startsWith("..") &&
      rel !== "" &&
      !rel.startsWith("/") &&
      (await Bun.file(localPath).exists())
    ) {
      const headers = new Headers();
      headers.set("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(Bun.file(localPath), { headers });
    }
    return serveOnlyOfficeBrowserAsset(pathname);
  });
  const serveOnlyOfficeAsset = (c: Context) =>
    serveOnlyOfficeBrowserAsset(new URL(c.req.url).pathname);
  app.get("/web-apps/*", serveOnlyOfficeAsset);
  app.get("/sdkjs/*", serveOnlyOfficeAsset);
  app.get("/wasm/*", serveOnlyOfficeAsset);
  app.get("/libs/*", serveOnlyOfficeAsset);
  app.get("/dictionaries/*", serveOnlyOfficeAsset);
  app.get("/server/FileConverter/bin/*", serveOnlyOfficeAsset);
  app.get("/onlyoffice-browser-font-assets.json", serveOnlyOfficeAsset);
  app.get("/onlyoffice-browser-font-source-map.json", serveOnlyOfficeAsset);
  app.get("/document_editor_service_worker.js", serveOnlyOfficeAsset);
  app.get("/plugins.json", serveOnlyOfficeAsset);
  app.get("/themes.json", serveOnlyOfficeAsset);
  app.get("/reset.html", serveOnlyOfficeAsset);
  app.get("/office-host.html", serveOnlyOfficeAsset);
  app.get("/sw.js", serveOnlyOfficeAsset);
  app.get("/*", (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (isOnlyOfficePrintPdfPath(pathname)) return serveMissingOnlyOfficePrintPdf();
    if (isPiworkOnlyOfficeBrowserAssetPath(pathname)) return serveOnlyOfficeBrowserAsset(pathname);
    return next();
  });
  app.get("/*", (c) => {
    if (c.req.path.includes(".")) return c.text("Not Found", 404);
    return serveIndexHtml(c);
  });
}

async function handleProtectedUserSpaceRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const match = url.pathname.match(
    /^\/internal\/(?:user-space-transfer\/([a-f0-9-]+)\/(?:mounts|operation)|onlyoffice\/([a-f0-9-]+)\/(?:active|operation))$/i,
  );
  if (!match) return null;
  // Internal operations can legitimately wait on the browser. Do not hold the
  // principal revocation gate for that unbounded interval: the broker's
  // runtime-epoch capability is the operation lease, and runtime teardown
  // revokes it before process disposal.
  const runtime = runtimeRegistry.getRuntimeForSession(match[1] || match[2]);
  if (!runtime) return new Response("Session runtime not found", { status: 404 });
  return runtime.internal.fetch(req);
}

let userSpaceIpcPath: string | null = null;
let userSpaceIpcServer: ReturnType<typeof Bun.serve> | null = null;
let internalTlsServer: ReturnType<typeof Bun.serve> | null = null;
let internalConnectProxy: InternalFileConnectProxy | null = null;
const protectedFetch = async (req: Request) =>
  (await handleProtectedUserSpaceRequest(req)) || new Response("Not Found", { status: 404 });

if (process.platform === "darwin") {
  const nonce = randomUUID().replaceAll("-", "").slice(0, 24);
  userSpaceIpcPath = join(internalRuntimeDir, `us-${process.pid}-${nonce}.sock`);
  if (Buffer.byteLength(userSpaceIpcPath, "utf8") > 100) {
    throw new Error("PIWORK_DATA_ROOT is too long for the protected User Space Unix socket");
  }
  userSpaceIpcServer = Bun.serve({
    unix: userSpaceIpcPath,
    maxRequestBodySize: USER_SPACE_BINARY_BODY_LIMIT_BYTES,
    fetch: protectedFetch,
  });
  const socketStat = lstatSync(userSpaceIpcPath);
  if (!socketStat.isSocket()) {
    userSpaceIpcServer.stop(true);
    throw new Error("Protected User Space IPC endpoint is not a Unix socket");
  }
  chmodSync(userSpaceIpcPath, 0o600);
  protectedTransport.unixSocketPath = userSpaceIpcPath;
  internalFileTransportAvailable = true;
} else {
  const material = ensureInternalFileTransportCertificate(dataRoot);
  internalTlsServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: material.key, cert: material.cert },
    maxRequestBodySize: USER_SPACE_BINARY_BODY_LIMIT_BYTES,
    fetch: protectedFetch,
  });
  if (typeof internalTlsServer.port !== "number") {
    internalTlsServer.stop(true);
    throw new Error("Internal file transport did not expose a TLS port");
  }
  internalConnectProxy = await startInternalFileConnectProxy(internalTlsServer.port);
  protectedTransport.tls = {
    baseUrl: `https://${INTERNAL_FILE_TRANSPORT_HOST}:${internalTlsServer.port}`,
    certificatePath: material.certPath,
    proxyUrl: `http://127.0.0.1:${internalConnectProxy.port}`,
  };
  internalFileTransportAvailable = true;
}

const server = Bun.serve<SocketData>({
  hostname: host,
  port,
  maxRequestBodySize: USER_SPACE_BINARY_BODY_LIMIT_BYTES,
  idleTimeout: 0, // Disable top-level idle timeout — it kills idle browser WebSockets (code 1006)
  async fetch(req, server) {
    const url = new URL(req.url);
    if (isOnlyOfficeHostRequestHost(req.headers.get("host"))) {
      if (isOnlyOfficePrintPdfPath(url.pathname)) return serveMissingOnlyOfficePrintPdf();
      if (isPiworkOnlyOfficeBrowserAssetPath(url.pathname))
        return serveOnlyOfficeBrowserAsset(url.pathname);
      return serveOnlyOfficeHostNotFound();
    }

    if (url.pathname === "/api/health/live" && req.method === "GET") {
      return Response.json(livenessResponse(), {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }
    if (url.pathname === "/api/health/ready" && req.method === "GET") {
      const readiness = await readinessResponse({
        dataRoot,
        databaseReady: checkBetterAuthDatabaseReady,
        piRuntimeAvailable,
        internalFileTransportAvailable,
      });
      return Response.json(readiness, {
        status: readiness.ok ? 200 : 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    let requestForDispatch = req;
    if (url.pathname.startsWith("/api/")) {
      const securityOptions = { trustedOrigins: browserOriginAllowlist };
      const secured = url.pathname.startsWith("/api/auth/")
        ? await secureCookieApiRequest(req, securityOptions)
        : await secureAuthenticatedCookieApiRequest(req, securityOptions, async (request) => {
            const identity = await localAuth.authenticateIdentity(request);
            return identity.ok ? { ok: true } : identity;
          });
      if (!secured.ok) return secured.response;
      requestForDispatch = secured.request;
    }

    const publicAuthResponse = await localAuth.handlePublicRequest(requestForDispatch);
    if (publicAuthResponse) return publicAuthResponse;

    if (url.pathname.startsWith("/api/")) {
      const auth = await localAuth.authenticate(requestForDispatch);
      if (!auth.ok) return auth.response;
      const principal = await resolveTenantBoundRuntimePrincipal(
        requestForDispatch,
        auth.user,
        withActiveTenant,
        { resourcePrincipal: runtimeResourcePrincipal(requestForDispatch) },
      );
      if (!principal.ok) return principal.response;
      const runtimeLease = runtimeRegistry.acquirePrincipal(principal.user);
      if (!runtimeLease) {
        return new Response("Tenant membership was revoked", { status: 403 });
      }
      try {
        return await runtimeLease.runtime.api.fetch(requestForDispatch, server);
      } finally {
        runtimeLease.release();
      }
    }

    if (url.pathname.startsWith("/internal/")) {
      return new Response("Not Found", { status: 404 });
    }

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      if (!requestOriginAllowed(req, browserOriginAllowlist)) {
        return new Response("WebSocket origin is not allowed", { status: 403 });
      }
      const auth = await localAuth.authenticate(req);
      if (!auth.ok) return auth.response;
      const activeUser = await withActiveTenant(auth.user);
      const runtimeLease = runtimeRegistry.acquirePrincipal(activeUser);
      if (!runtimeLease) return new Response("Tenant membership was revoked", { status: 403 });
      try {
        const runtime = runtimeLease.runtime;
        const sessionId = browserMatch[1];
        if (!runtime.launcher.getSession(sessionId) && !runtime.wsBridge.getSession(sessionId)) {
          return new Response("Session not found", { status: 404 });
        }
        const protocolParam = url.searchParams.get("protocolVersion");
        const epochParam = url.searchParams.get("contextEpoch");
        const contextIdParam = url.searchParams.get("contextId");
        const negotiated = protocolParam !== null || epochParam !== null || contextIdParam !== null;
        const contextEpoch = epochParam === null ? Number.NaN : Number(epochParam);
        if (
          !negotiated ||
          Number(protocolParam) !== WS_PROTOCOL_VERSION ||
          !Number.isSafeInteger(contextEpoch) ||
          contextEpoch < 0 ||
          !isRuntimeContextId(contextIdParam)
        ) {
          return new Response("Unsupported WebSocket protocol context", { status: 400 });
        }
        const upgraded = server.upgrade(req, {
          data: {
            kind: "browser" as const,
            sessionId,
            authCookie: req.headers.get("cookie") || "",
            authAuthorization: req.headers.get("authorization") || "",
            authUserId: activeUser.userId,
            authTenantId: activeUser.tenantId,
            authValidatedAt: Date.now(),
            protocolVersion: WS_PROTOCOL_VERSION,
            contextEpoch,
            contextId: contextIdParam!,
          },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      } finally {
        runtimeLease.release();
      }
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    ...websocketTransportLimits(),
    idleTimeout: 0,
    sendPings: false,
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      const runtimeLease = runtimeRegistry.acquireSession(data.sessionId);
      if (!runtimeLease) {
        closeUnauthorizedSocket(ws);
        return;
      }
      try {
        startSocketAuthRevalidation(ws);
        runtimeLease.runtime.wsBridge.handleBrowserOpen(ws, data.sessionId);
      } finally {
        runtimeLease.release();
      }
    },
    async message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (!(await validateAuthenticatedSocket(ws))) {
        closeUnauthorizedSocket(ws);
        return;
      }
      const runtimeLease = runtimeRegistry.acquireSession(data.sessionId);
      if (!runtimeLease) {
        closeUnauthorizedSocket(ws);
        return;
      }
      try {
        runtimeLease.runtime.wsBridge.handleBrowserMessage(ws, msg);
      } finally {
        runtimeLease.release();
      }
    },
    close(ws: ServerWebSocket<SocketData>, code?: number, _reason?: string) {
      stopSocketAuthRevalidation(ws);
      console.log("[ws-close] browser code=" + code);
      const data = ws.data;
      const runtimeLease = runtimeRegistry.acquireSession(data.sessionId);
      if (!runtimeLease) return;
      try {
        runtimeLease.runtime.wsBridge.handleBrowserClose(ws);
      } finally {
        runtimeLease.release();
      }
    },
  },
});

console.log(`Server running on http://${host}:${server.port}`);
console.log();
console.log("  Mode: native Pi + Better Auth + Postgres");
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

// ── Graceful shutdown ────────────────────────────────────────────────────────
let shutdownPromise: Promise<void> | null = null;
function gracefulShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log("[server] Graceful shutdown started");
    const serverStop = Promise.resolve(server.stop(false)).catch(() => undefined);
    const tlsStop = internalTlsServer
      ? Promise.resolve(internalTlsServer.stop(false)).catch(() => undefined)
      : Promise.resolve();
    const ipcStop = userSpaceIpcServer
      ? Promise.resolve(userSpaceIpcServer.stop(false)).catch(() => undefined)
      : Promise.resolve();
    const proxyStop = internalConnectProxy?.close().catch(() => undefined) ?? Promise.resolve();
    await runtimeRegistry.dispose();
    await agentBrowserBridge.dispose();
    await Promise.race([
      Promise.all([serverStop, tlsStop, ipcStop, proxyStop]),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (userSpaceIpcPath) rmSync(userSpaceIpcPath, { force: true });
    runnerLock?.release();
    closeLogFile();
  })().finally(() => {
    process.exit(0);
  });
  return shutdownPromise;
}
process.on("SIGTERM", () => {
  void gracefulShutdown();
});
process.on("SIGINT", () => {
  void gracefulShutdown();
});
