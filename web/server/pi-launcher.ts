import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentMode, PiModelRef, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import { PiBootstrapServer, type PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";
import type { PiRpcNotification } from "./pi-rpc-contract.js";
import { observePiRuntimeLifecycle, type PiRuntimeObserver } from "./pi-runtime-observer.js";
import {
  assertPiSessionFileFromState,
  ensurePiSessionFile,
  preparePiSessionLayout,
  resolvePiResumeFile,
  type PiSessionLayout,
} from "./pi-session-layout.js";
import { readPiSessionDocument } from "./pi-session-history.js";
import {
  buildPiRpcArgs,
  resolvePinnedPiRuntime,
  resolvePinnedSrtRuntime,
  type PiRuntime,
  type RuntimePackage,
} from "./pi-runtime-resolver.js";
import {
  waitForPiReadiness,
  type PiReadinessMcpStatus,
  type PiReadinessResult,
} from "./pi-readiness.js";

const SRT_PROXY_PRELOAD_PATH = fileURLToPath(
  new URL("./pi-srt-proxy-preload.mjs", import.meta.url),
);

export type PiProcessState = "starting" | "ready" | "running" | "exited";

export interface PiSessionInfo {
  sessionId: string;
  pid?: number;
  state: PiProcessState;
  lifecycleState?: "enabled" | "closed";
  exitCode?: number | null;
  model?: PiModelRef;
  thinkingLevel: ThinkingLevel;
  mode: AgentMode;
  cwd: string;
  createdAt: number;
  backendType: "pi";
  transport: "pi-rpc";
  generation: number;
  piVersion: "0.82.1";
  piSessionRelativePath?: string;
  archived?: boolean;
  archivedAt?: number;
  name?: string;
}

export interface PiLaunchSandbox {
  settings: SandboxRuntimeConfig;
  /** Extra safe environment needed by managed Agent Space helper binaries. */
  toolEnvironment?: Readonly<Record<string, string>>;
  /** Canonical sealed Piwork resource root that owns Skills and helper binaries. */
  managedResourcesDir?: string;
  sessionBinDir?: string;
}

export interface PiLaunchOptions {
  sessionId?: string;
  sessionRoot: string;
  /** Canonical Agent Space cwd. Defaults to this Pi session's own workspace. */
  workingDirectory?: string;
  trustedExtensionPath: string;
  managedSkillPaths: readonly string[];
  bootstrapPayload: PiBootstrapPayload;
  sandbox: PiLaunchSandbox;
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  mode?: AgentMode;
  resumeSessionFile?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  onNotification?: (notification: PiRpcNotification, info: PiSessionInfo) => void;
  onExit?: (info: PiSessionInfo) => void;
  observer?: PiRuntimeObserver;
}

export interface PiLauncherDependencies {
  resolvePiRuntime?: () => PiRuntime;
  resolveSrtRuntime?: () => RuntimePackage;
  spawnProcess?: typeof spawn;
  createBootstrapServer?: (
    options: ConstructorParameters<typeof PiBootstrapServer>[0],
  ) => PiBootstrapServer;
  createTransport?: (options: ConstructorParameters<typeof PiRpcTransport>[0]) => PiRpcTransport;
}

interface ExtensionReadyStatus {
  version: 1;
  mode: AgentMode;
  mcp: PiReadinessMcpStatus[];
}

interface ActivePiRuntime {
  child: ChildProcessWithoutNullStreams;
  transport: PiRpcTransport;
  bootstrap: PiBootstrapServer;
  tempDir: string;
  layout: PiSessionLayout;
  generation: number;
  readiness: PiReadinessResult;
}

const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SENSITIVE_ENV_KEY = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i;
const PROCESS_EXIT_GRACE_MS = 5_000;
const PROCESS_EXIT_FORCE_MS = 2_000;

function uuid(value?: string): string {
  const sessionId = value || randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Invalid Pi session id");
  return sessionId.toLowerCase();
}

function piSessionRelativePath(path: string): string {
  return `pi-sessions/${basename(path)}`;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function assertPrivateTempDir(path: string): void {
  const canonicalTmp = realpathSync(tmpdir());
  const canonical = realpathSync(path);
  if (
    !isInside(canonicalTmp, canonical) ||
    !/^piwork-pi-[A-Za-z0-9_-]+$/.test(canonical.split(sep).at(-1) || "")
  ) {
    throw new Error("Refusing to clean an unexpected Pi runtime path");
  }
}

function safeToolEnvironment(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!input) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ENV_KEY.test(key) || SENSITIVE_ENV_KEY.test(key) || typeof value !== "string") {
      throw new Error(`Unsafe Pi tool environment key: ${key}`);
    }
    if (value.includes("\0")) throw new Error(`Unsafe Pi tool environment value: ${key}`);
    output[key] = value;
  }
  return output;
}

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function canonicalRealDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute directory`);
  }
  const normalized = resolve(path);
  const info = lstatSync(normalized);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = realpathSync(normalized);
  if (canonical !== normalized) {
    throw new Error(`${label} must be canonical`);
  }
  return canonical;
}

function policyGrantCovers(grants: readonly string[], candidate: string): boolean {
  return grants.some((grant) => {
    if (!isAbsolute(grant) || grant.includes("\0")) return false;
    return isInside(resolve(grant), candidate);
  });
}

function assertWorkingDirectoryPolicy(
  settings: SandboxRuntimeConfig,
  workingDirectory: string,
  mode: AgentMode,
): void {
  const allowRead = settings.filesystem?.allowRead || [];
  const allowWrite = settings.filesystem?.allowWrite || [];
  const denyWrite = settings.filesystem?.denyWrite || [];
  if (!policyGrantCovers(allowRead, workingDirectory)) {
    throw new Error("Pi working directory is not readable under the SRT policy");
  }
  if (
    mode === "agent" &&
    (!policyGrantCovers(allowWrite, workingDirectory) ||
      denyWrite.some((path) => isAbsolute(path) && pathsOverlap(resolve(path), workingDirectory)))
  ) {
    throw new Error("Pi Agent working directory is not writable under the SRT policy");
  }
}

function validateManagedResources(
  sandbox: PiLaunchSandbox,
  managedSkillPaths: readonly string[],
): { managedResourcesDir?: string; sessionBinDir?: string } {
  if (!sandbox.managedResourcesDir && !sandbox.sessionBinDir && managedSkillPaths.length === 0) {
    return {};
  }
  if (!sandbox.managedResourcesDir) {
    throw new Error("Managed Pi resources require an explicit resource root");
  }
  const managedResourcesDir = canonicalRealDirectory(
    sandbox.managedResourcesDir,
    "Managed Pi resource root",
  );
  if ((lstatSync(managedResourcesDir).mode & 0o222) !== 0) {
    throw new Error("Managed Pi resources must be sealed read-only");
  }
  const allowRead = sandbox.settings.filesystem?.allowRead || [];
  const allowWrite = sandbox.settings.filesystem?.allowWrite || [];
  if (!allowRead.some((path) => isAbsolute(path) && resolve(path) === managedResourcesDir)) {
    throw new Error("Managed Pi resources require an exact SRT read grant");
  }
  if (
    allowWrite.some((path) => isAbsolute(path) && pathsOverlap(resolve(path), managedResourcesDir))
  ) {
    throw new Error("Managed Pi resources must not overlap an SRT write grant");
  }

  const managedSkillsDir = canonicalRealDirectory(
    join(managedResourcesDir, "skills"),
    "Managed Pi Skills root",
  );
  for (const skillPath of managedSkillPaths) {
    const skill = canonicalRealDirectory(skillPath, "Managed Pi Skill");
    if (
      skill === managedSkillsDir ||
      !isInside(managedSkillsDir, skill) ||
      (lstatSync(skill).mode & 0o222) !== 0
    ) {
      throw new Error("Managed Pi Skill escaped its sealed resource root");
    }
  }

  if (!sandbox.sessionBinDir) return { managedResourcesDir };
  const sessionBinDir = canonicalRealDirectory(
    sandbox.sessionBinDir,
    "Managed session binary path",
  );
  if (
    sessionBinDir !== join(managedResourcesDir, "bin") ||
    (lstatSync(sessionBinDir).mode & 0o222) !== 0
  ) {
    throw new Error("Managed session binaries must use the sealed resource bin");
  }
  return { managedResourcesDir, sessionBinDir };
}

function childEnvironment(
  layout: PiSessionLayout,
  sandbox: PiLaunchSandbox,
  sessionBinDir?: string,
  caCertPath?: string,
): NodeJS.ProcessEnv {
  return {
    HOME: layout.homeDir,
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: join(layout.homeDir, ".cache"),
    PATH: [sessionBinDir, "/usr/bin", "/bin"].filter(Boolean).join(":"),
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PI_CODING_AGENT_DIR: layout.piRuntimeConfigDir,
    PI_CODING_AGENT_SESSION_DIR: layout.piSessionsDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    OPENSSL_CONF: "/dev/null",
    ...(caCertPath ? { SSL_CERT_FILE: caCertPath } : {}),
    ...safeToolEnvironment(sandbox.toolEnvironment),
  };
}

function systemCaCertPath(): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? ["/private/etc/ssl/cert.pem", "/etc/ssl/cert.pem"]
      : [
          "/etc/ssl/certs/ca-certificates.crt",
          "/etc/pki/tls/certs/ca-bundle.crt",
          "/etc/ssl/cert.pem",
        ];
  return candidates.find((path) => existsSync(path));
}

function writeSrtSettings(tempDir: string, settings: SandboxRuntimeConfig): string {
  const path = join(tempDir, "srt-settings.json");
  const serialized = `${JSON.stringify(settings)}\n`;
  if (/(api[_-]?key|bearer|password|credential|access[_-]?token)/i.test(serialized)) {
    throw new Error("SRT policy must not contain credentials");
  }
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return path;
}

function nodeModulesRoot(packageRoot: string): string {
  let cursor = realpathSync(packageRoot);
  while (dirname(cursor) !== cursor) {
    if (cursor.split(sep).at(-1) === "node_modules") return cursor;
    cursor = dirname(cursor);
  }
  throw new Error("Pinned Pi runtime is not installed beneath node_modules");
}

function nodeRuntimeReadPaths(nodePath: string): string[] {
  if (process.platform !== "darwin") return [];
  const canonicalNodePath = realpathSync(nodePath);
  const nodeRoot = dirname(dirname(canonicalNodePath));
  const cellarMarker = `${sep}Cellar${sep}`;
  const cellarIndex = nodeRoot.indexOf(cellarMarker);
  if (cellarIndex < 1) return [];
  const homebrewPrefix = nodeRoot.slice(0, cellarIndex);
  const homebrewCellar = join(homebrewPrefix, "Cellar");
  const homebrewOpt = join(homebrewPrefix, "opt");
  const readable = new Set<string>([nodeRoot]);
  const inspected = new Set<string>();
  const pending = [canonicalNodePath];

  while (pending.length > 0) {
    const binaryPath = pending.pop()!;
    if (inspected.has(binaryPath)) continue;
    inspected.add(binaryPath);
    const dependencies = execFileSync("/usr/bin/otool", ["-L", binaryPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    for (const line of dependencies.split("\n")) {
      const dependency = line.trim().split(/\s+\(/, 1)[0];
      if (!dependency?.startsWith(`${homebrewOpt}${sep}`) || !existsSync(dependency)) continue;
      const relativeDependency = relative(homebrewOpt, dependency);
      const formula = relativeDependency.split(sep)[0];
      if (!formula || formula === "..") continue;
      const formulaAlias = join(homebrewOpt, formula);
      const formulaRoot = realpathSync(formulaAlias);
      if (!isInside(homebrewCellar, formulaRoot)) {
        throw new Error("Homebrew Node dependency escaped the Cellar");
      }
      readable.add(formulaAlias);
      readable.add(formulaRoot);
      pending.push(realpathSync(dependency));
    }
  }
  return [...readable];
}

function augmentSrtSettings(
  settings: SandboxRuntimeConfig,
  layout: PiSessionLayout,
  pi: PiRuntime,
  srt: RuntimePackage,
  trustedExtensionPath: string,
  socketPaths: readonly string[],
): SandboxRuntimeConfig {
  const extensionPath = realpathSync(trustedExtensionPath);
  const extensionInfo = lstatSync(extensionPath);
  if (!extensionInfo.isFile() || extensionInfo.isSymbolicLink() || extensionInfo.nlink !== 1) {
    throw new Error("Trusted Pi extension must be a private regular file");
  }
  const runtimeReadPaths = [
    pi.nodePath,
    ...nodeRuntimeReadPaths(pi.nodePath),
    nodeModulesRoot(pi.packageRoot),
    srt.packageRoot,
    dirname(extensionPath),
    SRT_PROXY_PRELOAD_PATH,
  ].flatMap((path) => {
    const normalized = resolve(path);
    const canonical = realpathSync(normalized);
    return normalized === canonical ? [canonical] : [normalized, canonical];
  });
  for (const runtimePath of runtimeReadPaths) {
    if (isInside(layout.sessionRoot, runtimePath)) {
      throw new Error("Trusted runtime code must be outside the session data root");
    }
  }
  const safeSockets = socketPaths.map((path) => {
    if (
      !path.startsWith("/") ||
      path.includes("\0") ||
      isInside(layout.sessionRoot, resolve(path))
    ) {
      throw new Error("Runtime broker sockets must be absolute and server-owned");
    }
    return path;
  });
  return {
    ...settings,
    filesystem: {
      ...settings.filesystem,
      allowRead: [...new Set([...(settings.filesystem?.allowRead || []), ...runtimeReadPaths])],
    },
    network: {
      ...settings.network,
      allowUnixSockets: [
        ...new Set([...(settings.network?.allowUnixSockets || []), ...safeSockets]),
      ],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
  };
}

function normalizeBootstrap(
  payload: PiBootstrapPayload,
  sessionId: string,
  generation: number,
  mode: AgentMode,
  workingDirectory: string,
): PiBootstrapPayload {
  if (payload.sessionId !== sessionId) throw new Error("Bootstrap session authority mismatch");
  if (payload.generation !== generation) throw new Error("Bootstrap generation authority mismatch");
  if (payload.mode !== mode) throw new Error("Bootstrap Agent mode mismatch");
  const authorizedRoots = payload.authorizedRoots.map((root) => ({
    ...root,
    path: canonicalRealDirectory(root.path, "Bootstrap authorized root"),
  }));
  const cwdAuthority = authorizedRoots.find((root) => root.path === workingDirectory);
  if (!cwdAuthority || (mode === "agent" && cwdAuthority.access !== "write")) {
    throw new Error("Pi working directory does not match its bootstrap authority");
  }
  return {
    ...payload,
    authorizedRoots,
  };
}

function parseExtensionStatus(notification: PiRpcNotification): ExtensionReadyStatus | null {
  if (
    notification.type !== "extension_ui_request" ||
    notification.method !== "setStatus" ||
    notification.statusKey !== "piwork.extension" ||
    typeof notification.statusText !== "string"
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(notification.statusText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      (record.mode !== "agent" && record.mode !== "plan") ||
      !Array.isArray(record.mcp)
    ) {
      return null;
    }
    const mcp = record.mcp.flatMap((item): PiReadinessMcpStatus[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const server = item as Record<string, unknown>;
      const status = server.status;
      if (
        typeof server.name !== "string" ||
        (status !== "connected" &&
          status !== "failed" &&
          status !== "disabled" &&
          status !== "connecting")
      ) {
        return [];
      }
      return [{ name: server.name, status }];
    });
    return { version: 1, mode: record.mode, mcp };
  } catch {
    return null;
  }
}

function toMcpDetails(status: ExtensionReadyStatus | null): PiReadinessMcpStatus[] {
  if (!status) throw new Error("Trusted Pi extension status is unavailable");
  return status.mcp.map((server) => ({
    name: server.name,
    status: server.status,
  }));
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export class PiLauncher {
  private readonly sessions = new Map<string, PiSessionInfo>();
  private readonly runtimes = new Map<string, ActivePiRuntime>();
  private readonly launchOptions = new Map<string, PiLaunchOptions>();
  private readonly generations = new Map<string, number>();
  private readonly dependencies: Required<PiLauncherDependencies>;
  private shuttingDown = false;

  constructor(dependencies: PiLauncherDependencies = {}) {
    this.dependencies = {
      resolvePiRuntime: dependencies.resolvePiRuntime || resolvePinnedPiRuntime,
      resolveSrtRuntime: dependencies.resolveSrtRuntime || resolvePinnedSrtRuntime,
      spawnProcess: dependencies.spawnProcess || spawn,
      createBootstrapServer:
        dependencies.createBootstrapServer || ((options) => new PiBootstrapServer(options)),
      createTransport: dependencies.createTransport || ((options) => new PiRpcTransport(options)),
    };
  }

  private nextGeneration(sessionId: string): number {
    const generation = (this.generations.get(sessionId) || 0) + 1;
    this.generations.set(sessionId, generation);
    return generation;
  }

  /** Generation the next one-child launch must bind into its one-use bootstrap. */
  nextLaunchGeneration(sessionId: string): number {
    return (this.generations.get(uuid(sessionId)) || 0) + 1;
  }

  private async terminateAfterTransportFailure(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    signalProcessTree(child, "SIGTERM");
    if (await waitForChildExit(child, PROCESS_EXIT_GRACE_MS)) return;
    signalProcessTree(child, "SIGKILL");
    await waitForChildExit(child, PROCESS_EXIT_FORCE_MS);
  }

  async launch(options: PiLaunchOptions): Promise<PiSessionInfo> {
    if (this.shuttingDown) throw new Error("Pi launcher is shutting down");
    const sessionId = uuid(options.sessionId);
    if (this.runtimes.has(sessionId)) throw new Error("Pi session already has an active runtime");

    const previousGeneration = this.generations.get(sessionId) || 0;
    const generation = this.nextGeneration(sessionId);
    const observationContext = { sessionId, generation };
    let transportErrorRecorded = false;
    observePiRuntimeLifecycle(
      options.observer,
      {
        type: "generation_change",
        meta: { previousGeneration, generation },
      },
      observationContext,
    );
    if (generation > 1) {
      observePiRuntimeLifecycle(
        options.observer,
        { type: "reconnect_attempt", meta: { previousGeneration } },
        observationContext,
      );
    }
    const layout = preparePiSessionLayout(options.sessionRoot);
    const mode = options.mode || "agent";
    const thinkingLevel = options.thinkingLevel || "medium";
    const workingDirectory = canonicalRealDirectory(
      options.workingDirectory || layout.workspaceDir,
      "Pi working directory",
    );
    const requestedResumeSessionFile = options.resumeSessionFile
      ? resolvePiResumeFile(layout, options.resumeSessionFile, workingDirectory)
      : undefined;
    const sessionFile =
      requestedResumeSessionFile ?? ensurePiSessionFile(layout, sessionId, workingDirectory);
    const resumeDocument = await readPiSessionDocument({
      sessionDir: layout.sessionRoot,
      piSessionRelativePath: piSessionRelativePath(sessionFile),
      expectedPiSessionId: sessionId,
      expectedCwd: workingDirectory,
    });
    const payload = normalizeBootstrap(
      options.bootstrapPayload,
      sessionId,
      generation,
      mode,
      workingDirectory,
    );
    assertWorkingDirectoryPolicy(options.sandbox.settings, workingDirectory, mode);
    const managedResources = validateManagedResources(options.sandbox, options.managedSkillPaths);
    const pi = this.dependencies.resolvePiRuntime();
    const srt = this.dependencies.resolveSrtRuntime();
    const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-")));
    chmodSync(tempDir, 0o700);
    const socketPath = join(tempDir, "bootstrap.sock");
    const bootstrap = this.dependencies.createBootstrapServer({
      socketPath,
      payload,
      ttlMs: options.readyTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    await bootstrap.start();

    const brokerSockets = [
      socketPath,
      payload.mcpBroker?.socketPath,
      payload.taskPolicy.brokerSocket,
    ].filter((path): path is string => Boolean(path));
    const settingsPath = writeSrtSettings(
      tempDir,
      augmentSrtSettings(
        options.sandbox.settings,
        layout,
        pi,
        srt,
        options.trustedExtensionPath,
        brokerSockets,
      ),
    );
    const rpcArgs = buildPiRpcArgs({
      sessionId,
      generation,
      sessionDir: layout.piSessionsDir,
      trustedExtensionPath: options.trustedExtensionPath,
      managedSkillPaths: options.managedSkillPaths,
      bootstrapSocketPath: socketPath,
      resumeSessionFile: sessionFile,
      model: options.model,
      thinkingLevel,
    });
    const caCertPath = systemCaCertPath();
    const command = [
      "--settings",
      settingsPath,
      pi.nodePath,
      ...(caCertPath ? ["--use-openssl-ca"] : []),
      "--import",
      SRT_PROXY_PRELOAD_PATH,
      pi.entryPath,
      ...rpcArgs,
    ];

    const info: PiSessionInfo = {
      sessionId,
      state: "starting",
      lifecycleState: "enabled",
      model: options.model,
      thinkingLevel,
      mode,
      cwd: workingDirectory,
      createdAt: Date.now(),
      backendType: "pi",
      transport: "pi-rpc",
      generation,
      piVersion: "0.82.1",
    };
    this.sessions.set(sessionId, info);

    let child: ChildProcessWithoutNullStreams | undefined;
    let transport: PiRpcTransport | undefined;
    let runtimePublished = false;
    let transportFailureTermination: Promise<void> | undefined;
    try {
      child = this.dependencies.spawnProcess(pi.nodePath, [srt.entryPath, ...command], {
        cwd: workingDirectory,
        env: childEnvironment(layout, options.sandbox, managedResources.sessionBinDir, caCertPath),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      if (!child.pid) throw new Error("SRT did not return a Pi process id");
      info.pid = child.pid;
      child.once("exit", (exitCode, signal) => {
        observePiRuntimeLifecycle(
          options.observer,
          {
            type: "process_exit",
            meta: { exitCode, signal },
          },
          observationContext,
        );
      });
      observePiRuntimeLifecycle(
        options.observer,
        { type: "process_spawn", meta: { pid: child.pid } },
        observationContext,
      );

      let latestExtensionStatus: ExtensionReadyStatus | null = null;
      let resolveExtension!: (status: ExtensionReadyStatus) => void;
      let rejectExtension!: (error: Error) => void;
      const extensionReady = new Promise<ExtensionReadyStatus>((resolveReady, rejectReady) => {
        resolveExtension = resolveReady;
        rejectExtension = rejectReady;
      });
      transport = this.dependencies.createTransport({
        sessionId,
        generation,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        process: child,
        requestTimeoutMs: options.requestTimeoutMs,
        observer: options.observer,
        sensitiveValues: payload.providers.flatMap((provider) => [
          provider.config.apiKey,
          ...Object.values(provider.config.headers || {}),
        ]),
        isGenerationCurrent: () =>
          !this.shuttingDown && this.generations.get(sessionId) === generation,
        onNotification: (notification) => {
          const status = parseExtensionStatus(notification);
          if (status) {
            latestExtensionStatus = status;
            resolveExtension(status);
          }
          options.onNotification?.(notification, info);
        },
        onProtocolError: (error) => {
          rejectExtension(error instanceof Error ? error : new Error(String(error)));
        },
        onLifecycle: (event) => {
          if (
            event.type === "closed" &&
            event.code !== "closed" &&
            event.code !== "child_exit" &&
            event.code !== "stale_generation"
          ) {
            transportErrorRecorded = true;
            observePiRuntimeLifecycle(
              options.observer,
              { type: "transport_error", meta: { code: event.code } },
              observationContext,
            );
            if (runtimePublished && child && !transportFailureTermination) {
              transportFailureTermination = this.terminateAfterTransportFailure(child);
            }
          }
        },
      });

      const readiness = await waitForPiReadiness({
        transport,
        expectedSessionFile: sessionFile,
        expectedHistoryEntries: resumeDocument.entries,
        expectedMode: mode,
        extensionReady,
        getMcpStatus: async () => toMcpDetails(latestExtensionStatus),
        timeoutMs: options.readyTimeoutMs,
      });
      const readySessionFile = assertPiSessionFileFromState(
        layout,
        readiness.state.sessionFile,
        workingDirectory,
      );
      await readPiSessionDocument({
        sessionDir: layout.sessionRoot,
        piSessionRelativePath: piSessionRelativePath(readySessionFile),
        expectedPiSessionId: sessionId,
        expectedCwd: workingDirectory,
      });
      if (transport.isClosed) {
        throw await transport.waitForClose();
      }
      info.piSessionRelativePath = piSessionRelativePath(readySessionFile);
      info.state = "ready";
      observePiRuntimeLifecycle(
        options.observer,
        { type: "process_ready", meta: { piVersion: info.piVersion } },
        observationContext,
      );
      if (generation > 1) {
        observePiRuntimeLifecycle(
          options.observer,
          { type: "reconnect_success" },
          observationContext,
        );
      }
      const runtime: ActivePiRuntime = {
        child,
        transport,
        bootstrap,
        tempDir,
        layout,
        generation,
        readiness,
      };
      this.runtimes.set(sessionId, runtime);
      this.launchOptions.set(sessionId, {
        ...options,
        workingDirectory,
        bootstrapPayload: payload,
        sandbox: {
          ...options.sandbox,
          managedResourcesDir: managedResources.managedResourcesDir,
          sessionBinDir: managedResources.sessionBinDir,
        },
      });

      child.once("exit", (code) => {
        if (this.generations.get(sessionId) !== generation) return;
        const current = this.runtimes.get(sessionId);
        if (current?.generation === generation) this.runtimes.delete(sessionId);
        info.state = "exited";
        info.exitCode = code;
        delete info.pid;
        void bootstrap.dispose().catch(() => undefined);
        this.cleanTemp(tempDir);
        options.onExit?.(info);
      });
      runtimePublished = true;
      if (transport.isClosed && !transportFailureTermination) {
        transportFailureTermination = this.terminateAfterTransportFailure(child);
      }
      await bootstrap.waitForConsumption();
      info.state = "running";
      return { ...info };
    } catch (cause) {
      if (!transportErrorRecorded) {
        observePiRuntimeLifecycle(
          options.observer,
          {
            type: "transport_error",
            meta: {
              phase: transport ? "readiness" : child ? "transport_setup" : "spawn",
              errorName: cause instanceof Error ? cause.name : "UnknownError",
            },
          },
          observationContext,
        );
      }
      transport?.dispose();
      if (child) {
        signalProcessTree(child, "SIGKILL");
        await waitForChildExit(child, PROCESS_EXIT_FORCE_MS);
      }
      await bootstrap.dispose().catch(() => undefined);
      this.cleanTemp(tempDir);
      if (this.generations.get(sessionId) === generation) {
        info.state = "exited";
        info.exitCode = child?.exitCode ?? 1;
        delete info.pid;
      }
      throw cause;
    }
  }

  getSession(sessionId: string): PiSessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    return info ? { ...info } : undefined;
  }

  /** Restore product metadata only; activation must build fresh launch authority. */
  restoreSession(info: PiSessionInfo): void {
    const sessionId = uuid(info.sessionId);
    if (this.runtimes.has(sessionId) || this.sessions.has(sessionId)) return;
    if (info.backendType !== "pi" || info.transport !== "pi-rpc") {
      throw new Error("Only Pi RPC sessions may be restored");
    }
    const generation = Math.max(0, Math.floor(info.generation || 0));
    this.generations.set(sessionId, generation);
    this.sessions.set(sessionId, {
      ...info,
      sessionId,
      state: "exited",
      lifecycleState: info.archived ? "closed" : "enabled",
      generation,
      pid: undefined,
      exitCode: info.exitCode ?? 0,
    });
  }

  listSessions(): PiSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session }));
  }

  getTransport(sessionId: string): PiRpcTransport | undefined {
    return this.runtimes.get(sessionId)?.transport;
  }

  getReadiness(sessionId: string): PiReadinessResult | undefined {
    return this.runtimes.get(sessionId)?.readiness;
  }

  getSandboxedGeneration(sessionId: string): number | undefined {
    return this.runtimes.get(sessionId)?.generation;
  }

  validateLaunchGeneration(sessionId: string, generation: number): boolean {
    return (
      Number.isSafeInteger(generation) &&
      generation > 0 &&
      this.runtimes.get(sessionId)?.generation === generation
    );
  }

  isAlive(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  async relaunch(sessionId: string, bootstrapPayload?: PiBootstrapPayload): Promise<PiSessionInfo> {
    const previous = this.launchOptions.get(sessionId);
    if (!previous) throw new Error("Pi session launch authority is not available");
    await this.kill(sessionId);
    const generation = (this.generations.get(sessionId) || 0) + 1;
    const payload = bootstrapPayload || {
      ...previous.bootstrapPayload,
      generation,
    };
    return this.launch({
      ...previous,
      sessionId,
      bootstrapPayload: payload,
      resumeSessionFile: this.sessionFileFor(sessionId),
    });
  }

  private sessionFileFor(sessionId: string): string | undefined {
    const info = this.sessions.get(sessionId);
    const options = this.launchOptions.get(sessionId);
    if (!info?.piSessionRelativePath || !options) return options?.resumeSessionFile;
    return join(resolve(options.sessionRoot), info.piSessionRelativePath);
  }

  async kill(sessionId: string): Promise<boolean> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      const info = this.sessions.get(sessionId);
      return !info || info.state === "exited";
    }
    await runtime.transport.abort({ timeoutMs: 750 }).catch(() => undefined);
    this.generations.set(sessionId, runtime.generation + 1);
    this.runtimes.delete(sessionId);
    runtime.transport.dispose();
    signalProcessTree(runtime.child, "SIGTERM");
    let exited = await waitForChildExit(runtime.child, PROCESS_EXIT_GRACE_MS);
    if (!exited) {
      signalProcessTree(runtime.child, "SIGKILL");
      exited = await waitForChildExit(runtime.child, PROCESS_EXIT_FORCE_MS);
    }
    await runtime.bootstrap.dispose().catch(() => undefined);
    this.cleanTemp(runtime.tempDir);
    const info = this.sessions.get(sessionId);
    if (info) {
      info.state = "exited";
      info.exitCode = runtime.child.exitCode ?? -1;
      delete info.pid;
    }
    return exited;
  }

  async killAll(options: { shutdown?: boolean } = {}): Promise<void> {
    if (options.shutdown !== false) this.shuttingDown = true;
    const outcomes = await Promise.allSettled(
      [...this.runtimes.keys()].map((sessionId) => this.kill(sessionId)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" || outcome.value !== true
        ? [outcome.status === "rejected" ? outcome.reason : new Error("Pi process did not exit")]
        : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "One or more Pi runtimes remain active");
  }

  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    info.archived = archived;
    if (archived) info.archivedAt = Date.now();
    else delete info.archivedAt;
  }

  removeSession(sessionId: string): void {
    if (this.runtimes.has(sessionId)) {
      throw new Error("Cannot remove an active Pi runtime");
    }
    this.sessions.delete(sessionId);
    this.launchOptions.delete(sessionId);
    this.generations.delete(sessionId);
  }

  private cleanTemp(path: string): void {
    assertPrivateTempDir(path);
    rmSync(path, { recursive: true, force: true });
  }
}
