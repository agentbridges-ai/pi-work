import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ensureAgentBrowserSocketRoot,
  agentBrowserSessionName,
  buildAgentBrowserProcessEnv,
  resolveAgentBrowserRuntime,
  type AgentBrowserRuntime,
} from "./agent-browser-runtime.js";
import { ENV, environment } from "./environment.js";

export type AgentBrowserBridgePhase =
  "unavailable" | "stopped" | "starting" | "waiting_for_extension" | "connected" | "error";

export interface AgentBrowserBridgeStatus {
  schemaVersion: 1;
  phase: AgentBrowserBridgePhase;
  runtime: {
    ready: boolean;
    version: string | null;
    sourceCommit: string | null;
    missing: string[];
  };
  daemon: {
    state: "offline" | "online";
    port: number;
    version: string | null;
    protocolVersion: number | null;
    sessionCount: number;
  };
  extension: {
    connected: boolean;
    path: string;
    profiles: Array<{
      profileId: string;
      chromeVersion: string | null;
      tabCount: number;
    }>;
  };
  error?: string;
}

export interface AgentBrowserVerification {
  ok: true;
  durationMs: number;
  probe: "active_tab_url";
  status: AgentBrowserBridgeStatus;
}

export interface AgentBrowserControlEvent {
  sequence: number;
  ownerSessionId: string;
  bridgeSessionId: string;
  action: "takeover" | "stop";
  tabId: number;
  pendingActionRisk: boolean;
  createdAt: string;
}

export interface AgentBrowserControlUpdate {
  reachable: boolean;
  matched: number;
}

export interface AgentBrowserSemanticReadback {
  snapshot: string;
  truncated: boolean;
}

const SEMANTIC_READBACK_MAX_CHARS = 64_000;

interface BridgeHealth {
  daemon?: unknown;
  version?: unknown;
  bridgeProtocolVersion?: unknown;
  profiles?: unknown;
  sessions?: unknown;
}

interface BridgeControlEventsResponse {
  sequence?: unknown;
  events?: unknown;
}

interface DaemonOwnerRecord {
  schemaVersion: 1;
  pid: number;
  startedAt: number;
  daemonScript: string;
  port: number;
  version: string | null;
  protocolVersion: number;
}

interface ServiceDependencies {
  runtime?: AgentBrowserRuntime;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  runCli?: (
    command: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pidIsAlive?: (pid: number) => boolean;
  pidMatchesDaemon?: (pid: number, daemonScript: string, startedAt: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  maxLogBytes?: number;
  maxLogBackups?: number;
}

function commandResult(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout>;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      reject(new Error(`agent-browser command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimers();
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(stderr.trim() || stdout.trim() || `agent-browser exited with code ${code}`),
        );
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function profileSummaries(value: unknown): AgentBrowserBridgeStatus["extension"]["profiles"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const profile = asRecord(entry);
    if (!profile || typeof profile.profileId !== "string") return [];
    return [
      {
        profileId: profile.profileId,
        chromeVersion: typeof profile.chromeVersion === "string" ? profile.chromeVersion : null,
        tabCount:
          typeof profile.tabCount === "number" && Number.isFinite(profile.tabCount)
            ? Math.max(0, Math.floor(profile.tabCount))
            : 0,
      },
    ];
  });
}

function parseControlEvent(value: unknown): AgentBrowserControlEvent | null {
  const event = asRecord(value);
  if (
    !event ||
    typeof event.sequence !== "number" ||
    !Number.isInteger(event.sequence) ||
    event.sequence <= 0 ||
    typeof event.ownerSessionId !== "string" ||
    !/^nex-[a-f0-9]{16}$/.test(event.ownerSessionId) ||
    typeof event.bridgeSessionId !== "string" ||
    (event.action !== "takeover" && event.action !== "stop") ||
    typeof event.tabId !== "number" ||
    !Number.isInteger(event.tabId) ||
    typeof event.pendingActionRisk !== "boolean" ||
    typeof event.createdAt !== "string"
  )
    return null;
  return {
    sequence: event.sequence,
    ownerSessionId: event.ownerSessionId,
    bridgeSessionId: event.bridgeSessionId,
    action: event.action,
    tabId: event.tabId,
    pendingActionRisk: event.pendingActionRisk,
    createdAt: event.createdAt,
  };
}

export class AgentBrowserBridgeService {
  private readonly runtime: AgentBrowserRuntime;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly runCli: NonNullable<ServiceDependencies["runCli"]>;
  private readonly sleep: NonNullable<ServiceDependencies["sleep"]>;
  private readonly now: NonNullable<ServiceDependencies["now"]>;
  private readonly pidIsAlive: NonNullable<ServiceDependencies["pidIsAlive"]>;
  private readonly pidMatchesDaemon: NonNullable<ServiceDependencies["pidMatchesDaemon"]>;
  private readonly signalProcess: NonNullable<ServiceDependencies["signalProcess"]>;
  private readonly maxLogBytes: number;
  private readonly maxLogBackups: number;
  private daemonProcess: ChildProcess | null = null;
  private ownedDaemonPid: number | null = null;
  private startPromise: Promise<AgentBrowserBridgeStatus> | null = null;
  private healthPromise: Promise<BridgeHealth | null> | null = null;
  private lastError = "";
  private disposed = false;
  private controlEventHandler: ((event: AgentBrowserControlEvent) => void | Promise<void>) | null =
    null;
  private controlPollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastControlEventSequence = 0;

  constructor(deps: ServiceDependencies = {}) {
    this.runtime = deps.runtime || resolveAgentBrowserRuntime();
    this.fetchImpl = deps.fetchImpl || fetch;
    this.spawnImpl = deps.spawnImpl || spawn;
    this.runCli = deps.runCli || commandResult;
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now || Date.now;
    this.pidIsAlive =
      deps.pidIsAlive ||
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    this.pidMatchesDaemon =
      deps.pidMatchesDaemon ||
      ((pid, daemonScript, startedAt) => {
        if (process.platform === "win32") return false;
        try {
          const readProcessField = (field: "command" | "lstart") =>
            execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              env: { ...process.env, LC_ALL: "C" },
            });
          const command = readProcessField("command");
          const processStartedAt = Date.parse(readProcessField("lstart").trim());
          return (
            command.includes(daemonScript) &&
            Number.isFinite(processStartedAt) &&
            Math.abs(processStartedAt - startedAt) <= 10_000
          );
        } catch {
          return false;
        }
      });
    this.signalProcess = deps.signalProcess || ((pid, signal) => void process.kill(pid, signal));
    this.maxLogBytes = deps.maxLogBytes ?? 10 * 1024 * 1024;
    this.maxLogBackups = deps.maxLogBackups ?? 3;
  }

  async status(): Promise<AgentBrowserBridgeStatus> {
    this.rotateBridgeLogIfNeeded();
    if (!this.runtime.ready) return this.buildStatus(null, "unavailable");
    const health = await this.readHealth();
    if (!health) {
      const phase = this.startPromise ? "starting" : this.lastError ? "error" : "stopped";
      return this.buildStatus(null, phase);
    }
    const profiles = profileSummaries(health.profiles);
    this.lastError = "";
    return this.buildStatus(health, profiles.length > 0 ? "connected" : "waiting_for_extension");
  }

  async start(): Promise<AgentBrowserBridgeStatus> {
    this.rotateBridgeLogIfNeeded();
    if (this.disposed) return this.buildStatus(null, "stopped");
    if (!this.runtime.ready) return this.status();
    const current = await this.readHealth();
    if (this.disposed) return this.buildStatus(null, "stopped");
    if (current) {
      this.adoptOwnedDaemon();
      return this.status();
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.replaceUnhealthyOwnedDaemon()
      .then((replaced) =>
        replaced && !this.disposed ? this.startDaemon() : this.buildStatus(null, "stopped"),
      )
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async verify(): Promise<AgentBrowserVerification> {
    const status = await this.start();
    if (status.phase !== "connected") {
      throw new Error(
        status.phase === "waiting_for_extension"
          ? "Chrome extension is not connected"
          : status.error || "Chrome bridge is unavailable",
      );
    }

    const startedAt = this.now();
    const socketRoot = ensureAgentBrowserSocketRoot();
    const scratch = mkdtempSync(join(socketRoot, "verify-"));
    const sessionId = `verify-${randomUUID()}`;
    const env = {
      ...environment.processEnv,
      ...buildAgentBrowserProcessEnv(this.runtime, { sessionId, socketDir: scratch }),
    };
    const sessionName = agentBrowserSessionName(sessionId);
    try {
      const result = await this.runCli(
        this.runtime.cliEntrypoint,
        ["--json", "--session", sessionName, "--provider", "chrome-extension", "get", "url"],
        env,
        30_000,
      );
      if (!result.stdout.trim())
        throw new Error("agent-browser returned an empty verification result");
      try {
        const payload = JSON.parse(result.stdout) as { success?: unknown };
        if (payload.success === false)
          throw new Error("agent-browser reported a failed verification result");
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error("agent-browser returned invalid JSON during verification");
        }
        throw error;
      }
      return {
        ok: true,
        durationMs: Math.max(0, this.now() - startedAt),
        probe: "active_tab_url",
        status: await this.status(),
      };
    } finally {
      await this.runCli(
        this.runtime.cliEntrypoint,
        ["--json", "--session", sessionName, "--provider", "chrome-extension", "close"],
        env,
        10_000,
      ).catch(() => undefined);
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  setControlEventHandler(
    handler: ((event: AgentBrowserControlEvent) => void | Promise<void>) | null,
  ): void {
    this.controlEventHandler = handler;
    if (handler && this.runtime.ready && !this.disposed) this.scheduleControlPoll(0);
    if (!handler && this.controlPollTimer) {
      clearTimeout(this.controlPollTimer);
      this.controlPollTimer = null;
    }
  }

  async setSessionControl(
    sessionId: string,
    phase: "agent" | "human" | "stopped",
  ): Promise<AgentBrowserControlUpdate> {
    if (!this.runtime.ready || this.disposed) return { reachable: false, matched: 0 };
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${this.runtime.bridgePort}/control/sessions/${encodeURIComponent(agentBrowserSessionName(sessionId))}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phase }),
          signal: AbortSignal.timeout(1_500),
        },
      );
      if (!response.ok) return { reachable: false, matched: 0 };
      const payload = (await response.json()) as { matched?: unknown };
      return {
        reachable: true,
        matched:
          typeof payload.matched === "number" && Number.isFinite(payload.matched)
            ? Math.max(0, Math.floor(payload.matched))
            : 0,
      };
    } catch {
      return { reachable: false, matched: 0 };
    }
  }

  /**
   * Take a fresh, structured snapshot through the already-owned provider
   * session. This bypasses the agent-facing wrapper so the coordinator can
   * measure the page while its persisted phase is still `resuming`.
   */
  async readSessionSnapshot(
    sessionId: string,
    socketDir: string,
  ): Promise<AgentBrowserSemanticReadback> {
    if (!this.runtime.ready || this.disposed) {
      throw new Error("Agent browser runtime is unavailable for semantic readback");
    }
    const resolvedSocketDir = this.assertManagedSocketDir(socketDir);
    if (!existsSync(resolvedSocketDir)) {
      throw new Error("Agent browser session state is unavailable for semantic readback");
    }
    const env = {
      ...environment.processEnv,
      ...buildAgentBrowserProcessEnv(this.runtime, { sessionId, socketDir: resolvedSocketDir }),
    };
    const result = await this.runCli(
      this.runtime.cliEntrypoint,
      [
        "--json",
        "--session",
        agentBrowserSessionName(sessionId),
        "--provider",
        "chrome-extension",
        "snapshot",
      ],
      env,
      30_000,
    );
    let payload: { success?: unknown; data?: unknown };
    try {
      payload = JSON.parse(result.stdout) as { success?: unknown; data?: unknown };
    } catch {
      throw new Error("Agent browser returned invalid JSON during semantic readback");
    }
    if (payload.success !== true || payload.data === undefined || payload.data === null) {
      throw new Error("Agent browser did not return a semantic snapshot");
    }
    const raw =
      typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data, null, 2);
    if (!raw.trim()) throw new Error("Agent browser returned an empty semantic snapshot");
    const truncated = raw.length > SEMANTIC_READBACK_MAX_CHARS;
    return {
      snapshot: truncated ? `${raw.slice(0, SEMANTIC_READBACK_MAX_CHARS)}\n[truncated]` : raw,
      truncated,
    };
  }

  async closeSession(sessionId: string, socketDir: string): Promise<void> {
    const resolvedSocketDir = this.assertManagedSocketDir(socketDir);
    if (!existsSync(resolvedSocketDir)) return;
    if (!this.runtime.ready) {
      rmSync(resolvedSocketDir, { recursive: true, force: true });
      return;
    }
    const sessionName = agentBrowserSessionName(sessionId);
    const hasRuntimeState = ["sock", "pid", "port", "config"].some((suffix) =>
      existsSync(join(resolvedSocketDir, `${sessionName}.${suffix}`)),
    );
    if (!hasRuntimeState) {
      rmSync(resolvedSocketDir, { recursive: true, force: true });
      return;
    }
    const env = {
      ...environment.processEnv,
      ...buildAgentBrowserProcessEnv(this.runtime, { sessionId, socketDir: resolvedSocketDir }),
    };
    try {
      await this.runCli(
        this.runtime.cliEntrypoint,
        ["--json", "--session", sessionName, "--provider", "chrome-extension", "close"],
        env,
        10_000,
      ).catch(() => undefined);
    } finally {
      rmSync(resolvedSocketDir, { recursive: true, force: true });
    }
  }

  private assertManagedSocketDir(socketDir: string): string {
    const socketRoot = ensureAgentBrowserSocketRoot();
    const resolvedSocketDir = resolve(socketDir);
    let canonicalSocketDir: string;
    if (existsSync(resolvedSocketDir)) {
      const info = lstatSync(resolvedSocketDir);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Agent browser socket path must be a real directory: ${socketDir}`);
      }
      canonicalSocketDir = realpathSync(resolvedSocketDir);
    } else {
      // `/tmp` is a symlink to `/private/tmp` on macOS. Canonicalize the
      // existing managed parent before comparing paths, while retaining the
      // missing child name needed by idempotent cleanup.
      canonicalSocketDir = join(realpathSync(dirname(resolvedSocketDir)), basename(socketDir));
    }
    const relativeSocketDir = relative(socketRoot, canonicalSocketDir);
    if (!relativeSocketDir || relativeSocketDir.startsWith("..") || isAbsolute(relativeSocketDir)) {
      throw new Error(`Agent browser socket directory is outside the managed root: ${socketDir}`);
    }
    return canonicalSocketDir;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controlEventHandler = null;
    if (this.controlPollTimer) {
      clearTimeout(this.controlPollTimer);
      this.controlPollTimer = null;
    }
    await this.startPromise?.catch(() => undefined);
    const child = this.daemonProcess;
    this.daemonProcess = null;
    const pid = this.ownedDaemonPid;
    this.ownedDaemonPid = null;
    if (child) {
      await this.terminateChild(child);
      this.removeOwnerRecord(child.pid);
      return;
    }
    if (pid !== null) {
      const record = this.readOwnerRecord();
      if (
        !record ||
        record.pid !== pid ||
        !this.pidMatchesDaemon(pid, this.runtime.daemonScript, record.startedAt)
      ) {
        this.removeOwnerRecord(pid);
        return;
      }
      if (await this.terminatePid(pid)) this.removeOwnerRecord(pid);
    }
  }

  private scheduleControlPoll(delayMs: number): void {
    if (this.disposed || !this.controlEventHandler || this.controlPollTimer) return;
    this.controlPollTimer = setTimeout(() => {
      this.controlPollTimer = null;
      void this.pollControlEvents();
    }, delayMs);
    this.controlPollTimer.unref?.();
  }

  private async pollControlEvents(): Promise<void> {
    if (this.disposed || !this.runtime.ready || !this.controlEventHandler) return;
    let nextDelay = 2_000;
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${this.runtime.bridgePort}/control/events?after=${this.lastControlEventSequence}`,
        { signal: AbortSignal.timeout(1_500) },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as BridgeControlEventsResponse;
      const sequence =
        typeof payload.sequence === "number" && Number.isInteger(payload.sequence)
          ? payload.sequence
          : this.lastControlEventSequence;
      if (sequence < this.lastControlEventSequence) {
        this.lastControlEventSequence = 0;
        nextDelay = 0;
        return;
      }
      const events = Array.isArray(payload.events)
        ? payload.events
            .map(parseControlEvent)
            .filter((event): event is AgentBrowserControlEvent => Boolean(event))
        : [];
      for (const event of events) {
        if (event.sequence <= this.lastControlEventSequence) continue;
        await this.controlEventHandler(event);
        this.lastControlEventSequence = event.sequence;
      }
      if (events.length === 0)
        this.lastControlEventSequence = Math.max(this.lastControlEventSequence, sequence);
      nextDelay = 250;
    } catch {
      // An offline bridge is expected before the user starts browser control.
    } finally {
      this.scheduleControlPoll(nextDelay);
    }
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, this.sleep(2_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, this.sleep(1_000)]);
    }
  }

  private async startDaemon(): Promise<AgentBrowserBridgeStatus> {
    const logPath = this.bridgeLogPath();
    mkdirSync(this.runtimeStateDir(), { recursive: true });
    const child = this.spawnImpl(process.execPath, [this.runtime.daemonScript], {
      env: {
        ...environment.processEnv,
        [ENV.AGENT_BROWSER_CHROME_BRIDGE_PORT]: String(this.runtime.bridgePort),
        [ENV.AGENT_BROWSER_CHROME_BRIDGE_LOG]: logPath,
      },
      stdio: "ignore",
    });
    if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      await this.terminateChild(child);
      this.lastError = "Chrome bridge daemon did not expose a process id";
      return this.buildStatus(null, "error");
    }
    this.daemonProcess = child;
    this.ownedDaemonPid = child.pid;
    try {
      this.writeOwnerRecord(child.pid);
    } catch (error) {
      this.lastError = `Chrome bridge daemon ownership could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
      await this.terminateChild(child);
      this.daemonProcess = null;
      this.ownedDaemonPid = null;
      return this.buildStatus(null, "error");
    }
    child.once("exit", (code) => {
      if (this.daemonProcess === child) this.daemonProcess = null;
      if (this.ownedDaemonPid === child.pid) this.ownedDaemonPid = null;
      this.removeOwnerRecord(child.pid);
      if (code && code !== 0) this.lastError = `Chrome bridge daemon exited with code ${code}`;
    });
    child.once("error", (error) => {
      if (this.daemonProcess === child) this.daemonProcess = null;
      this.lastError = error.message;
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (this.disposed) break;
      const health = await this.readHealth();
      if (health) return this.status();
      if (child.exitCode !== null) break;
      await this.sleep(125);
    }
    if (!this.disposed) this.lastError ||= "Chrome bridge daemon did not become ready";
    await this.terminateChild(child);
    if (this.daemonProcess === child) this.daemonProcess = null;
    if (this.ownedDaemonPid === child.pid) this.ownedDaemonPid = null;
    this.removeOwnerRecord(child.pid);
    return this.buildStatus(null, this.disposed ? "stopped" : "error");
  }

  private runtimeStateDir(): string {
    return join(this.runtime.rootDir, "..", ".runtime");
  }

  private bridgeLogPath(): string {
    return join(this.runtimeStateDir(), "agent-browser-chrome-bridge.log");
  }

  private rotateBridgeLogIfNeeded(): void {
    const logPath = this.bridgeLogPath();
    try {
      if (statSync(logPath).size <= this.maxLogBytes) return;
      rmSync(`${logPath}.${this.maxLogBackups}`, { force: true });
      for (let index = this.maxLogBackups - 1; index >= 1; index -= 1) {
        const source = `${logPath}.${index}`;
        if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
      }
      renameSync(logPath, `${logPath}.1`);
    } catch {
      // Missing logs and concurrent provider writes do not affect bridge health.
    }
  }

  private ownerRecordPath(): string {
    return join(this.runtimeStateDir(), "agent-browser-chrome-bridge-owner.json");
  }

  private readOwnerRecord(): DaemonOwnerRecord | null {
    try {
      const value = JSON.parse(
        readFileSync(this.ownerRecordPath(), "utf8"),
      ) as Partial<DaemonOwnerRecord>;
      if (
        value.schemaVersion !== 1 ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        typeof value.startedAt !== "number" ||
        value.daemonScript !== this.runtime.daemonScript ||
        value.port !== this.runtime.bridgePort ||
        value.version !== this.runtime.version ||
        value.protocolVersion !== this.runtime.bridgeProtocolVersion
      ) {
        return null;
      }
      return value as DaemonOwnerRecord;
    } catch {
      return null;
    }
  }

  private writeOwnerRecord(pid: number): void {
    mkdirSync(this.runtimeStateDir(), { recursive: true });
    const target = this.ownerRecordPath();
    const staged = `${target}.${randomUUID()}.tmp`;
    const record: DaemonOwnerRecord = {
      schemaVersion: 1,
      pid,
      startedAt: this.now(),
      daemonScript: this.runtime.daemonScript,
      port: this.runtime.bridgePort,
      version: this.runtime.version,
      protocolVersion: this.runtime.bridgeProtocolVersion,
    };
    try {
      writeFileSync(staged, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(staged, target);
    } finally {
      rmSync(staged, { force: true });
    }
  }

  private removeOwnerRecord(expectedPid?: number): void {
    if (expectedPid !== undefined) {
      try {
        const value = JSON.parse(readFileSync(this.ownerRecordPath(), "utf8")) as { pid?: unknown };
        if (value.pid !== expectedPid) return;
      } catch {
        return;
      }
    }
    rmSync(this.ownerRecordPath(), { force: true });
  }

  private adoptOwnedDaemon(): void {
    const record = this.readOwnerRecord();
    if (!record || !this.pidIsAlive(record.pid)) return;
    if (!this.pidMatchesDaemon(record.pid, this.runtime.daemonScript, record.startedAt)) {
      this.removeOwnerRecord(record.pid);
      return;
    }
    this.ownedDaemonPid = record.pid;
  }

  private async replaceUnhealthyOwnedDaemon(): Promise<boolean> {
    const record = this.readOwnerRecord();
    if (!record) return true;
    if (
      !this.pidIsAlive(record.pid) ||
      !this.pidMatchesDaemon(record.pid, this.runtime.daemonScript, record.startedAt)
    ) {
      this.removeOwnerRecord(record.pid);
      return true;
    }
    const terminated = await this.terminatePid(record.pid);
    if (terminated) {
      this.removeOwnerRecord(record.pid);
      return true;
    }
    this.lastError = `Chrome bridge daemon ${record.pid} could not be stopped safely`;
    return false;
  }

  private async terminatePid(pid: number): Promise<boolean> {
    if (!this.pidIsAlive(pid)) return true;
    try {
      this.signalProcess(pid, "SIGTERM");
    } catch {
      return !this.pidIsAlive(pid);
    }
    if (!this.pidIsAlive(pid)) return true;
    await this.sleep(2_000);
    if (!this.pidIsAlive(pid)) return true;
    try {
      this.signalProcess(pid, "SIGKILL");
      return true;
    } catch {
      // The process may exit between the final liveness check and signal.
      return !this.pidIsAlive(pid);
    }
  }

  private readHealth(): Promise<BridgeHealth | null> {
    if (this.healthPromise) return this.healthPromise;
    this.healthPromise = this.fetchHealth().finally(() => {
      this.healthPromise = null;
    });
    return this.healthPromise;
  }

  private async fetchHealth(): Promise<BridgeHealth | null> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.runtime.bridgePort}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as BridgeHealth;
      if (payload.daemon !== "ok") return null;
      if (this.runtime.version && payload.version !== this.runtime.version) {
        this.lastError = `Chrome bridge version mismatch: expected ${this.runtime.version}`;
        return null;
      }
      if (payload.bridgeProtocolVersion !== this.runtime.bridgeProtocolVersion) {
        this.lastError = `Chrome bridge protocol mismatch: expected ${this.runtime.bridgeProtocolVersion}`;
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private buildStatus(
    health: BridgeHealth | null,
    phase: AgentBrowserBridgePhase,
  ): AgentBrowserBridgeStatus {
    const profiles = profileSummaries(health?.profiles);
    return {
      schemaVersion: 1,
      phase,
      runtime: {
        ready: this.runtime.ready,
        version: this.runtime.version,
        sourceCommit: this.runtime.sourceCommit,
        missing: [...this.runtime.missing],
      },
      daemon: {
        state: health ? "online" : "offline",
        port: this.runtime.bridgePort,
        version: typeof health?.version === "string" ? health.version : null,
        protocolVersion:
          typeof health?.bridgeProtocolVersion === "number" ? health.bridgeProtocolVersion : null,
        sessionCount: Array.isArray(health?.sessions) ? health.sessions.length : 0,
      },
      extension: {
        connected: profiles.length > 0,
        path: this.runtime.extensionDir,
        profiles,
      },
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}
