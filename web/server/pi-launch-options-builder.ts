import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiModelRef, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import type { ControlPlaneService } from "./control-plane-service.js";
import { ENV, environment } from "./environment.js";
import { getLocalDataRoot, resolveTenantKnowledgePath } from "./local-paths.js";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import {
  normalizedDomain,
  piModelCandidateFromRpc,
  providerHost,
  resolveEffectiveModelNetworkPolicy,
} from "./pi-launch-policy.js";
import type { PiLaunchOptions } from "./pi-launcher.js";
import { PiLauncher } from "./pi-launcher.js";
import {
  PiModelProbeCache,
  resolvePiModelPolicy,
  type PiAgentModelPolicy,
  type PiModelCandidate,
} from "./pi-model-policy.js";
import { providerSensitiveValues } from "./pi-provider-secrets.js";
import { PiProviderVault } from "./pi-provider-vault.js";
import type { PiRuntimeObserver } from "./pi-runtime-observer.js";
import { PiRuntimeBrokers, type PiTaskBrokerHandler } from "./pi-runtime-brokers.js";
import { nativeHelperService, type NativeFileAction } from "./native-helper.js";
import { readScopedFileSnapshotNoFollow, resolveScopedPath } from "./path-policy.js";
import { requirePiRuntimeLayout } from "./pi-runtime-layout.js";
import {
  readPiSessionDocument,
  restoredPiSessionState,
  type RestoredPiSessionState,
} from "./pi-session-history.js";
import { PiSessionPreparer } from "./pi-session-preparer.js";
import { PiTaskManager } from "./pi-task-manager.js";
import { preparePiSessionLayout } from "./pi-session-layout.js";
import { compileSrtPolicy } from "./srt-policy.js";
import type { ResolvedPiSandbox, SessionLaunchContext } from "./session-orchestrator-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRUSTED_EXTENSION_PATH = join(__dirname, "pi-trusted-extension.ts");
const DEFAULT_PLATFORM_MODEL_ALLOWLIST = ["*/*"];
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const SENSITIVE_TOOL_ENV_KEY = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i;

export interface ProtectedInternalTransport {
  unixSocketPath?: string;
  tls?: {
    baseUrl: string;
    certificatePath: string;
    proxyUrl: string;
  };
}

export interface PiLaunchOptionsBuilderOptions {
  dataRoot?: string;
  tenantRoot: string;
  sessionDirFor(sessionId: string): string;
  migratedUserSkillsRoot?: string;
  internalTransport: ProtectedInternalTransport;
  providerVault: PiProviderVault;
  issueUserSpaceCapability(sessionId: string): string;
  nativeHelperOwnerKey?: string;
  controlPlane?: ControlPlaneService;
  onTaskEvent?: (sessionId: string, event: Record<string, unknown>) => void;
  deliverTaskResult?: (parentSessionId: string, message: string) => Promise<void>;
  handleApp?: (
    request: Parameters<PiTaskBrokerHandler>[0],
    context: Parameters<PiTaskBrokerHandler>[1],
    scope: {
      sessionId: string;
      generation: number;
      sessionRoot: string;
      workspaceDir: string;
    },
  ) => Promise<unknown>;
  runtimeObserverForSession?: (options: {
    recordingSessionId: string;
    cwd: string;
  }) => PiRuntimeObserver;
  registerRecordingSensitiveValues?: (
    recordingSessionId: string,
    values: readonly string[],
  ) => void;
}

function sameModel(left: PiModelRef, right: PiModelRef): boolean {
  return (
    left.key === right.key && left.provider === right.provider && left.modelId === right.modelId
  );
}

function defaultSandbox(): ResolvedPiSandbox {
  return {
    instructions: "",
    knowledgeRelativePaths: [],
    domainLayer: null,
    skillFiles: [],
    modelPolicy: {
      modelAllowlist: DEFAULT_PLATFORM_MODEL_ALLOWLIST,
      defaultThinkingLevel: DEFAULT_THINKING_LEVEL,
    },
    managedMcpServers: [],
  };
}

/**
 * Materializes all launch authority immediately before a generation starts.
 * Nothing credential-shaped is returned in argv, child environment, or the
 * durable session authority file.
 */
export class PiLaunchOptionsBuilder {
  private readonly options: PiLaunchOptionsBuilderOptions;
  private readonly dataRoot: string;
  private readonly preparer = new PiSessionPreparer();
  private readonly brokers = new Map<string, PiRuntimeBrokers>();
  private readonly taskManagers = new Map<string, PiTaskManager>();
  private readonly effectiveModels = new Map<string, PiModelCandidate[]>();
  private readonly modelProbes: PiModelProbeCache;

  constructor(options: PiLaunchOptionsBuilderOptions) {
    this.options = options;
    this.dataRoot = options.dataRoot ?? getLocalDataRoot();
    this.modelProbes = new PiModelProbeCache({
      ttlMs: 15_000,
      probe: (agentId, signal) => this.runModelProbe(agentId, signal),
    });
  }

  private async resolveSandbox(context: SessionLaunchContext): Promise<ResolvedPiSandbox> {
    if (context.request.resolvedSandbox) return context.request.resolvedSandbox;
    const authority = context.persisted?.authority;
    if (!authority) return defaultSandbox();
    if (!this.options.controlPlane) {
      throw new Error("Pinned Pi Agent authority cannot be resolved");
    }
    const resolved = await this.options.controlPlane.resolvePinnedSessionAuthority(authority);
    return resolved.launch;
  }

  private async restore(
    sessionId: string,
    context: SessionLaunchContext,
  ): Promise<RestoredPiSessionState> {
    const relativePath = context.persisted?.piSessionRelativePath;
    if (!relativePath) return {};
    const sessionDir = this.options.sessionDirFor(sessionId);
    const document = await readPiSessionDocument({
      sessionDir,
      piSessionRelativePath: relativePath,
      expectedPiSessionId: sessionId,
      expectedCwd: join(sessionDir, "workspace"),
    });
    return restoredPiSessionState(document.entries);
  }

  private async resolveCandidates(
    candidates: readonly PiModelCandidate[],
    sandbox: ResolvedPiSandbox,
  ) {
    const providers = this.options.providerVault.snapshot();
    const platformAllowlist =
      environment.list(ENV.PIWORK_PI_MODEL_ALLOWLIST).length > 0
        ? environment.list(ENV.PIWORK_PI_MODEL_ALLOWLIST)
        : DEFAULT_PLATFORM_MODEL_ALLOWLIST;
    const network = resolveEffectiveModelNetworkPolicy(
      providers,
      environment.list(ENV.PIWORK_SRT_ALLOWED_DOMAINS),
      sandbox.domainLayer,
    );
    const agentPolicy: PiAgentModelPolicy = {
      modelAllowlist: [...sandbox.modelPolicy.modelAllowlist],
      ...(sandbox.modelPolicy.defaultModel
        ? { defaultModel: { ...sandbox.modelPolicy.defaultModel } }
        : {}),
      defaultThinkingLevel: sandbox.modelPolicy.defaultThinkingLevel,
    };
    const resolved = await resolvePiModelPolicy({
      candidates,
      platformAllowlist,
      agentPolicy,
      hasCredential: this.options.providerVault.credentialProviders(),
      networkAllows: (candidate) => {
        const host = providerHost(candidate.provider, providers, candidate.modelId);
        const domain = host ? normalizedDomain(host) : "";
        return (
          Boolean(domain) &&
          network.allowedDomains.has(domain) &&
          !network.deniedDomains.has(domain)
        );
      },
    });
    return resolved;
  }

  private async selectModel(
    requested: PiModelRef | undefined,
    sandbox: ResolvedPiSandbox,
  ): Promise<{
    model: PiModelRef;
    thinkingLevel: ThinkingLevel;
    candidates: PiModelCandidate[];
  }> {
    const resolved = await this.resolveCandidates(
      this.options.providerVault.modelCandidates(),
      sandbox,
    );
    const model = requested ?? resolved.defaultModel ?? resolved.models[0];
    if (!model || !resolved.models.some((candidate) => sameModel(candidate, model))) {
      throw new Error("Requested Pi model is not effective under current policy");
    }
    return {
      model,
      thinkingLevel: resolved.defaultThinkingLevel,
      candidates: resolved.models,
    };
  }

  async build(
    sessionId: string,
    generation: number,
    context: SessionLaunchContext,
  ): Promise<PiLaunchOptions> {
    requirePiRuntimeLayout(this.dataRoot);
    if (!existsSync(TRUSTED_EXTENSION_PATH)) {
      throw new Error("Piwork trusted Pi extension is unavailable");
    }
    const sessionRoot = this.options.sessionDirFor(sessionId);
    const authority = context.persisted?.authority;
    const runtimeScope = authority
      ? {
          tenantId: authority.tenantId,
          userId: authority.userId,
          membershipId: authority.membershipId,
          orgNodeId: authority.orgNodeId,
          sessionId,
          generation,
        }
      : undefined;
    if (environment.runtimeMode === "compose" && !runtimeScope) {
      throw new Error("Compose Pi Runtime requires a tenant-scoped Agent authority");
    }
    const sandbox = await this.resolveSandbox(context);
    const restored = await this.restore(sessionId, context);
    const mode = context.request.mode ?? restored.mode ?? "agent";
    const selected = await this.selectModel(context.request.model ?? restored.model, sandbox);
    const thinkingLevel =
      context.request.thinkingLevel ?? restored.thinkingLevel ?? selected.thinkingLevel;
    const knowledgeDirs = sandbox.knowledgeRelativePaths.map((path) => {
      const authority = context.persisted?.authority;
      if (!authority) throw new Error("Knowledge roots require pinned Agent authority");
      return resolveTenantKnowledgePath(authority.tenantId, path);
    });
    const providers = this.options.providerVault.snapshot();
    const network = resolveEffectiveModelNetworkPolicy(
      providers,
      environment.list(ENV.PIWORK_SRT_ALLOWED_DOMAINS),
      sandbox.domainLayer,
    );
    const domainLayers = [
      {
        allowedDomains: network.platformDomains,
        deniedDomains: [],
      },
      ...(sandbox.domainLayer ? [sandbox.domainLayer] : []),
    ];
    const prepared = this.preparer.prepare({
      sessionRoot,
      sessionId,
      mode,
      dataRoot: this.dataRoot,
      tenantRoot: this.options.tenantRoot,
      knowledgeDirs,
      domainLayers,
      runtimeReadPaths: [TRUSTED_EXTENSION_PATH],
      internalSocketPath: this.options.internalTransport.unixSocketPath,
      internalTlsTransport: this.options.internalTransport.tls,
      issueUserSpaceCapability: this.options.issueUserSpaceCapability,
      managedSkillFiles: sandbox.skillFiles,
      migratedUserSkillsRoot: this.options.migratedUserSkillsRoot,
    });

    await this.taskManagers.get(sessionId)?.dispose();
    this.taskManagers.delete(sessionId);
    await this.brokers.get(sessionId)?.dispose();
    let taskManager: PiTaskManager | undefined;
    const runtimeBrokers = new PiRuntimeBrokers({
      runtimeDir: join(this.dataRoot, ".runtime"),
      sessionId,
      generation,
      mode,
      managedMcpServers: sandbox.managedMcpServers,
      authorizeRemoteUrl: (url) => {
        const domain = normalizedDomain(url.hostname);
        if (
          url.protocol !== "https:" ||
          !network.allowedDomains.has(domain) ||
          network.deniedDomains.has(domain)
        ) {
          throw new Error("Managed MCP remote URL is denied by network policy");
        }
      },
      authorizeStdio: (config) => {
        if (!config.command.startsWith("/")) {
          throw new Error("Managed MCP stdio command must be an absolute approved path");
        }
      },
      handleTask: (request, brokerContext) =>
        taskManager
          ? taskManager.handle(request, brokerContext)
          : Promise.reject(new Error("Managed task runtime is not ready")),
      handleApp: this.options.handleApp
        ? (request, brokerContext) =>
            this.options.handleApp!(request, brokerContext, {
              sessionId,
              generation,
              sessionRoot,
              workspaceDir: prepared.layout.workspaceDir,
            })
        : undefined,
      handleNativeFile: async (request) => {
        const payload =
          request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
            ? (request.payload as Record<string, unknown>)
            : {};
        const action = typeof payload.action === "string" ? payload.action : "";
        const path = typeof payload.path === "string" ? payload.path.trim() : "";
        if (
          ![
            "file.quickLook",
            "file.open",
            "file.openWith",
            "file.print",
            "file.saveAs",
            "file.revealExport",
            "file.share",
            "file.nativeEdit",
          ].includes(action) ||
          !path ||
          path.includes("\0")
        ) {
          throw new Error("Native file action payload is invalid");
        }
        const workspaceRoot = prepared.layout.workspaceDir;
        const target = resolveScopedPath(resolve(workspaceRoot, path), [workspaceRoot]);
        if (!target) throw new Error("Native file path is outside Agent Space");
        const snapshot = await readScopedFileSnapshotNoFollow(target, [workspaceRoot], {
          maxBytes: 100 * 1024 * 1024,
        });
        const operation = await nativeHelperService.createFileAction({
          ownerKey: this.options.nativeHelperOwnerKey || "local-user",
          sessionId,
          action: action as NativeFileAction,
          bytes: snapshot.bytes,
          filename: basename(target),
          source: {
            space: "agent",
            path: relative(workspaceRoot, target).split(sep).join("/"),
            baselineMtime: snapshot.mtimeMs,
          },
        });
        return {
          operationId: operation.id,
          action: operation.action,
          state: operation.state,
        };
      },
      onModeChange: (nextMode) => taskManager?.setRootMode(nextMode),
    });
    await runtimeBrokers.start();
    const runtimeObserver = this.options.runtimeObserverForSession?.({
      recordingSessionId: sessionId,
      cwd: prepared.layout.workspaceDir,
    });
    this.options.registerRecordingSensitiveValues?.(sessionId, [
      ...providerSensitiveValues(providers),
      ...runtimeBrokers.sensitiveValuesForRedaction(),
      runtimeBrokers.capability,
      prepared.userSpaceCapability,
      ...Object.entries(prepared.toolEnvironment ?? {}).flatMap(([key, value]) =>
        SENSITIVE_TOOL_ENV_KEY.test(key) ? [value] : [],
      ),
    ]);
    // MCP discovery must complete before any child bootstrap is created.
    taskManager = new PiTaskManager({
      rootSessionId: sessionId,
      rootGeneration: generation,
      rootSessionRoot: sessionRoot,
      rootWorkspaceDir: prepared.layout.workspaceDir,
      rootMode: mode,
      rootModel: selected.model,
      thinkingLevel,
      trustedExtensionPath: TRUSTED_EXTENSION_PATH,
      managedSkillPaths: prepared.managedSkillPaths,
      managedSkills: prepared.managedSkills,
      providers,
      mcp: runtimeBrokers.mcpState(),
      sandboxSettings: prepared.sandboxSettings,
      sharedReadOnlyPaths: prepared.taskReadOnlyPaths,
      userSpaceCapability: prepared.userSpaceCapability,
      toolEnvironment: prepared.toolEnvironment,
      managedResourcesDir: prepared.layout.piResourcesDir,
      sessionBinDir: prepared.sessionBinDir,
      brokers: runtimeBrokers,
      runtimeObserver,
      registerRecordingSensitiveValues: (values) =>
        this.options.registerRecordingSensitiveValues?.(sessionId, values),
      onTaskEvent: (event) => this.options.onTaskEvent?.(sessionId, event),
      deliverTaskResult: this.options.deliverTaskResult,
    });
    this.brokers.set(sessionId, runtimeBrokers);
    this.taskManagers.set(sessionId, taskManager);
    this.effectiveModels.set(
      sessionId,
      selected.candidates.map((candidate) => ({ ...candidate })),
    );
    const taskEndpoint = runtimeBrokers.taskEndpoint();
    const mcpEndpoint = runtimeBrokers.mcpEndpoint();
    const bootstrapPayload: PiBootstrapPayload = {
      version: 1,
      sessionId,
      generation,
      authorizedRoots: [
        {
          path: prepared.layout.workspaceDir,
          // The trusted extension owns the dynamic Agent/Plan boundary. Keep
          // the root capability writable so an explicitly confirmed
          // Plan -> Agent transition can enable native write/edit without
          // respawning Pi; Plan mode still hides and rejects every mutation.
          access: "write",
        },
        ...knowledgeDirs.map((path) => ({ path, access: "read" as const })),
      ],
      mode,
      instructions: sandbox.instructions,
      providers,
      managedSkills: prepared.managedSkills,
      mcp: runtimeBrokers.mcpState(),
      taskPolicy: {
        depth: 0,
        maxDepth: 2,
        maxParallel: 4,
        ...(taskEndpoint ?? {}),
      },
      productTools: {
        userSpaceCapability: prepared.userSpaceCapability,
      },
      ...(mcpEndpoint ? { mcpBroker: mcpEndpoint } : {}),
    };
    return {
      sessionId,
      ...(runtimeScope ? { runtimeScope } : {}),
      ...(environment.runtimeMode === "compose" ? { runtimeMode: "compose-nested" as const } : {}),
      sessionRoot,
      workingDirectory: prepared.layout.workspaceDir,
      trustedExtensionPath: TRUSTED_EXTENSION_PATH,
      managedSkillPaths: prepared.managedSkillPaths,
      bootstrapPayload,
      sandbox: {
        settings: prepared.sandboxSettings,
        toolEnvironment: prepared.toolEnvironment,
        managedResourcesDir: prepared.layout.piResourcesDir,
        sessionBinDir: prepared.sessionBinDir,
      },
      model: selected.model,
      thinkingLevel,
      mode,
      observer: runtimeObserver,
      ...(context.persisted?.piSessionRelativePath
        ? {
            resumeSessionFile: join(sessionRoot, context.persisted.piSessionRelativePath),
          }
        : {}),
      onExit: () => {
        if (this.brokers.get(sessionId) !== runtimeBrokers) return;
        this.brokers.delete(sessionId);
        this.effectiveModels.delete(sessionId);
        const tasks = this.taskManagers.get(sessionId);
        this.taskManagers.delete(sessionId);
        void tasks?.dispose();
        void runtimeBrokers.dispose();
      },
    };
  }

  async probeModels(
    agentId: string,
    sandbox: ResolvedPiSandbox,
    signal?: AbortSignal,
  ): Promise<{
    models: PiModelCandidate[];
    defaultModel: PiModelRef;
    defaultThinkingLevel: ThinkingLevel;
  }> {
    const probed = await this.modelProbes.get(agentId, signal);
    const resolved = await this.resolveCandidates(probed, sandbox);
    const model = resolved.defaultModel ?? resolved.models[0];
    if (!model) throw new Error("No effective Pi model is available");
    return {
      models: resolved.models,
      defaultModel: model,
      defaultThinkingLevel: resolved.defaultThinkingLevel,
    };
  }

  private async runModelProbe(_agentId: string, signal?: AbortSignal): Promise<PiModelCandidate[]> {
    requirePiRuntimeLayout(this.dataRoot);
    const probeId = randomUUID();
    const probeParent = join(this.options.tenantRoot, ".pi-model-probes");
    const sessionRoot = join(probeParent, probeId);
    const layout = preparePiSessionLayout(sessionRoot);
    const providers = this.options.providerVault.snapshot();
    const network = resolveEffectiveModelNetworkPolicy(
      providers,
      environment.list(ENV.PIWORK_SRT_ALLOWED_DOMAINS),
      null,
    );
    const sandbox = compileSrtPolicy({
      tenantsRoot: this.dataRoot,
      tenantRoot: this.options.tenantRoot,
      sessionRoot: layout.sessionRoot,
      workspaceDir: layout.workspaceDir,
      homeDir: layout.homeDir,
      tmpDir: layout.tmpDir,
      piConfigDir: layout.piRuntimeConfigDir,
      piSessionsDir: layout.piSessionsDir,
      deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
      knowledgeDirs: [],
      runtimeReadPaths: [TRUSTED_EXTENSION_PATH],
      unixSocketPaths: [],
      requiredInternalDomains: [],
      domainLayers: [
        {
          allowedDomains: network.platformDomains,
          deniedDomains: [],
        },
      ],
    });
    const launcher = new PiLauncher();
    try {
      const info = await launcher.launch({
        sessionId: probeId,
        sessionRoot,
        trustedExtensionPath: TRUSTED_EXTENSION_PATH,
        managedSkillPaths: [],
        bootstrapPayload: {
          version: 1,
          sessionId: probeId,
          generation: 1,
          authorizedRoots: [{ path: layout.workspaceDir, access: "read" }],
          mode: "plan",
          instructions: "Controlled model inventory probe. Do not run tools.",
          providers,
          managedSkills: [],
          mcp: [],
          taskPolicy: {
            depth: 0,
            maxDepth: 0,
            maxParallel: 1,
            readOnly: true,
          },
        },
        sandbox: { settings: sandbox },
        mode: "plan",
        readyTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
      });
      const transport = launcher.getTransport(info.sessionId);
      if (!transport) throw new Error("Controlled Pi model probe lost its transport");
      const models = await transport.getAvailableModels({
        signal,
        timeoutMs: 10_000,
      });
      return models.map(piModelCandidateFromRpc);
    } finally {
      await launcher.killAll().catch(() => undefined);
      const parent = resolve(probeParent);
      const candidate = resolve(sessionRoot);
      const rel = relative(parent, candidate);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && existsSync(candidate)) {
        rmSync(candidate, { recursive: true, force: true });
      }
    }
  }

  mcpDetails(sessionId: string) {
    return this.brokers.get(sessionId)?.details() ?? [];
  }

  async setMcpEnabled(sessionId: string, name: string, enabled: boolean): Promise<void> {
    const brokers = this.brokers.get(sessionId);
    if (!brokers) throw new Error("Pi runtime is not active");
    await brokers.setMcpEnabled(name, enabled);
  }

  async reconnectMcp(sessionId: string, name: string): Promise<void> {
    const brokers = this.brokers.get(sessionId);
    if (!brokers) throw new Error("Pi runtime is not active");
    await brokers.reconnectMcp(name);
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const tasks = this.taskManagers.get(sessionId);
    if (!tasks) throw new Error("Pi runtime is not active");
    await tasks.stopTask(taskId);
  }

  isModelEffective(sessionId: string, model: PiModelRef): boolean {
    return (
      this.effectiveModels.get(sessionId)?.some((candidate) => sameModel(candidate, model)) ?? false
    );
  }

  async dispose(): Promise<void> {
    const tasks = [...this.taskManagers.values()];
    this.taskManagers.clear();
    this.effectiveModels.clear();
    const active = [...this.brokers.values()];
    this.brokers.clear();
    await Promise.allSettled([
      ...tasks.map((manager) => manager.dispose()),
      ...active.map((brokers) => brokers.dispose()),
    ]);
    this.modelProbes.invalidate();
  }
}
