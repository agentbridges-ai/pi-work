#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officeRoot = process.env.PIWORK_ONLYOFFICE_BROWSER_DIR
  ? resolve(process.env.PIWORK_ONLYOFFICE_BROWSER_DIR)
  : null;
const manifestPath = join(root, "release", "onlyoffice-release-manifest.json");

function fail(message) {
  throw new Error(`[onlyoffice-release] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd, args, options = {}) {
  const result = execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
  return typeof result === "string" ? result.trim() : "";
}

function safeResolve(base, path) {
  assert(
    typeof path === "string" && path && !isAbsolute(path),
    `unsafe artifact path: ${String(path)}`,
  );
  const target = resolve(base, path);
  const rel = relative(base, target);
  assert(
    rel && !rel.startsWith("..") && !isAbsolute(rel),
    `artifact escapes its repository: ${path}`,
  );
  return target;
}

const manifest = readJson(manifestPath);
assert(manifest.schemaVersion === 2, "unsupported manifest schemaVersion");
assert(
  JSON.stringify(manifest.releaseOrder) ===
    JSON.stringify(["onlyoffice-x2t-wasm", "onlyoffice-browser", "Piwork"]),
  "release order must be x2t -> onlyoffice-browser -> Piwork",
);

for (const name of manifest.releaseOrder) {
  const repository = manifest.repositories?.[name];
  assert(repository, `missing repository entry: ${name}`);
  assert(/^[0-9a-f]{40}$/.test(repository.commitSha), `invalid immutable commit for ${name}`);
  assert(
    typeof repository.version === "string" && repository.version,
    `missing version for ${name}`,
  );
}

const pinnedOffice = manifest.repositories["onlyoffice-browser"];
if (officeRoot) {
  assert(existsSync(join(officeRoot, ".git")), `OnlyOffice checkout is missing: ${officeRoot}`);
  assert(
    git(officeRoot, ["rev-parse", "HEAD"]) === pinnedOffice.commitSha,
    "OnlyOffice checkout is not at the pinned commit",
  );
  assert(
    git(officeRoot, ["status", "--porcelain", "--untracked-files=no"]) === "",
    "OnlyOffice checkout has tracked changes",
  );
}

const rootPackage = readJson(join(root, "package.json"));
const webPackage = readJson(join(root, "web", "package.json"));
assert(
  rootPackage.version === manifest.repositories.Piwork.version,
  "Piwork version does not match the release manifest",
);
assert(
  webPackage.version === manifest.repositories.Piwork.version,
  "web package version does not match Piwork",
);
assert(
  webPackage.dependencies?.[manifest.npmPackage.name] === manifest.npmPackage.version,
  "Piwork OnlyOffice dependency is not exact",
);
if (officeRoot) {
  const officePackage = readJson(join(officeRoot, "package.json"));
  assert(officePackage.name === manifest.npmPackage.name, "OnlyOffice package name mismatch");
  assert(officePackage.version === pinnedOffice.version, "OnlyOffice source version mismatch");
  assert(
    officePackage.packageManager === "pnpm@11.4.0",
    "OnlyOffice packageManager must remain pinned to pnpm@11.4.0",
  );
}
assert(
  manifest.npmPackage.publish === true,
  "the browser npm package must be the only publishable package in this manifest",
);
assert(
  manifest.runtimeIdentity?.packageVersion === manifest.npmPackage.version,
  "runtime identity package version mismatch",
);
assert(
  typeof manifest.runtimeIdentity?.hostBuildId === "string" && manifest.runtimeIdentity.hostBuildId,
  "runtime identity hostBuildId is missing",
);
assert(
  /^[0-9a-f]{64}$/.test(manifest.runtimeIdentity?.assetManifestDigest || ""),
  "runtime identity asset manifest digest is invalid",
);
assert(manifest.releaseManifest?.version === 5, "release manifest version must be 5");
assert(
  manifest.releaseManifest?.channel === "stable-v5",
  "release manifest channel must be stable-v5",
);
const escapedPackageVersion = manifest.npmPackage.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
assert(
  new RegExp(`^v${escapedPackageVersion}-[0-9a-f]{16}$`).test(
    manifest.releaseManifest?.releaseId || "",
  ),
  "immutable release ID is invalid",
);
assert(
  /^[0-9a-f]{64}$/.test(manifest.releaseManifest?.sha256 || ""),
  "release manifest digest is invalid",
);
assert(
  /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.npmPackage?.integrity || ""),
  "npm package integrity is invalid",
);

const repositoryRoots = {
  Piwork: root,
  ...(officeRoot ? { "onlyoffice-browser": officeRoot } : {}),
};

for (const entry of [...manifest.lockfiles, ...manifest.artifacts]) {
  const base = repositoryRoots[entry.repository];
  assert(/^[0-9a-f]{64}$/.test(entry.sha256), `invalid SHA-256 for ${entry.path}`);
  if (!base) continue;
  const target = safeResolve(base, entry.path);
  assert(existsSync(target), `missing release input: ${entry.path}`);
  assert(sha256(target) === entry.sha256, `digest mismatch: ${entry.path}`);
}

const compactArtifact = manifest.artifacts.find((entry) => entry.kind === "compact-asset-manifest");
const runtimeIdentity = manifest.runtimeIdentity;
assert(
  runtimeIdentity?.packageVersion === pinnedOffice.version,
  "Office runtime identity package version mismatch",
);
assert(
  typeof runtimeIdentity?.hostBuildId === "string" && runtimeIdentity.hostBuildId.length > 0,
  "Office host build ID is missing",
);
assert(
  runtimeIdentity?.assetManifestDigest === compactArtifact?.sha256,
  "Office runtime identity must bind the compact asset manifest digest",
);
if (officeRoot) {
  const hostArtifacts = manifest.artifacts.filter((entry) => entry.kind === "editor-host-bundle");
  assert(
    hostArtifacts.length === 1,
    "release manifest must identify exactly one editor host bundle",
  );
  const builtHostBundles = readdirSync(join(officeRoot, "dist", "assets"))
    .filter((name) => /^officeHost-.*\.js$/.test(name))
    .map((name) => `dist/assets/${name}`)
    .sort();
  assert(
    JSON.stringify(builtHostBundles) === JSON.stringify([hostArtifacts[0].path]),
    "built officeHost bundle does not match the manifest",
  );
  const hostBundleSource = readFileSync(safeResolve(officeRoot, hostArtifacts[0].path), "utf8");
  assert(
    hostBundleSource.includes(runtimeIdentity.hostBuildId),
    "built officeHost bundle does not contain the release build ID",
  );
  assert(
    hostBundleSource.includes("HOST_READY"),
    "built officeHost bundle does not contain the identity handshake",
  );

  const compact = readJson(join(officeRoot, "dist", "onlyoffice-runtime-assets.json"));
  assert([1, 2].includes(compact.version), "compact asset manifest version mismatch");
  assert(
    JSON.stringify(compact.types) === JSON.stringify(["word", "cell", "slide"]),
    "compact runtime types mismatch",
  );
  assert(
    JSON.stringify(compact.dictionaries) === JSON.stringify(["en_US"]),
    "compact runtime dictionary profile mismatch",
  );
  assert(compact.keepHelp === false, "compact runtime must exclude help assets");
  assert(
    ["core", "word", "cell", "slide"].every((pack) => Number(compact.packs?.[pack]) > 0),
    "compact runtime pack counts are incomplete",
  );
}

const rootHead = git(root, ["rev-parse", "HEAD"]);
const pinnedRoot = manifest.repositories.Piwork.commitSha;
if (rootHead !== pinnedRoot) {
  try {
    git(root, ["merge-base", "--is-ancestor", pinnedRoot, rootHead], { quiet: true });
  } catch {
    fail(`Piwork manifest commit ${pinnedRoot} is not an ancestor of ${rootHead}`);
  }
}

const optionalX2tRoot = process.env.PIWORK_ONLYOFFICE_X2T_DIR
  ? resolve(process.env.PIWORK_ONLYOFFICE_X2T_DIR)
  : null;
if (optionalX2tRoot) {
  assert(existsSync(join(optionalX2tRoot, ".git")), "configured x2t checkout is missing");
  assert(
    git(optionalX2tRoot, ["rev-parse", "HEAD"]) ===
      manifest.repositories["onlyoffice-x2t-wasm"].commitSha,
    "local x2t checkout is not at the pinned commit",
  );
}

console.log(
  `[onlyoffice-release] verified ${manifest.npmPackage.name}@${manifest.npmPackage.version}`,
);
console.log(`[onlyoffice-release] source ${pinnedOffice.commitSha}`);
