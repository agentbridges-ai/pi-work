const CACHE_PREFIX = "piwork-pwa-";
const SHELL_REVISION = "__PIWORK_SHELL_REVISION__";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${SHELL_REVISION}`;
const OFFLINE_URL = "/offline.html";
const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/piwork-192.png",
  "/icons/piwork-512.png",
  "/icons/piwork-maskable-192.png",
  "/icons/piwork-maskable-512.png",
];

const NEVER_INTERCEPT_PREFIXES = [
  "/api/",
  "/ws/",
  "/internal/",
  "/user-space/",
  "/user-space-checkouts/",
  "/web-apps/",
  "/sdkjs/",
  "/wasm/",
  "/libs/",
  "/dictionaries/",
  "/fonts/",
  "/server/FileConverter/",
  "/__onlyoffice-browser-print__/",
];

const NEVER_INTERCEPT_PATHS = new Set([
  "/build-info",
  "/sw.js",
  "/document_editor_service_worker.js",
  "/office-host.html",
  "/onlyoffice-browser-font-assets.json",
  "/onlyoffice-browser-font-source-map.json",
]);

function mustUseNetwork(url) {
  return (
    NEVER_INTERCEPT_PATHS.has(url.pathname) ||
    NEVER_INTERCEPT_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    /(?:onlyoffice|officeHost|document-resource)/i.test(url.pathname) ||
    /\.(?:wasm|woff2?|ttf|ttc|otf)$/i.test(url.pathname)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const requests = SHELL_ASSETS.map((url) => new Request(url, { cache: "reload" }));
      await cache.addAll(requests);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      );

      const cache = await caches.open(SHELL_CACHE);
      const allowed = new Set(SHELL_ASSETS.map((path) => new URL(path, self.location.origin).href));
      const cachedRequests = await cache.keys();
      await Promise.all(
        cachedRequests
          .filter((request) => !allowed.has(request.url))
          .map((request) => cache.delete(request)),
      );
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
  if (type === "GET_VERSION") {
    event.ports?.[0]?.postMessage({ revision: SHELL_REVISION });
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || mustUseNetwork(url)) return;

  event.respondWith(
    (async () => {
      try {
        // A cached index.html without its hashed scripts produces a blank page.
        // Force a real network navigation so an unavailable local server always
        // falls through to the self-contained offline explanation instead.
        return await fetch(request, { cache: "no-store" });
      } catch {
        const offlinePage = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
        return (
          offlinePage ||
          new Response("Piwork local service is unavailable.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.type !== "piwork-session" || typeof data.sessionId !== "string") return;
  const sessionId = data.sessionId;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );

      if (existing) {
        existing.postMessage({ type: "piwork:open-session", sessionId });
        await existing.focus();
        return;
      }

      await self.clients.openWindow(`/session/${encodeURIComponent(sessionId)}`);
    })(),
  );
});
