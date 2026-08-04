import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiLauncher, type PiSessionInfo } from "./pi-launcher.js";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";

const roots: string[] = [];
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  for (const root of roots) {
    makeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeRemovable(join(path, entry));
}

function temporaryRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function payload(
  generation = 1,
  authorizedRoot = "/workspace",
  mode: "agent" | "plan" = "agent",
): PiBootstrapPayload {
  return {
    version: 1,
    sessionId: SESSION_ID,
    generation,
    authorizedRoots: [{ path: authorizedRoot, access: mode === "plan" ? "read" : "write" }],
    mode,
    providers: [
      {
        name: "test",
        config: {
          api: "openai-completions",
          apiKey: "never-on-command-line",
          models: [{ id: "model", name: "Model" }],
        },
      },
    ],
    managedSkills: [],
    mcp: [],
    productTools: { userSpaceCapability: "user-space-one-use-capability" },
    taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 4 },
  };
}

function childFixture() {
  const emitter = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  emitter.pid = 4242;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = vi.fn(() => {
    emitter.exitCode = 0;
    emitter.emit("exit", 0, null);
    return true;
  });
  return emitter;
}

function sessionInfo(overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
  return {
    sessionId: SESSION_ID,
    state: "running",
    lifecycleState: "enabled",
    thinkingLevel: "medium",
    mode: "agent",
    cwd: "/workspace",
    createdAt: 1,
    backendType: "pi",
    transport: "pi-rpc",
    generation: 4,
    piVersion: "0.82.1",
    ...overrides,
  };
}

describe("PiLauncher security boundary", () => {
  it("spawns Node rpc-entry through SRT without placing provider credentials in argv or env", async () => {
    const root = temporaryRoot("piwork-launcher-test-");
    const sessionRoot = join(root, "session");
    const workingDirectory = join(root, "shared-workspace");
    const managedResourcesDir = join(root, "parent-session", "pi-config", "piwork-resources");
    const managedSkillsDir = join(managedResourcesDir, "skills");
    const managedSkillPath = join(managedSkillsDir, "test-skill");
    const sessionBinDir = join(managedResourcesDir, "bin");
    const trustedExtensionPath = join(root, "extension.ts");
    const piEntry = join(root, "rpc-entry.js");
    const piPackage = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const nodePath = join(root, "node");
    const srtPath = join(root, "srt");
    mkdirSync(piPackage, { recursive: true });
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(managedSkillPath, { recursive: true });
    mkdirSync(sessionBinDir, { recursive: true });
    writeFileSync(join(managedSkillPath, "SKILL.md"), "# Test\n");
    writeFileSync(join(sessionBinDir, "managed-tool"), "#!/bin/sh\n");
    for (const path of [join(managedSkillPath, "SKILL.md"), join(sessionBinDir, "managed-tool")]) {
      chmodSync(path, 0o500);
    }
    for (const path of [managedSkillPath, managedSkillsDir, sessionBinDir, managedResourcesDir]) {
      chmodSync(path, 0o500);
    }
    for (const path of [trustedExtensionPath, piEntry, nodePath, srtPath]) {
      writeFileSync(path, "fixture");
    }

    const child = childFixture();
    const spawnProcess = vi.fn(() => child as never);
    let notification: ((value: Record<string, unknown>) => void) | undefined;
    const transport = {
      sessionId: SESSION_ID,
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
    };
    const createTransport = vi.fn((options: any) => {
      notification = options.onNotification;
      transportLifecycle = options.onLifecycle;
      queueMicrotask(() => {
        notification?.({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "piwork.extension",
          statusText: JSON.stringify({ version: 1, mode: "agent", mcp: [] }),
        });
      });
      return transport as never;
    });
    const bootstrap = {
      start: vi.fn(async () => undefined),
      waitForConsumption: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const createBootstrapServer = vi.fn(() => bootstrap as never);
    const managedSessionFile = join(sessionRoot, "pi-sessions", `${SESSION_ID}.jsonl`);
    let transportLifecycle: ((event: { type: "closed"; code: string }) => void) | undefined;

    // Readiness speaks the real request-id protocol through the transport. This
    // launcher unit focuses only on spawn authority, so make those requests
    // resolve from a structural transport double.
    Object.assign(transport, {
      getState: vi.fn(async () => ({
        sessionId: SESSION_ID,
        sessionFile: managedSessionFile,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "all",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      })),
      getAvailableModels: vi.fn(async () => [{ provider: "test", id: "model" }]),
      replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
      getCommands: vi.fn(async () => [{ name: "piwork-plan" }]),
    });

    const launcher = new PiLauncher({
      resolvePiRuntime: () => ({
        entryPath: piEntry,
        packageRoot: piPackage,
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.82.1",
        nodePath,
      }),
      resolveSrtRuntime: () => ({
        entryPath: srtPath,
        packageRoot: root,
        packageName: "@anthropic-ai/sandbox-runtime",
        version: "0.0.65",
      }),
      spawnProcess: spawnProcess as never,
      createTransport,
      createBootstrapServer,
    });
    const onLifecycle = vi.fn();
    const onExit = vi.fn();

    const launching = launcher.launch({
      sessionId: SESSION_ID,
      sessionRoot,
      workingDirectory,
      trustedExtensionPath,
      managedSkillPaths: [managedSkillPath],
      bootstrapPayload: payload(1, workingDirectory),
      sandbox: {
        settings: {
          filesystem: {
            denyRead: [],
            allowRead: [workingDirectory, managedResourcesDir],
            allowWrite: [workingDirectory],
            denyWrite: [],
            allowGitConfig: false,
          },
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
        },
        managedResourcesDir,
        sessionBinDir,
      },
      observer: { onLifecycle },
      onExit,
    });

    const info = await launching;
    expect(onLifecycle.mock.calls.map(([event]) => event.type)).toEqual([
      "generation_change",
      "process_spawn",
      "process_ready",
    ]);

    const [command, args, options] = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(command).toBe(nodePath);
    expect(args[0]).toBe(srtPath);
    expect(args).toContain("--use-openssl-ca");
    expect(args).toEqual(
      expect.arrayContaining(["--import", expect.stringContaining("pi-srt-proxy-preload.mjs")]),
    );
    expect(args).toContain(piEntry);
    expect(args).toEqual(expect.arrayContaining(["--session", managedSessionFile]));
    expect(JSON.stringify(args)).not.toContain("never-on-command-line");
    expect(JSON.stringify(options.env)).not.toContain("never-on-command-line");
    expect(JSON.stringify(options.env)).not.toContain("user-space-one-use-capability");
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.env).not.toHaveProperty("NODE_OPTIONS");
    expect(options.cwd).toBe(workingDirectory);
    expect(options.env.PATH).toMatch(new RegExp(`^${sessionBinDir}:`));
    expect(options.env.HOME).toBe(join(sessionRoot, "home"));
    expect(options.env.TMPDIR).toBe("/tmp");
    expect(options.env.TMPDIR).toBe("/tmp");
    expect(options.env.PI_CODING_AGENT_DIR).toBe(join(sessionRoot, "pi-config", "runtime"));
    expect(options.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(sessionRoot, "pi-sessions"));
    expect(options.env.SSL_CERT_FILE).toMatch(/cert/);
    expect(info.cwd).toBe(workingDirectory);
    transportLifecycle?.({ type: "closed", code: "protocol_error" });
    await vi.waitFor(() => {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(launcher.isAlive(SESSION_ID)).toBe(false);
      expect(onExit).toHaveBeenCalledOnce();
    });
    expect(onLifecycle.mock.calls.map(([event]) => event.type)).toEqual([
      "generation_change",
      "process_spawn",
      "process_ready",
      "transport_error",
      "process_exit",
    ]);
  });

  it("rejects a bootstrap capability for another generation before spawning", async () => {
    const root = temporaryRoot("piwork-launcher-test-");
    const spawnProcess = vi.fn();
    const launcher = new PiLauncher({
      spawnProcess: spawnProcess as never,
      resolvePiRuntime: vi.fn() as never,
      resolveSrtRuntime: vi.fn() as never,
    });
    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot: join(root, "session"),
        trustedExtensionPath: join(root, "extension.ts"),
        managedSkillPaths: [],
        bootstrapPayload: payload(99),
        sandbox: { settings: {} as never },
      }),
    ).rejects.toThrow(/generation/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fully validates the exact resume JSONL before spawning", async () => {
    const root = temporaryRoot("piwork-launcher-resume-test-");
    const sessionRoot = join(root, "session");
    const workspace = join(sessionRoot, "workspace");
    const piSessions = join(sessionRoot, "pi-sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(piSessions, { recursive: true });
    const resumeSessionFile = join(piSessions, "conversation.jsonl");
    writeFileSync(
      resumeSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: SESSION_ID,
        timestamp: new Date().toISOString(),
        cwd: workspace,
      })}\nnot-json\n`,
    );
    const spawnProcess = vi.fn();
    const launcher = new PiLauncher({
      spawnProcess: spawnProcess as never,
      resolvePiRuntime: vi.fn() as never,
      resolveSrtRuntime: vi.fn() as never,
    });

    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot,
        trustedExtensionPath: join(root, "extension.ts"),
        managedSkillPaths: [],
        bootstrapPayload: payload(),
        sandbox: { settings: {} as never },
        resumeSessionFile,
      }),
    ).rejects.toMatchObject({ code: "invalid_json" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("attempts graceful RPC abort before invalidating a runtime generation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "piwork-pi-"));
    roots.push(tempDir);
    const child = childFixture();
    const launcher = new PiLauncher();
    const internals = launcher as unknown as {
      generations: Map<string, number>;
      runtimes: Map<
        string,
        {
          generation: number;
          child: ReturnType<typeof childFixture>;
          transport: { abort: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
          bootstrap: { dispose: ReturnType<typeof vi.fn> };
          tempDir: string;
        }
      >;
      sessions: Map<string, { state: string; exitCode?: number; pid?: number }>;
    };
    internals.generations.set(SESSION_ID, 1);
    const abort = vi.fn(async () => {
      expect(internals.generations.get(SESSION_ID)).toBe(1);
    });
    internals.runtimes.set(SESSION_ID, {
      generation: 1,
      child,
      transport: { abort, dispose: vi.fn() },
      bootstrap: { dispose: vi.fn(async () => undefined) },
      tempDir,
    });
    internals.sessions.set(SESSION_ID, { state: "running", pid: child.pid });

    await expect(launcher.kill(SESSION_ID)).resolves.toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(internals.generations.get(SESSION_ID)).toBe(2);
  });

  it("retains authority-disabled process handles after transport-failure termination fails", async () => {
    vi.useFakeTimers();
    try {
      const tempDir = mkdtempSync(join(tmpdir(), "piwork-pi-"));
      roots.push(tempDir);
      const child = childFixture();
      child.pid = 99_999_999;
      child.kill = vi.fn(() => true);
      const transport = {
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
      };
      const bootstrap = { dispose: vi.fn(async () => undefined) };
      const launcher = new PiLauncher();
      const internals = launcher as unknown as {
        generations: Map<string, number>;
        runtimes: Map<string, any>;
        sessions: Map<string, PiSessionInfo>;
      };
      internals.generations.set(SESSION_ID, 1);
      internals.runtimes.set(SESSION_ID, {
        generation: 1,
        child,
        transport,
        bootstrap,
        tempDir,
      });
      internals.sessions.set(SESSION_ID, sessionInfo({ generation: 1, pid: child.pid }));

      const transportFailure = (
        launcher as unknown as {
          terminateAfterTransportFailure(sessionId: string): Promise<void>;
        }
      ).terminateAfterTransportFailure(SESSION_ID);
      const transportFailureOutcome = transportFailure.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(7_000);
      await expect(transportFailureOutcome).resolves.toMatchObject({
        message: expect.stringMatching(/remained active/u),
      });
      expect(launcher.isAlive(SESSION_ID)).toBe(true);
      expect(launcher.getTransport(SESSION_ID)).toBeUndefined();
      expect(launcher.validateLaunchGeneration(SESSION_ID, 1)).toBe(false);
      expect(internals.runtimes.has(SESSION_ID)).toBe(true);
      expect(bootstrap.dispose).not.toHaveBeenCalled();
      expect(existsSync(tempDir)).toBe(true);

      child.kill.mockImplementationOnce(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        return true;
      });
      await expect(launcher.kill(SESSION_ID)).resolves.toBe(true);
      expect(launcher.isAlive(SESSION_ID)).toBe(false);
      expect(internals.runtimes.has(SESSION_ID)).toBe(false);
      expect(bootstrap.dispose).toHaveBeenCalledOnce();
      expect(existsSync(tempDir)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a pre-readiness child when launch cleanup cannot confirm exit", async () => {
    const root = temporaryRoot("piwork-launcher-readiness-failure-");
    const sessionRoot = join(root, "session");
    const workingDirectory = join(root, "workspace");
    const trustedExtensionPath = join(root, "extension.ts");
    const piPackage = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const piEntry = join(piPackage, "rpc-entry.js");
    const nodePath = join(root, "node");
    const srtPackage = join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
    const srtPath = join(srtPackage, "srt.js");
    mkdirSync(workingDirectory, { recursive: true });
    mkdirSync(piPackage, { recursive: true });
    mkdirSync(srtPackage, { recursive: true });
    for (const path of [trustedExtensionPath, piEntry, nodePath, srtPath]) {
      writeFileSync(path, "fixture");
    }

    const child = childFixture();
    child.pid = 99_999_998;
    child.kill = vi.fn(() => true);
    const transport = {
      sessionId: SESSION_ID,
      isClosed: false,
      dispose: vi.fn(),
      getState: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
      getAvailableModels: vi.fn(async () => [{ provider: "test", id: "model" }]),
      replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
      getCommands: vi.fn(async () => [{ name: "piwork-plan" }]),
      waitForClose: vi.fn(async () => new Error("closed")),
    };
    const bootstrap = {
      start: vi.fn(async () => undefined),
      waitForConsumption: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const launcher = new PiLauncher({
      resolvePiRuntime: () => ({
        entryPath: piEntry,
        packageRoot: piPackage,
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.82.1",
        nodePath,
      }),
      resolveSrtRuntime: () => ({
        entryPath: srtPath,
        packageRoot: srtPackage,
        packageName: "@anthropic-ai/sandbox-runtime",
        version: "0.0.65",
      }),
      spawnProcess: vi.fn(() => child as never) as never,
      createTransport: vi.fn(() => transport as never),
      createBootstrapServer: vi.fn(() => bootstrap as never),
    });
    const onExit = vi.fn();

    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot,
        workingDirectory,
        trustedExtensionPath,
        managedSkillPaths: [],
        bootstrapPayload: payload(1, workingDirectory),
        sandbox: {
          settings: {
            filesystem: {
              denyRead: [],
              allowRead: [workingDirectory],
              allowWrite: [workingDirectory],
              denyWrite: [],
              allowGitConfig: false,
            },
            network: {
              allowedDomains: [],
              deniedDomains: [],
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
            enableWeakerNestedSandbox: false,
            enableWeakerNetworkIsolation: false,
          },
        },
        readyTimeoutMs: 100,
        onExit,
      }),
    ).rejects.toThrow("readiness failed");

    const internals = launcher as unknown as {
      runtimes: Map<string, { tempDir: string }>;
    };
    const retainedTempDir = internals.runtimes.get(SESSION_ID)?.tempDir;
    expect(retainedTempDir).toBeDefined();
    expect(launcher.isAlive(SESSION_ID)).toBe(true);
    expect(launcher.getTransport(SESSION_ID)).toBeUndefined();
    expect(bootstrap.dispose).not.toHaveBeenCalled();
    expect(existsSync(retainedTempDir!)).toBe(true);

    child.kill.mockImplementationOnce(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    });
    await expect(launcher.killAll({ shutdown: false })).resolves.toBeUndefined();
    expect(launcher.isAlive(SESSION_ID)).toBe(false);
    expect(bootstrap.dispose).toHaveBeenCalledOnce();
    expect(existsSync(retainedTempDir!)).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("disposes bootstrap authority and temp state when pre-spawn materialization fails", async () => {
    const root = temporaryRoot("piwork-launcher-preflight-failure-");
    const sessionRoot = join(root, "session");
    const workingDirectory = join(root, "workspace");
    mkdirSync(workingDirectory, { recursive: true });
    const bootstrap = {
      start: vi.fn(async () => undefined),
      waitForConsumption: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    let runtimeTempDir: string | undefined;
    const spawnProcess = vi.fn();
    const launcher = new PiLauncher({
      resolvePiRuntime: () => ({
        entryPath: join(root, "rpc-entry.js"),
        packageRoot: join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.82.1",
        nodePath: join(root, "node"),
      }),
      resolveSrtRuntime: () => ({
        entryPath: join(root, "srt.js"),
        packageRoot: root,
        packageName: "@anthropic-ai/sandbox-runtime",
        version: "0.0.65",
      }),
      spawnProcess: spawnProcess as never,
      createBootstrapServer: vi.fn((options: { socketPath: string }) => {
        runtimeTempDir = dirname(options.socketPath);
        return bootstrap as never;
      }) as never,
    });

    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot,
        workingDirectory,
        trustedExtensionPath: join(root, "missing-extension.ts"),
        managedSkillPaths: [],
        bootstrapPayload: payload(1, workingDirectory),
        sandbox: {
          settings: {
            filesystem: {
              allowRead: [workingDirectory],
              allowWrite: [workingDirectory],
              denyRead: [],
              denyWrite: [],
              allowGitConfig: false,
            },
            network: {
              allowedDomains: [],
              deniedDomains: [],
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
            enableWeakerNestedSandbox: false,
            enableWeakerNetworkIsolation: false,
          },
        },
      }),
    ).rejects.toThrow();

    expect(bootstrap.start).toHaveBeenCalledOnce();
    expect(bootstrap.dispose).toHaveBeenCalledOnce();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(runtimeTempDir).toBeDefined();
    expect(existsSync(runtimeTempDir!)).toBe(false);
  });

  it("rejects a PATH directory outside the exact sealed managed resource root", async () => {
    const root = temporaryRoot("piwork-launcher-bin-test-");
    const sessionRoot = join(root, "session");
    const workspace = join(sessionRoot, "workspace");
    const managedResourcesDir = join(root, "parent-session", "pi-config", "piwork-resources");
    const managedSkillsDir = join(managedResourcesDir, "skills");
    const managedBinDir = join(managedResourcesDir, "bin");
    const arbitraryBinDir = join(root, "arbitrary-bin");
    for (const path of [managedSkillsDir, managedBinDir, arbitraryBinDir]) {
      mkdirSync(path, { recursive: true });
    }
    for (const path of [managedSkillsDir, managedBinDir, managedResourcesDir, arbitraryBinDir]) {
      chmodSync(path, 0o500);
    }
    const spawnProcess = vi.fn();
    const launcher = new PiLauncher({
      spawnProcess: spawnProcess as never,
      resolvePiRuntime: vi.fn() as never,
      resolveSrtRuntime: vi.fn() as never,
    });

    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot,
        trustedExtensionPath: join(root, "extension.ts"),
        managedSkillPaths: [],
        bootstrapPayload: payload(1, workspace),
        sandbox: {
          settings: {
            filesystem: {
              denyRead: [],
              allowRead: [workspace, managedResourcesDir, arbitraryBinDir],
              allowWrite: [workspace],
              denyWrite: [],
              allowGitConfig: false,
            },
            network: {
              allowedDomains: [],
              deniedDomains: [],
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
            enableWeakerNestedSandbox: false,
            enableWeakerNetworkIsolation: false,
          },
          managedResourcesDir,
          sessionBinDir: arbitraryBinDir,
        },
      }),
    ).rejects.toThrow(/sealed resource bin/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("restores only Pi metadata and returns defensive session snapshots", () => {
    const launcher = new PiLauncher();
    const restored = sessionInfo({
      pid: 99,
      archived: true,
      archivedAt: 10,
      exitCode: undefined,
    });
    launcher.restoreSession(restored);

    expect(launcher.nextLaunchGeneration(SESSION_ID)).toBe(5);
    expect(launcher.getSession(SESSION_ID)).toMatchObject({
      sessionId: SESSION_ID,
      state: "exited",
      lifecycleState: "closed",
      generation: 4,
      pid: undefined,
      exitCode: 0,
    });
    const snapshot = launcher.getSession(SESSION_ID)!;
    snapshot.state = "running";
    expect(launcher.getSession(SESSION_ID)?.state).toBe("exited");
    const listed = launcher.listSessions();
    listed[0]!.state = "running";
    expect(launcher.getSession(SESSION_ID)?.state).toBe("exited");

    launcher.setArchived(SESSION_ID, false);
    expect(launcher.getSession(SESSION_ID)).toMatchObject({
      archived: false,
      lifecycleState: "closed",
    });
    expect(launcher.getSession(SESSION_ID)).not.toHaveProperty("archivedAt");
    launcher.setArchived(SESSION_ID, true);
    expect(launcher.getSession(SESSION_ID)?.archivedAt).toEqual(expect.any(Number));
    launcher.setArchived("missing", true);

    launcher.restoreSession(sessionInfo({ generation: 99 }));
    expect(launcher.getSession(SESSION_ID)?.generation).toBe(4);
    expect(() =>
      new PiLauncher().restoreSession({
        ...sessionInfo(),
        backendType: "legacy" as never,
      }),
    ).toThrow(/Only Pi RPC/);
  });

  it("exposes generation-bound runtime handles and rejects active removal", () => {
    const launcher = new PiLauncher();
    const transport = { isClosed: false };
    const readiness = { state: { sessionId: SESSION_ID } };
    const internals = launcher as unknown as {
      runtimes: Map<
        string,
        {
          generation: number;
          transport: unknown;
          readiness: unknown;
        }
      >;
      sessions: Map<string, PiSessionInfo>;
    };
    internals.runtimes.set(SESSION_ID, {
      generation: 7,
      transport,
      readiness,
    });
    internals.sessions.set(SESSION_ID, sessionInfo({ generation: 7 }));

    expect(launcher.getTransport(SESSION_ID)).toBe(transport);
    expect(launcher.getReadiness(SESSION_ID)).toBe(readiness);
    expect(launcher.getSandboxedGeneration(SESSION_ID)).toBe(7);
    expect(launcher.validateLaunchGeneration(SESSION_ID, 7)).toBe(true);
    expect(launcher.validateLaunchGeneration(SESSION_ID, 0)).toBe(false);
    expect(launcher.validateLaunchGeneration(SESSION_ID, Number.NaN)).toBe(false);
    expect(launcher.validateLaunchGeneration("missing", 7)).toBe(false);
    expect(launcher.isAlive(SESSION_ID)).toBe(true);
    expect(() => launcher.removeSession(SESSION_ID)).toThrow(/active Pi runtime/);
  });

  it("removes inactive authority and treats missing or exited runtimes as stopped", async () => {
    const launcher = new PiLauncher();
    expect(await launcher.kill("missing")).toBe(true);
    launcher.restoreSession(sessionInfo({ state: "running" }));
    expect(await launcher.kill(SESSION_ID)).toBe(true);
    launcher.removeSession(SESSION_ID);
    expect(launcher.getSession(SESSION_ID)).toBeUndefined();
    expect(launcher.nextLaunchGeneration(SESSION_ID)).toBe(1);

    const internals = launcher as unknown as {
      sessions: Map<string, PiSessionInfo>;
    };
    internals.sessions.set(SESSION_ID, sessionInfo({ state: "starting" }));
    expect(await launcher.kill(SESSION_ID)).toBe(false);
  });

  it("aggregates kill failures and shutdown prevents future launches", async () => {
    const failing = new PiLauncher();
    const internals = failing as unknown as {
      runtimes: Map<string, unknown>;
    };
    internals.runtimes.set(SESSION_ID, {});
    vi.spyOn(failing, "kill").mockResolvedValue(false);
    await expect(failing.killAll({ shutdown: false })).rejects.toThrow(AggregateError);

    const shutdown = new PiLauncher();
    await shutdown.killAll();
    await expect(
      shutdown.launch({
        sessionId: SESSION_ID,
        sessionRoot: "/does/not/matter",
        trustedExtensionPath: "/does/not/matter",
        managedSkillPaths: [],
        bootstrapPayload: payload(),
        sandbox: { settings: {} as never },
      }),
    ).rejects.toThrow(/shutting down/);
  });

  it("relaunches with fresh generation authority and the exact persisted Pi JSONL", async () => {
    const root = temporaryRoot("piwork-launcher-relaunch-test-");
    const launcher = new PiLauncher();
    const options = {
      sessionId: SESSION_ID,
      sessionRoot: root,
      trustedExtensionPath: join(root, "extension.ts"),
      managedSkillPaths: [],
      bootstrapPayload: payload(4),
      sandbox: { settings: {} as never },
      resumeSessionFile: join(root, "pi-sessions", "fallback.jsonl"),
    };
    const internals = launcher as unknown as {
      generations: Map<string, number>;
      launchOptions: Map<string, typeof options>;
      sessions: Map<string, PiSessionInfo>;
    };
    internals.generations.set(SESSION_ID, 4);
    internals.launchOptions.set(SESSION_ID, options);
    internals.sessions.set(
      SESSION_ID,
      sessionInfo({
        generation: 4,
        piSessionRelativePath: "pi-sessions/conversation.jsonl",
      }),
    );
    const kill = vi.spyOn(launcher, "kill").mockResolvedValue(true);
    const launch = vi
      .spyOn(launcher, "launch")
      .mockResolvedValue(sessionInfo({ generation: 5, state: "running" }));

    await expect(launcher.relaunch(SESSION_ID)).resolves.toMatchObject({ generation: 5 });
    expect(kill).toHaveBeenCalledWith(SESSION_ID);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        bootstrapPayload: expect.objectContaining({ generation: 5 }),
        resumeSessionFile: join(root, "pi-sessions", "conversation.jsonl"),
      }),
    );

    await expect(new PiLauncher().relaunch(SESSION_ID)).rejects.toThrow(
      /launch authority is not available/,
    );
  });

  it("cleans child, bootstrap, transport, and temp state after readiness failure", async () => {
    const root = temporaryRoot("piwork-launcher-readiness-test-");
    const sessionRoot = join(root, "session");
    const workspace = join(sessionRoot, "workspace");
    const trustedExtensionPath = join(root, "trusted-extension.ts");
    const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    const entryPath = join(packageRoot, "dist", "rpc-entry.js");
    const nodePath = join(root, "node");
    const srtRoot = join(root, "srt-package");
    const srtPath = join(srtRoot, "srt");
    for (const directory of [workspace, join(packageRoot, "dist"), srtRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const path of [trustedExtensionPath, entryPath, nodePath, srtPath]) {
      writeFileSync(path, "fixture");
    }

    const child = childFixture();
    child.pid = 987_654_321;
    const transport = {
      isClosed: false,
      getState: vi.fn(async () => {
        throw new Error("readiness failed");
      }),
      getAvailableModels: vi.fn(async () => []),
      replayHistory: vi.fn(async () => ({ entries: [], leafId: null })),
      getCommands: vi.fn(async () => []),
      dispose: vi.fn(),
    };
    const bootstrap = {
      start: vi.fn(async () => undefined),
      waitForConsumption: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const launcher = new PiLauncher({
      resolvePiRuntime: () => ({
        entryPath,
        packageRoot,
        packageName: "@earendil-works/pi-coding-agent",
        version: "0.82.1",
        nodePath,
      }),
      resolveSrtRuntime: () => ({
        entryPath: srtPath,
        packageRoot: srtRoot,
        packageName: "@anthropic-ai/sandbox-runtime",
        version: "0.0.65",
      }),
      spawnProcess: vi.fn(() => child as never) as never,
      createTransport: vi.fn(() => transport as never),
      createBootstrapServer: vi.fn(() => bootstrap as never),
    });

    await expect(
      launcher.launch({
        sessionId: SESSION_ID,
        sessionRoot,
        workingDirectory: workspace,
        trustedExtensionPath,
        managedSkillPaths: [],
        bootstrapPayload: payload(1, workspace),
        sandbox: {
          settings: {
            filesystem: {
              denyRead: [],
              allowRead: [workspace],
              allowWrite: [workspace],
              denyWrite: [],
              allowGitConfig: false,
            },
            network: {
              allowedDomains: [],
              deniedDomains: [],
              allowUnixSockets: [],
              allowAllUnixSockets: false,
              allowLocalBinding: false,
            },
            enableWeakerNestedSandbox: false,
            enableWeakerNetworkIsolation: false,
          },
        },
      }),
    ).rejects.toThrow("readiness failed");
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(bootstrap.dispose).toHaveBeenCalledOnce();
    expect(launcher.getSession(SESSION_ID)).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect(launcher.getSession(SESSION_ID)).not.toHaveProperty("pid");
  });
});
