import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type OnlyOfficeRuntimeIdentity = {
  packageVersion: string;
  hostBuildId: string;
  assetManifestDigest: string;
  releaseId: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Options = {
  frontendUrl: string;
  runtimeIdentity: OnlyOfficeRuntimeIdentity;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReleaseManifestPath = resolve(rootDir, "release/onlyoffice-release-manifest.json");

function fail(message: string): never {
  throw new Error(`[onlyoffice-browser] health check failed: ${message}`);
}

function exactHostUrl(identity: OnlyOfficeRuntimeIdentity): URL {
  return new URL(
    `https://office-editor-health.getpi.work/r/${encodeURIComponent(identity.releaseId)}/office-host.html`,
  );
}

function frameAncestors(policy: string): string[] {
  const directive = policy
    .split(";")
    .map((value) => value.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === "frame-ancestors");
  return directive?.slice(1) || [];
}

export async function checkOnlyOfficeDevHealth({
  frontendUrl,
  runtimeIdentity,
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: Options) {
  // Piwork is a consumer: inspect only the immutable Host response envelope,
  // never Host bundles, fonts, SDK, WASM, or plugin internals.
  void new URL(frontendUrl);
  const hostUrl = exactHostUrl(runtimeIdentity);
  let response: Response;
  try {
    response = await fetchImpl(hostUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(
      `exact release Host is unreachable at ${hostUrl.href}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!response.ok) fail(`exact release Host returned HTTP ${response.status}`);
  if (!/^text\/html(?:;|$)/i.test(response.headers.get("content-type") || ""))
    fail("exact release Host has an invalid content type");
  if (response.headers.get("x-onlyoffice-asset-version") !== runtimeIdentity.releaseId)
    fail("exact release Host identity header mismatch");
  if (response.headers.get("origin-agent-cluster") !== "?1")
    fail("exact release Host is missing Origin-Agent-Cluster");
  const csp = response.headers.get("content-security-policy") || "";
  if (!frameAncestors(csp).includes("https://piwork.getpi.work"))
    fail("exact release Host CSP does not permit Piwork embedding");
  return { hostUrl: hostUrl.href, runtimeIdentity: { ...runtimeIdentity } };
}

async function readReleaseIdentity(
  path = defaultReleaseManifestPath,
): Promise<OnlyOfficeRuntimeIdentity> {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const identity = { ...manifest.runtimeIdentity, releaseId: manifest.releaseManifest?.releaseId };
  if (
    typeof identity.packageVersion !== "string" ||
    typeof identity.hostBuildId !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.assetManifestDigest || "") ||
    !/^[a-zA-Z0-9._+-]{1,128}$/.test(identity.releaseId || "")
  )
    fail(`release manifest has an invalid immutable runtime identity: ${path}`);
  return identity as OnlyOfficeRuntimeIdentity;
}

if (import.meta.main) {
  const frontendUrl = process.argv[2];
  if (!frontendUrl) {
    console.error("Usage: bun scripts/check-onlyoffice-dev-health.ts FRONTEND_URL");
    process.exit(2);
  }
  try {
    const result = await checkOnlyOfficeDevHealth({
      frontendUrl,
      runtimeIdentity: await readReleaseIdentity(),
    });
    console.log(`[onlyoffice-browser] immutable Host healthy: ${result.runtimeIdentity.releaseId}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
