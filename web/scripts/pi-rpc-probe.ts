import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const PROCESS_TIMEOUT_MS = 30_000;

interface RpcRecord {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

interface PendingRequest {
  command: string;
  resolve(value: RpcRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PiProbeLayout {
  root: string;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
  piConfigDir: string;
  piSessionsDir: string;
  recordingsDir: string;
  userSpaceCheckoutsDir: string;
  extensionPath: string;
  skillPath: string;
}

export interface PiProbeLaunch {
  executable: string;
  prefixArgs: string[];
  env?: NodeJS.ProcessEnv;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function createPiProbeLayout(root: string): PiProbeLayout {
  const canonicalRoot = realpathSync(resolve(root));
  const layout: PiProbeLayout = {
    root: canonicalRoot,
    workspaceDir: join(canonicalRoot, "workspace"),
    homeDir: join(canonicalRoot, "home"),
    tmpDir: join(canonicalRoot, "tmp"),
    piConfigDir: join(canonicalRoot, "pi-config"),
    piSessionsDir: join(canonicalRoot, "pi-sessions"),
    recordingsDir: join(canonicalRoot, "recordings"),
    userSpaceCheckoutsDir: join(canonicalRoot, "user-space-checkouts"),
    extensionPath: join(canonicalRoot, "pi-config", "piwork-smoke-extension.ts"),
    skillPath: join(canonicalRoot, "pi-config", "managed-skills", "piwork-managed-canary"),
  };
  for (const path of [
    layout.workspaceDir,
    layout.homeDir,
    layout.tmpDir,
    layout.piConfigDir,
    layout.piSessionsDir,
    layout.recordingsDir,
    layout.userSpaceCheckoutsDir,
    layout.skillPath,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    layout.extensionPath,
    `export default function piworkSmokeExtension(pi) {
  pi.registerCommand("piwork-smoke", {
    description: "Piwork trusted-extension smoke canary",
    handler: async (_args, ctx) => ctx.ui.notify("piwork-smoke", "info"),
  });
}
`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(layout.skillPath, "SKILL.md"),
    `---
name: piwork-managed-canary
description: Verify explicit managed Skill loading.
---

Return the literal text \`piwork-managed-canary\`.
`,
    { mode: 0o600 },
  );
  return layout;
}

class StrictJsonlClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly records: RpcRecord[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stderr = "";
  private requestSequence = 0;
  private failure: Error | null = null;
  private readonly processTimer: ReturnType<typeof setTimeout>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.once("error", (error) => this.fail(error));
    this.exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.finishDecoder();
        const error =
          this.failure ??
          (code === 0
            ? new Error("Pi RPC process exited.")
            : new Error(
                `Pi RPC process exited with ${code ?? signal ?? "unknown status"}: ${this.stderr}`,
              ));
        this.rejectPending(error);
        resolveExit({ code, signal });
      });
    });
    this.processTimer = setTimeout(() => {
      this.fail(new Error(`Pi RPC process exceeded ${PROCESS_TIMEOUT_MS}ms.`));
      child.kill("SIGTERM");
    }, PROCESS_TIMEOUT_MS);
    this.processTimer.unref?.();
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.byteLength;
    if (this.stderrBytes > MAX_STDERR_BYTES) {
      this.fail(new Error(`Pi RPC stderr exceeded ${MAX_STDERR_BYTES} bytes.`));
      this.child.kill("SIGTERM");
      return;
    }
    this.stderr += chunk.toString("utf8");
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.fail(new Error(`Pi RPC stdout exceeded ${MAX_STDOUT_BYTES} bytes.`));
      this.child.kill("SIGTERM");
      return;
    }
    this.buffer += this.decoder.write(chunk);
    this.drainFrames();
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.fail(new Error(`Pi RPC frame exceeded ${MAX_FRAME_BYTES} bytes.`));
      this.child.kill("SIGTERM");
    }
  }

  private drainFrames(): void {
    while (true) {
      const lf = this.buffer.indexOf("\n");
      if (lf < 0) return;
      const line = this.buffer.slice(0, lf);
      this.buffer = this.buffer.slice(lf + 1);
      if (line.endsWith("\r")) {
        this.fail(new Error("Pi RPC stdout used CRLF framing instead of strict LF."));
        continue;
      }
      if (!line) {
        this.fail(new Error("Pi RPC stdout emitted an empty JSONL frame."));
        continue;
      }
      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch {
        this.fail(new Error(`Pi RPC stdout emitted invalid JSON: ${line.slice(0, 160)}`));
        continue;
      }
      this.records.push(record);
      if (record.type !== "response" || typeof record.id !== "string") continue;
      const request = this.pending.get(record.id);
      if (!request) continue;
      this.pending.delete(record.id);
      clearTimeout(request.timer);
      if (record.command !== request.command) {
        request.reject(
          new Error(
            `Pi RPC response command mismatch for ${record.id}: ${record.command} != ${request.command}`,
          ),
        );
      } else if (record.success !== true) {
        request.reject(new Error(`Pi RPC ${request.command} failed: ${record.error || "unknown"}`));
      } else {
        request.resolve(record);
      }
    }
  }

  private finishDecoder(): void {
    this.buffer += this.decoder.end();
    this.drainFrames();
    if (this.buffer.length > 0 && !this.failure) {
      this.failure = new Error("Pi RPC stdout ended with a non-LF-terminated frame.");
    }
    clearTimeout(this.processTimer);
  }

  private prepare(command: Record<string, unknown>): {
    id: string;
    line: string;
    response: Promise<RpcRecord>;
  } {
    if (this.failure) throw this.failure;
    const id = `piwork-probe-${++this.requestSequence}`;
    const type = String(command.type || "");
    assert(type, "RPC command type is required.");
    const line = `${JSON.stringify({ id, ...command })}\n`;
    assert(Buffer.byteLength(line) <= MAX_FRAME_BYTES, "Probe request exceeds the frame limit.");
    const response = new Promise<RpcRecord>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Pi RPC ${type} timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        command: type,
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
      });
    });
    return { id, line, response };
  }

  private async write(value: string): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child.stdin.write(value, "utf8")) await once(this.child.stdin, "drain");
  }

  async request(command: Record<string, unknown>): Promise<RpcRecord> {
    const prepared = this.prepare(command);
    await this.write(prepared.line);
    return prepared.response;
  }

  async fragmentedRequest(command: Record<string, unknown>): Promise<RpcRecord> {
    const prepared = this.prepare(command);
    const split = Math.max(1, Math.floor(prepared.line.length / 2));
    await this.write(prepared.line.slice(0, split));
    await this.write(prepared.line.slice(split));
    return prepared.response;
  }

  async combinedRequests(
    first: Record<string, unknown>,
    second: Record<string, unknown>,
  ): Promise<[RpcRecord, RpcRecord]> {
    const left = this.prepare(first);
    const right = this.prepare(second);
    await this.write(left.line + right.line);
    return Promise.all([left.response, right.response]);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const exited = await this.exited;
    if (this.failure && this.failure.message !== "Pi RPC process exited.") throw this.failure;
    assert(
      exited.code === 0,
      `Pi RPC process did not exit cleanly: ${exited.code ?? exited.signal}`,
    );
  }
}

function piArgs(layout: PiProbeLayout, sessionFile?: string): string[] {
  const sessionSelection = sessionFile
    ? ["--session", sessionFile]
    : ["--session-id", randomUUID()];
  return [
    "--no-builtin-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--no-context-files",
    "--offline",
    "--extension",
    layout.extensionPath,
    "--skill",
    layout.skillPath,
    "--session-dir",
    layout.piSessionsDir,
    ...sessionSelection,
  ];
}

function spawnPi(
  launch: PiProbeLaunch,
  layout: PiProbeLayout,
  sessionFile?: string,
): StrictJsonlClient {
  const child = spawn(launch.executable, [...launch.prefixArgs, ...piArgs(layout, sessionFile)], {
    cwd: layout.workspaceDir,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      TERM: "dumb",
      HOME: layout.homeDir,
      PI_CODING_AGENT_DIR: layout.piConfigDir,
      PI_CODING_AGENT_SESSION_DIR: layout.piSessionsDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ...launch.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new StrictJsonlClient(child);
}

function responseData(response: RpcRecord): Record<string, unknown> {
  assert(
    response.data && typeof response.data === "object",
    `${response.command} returned no data.`,
  );
  return response.data as Record<string, unknown>;
}

export async function runPiRpcProbe(
  launch: PiProbeLaunch,
  layout: PiProbeLayout,
): Promise<{ sessionFile: string; modelCount: number; commandCount: number }> {
  const sessionId = randomUUID();
  const initializedSessionFile = join(layout.piSessionsDir, `${sessionId}.jsonl`);
  writeFileSync(
    initializedSessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: layout.workspaceDir,
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const first = spawnPi(launch, layout, initializedSessionFile);
  const stateResponse = await first.fragmentedRequest({
    type: "get_state",
    canary: "strict\u2028jsonl",
  });
  const [modelsResponse, commandsResponse] = await first.combinedRequests(
    { type: "get_available_models" },
    { type: "get_commands" },
  );
  await first.request({ type: "set_session_name", name: "piwork-pi-rpc-smoke" });
  await first.request({ type: "abort" });
  const entriesResponse = await first.request({ type: "get_entries" });

  const state = responseData(stateResponse);
  const models = responseData(modelsResponse).models;
  const commands = responseData(commandsResponse).commands;
  const entries = responseData(entriesResponse).entries;
  assert(Array.isArray(models), "get_available_models did not return a models array.");
  assert(Array.isArray(commands), "get_commands did not return a commands array.");
  assert(
    Array.isArray(entries) && entries.length > 0,
    "Pi did not persist its initial session entry.",
  );
  assert(
    commands.some(
      (command) =>
        command &&
        typeof command === "object" &&
        (command as Record<string, unknown>).name === "piwork-smoke" &&
        (command as Record<string, unknown>).source === "extension",
    ),
    "Explicit Piwork extension was not loaded.",
  );
  assert(
    commands.some(
      (command) =>
        command &&
        typeof command === "object" &&
        (command as Record<string, unknown>).name === "skill:piwork-managed-canary" &&
        (command as Record<string, unknown>).source === "skill",
    ),
    "Explicit managed Skill was not loaded.",
  );
  assert(
    !commands.some(
      (command) =>
        command &&
        typeof command === "object" &&
        (command as Record<string, unknown>).name === "login",
    ),
    "The forbidden /login command was exposed.",
  );
  assert(typeof state.sessionFile === "string", "get_state did not return a session file.");
  assert(state.sessionId === sessionId, "Pi did not preserve the exact requested session id.");
  const sessionFile = resolve(String(state.sessionFile));
  assert(sessionFile === initializedSessionFile, "Pi selected a different session JSONL file.");
  assert(
    isInside(realpathSync(layout.piSessionsDir), sessionFile),
    "Session file escaped pi-sessions.",
  );
  assert(sessionFile.endsWith(".jsonl"), "Pi session source of truth is not JSONL.");
  assert(existsSync(sessionFile), "Pi session JSONL was not created.");
  assert(!lstatSync(sessionFile).isSymbolicLink(), "Pi session JSONL must not be a symbolic link.");
  assert(!existsSync(join(layout.workspaceDir, ".pi")), "Workspace-local .pi was created.");
  await first.close();

  const priorBytes = readFileSync(sessionFile);
  const resumed = spawnPi(launch, layout, sessionFile);
  const resumedState = responseData(await resumed.request({ type: "get_state" }));
  const resumedEntries = responseData(await resumed.request({ type: "get_entries" })).entries;
  const resumedCommands = responseData(await resumed.request({ type: "get_commands" })).commands;
  assert(
    resolve(String(resumedState.sessionFile)) === sessionFile,
    "Pi resumed a different session file.",
  );
  assert(
    Array.isArray(resumedEntries) && resumedEntries.length >= entries.length,
    "Pi history replay lost persisted entries.",
  );
  assert(
    Array.isArray(resumedCommands) &&
      resumedCommands.some(
        (command) =>
          command &&
          typeof command === "object" &&
          (command as Record<string, unknown>).name === "piwork-smoke",
      ),
    "Explicit extension was not restored on resume.",
  );
  await resumed.close();
  assert(
    readFileSync(sessionFile).byteLength >= priorBytes.byteLength,
    "Resume unexpectedly truncated Pi JSONL.",
  );

  return { sessionFile, modelCount: models.length, commandCount: commands.length };
}
