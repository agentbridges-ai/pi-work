import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { AgentMode, PiModelRef, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import type {
  ManagedSkillBootstrap,
  McpBootstrap,
  PiBootstrapPayload,
  ProviderBootstrap,
} from "./pi-bootstrap-channel.js";
import type { PiBrokerRequest, PiBrokerRequestContext } from "./pi-broker-server.js";
import { PiLauncher, type PiLaunchOptions, type PiSessionInfo } from "./pi-launcher.js";
import type { PiRpcNotification } from "./pi-rpc-contract.js";
import type { PiRuntimeObserver } from "./pi-runtime-observer.js";
import { preparePiSessionLayout } from "./pi-session-layout.js";
import type { PiRuntimeBrokers } from "./pi-runtime-brokers.js";
import { deriveTaskSrtPolicy } from "./srt-policy.js";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

const MAX_PARALLEL_TASKS = 4;
const MAX_TASK_DEPTH = 2;
const FOREGROUND_TIMEOUT_MS = 30 * 60_000;

interface ParentContext {
  sessionId: string;
  generation: number;
  rootSessionId: string;
  parentSessionRoot: string;
  depth: number;
  mode: AgentMode;
  model: PiModelRef;
  thinkingLevel: ThinkingLevel;
  readOnlyLocked: boolean;
}

interface ActiveTask {
  taskId: string;
  parent: ParentContext;
  sessionId: string;
  generation: number;
  sessionRoot: string;
  launcher: PiTaskLauncher;
  background: boolean;
  status: "starting" | "running" | "completed" | "failed" | "stopped";
  finalText: string;
  completion: Promise<unknown>;
  finish(value: unknown): void;
  fail(error: Error): void;
}

export interface PiTaskLauncher {
  launch(options: PiLaunchOptions): Promise<PiSessionInfo>;
  getTransport(sessionId: string): ReturnType<PiLauncher["getTransport"]>;
  killAll(options?: { shutdown?: boolean }): Promise<void>;
}

export interface PiTaskManagerOptions {
  rootSessionId: string;
  rootGeneration: number;
  rootSessionRoot: string;
  rootWorkspaceDir: string;
  rootMode: AgentMode;
  rootModel: PiModelRef;
  thinkingLevel: ThinkingLevel;
  trustedExtensionPath: string;
  managedSkillPaths: readonly string[];
  managedSkills: readonly ManagedSkillBootstrap[];
  providers: readonly ProviderBootstrap[];
  mcp: readonly McpBootstrap[];
  sandboxSettings: SandboxRuntimeConfig;
  /** Exact parent-session paths children may reuse read-only. */
  sharedReadOnlyPaths: readonly string[];
  userSpaceCapability?: string;
  toolEnvironment?: Readonly<Record<string, string>>;
  managedResourcesDir: string;
  sessionBinDir?: string;
  brokers: PiRuntimeBrokers;
  launcherFactory?: () => PiTaskLauncher;
  runtimeObserver?: PiRuntimeObserver;
  registerRecordingSensitiveValues?: (values: readonly string[]) => void;
  onTaskEvent?: (event: Record<string, unknown>) => void;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, name: string, maxLength = 100_000): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(`Managed task ${name} is invalid`);
  }
  return value;
}

function textFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const item = record(part);
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
}

function taskRoot(parentRoot: string, taskId: string): string {
  const root = resolve(parentRoot);
  const candidate = resolve(root, "tmp", "pi-tasks", taskId);
  const rel = relative(join(root, "tmp", "pi-tasks"), candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.includes("\0")) {
    throw new Error("Managed task root escaped the parent session");
  }
  return candidate;
}

/**
 * Owns isolated Pi/SRT children for the trusted `task` tool. Every child has a
 * fresh launcher/bootstrap channel and a distinct broker capability, while
 * inheriting only the parent's already-materialized model, Skills, MCP view,
 * network policy, mode, and safe tool environment.
 */
export class PiTaskManager {
  private readonly options: PiTaskManagerOptions;
  private readonly contexts = new Map<string, ParentContext>();
  private readonly tasks = new Map<string, ActiveTask>();
  private disposed = false;

  constructor(options: PiTaskManagerOptions) {
    this.options = options;
    this.contexts.set(`${options.rootSessionId}:${options.rootGeneration}`, {
      sessionId: options.rootSessionId,
      generation: options.rootGeneration,
      rootSessionId: options.rootSessionId,
      parentSessionRoot: options.rootSessionRoot,
      depth: 0,
      mode: options.rootMode,
      model: options.rootModel,
      thinkingLevel: options.thinkingLevel,
      readOnlyLocked: false,
    });
  }

  private emit(task: ActiveTask, progress?: string): void {
    this.options.onTaskEvent?.({
      type: "task_progress",
      rootSessionId: task.parent.rootSessionId,
      generation: this.options.rootGeneration,
      taskId: task.taskId,
      parentSessionId: task.parent.sessionId,
      status: task.status,
      background: task.background,
      depth: task.parent.depth + 1,
      ...(progress ? { progress } : {}),
    });
  }

  private activeFor(rootSessionId: string): number {
    return [...this.tasks.values()].filter(
      (task) =>
        task.parent.rootSessionId === rootSessionId &&
        (task.status === "starting" || task.status === "running"),
    ).length;
  }

  async handle(request: PiBrokerRequest, brokerContext: PiBrokerRequestContext): Promise<unknown> {
    if (this.disposed) throw new Error("Managed task runtime is disposed");
    const parent = this.contexts.get(`${request.sessionId}:${request.generation}`);
    if (!parent) throw new Error("Managed task parent generation is stale");
    if (request.operation === "mode.set") {
      const mode = record(request.payload).mode;
      if (mode !== "agent" && mode !== "plan") {
        throw new Error("Managed task mode is invalid");
      }
      if (mode === "agent" && parent.readOnlyLocked) {
        throw new Error("Read-only managed tasks cannot enter Agent mode");
      }
      parent.mode = mode;
      return { mode };
    }
    if (request.operation === "task.stop") {
      const taskId = requiredString(record(request.payload).taskId, "id", 256);
      return this.stop(taskId, parent.rootSessionId);
    }
    if (request.operation !== "task.start") {
      throw new Error("Unsupported managed task operation");
    }
    return this.start(parent, record(request.payload), brokerContext);
  }

  private async start(
    parent: ParentContext,
    payload: Record<string, unknown>,
    brokerContext: PiBrokerRequestContext,
  ): Promise<unknown> {
    const depth = Number(payload.depth);
    if (!Number.isSafeInteger(depth) || depth !== parent.depth + 1 || depth > MAX_TASK_DEPTH) {
      throw new Error("Managed task depth limit reached");
    }
    if (this.activeFor(parent.rootSessionId) >= MAX_PARALLEL_TASKS) {
      throw new Error("Managed task parallel limit reached");
    }
    const prompt = requiredString(payload.prompt, "prompt");
    const background = payload.background === true;
    const readOnly = parent.mode === "plan" || payload.readOnly === true || payload.mode === "plan";
    const mode: AgentMode = readOnly ? "plan" : "agent";
    // Managed children inherit the already-authorized parent model exactly.
    // Never treat a broker payload as a second model-selection authority.
    const model = parent.model;
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const generation = 1;
    const sessionRoot = taskRoot(this.options.rootSessionRoot, taskId);
    const layout = preparePiSessionLayout(sessionRoot);
    const sandboxSettings = deriveTaskSrtPolicy({
      parent: this.options.sandboxSettings,
      rootSessionRoot: this.options.rootSessionRoot,
      sharedWorkspaceDir: this.options.rootWorkspaceDir,
      sharedReadOnlyPaths: this.options.sharedReadOnlyPaths,
      childSessionRoot: layout.sessionRoot,
      childHomeDir: layout.homeDir,
      childTmpDir: layout.tmpDir,
      childPiRuntimeConfigDir: layout.piRuntimeConfigDir,
      childPiSessionsDir: layout.piSessionsDir,
      childDeniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
      readOnlyWorkspace: mode === "plan",
    });
    const launcher = this.options.launcherFactory?.() || new PiLauncher();
    const childEndpoint = this.options.brokers.issueChildEndpoint(sessionId, generation, {
      mode,
      readOnlyLocked: readOnly,
    });
    this.options.registerRecordingSensitiveValues?.([childEndpoint.capability]);
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const completion = new Promise<unknown>((resolveCompletion, rejectCompletion) => {
      finish = resolveCompletion;
      fail = rejectCompletion;
    });
    const task: ActiveTask = {
      taskId,
      parent,
      sessionId,
      generation,
      sessionRoot,
      launcher,
      background,
      status: "starting",
      finalText: "",
      completion,
      finish,
      fail,
    };
    this.tasks.set(taskId, task);
    this.emit(task, "starting");
    const bootstrap: PiBootstrapPayload = {
      version: 1,
      sessionId,
      generation,
      authorizedRoots: [
        {
          path: this.options.rootWorkspaceDir,
          access: mode === "plan" ? "read" : "write",
        },
      ],
      mode,
      instructions: [
        "You are an isolated managed Piwork sub-agent. Complete only the delegated task and return a concise result to the parent.",
        mode === "plan" ? "This task is read-only. Do not modify files or external state." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      providers: this.options.providers.map((provider) => structuredClone(provider)),
      managedSkills: this.options.managedSkills.map((skill) => structuredClone(skill)),
      mcp: this.options.mcp.map((server) => structuredClone(server)),
      productTools: this.options.userSpaceCapability
        ? { userSpaceCapability: this.options.userSpaceCapability }
        : undefined,
      mcpBroker:
        this.options.mcp.length > 0
          ? {
              socketPath: this.options.brokers.socketPath,
              capability: childEndpoint.capability,
            }
          : undefined,
      taskPolicy: {
        depth,
        maxDepth: MAX_TASK_DEPTH,
        maxParallel: MAX_PARALLEL_TASKS,
        ...(mode === "plan" ? { readOnly: true } : {}),
        ...childEndpoint,
      },
    };
    const onNotification = (notification: PiRpcNotification) => {
      if (notification.type === "message_end") {
        const message = notification.message;
        if (message.role === "assistant") {
          task.finalText = textFromMessage(message);
          this.emit(task, task.finalText.slice(-4_096));
        }
      } else if (notification.type === "tool_execution_update") {
        this.emit(task, `tool:${notification.toolName}`);
      } else if (notification.type === "agent_end" && !notification.willRetry) {
        task.status = "completed";
        this.emit(task, task.finalText || "completed");
        task.finish({
          taskId,
          status: "completed",
          result: task.finalText,
          background,
        });
      }
    };
    try {
      const info = await launcher.launch({
        sessionId,
        sessionRoot,
        workingDirectory: this.options.rootWorkspaceDir,
        trustedExtensionPath: this.options.trustedExtensionPath,
        managedSkillPaths: this.options.managedSkillPaths,
        bootstrapPayload: bootstrap,
        sandbox: {
          settings: sandboxSettings,
          toolEnvironment: this.options.toolEnvironment,
          managedResourcesDir: this.options.managedResourcesDir,
          sessionBinDir: this.options.sessionBinDir,
        },
        model,
        thinkingLevel: parent.thinkingLevel,
        mode,
        observer: this.options.runtimeObserver,
        onNotification,
        onExit: () => {
          if (task.status === "completed" || task.status === "stopped") return;
          task.status = "failed";
          const error = new Error("Managed Pi task process exited");
          this.emit(task, "failed");
          task.fail(error);
        },
      });
      const childContext: ParentContext = {
        sessionId,
        generation: info.generation,
        rootSessionId: parent.rootSessionId,
        parentSessionRoot: sessionRoot,
        depth,
        mode,
        model,
        thinkingLevel: parent.thinkingLevel,
        readOnlyLocked: readOnly,
      };
      this.contexts.set(`${sessionId}:${info.generation}`, childContext);
      task.status = "running";
      this.emit(task, "running");
      const transport = launcher.getTransport(sessionId);
      if (!transport) throw new Error("Managed Pi task transport is unavailable");
      await transport.prompt(prompt, {
        signal: brokerContext.signal,
        abortRemoteOnSignal: true,
      });
      if (background) {
        void completion.catch(() => undefined).finally(() => this.cleanup(task));
        return {
          taskId,
          status: "running",
          background: true,
          depth,
        };
      }
      const timer = setTimeout(() => {
        task.fail(new Error("Managed Pi task timed out"));
      }, FOREGROUND_TIMEOUT_MS);
      timer.unref?.();
      const abortTask = () => {
        task.status = "stopped";
        this.emit(task, "stopped");
        void transport.abort().catch(() => undefined);
        task.fail(new Error("Managed Pi task was aborted"));
      };
      brokerContext.signal.addEventListener("abort", abortTask, { once: true });
      try {
        return await completion;
      } finally {
        brokerContext.signal.removeEventListener("abort", abortTask);
        clearTimeout(timer);
        await this.cleanup(task);
      }
    } catch (error) {
      if (task.status !== "stopped" && task.status !== "completed") {
        task.status = "failed";
        this.emit(task, "failed");
      }
      await this.cleanup(task);
      throw error;
    }
  }

  private async stop(taskId: string, rootSessionId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task || task.parent.rootSessionId !== rootSessionId) {
      throw new Error("Managed task was not found");
    }
    task.status = "stopped";
    await task.launcher.killAll().catch(() => undefined);
    task.finish({ taskId, status: "stopped" });
    this.emit(task, "stopped");
    await this.cleanup(task);
    return { taskId, status: "stopped" };
  }

  stopTask(taskId: string): Promise<Record<string, unknown>> {
    return this.stop(taskId, this.options.rootSessionId);
  }

  setRootMode(mode: AgentMode): void {
    const root = this.contexts.get(`${this.options.rootSessionId}:${this.options.rootGeneration}`);
    if (root) root.mode = mode;
  }

  private async cleanup(task: ActiveTask): Promise<void> {
    this.tasks.delete(task.taskId);
    this.contexts.delete(`${task.sessionId}:${task.generation}`);
    this.options.brokers.revokeChildEndpoint(task.sessionId, task.generation);
    await task.launcher.killAll().catch(() => undefined);
    const root = resolve(this.options.rootSessionRoot, "tmp", "pi-tasks");
    const candidate = resolve(task.sessionRoot);
    const rel = relative(root, candidate);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && existsSync(candidate)) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(
      [...this.tasks.values()].map(async (task) => {
        task.status = "stopped";
        task.finish({ taskId: task.taskId, status: "stopped" });
        await this.cleanup(task);
      }),
    );
    this.contexts.clear();
  }
}
