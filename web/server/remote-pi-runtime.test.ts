import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import type { PiLaunchOptions, PiSessionInfo } from "./pi-launcher.js";
import type { PiRpcNotification } from "./pi-rpc-contract.js";
import { RemotePiRuntimeBackend } from "./remote-pi-runtime.js";
import type { RuntimeEventFrame, RuntimeScope } from "./runtime-control-protocol.js";
import { RuntimeControlClient } from "./runtime-control-server.js";

const scope: RuntimeScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
};

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessionInfo(currentScope: RuntimeScope, cwd: string): PiSessionInfo {
  return {
    sessionId: currentScope.sessionId,
    state: "ready",
    thinkingLevel: "off",
    mode: "agent",
    cwd,
    createdAt: 1,
    backendType: "pi",
    transport: "pi-rpc",
    generation: currentScope.generation,
    piVersion: "0.82.1",
  };
}

function bootstrapPayload(currentScope: RuntimeScope, workspace: string): PiBootstrapPayload {
  return {
    version: 1,
    sessionId: currentScope.sessionId,
    generation: currentScope.generation,
    authorizedRoots: [{ path: workspace, access: "write" }],
    mode: "agent",
    providers: [],
    managedSkills: [],
    mcp: [],
    taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 1 },
  };
}

function makeLaunchOptions(
  dataRoot: string,
  currentScope: RuntimeScope = scope,
): PiLaunchOptions {
  const sessionRoot = join(
    dataRoot,
    "tenants",
    currentScope.tenantId,
    "users",
    currentScope.userId,
    "sessions",
    currentScope.sessionId,
  );
  const workspace = join(sessionRoot, "workspace");
  const managedResourcesDir = join(sessionRoot, "pi-config", "piwork-resources");
  return {
    sessionId: currentScope.sessionId,
    runtimeScope: currentScope,
    runtimeMode: "compose-nested",
    sessionRoot,
    workingDirectory: workspace,
    trustedExtensionPath: join(dataRoot, "pi-trusted-extension.mjs"),
    managedSkillPaths: [],
    bootstrapPayload: bootstrapPayload(currentScope, workspace),
    sandbox: {
      settings: { network: { allowedDomains: [], deniedDomains: [] } } as never,
      managedResourcesDir,
    },
  };
}

function responseFor(input: { type: string }): Record<string, unknown> {
  switch (input.type) {
    case "get_available_models":
      return { models: [] };
    case "get_available_thinking_levels":
      return { levels: [] };
    case "get_entries":
      return { entries: [] };
    case "get_messages":
      return { messages: [] };
    case "get_commands":
      return { commands: [] };
    case "set_model":
      return { provider: "openai", id: "model", name: "Model" };
    case "get_state":
      return { type: "state" };
    default:
      return {};
  }
}

describe("Remote Pi Runtime backend", () => {
  it("covers scoped launch, the remote transport surface, lifecycle, and cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-remote-runtime-"));
    roots.push(root);
    const currentScope = { ...scope };
    const options = makeLaunchOptions(root, currentScope);
    await mkdir(join(options.sessionRoot, "workspace"), { recursive: true });
    await mkdir(options.sandbox.managedResourcesDir!, { recursive: true });
    await writeFile(options.trustedExtensionPath, "export {};\n");
    const keyPath = join(root, "control.key");
    await writeFile(keyPath, "runtime-control-key-012345678901234567890");

    let eventHandler: ((event: RuntimeEventFrame) => void) | undefined;
    const onEvent = vi
      .spyOn(RuntimeControlClient.prototype, "onEvent")
      .mockImplementation((handler) => {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      });
    const request = vi
      .spyOn(RuntimeControlClient.prototype, "request")
      .mockImplementation(async (requestScope, operation, payload) => {
        if (operation === "launch.prepare") return { nonce: `nonce-${requestScope.generation}` };
        if (operation === "launch.bootstrap") {
          return sessionInfo(requestScope, options.workingDirectory!);
        }
        if (operation === "kill") return { killed: true };
        if (operation === "shutdown") return { stopped: true };
        const input = (payload as { input: { type: string } }).input;
        return {
          type: "response",
          command: input.type,
          success: true,
          data: responseFor(input),
        };
      });
    const backend = new RemotePiRuntimeBackend({
      socketPath: join(root, "runtime.sock"),
      controlKeyPath: keyPath,
      dataRoot: root,
    });

    await expect(
      backend.launch({ ...options, runtimeScope: undefined } as never),
    ).rejects.toThrow("immutable Runtime scope");
    await expect(
      backend.launch({ ...options, sessionId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow("does not match options");
    expect(backend.nextLaunchGeneration(currentScope.sessionId)).toBe(1);

    const notifications: PiRpcNotification[] = [];
    const exits: PiSessionInfo[] = [];
    const info = await backend.launch({
      ...options,
      onNotification: (notification) => notifications.push(notification),
      onExit: (exitInfo) => exits.push(exitInfo),
    });
    expect(info).toMatchObject({ sessionId: currentScope.sessionId, generation: 1 });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(backend.getSession(currentScope.sessionId)).toEqual(info);
    expect(backend.getReadiness(currentScope.sessionId)).toBeUndefined();
    expect(backend.getSandboxedGeneration(currentScope.sessionId)).toBe(1);
    expect(backend.validateLaunchGeneration(currentScope.sessionId, 1)).toBe(true);
    expect(backend.isAlive(currentScope.sessionId)).toBe(true);

    const transport = backend.getTransport(currentScope.sessionId)!;
    expect(transport.getStderr()).toBe("");
    expect(transport.pendingRequestCount).toBe(0);
    const closePromise = transport.waitForClose();
    await transport.sendInput({ type: "abort" });
    await transport.sendExtensionUiResponse({
      type: "extension_ui_response",
      id: "ui-1",
      value: "ok",
    });
    await transport.request({ type: "get_state" } as never);
    await transport.prompt("hello", { images: [], streamingBehavior: "steer" });
    await transport.steer("steer");
    await transport.followUp("follow");
    await transport.abort();
    await transport.getState();
    await transport.getAvailableModels();
    await transport.setModel("openai", "model");
    await transport.setThinkingLevel("off");
    await transport.getAvailableThinkingLevels();
    await transport.compact("compact");
    await transport.setAutoRetry(true);
    await transport.retry();
    await transport.abortRetry();
    await transport.getEntries("entry-1");
    await transport.replayHistory("entry-1");
    await transport.getMessages();
    await transport.getCommands();
    await transport.getSessionStats();

    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.getState({ signal: aborted.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    request.mockImplementationOnce(() => new Promise(() => undefined));
    await expect(transport.getState({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "request_timeout",
    });
    request.mockResolvedValueOnce({
      type: "response",
      command: "get_state",
      success: false,
      error: "remote failure",
    });
    await expect(transport.getState()).rejects.toMatchObject({
      name: "PiRpcRemoteError",
      command: "get_state",
    });

    eventHandler?.({
      version: 1,
      kind: "event",
      event: "pi.notification",
      scope: { ...currentScope, generation: 99 },
      payload: { ignored: true },
      mac: "",
    });
    eventHandler?.({
      version: 1,
      kind: "event",
      event: "pi.notification",
      scope: currentScope,
      payload: { type: "agent_start" },
      mac: "",
    });
    expect(notifications).toEqual([{ type: "agent_start" }]);
    eventHandler?.({
      version: 1,
      kind: "event",
      event: "lifecycle",
      scope: currentScope,
      payload: info,
      mac: "",
    });
    await expect(closePromise).resolves.toMatchObject({ code: "child_exit" });
    expect(exits).toEqual([info]);
    expect(backend.getTransport(currentScope.sessionId)).toBeUndefined();
    expect(backend.isAlive(currentScope.sessionId)).toBe(false);
    await expect(backend.kill(currentScope.sessionId)).resolves.toBe(true);

    const relaunched = await backend.relaunch(currentScope.sessionId);
    expect(relaunched.generation).toBe(2);
    expect(backend.nextLaunchGeneration(currentScope.sessionId)).toBe(3);
    expect(() => backend.removeSession(currentScope.sessionId)).toThrow("active remote");
    backend.setArchived(currentScope.sessionId, true);
    expect(backend.getSession(currentScope.sessionId)?.archived).toBe(true);
    backend.setArchived(currentScope.sessionId, false);
    expect(backend.getSession(currentScope.sessionId)?.archived).toBe(false);
    request.mockResolvedValueOnce({ killed: false });
    await expect(backend.kill(currentScope.sessionId)).resolves.toBe(false);
    backend.restoreSession({ ...relaunched, generation: 5 });
    expect(backend.listSessions()[0]).toMatchObject({ state: "exited", generation: 5 });
    backend.removeSession(currentScope.sessionId);
    await expect(backend.relaunch(currentScope.sessionId)).rejects.toThrow("authority");
    await backend.killAll({ shutdown: false });
    await backend.killAll();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "system" }),
      "shutdown",
    );
  });

  it("rejects missing prepare nonces and invalid bootstrap metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-remote-runtime-invalid-"));
    roots.push(root);
    const options = makeLaunchOptions(root);
    await mkdir(join(options.sessionRoot, "workspace"), { recursive: true });
    await mkdir(options.sandbox.managedResourcesDir!, { recursive: true });
    await writeFile(options.trustedExtensionPath, "export {};\n");
    const keyPath = join(root, "control.key");
    await writeFile(keyPath, "runtime-control-key-012345678901234567890");
    const request = vi
      .spyOn(RuntimeControlClient.prototype, "request")
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ nonce: "nonce" })
      .mockResolvedValueOnce({});
    const backend = new RemotePiRuntimeBackend({
      socketPath: join(root, "runtime.sock"),
      controlKeyPath: keyPath,
      dataRoot: root,
    });
    await expect(backend.launch(options)).rejects.toThrow("no nonce");
    await expect(backend.launch(options)).rejects.toThrow("invalid session metadata");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
