import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { cacheControlMiddleware } from "./cache-headers.js";

/**
 * Unit tests for the Cache-Control middleware.
 *
 * Uses a minimal Hono app with mock routes that return 200 for known paths.
 * The middleware runs after the route handler (via await next()) and sets
 * Cache-Control headers based on the request path.
 *
 * Validates that:
 * - index.html gets no-store (app shell must always come from the server)
 * - Vite hashed assets get immutable caching (content-hashed filenames)
 * - Font files get immutable caching
 * - Images get 1-day cache
 * - API routes get no Cache-Control header (handled by network, not static)
 */
function createTestApp() {
  const app = new Hono();
  app.use("/*", cacheControlMiddleware());

  // Mock routes that simulate serveStatic behavior
  app.get("/", (c) => c.html("<html></html>"));
  app.get("/index.html", (c) => c.html("<html></html>"));
  app.get("/assets/index-abc123.js", (c) => c.text("// js"));
  app.get("/assets/style-def456.css", (c) => c.text("/* css */"));
  app.get("/fonts/MesloLGSNerdFontMono-Regular.woff2", (c) => c.body("font"));
  app.get("/screenshot.png", (c) => c.body("png"));
  app.get("/manifest.webmanifest", (c) => c.body("{}"));
  app.get("/piwork-sw.js", (c) => c.text("// worker"));
  app.get("/offline.html", (c) => c.html("<html></html>"));
  app.get("/api/sessions", (c) => c.json([]));

  return app;
}

describe("cacheControlMiddleware", () => {
  const app = createTestApp();

  it("sets no-store for / (index.html root)", async () => {
    const res = await app.request("/");
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  it("sets no-store for /index.html", async () => {
    const res = await app.request("/index.html");
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  it.each(["/manifest.webmanifest", "/piwork-sw.js", "/offline.html"])(
    "forces PWA control resource %s to revalidate",
    async (path) => {
      const res = await app.request(path);
      expect(res.headers.get("Cache-Control")).toBe("no-cache, max-age=0, must-revalidate");
    },
  );

  it("sets immutable max-age for Vite hashed JS assets", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets immutable max-age for Vite hashed CSS assets", async () => {
    const res = await app.request("/assets/style-def456.css");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets immutable max-age for woff2 font files", async () => {
    const res = await app.request("/fonts/MesloLGSNerdFontMono-Regular.woff2");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("sets 1-day cache for static images", async () => {
    const res = await app.request("/screenshot.png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("does not set Cache-Control for API routes", async () => {
    const res = await app.request("/api/sessions");
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
