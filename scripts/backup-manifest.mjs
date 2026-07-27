#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const BACKUP_EXCLUSIONS = [
  ".cache",
  "cache",
  "caches",
  "checkouts",
  "recordings",
  "tmp",
  "user-space-checkouts",
];

const REQUIRED_ARTIFACTS = ["postgres.dump", "data.tar"];

function fail(message) {
  throw new Error(`[backup-manifest] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function safeArtifactPath(backupDir, relativePath) {
  assert(REQUIRED_ARTIFACTS.includes(relativePath), `unexpected artifact path: ${relativePath}`);
  assert(
    !isAbsolute(relativePath) && basename(relativePath) === relativePath,
    `unsafe artifact path: ${relativePath}`,
  );
  return join(backupDir, relativePath);
}

function assertOwnerOnly(stat, label) {
  if (process.platform !== "win32") {
    assert((stat.mode & 0o077) === 0, `${label} must not be accessible by group or other users`);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

function fsyncPath(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function artifactEntry(backupDir, path) {
  const fullPath = safeArtifactPath(backupDir, path);
  assert(existsSync(fullPath), `missing artifact: ${path}`);
  const stat = lstatSync(fullPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), `artifact must be a regular file: ${path}`);
  assertOwnerOnly(stat, path);
  return {
    path,
    size: stat.size,
    sha256: await sha256(fullPath),
  };
}

async function createManifest(args) {
  const [rawBackupDir, createdAt, sourceGitSha, piworkVersion, dataRootName] = args;
  assert(rawBackupDir, "create requires a backup directory");
  const backupDir = resolve(rawBackupDir);
  const backupDirStat = lstatSync(backupDir);
  assert(
    backupDirStat.isDirectory() && !backupDirStat.isSymbolicLink(),
    "backup path must be a real directory",
  );
  assertOwnerOnly(backupDirStat, "backup directory");
  assert(Number.isFinite(Date.parse(createdAt)), "createdAt must be an ISO timestamp");
  assert(/^[0-9a-f]{40}$/.test(sourceGitSha), "source git SHA must be immutable");
  assert(typeof piworkVersion === "string" && piworkVersion, "Piwork version is required");
  assert(
    dataRootName && basename(dataRootName) === dataRootName,
    "data root name must not contain a path",
  );

  const artifacts = [];
  for (const artifact of REQUIRED_ARTIFACTS)
    artifacts.push(await artifactEntry(backupDir, artifact));

  const manifest = {
    schemaVersion: 1,
    format: "piwork-maintenance-backup",
    createdAt: new Date(createdAt).toISOString(),
    source: {
      piworkVersion,
      gitSha: sourceGitSha,
      dataRootName,
      postgresDumpFormat: "custom",
    },
    policy: {
      recordingsIncluded: false,
      exclusions: BACKUP_EXCLUSIONS,
    },
    artifacts,
  };

  const target = join(backupDir, "manifest.json");
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  for (const artifact of REQUIRED_ARTIFACTS) fsyncPath(join(backupDir, artifact));
  fsyncPath(temporary);
  renameSync(temporary, target);
  fsyncPath(target);
  fsyncPath(backupDir);
  console.log(target);
}

async function verifyManifest(args) {
  const [rawBackupDir] = args;
  assert(rawBackupDir, "verify requires a backup directory");
  const backupDir = resolve(rawBackupDir);
  const backupDirStat = lstatSync(backupDir);
  assert(
    backupDirStat.isDirectory() && !backupDirStat.isSymbolicLink(),
    "backup path must be a real directory",
  );
  assertOwnerOnly(backupDirStat, "backup directory");
  const manifestPath = join(backupDir, "manifest.json");
  assert(existsSync(manifestPath), "manifest.json is missing");
  const manifestStat = lstatSync(manifestPath);
  assert(
    manifestStat.isFile() && !manifestStat.isSymbolicLink(),
    "manifest.json must be a regular file",
  );
  assertOwnerOnly(manifestStat, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert(manifest.schemaVersion === 1, "unsupported schemaVersion");
  assert(manifest.format === "piwork-maintenance-backup", "unexpected backup format");
  assert(Number.isFinite(Date.parse(manifest.createdAt)), "invalid createdAt");
  assert(/^[0-9a-f]{40}$/.test(manifest.source?.gitSha), "invalid source git SHA");
  assert(manifest.source?.postgresDumpFormat === "custom", "Postgres dump must use custom format");
  assert(manifest.policy?.recordingsIncluded === false, "recordings must be excluded by default");
  assert(
    JSON.stringify(manifest.policy?.exclusions) === JSON.stringify(BACKUP_EXCLUSIONS),
    "backup exclusion policy is incomplete",
  );
  assert(
    Array.isArray(manifest.artifacts) && manifest.artifacts.length === REQUIRED_ARTIFACTS.length,
    "artifact list is incomplete",
  );

  const recordedPaths = manifest.artifacts.map((artifact) => artifact.path).sort();
  assert(
    JSON.stringify(recordedPaths) === JSON.stringify([...REQUIRED_ARTIFACTS].sort()),
    "artifact names do not match the backup contract",
  );
  for (const recorded of manifest.artifacts) {
    assert(
      Number.isSafeInteger(recorded.size) && recorded.size >= 0,
      `invalid size for ${recorded.path}`,
    );
    assert(/^[0-9a-f]{64}$/.test(recorded.sha256), `invalid checksum for ${recorded.path}`);
    const actual = await artifactEntry(backupDir, recorded.path);
    assert(actual.size === recorded.size, `size mismatch for ${recorded.path}`);
    assert(actual.sha256 === recorded.sha256, `checksum mismatch for ${recorded.path}`);
  }
  console.log(`[backup-manifest] verified ${backupDir}`);
}

function sealDirectory(args) {
  const [rawBackupDir] = args;
  assert(rawBackupDir, "seal requires a backup directory");
  const backupDir = resolve(rawBackupDir);
  fsyncPath(backupDir);
  fsyncPath(dirname(backupDir));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "create") await createManifest(args);
  else if (command === "verify") await verifyManifest(args);
  else if (command === "seal") sealDirectory(args);
  else fail("usage: backup-manifest.mjs <create|verify|seal> ...");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
