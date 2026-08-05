import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { StrictLfJsonlDecoder } from "./pi-rpc-transport.js";

export const NATIVE_HELPER_PROTOCOL_VERSION = 1;
export const NATIVE_HELPER_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const NATIVE_HELPER_UPGRADE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/agentbridges-ai/piwork-helper/main/install.sh | sh -s -- --upgrade";

export const NATIVE_FILE_ACTIONS = [
  "file.quickLook",
  "file.open",
  "file.openWith",
  "file.print",
  "file.saveAs",
  "file.revealExport",
  "file.share",
  "file.nativeEdit",
] as const;

export type NativeFileAction = (typeof NATIVE_FILE_ACTIONS)[number];

export interface NativeHelperAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeHelperStatus {
  supported: boolean;
  installed: boolean;
  connected: boolean;
  compatible: boolean;
  helperVersion: string | null;
  protocolVersion: number | null;
  platformVersion: string | null;
  capabilities: string[];
  latestVersion: string | null;
  updateAvailable: boolean;
  upgradeCommand: string;
  lastError: string | null;
}

export interface NativeFileSource {
  space: "agent" | "user";
  path: string;
  mountId?: string;
  baselineSha256?: string;
  baselineMtime?: number;
}

export interface NativeFileOperation {
  id: string;
  sessionId: string;
  action: NativeFileAction;
  filename: string;
  source: NativeFileSource;
  baselineSha256: string;
  managedSha256: string;
  state: string;
  createdAt: string;
}

interface PersistedNativeFileOperation extends NativeFileOperation {
  version: 1;
  ownerKey: string;
  filePath: string;
  operationRoot: string;
}

interface NativeHelperHello {
  type: "hello";
  version: 1;
  id: string;
  helperVersion: string;
  protocolVersion: number;
  platformVersion: string;
  capabilities: string[];
  pid: number;
}

interface NativeHelperResult {
  type: "result";
  version: 1;
  id: string;
  ok: boolean;
  state?: string;
  operationId?: string;
  destinationName?: string;
  code?: string;
  error?: string | null;
}

interface NativeHelperError {
  type: "error";
  version: 1;
  id: string;
  code: string;
  error: string;
}

interface NativeHelperProgress {
  type: "progress";
  version: 1;
  id: string;
  operationId?: string;
  stage: string;
}

type NativeHelperResponse =
  NativeHelperHello | NativeHelperResult | NativeHelperError | NativeHelperProgress;

export interface NativeHelperServiceOptions {
  platform?: NodeJS.Platform;
  socketPath?: string;
  stagingRoot?: string;
  appPath?: string;
  plistPath?: string;
  requestTimeoutMs?: number;
  fetchLatestVersion?: () => Promise<string | null>;
}

const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const TRANSIENT_OPERATION_TTL_MS = 60 * 60 * 1_000;
const NATIVE_EDIT_OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;

function helperDefaults() {
  const userHome = homedir();
  return {
    socketPath: join(userHome, ".piwork", "run", "native-helper.sock"),
    stagingRoot: join(userHome, ".piwork", "helper", "staging"),
    appPath: join(
      userHome,
      "Applications",
      "Piwork Helper.app",
      "Contents",
      "MacOS",
      "piwork-helper",
    ),
    plistPath: join(userHome, "Library", "LaunchAgents", "ai.agentbridges.piwork-helper.plist"),
  };
}

function sanitizedFilename(value: string): string {
  const leaf = basename(value.trim()).replace(/[\u0000-\u001f\u007f/\\:]/gu, "_");
  if (!leaf || leaf === "." || leaf === "..") return "piwork-file";
  const bytes = Buffer.from(leaf);
  if (bytes.length <= 240) return leaf;
  return (
    bytes
      .subarray(0, 240)
      .toString("utf8")
      .replace(/\uFFFD+$/u, "") || "piwork-file"
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function versionParts(value: string): number[] | null {
  const match = value
    .trim()
    .replace(/^v/u, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function nativeHelperVersionIsNewer(latest: string, current: string): boolean {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  if (!latestParts || !currentParts) return false;
  for (let index = 0; index < 3; index++) {
    if (latestParts[index]! !== currentParts[index]!) {
      return latestParts[index]! > currentParts[index]!;
    }
  }
  return false;
}

export function validateNativeHelperAnchor(
  value: NativeHelperAnchor | undefined,
): NativeHelperAnchor | undefined {
  if (value === undefined) return undefined;
  if (
    Object.values(value).some((coordinate) => !Number.isFinite(coordinate)) ||
    Math.abs(value.x) > 100_000 ||
    Math.abs(value.y) > 100_000 ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.width > 20_000 ||
    value.height > 20_000
  ) {
    throw Object.assign(new Error("Invalid native helper anchor rectangle"), { status: 400 });
  }
  return value;
}

function isNativeFileAction(value: string): value is NativeFileAction {
  return (NATIVE_FILE_ACTIONS as readonly string[]).includes(value);
}

function publicOperation(record: PersistedNativeFileOperation): NativeFileOperation {
  const {
    version: _version,
    ownerKey: _ownerKey,
    filePath: _filePath,
    operationRoot: _operationRoot,
    ...operation
  } = record;
  return operation;
}

async function defaultFetchLatestVersion(): Promise<string | null> {
  const response = await fetch(
    "https://api.github.com/repos/agentbridges-ai/piwork-helper/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "piwork-native-helper-status",
      },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Helper release check failed (${response.status})`);
  const value = (await response.json()) as {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
  };
  const tag = typeof value.tag_name === "string" ? value.tag_name.replace(/^v/u, "") : null;
  if (!tag) return null;
  const manifestAsset = value.assets?.find(
    (asset) =>
      asset.name === `piwork-helper-${tag}-manifest.json` &&
      typeof asset.browser_download_url === "string",
  );
  if (!manifestAsset || typeof manifestAsset.browser_download_url !== "string") return tag;
  const manifestResponse = await fetch(manifestAsset.browser_download_url, {
    headers: { "User-Agent": "piwork-native-helper-status" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!manifestResponse.ok) {
    throw new Error(`Helper release manifest check failed (${manifestResponse.status})`);
  }
  const manifest = (await manifestResponse.json()) as {
    version?: unknown;
    protocol?: { minimum?: unknown; maximum?: unknown };
  };
  if (
    typeof manifest.version !== "string" ||
    manifest.version.replace(/^v/u, "") !== tag ||
    manifest.protocol?.minimum !== NATIVE_HELPER_PROTOCOL_VERSION ||
    manifest.protocol?.maximum !== NATIVE_HELPER_PROTOCOL_VERSION
  ) {
    throw new Error("Helper release manifest is incompatible with this Piwork build");
  }
  return tag;
}

export class NativeHelperService {
  private readonly platform: NodeJS.Platform;
  private readonly socketPath: string;
  private readonly stagingRoot: string;
  private readonly appPath: string;
  private readonly plistPath: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchLatestVersion: () => Promise<string | null>;
  private readonly operations = new Map<string, PersistedNativeFileOperation>();
  private latestVersion: string | null = null;
  private latestVersionCheckedAt = 0;
  private lastError: string | null = null;

  constructor(options: NativeHelperServiceOptions = {}) {
    const defaults = helperDefaults();
    this.platform = options.platform ?? process.platform;
    this.socketPath = options.socketPath ?? defaults.socketPath;
    this.stagingRoot = options.stagingRoot ?? defaults.stagingRoot;
    this.appPath = options.appPath ?? defaults.appPath;
    this.plistPath = options.plistPath ?? defaults.plistPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.fetchLatestVersion = options.fetchLatestVersion ?? defaultFetchLatestVersion;
  }

  async status(options: { refreshLatest?: boolean } = {}): Promise<NativeHelperStatus> {
    await this.cleanupStaleOperations();
    const supported = this.platform === "darwin";
    const installed = supported && existsSync(this.appPath) && existsSync(this.plistPath);
    let hello: NativeHelperHello | null = null;
    if (supported) {
      try {
        hello = await this.hello();
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      await this.refreshLatestVersion(Boolean(options.refreshLatest)).catch((error: unknown) => {
        if (!this.lastError) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      });
    }
    const compatible =
      hello !== null &&
      hello.protocolVersion === NATIVE_HELPER_PROTOCOL_VERSION &&
      NATIVE_FILE_ACTIONS.every((capability) => hello?.capabilities.includes(capability));
    return {
      supported,
      installed,
      connected: hello !== null,
      compatible,
      helperVersion: hello?.helperVersion ?? null,
      protocolVersion: hello?.protocolVersion ?? null,
      platformVersion: hello?.platformVersion ?? null,
      capabilities: hello?.capabilities ?? [],
      latestVersion: this.latestVersion,
      updateAvailable: Boolean(
        hello?.helperVersion &&
        this.latestVersion &&
        nativeHelperVersionIsNewer(this.latestVersion, hello.helperVersion),
      ),
      upgradeCommand: NATIVE_HELPER_UPGRADE_COMMAND,
      lastError: this.lastError,
    };
  }

  async createFileAction(input: {
    ownerKey: string;
    sessionId: string;
    action: NativeFileAction;
    bytes: Uint8Array;
    filename: string;
    source: NativeFileSource;
    anchor?: NativeHelperAnchor;
    applicationPath?: string;
  }): Promise<NativeFileOperation> {
    await this.cleanupStaleOperations();
    if (this.platform !== "darwin") {
      throw Object.assign(new Error("Piwork Helper is available only on macOS"), { status: 501 });
    }
    if (!isNativeFileAction(input.action)) {
      throw Object.assign(new Error("Unsupported native file action"), { status: 400 });
    }
    if (input.bytes.byteLength > NATIVE_HELPER_MAX_FILE_BYTES) {
      throw Object.assign(new Error("Native file exceeds the 100 MiB limit"), { status: 413 });
    }
    const anchor = validateNativeHelperAnchor(input.anchor);
    const id = randomUUID();
    const operationRoot = resolve(this.stagingRoot, id);
    if (!operationRoot.startsWith(`${resolve(this.stagingRoot)}/`)) {
      throw new Error("Native helper operation root escaped its staging directory");
    }
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    await chmod(this.stagingRoot, 0o700);
    await mkdir(operationRoot, { recursive: false, mode: 0o700 });
    await chmod(operationRoot, 0o700);
    const filePath = join(operationRoot, sanitizedFilename(input.filename));
    const managedSha256 = sha256(input.bytes);
    const record: PersistedNativeFileOperation = {
      version: 1,
      ownerKey: input.ownerKey,
      id,
      sessionId: input.sessionId,
      action: input.action,
      filename: sanitizedFilename(input.filename),
      source: {
        ...input.source,
        baselineSha256: validSha256(input.source.baselineSha256)
          ? input.source.baselineSha256
          : managedSha256,
      },
      baselineSha256: validSha256(input.source.baselineSha256)
        ? input.source.baselineSha256
        : managedSha256,
      managedSha256,
      state: "staged",
      createdAt: new Date().toISOString(),
      filePath,
      operationRoot,
    };
    try {
      await writeFile(filePath, input.bytes, { flag: "wx", mode: 0o600 });
      await this.writeOperation(record);
      const result = await this.request<NativeHelperResult>({
        type: "action",
        version: NATIVE_HELPER_PROTOCOL_VERSION,
        id,
        action: input.action,
        filePath,
        displayName: record.filename,
        timeoutMs: this.requestTimeoutMs,
        ...(anchor ? { anchor } : {}),
        ...(input.applicationPath ? { applicationPath: input.applicationPath } : {}),
      });
      if (!result.ok) {
        throw Object.assign(new Error(result.error || "Native helper action failed"), {
          code: result.code,
        });
      }
      record.state = result.state || "completed";
      this.operations.set(id, record);
      await this.writeOperation(record);
      if (input.action !== "file.nativeEdit") {
        const timer = setTimeout(() => void this.cancelFileAction(id), TRANSIENT_OPERATION_TTL_MS);
        timer.unref?.();
      }
      return publicOperation(record);
    } catch (error) {
      await this.request<NativeHelperResult>({
        type: "cancel",
        version: NATIVE_HELPER_PROTOCOL_VERSION,
        id: randomUUID(),
        operationId: id,
      }).catch(() => undefined);
      await rm(operationRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async reclaimFileAction(
    ownerKey: string,
    sessionId: string,
    operationId: string,
  ): Promise<{
    operation: NativeFileOperation;
    bytes: Uint8Array;
    managedSha256: string;
    changed: boolean;
  }> {
    const record = await this.requireOperation(ownerKey, sessionId, operationId);
    if (record.action !== "file.nativeEdit") {
      throw Object.assign(new Error("Only native editing operations can be reclaimed"), {
        status: 409,
      });
    }
    const bytes = new Uint8Array(await readFile(record.filePath));
    const managedSha256 = sha256(bytes);
    record.state = "ready-to-reclaim";
    record.managedSha256 = managedSha256;
    this.operations.set(record.id, record);
    await this.writeOperation(record);
    return {
      operation: publicOperation(record),
      bytes,
      managedSha256,
      changed: managedSha256 !== record.baselineSha256,
    };
  }

  async listFileActions(ownerKey: string, sessionId: string): Promise<NativeFileOperation[]> {
    await this.cleanupStaleOperations();
    const active: NativeFileOperation[] = [];
    try {
      for (const operationId of await readdir(this.stagingRoot)) {
        const record = await this.loadOperation(operationId);
        if (
          record?.ownerKey === ownerKey &&
          record.sessionId === sessionId &&
          record.action === "file.nativeEdit"
        ) {
          active.push(publicOperation(record));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return active.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async cancelFileAction(
    operationId: string,
    sessionId?: string,
    ownerKey?: string,
  ): Promise<void> {
    const record =
      sessionId && ownerKey
        ? await this.requireOperation(ownerKey, sessionId, operationId)
        : await this.loadOperation(operationId);
    if (!record) return;
    await this.request<NativeHelperResult>({
      type: "cancel",
      version: NATIVE_HELPER_PROTOCOL_VERSION,
      id: randomUUID(),
      operationId,
    }).catch(() => undefined);
    this.operations.delete(operationId);
    await rm(record.operationRoot, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    this.operations.clear();
  }

  private async hello(): Promise<NativeHelperHello> {
    const response = await this.request<NativeHelperHello>({
      type: "hello",
      version: NATIVE_HELPER_PROTOCOL_VERSION,
      id: randomUUID(),
    });
    if (response.type !== "hello") throw new Error("Piwork Helper returned an invalid handshake");
    return response;
  }

  private request<T extends NativeHelperResponse>(payload: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const socket = createConnection(this.socketPath);
      const decoder = new StrictLfJsonlDecoder(MAX_PROTOCOL_FRAME_BYTES);
      const expectedId = String(payload.id || "");
      let settled = false;
      const finish = (error: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) rejectRequest(error);
        else resolveRequest(value as T);
      };
      const timer = setTimeout(
        () => finish(new Error("Piwork Helper request timed out")),
        this.requestTimeoutMs,
      );
      timer.unref?.();
      socket.once("error", (error) =>
        finish(new Error(`Piwork Helper is unavailable: ${error.message}`, { cause: error })),
      );
      socket.once("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          for (const line of decoder.push(chunk)) {
            const value = JSON.parse(line) as NativeHelperResponse;
            if (
              !value ||
              value.version !== NATIVE_HELPER_PROTOCOL_VERSION ||
              value.id !== expectedId
            ) {
              finish(new Error("Piwork Helper response binding is invalid"));
              return;
            }
            if (value.type === "error") {
              finish(new Error(value.error));
              return;
            }
            if (value.type === "progress") continue;
            finish(null, value as T);
          }
        } catch (error) {
          finish(
            new Error("Piwork Helper emitted an invalid protocol frame", {
              cause: error,
            }),
          );
        }
      });
      socket.once("end", () => {
        if (!settled) finish(new Error("Piwork Helper closed without a response"));
      });
    });
  }

  private async refreshLatestVersion(force: boolean): Promise<void> {
    if (!force && Date.now() - this.latestVersionCheckedAt < VERSION_CHECK_INTERVAL_MS) return;
    this.latestVersionCheckedAt = Date.now();
    this.latestVersion = await this.fetchLatestVersion();
  }

  private async writeOperation(record: PersistedNativeFileOperation): Promise<void> {
    const journalPath = join(record.operationRoot, "operation.json");
    await writeFile(journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  private async requireOperation(
    ownerKey: string,
    sessionId: string,
    operationId: string,
  ): Promise<PersistedNativeFileOperation> {
    const record = await this.loadOperation(operationId);
    if (!record || record.ownerKey !== ownerKey || record.sessionId !== sessionId) {
      throw Object.assign(new Error("Native file operation was not found"), { status: 404 });
    }
    return record;
  }

  private async loadOperation(operationId: string): Promise<PersistedNativeFileOperation | null> {
    if (!/^[0-9a-f-]{36}$/u.test(operationId)) return null;
    const active = this.operations.get(operationId);
    if (active) return active;
    const operationRoot = resolve(this.stagingRoot, operationId);
    if (!operationRoot.startsWith(`${resolve(this.stagingRoot)}/`)) return null;
    try {
      const parsed = JSON.parse(
        await readFile(join(operationRoot, "operation.json"), "utf8"),
      ) as PersistedNativeFileOperation;
      const fileInfo = await stat(parsed.filePath);
      if (
        parsed.version !== 1 ||
        parsed.id !== operationId ||
        typeof parsed.ownerKey !== "string" ||
        !parsed.ownerKey ||
        parsed.operationRoot !== operationRoot ||
        !parsed.filePath.startsWith(`${operationRoot}/`) ||
        !fileInfo.isFile()
      ) {
        return null;
      }
      this.operations.set(operationId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async cleanupStaleOperations(): Promise<void> {
    let operationIds: string[];
    try {
      operationIds = await readdir(this.stagingRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    const now = Date.now();
    await Promise.all(
      operationIds.map(async (operationId) => {
        const record = await this.loadOperation(operationId);
        if (!record) return;
        const createdAt = Date.parse(record.createdAt);
        const ttl =
          record.action === "file.nativeEdit"
            ? NATIVE_EDIT_OPERATION_TTL_MS
            : TRANSIENT_OPERATION_TTL_MS;
        if (!Number.isFinite(createdAt) || now - createdAt <= ttl) return;
        this.operations.delete(operationId);
        await rm(record.operationRoot, { recursive: true, force: true });
      }),
    );
  }
}

export const nativeHelperService = new NativeHelperService();
