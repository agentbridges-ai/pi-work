import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBinary } from "./path-resolver.js";

export const PINNED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PINNED_PI_VERSION = "0.82.1";
export const PINNED_MCP_SDK_VERSION = "1.29.0";
export const PINNED_SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
export const PINNED_SRT_VERSION = "0.0.65";
export const MINIMUM_NODE_VERSION = "22.19.0";

/**
 * SRT's filesystem/network policy is useful on macOS, but only Linux gives
 * Piwork a kernel-owned PID namespace for the complete Pi descendant tree.
 * Keep the execution boundary explicit: host macOS/Windows development must
 * run the whole local server inside OrbStack Linux or WSL2 Linux.
 */
export function assertSupportedPiExecutionPlatform(platform = process.platform): void {
  if (platform === "linux") return;
  const runtime =
    platform === "darwin"
      ? "an OrbStack Linux VM"
      : platform === "win32"
        ? "a WSL2 Linux distribution"
        : "a Linux VM";
  throw new Error(
    `Native Pi SRT execution requires Linux; run Piwork inside ${runtime} instead of the ${platform} host.`,
  );
}

export interface RuntimePackage {
  entryPath: string;
  packageRoot: string;
  packageName: string;
  version: string;
}

export interface PiRuntime extends RuntimePackage {
  nodePath: string;
}

export interface PiRpcArgInput {
  sessionId: string;
  generation: number;
  sessionDir: string;
  trustedExtensionPath: string;
  managedSkillPaths: readonly string[];
  bootstrapSocketPath: string;
  resumeSessionFile?: string;
  model?: {
    provider: string;
    modelId: string;
  };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  engines?: { node?: unknown };
  exports?: Record<string, unknown>;
}

function parseVersion(value: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported Node.js version string: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (compareVersions(parseVersion(version), parseVersion(MINIMUM_NODE_VERSION)) < 0) {
    throw new Error(`Node.js >=${MINIMUM_NODE_VERSION} is required; found ${version}`);
  }
}

function readManifest(path: string): PackageManifest {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) {
      throw new Error(`Unsafe package manifest: ${path}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid package manifest: ${path}`);
    }
    return parsed as PackageManifest;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function findPackage(
  entryPath: string,
  expectedName: string,
  expectedVersion: string,
): RuntimePackage {
  const canonicalEntry = realpathSync(entryPath);
  let cursor = dirname(canonicalEntry);
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(cursor, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = readManifest(manifestPath);
      if (manifest.name === expectedName) {
        if (manifest.version !== expectedVersion) {
          throw new Error(
            `${expectedName}@${expectedVersion} is required; found ${String(manifest.version)}`,
          );
        }
        return {
          entryPath: canonicalEntry,
          packageRoot: realpathSync(cursor),
          packageName: expectedName,
          version: expectedVersion,
        };
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`${canonicalEntry} is not owned by ${expectedName}@${expectedVersion}`);
}

function importTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.import === "string"
    ? record.import
    : typeof record.default === "string"
      ? record.default
      : undefined;
}

function assertPiExport(runtime: RuntimePackage): void {
  const manifest = readManifest(join(runtime.packageRoot, "package.json"));
  const target = importTarget(manifest.exports?.["./rpc-entry"]);
  if (!target) throw new Error(`${PINNED_PI_PACKAGE} does not export ./rpc-entry`);
  const exportedPath = realpathSync(resolve(runtime.packageRoot, target));
  if (exportedPath !== runtime.entryPath) {
    throw new Error("Resolved Pi rpc-entry does not match the pinned package export");
  }
  if (manifest.engines?.node !== `>=${MINIMUM_NODE_VERSION}`) {
    throw new Error(
      `${PINNED_PI_PACKAGE}@${PINNED_PI_VERSION} must declare Node >=${MINIMUM_NODE_VERSION}`,
    );
  }
}

export function resolvePinnedPiRuntime(
  resolveModule: (specifier: string) => string = (specifier) => import.meta.resolve(specifier),
  nodePath = resolveBinary("node") || "",
  platform = process.platform,
): PiRuntime {
  assertSupportedPiExecutionPlatform(platform);
  assertSupportedNodeVersion();
  if (!nodePath) throw new Error(`Node.js >=${MINIMUM_NODE_VERSION} is required`);
  const resolvedUrl = resolveModule(`${PINNED_PI_PACKAGE}/rpc-entry`);
  const entryPath = resolvedUrl.startsWith("file:")
    ? fileURLToPath(resolvedUrl)
    : fileURLToPath(pathToFileURL(resolvedUrl));
  const runtime = findPackage(entryPath, PINNED_PI_PACKAGE, PINNED_PI_VERSION);
  assertPiExport(runtime);
  const canonicalNode = realpathSync(nodePath);
  const nodeFd = openSync(canonicalNode, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(nodeFd).isFile()) throw new Error("Node runtime must be a regular file");
  } finally {
    closeSync(nodeFd);
  }
  return { ...runtime, nodePath: canonicalNode };
}

export function resolvePinnedSrtRuntime(
  binary = resolveBinary("srt"),
  platform = process.platform,
): RuntimePackage {
  assertSupportedPiExecutionPlatform(platform);
  if (!binary) throw new Error(`${PINNED_SRT_PACKAGE}@${PINNED_SRT_VERSION} is required`);
  return findPackage(binary, PINNED_SRT_PACKAGE, PINNED_SRT_VERSION);
}

function requireAbsolutePath(path: string, label: string): string {
  if (!path || !isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path;
}

function requireIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:/@*-]{1,512}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/**
 * Build the only supported rpc-entry argument vector.
 *
 * Discovery remains disabled even when explicit resources are provided:
 * Pi treats explicit --extension and --skill values as trusted inputs while
 * --no-extensions/--no-skills disable user and project discovery.
 */
export function buildPiRpcArgs(input: PiRpcArgInput): string[] {
  if (!/^[a-f0-9-]{36}$/i.test(input.sessionId)) throw new Error("Invalid session id");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Invalid process generation");
  }
  requireAbsolutePath(input.sessionDir, "Pi session directory");
  requireAbsolutePath(input.trustedExtensionPath, "trusted extension");
  requireAbsolutePath(input.bootstrapSocketPath, "bootstrap socket");
  const args = [
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--no-context-files",
    "--extension",
    input.trustedExtensionPath,
    "--session-dir",
    input.sessionDir,
  ];
  for (const skillPath of input.managedSkillPaths) {
    args.push("--skill", requireAbsolutePath(skillPath, "managed skill"));
  }
  if (input.resumeSessionFile) {
    args.push("--session", requireAbsolutePath(input.resumeSessionFile, "Pi session file"));
  } else {
    args.push("--session-id", input.sessionId.toLowerCase());
  }
  if (input.model) {
    args.push(
      "--provider",
      requireIdentifier(input.model.provider, "model provider"),
      "--model",
      requireIdentifier(input.model.modelId, "model id"),
    );
  }
  if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
  args.push(
    "--piwork-bootstrap-socket",
    input.bootstrapSocketPath,
    "--piwork-session-id",
    input.sessionId,
    "--piwork-generation",
    String(input.generation),
  );
  return args;
}
