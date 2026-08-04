import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ENV, environment } from "./server/environment.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preserveOriginalOriginProxyOptions } from "./server/vite-config-runtime";

const webRoot = dirname(fileURLToPath(import.meta.url));
const frontendPublicDir = resolve(webRoot, "public");
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

export default defineConfig({
  publicDir: frontendPublicDir,
  esbuild: {
    jsx: "automatic",
  },
  build: {
    manifest: true,
  },
  plugins: [onlyOfficeBrowserDevModuleCacheGuardPlugin(), react(), tailwindcss()],
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
