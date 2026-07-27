import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkOnlyOfficeDevHealth } from "../../scripts/check-onlyoffice-dev-health.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestBody = JSON.stringify({ version: 1, selected: 1660 });
const manifestDigest = createHash("sha256").update(manifestBody).digest("hex");
const runtimeIdentity = {
  packageVersion: "0.3.30",
  hostBuildId: "office-host-0.3.30-r1",
  assetManifestDigest: manifestDigest,
};

function healthyFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/office-host.html") {
      return new Response('<script type="module" src="./assets/officeHost-health.js"></script>', {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "origin-agent-cluster": "?1",
        },
      });
    }
    if (url.pathname === "/assets/officeHost-health.js") {
      return new Response(
        `const version = "${runtimeIdentity.packageVersion}"; const build = "${runtimeIdentity.hostBuildId}"; const type = "HOST_READY"; const manifest = "/onlyoffice-runtime-assets.json"; const protocol = "onlyoffice-browser-plugin/v1"; const instance = "pluginInstanceId"; const invoke = "INVOKE_PLUGIN"; const ready = "PLUGIN_READY";`,
        { status: 200, headers: { "content-type": "text/javascript; charset=utf-8" } },
      );
    }
    if (url.pathname === "/onlyoffice-runtime-assets.json") {
      return new Response(manifestBody, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === "/onlyoffice-plugin/config.json") {
      return Response.json({
        guid: "asc.{7F1B98C4-21D8-4D6B-A7F0-9E8506E23A10}",
        variations: [{ url: "index.html" }],
      });
    }
    if (url.pathname === "/onlyoffice-plugin/index.html") {
      return new Response('<script src="plugin.js"></script>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/onlyoffice-plugin/plugin.js") {
      return new Response(
        "const protocol = 'onlyoffice-browser-plugin/v1'; const pluginInstanceId = crypto.randomUUID(); const host = window.parent.parent; const ops = ['get_document_text', 'get_range_values', 'get_charts_info', 'insert_chart', 'get_presentation_info', 'append_slide'];",
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      );
    }
    return new Response("Not Found", { status: 404 });
  });
}

describe("OnlyOffice dev health check", () => {
  it("runs as a required make dev startup gate and from make status", () => {
    const devScript = readFileSync(resolve(repoRoot, "scripts/dev-local.sh"), "utf8");
    const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");

    expect(devScript).toContain(
      '"$BUN_BIN" "$ROOT_DIR/scripts/check-onlyoffice-dev-health.ts" "http://127.0.0.1:$VITE_PORT" \\\n  --checkout "$ROOT_DIR/onlyoffice-browser"',
    );
    expect(devScript).toContain("VITE_PIWORK_ONLYOFFICE_HOST_URL_TEMPLATE");
    expect(makefile).toContain(
      'bun ./scripts/check-onlyoffice-dev-health.ts "http://127.0.0.1:$$vite_port" --checkout "$(CURDIR)/onlyoffice-browser"',
    );
  });

  it("checks the isolated host page, entry bundle, manifest, and release identity", async () => {
    const fetchImpl = healthyFetch();

    const result = await checkOnlyOfficeDevHealth({
      frontendUrl: "http://127.0.0.1:3458",
      runtimeIdentity,
      fetchImpl,
    });

    expect(result).toEqual({
      hostUrl: expect.stringContaining(".office.localhost:3458/office-host.html"),
      bundlePath: "/assets/officeHost-health.js",
      runtimeIdentity,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("rejects a served runtime manifest that does not match the release identity", async () => {
    await expect(
      checkOnlyOfficeDevHealth({
        frontendUrl: "http://127.0.0.1:3458",
        runtimeIdentity: { ...runtimeIdentity, assetManifestDigest: "0".repeat(64) },
        fetchImpl: healthyFetch(),
      }),
    ).rejects.toThrow("runtime manifest digest mismatch");
  });
});
