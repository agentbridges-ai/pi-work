import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePwaAssetPolicy } from "./pwa-assets.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public", import.meta.url));
const manifestPath = fileURLToPath(new URL("../public/manifest.webmanifest", import.meta.url));

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("desktop PWA assets", () => {
  it("serves root PWA resources with explicit safe policies", () => {
    expect(resolvePwaAssetPolicy("/app/dist", "/manifest.webmanifest")).toMatchObject({
      contentType: "application/manifest+json; charset=utf-8",
      cacheControl: "no-cache, max-age=0, must-revalidate",
    });
    expect(resolvePwaAssetPolicy("/app/dist", "/piwork-sw.js")).toMatchObject({
      contentType: "text/javascript; charset=utf-8",
      serviceWorkerAllowed: "/",
    });
    expect(resolvePwaAssetPolicy("/app/dist", "/icons/piwork-192.png")).toMatchObject({
      contentType: "image/png",
    });
    expect(resolvePwaAssetPolicy("/app/dist", "/icons/../private.json")).toBeNull();
    expect(resolvePwaAssetPolicy("/app/dist", "/unknown.js")).toBeNull();
  });

  it("declares only desktop screenshots and provides real PNGs at every advertised size", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      display: string;
      prefer_related_applications: boolean;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
      screenshots: Array<{ src: string; sizes: string; form_factor?: string; label?: string }>;
    };

    expect(manifest.display).toBe("standalone");
    expect(manifest.prefer_related_applications).toBe(false);
    expect(manifest.screenshots).toHaveLength(1);
    expect(manifest.screenshots[0]).toMatchObject({ form_factor: "wide", sizes: "1280x720" });
    expect(JSON.stringify(manifest)).not.toMatch(/Android|mobile|narrow|手机|平板/i);

    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngDimensions(`${publicRoot}${icon.src}`)).toEqual({ width, height });
    }
    expect(pngDimensions(`${publicRoot}${manifest.screenshots[0].src}`)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("keeps private and OnlyOffice traffic out of the application worker", () => {
    const worker = readFileSync(`${publicRoot}/piwork-sw.js`, "utf-8");
    for (const path of [
      "/api/",
      "/ws/",
      "/user-space/",
      "/web-apps/",
      "/sdkjs/",
      "/wasm/",
      "/fonts/",
      "/sw.js",
    ]) {
      expect(worker).toContain(path);
    }
    expect(worker).toContain('request.mode !== "navigate"');
    expect(worker).not.toContain("clients.claim");
    expect(worker).not.toContain('addEventListener("push"');
    expect(worker).toContain('fetch(request, { cache: "no-store" })');
  });

  it("keeps the offline explanation self-contained", () => {
    const offline = readFileSync(`${publicRoot}/offline.html`, "utf-8");
    expect(offline).toContain("本地服务暂时没有响应");
    expect(offline).toContain("<svg");
    expect(offline).not.toContain("<script");
    expect(offline).not.toContain("<img");
  });

  it("links the manifest statically and registers the dedicated worker in source", () => {
    const html = readFileSync(`${webRoot}/index.html`, "utf-8");
    const lifecycle = readFileSync(`${webRoot}/src/pwa/lifecycle.ts`, "utf-8");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(lifecycle).toContain('serviceWorker.register("/piwork-sw.js"');
    expect(lifecycle).not.toContain('serviceWorker.register("/sw.js"');
  });
});
