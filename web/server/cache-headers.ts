import type { MiddlewareHandler } from "hono";

/**
 * Hono middleware that sets Cache-Control headers for production static assets.
 *
 * Must be registered BEFORE serveStatic so it can modify the response headers
 * after the static file is served (via await next()).
 *
 * Header strategy:
 * - manifest, Piwork Service Worker, offline page: always revalidate
 * - index.html: no-store (HTML app shell must always come from the server)
 * - /assets/*: immutable, 1 year (Vite content-hashed filenames)
 * - /fonts/*.woff2: immutable, 1 year (stable font files)
 * - Images: 1 day cache
 */
export function cacheControlMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    // Only set cache headers on successful responses
    if (c.res.status !== 200) return;

    const path = c.req.path;

    if (path === "/piwork-sw.js" || path === "/manifest.webmanifest" || path === "/offline.html") {
      c.header("Cache-Control", "no-cache, max-age=0, must-revalidate");
      return;
    }

    // index.html (served for / and /index.html): must be fresh
    if (path === "/" || path === "/index.html") {
      c.header("Cache-Control", "no-store, max-age=0");
      return;
    }

    // Vite hashed assets: immutable (filename changes on content change)
    if (path.startsWith("/assets/")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return;
    }

    // Font files: immutable
    if (path.startsWith("/fonts/") && path.endsWith(".woff2")) {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      return;
    }

    // Other static images: cache for 1 day
    if (path.endsWith(".png") || path.endsWith(".svg") || path.endsWith(".ico")) {
      c.header("Cache-Control", "public, max-age=86400");
    }
  };
}
