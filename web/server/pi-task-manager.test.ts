import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
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
  };
  launcher: {
    launch: ReturnType<typeof vi.fn>;
    getTransport: ReturnType<typeof vi.fn>;
    killAll: ReturnType<typeof vi.fn>;
  };
}

const roots: string[] = [];
const managers: PiTaskManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
  for (const root of roots.splice(0)) {
    restoreWriteAccess(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function restoreWriteAccess(path: string): void {
  const entry = lstatSync(path);
  chmodSync(path, entry.isDirectory() ? 0o700 : 0o600);
  if (!entry.isDirectory()) return;
  for (const child of readdirSync(path)) restoreWriteAccess(join(path, child));
}

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

function fixture(rootMode: "agent" | "plan" = "agent") {
  // macOS exposes /tmp as a symlink to /private/tmp. The production layout
  // guard correctly rejects symlink aliases, so canonicalize the test root.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-task-manager-")));
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
  const launcherFactory = (): PiTaskLauncher => {
    const launchRecord: FakeTaskLaunch = {
      transport: {
        prompt: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      },
      launcher: {} as FakeTaskLaunch["launcher"],
    };
    launchRecord.launcher = {
      launch: vi.fn(async (options: PiLaunchOptions): Promise<PiSessionInfo> => {
        launchRecord.options = options;
        return {
          sessionId: options.sessionId!,
          state: "running",
          lifecycleState: "enabled",
          model: options.model,
          thinkingLevel: options.thinkingLevel || "medium",
          mode: options.mode || "agent",
          cwd: options.workingDirectory!,
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
        originToolCallId: "task-call-1",
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
    expect(context.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: result.taskId,
          originToolCallId: "task-call-1",
          durationMs: expect.any(Number),
          description: "inspect the workspace",
        }),
      ]),
    );
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
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    notify({ type: "agent_settled" } as unknown as PiRpcNotification, {} as PiSessionInfo);

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
      expect.arrayContaining([expect.objectContaining({ status: "stopped", progress: "stopped" })]),
    );
    expect(context.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed", progress: "failed" })]),
    );
  });
});
