import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlyOfficeRuntimeIdentity } from "../web/server/onlyoffice-runtime-identity.ts";

export type OnlyOfficeRuntimeIdentity = {
  packageVersion: string;
  hostBuildId: string;
  assetManifestDigest: string;
};

type CheckOnlyOfficeDevHealthOptions = {
  frontendUrl: string;
  runtimeIdentity: OnlyOfficeRuntimeIdentity;
  hostUrlTemplate?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OnlyOfficeDevHealth = {
  hostUrl: string;
  bundlePath: string;
  runtimeIdentity: OnlyOfficeRuntimeIdentity;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleaseManifestPath = resolve(rootDir, "release/onlyoffice-release-manifest.json");
const healthSessionId = "office-editor-health";
const pluginGuid = "asc.{7F1B98C4-21D8-4D6B-A7F0-9E8506E23A10}";

function fail(message: string): never {
  throw new Error(`[onlyoffice-browser] health check failed: ${message}`);
}

function isolatedHostUrl(frontendUrl: string, hostUrlTemplate = ""): URL {
  const parent = new URL(frontendUrl);
  let host: URL;
  if (hostUrlTemplate.trim()) {
    host = new URL(
      hostUrlTemplate
        .replaceAll("{sessionId}", healthSessionId)
        .replaceAll("{rawSessionId}", encodeURIComponent(healthSessionId))
        .replaceAll("{hostname}", parent.hostname)
        .replaceAll("{origin}", parent.origin)
        .replaceAll("{protocol}", parent.protocol.replace(/:$/, ""))
        .replaceAll("{port}", parent.port),
    );
  } else {
    host = new URL("/office-host.html", parent);
    if (parent.hostname === "127.0.0.1" || parent.hostname === "localhost") {
      host.hostname = `host-${healthSessionId}.office.localhost`;
    } else {
      host.hostname = `${healthSessionId}.office-host.${parent.hostname}`;
    }
  }
  host.searchParams.set("sessionId", healthSessionId);
  host.searchParams.set("parentOrigin", parent.origin);
  return host;
}

async function fetchRequired(
  fetchImpl: FetchLike,
  url: URL,
  label: string,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(
      `${label} is unreachable at ${url.href}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!response.ok) fail(`${label} returned HTTP ${response.status} at ${url.href}`);
  return response;
}

function requireContentType(response: Response, expected: string, label: string): void {
  const actual = response.headers.get("content-type") || "";
  if (!actual.toLowerCase().includes(expected)) {
    fail(`${label} returned unexpected content type ${actual || "(missing)"}`);
  }
}

export async function checkOnlyOfficeDevHealth({
  frontendUrl,
  runtimeIdentity,
  hostUrlTemplate = "",
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: CheckOnlyOfficeDevHealthOptions): Promise<OnlyOfficeDevHealth> {
  const hostUrl = isolatedHostUrl(frontendUrl, hostUrlTemplate);
  const hostResponse = await fetchRequired(fetchImpl, hostUrl, "office host page", timeoutMs);
  requireContentType(hostResponse, "text/html", "office host page");
  if (hostResponse.headers.get("origin-agent-cluster") !== "?1") {
    fail("office host page is missing Origin-Agent-Cluster: ?1");
  }

  const hostHtml = await hostResponse.text();
  const bundleMatch = hostHtml.match(
    /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']*\/assets\/officeHost-[^"']+\.js)["'][^>]*>/i,
  );
  if (!bundleMatch?.[1]) fail("office host page does not reference its module entry bundle");

  const bundleUrl = new URL(bundleMatch[1], hostUrl);
  const bundleResponse = await fetchRequired(fetchImpl, bundleUrl, "office host bundle", timeoutMs);
  requireContentType(bundleResponse, "javascript", "office host bundle");
  const bundle = await bundleResponse.text();
  for (const signature of [
    runtimeIdentity.packageVersion,
    runtimeIdentity.hostBuildId,
    "HOST_READY",
    "/onlyoffice-runtime-assets.json",
    "onlyoffice-browser-plugin/v1",
    "pluginInstanceId",
    "INVOKE_PLUGIN",
    "PLUGIN_READY",
  ]) {
    if (!bundle.includes(signature))
      fail(`office host bundle is missing runtime signature ${signature}`);
  }

  const manifestUrl = new URL("/onlyoffice-runtime-assets.json", hostUrl);
  const manifestResponse = await fetchRequired(
    fetchImpl,
    manifestUrl,
    "office runtime manifest",
    timeoutMs,
  );
  requireContentType(manifestResponse, "application/json", "office runtime manifest");
  const manifest = Buffer.from(await manifestResponse.arrayBuffer());
  const actualDigest = createHash("sha256").update(manifest).digest("hex");
  if (actualDigest !== runtimeIdentity.assetManifestDigest) {
    fail(
      `runtime manifest digest mismatch (expected ${runtimeIdentity.assetManifestDigest}, received ${actualDigest})`,
    );
  }

  const pluginConfigUrl = new URL("/onlyoffice-plugin/config.json", hostUrl);
  const pluginConfigResponse = await fetchRequired(
    fetchImpl,
    pluginConfigUrl,
    "Piwork ONLYOFFICE plugin config",
    timeoutMs,
  );
  requireContentType(pluginConfigResponse, "application/json", "Piwork ONLYOFFICE plugin config");
  const pluginConfig = (await pluginConfigResponse.json()) as {
    guid?: unknown;
    variations?: Array<{ url?: unknown }>;
  };
  if (pluginConfig.guid !== pluginGuid) {
    fail(`Piwork ONLYOFFICE plugin config has an unexpected guid at ${pluginConfigUrl.href}`);
  }
  const pluginEntry = pluginConfig.variations?.[0]?.url;
  if (typeof pluginEntry !== "string" || !pluginEntry.trim()) {
    fail(`Piwork ONLYOFFICE plugin config has no entry URL at ${pluginConfigUrl.href}`);
  }
  const pluginEntryUrl = new URL(pluginEntry, pluginConfigUrl);
  const pluginEntryResponse = await fetchRequired(
    fetchImpl,
    pluginEntryUrl,
    "Piwork ONLYOFFICE plugin entry",
    timeoutMs,
  );
  requireContentType(pluginEntryResponse, "text/html", "Piwork ONLYOFFICE plugin entry");
  const pluginEntryHtml = await pluginEntryResponse.text();
  if (!/<script\b[^>]*\bsrc=["']plugin\.js["']/i.test(pluginEntryHtml)) {
    fail(`Piwork ONLYOFFICE plugin entry does not load plugin.js at ${pluginEntryUrl.href}`);
  }

  const pluginScriptUrl = new URL("plugin.js", pluginEntryUrl);
  const pluginScriptResponse = await fetchRequired(
    fetchImpl,
    pluginScriptUrl,
    "Piwork ONLYOFFICE plugin script",
    timeoutMs,
  );
  requireContentType(pluginScriptResponse, "javascript", "Piwork ONLYOFFICE plugin script");
  const pluginScript = await pluginScriptResponse.text();
  for (const signature of [
    "onlyoffice-browser-plugin/v1",
    "pluginInstanceId",
    "window.parent.parent",
    "get_document_text",
    "get_range_values",
    "get_charts_info",
    "insert_chart",
    "get_presentation_info",
    "append_slide",
  ]) {
    if (!pluginScript.includes(signature)) {
      fail(`Piwork ONLYOFFICE plugin script is missing bridge signature ${signature}`);
    }
  }

  return {
    hostUrl: hostUrl.href,
    bundlePath: bundleUrl.pathname,
    runtimeIdentity: { ...runtimeIdentity },
  };
}

async function readReleaseIdentity(
  path = defaultReleaseManifestPath,
): Promise<OnlyOfficeRuntimeIdentity> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    runtimeIdentity?: Partial<OnlyOfficeRuntimeIdentity>;
  };
  const identity = manifest.runtimeIdentity;
  if (
    !identity ||
    typeof identity.packageVersion !== "string" ||
    typeof identity.hostBuildId !== "string" ||
    typeof identity.assetManifestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.assetManifestDigest)
  ) {
    fail(`release manifest has an invalid runtime identity: ${path}`);
  }
  return identity as OnlyOfficeRuntimeIdentity;
}

if (import.meta.main) {
  const frontendUrl = process.argv[2];
  const checkoutFlagIndex = process.argv.indexOf("--checkout");
  const checkoutDir = checkoutFlagIndex >= 0 ? process.argv[checkoutFlagIndex + 1] : undefined;
  if (!frontendUrl) {
    console.error(
      "Usage: bun scripts/check-onlyoffice-dev-health.ts FRONTEND_URL [--checkout ONLYOFFICE_BROWSER_DIR]",
    );
    process.exit(2);
  }
  if (checkoutFlagIndex >= 0 && !checkoutDir) {
    console.error("--checkout requires an onlyoffice-browser directory");
    process.exit(2);
  }
  try {
    const result = await checkOnlyOfficeDevHealth({
      frontendUrl,
      hostUrlTemplate: process.env.VITE_PIWORK_ONLYOFFICE_HOST_URL_TEMPLATE,
      runtimeIdentity: checkoutDir
        ? await readOnlyOfficeRuntimeIdentity(checkoutDir)
        : await readReleaseIdentity(),
    });
    console.log(
      `[onlyoffice-browser] healthy: ${result.runtimeIdentity.hostBuildId} via ${result.bundlePath}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
