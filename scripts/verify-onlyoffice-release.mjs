#!/usr/bin/env node

// Piwork deliberately verifies a published descriptor.  It must never clone,
// build, or inspect an onlyoffice-browser checkout: the iframe runtime belongs
// to that repository and is consumed here only by its immutable identity.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "release", "onlyoffice-release-manifest.json");
const commitPattern = /^[0-9a-f]{40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legacySchema4ReleaseIds = new Set(["v0.5.12-fd3fbc60abd50785"]);

function fail(message) {
  throw new Error(`[onlyoffice-release] ${message}`);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function requireDigest(value, label) {
  assert(/^[0-9a-f]{64}$/.test(value || ""), `${label} is invalid`);
  return value;
}
function requireCommit(value, label) {
  assert(commitPattern.test(value || ""), `${label} is invalid`);
  return value;
}
function requireRunId(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} is invalid`);
  return value;
}
function requireUuid(value, label) {
  assert(uuidPattern.test(value || ""), `${label} is invalid`);
  return value;
}
function requireReleaseId(value) {
  assert(/^[a-zA-Z0-9._+-]{1,128}$/.test(value || ""), "immutable release ID is invalid");
  return value;
}

function normalizeHttpsOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`[onlyoffice-release] ${label} is invalid`, { cause: error });
  }
  assert(
    url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    `${label} must be an HTTPS origin`,
  );
  return url.origin;
}

function cspDirectiveSources(policy, name) {
  const directive = policy
    .split(";")
    .map((value) => value.trim().split(/\s+/))
    .find(([candidate]) => candidate?.toLowerCase() === name);
  return directive?.slice(1) || [];
}

function npmPackagePurl(name, version) {
  return `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${version}`;
}

function requiredArtifact(manifest, repository, kind) {
  const matches = (manifest.artifacts || []).filter(
    (entry) => entry?.repository === repository && entry?.kind === kind,
  );
  assert(
    matches.length === 1,
    `descriptor must contain exactly one ${repository}/${kind} artifact`,
  );
  const [artifact] = matches;
  assert(typeof artifact.path === "string" && artifact.path, `${kind} artifact path is missing`);
  requireDigest(artifact.sha256, `${kind} artifact digest`);
  return artifact;
}

export function validateOnlyOfficeIntegrationBase(
  manifest,
  { headCommit, eventBaseCommit, eventHeadCommit, isAncestor, mergeBase },
) {
  const integrationBaseCommit = requireCommit(
    manifest.repositories?.Piwork?.integrationBaseCommit,
    "Piwork integration base commit",
  );
  requireCommit(headCommit, "current HEAD commit");
  assert(typeof isAncestor === "function", "integration ancestry checker is missing");
  assert(
    isAncestor(integrationBaseCommit, headCommit),
    "Piwork integration base commit is not an ancestor of the current HEAD",
  );
  if (manifest.promotionReceipt) {
    const piworkIntegrationCommit = requireCommit(
      manifest.promotionReceipt.piworkIntegrationCommit,
      "promotion receipt Piwork integration commit",
    );
    assert(
      isAncestor(piworkIntegrationCommit, headCommit),
      "promotion receipt Piwork integration commit is not an ancestor of the current HEAD",
    );
  }

  const hasEventBase = Boolean(eventBaseCommit);
  const hasEventHead = Boolean(eventHeadCommit);
  assert(
    hasEventBase === hasEventHead,
    "pull request base and head commits must be provided together",
  );
  if (hasEventBase && hasEventHead) {
    requireCommit(eventBaseCommit, "pull request event base commit");
    requireCommit(eventHeadCommit, "pull request event head commit");
    const checksExactEventHead = eventHeadCommit === headCommit;
    const checksSyntheticMerge =
      isAncestor(eventBaseCommit, headCommit) && isAncestor(eventHeadCommit, headCommit);
    assert(
      checksExactEventHead || checksSyntheticMerge,
      "checked-out commit is neither the pull request head nor its synthetic merge commit",
    );
    assert(typeof mergeBase === "function", "integration merge-base resolver is missing");
    assert(
      mergeBase(eventBaseCommit, eventHeadCommit) === integrationBaseCommit,
      "descriptor integration base does not match the pull request merge base",
    );
  }
  return integrationBaseCommit;
}

function resolveGitCommit(ref) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`[onlyoffice-release] cannot resolve Git commit ${ref}`, { cause: error });
  }
}

function gitIsAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`cannot compare Git ancestry: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function gitMergeBase(left, right) {
  try {
    return execFileSync("git", ["merge-base", left, right], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error("[onlyoffice-release] cannot resolve pull request merge base", {
      cause: error,
    });
  }
}

export function validatePiworkReleaseInputs(manifest, repositoryRoot = root) {
  const piworkLockfiles = (manifest.lockfiles || []).filter(
    (entry) => entry?.repository === "Piwork",
  );
  const requiredLockfiles = piworkLockfiles.filter((entry) => entry.path === "web/bun.lock");
  assert(
    requiredLockfiles.length === 1,
    "descriptor must contain exactly one Piwork web/bun.lock entry",
  );
  for (const entry of piworkLockfiles) {
    requireDigest(entry.sha256, `lockfile digest for ${entry.path}`);
    assert(typeof entry.path === "string" && entry.path, "Piwork lockfile path is missing");
    const target = resolve(repositoryRoot, entry.path);
    const pathFromRoot = relative(repositoryRoot, target);
    assert(
      pathFromRoot && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot),
      `Piwork lockfile path escapes the repository: ${entry.path}`,
    );
    assert(
      digest(readFileSync(target)) === entry.sha256,
      `Piwork lockfile digest mismatch: ${entry.path}`,
    );
  }
}

export function validateOnlyOfficeDescriptor(
  manifest,
  { rootPackage, webPackage, allowCandidate = false },
) {
  assert([4, 5].includes(manifest.schemaVersion), "unsupported manifest schemaVersion");
  assert(
    JSON.stringify(manifest.releaseOrder) ===
      JSON.stringify(["onlyoffice-x2t-wasm", "onlyoffice-browser", "Piwork"]),
    "release order must be x2t -> onlyoffice-browser -> Piwork",
  );
  for (const name of ["onlyoffice-x2t-wasm", "onlyoffice-browser"]) {
    const repository = manifest.repositories?.[name];
    assert(
      repository && commitPattern.test(repository.commitSha),
      `invalid immutable commit for ${name}`,
    );
    assert(
      typeof repository.version === "string" && repository.version,
      `missing version for ${name}`,
    );
  }
  const piwork = manifest.repositories?.Piwork;
  assert(
    piwork && typeof piwork.version === "string" && piwork.version,
    "missing version for Piwork",
  );
  requireCommit(piwork.integrationBaseCommit, "Piwork integration base commit");
  assert(
    !Object.prototype.hasOwnProperty.call(piwork, "commitSha"),
    "Piwork descriptor must not contain a self-referential commitSha",
  );
  const office = manifest.repositories["onlyoffice-browser"];
  assert(
    rootPackage.version === manifest.repositories.Piwork.version,
    "Piwork version does not match the release manifest",
  );
  requiredArtifact(manifest, "onlyoffice-browser", "x2t-wasm");
  assert(webPackage.version === rootPackage.version, "web package version does not match Piwork");
  assert(
    webPackage.dependencies?.[manifest.npmPackage.name] === manifest.npmPackage.version,
    "Piwork OnlyOffice dependency is not exact",
  );
  assert(
    manifest.npmPackage.name === "@agentbridges-ai/onlyoffice-browser",
    "OnlyOffice package name is invalid",
  );
  assert(
    manifest.npmPackage.version === office.version,
    "OnlyOffice source and npm versions differ",
  );
  assert(
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.npmPackage.integrity || ""),
    "npm package integrity is invalid",
  );
  assert(
    /^[0-9a-f]{40}$/.test(manifest.npmPackage.sourceCommit || ""),
    "npm proxy API source commit is invalid",
  );
  assert(
    manifest.npmPackage.gitHead === manifest.npmPackage.sourceCommit,
    "npm gitHead must bind the npm proxy API source commit",
  );
  requireReleaseId(manifest.releaseManifest?.releaseId);
  assert(manifest.releaseManifest?.version === 5, "release manifest version must be 5");
  assert(
    manifest.releaseManifest?.channel === "stable-v5",
    "release manifest channel must be stable-v5",
  );
  requireDigest(manifest.releaseManifest?.sha256, "release manifest digest");
  requireDigest(manifest.releaseManifest?.hostBuildId, "release manifest host build ID");
  requireDigest(
    manifest.runtimeIdentity?.assetManifestDigest,
    "runtime identity asset manifest digest",
  );
  assert(
    /^[0-9a-f]{40}$/.test(manifest.runtimeIdentity?.sourceCommit || ""),
    "runtime Host source commit is invalid",
  );
  assert(
    manifest.runtimeIdentity.sourceCommit === office.commitSha,
    "runtime Host source commit must bind the browser runtime source",
  );
  assert(
    manifest.runtimeIdentity?.packageVersion === manifest.npmPackage.version,
    "runtime identity package version mismatch",
  );
  assert(
    typeof manifest.runtimeIdentity?.hostBuildId === "string" &&
      manifest.runtimeIdentity.hostBuildId,
    "runtime identity hostBuildId is missing",
  );
  assert(
    manifest.lifecycle === "supported" || (allowCandidate && manifest.lifecycle === "candidate"),
    allowCandidate
      ? "Piwork can only verify a candidate or supported release"
      : "Piwork can only pin a supported release",
  );
  if (manifest.schemaVersion === 4) {
    assert(
      manifest.lifecycle === "supported" &&
        legacySchema4ReleaseIds.has(manifest.releaseManifest.releaseId),
      "schema 4 is restricted to the allowlisted legacy supported release",
    );
  }
  normalizeHttpsOrigin(manifest.deployment?.canonicalOrigin, "canonical deployment origin");
  normalizeHttpsOrigin(manifest.deployment?.editorOrigin, "editor deployment origin");
  const receipt = manifest.promotionReceipt;
  if (manifest.schemaVersion === 5 && manifest.lifecycle === "supported") {
    assert(receipt, "schema 5 supported releases require an immutable promotion receipt");
  }
  if (receipt) {
    assert(receipt.version === 1, "promotion receipt version must be 1");
    requireDigest(receipt.sha256, "promotion receipt digest");
    requireCommit(receipt.piworkIntegrationCommit, "promotion receipt Piwork integration commit");
    requireRunId(receipt.deepVerifyRunId, "promotion receipt deep verify run ID");
    requireRunId(receipt.deepVerifyRunAttempt, "promotion receipt deep verify run attempt");
    requireRunId(receipt.stagingRunId, "promotion receipt staging run ID");
    requireRunId(receipt.productionRunId, "promotion receipt production run ID");
    const path = receipt.path?.match(
      /^\/promotions\/([a-zA-Z0-9._+-]{1,128})\/([0-9a-f]{40})-([0-9a-f]{64})\.json$/,
    );
    assert(path, "promotion receipt path is invalid");
    assert(
      path[1] === manifest.releaseManifest.releaseId,
      "promotion receipt path release mismatch",
    );
    assert(
      path[2] === manifest.runtimeIdentity.sourceCommit,
      "promotion receipt path candidate mismatch",
    );
    assert(path[3] === receipt.sha256, "promotion receipt path digest mismatch");
  }
  return manifest;
}

async function jsonResponse(fetchImpl, url, label, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.status === 200, `${label} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    return { response, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`[onlyoffice-release] ${label} is not JSON`, { cause: error });
  }
}

async function githubJsonResponse(fetchImpl, url, label, githubToken) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === "https:" &&
      parsed.hostname === "api.github.com" &&
      !parsed.username &&
      !parsed.password,
    `${label} URL is not GitHub API-owned`,
  );
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  return jsonResponse(fetchImpl, parsed.href, label, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export async function verifyPublishedOnlyOfficeRelease(
  manifest,
  fetchImpl = fetch,
  { githubToken = process.env.GITHUB_TOKEN } = {},
) {
  const npm = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(manifest.npmPackage.name)}/${manifest.npmPackage.version}`,
    { cache: "no-store", signal: AbortSignal.timeout(10_000) },
  );
  assert(npm.status === 200, `npm registry returned HTTP ${npm.status}`);
  const npmPackage = await npm.json();
  assert(npmPackage.version === manifest.npmPackage.version, "npm registry version mismatch");
  assert(
    npmPackage.dist?.integrity === manifest.npmPackage.integrity,
    "npm registry integrity mismatch",
  );
  assert(npmPackage.gitHead === manifest.npmPackage.gitHead, "npm registry gitHead mismatch");
  const attestationUrl = npmPackage.dist?.attestations?.url;
  assert(attestationUrl, "npm registry provenance attestation is missing");
  const parsedAttestationUrl = new URL(attestationUrl);
  assert(
    parsedAttestationUrl.protocol === "https:" &&
      parsedAttestationUrl.hostname === "registry.npmjs.org" &&
      !parsedAttestationUrl.username &&
      !parsedAttestationUrl.password,
    "npm provenance attestation URL is not registry-owned",
  );
  const attestation = await jsonResponse(fetchImpl, attestationUrl, "npm provenance attestation");
  const sriSha512 = Buffer.from(
    manifest.npmPackage.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  const slsa = attestation.value.attestations?.find(
    (entry) =>
      entry?.predicateType === "https://slsa.dev/provenance/v1" &&
      entry?.bundle?.dsseEnvelope?.payload,
  );
  assert(slsa, "npm provenance SLSA attestation is missing");
  let statement;
  try {
    statement = JSON.parse(
      Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    );
  } catch {
    fail("npm provenance SLSA payload is invalid");
  }
  const expectedPurl = npmPackagePurl(manifest.npmPackage.name, manifest.npmPackage.version);
  assert(
    statement?._type === "https://in-toto.io/Statement/v1" &&
      statement?.predicateType === "https://slsa.dev/provenance/v1",
    "npm provenance statement identity is invalid",
  );
  assert(
    statement?.subject?.some(
      (subject) => subject?.name === expectedPurl && subject?.digest?.sha512 === sriSha512,
    ),
    "npm provenance subject does not bind the package integrity",
  );
  const buildDefinition = statement?.predicate?.buildDefinition;
  assert(
    buildDefinition?.resolvedDependencies?.some(
      (dependency) =>
        dependency?.digest?.gitCommit === manifest.npmPackage.gitHead &&
        dependency?.uri ===
          `git+https://github.com/agentbridges-ai/onlyoffice-browser@refs/tags/v${manifest.npmPackage.version}`,
    ),
    "npm provenance source does not bind npm gitHead and signed tag",
  );
  assert(
    buildDefinition?.externalParameters?.workflow?.repository ===
      "https://github.com/agentbridges-ai/onlyoffice-browser" &&
      buildDefinition.externalParameters.workflow.path === ".github/workflows/release-npm.yml" &&
      buildDefinition.externalParameters.workflow.ref ===
        `refs/tags/v${manifest.npmPackage.version}`,
    "npm provenance workflow identity is invalid",
  );

  const canonicalOrigin = normalizeHttpsOrigin(
    manifest.deployment.canonicalOrigin,
    "canonical deployment origin",
  );
  const editorOrigin = normalizeHttpsOrigin(
    manifest.deployment.editorOrigin,
    "editor deployment origin",
  );
  const releaseId = manifest.releaseManifest.releaseId;
  const pointer = await jsonResponse(
    fetchImpl,
    `${canonicalOrigin}/channels/stable-v5.json`,
    "stable-v5 pointer",
  );
  assert(
    pointer.response.headers.get("cache-control")?.startsWith("no-store"),
    "stable-v5 pointer must be no-store",
  );
  // Stable is observable operational state, not Piwork's authority. Existing
  // sessions stay pinned to this immutable release until their integration PR
  // explicitly advances the descriptor.
  const runtimeManifest = await jsonResponse(
    fetchImpl,
    `${canonicalOrigin}/releases/${encodeURIComponent(releaseId)}/manifest.json`,
    "immutable runtime manifest",
  );
  assert(
    digest(runtimeManifest.bytes) === manifest.releaseManifest.sha256,
    "immutable runtime manifest digest mismatch",
  );
  assert(
    runtimeManifest.value.releaseId === releaseId && runtimeManifest.value.version === 5,
    "immutable runtime manifest identity mismatch",
  );
  assert(
    /(?:^|,)\s*immutable(?:,|$)/.test(runtimeManifest.response.headers.get("cache-control") || ""),
    "immutable runtime manifest cache policy is invalid",
  );
  assert(
    runtimeManifest.value.runtimeManifestSha256 === manifest.runtimeIdentity.assetManifestDigest,
    "runtime asset identity mismatch",
  );
  assert(
    runtimeManifest.value.packageVersion === manifest.npmPackage.version &&
      runtimeManifest.value.hostBuildId === manifest.releaseManifest.hostBuildId,
    "runtime package or Host build identity mismatch",
  );
  assert(
    runtimeManifest.value.x2t?.version === manifest.repositories["onlyoffice-x2t-wasm"].version &&
      runtimeManifest.value.x2t?.commit === manifest.repositories["onlyoffice-x2t-wasm"].commitSha,
    "runtime x2t identity mismatch",
  );
  assert(
    runtimeManifest.value.x2t?.sha256 ===
      requiredArtifact(manifest, "onlyoffice-browser", "x2t-wasm").sha256,
    "runtime x2t WASM digest mismatch",
  );
  if (manifest.schemaVersion === 5) {
    assert(
      runtimeManifest.value.sourceCommit === manifest.runtimeIdentity.sourceCommit,
      "schema 5 runtime manifest source commit mismatch",
    );
  } else if (runtimeManifest.value.sourceCommit !== undefined) {
    assert(
      runtimeManifest.value.sourceCommit === manifest.runtimeIdentity.sourceCommit,
      "runtime manifest source commit mismatch",
    );
  }

  let promotedWorkerVersionId;
  if (manifest.promotionReceipt) {
    const promotion = manifest.promotionReceipt;
    const receipt = await jsonResponse(
      fetchImpl,
      `${canonicalOrigin}${promotion.path}`,
      "immutable promotion receipt",
    );
    assert(
      digest(receipt.bytes) === promotion.sha256,
      "immutable promotion receipt digest mismatch",
    );
    assert(
      /(?:^|,)\s*immutable(?:,|$)/.test(receipt.response.headers.get("cache-control") || ""),
      "promotion receipt cache policy is invalid",
    );
    const value = receipt.value;
    assert(value.version === 1, "promotion receipt version mismatch");
    assert(
      value.trustRoot === "protected-production-workflow-and-r2-cas",
      "promotion receipt trust root mismatch",
    );
    assert(
      value.channel === manifest.releaseManifest.channel,
      "promotion receipt channel mismatch",
    );
    assert(
      value.candidate?.commit === manifest.runtimeIdentity.sourceCommit,
      "promotion receipt candidate commit mismatch",
    );
    requireRunId(value.candidate?.runId, "promotion receipt candidate run ID");
    assert(
      value.staging?.runId === promotion.stagingRunId,
      "promotion receipt staging run mismatch",
    );
    assert(
      value.piwork?.commit === promotion.piworkIntegrationCommit &&
        value.piwork?.deepVerifyRunId === promotion.deepVerifyRunId &&
        value.piwork?.deepVerifyRunAttempt === promotion.deepVerifyRunAttempt,
      "promotion receipt Piwork integration mismatch",
    );
    const deepVerifyRun = await githubJsonResponse(
      fetchImpl,
      `https://api.github.com/repos/agentbridges-ai/pi-work/actions/runs/${promotion.deepVerifyRunId}/attempts/${promotion.deepVerifyRunAttempt}`,
      "Piwork deep verify workflow run",
      githubToken,
    );
    assert(
      deepVerifyRun.value.id === promotion.deepVerifyRunId &&
        deepVerifyRun.value.run_attempt === promotion.deepVerifyRunAttempt &&
        deepVerifyRun.value.conclusion === "success" &&
        deepVerifyRun.value.event === "workflow_dispatch" &&
        deepVerifyRun.value.head_sha === promotion.piworkIntegrationCommit &&
        deepVerifyRun.value.repository?.full_name === "agentbridges-ai/pi-work" &&
        deepVerifyRun.value.path === ".github/workflows/deep-verify.yml",
      "Piwork deep verify workflow run identity or conclusion mismatch",
    );
    const deepVerifyJobs = await githubJsonResponse(
      fetchImpl,
      `https://api.github.com/repos/agentbridges-ai/pi-work/actions/runs/${promotion.deepVerifyRunId}/attempts/${promotion.deepVerifyRunAttempt}/jobs?per_page=100`,
      "Piwork deep verify workflow jobs",
      githubToken,
    );
    const expectedCandidateJobName = `OnlyOffice candidate integration / ${releaseId}`;
    const candidateJobs = (deepVerifyJobs.value.jobs || []).filter(
      (job) => job?.name === expectedCandidateJobName,
    );
    assert(
      deepVerifyJobs.value.total_count === deepVerifyJobs.value.jobs?.length &&
        candidateJobs.length === 1 &&
        candidateJobs[0].run_id === promotion.deepVerifyRunId &&
        candidateJobs[0].head_sha === promotion.piworkIntegrationCommit &&
        candidateJobs[0].status === "completed" &&
        candidateJobs[0].conclusion === "success",
      "Piwork candidate integration job identity or conclusion mismatch",
    );
    const expectedManifestUrl = `/releases/${encodeURIComponent(releaseId)}/manifest.json`;
    assert(
      value.runtime?.releaseId === releaseId &&
        value.runtime?.manifestUrl === expectedManifestUrl &&
        value.runtime?.manifestSha256 === manifest.releaseManifest.sha256 &&
        value.runtime?.runtimeManifestSha256 === manifest.runtimeIdentity.assetManifestDigest,
      "promotion receipt runtime identity mismatch",
    );
    const previousStableId = requireReleaseId(value.previousStable?.releaseId);
    assert(
      value.previousStable?.manifestUrl ===
        `/releases/${encodeURIComponent(previousStableId)}/manifest.json`,
      "promotion receipt previous stable URL mismatch",
    );
    requireDigest(
      value.previousStable?.manifestSha256,
      "promotion receipt previous stable manifest digest",
    );
    assert(
      value.worker?.name === "onlyoffice-browser-runtime",
      "promotion receipt Worker name mismatch",
    );
    const previousWorkerVersionId = requireUuid(
      value.worker?.previousVersionId,
      "promotion receipt previous Worker version ID",
    );
    const candidateWorkerVersionId = requireUuid(
      value.worker?.candidateVersionId,
      "promotion receipt candidate Worker version ID",
    );
    promotedWorkerVersionId = candidateWorkerVersionId;
    requireUuid(value.worker?.finalDeploymentId, "promotion receipt final Worker deployment ID");
    assert(
      previousWorkerVersionId !== candidateWorkerVersionId,
      "promotion receipt Worker versions must be distinct",
    );
    assert(
      value.runtimeRoot?.mode === "stable-v5-release-cas",
      "promotion receipt runtime root mode mismatch",
    );
    assert(
      value.production?.repository === "agentbridges-ai/onlyoffice-browser" &&
        value.production?.runId === promotion.productionRunId,
      "promotion receipt production workflow mismatch",
    );
    const productionRunAttempt = requireRunId(
      value.production?.runAttempt,
      "promotion receipt production run attempt",
    );
    const productionRun = await githubJsonResponse(
      fetchImpl,
      `https://api.github.com/repos/agentbridges-ai/onlyoffice-browser/actions/runs/${promotion.productionRunId}/attempts/${productionRunAttempt}`,
      "promotion workflow run",
      githubToken,
    );
    assert(
      productionRun.value.id === promotion.productionRunId &&
        productionRun.value.run_attempt === productionRunAttempt &&
        productionRun.value.conclusion === "success" &&
        productionRun.value.event === "workflow_dispatch" &&
        productionRun.value.head_sha === manifest.runtimeIdentity.sourceCommit &&
        productionRun.value.head_branch === "main" &&
        productionRun.value.repository?.full_name === "agentbridges-ai/onlyoffice-browser" &&
        productionRun.value.path === ".github/workflows/deploy-r2.yml",
      "promotion workflow run identity or conclusion mismatch",
    );
  }

  const host = await fetchImpl(
    `${editorOrigin}/r/${encodeURIComponent(releaseId)}/office-host.html`,
    { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(10_000) },
  );
  assert(host.status === 200, `exact release Host returned HTTP ${host.status}`);
  assert(
    /^text\/html(?:;|$)/i.test(host.headers.get("content-type") || ""),
    "exact release Host content type is invalid",
  );
  assert(
    host.headers.get("x-onlyoffice-asset-version") === releaseId,
    "exact release Host identity header mismatch",
  );
  assert(
    host.headers.get("origin-agent-cluster") === "?1",
    "exact release Host is missing Origin-Agent-Cluster",
  );
  assert(
    /(?:^|,)\s*immutable(?:,|$)/.test(host.headers.get("cache-control") || ""),
    "exact release Host cache policy is invalid",
  );
  if (manifest.promotionReceipt) {
    const hostWorkerVersionId = requireUuid(
      host.headers.get("x-onlyoffice-worker-version"),
      "exact release Host Worker version",
    );
    assert(
      hostWorkerVersionId === promotedWorkerVersionId,
      "exact release Host Worker version does not match the promotion receipt",
    );
  }
  const csp = host.headers.get("content-security-policy") || "";
  assert(
    cspDirectiveSources(csp, "frame-ancestors").includes("https://piwork.getpi.work"),
    "exact release Host CSP does not permit Piwork embedding",
  );
  return {
    releaseId,
    npmIntegrity: npmPackage.dist.integrity,
    observedStableReleaseId: pointer.value.releaseId,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const allowCandidate = process.argv.includes("--allow-candidate");
  const candidateIntegration = process.argv.includes("--candidate-integration");
  const online = process.argv.includes("--online");
  const manifest = validateOnlyOfficeDescriptor(readJson(manifestPath), {
    rootPackage: readJson(join(root, "package.json")),
    webPackage: readJson(join(root, "web", "package.json")),
    allowCandidate,
  });
  validatePiworkReleaseInputs(manifest);
  validateOnlyOfficeIntegrationBase(manifest, {
    headCommit: resolveGitCommit("HEAD"),
    eventBaseCommit: process.env.ONLYOFFICE_INTEGRATION_EVENT_BASE_SHA?.trim(),
    eventHeadCommit: process.env.ONLYOFFICE_INTEGRATION_EVENT_HEAD_SHA?.trim(),
    isAncestor: gitIsAncestor,
    mergeBase: gitMergeBase,
  });
  const expectedReleaseId = process.env.ONLYOFFICE_EXPECTED_RELEASE_ID?.trim();
  if (expectedReleaseId) {
    requireReleaseId(expectedReleaseId);
    assert(
      manifest.releaseManifest.releaseId === expectedReleaseId,
      "descriptor release ID does not match the requested candidate integration release",
    );
  }
  if (candidateIntegration) {
    assert(allowCandidate && online, "candidate integration requires --online --allow-candidate");
    assert(expectedReleaseId, "candidate integration requires ONLYOFFICE_EXPECTED_RELEASE_ID");
    assert(
      manifest.lifecycle === "candidate",
      "candidate integration requires candidate lifecycle",
    );
  }
  if (online) await verifyPublishedOnlyOfficeRelease(manifest);
  console.log(
    `[onlyoffice-release] verified descriptor ${manifest.npmPackage.name}@${manifest.npmPackage.version}${online ? " against registry and immutable runtime" : ""}`,
  );
}
