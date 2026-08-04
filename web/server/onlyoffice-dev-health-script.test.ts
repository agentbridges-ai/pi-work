import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkOnlyOfficeDevHealth } from "../../scripts/check-onlyoffice-dev-health.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeIdentity = {
  packageVersion: "0.3.30",
  hostBuildId: "office-host-0.3.30-r1",
  assetManifestDigest: "a".repeat(64),
  releaseId: "v0.3.30-0123456789abcdef",
};

function healthyFetch(csp = "frame-ancestors https://piwork.getpi.work; base-uri 'none'") {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === `/r/${runtimeIdentity.releaseId}/office-host.html`) {
      return new Response("host", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "origin-agent-cluster": "?1",
          "x-onlyoffice-asset-version": runtimeIdentity.releaseId,
          "content-security-policy": csp,
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
}

describe("OnlyOffice dev health check", () => {
  it("keeps Piwork development and build independent from the OnlyOffice deployment", () => {
    const devScript = readFileSync(resolve(repoRoot, "scripts/dev-local.sh"), "utf8");
    const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");
    const viteConfig = readFileSync(resolve(repoRoot, "web/vite.config.ts"), "utf8");
    const server = readFileSync(resolve(repoRoot, "web/server/index.ts"), "utf8");

    expect(devScript).not.toContain("check-onlyoffice-dev-health.ts");
    expect(devScript).not.toContain("PIWORK_ONLYOFFICE_BROWSER_");
    expect(makefile).toContain("dev-fast: dev-compose");
    expect(makefile).not.toContain("dev-fast: agent-browser");
    expect(makefile).not.toMatch(/^build:\n\t.*ensure-onlyoffice-browser/m);
    expect(makefile).not.toContain("check-onlyoffice-dev-health.ts");
    expect(viteConfig).not.toContain("onlyOfficeBrowserRuntimePlugin");
    expect(viteConfig).not.toContain("onlyOfficeBrowserFontBuildPlugin");
    expect(server).not.toContain('app.get("/office-host.html"');
    expect(server).not.toContain("serveOnlyOfficeBrowserAsset");
  });

  it("checks the exact immutable Host identity and Piwork embedding policy", async () => {
    const fetchImpl = healthyFetch();

    const result = await checkOnlyOfficeDevHealth({
      frontendUrl: "http://127.0.0.1:3458",
      runtimeIdentity,
      fetchImpl,
    });

    expect(result).toEqual({
      hostUrl: expect.stringContaining(`/r/${runtimeIdentity.releaseId}/office-host.html`),
      runtimeIdentity,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an exact Host with a different immutable identity", async () => {
    await expect(
      checkOnlyOfficeDevHealth({
        frontendUrl: "http://127.0.0.1:3458",
        runtimeIdentity: { ...runtimeIdentity, releaseId: "v0.3.30-fedcba9876543210" },
        fetchImpl: healthyFetch(),
      }),
    ).rejects.toThrow("exact release Host returned HTTP 404");
  });

  it("requires Piwork in the frame-ancestors directive itself", async () => {
    await expect(
      checkOnlyOfficeDevHealth({
        frontendUrl: "http://127.0.0.1:3458",
        runtimeIdentity,
        fetchImpl: healthyFetch("default-src https://piwork.getpi.work; frame-ancestors 'none'"),
      }),
    ).rejects.toThrow("CSP does not permit Piwork embedding");
  });
});
