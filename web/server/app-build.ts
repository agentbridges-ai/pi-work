import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveBinary } from "./path-resolver.js";
import {
  materializeAppBindingManifest,
  parsePiworkAppManifestText,
  PIWORK_APP_MANIFEST_FILENAME,
  type AppBindingManifest,
  type PiworkAppManifestV1,
} from "./app-manifest.js";

const O_CLOEXEC = Number((constants as unknown as Record<string, unknown>).O_CLOEXEC || 0);

export const APP_BUILD_TIMEOUT_MS = 120_000;
export const APP_SOURCE_FILE_LIMIT = 50_000;
export const APP_ASSET_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
/** Aggregate bytes retained in one immutable Worker/Assets artifact. */
export const APP_ARTIFACT_BYTE_LIMIT_BYTES = 64 * 1024 * 1024;
export const APP_BUILD_COMMAND = "bun install --frozen-lockfile && bun run build";
export const APP_BUILD_CONFIG_PATH = "build/server/wrangler.json";

function shellQuote(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Bun executable path is invalid");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Resolve Bun before entering the SRT child PATH, which intentionally omits host install dirs. */
export function resolveAppBuildCommand(): string {
  const candidates = [
    process.versions.bun ? process.execPath : undefined,
    resolveBinary("bun"),
    "/usr/local/bin/bun",
    "/usr/local/bun/bin/bun",
    "/opt/homebrew/bin/bun",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const executable = candidates.find((value) => isAbsolute(value) && existsSync(value));
  if (!executable) throw new Error("Bun is required for App builds");
  const quoted = shellQuote(executable);
  return `${quoted} install --frozen-lockfile && ${quoted} run build`;
}

const PACKAGE_JSON_LIMIT_BYTES = 1024 * 1024;
export const APP_SOURCE_SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".wrangler",
  ".cache",
  "node_modules",
  "build",
  "dist",
]);
const FORBIDDEN_WRANGLER_FIELDS = new Set([
  "ai",
  "analytics_engine_datasets",
  "browser",
  "d1_databases",
  "dispatch_namespaces",
  "hyperdrive",
  "kv_namespaces",
  "mtls_certificates",
  "pipelines",
  "queues",
  "r2_buckets",
  "ratelimits",
  "secrets",
  "secrets_store_secrets",
  "send_email",
  "services",
  "unsafe",
  "vars",
  "vectorize",
  "vpc_services",
  "workflows",
]);
const ALLOWED_RULE_TYPES = new Set(["ESModule", "CommonJS", "CompiledWasm", "Text", "Data"]);

export interface AppBuildWarning {
  code: "asset_too_large";
  path: string;
  size: number;
  limit: number;
}

export interface AppSourceInspection {
  sourceRoot: string;
  fileCount: number;
  sourceBytes: number;
  sourceDigest: string;
  manifest: PiworkAppManifestV1;
  bindings: AppBindingManifest;
}

export interface AppWorkerModule {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface AppStaticAsset {
  path: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface AppBuildArtifact extends AppSourceInspection {
  configPath: typeof APP_BUILD_CONFIG_PATH;
  mainModule: string;
  compatibilityDate?: string;
  compatibilityFlags: string[];
  modules: AppWorkerModule[];
  assets: AppStaticAsset[];
  warnings: AppBuildWarning[];
  artifactDigest: string;
  durableObjectClasses: string[];
  rawConfig: Record<string, unknown>;
}

export function computeAppArtifactDigest(input: {
  mainModule: string;
  compatibilityDate?: string;
  compatibilityFlags: string[];
  bindings: AppBindingManifest;
  modules: AppWorkerModule[];
  assets: AppStaticAsset[];
}): string {
  const artifactHash = createHash("sha256");
  artifactHash.update(
    JSON.stringify({
      mainModule: input.mainModule,
      compatibilityDate: input.compatibilityDate,
      compatibilityFlags: input.compatibilityFlags,
      bindings: input.bindings,
    }),
  );
  for (const module of input.modules) {
    artifactHash.update(`module\0${module.name}\0${module.bytes.byteLength}\0`);
    artifactHash.update(module.bytes);
  }
  for (const asset of input.assets) {
    artifactHash.update(`asset\0${asset.path}\0${asset.bytes.byteLength}\0`);
    artifactHash.update(asset.bytes);
  }
  return artifactHash.digest("hex");
}

export class AppBuildError extends Error {
  readonly code:
    | "invalid_source_path"
    | "invalid_source_tree"
    | "missing_build_contract"
    | "invalid_build_contract"
    | "build_limit_exceeded";

  constructor(code: AppBuildError["code"], message: string) {
    super(message);
    this.name = "AppBuildError";
    this.code = code;
  }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function resolveAppSourceRoot(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath)
  ) {
    throw new AppBuildError("invalid_source_path", "App path must be relative to Agent Space");
  }
  const canonicalWorkspace = await realpath(workspaceRoot);
  const candidate = resolve(canonicalWorkspace, requestedPath || ".");
  if (!contained(canonicalWorkspace, candidate)) {
    throw new AppBuildError("invalid_source_path", "App path escapes Agent Space");
  }
  const candidateStat = await lstat(candidate).catch(() => null);
  if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new AppBuildError("invalid_source_path", "App path must be a real directory");
  }
  const canonicalCandidate = await realpath(candidate);
  if (!contained(canonicalWorkspace, canonicalCandidate) || canonicalCandidate !== candidate) {
    throw new AppBuildError("invalid_source_path", "App path resolves outside Agent Space");
  }
  return canonicalCandidate;
}

interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

async function walkRegularFiles(
  root: string,
  options: { ignoreSourceDirectories?: boolean; counter?: { value: number } } = {},
): Promise<WalkedFile[]> {
  const output: WalkedFile[] = [];
  const counter = options.counter ?? { value: 0 };
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (!contained(root, absolutePath)) {
        throw new AppBuildError("invalid_source_tree", "App file escapes its source root");
      }
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new AppBuildError(
          "invalid_source_tree",
          `Symbolic links are not allowed in App sources: ${relative(root, absolutePath)}`,
        );
      }
      if (stat.isDirectory()) {
        if (
          options.ignoreSourceDirectories &&
          APP_SOURCE_SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new AppBuildError(
          "invalid_source_tree",
          `Only regular files are allowed in App sources: ${relative(root, absolutePath)}`,
        );
      }
      counter.value += 1;
      if (counter.value > APP_SOURCE_FILE_LIMIT) {
        throw new AppBuildError(
          "build_limit_exceeded",
          `App contains more than ${APP_SOURCE_FILE_LIMIT} files`,
        );
      }
      output.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split(sep).join("/"),
        size: stat.size,
      });
    }
  };
  await walk(root);
  return output;
}

async function requiredFile(path: string, message: string): Promise<Uint8Array> {
  try {
    return await readRegularFileNoFollow(path);
  } catch {
    throw new AppBuildError("missing_build_contract", message);
  }
}

async function readRegularFileNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppBuildError("invalid_build_contract", `${label} must contain a JSON object`);
  }
}

export async function inspectAppSource(
  workspaceRoot: string,
  requestedPath: string,
): Promise<AppSourceInspection> {
  const sourceRoot = await resolveAppSourceRoot(workspaceRoot, requestedPath);
  const packageBytes = await requiredFile(
    resolve(sourceRoot, "package.json"),
    "App source requires package.json",
  );
  if (packageBytes.byteLength > PACKAGE_JSON_LIMIT_BYTES) {
    throw new AppBuildError("invalid_build_contract", "package.json is too large");
  }
  const packageJson = parseJsonObject(packageBytes, "package.json");
  const scripts = packageJson.scripts;
  if (
    !scripts ||
    typeof scripts !== "object" ||
    Array.isArray(scripts) ||
    typeof (scripts as Record<string, unknown>).build !== "string" ||
    !(scripts as Record<string, string>).build.trim()
  ) {
    throw new AppBuildError("missing_build_contract", "package.json requires scripts.build");
  }
  await requiredFile(resolve(sourceRoot, "bun.lock"), "App source requires bun.lock");
  const manifestBytes = await requiredFile(
    resolve(sourceRoot, PIWORK_APP_MANIFEST_FILENAME),
    `App source requires ${PIWORK_APP_MANIFEST_FILENAME}`,
  );
  const manifest = parsePiworkAppManifestText(new TextDecoder().decode(manifestBytes));
  const files = await walkRegularFiles(sourceRoot, { ignoreSourceDirectories: true });
  const digest = createHash("sha256");
  let sourceBytes = 0;
  for (const file of files) {
    const bytes = await readRegularFileNoFollow(file.absolutePath);
    sourceBytes += bytes.byteLength;
    digest.update(`${file.relativePath}\0${bytes.byteLength}\0`);
    digest.update(bytes);
  }
  return {
    sourceRoot,
    fileCount: files.length,
    sourceBytes,
    sourceDigest: digest.digest("hex"),
    manifest,
    bindings: materializeAppBindingManifest(manifest),
  };
}

interface WorkerRule {
  type: string;
  globs: string[];
}

function globPattern(pattern: string): RegExp {
  if (
    !pattern ||
    pattern.includes("\0") ||
    pattern.startsWith("/") ||
    pattern.split("/").includes("..")
  ) {
    throw new AppBuildError("invalid_build_contract", "Worker module glob is unsafe");
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function parseRules(value: unknown): Array<WorkerRule & { patterns: RegExp[] }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new AppBuildError("invalid_build_contract", "Worker rules must be a bounded array");
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppBuildError("invalid_build_contract", "Worker rule must be an object");
    }
    const rule = raw as Record<string, unknown>;
    if (
      typeof rule.type !== "string" ||
      !ALLOWED_RULE_TYPES.has(rule.type) ||
      !Array.isArray(rule.globs) ||
      rule.globs.length === 0 ||
      rule.globs.some((glob) => typeof glob !== "string")
    ) {
      throw new AppBuildError("invalid_build_contract", "Worker rule is invalid");
    }
    const globs = rule.globs as string[];
    return { type: rule.type, globs, patterns: globs.map(globPattern) };
  });
}

function moduleContentType(type: string): string {
  if (type === "CompiledWasm") return "application/wasm";
  if (type === "Text") return "text/plain";
  if (type === "Data") return "application/octet-stream";
  if (type === "CommonJS") return "application/javascript";
  return "application/javascript+module";
}

function relativeConfigPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new AppBuildError("invalid_build_contract", `${label} must be a safe relative path`);
  }
  return value.replace(/^\.\//u, "").replaceAll("\\", "/");
}

function assertNoForbiddenWranglerBindings(config: Record<string, unknown>): void {
  for (const key of FORBIDDEN_WRANGLER_FIELDS) {
    if (config[key] !== undefined) {
      throw new AppBuildError(
        "invalid_build_contract",
        `Worker configuration field "${key}" is platform-controlled`,
      );
    }
  }
  if (Array.isArray(config.bindings) && config.bindings.length > 0) {
    throw new AppBuildError(
      "invalid_build_contract",
      "Direct Worker bindings are forbidden; declare capabilities in piwork.app.json",
    );
  }
  if (config.durable_objects !== undefined) {
    throw new AppBuildError(
      "invalid_build_contract",
      "Durable Object bindings are platform-generated from piwork.app.json",
    );
  }
}

function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const declaration =
    /\bexport\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  for (let match = declaration.exec(source); match; match = declaration.exec(source)) {
    names.add(match[1]!);
  }
  const clause = /\bexport\s*\{([^}]*)\}/gu;
  for (let match = clause.exec(source); match; match = clause.exec(source)) {
    for (const raw of match[1]!.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const alias = item.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/u);
      names.add(alias?.[1] ?? item);
    }
  }
  return names;
}

function contentTypeForAsset(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        css: "text/css; charset=utf-8",
        gif: "image/gif",
        html: "text/html; charset=utf-8",
        ico: "image/x-icon",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        js: "text/javascript; charset=utf-8",
        json: "application/json; charset=utf-8",
        mjs: "text/javascript; charset=utf-8",
        png: "image/png",
        svg: "image/svg+xml",
        txt: "text/plain; charset=utf-8",
        webp: "image/webp",
        woff: "font/woff",
        woff2: "font/woff2",
      } as Record<string, string>
    )[extension ?? ""] ?? "application/octet-stream"
  );
}

export async function collectAppBuildArtifact(
  workspaceRoot: string,
  requestedPath: string,
): Promise<AppBuildArtifact> {
  const source = await inspectAppSource(workspaceRoot, requestedPath);
  const serverRoot = resolve(source.sourceRoot, "build/server");
  const configBytes = await requiredFile(
    resolve(source.sourceRoot, APP_BUILD_CONFIG_PATH),
    `App build must emit ${APP_BUILD_CONFIG_PATH}`,
  );
  const config = parseJsonObject(configBytes, APP_BUILD_CONFIG_PATH);
  assertNoForbiddenWranglerBindings(config);
  const mainModule = relativeConfigPath(config.main, "Worker main");
  const rules = parseRules(config.rules);
  const buildFiles = await walkRegularFiles(serverRoot);
  const byPath = new Map(buildFiles.map((file) => [file.relativePath, file]));
  const mainFile = byPath.get(mainModule);
  if (!mainFile) {
    throw new AppBuildError(
      "invalid_build_contract",
      `Worker main module "${mainModule}" is missing from build/server`,
    );
  }

  const modules: AppWorkerModule[] = [];
  let artifactBytes = 0;
  for (const file of buildFiles) {
    if (file.relativePath === "wrangler.json") continue;
    const rule = rules.find((candidate) =>
      candidate.patterns.some((pattern) => pattern.test(file.relativePath)),
    );
    if (file.relativePath !== mainModule && !rule) continue;
    if (artifactBytes + file.size > APP_ARTIFACT_BYTE_LIMIT_BYTES) {
      throw new AppBuildError(
        "build_limit_exceeded",
        `App artifact exceeds the ${APP_ARTIFACT_BYTE_LIMIT_BYTES}-byte aggregate limit`,
      );
    }
    const bytes = await readRegularFileNoFollow(file.absolutePath);
    if (artifactBytes + bytes.byteLength > APP_ARTIFACT_BYTE_LIMIT_BYTES) {
      throw new AppBuildError(
        "build_limit_exceeded",
        `App artifact exceeds the ${APP_ARTIFACT_BYTE_LIMIT_BYTES}-byte aggregate limit`,
      );
    }
    artifactBytes += bytes.byteLength;
    modules.push({
      name: file.relativePath,
      contentType:
        file.relativePath === mainModule
          ? "application/javascript+module"
          : moduleContentType(rule!.type),
      bytes,
    });
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));

  const mainText = new TextDecoder().decode(
    modules.find((item) => item.name === mainModule)!.bytes,
  );
  const exports = exportedNames(mainText);
  const durableObjectClasses = source.bindings.durableObjects.map((entry) => entry.className);
  const missingExports = durableObjectClasses.filter((className) => !exports.has(className));
  if (missingExports.length > 0) {
    throw new AppBuildError(
      "invalid_build_contract",
      `Worker main module does not export Durable Object class: ${missingExports.join(", ")}`,
    );
  }

  const assetsConfig = config.assets;
  let assetsDirectory: string | undefined;
  if (typeof assetsConfig === "string") assetsDirectory = assetsConfig;
  else if (assetsConfig && typeof assetsConfig === "object" && !Array.isArray(assetsConfig)) {
    assetsDirectory = (assetsConfig as Record<string, unknown>).directory as string | undefined;
  }
  const assets: AppStaticAsset[] = [];
  const warnings: AppBuildWarning[] = [];
  if (assetsDirectory !== undefined) {
    const safeDirectory = relativeConfigPath(assetsDirectory, "Assets directory");
    const assetRoot = resolve(serverRoot, safeDirectory);
    if (!contained(serverRoot, assetRoot)) {
      throw new AppBuildError("invalid_build_contract", "Assets directory escapes build/server");
    }
    const assetFiles = await walkRegularFiles(assetRoot);
    for (const file of assetFiles) {
      const path = `/${file.relativePath}`;
      if (file.size > APP_ASSET_FILE_LIMIT_BYTES) {
        warnings.push({
          code: "asset_too_large",
          path,
          size: file.size,
          limit: APP_ASSET_FILE_LIMIT_BYTES,
        });
        continue;
      }
      if (artifactBytes + file.size > APP_ARTIFACT_BYTE_LIMIT_BYTES) {
        throw new AppBuildError(
          "build_limit_exceeded",
          `App artifact exceeds the ${APP_ARTIFACT_BYTE_LIMIT_BYTES}-byte aggregate limit`,
        );
      }
      const bytes = await readRegularFileNoFollow(file.absolutePath);
      if (artifactBytes + bytes.byteLength > APP_ARTIFACT_BYTE_LIMIT_BYTES) {
        throw new AppBuildError(
          "build_limit_exceeded",
          `App artifact exceeds the ${APP_ARTIFACT_BYTE_LIMIT_BYTES}-byte aggregate limit`,
        );
      }
      artifactBytes += bytes.byteLength;
      assets.push({
        path,
        contentType: contentTypeForAsset(file.relativePath),
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  const compatibilityFlags = config.compatibility_flags;
  if (
    compatibilityFlags !== undefined &&
    (!Array.isArray(compatibilityFlags) ||
      compatibilityFlags.some((value) => typeof value !== "string"))
  ) {
    throw new AppBuildError("invalid_build_contract", "Worker compatibility_flags must be strings");
  }
  if (
    config.compatibility_date !== undefined &&
    (typeof config.compatibility_date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.compatibility_date))
  ) {
    throw new AppBuildError("invalid_build_contract", "Worker compatibility_date is invalid");
  }

  return {
    ...source,
    configPath: APP_BUILD_CONFIG_PATH,
    mainModule,
    ...(typeof config.compatibility_date === "string"
      ? { compatibilityDate: config.compatibility_date }
      : {}),
    compatibilityFlags: (compatibilityFlags as string[] | undefined) ?? [],
    modules,
    assets,
    warnings,
    artifactDigest: computeAppArtifactDigest({
      mainModule,
      ...(typeof config.compatibility_date === "string"
        ? { compatibilityDate: config.compatibility_date }
        : {}),
      compatibilityFlags: (compatibilityFlags as string[] | undefined) ?? [],
      bindings: source.bindings,
      modules,
      assets,
    }),
    durableObjectClasses,
    rawConfig: config,
  };
}
