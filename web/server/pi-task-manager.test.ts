import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import type { PiBrokerRequest, PiBrokerRequestContext } from "./pi-broker-server.js";
import type { PiLaunchOptions, PiSessionInfo } from "./pi-launcher.js";
import type { PiRpcNotification } from "./pi-rpc-contract.js";
import type { PiRuntimeBrokers } from "./pi-runtime-brokers.js";
import { PiTaskManager, type PiTaskLauncher } from "./pi-task-manager.js";
import { preparePiSessionLayout } from "./pi-session-layout.js";
import { compileSrtPolicy } from "./srt-policy.js";

const ROOT_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_GENERATION = 7;
const ROOT_MODEL = {
  key: "managed/model",
  provider: "managed",
  modelId: "model",
} as const;

interface FakeTaskLaunch {
  options?: PiLaunchOptions;
  transport: {
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
  launcher: {
    launch: ReturnType<typeof vi.fn>;
    getTransport: ReturnType<typeof vi.fn>;
    killAll: ReturnType<typeof vi.fn>;
  };
}

const roots: string[] = [];
const managers: PiTaskManager[] = [];

function makeTreeRemovable(path: string): void {
  let directory = false;
  try {
    directory = lstatSync(path).isDirectory();
    chmodSync(path, directory ? 0o700 : 0o600);
  } catch {
    return;
  }
  if (!directory) return;
  for (const entry of readdirSync(path)) {
    makeTreeRemovable(join(path, entry));
  }
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
  for (const root of roots.splice(0)) {
    makeTreeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function brokerContext(signal = new AbortController().signal): PiBrokerRequestContext {
  return {
    signal,
    onProgress: vi.fn(),
  };
}

function taskRequest(
  sessionId: string,
  generation: number,
  payload: Record<string, unknown>,
): PiBrokerRequest {
  return {
    id: `request-${Math.random()}`,
    sessionId,
    generation,
    operation: "task.start",
    payload,
  };
}

function taskOperation(
  operation: string,
  payload: Record<string, unknown> = {},
  sessionId = ROOT_SESSION_ID,
  generation = ROOT_GENERATION,
): PiBrokerRequest {
  return {
    id: `request-${Math.random()}`,
    sessionId,
    generation,
    operation,
    payload,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for fake task runtime");
}

function sealManagedResources(path: string): void {
  const skill = join(path, "skills", "managed");
  const bin = join(path, "bin");
  mkdirSync(skill, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Managed\n");
  writeFileSync(join(bin, "managed-tool"), "#!/bin/sh\n");
  for (const file of [join(skill, "SKILL.md"), join(bin, "managed-tool")]) {
    chmodSync(file, 0o500);
  }
  for (const directory of [skill, join(path, "skills"), bin, path]) {
    chmodSync(directory, 0o500);
  }
}

function fixture(
  rootMode: "agent" | "plan" = "agent",
  fixtureOptions: { deferLaunch?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "piwork-task-manager-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const tenantRoot = join(dataRoot, "tenant");
  const rootSessionRoot = join(tenantRoot, "sessions", ROOT_SESSION_ID);
  mkdirSync(tenantRoot, { recursive: true });
  const layout = preparePiSessionLayout(rootSessionRoot);
  const knowledgeDir = join(tenantRoot, "knowledge", "managed");
  const runtimeFile = join(root, "trusted-runtime.js");
  const browserControl = join(layout.sessionRoot, ".browser-control.json");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(runtimeFile, "runtime");
  writeFileSync(browserControl, "{}\n");
  sealManagedResources(layout.piResourcesDir);

  const sandboxSettings = compileSrtPolicy({
    tenantsRoot: dataRoot,
    tenantRoot,
    sessionRoot: layout.sessionRoot,
    workspaceDir: layout.workspaceDir,
    homeDir: layout.homeDir,
    tmpDir: layout.tmpDir,
    piConfigDir: layout.piRuntimeConfigDir,
    piSessionsDir: layout.piSessionsDir,
    managedReadPaths: [layout.piResourcesDir, browserControl],
    knowledgeDirs: [knowledgeDir],
    runtimeReadPaths: [runtimeFile],
    unixSocketPaths: [join(root, "internal.sock")],
    deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
    requiredInternalDomains: [],
    domainLayers: [
      {
        allowedDomains: ["models.example.test"],
        deniedDomains: ["blocked.example.test"],
      },
    ],
  });

  const launches: FakeTaskLaunch[] = [];
  const launchResolvers: Array<() => void> = [];
  const launcherFactory = (): PiTaskLauncher => {
    const launchRecord: FakeTaskLaunch = {
      transport: {
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        steer: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
      },
      launcher: {} as FakeTaskLaunch["launcher"],
    };
    launchRecord.launcher = {
      launch: vi.fn(async (launchOptions: PiLaunchOptions): Promise<PiSessionInfo> => {
        launchRecord.options = launchOptions;
        if (fixtureOptions.deferLaunch) {
          await new Promise<void>((resolveLaunch) => launchResolvers.push(resolveLaunch));
        }
        return {
          sessionId: launchOptions.sessionId!,
          state: "running",
          lifecycleState: "enabled",
          model: launchOptions.model,
          thinkingLevel: launchOptions.thinkingLevel || "medium",
          mode: launchOptions.mode || "agent",
          cwd: launchOptions.workingDirectory!,
          createdAt: Date.now(),
          backendType: "pi",
          transport: "pi-rpc",
          generation: 1,
          piVersion: "0.82.1",
        };
      }),
      getTransport: vi.fn(() => launchRecord.transport),
      killAll: vi.fn(async () => undefined),
    };
    launches.push(launchRecord);
    return launchRecord.launcher as unknown as PiTaskLauncher;
  };

  const childAuthorities = new Map<
    string,
    { mode: "agent" | "plan"; readOnlyLocked: boolean; capability: string }
  >();
  const issueChildEndpoint = vi.fn(
    (
      sessionId: string,
      generation: number,
      authority: { mode: "agent" | "plan"; readOnlyLocked: boolean },
    ) => {
      const capability = `capability-${sessionId}-${generation}`;
      childAuthorities.set(`${sessionId}:${generation}`, {
        ...authority,
        capability,
      });
      return {
        brokerSocket: join(root, "task-broker.sock"),
        capability,
      };
    },
  );
  const revokeChildEndpoint = vi.fn((sessionId: string, generation: number) => {
    childAuthorities.delete(`${sessionId}:${generation}`);
  });
  const brokers = {
    socketPath: join(root, "task-broker.sock"),
    issueChildEndpoint,
    revokeChildEndpoint,
  } as unknown as PiRuntimeBrokers;
  const events: Record<string, unknown>[] = [];
  const managedSkillPath = join(layout.managedSkillsDir, "managed");
  const deliverTaskResult = vi.fn(async () => undefined);
  const manager = new PiTaskManager({
    rootSessionId: ROOT_SESSION_ID,
    rootGeneration: ROOT_GENERATION,
    rootSessionRoot: layout.sessionRoot,
    rootWorkspaceDir: layout.workspaceDir,
    rootMode,
    rootModel: ROOT_MODEL,
    thinkingLevel: "xhigh",
    trustedExtensionPath: runtimeFile,
    managedSkillPaths: [managedSkillPath],
    managedSkills: [
      {
        path: managedSkillPath,
        name: "managed",
        sha256: "a".repeat(64),
      },
    ],
    providers: [
      {
        name: "managed",
        config: {
          api: "openai-completions",
          apiKey: "one-use-secret",
          models: [{ id: "model", name: "Model" }],
        },
      },
    ],
    mcp: [
      {
        name: "docs",
        enabled: true,
        status: "connected",
        transport: "streamable-http",
        tools: [
          { name: "read", readOnly: true },
          { name: "write", readOnly: false },
        ],
      },
    ],
    sandboxSettings,
    sharedReadOnlyPaths: [layout.piResourcesDir, browserControl],
    userSpaceCapability: "root-user-space-capability",
    toolEnvironment: {
      PIWORK_AGENT_BROWSER_CONTROL_FILE: browserControl,
    },
    managedResourcesDir: layout.piResourcesDir,
    sessionBinDir: join(layout.piResourcesDir, "bin"),
    brokers,
    launcherFactory,
    onTaskEvent: (event) => events.push(event),
    deliverTaskResult,
  });
  managers.push(manager);
  return {
    root,
    layout,
    knowledgeDir,
    runtimeFile,
    browserControl,
    sandboxSettings,
    manager,
    launches,
    events,
    childAuthorities,
    issueChildEndpoint,
    revokeChildEndpoint,
    managedSkillPath,
    deliverTaskResult,
    launchResolvers,
  };
}

describe("PiTaskManager", () => {
  it("inherits model/thinking and shares only root Agent Space with private child state", async () => {
    const context = fixture();
    const result = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "inspect the workspace",
        background: true,
        model: {
          key: "forged/model",
          provider: "forged",
          modelId: "forged",
        },
        thinkingLevel: "off",
      }),
      brokerContext(),
    )) as { taskId: string };
    const launch = context.launches[0].options!;
    const childLayout = preparePiSessionLayout(launch.sessionRoot);

    expect(launch.model).toEqual(ROOT_MODEL);
    expect(launch.thinkingLevel).toBe("xhigh");
    expect(launch.mode).toBe("agent");
    expect(launch.workingDirectory).toBe(context.layout.workspaceDir);
    expect(launch.bootstrapPayload.authorizedRoots).toEqual([
      { path: context.layout.workspaceDir, access: "write" },
    ]);
    expect(launch.bootstrapPayload.instructions).toContain("isolated managed Piwork sub-agent");
    expect(launch.bootstrapPayload.managedSkills).toEqual([
      {
        path: context.managedSkillPath,
        name: "managed",
        sha256: "a".repeat(64),
      },
    ]);
    expect(launch.managedSkillPaths).toEqual([context.managedSkillPath]);
    expect(launch.bootstrapPayload.productTools).toEqual({
      userSpaceCapability: "root-user-space-capability",
    });
    expect(launch.sandbox.toolEnvironment).not.toHaveProperty("PIWORK_USER_SPACE_API_TOKEN");
    expect(launch.sandbox).toMatchObject({
      managedResourcesDir: context.layout.piResourcesDir,
      sessionBinDir: join(context.layout.piResourcesDir, "bin"),
    });

    const filesystem = launch.sandbox.settings.filesystem;
    const allPaths = [
      ...(filesystem.allowRead || []),
      ...(filesystem.allowWrite || []),
      ...(filesystem.denyRead || []),
      ...(filesystem.denyWrite || []),
    ];
    for (const parentPrivate of [
      context.layout.homeDir,
      context.layout.tmpDir,
      context.layout.piRuntimeConfigDir,
      context.layout.piSessionsDir,
      context.layout.recordingsDir,
      context.layout.userSpaceCheckoutsDir,
    ]) {
      expect(allPaths).not.toContain(parentPrivate);
    }
    expect(filesystem.allowRead).toEqual(
      expect.arrayContaining([
        context.layout.workspaceDir,
        context.layout.piResourcesDir,
        context.browserControl,
        context.knowledgeDir,
        context.runtimeFile,
        childLayout.homeDir,
        childLayout.tmpDir,
        childLayout.piRuntimeConfigDir,
        childLayout.piSessionsDir,
      ]),
    );
    expect(filesystem.allowRead).not.toContain(childLayout.workspaceDir);
    expect(filesystem.allowWrite).toContain(context.layout.workspaceDir);
    expect(filesystem.allowWrite).not.toContain(context.layout.piResourcesDir);
    expect(filesystem.denyRead).toEqual(
      expect.arrayContaining([childLayout.recordingsDir, childLayout.userSpaceCheckoutsDir]),
    );
    expect(launch.sandbox.settings.network).toEqual(context.sandboxSettings.network);

    await context.manager.stopTask(result.taskId);
  });

  it("locks inherited Plan tasks to read-only Agent Space", async () => {
    const context = fixture("plan");
    const result = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "plan only",
        background: true,
        mode: "agent",
      }),
      brokerContext(),
    )) as { taskId: string };
    const launch = context.launches[0].options!;

    expect(launch.mode).toBe("plan");
    expect(launch.thinkingLevel).toBe("xhigh");
    expect(launch.bootstrapPayload.authorizedRoots).toEqual([
      { path: context.layout.workspaceDir, access: "read" },
    ]);
    expect(launch.sandbox.settings.filesystem.allowWrite).not.toContain(
      context.layout.workspaceDir,
    );
    expect(launch.sandbox.settings.filesystem.denyWrite).toContain(context.layout.workspaceDir);
    expect(context.childAuthorities.get(`${launch.sessionId}:1`)).toMatchObject({
      mode: "plan",
      readOnlyLocked: true,
    });
    await expect(
      context.manager.handle(
        {
          id: "mode-agent",
          sessionId: launch.sessionId!,
          generation: 1,
          operation: "mode.set",
          payload: { mode: "agent" },
        },
        brokerContext(),
      ),
    ).rejects.toThrow(/cannot enter Agent mode/);

    await context.manager.stopTask(result.taskId);
  });

  it("revokes writable child runtimes when the root enters Plan mode", async () => {
    const context = fixture("agent");
    const writable = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };

    await context.manager.setRootMode("plan");
    expect(context.launches[0].launcher.killAll).toHaveBeenCalled();
    await expect(
      context.manager.handle(
        taskOperation("task.status", { taskId: writable.taskId }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({ status: "stopped" });

    const readOnly = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Read the source document",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    expect(context.launches[1].options!.mode).toBe("plan");
    await context.manager.stopTask(readOnly.taskId);
  });

  it("makes concurrent Plan transitions await and propagate child termination failure", async () => {
    const context = fixture("agent");
    const writable = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    let rejectTermination!: (reason: unknown) => void;
    context.launches[0].launcher.killAll.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectTermination = reject;
        }),
    );

    const firstTransition = context.manager.setRootMode("plan");
    await waitFor(() => context.launches[0].launcher.killAll.mock.calls.length === 1);
    let secondFinished = false;
    const secondTransition = context.manager.setRootMode("plan");
    void secondTransition.then(
      () => {
        secondFinished = true;
      },
      () => {
        secondFinished = true;
      },
    );
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(context.launches[0].launcher.killAll).toHaveBeenCalledTimes(1);

    const firstFailure = expect(firstTransition).rejects.toThrow(
      /writable tasks could not be stopped/u,
    );
    const secondFailure = expect(secondTransition).rejects.toThrow(
      /writable tasks could not be stopped/u,
    );
    rejectTermination(new Error("child process survived SIGKILL"));
    await firstFailure;
    await secondFailure;
    await expect(
      context.manager.handle(
        taskOperation("task.status", { taskId: writable.taskId }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({ status: "stopped" });

    await expect(context.manager.setRootMode("plan")).resolves.toBeUndefined();
    expect(context.launches[0].launcher.killAll).toHaveBeenCalledTimes(2);
  });

  it("finishes task cleanup when a child exits after an earlier stop failure", async () => {
    const context = fixture("agent");
    const started = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    const launch = context.launches[0].options!;
    context.launches[0].launcher.killAll.mockRejectedValueOnce(
      new Error("child process survived SIGKILL"),
    );

    await expect(context.manager.stopTask(started.taskId)).rejects.toThrow(/survived SIGKILL/u);
    expect(existsSync(launch.sessionRoot)).toBe(true);
    launch.onExit?.({} as PiSessionInfo);

    await waitFor(
      () =>
        context.launches[0].launcher.killAll.mock.calls.length === 2 &&
        !existsSync(launch.sessionRoot),
    );
    expect(context.childAuthorities.has(`${launch.sessionId}:1`)).toBe(false);
  });

  it("kills a writable child whose launch resolves after Plan mode revoked it", async () => {
    const context = fixture("agent", { deferLaunch: true });
    const pending = context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    );
    await waitFor(() => context.launchResolvers.length === 1);

    const planTransition = context.manager.setRootMode("plan");
    let planFinished = false;
    void planTransition.finally(() => {
      planFinished = true;
    });
    await Promise.resolve();
    expect(planFinished).toBe(false);
    const pendingFailure = expect(pending).rejects.toThrow(/stopped while launching/);
    context.launchResolvers[0]!();

    await expect(planTransition).resolves.toBeUndefined();
    await pendingFailure;
    expect(context.launches[0].transport.prompt).not.toHaveBeenCalled();
    expect(context.launches[0].launcher.killAll).toHaveBeenCalledOnce();
  });

  it("does not lose a launching child when its first post-launch termination fails", async () => {
    const context = fixture("agent", { deferLaunch: true });
    const pending = context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    );
    await waitFor(() => context.launchResolvers.length === 1);
    context.launches[0].launcher.killAll.mockRejectedValueOnce(
      new Error("child process survived SIGKILL"),
    );

    const planTransition = context.manager.setRootMode("plan");
    const planFailure = expect(planTransition).rejects.toThrow(
      /writable tasks could not be stopped/u,
    );
    const taskFailure = expect(pending).rejects.toThrow(/survived SIGKILL/u);
    context.launchResolvers[0]!();

    await planFailure;
    await taskFailure;
    expect(context.launches[0].transport.prompt).not.toHaveBeenCalled();
    expect(context.launches[0].launcher.killAll).toHaveBeenCalledTimes(2);
    await expect(context.manager.setRootMode("plan")).resolves.toBeUndefined();
  });

  it("shares concurrent disposal and retries a failed child termination", async () => {
    const context = fixture("agent");
    await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Draft a document",
        background: true,
      }),
      brokerContext(),
    );
    let rejectTermination!: (reason: unknown) => void;
    context.launches[0].launcher.killAll.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectTermination = reject;
        }),
    );

    const firstDispose = context.manager.dispose();
    const secondDispose = context.manager.dispose();
    expect(secondDispose).toBe(firstDispose);
    const firstOutcome = firstDispose.catch((error: unknown) => error);
    const secondOutcome = secondDispose.catch((error: unknown) => error);
    await waitFor(() => typeof rejectTermination === "function");
    rejectTermination(new Error("child process survived SIGKILL"));
    await expect(firstOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/task runtimes could not be disposed/u),
    });
    await expect(secondOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/task runtimes could not be disposed/u),
    });

    await expect(context.manager.dispose()).resolves.toBeUndefined();
    expect(context.launches[0].launcher.killAll).toHaveBeenCalledTimes(2);
  });

  it("revokes a writable descendant when its managed parent enters Plan mode", async () => {
    const context = fixture();
    const parentTask = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Coordinate document research",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    const parentLaunch = context.launches[0].options!;
    const childTask = (await context.manager.handle(
      taskRequest(parentLaunch.sessionId!, 1, {
        depth: 2,
        prompt: "Draft a section",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };

    await context.manager.handle(
      taskOperation("mode.set", { mode: "plan" }, parentLaunch.sessionId!, 1),
      brokerContext(),
    );
    await expect(
      context.manager.handle(
        taskOperation("task.status", { taskId: childTask.taskId }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({ status: "stopped" });
    await context.manager.stopTask(parentTask.taskId);
  });

  it("enforces four parallel tasks and a maximum depth of two", async () => {
    const parallel = fixture();
    const running: Array<{ taskId: string }> = [];
    for (let index = 0; index < 4; index += 1) {
      running.push(
        (await parallel.manager.handle(
          taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
            depth: 1,
            prompt: `parallel-${index}`,
            background: true,
          }),
          brokerContext(),
        )) as { taskId: string },
      );
    }
    await expect(
      parallel.manager.handle(
        taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
          depth: 1,
          prompt: "too many",
          background: true,
        }),
        brokerContext(),
      ),
    ).rejects.toThrow(/parallel limit/);
    const stopped = await parallel.manager.stopTask(running[0].taskId);
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(parallel.launches[0].launcher.killAll).toHaveBeenCalled();
    expect(parallel.revokeChildEndpoint).toHaveBeenCalled();
    for (const task of running.slice(1)) {
      await parallel.manager.stopTask(task.taskId);
    }

    const nested = fixture();
    const first = (await nested.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "depth one",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    const firstLaunch = nested.launches[0].options!;
    const second = (await nested.manager.handle(
      taskRequest(firstLaunch.sessionId!, 1, {
        depth: 2,
        prompt: "depth two",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };
    const secondLaunch = nested.launches[1].options!;
    await expect(
      nested.manager.handle(
        taskRequest(secondLaunch.sessionId!, 1, {
          depth: 3,
          prompt: "depth three",
          background: true,
        }),
        brokerContext(),
      ),
    ).rejects.toThrow(/depth limit/);
    await nested.manager.stopTask(first.taskId);
    await nested.manager.stopTask(second.taskId);
  });

  it("streams progress and returns the foreground assistant result", async () => {
    const context = fixture();
    const pending = context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "foreground",
        background: false,
      }),
      brokerContext(),
    );
    await waitFor(() => context.launches[0]?.transport.prompt.mock.calls.length > 0);
    const notify = context.launches[0].options!.onNotification!;
    notify(
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
        partialResult: { content: [] },
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );
    notify(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "finished" }],
        },
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );
    notify(
      {
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );
    let resolved = false;
    void pending.finally(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    notify(
      {
        type: "agent_settled",
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );

    await expect(pending).resolves.toMatchObject({
      status: "completed",
      result: "finished",
      background: false,
    });
    expect(context.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "starting", progress: "starting" }),
        expect.objectContaining({ status: "running", progress: "running" }),
        expect.objectContaining({ progress: "tool:read" }),
        expect.objectContaining({ status: "completed", progress: "finished" }),
      ]),
    );
  });

  it("maps a settled Pi assistant error to a failed managed task", async () => {
    const context = fixture();
    const pending = context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Read the damaged document",
        background: false,
      }),
      brokerContext(),
    );
    await waitFor(() => context.launches[0]?.transport.prompt.mock.calls.length > 0);
    const notify = context.launches[0].options!.onNotification!;
    notify(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "The document parser failed.",
        },
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );
    notify({ type: "agent_settled" } as PiRpcNotification, {} as PiSessionInfo);

    await expect(pending).rejects.toThrow("The document parser failed.");
    expect(context.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          progress: "The document parser failed.",
        }),
      ]),
    );
    expect(context.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "completed" })]),
    );
  });

  it("retains background results, supports Pi-native steering/waiting, and follows up to parent", async () => {
    const context = fixture();
    const started = (await context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "Compare the two source documents and cite the differences.",
        description: "Compare source documents",
        background: true,
      }),
      brokerContext(),
    )) as { taskId: string };

    await expect(
      context.manager.handle(
        taskOperation("task.status", { taskId: started.taskId }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({
      taskId: started.taskId,
      status: "running",
      description: "Compare source documents",
    });
    await expect(
      context.manager.handle(taskOperation("task.list"), brokerContext()),
    ).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: started.taskId, status: "running" })],
    });
    await expect(
      context.manager.handle(
        taskOperation("task.steer", {
          taskId: started.taskId,
          message: "Prioritize the signed version.",
        }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({ taskId: started.taskId, status: "running" });
    expect(context.launches[0].transport.steer).toHaveBeenCalledWith(
      "Prioritize the signed version.",
      expect.objectContaining({ signal: expect.anything() }),
    );
    await expect(
      context.manager.handle(
        taskOperation("task.wait", { taskId: started.taskId, timeoutMs: 1 }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({
      taskId: started.taskId,
      status: "running",
      timedOut: true,
    });

    const notify = context.launches[0].options!.onNotification!;
    notify(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The signed document adds a termination clause." }],
        },
      } as unknown as PiRpcNotification,
      {} as PiSessionInfo,
    );
    notify({ type: "agent_settled" } as PiRpcNotification, {} as PiSessionInfo);
    await waitFor(() => context.deliverTaskResult.mock.calls.length === 1);

    await expect(
      context.manager.handle(
        taskOperation("task.wait", { taskId: started.taskId, timeoutMs: 10 }),
        brokerContext(),
      ),
    ).resolves.toMatchObject({
      taskId: started.taskId,
      status: "completed",
      result: "The signed document adds a termination clause.",
    });
    expect(context.deliverTaskResult).toHaveBeenCalledWith(
      ROOT_SESSION_ID,
      expect.stringContaining("The signed document adds a termination clause."),
    );
    await expect(
      context.manager.handle(taskOperation("task.list"), brokerContext()),
    ).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: started.taskId, status: "completed" })],
    });
  });

  it("aborts a foreground task and cleans its child authority", async () => {
    const context = fixture();
    const controller = new AbortController();
    const pending = context.manager.handle(
      taskRequest(ROOT_SESSION_ID, ROOT_GENERATION, {
        depth: 1,
        prompt: "abort me",
        background: false,
      }),
      brokerContext(controller.signal),
    );
    await waitFor(() => context.events.some((event) => event.status === "running"));
    const launch = context.launches[0].options!;
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
    expect(context.launches[0].transport.abort).toHaveBeenCalled();
    expect(context.childAuthorities.has(`${launch.sessionId}:1`)).toBe(false);
    expect(context.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "stopped",
          progress: "Managed Pi task was aborted",
        }),
      ]),
    );
    expect(context.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", progress: "failed" })]),
    );
  });
});
