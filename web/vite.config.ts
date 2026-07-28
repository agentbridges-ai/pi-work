import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ENV, environment } from "./server/environment.js";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstHeader,
  preserveOriginalOriginProxyOptions,
  resolveOnlyOfficeFontAssetsDir,
  resolveOnlyOfficeGeneratedFontAsset,
  verifyOnlyOfficeFontAssets,
} from "./server/vite-config-runtime";
import {
  contentTypeForOnlyOfficeAsset,
  isOnlyOfficeSharedAssetPath,
  isOnlyOfficeBrowserAssetPath,
  isOnlyOfficeHostRequestHost,
  isOnlyOfficePrintPdfPath,
} from "./server/onlyoffice-runtime-assets";
import { readOnlyOfficeRuntimeIdentity } from "./server/onlyoffice-runtime-identity";

const webRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(webRoot, "..");
const frontendPublicDir = resolve(webRoot, "public");
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
const onlyOfficeBrowserPackageName = "@agentbridges-ai/onlyoffice-browser";
const codeMirrorDedupe = [
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/theme-one-dark",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@uiw/codemirror-extensions-basic-setup",
  "@uiw/react-codemirror",
  "codemirror",
  "style-mod",
];

function isOnlyOfficeBrowserDevModule(pathname: string): boolean {
  return (
    pathname.startsWith("/node_modules/.vite/deps/@agentbridges-ai_onlyoffice-browser") ||
    pathname.includes("/node_modules/@agentbridges-ai/onlyoffice-browser/") ||
    pathname.includes("/@agentbridges-ai/onlyoffice-browser/") ||
    pathname.includes("@agentbridges-ai_onlyoffice-browser")
  );
}

function setNoStoreHeaders(res: { setHeader(name: string, value: string): void }): void {
  res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function onlyOfficeBrowserDevModuleCacheGuardPlugin(): Plugin {
  return {
    name: "piwork-onlyoffice-browser-dev-module-cache-guard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = req.url || "";
        const pathname = new URL(requestUrl, "http://localhost").pathname;
        if (isOnlyOfficeBrowserDevModule(pathname)) {
          setNoStoreHeaders(res);
        }
        next();
      });
    },
  };
}

function onlyOfficeBrowserRuntimePlugin(): Plugin {
  return {
    name: "piwork-onlyoffice-browser-runtime",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url || "";
        const pathname = new URL(requestUrl, "http://localhost").pathname;
        const isOfficeHost = isOnlyOfficeHostRequestHost(firstHeader(req.headers.host));
        if (isOnlyOfficePrintPdfPath(pathname)) {
          res.statusCode = 410;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store, max-age=0");
          res.end(
            "OnlyOffice print PDFs are transient and must be served from the editor host Service Worker cache.",
          );
          return;
        }
        if (!isPiworkOnlyOfficeBrowserAssetPath(pathname)) {
          if (isOfficeHost) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Cache-Control", "no-store, max-age=0");
            res.end("OnlyOffice host origin does not serve the Piwork application.");
            return;
          }
          next();
          return;
        }
        if (pathname === "/office-host.html") {
          res.setHeader("Origin-Agent-Cluster", "?1");
        }
        if (isOnlyOfficeSharedAssetPath(pathname)) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, ETag, Last-Modified, X-OnlyOffice-Asset-Version",
          );
        }

        try {
          const generatedFontAsset = resolveGeneratedOnlyOfficeFontAsset(pathname);
          if (generatedFontAsset) {
            await serveRevalidatedOnlyOfficeAsset(req, res, pathname, generatedFontAsset);
            return;
          }
          const localAsset = resolveLocalOnlyOfficeBrowserAsset(pathname);
          if (localAsset) {
            await serveRevalidatedOnlyOfficeAsset(req, res, pathname, localAsset);
            return;
          }
          if (!onlyOfficeBrowserAssetBase) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`OnlyOffice browser runtime asset is not configured: ${pathname}`);
            return;
          }
          const target = new URL(
            pathname.slice(1),
            ensureTrailingSlash(onlyOfficeBrowserAssetBase),
          );
          const upstream = await fetch(target);
          if (!upstream.ok || !upstream.body) {
            res.statusCode = upstream.status || 502;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`Failed to load OnlyOffice runtime asset: ${pathname}`);
            return;
          }
          const body = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          res.statusMessage = upstream.statusText;
          res.setHeader("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
          res.setHeader("Cache-Control", "public, max-age=86400");
          if (pathname.endsWith(".br")) res.setHeader("Content-Encoding", "br");
          res.end(body);
        } catch (error) {
          console.warn("[vite] Failed to proxy OnlyOffice browser asset", pathname, error);
          res.statusCode = 502;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Failed to load OnlyOffice browser asset");
          return;
        }
      });
    },
  };
}

function onlyOfficeBrowserDevelopmentIdentityPlugin(): Plugin {
  return {
    name: "piwork-onlyoffice-browser-development-identity",
    apply: "serve",
    async config() {
      if (!onlyOfficeBrowserPublicDir || onlyOfficeBrowserAssetBase) return;
      const identity = await readOnlyOfficeRuntimeIdentity(defaultOnlyOfficeBrowserDir);
      return {
        define: {
          __PIWORK_ONLYOFFICE_DEVELOPMENT_IDENTITY__: JSON.stringify(identity),
        },
      };
    },
  };
}

function onlyOfficeBrowserFontBuildPlugin(): Plugin {
  return {
    name: "piwork-onlyoffice-browser-fonts",
    apply: "build",
    async buildStart() {
      if (!onlyOfficeFontAssetsDir) return;
      const manifest = verifyOnlyOfficeFontAssets(onlyOfficeFontAssetsDir);
      if (!manifest) return;
      const assetPaths = [
        "onlyoffice-browser-font-assets.json",
        ...(manifest.fontSourceMap ? [manifest.fontSourceMap] : []),
        manifest.allFonts,
        manifest.fontSelection,
        ...manifest.fontThumbnails,
        ...manifest.fonts,
      ];
      const converterAllFonts = "server/FileConverter/bin/AllFonts.js";
      const converterAllFontsSource = resolveOnlyOfficeGeneratedFontAsset(
        onlyOfficeFontAssetsDir,
        `/${converterAllFonts}`,
      );
      if (converterAllFontsSource && existsSync(converterAllFontsSource)) {
        assetPaths.push(converterAllFonts);
      }
      for (const assetPath of assetPaths) {
        const source = resolveOnlyOfficeGeneratedFontAsset(
          onlyOfficeFontAssetsDir,
          `/${assetPath}`,
        );
        if (!source) {
          throw new Error(`OnlyOffice generated font asset is not resolvable: ${assetPath}`);
        }
        this.emitFile({
          type: "asset",
          fileName: assetPath,
          source: await readFile(source),
        });
      }
    },
  };
}

function isPiworkOnlyOfficeBrowserAssetPath(pathname: string): boolean {
  return isOnlyOfficeBrowserAssetPath(pathname, {
    assetBaseConfigured: Boolean(onlyOfficeBrowserAssetBase),
    localAssetRoots: [frontendPublicDir, onlyOfficeBrowserPublicDir],
  });
}

function resolveLocalOnlyOfficeBrowserAsset(pathname: string): string | null {
  for (const configuredRoot of [frontendPublicDir, onlyOfficeBrowserPublicDir]) {
    if (!configuredRoot) continue;
    const root = resolve(configuredRoot);
    const target = resolve(root, `.${pathname}`);
    const rel = relative(root, target);
    if (rel.startsWith("..") || rel === "" || rel.startsWith("/")) continue;
    if (existsSync(target)) return target;
  }
  return null;
}

function resolveGeneratedOnlyOfficeFontAsset(pathname: string): string | null {
  const target = resolveOnlyOfficeGeneratedFontAsset(onlyOfficeFontAssetsDir, pathname);
  if (!target || !existsSync(target)) return null;
  return target;
}

async function serveRevalidatedOnlyOfficeAsset(
  req: { headers: { [key: string]: string | string[] | undefined } },
  res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: Buffer): void;
  },
  pathname: string,
  target: string,
): Promise<void> {
  const metadata = await stat(target);
  const etag = `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`;
  res.setHeader("Content-Type", contentTypeForOnlyOfficeAsset(pathname));
  res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
  res.setHeader("ETag", etag);
  if (pathname.endsWith(".br")) res.setHeader("Content-Encoding", "br");
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.end(await readFile(target));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export default defineConfig({
  publicDir: frontendPublicDir,
  build: {
    manifest: true,
  },
  plugins: [
    onlyOfficeBrowserDevModuleCacheGuardPlugin(),
    onlyOfficeBrowserDevelopmentIdentityPlugin(),
    onlyOfficeBrowserFontBuildPlugin(),
    onlyOfficeBrowserRuntimePlugin(),
    react(),
    tailwindcss(),
  ],
  server: {
    host: "127.0.0.1",
    port: environment.number(ENV.VITE_PORT, 3458),
    strictPort: true,
    proxy: {
      "/api": preserveOriginalOriginProxyOptions(),
      "/ws/browser": preserveOriginalOriginProxyOptions({ ws: true }),
    },
  },
  resolve: {
    alias: {
      "node:zlib": fileURLToPath(new globalThis.URL("./src/shims/node-zlib.ts", import.meta.url)),
    },
    dedupe: ["react", "react-dom", ...codeMirrorDedupe],
  },
  optimizeDeps: {
    exclude: [onlyOfficeBrowserPackageName],
    include: [
      "@codemirror/language",
      "@codemirror/state",
      "@codemirror/view",
      "@headless-tree/core",
      "@headless-tree/react",
      "@tanstack/react-virtual",
      "@uiw/react-codemirror",
      "@lezer/highlight",
      "konva",
      "react",
      "react-dom",
      "react-dom/client",
      "react-konva",
      "react-konva-utils",
      "zustand",
    ],
  },
});
