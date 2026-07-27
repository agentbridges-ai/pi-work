import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, environment } from "./environment.js";

export const ONLYOFFICE_FONT_ASSETS_DIR_ENV = "ONLYOFFICE_BROWSER_FONT_ASSETS_DIR";
export const PIWORK_ONLYOFFICE_FONT_ASSETS_DIR_ENV = "PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR";
export const ONLYOFFICE_FONT_ASSETS_MANIFEST = "onlyoffice-browser-font-assets.json";
export const ONLYOFFICE_FONT_SOURCE_MAP = "onlyoffice-browser-font-source-map.json";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configuredOnlyOfficeBrowserDir = environment
  .optionalString(ENV.PIWORK_ONLYOFFICE_BROWSER_DIR, false)
  ?.trim();
const defaultOnlyOfficeBrowserDir = configuredOnlyOfficeBrowserDir
  ? resolve(configuredOnlyOfficeBrowserDir)
  : resolve(repoRoot, "onlyoffice-browser");
export const DEFAULT_ONLYOFFICE_FONT_ASSETS_DIR = resolve(
  defaultOnlyOfficeBrowserDir,
  ".onlyoffice-font-assets",
);

const FONT_THUMBNAIL_RE = /^\/sdkjs\/common\/Images\/fonts_thumbnail(?:_ea)?(?:@[\d.]+x)?\.png$/;

export type OnlyOfficeFontAssetsManifest = {
  version: number;
  allFonts: string;
  fontSelection: string;
  fontSourceMap?: string;
  fontThumbnails: string[];
  fonts: string[];
};

function isInsideDirectory(root: string, candidate: string): boolean {
  const nextRelative = relative(root, candidate);
  return !!nextRelative && !nextRelative.startsWith("..") && !nextRelative.startsWith("/");
}

function safeResolve(root: string, relativePath: string): string | null {
  const target = resolve(root, relativePath);
  return isInsideDirectory(root, target) ? target : null;
}

function normalizeAssetPath(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/");
}

export function resolveOnlyOfficeFontAssetsDir(): string {
  const configured =
    environment.value(ENV.PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR)?.trim() ||
    environment.value(ENV.ONLYOFFICE_BROWSER_FONT_ASSETS_DIR)?.trim();
  if (configured) return resolve(configured);
  return existsSync(DEFAULT_ONLYOFFICE_FONT_ASSETS_DIR) ? DEFAULT_ONLYOFFICE_FONT_ASSETS_DIR : "";
}

export function resolveOnlyOfficeGeneratedFontAsset(
  fontAssetsRoot: string,
  requestPath: string,
): string | null {
  if (!fontAssetsRoot) return null;

  const pathname = normalizeAssetPath(requestPath);
  if (pathname === `/${ONLYOFFICE_FONT_ASSETS_MANIFEST}`) {
    return safeResolve(fontAssetsRoot, ONLYOFFICE_FONT_ASSETS_MANIFEST);
  }

  if (pathname === `/${ONLYOFFICE_FONT_SOURCE_MAP}`) {
    return safeResolve(fontAssetsRoot, ONLYOFFICE_FONT_SOURCE_MAP);
  }

  if (pathname === "/sdkjs/common/AllFonts.js") {
    return safeResolve(fontAssetsRoot, "sdkjs/common/AllFonts.js");
  }

  if (FONT_THUMBNAIL_RE.test(pathname)) {
    return safeResolve(fontAssetsRoot, `sdkjs/common/Images/${basename(pathname)}`);
  }

  if (pathname === "/server/FileConverter/bin/font_selection.bin") {
    return safeResolve(fontAssetsRoot, "server/FileConverter/bin/font_selection.bin");
  }

  if (pathname === "/server/FileConverter/bin/AllFonts.js") {
    return safeResolve(fontAssetsRoot, "server/FileConverter/bin/AllFonts.js");
  }

  if (pathname.startsWith("/fonts/fonts/")) {
    return null;
  }

  if (pathname.startsWith("/fonts/")) {
    return safeResolve(fontAssetsRoot, `fonts/${pathname.slice("/fonts/".length)}`);
  }

  return null;
}

export function isOnlyOfficeGeneratedFontAssetPath(pathname: string): boolean {
  return resolveOnlyOfficeGeneratedFontAsset("/__font_assets__", pathname) !== null;
}

export function readOnlyOfficeFontAssetsManifest(
  fontAssetsRoot: string,
): OnlyOfficeFontAssetsManifest | null {
  const target = resolveOnlyOfficeGeneratedFontAsset(
    fontAssetsRoot,
    `/${ONLYOFFICE_FONT_ASSETS_MANIFEST}`,
  );
  if (!target || !existsSync(target)) return null;

  const manifest = JSON.parse(
    readFileSync(target, "utf-8"),
  ) as Partial<OnlyOfficeFontAssetsManifest>;
  if (
    manifest.version !== 1 ||
    typeof manifest.allFonts !== "string" ||
    typeof manifest.fontSelection !== "string" ||
    (manifest.fontSourceMap !== undefined && typeof manifest.fontSourceMap !== "string") ||
    !Array.isArray(manifest.fontThumbnails) ||
    !Array.isArray(manifest.fonts)
  ) {
    throw new Error(`Invalid OnlyOffice font assets manifest: ${target}`);
  }

  return manifest as OnlyOfficeFontAssetsManifest;
}

export function verifyOnlyOfficeFontAssets(
  fontAssetsRoot: string,
): OnlyOfficeFontAssetsManifest | null {
  const manifest = readOnlyOfficeFontAssetsManifest(fontAssetsRoot);
  if (!manifest) return null;

  const required = [
    manifest.allFonts,
    manifest.fontSelection,
    ...(manifest.fontSourceMap ? [manifest.fontSourceMap] : []),
    ...manifest.fontThumbnails,
    ...manifest.fonts,
  ];

  for (const assetPath of required) {
    const target = resolveOnlyOfficeGeneratedFontAsset(fontAssetsRoot, `/${assetPath}`);
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`Missing OnlyOffice generated font asset: ${assetPath}`);
    }
  }

  return manifest;
}
