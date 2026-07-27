import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, environment } from "./environment.js";

const PROVIDER_RELATIVE_PATH = "packages/@agent-browser/chrome-extension-provider";
const DEFAULT_BRIDGE_PORT = 19826;
const SOCKET_LEASE_FILE = ".piwork-agent-browser-lease.json";
const DEFAULT_SOCKET_STALE_AFTER_MS = 20 * 60 * 1_000;

interface AgentBrowserSocketLease {
  schemaVersion: 1;
  sessionId: string;
  sessionRoot: string;
  ownerPid: number;
  createdAt: number;
  lastTouchedAt: number;
}

interface SocketLeaseOptions {
  now?: number;
  ownerPid?: number;
}

interface SocketReaperOptions {
  root?: string;
  now?: number;
  staleAfterMs?: number;
  pidIsAlive?: (pid: number) => boolean;
}

export interface AgentBrowserRuntime {
  enabled: boolean;
  ready: boolean;
  rootDir: string;
  cliEntrypoint: string;
  nativeCli: string;
  providerPlugin: string;
  providerDist: string;
  pluginRunner: string;
  daemonScript: string;
  extensionDir: string;
  bridgePort: number;
  bridgeProtocolVersion: number;
  sourceCommit: string | null;
  version: string | null;
  missing: string[];
}

export function agentBrowserNativeBinaryName(): string {
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.platform === "win32" && process.arch === "arm64" ? "x64" : process.arch;
  return `agent-browser-${platform}-${arch}${process.platform === "win32" ? ".exe" : ""}`;
}

interface ReleaseManifest {
  commitSha?: unknown;
  cliVersion?: unknown;
  defaultBridgePort?: unknown;
  bridgeProtocolVersion?: unknown;
}

function repoRoot(): string {
  const packageRoot = environment.packageRoot;
  if (packageRoot) return resolve(packageRoot, "..");
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function releaseManifest(root: string): ReleaseManifest {
  const path = join(root, "release", "agent-browser-release-manifest.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
  } catch {
    return {};
  }
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function installedVersion(rootDir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

function installedCommit(rootDir: string): string | null {
  try {
    const value = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function resolveAgentBrowserRuntime(): AgentBrowserRuntime {
  const root = repoRoot();
  const manifest = releaseManifest(root);
  const configuredPort = environment.number(
    ENV.PIWORK_AGENT_BROWSER_BRIDGE_PORT,
    typeof manifest.defaultBridgePort === "number" && validPort(manifest.defaultBridgePort)
      ? manifest.defaultBridgePort
      : DEFAULT_BRIDGE_PORT,
  );
  const bridgePort = validPort(configuredPort) ? configuredPort : DEFAULT_BRIDGE_PORT;
  const rootDir = resolve(
    environment.optionalString(ENV.PIWORK_AGENT_BROWSER_DIR, false) || join(root, "agent-browser"),
  );
  const providerDir = join(rootDir, PROVIDER_RELATIVE_PATH);
  const actualVersion = installedVersion(rootDir);
  const actualCommit = installedCommit(rootDir);
  const paths = {
    cliEntrypoint: join(rootDir, "bin", "agent-browser.js"),
    nativeCli: join(rootDir, "bin", agentBrowserNativeBinaryName()),
    providerPlugin: join(providerDir, "dist", "plugin.js"),
    providerDist: join(providerDir, "dist"),
    pluginRunner: join(root, "scripts", "agent-browser-plugin-runner.mjs"),
    daemonScript: join(providerDir, "dist", "daemon", "cli.js"),
    extensionDir: join(providerDir, ".output", "chrome-mv3"),
  };
  const required = [
    ["agent-browser CLI", paths.cliEntrypoint],
    ["agent-browser native CLI", paths.nativeCli],
    ["Chrome provider plugin", paths.providerPlugin],
    ["Chrome provider process runner", paths.pluginRunner],
    ["Chrome bridge daemon", paths.daemonScript],
    ["Chrome extension manifest", join(paths.extensionDir, "manifest.json")],
  ] as const;
  const missing: string[] = required
    .filter(([, path]) => !existsSync(path))
    .map(([label]) => label);
  if (
    actualVersion &&
    typeof manifest.cliVersion === "string" &&
    actualVersion !== manifest.cliVersion
  ) {
    missing.push(`agent-browser version ${manifest.cliVersion}`);
  }
  if (
    actualCommit &&
    typeof manifest.commitSha === "string" &&
    actualCommit !== manifest.commitSha
  ) {
    missing.push(`agent-browser commit ${manifest.commitSha.slice(0, 12)}`);
  }
  const enabled = environment.bool(ENV.PIWORK_AGENT_BROWSER_ENABLED, true);
  return {
    enabled,
    ready: enabled && missing.length === 0,
    rootDir,
    ...paths,
    bridgePort,
    bridgeProtocolVersion:
      typeof manifest.bridgeProtocolVersion === "number" ? manifest.bridgeProtocolVersion : 1,
    sourceCommit:
      actualCommit || (typeof manifest.commitSha === "string" ? manifest.commitSha : null),
    version:
      actualVersion || (typeof manifest.cliVersion === "string" ? manifest.cliVersion : null),
    missing,
  };
}

export function agentBrowserSessionName(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `nex-${digest}`;
}

export function agentBrowserSocketRoot(): string {
  // Unix-domain sockets have a small path limit (103 bytes on macOS). The
  // per-user macOS TMPDIR is already long, so keep this host-owned runtime
  // root under the short system temp path.
  return process.platform === "win32"
    ? join(tmpdir(), "piwork-agent-browser")
    : "/tmp/piwork-agent-browser";
}

export function ensureAgentBrowserSocketRoot(): string {
  const root = agentBrowserSocketRoot();
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Agent browser socket root must be a real directory: ${root}`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`Agent browser socket root must be owned by the Piwork process: ${root}`);
  }
  chmodSync(root, 0o700);
  return realpathSync(root);
}

function readSocketLease(socketDir: string): AgentBrowserSocketLease | null {
  try {
    const value = JSON.parse(
      readFileSync(join(socketDir, SOCKET_LEASE_FILE), "utf8"),
    ) as Partial<AgentBrowserSocketLease>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.sessionId !== "string" ||
      typeof value.sessionRoot !== "string" ||
      typeof value.ownerPid !== "number" ||
      !Number.isSafeInteger(value.ownerPid) ||
      value.ownerPid <= 0 ||
      typeof value.createdAt !== "number" ||
      typeof value.lastTouchedAt !== "number"
    ) {
      return null;
    }
    return value as AgentBrowserSocketLease;
  } catch {
    return null;
  }
}

export function refreshAgentBrowserSocketLease(
  socketDir: string,
  sessionId: string,
  sessionRoot: string,
  options: SocketLeaseOptions = {},
): void {
  const info = lstatSync(socketDir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Agent browser socket directory must be a real directory: ${socketDir}`);
  }
  const now = options.now ?? Date.now();
  const ownerPid = options.ownerPid ?? process.pid;
  const previous = readSocketLease(socketDir);
  const lease: AgentBrowserSocketLease = {
    schemaVersion: 1,
    sessionId,
    sessionRoot: resolve(sessionRoot),
    ownerPid,
    createdAt:
      previous?.sessionId === sessionId && previous.sessionRoot === resolve(sessionRoot)
        ? previous.createdAt
        : now,
    lastTouchedAt: now,
  };
  const target = join(socketDir, SOCKET_LEASE_FILE);
  const staged = join(socketDir, `.${randomUUID()}.lease.tmp`);
  try {
    writeFileSync(staged, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(staged, target);
  } finally {
    rmSync(staged, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reapStaleAgentBrowserSocketDirs(options: SocketReaperOptions = {}): number {
  const configuredRoot = options.root ?? agentBrowserSocketRoot();
  if (!existsSync(configuredRoot)) {
    if (options.root) return 0;
    ensureAgentBrowserSocketRoot();
  }
  const rootInfo = lstatSync(configuredRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Agent browser socket root must be a real directory: ${configuredRoot}`);
  }
  const root = options.root ? realpathSync(configuredRoot) : ensureAgentBrowserSocketRoot();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_SOCKET_STALE_AFTER_MS;
  const pidIsAlive = options.pidIsAlive ?? processIsAlive;
  let removed = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const lease = readSocketLease(path);
      const lastTouchedAt = lease?.lastTouchedAt ?? statSync(path).mtimeMs;
      const sessionRootIsGone = Boolean(lease && !existsSync(lease.sessionRoot));
      if (!sessionRootIsGone && now - lastTouchedAt < staleAfterMs) continue;
      if (lease && pidIsAlive(lease.ownerPid)) continue;
      const nativePidIsAlive = readdirSync(path)
        .filter((name) => name.endsWith(".pid"))
        .some((name) => {
          const pid = Number.parseInt(readFileSync(join(path, name), "utf8").trim(), 10);
          return Number.isSafeInteger(pid) && pid > 0 && pidIsAlive(pid);
        });
      if (nativePidIsAlive) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A concurrent session may create/remove files while the janitor scans.
    }
  }
  return removed;
}

export function agentBrowserSocketDir(sessionId: string, sessionRoot: string): string {
  const digest = createHash("sha256")
    .update(resolve(sessionRoot))
    .update("\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 20);
  return join(agentBrowserSocketRoot(), digest);
}

export function buildAgentBrowserProcessEnv(
  runtime: AgentBrowserRuntime,
  input: {
    sessionId: string;
    socketDir: string;
    logPath?: string;
    providerPlugin?: string;
    pluginRunner?: string;
  },
): Record<string, string> {
  const providerPlugin = input.providerPlugin || runtime.providerPlugin;
  const pluginRunner = input.pluginRunner || runtime.pluginRunner;
  return {
    [ENV.AGENT_BROWSER_PLUGINS]: JSON.stringify([
      {
        name: "chrome-extension",
        command: process.execPath,
        args: [pluginRunner, providerPlugin],
        capabilities: ["browser.provider", "command.run", "chrome-extension.manage"],
      },
    ]),
    [ENV.AGENT_BROWSER_PROVIDER]: "chrome-extension",
    [ENV.AGENT_BROWSER_CHROME_BRIDGE_PORT]: String(runtime.bridgePort),
    [ENV.AGENT_BROWSER_CHROME_BRIDGE_DAEMON]: runtime.daemonScript,
    [ENV.AGENT_BROWSER_SOCKET_DIR]: input.socketDir,
    [ENV.AGENT_BROWSER_IDLE_TIMEOUT_MS]: "900000",
    [ENV.PIWORK_AGENT_BROWSER_SESSION_ID]: agentBrowserSessionName(input.sessionId),
    ...(input.logPath ? { [ENV.AGENT_BROWSER_CHROME_BRIDGE_LOG]: input.logPath } : {}),
  };
}
