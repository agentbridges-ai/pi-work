import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { PiModelRef, AgentMode, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import {
  isPiBootstrapPayload,
  type McpBootstrap,
  type PiBootstrapPayload,
  type ProviderBootstrap,
  type TaskPolicy,
} from "./pi-bootstrap-channel.js";
import { PiLauncher, type PiLaunchOptions, type PiSessionInfo } from "./pi-launcher.js";
import { isPiRpcCommand, serializePiRpcInput, type PiRpcInput } from "./pi-rpc-contract.js";
import { compileSrtPolicy, type SrtExecutionMode } from "./srt-policy.js";
import type { RuntimeControlConnection, RuntimeControlHandler } from "./runtime-control-server.js";
import type { RuntimeRequestFrame, RuntimeScope } from "./runtime-control-protocol.js";
import { assertRuntimeScope } from "./runtime-control-protocol.js";
import { preparePiSessionLayout, type PiSessionLayout } from "./pi-session-layout.js";
import { isPathInside } from "./path-scope.js";

export interface RuntimeLaunchPreparePayload {
  version: 1;
  mode: AgentMode;
  model?: PiModelRef;
  thinkingLevel?: ThinkingLevel;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  /** Relative to the session root and restricted to its managed resources. */
  managedSkillPaths: string[];
  /** Relative to the session root and restricted to pi-sessions/*.jsonl. */
  resumeSessionPath?: string;
  /** Relative to the data root; only server-owned broker paths are accepted. */
  unixSocketPaths: string[];
}

export interface RuntimeBootstrapEnvelope {
  version: 1;
  nonce: string;
  instructions?: string;
  providers: ProviderBootstrap[];
  mcp: McpBootstrap[];
  authorizedRoots: Array<{ relativePath: string; access: "read" | "write" }>;
  managedSkills: Array<{ relativePath: string; name?: string; sha256?: string }>;
  taskPolicy: Omit<TaskPolicy, "brokerSocket"> & { brokerSocketRelative?: string };
  productTools?: { userSpaceCapability: string };
  mcpBroker?: { socketRelative: string; capability: string };
}

interface PreparedLaunch {
  scope: RuntimeScope;
  payload: RuntimeLaunchPreparePayload;
  nonce: string;
  connection: RuntimeControlConnection;
}

interface ActiveLaunch {
  scope: RuntimeScope;
  connection: RuntimeControlConnection;
}

export interface PiRuntimeServiceOptions {
  dataRoot: string;
  trustedExtensionPath: string;
  executionMode: SrtExecutionMode;
  launcher?: PiLauncher;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`Invalid Runtime ${label}`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid Runtime ${label}`);
  }
  return normalized;
}

function relativePath(value: unknown, label: string): string {
  return safeRelative(value, label);
}

function expectedTenantRoot(dataRoot: string, scope: RuntimeScope): string {
  return join(dataRoot, "tenants", scope.tenantId);
}

function expectedSessionRoot(dataRoot: string, scope: RuntimeScope): string {
  return join(
    expectedTenantRoot(dataRoot, scope),
    "users",
    scope.userId,
    "sessions",
    scope.sessionId,
  );
}

function assertRealChild(root: string, candidate: string, label: string): string {
  const canonicalRoot = realpathSync(root);
  const normalized = resolve(candidate);
  if (!isPathInside(canonicalRoot, normalized) || normalized === canonicalRoot) {
    throw new Error(`${label} escaped its Runtime authority`);
  }
  const canonical = realpathSync(normalized);
  if (!isPathInside(canonicalRoot, canonical) || canonical !== normalized) {
    throw new Error(`${label} must be a canonical non-symlink path`);
  }
  return canonical;
}

function assertSocket(dataRoot: string, sessionRoot: string, value: string): string {
  const absolute = resolve(dataRoot, relativePath(value, "Unix socket path"));
  const canonicalParent = realpathSync(dirname(absolute));
  const canonical = join(canonicalParent, absolute.split(sep).at(-1)!);
  if (isPathInside(sessionRoot, canonical) || !isPathInside(dataRoot, canonical)) {
    throw new Error("Runtime broker sockets must be server-owned and outside the session");
  }
  return canonical;
}

function parsePrepare(value: unknown): RuntimeLaunchPreparePayload {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.network)) {
    throw new Error("Invalid Runtime launch.prepare payload");
  }
  const mode = value.mode;
  if (mode !== "agent" && mode !== "plan") throw new Error("Invalid Runtime Agent mode");
  const network = value.network;
  const allowedDomains = network.allowedDomains;
  const deniedDomains = network.deniedDomains;
  if (
    !Array.isArray(allowedDomains) ||
    !Array.isArray(deniedDomains) ||
    !allowedDomains.every((item) => typeof item === "string") ||
    !deniedDomains.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid Runtime network policy");
  }
  const managedSkillPaths = value.managedSkillPaths;
  const unixSocketPaths = value.unixSocketPaths;
  if (
    !Array.isArray(managedSkillPaths) ||
    !managedSkillPaths.every((item) => typeof item === "string") ||
    !Array.isArray(unixSocketPaths) ||
    !unixSocketPaths.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid Runtime managed resource policy");
  }
  const model = value.model;
  if (
    model !== undefined &&
    (!isRecord(model) || typeof model.provider !== "string" || typeof model.modelId !== "string")
  ) {
    throw new Error("Invalid Runtime model policy");
  }
  const thinkingLevel = value.thinkingLevel;
  if (
    thinkingLevel !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinkingLevel))
  ) {
    throw new Error("Invalid Runtime thinking level");
  }
  return {
    version: 1,
    mode,
    ...(model
      ? {
          model: {
            key: `${String(model.provider)}/${String(model.modelId)}`,
            provider: String(model.provider),
            modelId: String(model.modelId),
          },
        }
      : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
    network: { allowedDomains: [...allowedDomains], deniedDomains: [...deniedDomains] },
    managedSkillPaths: managedSkillPaths.map((item) => safeRelative(item, "managed Skill path")),
    ...(value.resumeSessionPath === undefined
      ? {}
      : { resumeSessionPath: safeRelative(value.resumeSessionPath, "resume session path") }),
    unixSocketPaths: unixSocketPaths.map((item) => safeRelative(item, "Unix socket path")),
  };
}

function parseBootstrap(value: unknown): RuntimeBootstrapEnvelope {
  if (!isRecord(value) || value.version !== 1 || typeof value.nonce !== "string" || !value.nonce) {
    throw new Error("Invalid Runtime launch.bootstrap payload");
  }
  if (
    !Array.isArray(value.providers) ||
    !Array.isArray(value.mcp) ||
    !Array.isArray(value.authorizedRoots) ||
    !Array.isArray(value.managedSkills) ||
    !isRecord(value.taskPolicy)
  ) {
    throw new Error("Invalid Runtime bootstrap authority");
  }
  if (
    !value.authorizedRoots.every(
      (item) =>
        isRecord(item) &&
        typeof item.relativePath === "string" &&
        (item.access === "read" || item.access === "write"),
    )
  ) {
    throw new Error("Invalid Runtime authorized root");
  }
  if (
    !value.managedSkills.every((item) => isRecord(item) && typeof item.relativePath === "string")
  ) {
    throw new Error("Invalid Runtime managed Skill");
  }
  const taskPolicy = value.taskPolicy;
  const depth = taskPolicy.depth;
  const maxDepth = taskPolicy.maxDepth;
  const maxParallel = taskPolicy.maxParallel;
  if (
    typeof depth !== "number" ||
    typeof maxDepth !== "number" ||
    typeof maxParallel !== "number" ||
    !Number.isSafeInteger(depth) ||
    !Number.isSafeInteger(maxDepth) ||
    !Number.isSafeInteger(maxParallel)
  ) {
    throw new Error("Invalid Runtime task policy");
  }
  const task: RuntimeBootstrapEnvelope["taskPolicy"] = {
    depth,
    maxDepth,
    maxParallel,
    ...(typeof taskPolicy.readOnly === "boolean" ? { readOnly: taskPolicy.readOnly } : {}),
    ...(typeof taskPolicy.brokerSocketRelative === "string"
      ? { brokerSocketRelative: taskPolicy.brokerSocketRelative }
      : {}),
    ...(typeof taskPolicy.capability === "string" ? { capability: taskPolicy.capability } : {}),
  };
  return {
    version: 1,
    nonce: value.nonce,
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
    providers: value.providers as ProviderBootstrap[],
    mcp: value.mcp as McpBootstrap[],
    authorizedRoots: value.authorizedRoots.map((item) => ({
      relativePath: safeRelative((item as Record<string, unknown>).relativePath, "authorized root"),
      access: (item as Record<string, unknown>).access as "read" | "write",
    })),
    managedSkills: value.managedSkills.map((item) => ({
      relativePath: safeRelative((item as Record<string, unknown>).relativePath, "managed Skill"),
      ...(typeof (item as Record<string, unknown>).name === "string"
        ? { name: String((item as Record<string, unknown>).name) }
        : {}),
      ...(typeof (item as Record<string, unknown>).sha256 === "string"
        ? { sha256: String((item as Record<string, unknown>).sha256) }
        : {}),
    })),
    taskPolicy: task,
    ...(isRecord(value.productTools) && typeof value.productTools.userSpaceCapability === "string"
      ? { productTools: { userSpaceCapability: value.productTools.userSpaceCapability } }
      : {}),
    ...(isRecord(value.mcpBroker) &&
    typeof value.mcpBroker.socketRelative === "string" &&
    typeof value.mcpBroker.capability === "string"
      ? {
          mcpBroker: {
            socketRelative: safeRelative(value.mcpBroker.socketRelative, "MCP broker socket"),
            capability: value.mcpBroker.capability,
          },
        }
      : {}),
  };
}

function buildBootstrap(
  dataRoot: string,
  scope: RuntimeScope,
  layout: PiSessionLayout,
  prepared: RuntimeLaunchPreparePayload,
  envelope: RuntimeBootstrapEnvelope,
): PiBootstrapPayload {
  const tenantRoot = expectedTenantRoot(dataRoot, scope);
  const knowledgeRoot = join(tenantRoot, "knowledge");
  const sessionRoot = layout.sessionRoot;
  const authorizedRoots = envelope.authorizedRoots.map((root) => {
    const target = resolve(dataRoot, root.relativePath);
    const canonical = assertRealChild(dataRoot, target, "Bootstrap root");
    if (canonical !== layout.workspaceDir && !isPathInside(knowledgeRoot, canonical)) {
      throw new Error("Bootstrap root escaped the tenant authority");
    }
    if (prepared.mode === "agent" && canonical === layout.workspaceDir && root.access !== "write") {
      throw new Error("Agent workspace authority must be writable");
    }
    return { path: canonical, access: root.access };
  });
  const cwdRoot = authorizedRoots.find((root) => root.path === layout.workspaceDir);
  if (!cwdRoot) throw new Error("Runtime bootstrap must authorize this session workspace");
  const managedSkills = envelope.managedSkills.map((skill) => {
    const target = assertRealChild(
      layout.managedSkillsDir,
      resolve(layout.managedSkillsDir, skill.relativePath),
      "Managed Skill",
    );
    if (!existsSync(join(target, "SKILL.md"))) throw new Error("Managed Skill is missing SKILL.md");
    return {
      path: target,
      ...(skill.name ? { name: skill.name } : {}),
      ...(skill.sha256 ? { sha256: skill.sha256 } : {}),
    };
  });
  const taskPolicy: TaskPolicy = {
    depth: envelope.taskPolicy.depth,
    maxDepth: envelope.taskPolicy.maxDepth,
    maxParallel: envelope.taskPolicy.maxParallel,
    ...(envelope.taskPolicy.readOnly === undefined
      ? {}
      : { readOnly: envelope.taskPolicy.readOnly }),
    ...(envelope.taskPolicy.capability ? { capability: envelope.taskPolicy.capability } : {}),
    ...(envelope.taskPolicy.brokerSocketRelative
      ? {
          brokerSocket: assertSocket(
            dataRoot,
            sessionRoot,
            envelope.taskPolicy.brokerSocketRelative,
          ),
        }
      : {}),
  };
  const bootstrap: PiBootstrapPayload = {
    version: 1,
    sessionId: scope.sessionId,
    generation: scope.generation,
    authorizedRoots,
    mode: prepared.mode,
    ...(envelope.instructions ? { instructions: envelope.instructions } : {}),
    providers: envelope.providers,
    managedSkills,
    mcp: envelope.mcp,
    taskPolicy,
    ...(envelope.productTools ? { productTools: envelope.productTools } : {}),
    ...(envelope.mcpBroker
      ? {
          mcpBroker: {
            socketPath: assertSocket(dataRoot, sessionRoot, envelope.mcpBroker.socketRelative),
            capability: envelope.mcpBroker.capability,
          },
        }
      : {}),
  };
  if (!isPiBootstrapPayload(bootstrap))
    throw new Error("Runtime bootstrap failed Pi schema validation");
  return bootstrap;
}

function sessionRelativePath(dataRoot: string, target: string): string {
  const rel = relative(dataRoot, target).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === "..")
    throw new Error("Runtime path escaped data root");
  return rel;
}

function sameRuntimeScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.membershipId === right.membershipId &&
    left.orgNodeId === right.orgNodeId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation
  );
}

export class PiRuntimeService {
  private readonly launcher: PiLauncher;
  private readonly prepared = new Map<string, PreparedLaunch>();
  private readonly active = new Map<string, ActiveLaunch>();
  private readonly dataRoot: string;

  constructor(private readonly options: PiRuntimeServiceOptions) {
    this.dataRoot = realpathSync(resolve(options.dataRoot));
    if (!existsSync(options.trustedExtensionPath))
      throw new Error("Runtime trusted Pi extension is unavailable");
    this.launcher = options.launcher || new PiLauncher();
  }

  handler(): RuntimeControlHandler {
    return (request, connection) => this.handle(request, connection);
  }

  async shutdown(): Promise<void> {
    await this.launcher.killAll();
  }

  private async handle(
    request: RuntimeRequestFrame,
    connection: RuntimeControlConnection,
  ): Promise<unknown> {
    switch (request.operation) {
      case "launch.prepare":
        return this.prepare(request.scope, request.payload, connection);
      case "launch.bootstrap":
        return this.bootstrap(request.scope, request.payload, connection);
      case "request":
        return this.request(request.scope, request.payload);
      case "interrupt":
        return this.interrupt(request.scope);
      case "kill":
        return { killed: await this.kill(request.scope) };
      case "status":
        return this.status(request.scope);
      case "shutdown":
        await this.shutdown();
        return { stopped: true };
    }
  }

  private prepare(
    scope: RuntimeScope,
    value: unknown,
    connection: RuntimeControlConnection,
  ): { nonce: string; generation: number; sessionRoot: string } {
    assertRuntimeScope(scope);
    const payload = parsePrepare(value);
    if (this.active.has(scope.sessionId)) throw new Error("Runtime session is already active");
    const existing = this.prepared.get(scope.sessionId);
    if (existing && !sameRuntimeScope(existing.scope, scope)) {
      throw new Error("Runtime session preparation scope is already reserved");
    }
    const sessionRoot = expectedSessionRoot(this.dataRoot, scope);
    const layout = preparePiSessionLayout(sessionRoot);
    for (const path of payload.managedSkillPaths) {
      const candidate = resolve(layout.sessionRoot, path);
      assertRealChild(layout.managedSkillsDir, candidate, "Managed Skill");
    }
    for (const path of payload.unixSocketPaths) assertSocket(this.dataRoot, sessionRoot, path);
    const nonce = randomBytes(32).toString("base64url");
    this.prepared.set(scope.sessionId, { scope, payload, nonce, connection });
    return {
      nonce,
      generation: scope.generation,
      sessionRoot: sessionRelativePath(this.dataRoot, sessionRoot),
    };
  }

  private async bootstrap(
    scope: RuntimeScope,
    value: unknown,
    connection: RuntimeControlConnection,
  ): Promise<PiSessionInfo> {
    const prepared = this.prepared.get(scope.sessionId);
    if (!prepared || !sameRuntimeScope(prepared.scope, scope)) {
      throw new Error("Runtime launch preparation scope is stale");
    }
    const envelope = parseBootstrap(value);
    if (envelope.nonce !== prepared.nonce) throw new Error("Runtime launch nonce mismatch");
    this.prepared.delete(scope.sessionId);
    const layout = preparePiSessionLayout(expectedSessionRoot(this.dataRoot, scope));
    const socketPaths = prepared.payload.unixSocketPaths.map((path) =>
      assertSocket(this.dataRoot, layout.sessionRoot, path),
    );
    const bootstrapPayload = buildBootstrap(
      this.dataRoot,
      scope,
      layout,
      prepared.payload,
      envelope,
    );
    const knowledgeDirs = bootstrapPayload.authorizedRoots
      .filter((root) => root.access === "read" && root.path !== layout.workspaceDir)
      .map((root) => root.path);
    const managedSkillPaths = bootstrapPayload.managedSkills.map((skill) => skill.path);
    const managedResourcesDir = layout.piResourcesDir;
    const sessionBinDir = join(managedResourcesDir, "bin");
    const sandbox = compileSrtPolicy({
      tenantsRoot: this.dataRoot,
      tenantRoot: expectedTenantRoot(this.dataRoot, scope),
      sessionRoot: layout.sessionRoot,
      workspaceDir: layout.workspaceDir,
      homeDir: layout.homeDir,
      tmpDir: layout.tmpDir,
      piConfigDir: layout.piRuntimeConfigDir,
      piSessionsDir: layout.piSessionsDir,
      deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
      managedReadPaths: existsSync(managedResourcesDir) ? [managedResourcesDir] : [],
      knowledgeDirs,
      runtimeReadPaths: [this.options.trustedExtensionPath],
      unixSocketPaths: [
        ...socketPaths,
        ...(bootstrapPayload.mcpBroker ? [bootstrapPayload.mcpBroker.socketPath] : []),
        ...(bootstrapPayload.taskPolicy.brokerSocket
          ? [bootstrapPayload.taskPolicy.brokerSocket]
          : []),
      ],
      requiredInternalDomains: [],
      domainLayers: [prepared.payload.network],
      executionMode: this.options.executionMode,
    });
    const options: PiLaunchOptions = {
      sessionId: scope.sessionId,
      runtimeScope: scope,
      runtimeMode: this.options.executionMode,
      sessionRoot: layout.sessionRoot,
      workingDirectory: layout.workspaceDir,
      trustedExtensionPath: this.options.trustedExtensionPath,
      managedSkillPaths,
      bootstrapPayload,
      sandbox: {
        settings: sandbox,
        managedResourcesDir,
        ...(existsSync(sessionBinDir) ? { sessionBinDir } : {}),
      },
      model: prepared.payload.model,
      thinkingLevel: prepared.payload.thinkingLevel,
      mode: prepared.payload.mode,
      ...(prepared.payload.resumeSessionPath
        ? {
            resumeSessionFile: assertRealChild(
              layout.piSessionsDir,
              resolve(layout.sessionRoot, prepared.payload.resumeSessionPath),
              "Resume session",
            ),
          }
        : {}),
      onNotification: (notification) => {
        void connection.sendEvent("pi.notification", scope, notification).catch(() => undefined);
      },
      onExit: (info) => {
        this.active.delete(scope.sessionId);
        void connection.sendEvent("lifecycle", scope, info).catch(() => undefined);
      },
    };
    const info = await this.launcher.launch(options);
    this.active.set(scope.sessionId, { scope, connection });
    return info;
  }

  private transport(scope: RuntimeScope) {
    const active = this.active.get(scope.sessionId);
    if (!active || !sameRuntimeScope(active.scope, scope))
      throw new Error("Runtime session scope is stale");
    const transport = this.launcher.getTransport(scope.sessionId);
    if (!transport || !this.launcher.validateLaunchGeneration(scope.sessionId, scope.generation)) {
      throw new Error("Runtime Pi transport is unavailable");
    }
    return transport;
  }

  private async request(scope: RuntimeScope, value: unknown): Promise<unknown> {
    if (!isRecord(value) || !("input" in value))
      throw new Error("Runtime request input is required");
    const input = value.input as PiRpcInput;
    const awaitResponse = value.awaitResponse === true;
    serializePiRpcInput(input);
    const transport = this.transport(scope);
    if (isPiRpcCommand(input) && awaitResponse) {
      const response = await transport.request(input);
      return response;
    }
    await transport.sendInput(input);
    return { accepted: true };
  }

  private async interrupt(scope: RuntimeScope): Promise<{ interrupted: boolean }> {
    const transport = this.transport(scope);
    await transport.abort();
    return { interrupted: true };
  }

  private async kill(scope: RuntimeScope): Promise<boolean> {
    const active = this.active.get(scope.sessionId);
    if (!active) return true;
    if (!sameRuntimeScope(active.scope, scope)) throw new Error("Runtime kill scope is stale");
    const result = await this.launcher.kill(scope.sessionId);
    this.active.delete(scope.sessionId);
    return result;
  }

  private status(scope: RuntimeScope): { session?: PiSessionInfo; alive: boolean } {
    const active = this.active.get(scope.sessionId);
    if (active && !sameRuntimeScope(active.scope, scope))
      throw new Error("Runtime status scope is stale");
    return {
      session: this.launcher.getSession(scope.sessionId),
      alive: this.launcher.isAlive(scope.sessionId),
    };
  }
}
