import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isOnlyOfficeGeneratedFontAssetPath } from "./onlyoffice-font-assets.js";

export const onlyOfficeBrowserAssetPrefixes = [
  "/web-apps/",
  "/sdkjs/",
  "/wasm/",
  "/libs/",
  "/dictionaries/",
  "/server/FileConverter/bin/",
  "/onlyoffice-plugin/",
];

export const onlyOfficeBrowserAssetFiles = new Set([
  "/onlyoffice-browser-font-assets.json",
  "/onlyoffice-browser-font-source-map.json",
  "/onlyoffice-runtime-assets.json",
  "/office-host.html",
  "/document_editor_service_worker.js",
  "/plugins.json",
  "/themes.json",
  "/reset.html",
  "/sw.js",
]);

const onlyOfficeBrowserAssetChunkPrefixes = [
  "officeHost",
  "office-host-protocol",
  "base",
  "converter",
  "office-editor",
  "main",
  "saveE2E",
];

export const ONLYOFFICE_PRINT_PDF_ROUTE_PREFIX = "/__onlyoffice-browser-print__/";

export type OnlyOfficeBrowserAssetPathOptions = {
  assetBaseConfigured?: boolean;
  localAssetRoots?: Array<string | undefined>;
};

export function isOnlyOfficePrintPdfPath(pathname: string): boolean {
  return pathname.startsWith(ONLYOFFICE_PRINT_PDF_ROUTE_PREFIX);
}

export function applyOnlyOfficeHostResponseHeaders(pathname: string, headers: Headers): Headers {
  if (pathname === "/office-host.html") {
    headers.set("Origin-Agent-Cluster", "?1");
  }
  return headers;
}

export function isOnlyOfficeHostRequestHost(host: string | null | undefined): boolean {
  if (!host) return false;
  let hostname = host.trim().toLowerCase();
  try {
    hostname = new URL(`http://${hostname}`).hostname;
  } catch {
    hostname = hostname.split(":")[0] || "";
  }
  return (
    hostname === "host.localhost" ||
    (hostname.startsWith("host-office-editor-") && hostname.endsWith(".localhost")) ||
    hostname.includes(".office-host.")
  );
}

export function isOnlyOfficeBrowserAssetPath(
  pathname: string,
  options: OnlyOfficeBrowserAssetPathOptions = {},
): boolean {
  if (pathname.startsWith("/fonts/Meslo")) return false;
  if (isOnlyOfficeGeneratedFontAssetPath(pathname)) return true;
  if (isOnlyOfficeBrowserAssetChunkPath(pathname, options)) return true;
  return (
    onlyOfficeBrowserAssetFiles.has(pathname) ||
    onlyOfficeBrowserAssetPrefixes.some((prefix) => pathname.startsWith(prefix))
  );
}

function isOnlyOfficeBrowserAssetChunkPath(
  pathname: string,
  options: OnlyOfficeBrowserAssetPathOptions,
): boolean {
  if (!pathname.startsWith("/assets/")) return false;
  const fileName = pathname.slice("/assets/".length);
  if (!onlyOfficeBrowserAssetChunkPrefixes.some((prefix) => fileName.startsWith(`${prefix}-`))) {
    return false;
  }

  const roots = options.localAssetRoots?.filter((root): root is string => Boolean(root)) ?? [];
  if (roots.some((root) => fileExistsWithinRoot(root, pathname))) return true;
  return Boolean(options.assetBaseConfigured);
}

function fileExistsWithinRoot(root: string, pathname: string): boolean {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, `.${pathname}`);
  const rel = relative(resolvedRoot, target);
  if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) return false;
  return existsSync(target);
}

export function contentTypeForOnlyOfficeAsset(pathname: string): string {
  const cleanPath = pathname.endsWith(".br") ? pathname.slice(0, -3) : pathname;
  if (cleanPath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (cleanPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (cleanPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (cleanPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (cleanPath.endsWith(".wasm")) return "application/wasm";
  if (cleanPath.endsWith(".svg")) return "image/svg+xml";
  if (cleanPath.endsWith(".png")) return "image/png";
  if (cleanPath.endsWith(".jpg") || cleanPath.endsWith(".jpeg")) return "image/jpeg";
  if (cleanPath.endsWith(".gif")) return "image/gif";
  if (cleanPath.endsWith(".woff")) return "font/woff";
  if (cleanPath.endsWith(".woff2")) return "font/woff2";
  if (cleanPath.endsWith(".otf")) return "font/otf";
  if (cleanPath.endsWith(".ttf")) return "font/ttf";
  if (cleanPath.endsWith(".ttc")) return "font/collection";
  if (cleanPath.endsWith(".otc")) return "font/collection";
  if (cleanPath.endsWith(".eot")) return "application/vnd.ms-fontobject";
  return "application/octet-stream";
}
