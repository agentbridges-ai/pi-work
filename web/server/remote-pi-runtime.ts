import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type {
  PiModel,
  PiRpcCommand,
  PiRpcInput,
  PiRpcResponse,
  PiRpcSessionState,
  PiThinkingLevel,
  PiRpcNotification,
  PiExtensionUiResponse,
} from "./pi-rpc-contract.js";
import { serializePiRpcInput } from "./pi-rpc-contract.js";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import type { PiLaunchOptions, PiSessionInfo } from "./pi-launcher.js";
import type { PiRuntimeBackend } from "./pi-runtime-backend.js";
import {
  PiRpcRemoteError,
  PiRpcTransportError,
  type PiRpcEntriesResult,
  type PiRpcRequestOptions,
  type PiRpcTransportLike,
} from "./pi-rpc-transport.js";
import { RuntimeControlClient } from "./runtime-control-server.js";
import { RuntimeControlAuthenticator, type RuntimeScope } from "./runtime-control-protocol.js";
import type {
  RuntimeBootstrapEnvelope,
  RuntimeLaunchPreparePayload,
} from "./pi-runtime-service.js";

export interface RemotePiRuntimeOptions {
  socketPath: string;
  controlKeyPath: string;
  dataRoot: string;
}

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;

function canonicalRelative(root: string, candidate: string, label: string): string {
  const canonicalRoot = realpathSync(root);
  const canonicalCandidate = realpathSync(candidate);
  const value = relative(canonicalRoot, canonicalCandidate).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || value.includes("\0")) {
    throw new Error(`${label} must remain inside the Runtime data root`);
  }
  return value;
}

function requiredScope(options: PiLaunchOptions): RuntimeScope {
  if (!options.runtimeScope)
    throw new Error("Remote Pi launch requires an immutable Runtime scope");
  if (!options.sessionId || options.sessionId !== options.runtimeScope.sessionId) {
    throw new Error("Remote Pi launch session scope does not match options");
  }
  return options.runtimeScope;
}

function responseValue<T>(response: PiRpcResponse, command: PiRpcCommand): T {
  if (!response.success) throw new PiRpcRemoteError(command.type, response.error);
  return response.data as T;
}

class RemotePiRpcTransport implements PiRpcTransportLike {
  readonly sessionId: string;
  readonly generation: number;
  private closed = false;
  private pending = 0;
  private readonly unsubscribe: () => void;
  private readonly closeErrorPromise: Promise<PiRpcTransportError>;
  private resolveCloseError!: (error: PiRpcTransportError) => void;
  private closeError: PiRpcTransportError | undefined;
  private notificationHandler?: (notification: PiRpcNotification) => void;

  constructor(
    private readonly client: RuntimeControlClient,
    private readonly scope: RuntimeScope,
    private readonly onExit?: (info: PiSessionInfo) => void,
  ) {
    this.sessionId = scope.sessionId;
    this.generation = scope.generation;
    this.closeErrorPromise = new Promise((resolveClose) => {
      this.resolveCloseError = resolveClose;
    });
    this.unsubscribe = client.onEvent((event) => {
      if (!sameScope(event.scope, this.scope)) return;
      if (event.event === "pi.notification") {
        this.notificationHandler?.(event.payload as PiRpcNotification);
      } else if (event.event === "lifecycle") {
        if (event.payload && typeof event.payload === "object") {
          this.onExit?.(event.payload as PiSessionInfo);
        }
        this.finish("child_exit", "Remote Pi Runtime ended the session");
      }
    });
  }

  setNotificationHandler(handler: (notification: PiRpcNotification) => void): void {
    this.notificationHandler = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingRequestCount(): number {
    return this.pending;
  }

  getStderr(): string {
    return "";
  }

  waitForClose(): Promise<PiRpcTransportError> {
    return this.closeErrorPromise;
  }

  invalidateGeneration(): void {
    this.finish("stale_generation", "Remote Pi Runtime generation was invalidated");
  }

  dispose(): void {
    this.unsubscribe();
    this.finish("closed", "Remote Pi Runtime transport was disposed");
  }

  private finish(code: "closed" | "child_exit" | "stale_generation", message: string): void {
    if (this.closeError) return;
    this.closed = true;
    this.closeError = new PiRpcTransportError(code, message, {
      sessionId: this.sessionId,
      generation: this.generation,
    });
    this.resolveCloseError(this.closeError);
  }

  private async call<T>(
    input: PiRpcInput,
    options: PiRpcRequestOptions = {},
    waitForResponse = true,
  ): Promise<T> {
    if (this.closed) throw this.closeError;
    serializePiRpcInput(input);
    if (options.signal?.aborted)
      throw new PiRpcTransportError("aborted", "Remote Pi RPC request was aborted", this.scope);
    this.pending += 1;
    try {
      const result = await this.withTimeout(
        this.client.request(this.scope, "request", { input, awaitResponse: waitForResponse }),
        options.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
        options.signal,
        options.abortRemoteOnSignal ?? true,
      );
      if (!waitForResponse) return undefined as T;
      return responseValue<T>(result as PiRpcResponse, input as PiRpcCommand);
    } finally {
      this.pending -= 1;
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    abortRemote: boolean,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const abortRemoteSession = (): void => {
      if (!abortRemote) return;
      void this.client.request(this.scope, "interrupt").catch(() => undefined);
    };
    const abortPromise = signal
      ? new Promise<T>((_, reject) => {
          onAbort = () => {
            abortRemoteSession();
            reject(
              new PiRpcTransportError("aborted", "Remote Pi RPC request was aborted", this.scope),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })
      : undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        abortRemoteSession();
        reject(
          new PiRpcTransportError("request_timeout", "Remote Pi RPC request timed out", this.scope),
        );
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        promise,
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ] as Promise<T>[]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async sendInput(input: PiRpcInput): Promise<void> {
    await this.call<void>(input, {}, false);
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.sendInput(response);
  }

  async request(command: PiRpcCommand, options: PiRpcRequestOptions = {}): Promise<PiRpcResponse> {
    return await this.call<PiRpcResponse>(command, options, true);
  }

  async prompt(
    message: string,
    options: PiRpcRequestOptions & {
      images?: { type: "image"; data: string; mimeType: string }[];
      streamingBehavior?: "steer" | "followUp";
    } = {},
  ): Promise<void> {
    const { images, streamingBehavior, ...requestOptions } = options;
    await this.call({ type: "prompt", message, images, streamingBehavior }, requestOptions, false);
  }

  async steer(message: string, options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "steer", message }, options, false);
  }

  async followUp(message: string, options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "follow_up", message }, options, false);
  }

  async abort(options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "abort" }, options, true);
  }

  async getState(options?: PiRpcRequestOptions): Promise<PiRpcSessionState> {
    return await this.call({ type: "get_state" }, options, true);
  }

  async getAvailableModels(options?: PiRpcRequestOptions): Promise<PiModel[]> {
    const data = await this.call<{ models: PiModel[] }>(
      { type: "get_available_models" },
      options,
      true,
    );
    return data.models;
  }

  async setModel(
    provider: string,
    modelId: string,
    options?: PiRpcRequestOptions,
  ): Promise<PiModel> {
    return await this.call({ type: "set_model", provider, modelId }, options, true);
  }

  async setThinkingLevel(level: PiThinkingLevel, options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "set_thinking_level", level }, options, true);
  }

  async getAvailableThinkingLevels(options?: PiRpcRequestOptions): Promise<PiThinkingLevel[]> {
    const data = await this.call<{ levels: PiThinkingLevel[] }>(
      { type: "get_available_thinking_levels" },
      options,
      true,
    );
    return data.levels;
  }

  async compact(
    customInstructions?: string,
    options?: PiRpcRequestOptions,
  ): Promise<Record<string, unknown>> {
    return await this.call({ type: "compact", customInstructions }, options, true);
  }

  async setAutoRetry(enabled: boolean, options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "set_auto_retry", enabled }, options, true);
  }

  async retry(options?: PiRpcRequestOptions): Promise<void> {
    await this.setAutoRetry(true, options);
  }

  async abortRetry(options?: PiRpcRequestOptions): Promise<void> {
    await this.call({ type: "abort_retry" }, options, true);
  }

  async getEntries(since?: string, options?: PiRpcRequestOptions): Promise<PiRpcEntriesResult> {
    return await this.call({ type: "get_entries", since }, options, true);
  }

  async replayHistory(since?: string, options?: PiRpcRequestOptions): Promise<PiRpcEntriesResult> {
    return await this.getEntries(since, options);
  }

  async getMessages(options?: PiRpcRequestOptions): Promise<Record<string, unknown>[]> {
    const data = await this.call<{ messages: Record<string, unknown>[] }>(
      { type: "get_messages" },
      options,
      true,
    );
    return data.messages;
  }

  async getCommands(options?: PiRpcRequestOptions): Promise<Record<string, unknown>[]> {
    const data = await this.call<{ commands: Record<string, unknown>[] }>(
      { type: "get_commands" },
      options,
      true,
    );
    return data.commands;
  }

  async getSessionStats(options?: PiRpcRequestOptions): Promise<Record<string, unknown>> {
    return await this.call({ type: "get_session_stats" }, options, true);
  }
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.membershipId === right.membershipId &&
    left.orgNodeId === right.orgNodeId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation
  );
}

function toRuntimePrepare(options: PiLaunchOptions, dataRoot: string): RuntimeLaunchPreparePayload {
  requiredScope(options);
  const sessionRoot = realpathSync(options.sessionRoot);
  const managedSkillPaths = options.managedSkillPaths.map((path) =>
    canonicalRelative(sessionRoot, path, "managed Skill"),
  );
  const unixSocketPaths = (options.sandbox.settings.network?.allowUnixSockets || []).map((path) =>
    canonicalRelative(dataRoot, path, "Runtime broker socket"),
  );
  return {
    version: 1,
    mode: options.mode || "agent",
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    network: {
      allowedDomains: [...(options.sandbox.settings.network?.allowedDomains || [])],
      deniedDomains: [...(options.sandbox.settings.network?.deniedDomains || [])],
    },
    managedSkillPaths,
    ...(options.sandbox.toolEnvironment
      ? { toolEnvironment: { ...options.sandbox.toolEnvironment } }
      : {}),
    ...(options.resumeSessionFile
      ? {
          resumeSessionPath: canonicalRelative(
            sessionRoot,
            options.resumeSessionFile,
            "resume session",
          ),
        }
      : {}),
    unixSocketPaths,
  };
}

function toRuntimeBootstrap(
  options: PiLaunchOptions,
  dataRoot: string,
  nonce: string,
): RuntimeBootstrapEnvelope {
  const payload = options.bootstrapPayload;
  const resourcesRoot = realpathSync(
    options.sandbox.managedResourcesDir ||
      resolve(options.sessionRoot, "pi-config/piwork-resources"),
  );
  const managedSkillsRoot = resolve(resourcesRoot, "skills");
  const taskPolicy = payload.taskPolicy;
  return {
    version: 1,
    nonce,
    ...(payload.instructions ? { instructions: payload.instructions } : {}),
    providers: payload.providers,
    mcp: payload.mcp,
    authorizedRoots: payload.authorizedRoots.map((root) => ({
      relativePath: canonicalRelative(dataRoot, root.path, "authorized root"),
      access: root.access,
    })),
    managedSkills: payload.managedSkills.map((skill) => ({
      relativePath: canonicalRelative(managedSkillsRoot, skill.path, "managed Skill"),
      ...(skill.name ? { name: skill.name } : {}),
      ...(skill.sha256 ? { sha256: skill.sha256 } : {}),
    })),
    taskPolicy: {
      depth: taskPolicy.depth,
      maxDepth: taskPolicy.maxDepth,
      maxParallel: taskPolicy.maxParallel,
      ...(taskPolicy.readOnly === undefined ? {} : { readOnly: taskPolicy.readOnly }),
      ...(taskPolicy.brokerSocket
        ? {
            brokerSocketRelative: canonicalRelative(
              dataRoot,
              taskPolicy.brokerSocket,
              "task broker socket",
            ),
          }
        : {}),
      ...(taskPolicy.capability ? { capability: taskPolicy.capability } : {}),
    },
    ...(payload.productTools ? { productTools: payload.productTools } : {}),
    ...(payload.mcpBroker
      ? {
          mcpBroker: {
            socketRelative: canonicalRelative(
              dataRoot,
              payload.mcpBroker.socketPath,
              "MCP broker socket",
            ),
            capability: payload.mcpBroker.capability,
          },
        }
      : {}),
  };
}

function isSessionInfo(value: unknown): value is PiSessionInfo {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { generation?: unknown }).generation === "number"
  );
}

export class RemotePiRuntimeBackend implements PiRuntimeBackend {
  private readonly client: RuntimeControlClient;
  private readonly sessions = new Map<string, PiSessionInfo>();
  private readonly transports = new Map<string, RemotePiRpcTransport>();
  private readonly optionsBySession = new Map<string, PiLaunchOptions>();
  private readonly generations = new Map<string, number>();

  constructor(options: RemotePiRuntimeOptions) {
    const key = readFileSync(options.controlKeyPath);
    this.client = new RuntimeControlClient({
      socketPath: options.socketPath,
      authenticator: new RuntimeControlAuthenticator(key),
    });
    this.dataRoot = realpathSync(resolve(options.dataRoot));
  }

  private readonly dataRoot: string;

  nextLaunchGeneration(sessionId: string): number {
    return (this.generations.get(sessionId) || 0) + 1;
  }

  async launch(options: PiLaunchOptions): Promise<PiSessionInfo> {
    const scope = requiredScope(options);
    // A Web restart must adopt a Pi that is still owned by the independently
    // managed Runtime instead of asking it to launch a duplicate generation.
    // The status request also rebinds the Runtime's event connection to this
    // fresh control socket before notifications are subscribed below.
    const existing = (await this.client.request(scope, "status").catch(() => undefined)) as
      { alive?: unknown; session?: unknown } | undefined;
    if (existing?.alive === true && isSessionInfo(existing.session)) {
      if (existing.session.generation !== scope.generation) {
        throw new Error("Remote Pi Runtime generation is newer than the persisted Web authority");
      }
      return this.attachRemoteSession(scope, options, existing.session);
    }
    const prepared = toRuntimePrepare(options, this.dataRoot);
    const result = (await this.client.request(scope, "launch.prepare", prepared)) as {
      nonce?: unknown;
    };
    if (!result || typeof result.nonce !== "string")
      throw new Error("Runtime launch.prepare returned no nonce");
    const infoValue = await this.client.request(
      scope,
      "launch.bootstrap",
      toRuntimeBootstrap(options, this.dataRoot, result.nonce),
    );
    if (!isSessionInfo(infoValue))
      throw new Error("Runtime launch returned invalid session metadata");
    return this.attachRemoteSession(scope, options, infoValue);
  }

  private attachRemoteSession(
    scope: RuntimeScope,
    options: PiLaunchOptions,
    infoValue: PiSessionInfo,
  ): PiSessionInfo {
    const transport = new RemotePiRpcTransport(this.client, scope, (exitInfo) => {
      const current = this.sessions.get(scope.sessionId);
      if (current && current.generation === scope.generation) {
        this.sessions.set(scope.sessionId, {
          ...current,
          ...exitInfo,
          state: "exited",
          pid: undefined,
        });
        this.transports.delete(scope.sessionId);
      }
      options.onExit?.(exitInfo);
    });
    const callerNotification = options.onNotification;
    transport.setNotificationHandler((notification) =>
      callerNotification?.(notification, infoValue),
    );
    this.transports.set(scope.sessionId, transport);
    this.sessions.set(scope.sessionId, { ...infoValue });
    this.generations.set(scope.sessionId, scope.generation);
    this.optionsBySession.set(scope.sessionId, options);
    return { ...infoValue };
  }

  getSession(sessionId: string): PiSessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    return info ? { ...info } : undefined;
  }

  getTransport(sessionId: string): PiRpcTransportLike | undefined {
    const transport = this.transports.get(sessionId);
    return transport?.isClosed ? undefined : transport;
  }

  getReadiness(_sessionId: string): undefined {
    return undefined;
  }

  getSandboxedGeneration(sessionId: string): number | undefined {
    return this.getTransport(sessionId)?.generation;
  }

  validateLaunchGeneration(sessionId: string, generation: number): boolean {
    return this.getTransport(sessionId)?.generation === generation;
  }

  isAlive(sessionId: string): boolean {
    return this.getTransport(sessionId) !== undefined;
  }

  restoreSession(info: PiSessionInfo): void {
    this.sessions.set(info.sessionId, { ...info, state: "exited", pid: undefined });
    this.generations.set(info.sessionId, info.generation);
  }

  listSessions(): PiSessionInfo[] {
    return [...this.sessions.values()].map((info) => ({ ...info }));
  }

  async kill(sessionId: string): Promise<boolean> {
    const info = this.sessions.get(sessionId);
    const transport = this.transports.get(sessionId);
    if (!info || !transport) return true;
    const scope = this.optionsBySession.get(sessionId)?.runtimeScope;
    if (!scope) return false;
    try {
      const result = (await this.client.request(scope, "kill")) as { killed?: unknown };
      transport.dispose();
      this.transports.delete(sessionId);
      this.sessions.set(sessionId, { ...info, state: "exited", pid: undefined });
      return result?.killed === true;
    } catch {
      return false;
    }
  }

  async killAll(options: { shutdown?: boolean } = {}): Promise<void> {
    await Promise.all([...this.transports.keys()].map((sessionId) => this.kill(sessionId)));
    if (options.shutdown !== false)
      await this.client.request(this.shutdownScope(), "shutdown").catch(() => undefined);
  }

  private shutdownScope(): RuntimeScope {
    const existing = this.optionsBySession.values().next().value?.runtimeScope;
    if (existing) return { ...existing, generation: Math.max(existing.generation, 1) };
    return {
      tenantId: "system",
      userId: "system",
      membershipId: "system",
      orgNodeId: "system",
      sessionId: "system",
      generation: 1,
    };
  }

  relaunch(sessionId: string, bootstrapPayload?: PiBootstrapPayload): Promise<PiSessionInfo> {
    const previous = this.optionsBySession.get(sessionId);
    if (!previous) return Promise.reject(new Error("Remote Pi launch authority is unavailable"));
    return this.kill(sessionId).then(() =>
      this.launch({
        ...previous,
        bootstrapPayload: bootstrapPayload || previous.bootstrapPayload,
        runtimeScope: {
          ...previous.runtimeScope!,
          generation: this.nextLaunchGeneration(sessionId),
        },
      }),
    );
  }

  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    this.sessions.set(sessionId, {
      ...info,
      ...(archived
        ? { archived: true, archivedAt: Date.now() }
        : { archived: false, archivedAt: undefined }),
    });
  }

  removeSession(sessionId: string): void {
    if (this.isAlive(sessionId)) throw new Error("Cannot remove an active remote Pi Runtime");
    this.sessions.delete(sessionId);
    this.optionsBySession.delete(sessionId);
    this.generations.delete(sessionId);
  }
}
