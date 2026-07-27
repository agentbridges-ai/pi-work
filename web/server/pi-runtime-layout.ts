import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const PI_RUNTIME_LAYOUT_FORMAT = "piwork-runtime-layout";
export const PI_RUNTIME_LAYOUT_VERSION = 1;
export const PI_RUNTIME_BACKEND = "pi";
export const PI_RUNTIME_MARKER_RELATIVE_PATH = join(".runtime", "runtime-layout.json");

export interface PiRuntimeLayoutMarker {
  format: typeof PI_RUNTIME_LAYOUT_FORMAT;
  version: typeof PI_RUNTIME_LAYOUT_VERSION;
  backend: typeof PI_RUNTIME_BACKEND;
  createdAt: string;
}

export type PiRuntimeLayoutInspection =
  | { state: "ready"; dataRoot: string; markerPath: string; marker: PiRuntimeLayoutMarker }
  | { state: "initializable"; dataRoot: string; markerPath: string }
  | {
      state: "migration-required";
      dataRoot: string;
      markerPath: string;
      entries: string[];
    }
  | { state: "invalid"; dataRoot: string; markerPath: string; reason: string };

export class PiRuntimeLayoutError extends Error {
  constructor(
    message: string,
    readonly inspection: Exclude<PiRuntimeLayoutInspection, { state: "ready" }>,
  ) {
    super(message);
    this.name = "PiRuntimeLayoutError";
  }
}

function markerPathFor(dataRoot: string): string {
  return join(dataRoot, PI_RUNTIME_MARKER_RELATIVE_PATH);
}

function prospectiveCanonicalPath(path: string): string {
  let cursor = path;
  const missing: string[] = [];
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) throw new Error("Path traverses a symbolic-link alias.");
      if (!info.isDirectory()) throw new Error("Path traverses a non-directory ancestor.");
      return resolve(realpathSync(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function validateRoot(dataRoot: string): { root: string; error?: string } {
  const root = resolve(dataRoot);
  if (dirname(root) === root) return { root, error: "Data root must not be the filesystem root." };
  if (!existsSync(root)) {
    try {
      if (prospectiveCanonicalPath(root) !== root) {
        return { root, error: "Data root must not traverse symbolic-link aliases." };
      }
    } catch (error) {
      return {
        root,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { root };
  }
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return { root, error: "Data root must not be a symbolic link." };
  if (!stat.isDirectory()) return { root, error: "Data root must be a directory." };
  if (realpathSync(root) !== root) {
    return { root, error: "Data root must not traverse symbolic-link aliases." };
  }
  return { root };
}

function parseMarker(value: unknown): PiRuntimeLayoutMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\0") !== ["backend", "createdAt", "format", "version"].join("\0")) return null;
  if (
    candidate.format !== PI_RUNTIME_LAYOUT_FORMAT ||
    candidate.version !== PI_RUNTIME_LAYOUT_VERSION ||
    candidate.backend !== PI_RUNTIME_BACKEND ||
    typeof candidate.createdAt !== "string" ||
    !candidate.createdAt ||
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    new Date(candidate.createdAt).toISOString() !== candidate.createdAt
  ) {
    return null;
  }
  return candidate as unknown as PiRuntimeLayoutMarker;
}

function nonMarkerEntries(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name !== ".runtime") {
      names.push(entry.name);
      continue;
    }
    const runtimePath = join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    for (const child of readdirSync(runtimePath)) {
      if (child !== "runtime-layout.json") names.push(join(entry.name, child));
    }
  }
  return names.sort();
}

export function inspectPiRuntimeLayout(dataRoot: string): PiRuntimeLayoutInspection {
  const validated = validateRoot(dataRoot);
  const markerPath = markerPathFor(validated.root);
  if (validated.error) {
    return {
      state: "invalid",
      dataRoot: validated.root,
      markerPath,
      reason: validated.error,
    };
  }
  const runtimeDir = dirname(markerPath);
  try {
    const runtimeInfo = lstatSync(runtimeDir);
    if (
      runtimeInfo.isSymbolicLink() ||
      !runtimeInfo.isDirectory() ||
      realpathSync(runtimeDir) !== runtimeDir
    ) {
      throw new Error(".runtime must be a canonical directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        state: "invalid",
        dataRoot: validated.root,
        markerPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let markerInfo: ReturnType<typeof lstatSync> | undefined;
  try {
    markerInfo = lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        state: "invalid",
        dataRoot: validated.root,
        markerPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (markerInfo) {
    try {
      if (
        markerInfo.isSymbolicLink() ||
        !markerInfo.isFile() ||
        markerInfo.nlink !== 1 ||
        markerInfo.size > 16 * 1024
      ) {
        throw new Error("Marker must be a singly-linked bounded regular file.");
      }
      const marker = parseMarker(JSON.parse(readFileSync(markerPath, "utf8")));
      if (!marker) throw new Error("Marker does not match the Pi v1 schema.");
      return { state: "ready", dataRoot: validated.root, markerPath, marker };
    } catch (error) {
      return {
        state: "invalid",
        dataRoot: validated.root,
        markerPath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const entries = nonMarkerEntries(validated.root);
  if (entries.length > 0) {
    return {
      state: "migration-required",
      dataRoot: validated.root,
      markerPath,
      entries,
    };
  }
  return { state: "initializable", dataRoot: validated.root, markerPath };
}

function throwForInspection(
  inspection: Exclude<PiRuntimeLayoutInspection, { state: "ready" | "initializable" }>,
): never {
  if (inspection.state === "migration-required") {
    throw new PiRuntimeLayoutError(
      `Pi sessions are disabled because the non-empty data root has no Pi v1 marker. ` +
        `Run "make pi-reset-legacy-sessions" and review its dry-run before confirming the reset.`,
      inspection,
    );
  }
  throw new PiRuntimeLayoutError(`Invalid Pi runtime layout: ${inspection.reason}`, inspection);
}

function publishMarker(inspection: Extract<PiRuntimeLayoutInspection, { state: "initializable" }>) {
  mkdirSync(inspection.dataRoot, { recursive: true, mode: 0o700 });
  const validated = validateRoot(inspection.dataRoot);
  if (validated.error || realpathSync(inspection.dataRoot) !== inspection.dataRoot) {
    throw new PiRuntimeLayoutError("Data root became non-canonical during initialization.", {
      state: "invalid",
      dataRoot: inspection.dataRoot,
      markerPath: inspection.markerPath,
      reason: validated.error || "Data root traverses a symbolic-link alias.",
    });
  }
  chmodSync(inspection.dataRoot, 0o700);

  const secondInspection = inspectPiRuntimeLayout(inspection.dataRoot);
  if (secondInspection.state === "ready") return secondInspection.marker;
  if (secondInspection.state !== "initializable") throwForInspection(secondInspection);

  mkdirSync(dirname(inspection.markerPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(inspection.markerPath), 0o700);
  const thirdInspection = inspectPiRuntimeLayout(inspection.dataRoot);
  if (thirdInspection.state === "ready") return thirdInspection.marker;
  if (thirdInspection.state !== "initializable") throwForInspection(thirdInspection);

  const marker: PiRuntimeLayoutMarker = {
    format: PI_RUNTIME_LAYOUT_FORMAT,
    version: PI_RUNTIME_LAYOUT_VERSION,
    backend: PI_RUNTIME_BACKEND,
    createdAt: new Date().toISOString(),
  };
  const temporary = join(dirname(inspection.markerPath), `.runtime-layout.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(temporary, inspection.markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }

  const finalInspection = inspectPiRuntimeLayout(inspection.dataRoot);
  if (finalInspection.state !== "ready") {
    if (finalInspection.state === "initializable") {
      throw new PiRuntimeLayoutError("Pi runtime marker was not published.", {
        state: "invalid",
        dataRoot: finalInspection.dataRoot,
        markerPath: finalInspection.markerPath,
        reason: "Atomic marker publication did not produce a marker.",
      });
    }
    throwForInspection(finalInspection);
  }
  return finalInspection.marker;
}

/**
 * Initializes only a brand-new or empty data root. It never removes or
 * migrates data; non-empty legacy roots must use the explicit reset command.
 */
export function ensurePiRuntimeLayout(dataRoot: string): PiRuntimeLayoutMarker {
  const inspection = inspectPiRuntimeLayout(dataRoot);
  if (inspection.state === "ready") return inspection.marker;
  if (inspection.state === "initializable") return publishMarker(inspection);
  return throwForInspection(inspection);
}

/** Refuses session launch unless an already-valid Pi v1 marker exists. */
export function requirePiRuntimeLayout(dataRoot: string): PiRuntimeLayoutMarker {
  const inspection = inspectPiRuntimeLayout(dataRoot);
  if (inspection.state === "ready") return inspection.marker;
  if (inspection.state === "initializable") {
    throw new PiRuntimeLayoutError(
      "Pi runtime layout is not initialized. Initialize the empty data root before session launch.",
      inspection,
    );
  }
  return throwForInspection(inspection);
}
