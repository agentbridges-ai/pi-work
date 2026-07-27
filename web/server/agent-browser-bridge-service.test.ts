import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowserBridgeService } from "./agent-browser-bridge-service.js";
import {
  agentBrowserSessionName,
  ensureAgentBrowserSocketRoot,
  type AgentBrowserRuntime,
} from "./agent-browser-runtime.js";

function runtime(ready = true): AgentBrowserRuntime {
  return {
    enabled: true,
    ready,
    rootDir: "/runtime/agent-browser",
    cliEntrypoint: "/runtime/agent-browser/bin/agent-browser.js",
    nativeCli: "/runtime/agent-browser/bin/agent-browser-darwin-arm64",
    providerPlugin: "/runtime/provider/plugin.js",
    providerDist: "/runtime/provider",
    pluginRunner: "/runtime/agent-browser-plugin-runner.mjs",
    daemonScript: "/runtime/provider/daemon.js",
    extensionDir: "/runtime/provider/chrome-mv3",
    bridgePort: 19826,
    bridgeProtocolVersion: 1,
    sourceCommit: "a".repeat(40),
    version: "0.31.1",
    missing: ready ? [] : ["Chrome extension manifest"],
  };
}

describe("AgentBrowserBridgeService", () => {
  it("terminates a daemon that never becomes healthy before startup times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-start-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const child = new EventEmitter() as ChildProcess & {
      exitCode: number | null;
      pid: number;
      signals: NodeJS.Signals[];
    };
    child.exitCode = null;
    child.pid = 4242;
    child.signals = [];
    child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      child.signals.push(signal);
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, signal));
      return true;
    });
    const service = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl: vi.fn(async () => {
        throw new Error("not ready");
      }) as unknown as typeof fetch,
      spawnImpl: vi.fn(() => child) as never,
      sleep: vi.fn(async () => undefined),
    });

    try {
      await expect(service.start()).resolves.toMatchObject({ phase: "error" });
      expect(child.signals).toEqual(["SIGTERM"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts a healthy daemon owned by a previous server instance and stops it on dispose", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-adopt-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const child = new EventEmitter() as ChildProcess & {
      exitCode: number | null;
      pid: number;
    };
    child.exitCode = null;
    child.pid = 5252;
    child.kill = vi.fn(() => true);
    const health = () =>
      new Response(
        JSON.stringify({
          daemon: "ok",
          version: "0.31.1",
          bridgeProtocolVersion: 1,
          profiles: [],
          sessions: [],
        }),
        { status: 200 },
      );
    const firstFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => health());
    const first = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl: firstFetch as unknown as typeof fetch,
      spawnImpl: vi.fn(() => child) as never,
      sleep: vi.fn(async () => undefined),
    });

    try {
      await expect(first.start()).resolves.toMatchObject({ phase: "waiting_for_extension" });

      let alive = true;
      const signalProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
        if (signal === "SIGTERM") alive = false;
      });
      const restarted = new AgentBrowserBridgeService({
        runtime: testRuntime,
        fetchImpl: vi.fn(async () => health()) as unknown as typeof fetch,
        pidIsAlive: vi.fn(() => alive),
        pidMatchesDaemon: vi.fn(() => true),
        signalProcess,
        sleep: vi.fn(async () => undefined),
      });

      await expect(restarted.start()).resolves.toMatchObject({ phase: "waiting_for_extension" });
      await restarted.dispose();

      expect(signalProcess).toHaveBeenCalledWith(5252, "SIGTERM");
    } finally {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not signal a reused owner pid that no longer belongs to the bridge daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-pid-reuse-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const child = new EventEmitter() as ChildProcess & { exitCode: number | null; pid: number };
    child.exitCode = null;
    child.pid = 5454;
    child.kill = vi.fn(() => true);
    const health = () =>
      new Response(
        JSON.stringify({
          daemon: "ok",
          version: "0.31.1",
          bridgeProtocolVersion: 1,
          profiles: [],
          sessions: [],
        }),
      );
    const first = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async () => health()) as unknown as typeof fetch,
      spawnImpl: vi.fn(() => child) as never,
      sleep: vi.fn(async () => undefined),
    });

    try {
      await first.start();
      const signalProcess = vi.fn();
      const restarted = new AgentBrowserBridgeService({
        runtime: testRuntime,
        fetchImpl: vi.fn(async () => health()) as unknown as typeof fetch,
        pidIsAlive: vi.fn(() => true),
        pidMatchesDaemon: vi.fn(() => false),
        signalProcess,
      });

      await restarted.start();
      await restarted.dispose();
      expect(signalProcess).not.toHaveBeenCalled();
    } finally {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces an unhealthy daemon owned by a previous server before spawning another", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-replace-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const previous = new EventEmitter() as ChildProcess & { exitCode: number | null; pid: number };
    previous.exitCode = null;
    previous.pid = 5353;
    previous.kill = vi.fn(() => true);
    const replacement = new EventEmitter() as ChildProcess & {
      exitCode: number | null;
      pid: number;
    };
    replacement.exitCode = null;
    replacement.pid = 6363;
    replacement.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      replacement.exitCode = 0;
      queueMicrotask(() => replacement.emit("exit", 0, signal));
      return true;
    });
    const health = () =>
      new Response(
        JSON.stringify({
          daemon: "ok",
          version: "0.31.1",
          bridgeProtocolVersion: 1,
          profiles: [],
          sessions: [],
        }),
      );
    const first = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async () => health()) as unknown as typeof fetch,
      spawnImpl: vi.fn(() => previous) as never,
      sleep: vi.fn(async () => undefined),
    });

    try {
      await first.start();
      let previousAlive = true;
      const signalProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
        if (pid === previous.pid && signal === "SIGTERM") previousAlive = false;
      });
      const restartedFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("unhealthy"))
        .mockImplementation(async () => health());
      const spawnReplacement = vi.fn(() => replacement);
      const restarted = new AgentBrowserBridgeService({
        runtime: testRuntime,
        fetchImpl: restartedFetch as unknown as typeof fetch,
        spawnImpl: spawnReplacement as never,
        pidIsAlive: vi.fn((pid) => pid === previous.pid && previousAlive),
        pidMatchesDaemon: vi.fn(() => true),
        signalProcess,
        sleep: vi.fn(async () => undefined),
      });

      await expect(restarted.start()).resolves.toMatchObject({ phase: "waiting_for_extension" });

      expect(signalProcess).toHaveBeenCalledWith(previous.pid, "SIGTERM");
      expect(spawnReplacement).toHaveBeenCalledOnce();
      await restarted.dispose();
    } finally {
      previous.exitCode = 0;
      previous.emit("exit", 0, null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not spawn a replacement after disposal begins during startup recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-dispose-start-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const previous = new EventEmitter() as ChildProcess & { exitCode: number | null; pid: number };
    previous.exitCode = null;
    previous.pid = 5555;
    previous.kill = vi.fn(() => true);
    const health = () =>
      new Response(
        JSON.stringify({
          daemon: "ok",
          version: "0.31.1",
          bridgeProtocolVersion: 1,
          profiles: [],
          sessions: [],
        }),
      );
    const first = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async () => health()) as unknown as typeof fetch,
      spawnImpl: vi.fn(() => previous) as never,
      sleep: vi.fn(async () => undefined),
    });

    try {
      await first.start();
      let releaseSleep!: () => void;
      const blockedSleep = new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
      const spawnReplacement = vi.fn();
      const signalProcess = vi.fn();
      const restarted = new AgentBrowserBridgeService({
        runtime: testRuntime,
        fetchImpl: vi.fn(async () => {
          throw new Error("unhealthy");
        }) as unknown as typeof fetch,
        spawnImpl: spawnReplacement as never,
        pidIsAlive: vi.fn(() => true),
        pidMatchesDaemon: vi.fn(() => true),
        signalProcess,
        sleep: vi.fn(async () => blockedSleep),
      });

      const starting = restarted.start();
      await vi.waitFor(() => expect(signalProcess).toHaveBeenCalledWith(previous.pid, "SIGTERM"));
      const disposing = restarted.dispose();
      releaseSleep();
      await Promise.all([starting, disposing]);

      expect(spawnReplacement).not.toHaveBeenCalled();
    } finally {
      previous.exitCode = 0;
      previous.emit("exit", 0, null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports unavailable runtime artifacts without starting a daemon", async () => {
    const spawnImpl = vi.fn();
    const service = new AgentBrowserBridgeService({
      runtime: runtime(false),
      spawnImpl: spawnImpl as never,
    });

    await expect(service.start()).resolves.toMatchObject({
      phase: "unavailable",
      runtime: { ready: false, missing: ["Chrome extension manifest"] },
      daemon: { state: "offline", port: 19826 },
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("rotates an oversized bridge log before reporting status", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-bridge-log-"));
    const testRuntime = runtime();
    testRuntime.rootDir = join(root, "agent-browser");
    const runtimeDir = join(root, ".runtime");
    const logPath = join(runtimeDir, "agent-browser-chrome-bridge.log");
    mkdirSync(runtimeDir);
    writeFileSync(logPath, "0123456789abcdef\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.1",
            bridgeProtocolVersion: 1,
            profiles: [],
            sessions: [],
          }),
        ),
    ) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({
      runtime: testRuntime,
      fetchImpl,
      maxLogBytes: 8,
      maxLogBackups: 2,
    });

    try {
      await service.status();
      expect(existsSync(logPath)).toBe(false);
      expect(readFileSync(`${logPath}.1`, "utf8")).toBe("0123456789abcdef\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarizes connected profiles without returning tab URLs or bridge tokens", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.1",
            bridgeProtocolVersion: 1,
            profiles: [
              {
                profileId: "profile-1",
                chromeVersion: "126.0.0",
                tabCount: 2,
                tabs: [{ tabId: 4, url: "https://private.example", title: "Private" }],
              },
            ],
            sessions: [{ sessionId: "secret", token: "do-not-return" }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    const status = await service.status();
    expect(status).toMatchObject({
      phase: "connected",
      extension: {
        connected: true,
        profiles: [{ profileId: "profile-1", chromeVersion: "126.0.0", tabCount: 2 }],
      },
      daemon: { state: "online", sessionCount: 1 },
    });
    expect(JSON.stringify(status)).not.toContain("private.example");
    expect(JSON.stringify(status)).not.toContain("do-not-return");
  });

  it("shares one in-flight daemon health request across concurrent status callers", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => pending) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    const first = service.status();
    const second = service.status();
    expect(fetchImpl).toHaveBeenCalledOnce();
    release(
      new Response(
        JSON.stringify({
          daemon: "ok",
          version: "0.31.1",
          bridgeProtocolVersion: 1,
          profiles: [],
          sessions: [],
        }),
      ),
    );

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects a daemon that does not match the pinned provider protocol", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.1",
            bridgeProtocolVersion: 2,
            profiles: [],
            sessions: [],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    await expect(service.status()).resolves.toMatchObject({
      phase: "error",
      error: "Chrome bridge protocol mismatch: expected 1",
      daemon: { state: "offline" },
    });
  });

  it("rejects a daemon that does not match the pinned provider version", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.0",
            bridgeProtocolVersion: 1,
            profiles: [],
            sessions: [],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    await expect(service.status()).resolves.toMatchObject({
      phase: "error",
      error: "Chrome bridge version mismatch: expected 0.31.1",
    });
  });

  it("propagates session control using the opaque agent-browser owner id", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ matched: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    await expect(service.setSessionControl("session-1", "human")).resolves.toEqual({
      reachable: true,
      matched: 1,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:19826/control/sessions/${agentBrowserSessionName("session-1")}`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ phase: "human" }) }),
    );
  });

  it("fails session control closed when the runtime or daemon is unavailable", async () => {
    const disabled = new AgentBrowserBridgeService({ runtime: runtime(false) });
    await expect(disabled.setSessionControl("session-1", "agent")).resolves.toEqual({
      reachable: false,
      matched: 0,
    });

    const fetchImpl = vi.fn(async () => Promise.reject(new Error("offline")));
    const offline = new AgentBrowserBridgeService({
      runtime: runtime(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(offline.setSessionControl("session-1", "agent")).resolves.toEqual({
      reachable: false,
      matched: 0,
    });
  });

  it("consumes page control events once and stops polling on dispose", async () => {
    vi.useFakeTimers();
    const event = {
      sequence: 1,
      ownerSessionId: "nex-aaaaaaaaaaaaaaaa",
      bridgeSessionId: "bridge-1",
      action: "takeover",
      tabId: 9,
      pendingActionRisk: true,
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ sequence: 1, events: [event] }), { status: 200 }),
    );
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const handler = vi.fn(async () => undefined);
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    try {
      service.setControlEventHandler(handler);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
      await service.dispose();
      const callsAfterDispose = fetchSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchSpy).toHaveBeenCalledTimes(callsAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a scheduled control poll when its handler is removed", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl });

    try {
      service.setControlEventHandler(vi.fn());
      service.setControlEventHandler(null);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
      vi.useRealTimers();
    }
  });

  it("uses a read-only active-tab probe for end-to-end verification", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.1",
            bridgeProtocolVersion: 1,
            profiles: [{ profileId: "profile-1", tabCount: 1 }],
            sessions: [],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const runCli = vi.fn(
      async (
        _command: string,
        _args: string[],
        _env: Record<string, string | undefined>,
        _timeoutMs: number,
      ) => ({ stdout: JSON.stringify({ success: true, data: "https://example.com" }), stderr: "" }),
    );
    const service = new AgentBrowserBridgeService({
      runtime: runtime(),
      fetchImpl,
      runCli,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValue(145),
    });

    const result = await service.verify();

    expect(result).toMatchObject({ ok: true, durationMs: 45, probe: "active_tab_url" });
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(runCli.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["--provider", "chrome-extension", "get", "url"]),
    );
    expect(runCli.mock.calls[1][1]).toEqual(expect.arrayContaining(["close"]));
  });

  it.each([
    ["empty", ""],
    ["invalid JSON", "not-json"],
    ["reported failure", JSON.stringify({ success: false })],
  ])("rejects an %s verification probe", async (_label, stdout) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            daemon: "ok",
            version: "0.31.1",
            bridgeProtocolVersion: 1,
            profiles: [{ profileId: "profile-1", tabCount: 1 }],
            sessions: [],
          }),
        ),
    ) as unknown as typeof fetch;
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ stdout, stderr: "" })
      .mockResolvedValue({ stdout: JSON.stringify({ success: true }), stderr: "" });
    const service = new AgentBrowserBridgeService({ runtime: runtime(), fetchImpl, runCli });

    await expect(service.verify()).rejects.toThrow(/empty|invalid JSON|failed verification/);
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it("captures a structured snapshot through the owned session before resume", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "readback-"));
    const runCli = vi.fn(
      async (
        _command: string,
        _args: string[],
        _env: Record<string, string | undefined>,
        _timeoutMs: number,
      ) => ({
        stdout: JSON.stringify({ success: true, data: { tree: '[textbox "Name"]' } }),
        stderr: "",
      }),
    );
    const service = new AgentBrowserBridgeService({ runtime: runtime(), runCli });

    try {
      const macOsTmpAlias = socketDir.replace(/^\/private\/tmp\//, "/tmp/");
      await expect(service.readSessionSnapshot("session-1", macOsTmpAlias)).resolves.toEqual({
        snapshot: '{\n  "tree": "[textbox \\"Name\\"]"\n}',
        truncated: false,
      });
      expect(runCli).toHaveBeenCalledOnce();
      expect(runCli.mock.calls[0][1]).toEqual([
        "--json",
        "--session",
        agentBrowserSessionName("session-1"),
        "--provider",
        "chrome-extension",
        "snapshot",
      ]);
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it("rejects an unsuccessful semantic snapshot instead of reopening agent control", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "readback-fail-"));
    const service = new AgentBrowserBridgeService({
      runtime: runtime(),
      runCli: vi.fn(async () => ({
        stdout: JSON.stringify({ success: false, data: null }),
        stderr: "",
      })),
    });

    try {
      await expect(service.readSessionSnapshot("session-1", socketDir)).rejects.toThrow(
        "did not return a semantic snapshot",
      );
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid snapshot JSON and bounds a very large semantic readback", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "readback-bounds-"));
    const runCli = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "not-json", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ success: true, data: "x".repeat(70_000) }),
        stderr: "",
      });
    const service = new AgentBrowserBridgeService({ runtime: runtime(), runCli });

    try {
      await expect(service.readSessionSnapshot("session-1", socketDir)).rejects.toThrow(
        "invalid JSON",
      );
      await expect(service.readSessionSnapshot("session-1", socketDir)).resolves.toMatchObject({
        truncated: true,
        snapshot: expect.stringMatching(/\[truncated\]$/),
      });
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it("closes session browser state and removes its short-lived socket directory", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "close-"));
    const sessionId = "session-1";
    writeFileSync(join(socketDir, `${agentBrowserSessionName(sessionId)}.pid`), "123");
    const runCli = vi.fn(async () => ({ stdout: JSON.stringify({ success: true }), stderr: "" }));
    const service = new AgentBrowserBridgeService({ runtime: runtime(), runCli });

    await service.closeSession(sessionId, socketDir);

    expect(runCli).toHaveBeenCalledOnce();
    expect(existsSync(socketDir)).toBe(false);
  });

  it("removes socket state even when runtime artifacts are unavailable", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "unavailable-"));
    writeFileSync(join(socketDir, "stale.sock"), "stale");
    const runCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const service = new AgentBrowserBridgeService({ runtime: runtime(false), runCli });

    await service.closeSession("session-1", socketDir);

    expect(runCli).not.toHaveBeenCalled();
    expect(existsSync(socketDir)).toBe(false);
  });

  it("fails semantic readback closed when the runtime or managed session state is unavailable", async () => {
    const socketRoot = ensureAgentBrowserSocketRoot();
    const missingSocketDir = join(socketRoot, `missing-${crypto.randomUUID()}`);

    await expect(
      new AgentBrowserBridgeService({ runtime: runtime(false) }).readSessionSnapshot(
        "session-1",
        missingSocketDir,
      ),
    ).rejects.toThrow("runtime is unavailable");
    await expect(
      new AgentBrowserBridgeService({ runtime: runtime() }).readSessionSnapshot(
        "session-1",
        missingSocketDir,
      ),
    ).rejects.toThrow("session state is unavailable");
  });

  it("removes an empty managed session directory without invoking the provider", async () => {
    const socketDir = mkdtempSync(join(ensureAgentBrowserSocketRoot(), "empty-close-"));
    const runCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const service = new AgentBrowserBridgeService({ runtime: runtime(), runCli });

    await service.closeSession("session-1", socketDir);

    expect(runCli).not.toHaveBeenCalled();
    expect(existsSync(socketDir)).toBe(false);
  });
});
