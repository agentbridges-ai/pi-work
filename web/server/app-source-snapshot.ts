import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_SOURCE_FILE_LIMIT, APP_SOURCE_SNAPSHOT_IGNORED_DIRECTORIES } from "./app-build.js";

const SNAPSHOT_MARKER = ".piwork-source-snapshot.json";

export interface AppSourceSnapshot {
  key: string;
  digest: string;
  fileCount: number;
  sourceBytes: number;
}

interface SnapshotMarker {
  version: 1;
  digest: string;
  fileCount: number;
  sourceBytes: number;
  createdAt: string;
}

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function enumerateSource(root: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === SNAPSHOT_MARKER) continue;
      const path = resolve(directory, entry.name);
      if (!contained(root, path)) throw new Error("Source snapshot path escapes its root");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Source snapshots reject symbolic links");
      if (stat.isDirectory()) {
        if (APP_SOURCE_SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(path);
      } else if (stat.isFile()) {
        if (files.length >= APP_SOURCE_FILE_LIMIT) {
          throw new Error(`Source snapshot exceeds ${APP_SOURCE_FILE_LIMIT} files`);
        }
        files.push({
          absolutePath: path,
          relativePath: relative(root, path).split(sep).join("/"),
          size: stat.size,
        });
      } else {
        throw new Error("Source snapshots accept only regular files and directories");
      }
    }
  };
  await walk(root);
  return files;
}

async function sourceDigest(files: readonly SourceFile[]): Promise<{
  digest: string;
  sourceBytes: number;
}> {
  const hash = createHash("sha256");
  let sourceBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    sourceBytes += bytes.byteLength;
    hash.update(`${file.relativePath}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return { digest: hash.digest("hex"), sourceBytes };
}

async function copyFiles(files: readonly SourceFile[], destination: string): Promise<void> {
  for (const file of files) {
    const target = resolve(destination, file.relativePath);
    if (!contained(destination, target)) throw new Error("Source snapshot target escapes its root");
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await copyFile(file.absolutePath, target, constants.COPYFILE_EXCL);
  }
}

export async function createAppSourceSnapshot(options: {
  creatorRoot: string;
  appId: string;
  deploymentId: string;
  sourceRoot: string;
  expectedDigest?: string;
}): Promise<AppSourceSnapshot> {
  const creatorRoot = await realpath(options.creatorRoot);
  const sourceRoot = await realpath(options.sourceRoot);
  const appId = safeSegment(options.appId, "App id");
  const deploymentId = safeSegment(options.deploymentId, "Deployment id");
  const snapshotsRoot = join(creatorRoot, "published-apps", appId, "sources");
  await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  const canonicalSnapshotsRoot = await realpath(snapshotsRoot);
  if (!contained(creatorRoot, canonicalSnapshotsRoot)) {
    throw new Error("Source snapshot root escapes the creator data root");
  }
  const destination = join(canonicalSnapshotsRoot, deploymentId);
  try {
    const marker = JSON.parse(await readFile(join(destination, SNAPSHOT_MARKER), "utf8")) as
      SnapshotMarker | undefined;
    if (
      marker?.version === 1 &&
      (!options.expectedDigest || marker.digest === options.expectedDigest)
    ) {
      return {
        key: `${appId}/sources/${deploymentId}`,
        digest: marker.digest,
        fileCount: marker.fileCount,
        sourceBytes: marker.sourceBytes,
      };
    }
    throw new Error("Immutable source snapshot already exists with different content");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code ?? "")
        : "";
    if (code !== "ENOENT") throw error;
  }

  const files = await enumerateSource(sourceRoot);
  const digest = await sourceDigest(files);
  if (options.expectedDigest && options.expectedDigest !== digest.digest) {
    throw new Error("Source changed after App build validation");
  }
  const staging = join(canonicalSnapshotsRoot, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    await copyFiles(files, staging);
    const marker: SnapshotMarker = {
      version: 1,
      digest: digest.digest,
      fileCount: files.length,
      sourceBytes: digest.sourceBytes,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(staging, SNAPSHOT_MARKER), JSON.stringify(marker), { mode: 0o600 });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    key: `${appId}/sources/${deploymentId}`,
    digest: digest.digest,
    fileCount: files.length,
    sourceBytes: digest.sourceBytes,
  };
}

export async function restoreAppSourceSnapshot(options: {
  creatorRoot: string;
  snapshotKey: string;
  workspaceRoot: string;
  expectedDigest?: string;
}): Promise<AppSourceSnapshot> {
  if (
    !options.snapshotKey ||
    isAbsolute(options.snapshotKey) ||
    options.snapshotKey.includes("\0") ||
    options.snapshotKey.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Source snapshot key is invalid");
  }
  const creatorRoot = await realpath(options.creatorRoot);
  const snapshotRoot = resolve(creatorRoot, "published-apps", options.snapshotKey);
  if (!contained(resolve(creatorRoot, "published-apps"), snapshotRoot)) {
    throw new Error("Source snapshot key escapes the creator data root");
  }
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  if (canonicalSnapshotRoot !== snapshotRoot)
    throw new Error("Source snapshot root is not canonical");
  const marker = JSON.parse(await readFile(join(snapshotRoot, SNAPSHOT_MARKER), "utf8")) as
    SnapshotMarker | undefined;
  if (
    marker?.version !== 1 ||
    (options.expectedDigest && marker.digest !== options.expectedDigest)
  ) {
    throw new Error("Source snapshot marker is invalid");
  }
  const workspaceRoot = await realpath(options.workspaceRoot);
  const existing = (await readdir(workspaceRoot)).filter((name) => name !== ".gitkeep");
  if (existing.length > 0) throw new Error("Source snapshot restore requires an empty Agent Space");
  const files = await enumerateSource(snapshotRoot);
  const digest = await sourceDigest(files);
  if (digest.digest !== marker.digest) throw new Error("Source snapshot content digest mismatch");
  for (const file of files) {
    const target = resolve(workspaceRoot, file.relativePath);
    if (!contained(workspaceRoot, target))
      throw new Error("Restored source path escapes Agent Space");
    await access(resolve(target, ".."), constants.F_OK).catch(async () => {
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    });
    await copyFile(file.absolutePath, target, constants.COPYFILE_EXCL);
  }
  return {
    key: options.snapshotKey,
    digest: marker.digest,
    fileCount: marker.fileCount,
    sourceBytes: marker.sourceBytes,
  };
}
