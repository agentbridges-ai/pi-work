import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiAgentSpace } from "./pi-agent-space.js";
import {
  buildPiAskReview,
  encodePiAskBatchTitle,
  parsePiAskBatchResponse,
  PI_ASK_BATCH_OPTION,
  PI_ASK_LIMITS,
} from "./pi-ask-interaction.js";
import {
  consumePiBootstrap,
  type PiAgentMode,
  type PiBootstrapPayload,
} from "./pi-bootstrap-channel.js";
import { requestPiBroker, type PiBrokerEndpoint } from "./pi-broker-client.js";
import { PiMcpManager } from "./pi-mcp-manager.js";
import { evaluatePiToolPolicy } from "./pi-plan-policy.js";
import { encodePiPlanRequestTitle, PI_PLAN_OPTIONS } from "./pi-plan-interaction.js";
import {
  createRedactingPiStreamSimple,
  escapePiConfigLiteral,
  providerSensitiveValues,
  redactPiSensitiveValue,
} from "./pi-provider-secrets.js";

export { managedMcpToolName } from "./pi-mcp-manager.js";

const EXTENSION_VERSION = 1;
const BOOTSTRAP_SOCKET_FLAG = "piwork-bootstrap-socket";
const SESSION_ID_FLAG = "piwork-session-id";
const GENERATION_FLAG = "piwork-generation";
const MODE_ENTRY = "piwork.mode";
const PLAN_ENTRY = "piwork.plan";
const TODO_ENTRY = "piwork.todo";
const STATUS_KEY = "piwork.extension";
const MAX_TODOS = 200;
const MAX_PLAN_REFINEMENT_BYTES = 100_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

interface ExtensionState {
  payload: PiBootstrapPayload;
  mode: PiAgentMode;
  agentSpace: PiAgentSpace;
  mcpManager: PiMcpManager;
  userSpaceCapability?: string;
  taskEndpoint?: PiBrokerEndpoint;
  mcpEndpoint?: PiBrokerEndpoint;
  sensitiveValues: string[];
  todos: TodoItem[];
}

export type PiPlanDecision =
  { decision: "execute" | "continue_planning" } | { decision: "refine"; refinement: string };

export function parsePiPlanDecision(value: unknown): PiPlanDecision | undefined {
  if (value === "execute" || value === "continue_planning") {
    return { decision: value };
  }
  if (typeof value !== "string" || value.length > MAX_PLAN_REFINEMENT_BYTES + 64) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => key !== "decision" && key !== "refinement")
    ) {
      return undefined;
    }
    const response = parsed as Record<string, unknown>;
    if (response.decision !== "refine" || !nonEmpty(response.refinement)) return undefined;
    const refinement = response.refinement.trim();
    if (Buffer.byteLength(refinement, "utf8") > MAX_PLAN_REFINEMENT_BYTES) return undefined;
    return { decision: "refine", refinement };
  } catch {
    return undefined;
  }
}

function textResult(text: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
  };
}

function failTool(message: string): never {
  throw new Error(message);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function integer(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Pi discovers extension flags before its final argument parse. Reading argv
 * here is therefore an intentional fallback for the three non-secret binding
 * values. Credentials and broker capabilities are never accepted via argv.
 */
export function readTrustedExtensionFlag(
  pi: Pick<ExtensionAPI, "getFlag">,
  name: string,
  argv: readonly string[] = process.argv.slice(2),
): string | undefined {
  const registered = pi.getFlag(name);
  if (typeof registered === "string" && registered.length > 0) return registered;
  let found: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    let candidate: string | undefined;
    if (token === `--${name}`) candidate = argv[index + 1];
    else if (token.startsWith(`--${name}=`)) candidate = token.slice(name.length + 3);
    if (candidate === undefined) continue;
    if (found !== undefined) throw new Error(`Duplicate --${name} binding.`);
    found = candidate;
  }
  return found;
}

export function scrubPiShellEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const unsafeRuntimeKeys = new Set([
    "BASH_ENV",
    "BASHOPTS",
    "BASH_XTRACEFD",
    "BUN_OPTIONS",
    "CDPATH",
    "ENV",
    "GLOBIGNORE",
    "IFS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PERL5OPT",
    "PROMPT_COMMAND",
    "PS4",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "RUBYOPT",
    "SHELLOPTS",
  ]);
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (
      unsafeRuntimeKeys.has(name) ||
      /^(?:BASH_FUNC_|DYLD_|LD_)/u.test(name) ||
      /(?:api[_-]?key|token|secret|password|credential|authorization|cookie)/iu.test(name)
    ) {
      continue;
    }
    output[name] = value;
  }
  return output;
}

/**
 * Capabilities are injected only for one literal managed CLI invocation.
 * Any shell composition, expansion, redirection, assignment, or ambiguous
 * quoting keeps the capability out of the spawned shell.
 */
export function isManagedProductCliCommand(command: string): boolean {
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    command.includes("\0") ||
    command.includes("\n") ||
    command.includes("\r")
  ) {
    return false;
  }
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  const pushToken = (): void => {
    if (token.length === 0) return;
    tokens.push(token);
    token = "";
  };
  for (const char of command) {
    if (char === "\\") {
      // Bash preserves backslashes literally inside single quotes. Supporting
      // that exact case keeps JSON strings usable without creating a parser
      // differential; all other backslash escaping stays fail-closed.
      if (quote === "'") {
        token += char;
        continue;
      }
      return false;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "`")) return false;
      token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }
    if (/[|&;<>\n\r$`()]/u.test(char)) return false;
    token += char;
  }
  if (quote) return false;
  pushToken();
  if (tokens[0] === "user-space") {
    return ["read", "write", "edit", "bash"].includes(tokens[1] ?? "");
  }
  if (tokens[0] === "onlyoffice") {
    return ["active", "op"].includes(tokens[1] ?? "");
  }
  return false;
}

export function buildPiShellEnvironment(
  command: string,
  environment: NodeJS.ProcessEnv | undefined,
  userSpaceCapability?: string,
): NodeJS.ProcessEnv {
  const output = scrubPiShellEnvironment(environment);
  if (userSpaceCapability && isManagedProductCliCommand(command)) {
    output.PIWORK_USER_SPACE_API_TOKEN = userSpaceCapability;
  }
  return output;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function restoreCustomState(
  entries: readonly unknown[],
  initialMode: PiAgentMode,
): { mode: PiAgentMode; todos: TodoItem[] } {
  let mode = initialMode;
  let todos: TodoItem[] = [];
  for (const item of entries) {
    const entry = record(item);
    if (entry.type !== "custom") continue;
    if (entry.customType === MODE_ENTRY) {
      const data = record(entry.data);
      if (data.mode === "agent" || data.mode === "plan") mode = data.mode;
    } else if (entry.customType === TODO_ENTRY) {
      const data = record(entry.data);
      if (Array.isArray(data.todos)) todos = data.todos as TodoItem[];
    }
  }
  return { mode, todos };
}

function publishStatus(ctx: ExtensionContext, state: ExtensionState): void {
  ctx.ui.setStatus(
    STATUS_KEY,
    JSON.stringify({
      version: EXTENSION_VERSION,
      mode: state.mode,
      mcp: state.mcpManager.snapshot().map(({ name, enabled, status }) => ({
        name,
        enabled,
        status,
      })),
    }),
  );
}

async function setMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  mode: PiAgentMode,
): Promise<void> {
  if (state.taskEndpoint) {
    await requestPiBroker({
      endpoint: state.taskEndpoint,
      sessionId: state.payload.sessionId,
      generation: state.payload.generation,
      operation: "mode.set",
      payload: { mode },
    });
  }
  state.mode = mode;
  pi.appendEntry(MODE_ENTRY, { version: 1, mode });
  applyActiveTools(state);
  publishStatus(ctx, state);
}

function applyActiveTools(state: ExtensionState): void {
  state.mcpManager.applyActiveTools(state.mode);
}

function registerNativeTools(pi: ExtensionAPI, state: ExtensionState, cwd: string): void {
  const localBash = createLocalBashOperations();
  const bashOperations = {
    exec: (
      command: string,
      requestedCwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ) =>
      localBash.exec(command, requestedCwd, {
        ...options,
        env: buildPiShellEnvironment(command, options.env, state.userSpaceCapability),
      }),
  };
  pi.registerTool(createReadToolDefinition(cwd, { operations: state.agentSpace.readOperations }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: state.agentSpace.writeOperations }));
  pi.registerTool(createEditToolDefinition(cwd, { operations: state.agentSpace.editOperations }));
  pi.registerTool(
    createBashToolDefinition(cwd, {
      operations: bashOperations,
      exposeSessionEnvironment: false,
    }),
  );
}

function registerAskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    label: "ask",
    description:
      "Ask the user one to four related questions in one interaction. Keep questions concise, provide two to four distinct options per question, and mark multiSelect only when multiple options may be combined.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({ minLength: 1, maxLength: 12 }),
          question: Type.String({ minLength: 1, maxLength: 4_096 }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ minLength: 1, maxLength: 1_024 }),
              description: Type.String({ minLength: 1, maxLength: 2_048 }),
            }),
            {
              minItems: 2,
              maxItems: PI_ASK_LIMITS.optionsPerQuestion,
            },
          ),
          multiSelect: Type.Boolean(),
        }),
        {
          minItems: 1,
          maxItems: PI_ASK_LIMITS.questions,
        },
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
    }),
    async execute(id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return failTool("Interactive RPC UI is unavailable.");
      const response = await ctx.ui.select(
        encodePiAskBatchTitle(id, params.questions),
        [PI_ASK_BATCH_OPTION],
        { signal, timeout: params.timeoutMs },
      );
      if (response === undefined) return textResult("cancelled", { cancelled: true });
      const answers = parsePiAskBatchResponse(response, params.questions);
      if (!answers) return failTool("The Ask response is invalid or incomplete.");
      const review = buildPiAskReview(params.questions, answers);
      return textResult(JSON.stringify(review), review);
    },
  });
}

function registerTodoTool(pi: ExtensionAPI, state: ExtensionState): void {
  pi.registerTool({
    name: "todo_write",
    label: "todo_write",
    description: "Replace the complete session todo list.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          id: Type.String({ minLength: 1, maxLength: 128 }),
          text: Type.String({ minLength: 1, maxLength: 4_096 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        }),
        { maxItems: MAX_TODOS },
      ),
    }),
    async execute(_id, params) {
      const ids = new Set<string>();
      for (const todo of params.todos) {
        if (ids.has(todo.id)) return failTool("Todo ids must be unique.");
        ids.add(todo.id);
      }
      state.todos = params.todos.map((todo) => ({ ...todo }));
      pi.appendEntry(TODO_ENTRY, { version: 1, todos: state.todos });
      return textResult(`Stored ${state.todos.length} todos.`, {
        todos: state.todos,
      });
    },
  });
}

function registerTaskTool(pi: ExtensionAPI, state: ExtensionState): void {
  pi.registerTool({
    name: "task",
    label: "task",
    description: "Start or stop an isolated managed Pi sub-agent.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      background: Type.Optional(Type.Boolean()),
      readOnly: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!state.taskEndpoint) return failTool("Managed task broker is unavailable.");
      if (params.action === "stop") {
        if (!nonEmpty(params.taskId)) {
          return failTool("taskId is required to stop a task.");
        }
        const value = await requestPiBroker({
          endpoint: state.taskEndpoint,
          sessionId: state.payload.sessionId,
          generation: state.payload.generation,
          operation: "task.stop",
          payload: { taskId: params.taskId },
          signal,
        });
        return textResult("Task stop requested.", value);
      }
      if (!nonEmpty(params.prompt)) {
        return failTool("prompt is required to start a task.");
      }
      if (state.payload.taskPolicy.depth >= state.payload.taskPolicy.maxDepth) {
        return failTool("Managed task depth limit reached.");
      }
      const readOnly =
        state.mode === "plan" || state.payload.taskPolicy.readOnly === true || params.readOnly;
      const value = await requestPiBroker({
        endpoint: state.taskEndpoint,
        sessionId: state.payload.sessionId,
        generation: state.payload.generation,
        operation: "task.start",
        payload: {
          originToolCallId: toolCallId,
          prompt: params.prompt,
          background: params.background === true,
          readOnly: readOnly === true,
          mode: state.mode,
          depth: state.payload.taskPolicy.depth + 1,
          maxDepth: state.payload.taskPolicy.maxDepth,
          maxParallel: state.payload.taskPolicy.maxParallel,
          model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
          skills: state.payload.managedSkills.map((skill) => ({
            path: skill.path,
            name: skill.name,
            sha256: skill.sha256,
          })),
          mcp: state.mcpManager
            .snapshot()
            .filter((server) => server.enabled)
            .map((server) => server.name),
        },
        signal,
        onProgress: (progress) =>
          onUpdate?.({
            content: [{ type: "text", text: JSON.stringify(progress) }],
            details: progress,
          }),
      });
      return textResult(
        params.background ? "Task started in background." : "Task completed.",
        value,
      );
    },
  });
}

function registerPlanTool(pi: ExtensionAPI, state: ExtensionState): void {
  pi.registerTool({
    name: "propose_plan",
    label: "propose_plan",
    description:
      "Present a plan for execution, continued planning, or refinement. Only explicit execution confirmation changes to Agent mode.",
    parameters: Type.Object({
      plan: Type.String({ minLength: 1, maxLength: 100_000 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
    }),
    async execute(id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return failTool("Interactive RPC UI is unavailable.");
      const response = await ctx.ui.select(
        encodePiPlanRequestTitle(id, params.plan),
        [...PI_PLAN_OPTIONS],
        { signal, timeout: params.timeoutMs },
      );
      const decision = parsePiPlanDecision(response);
      if (!decision) {
        pi.appendEntry(PLAN_ENTRY, {
          version: 1,
          plan: params.plan,
          decision: "cancelled",
        });
        return textResult("cancelled", { cancelled: true });
      }
      pi.appendEntry(PLAN_ENTRY, {
        version: 1,
        plan: params.plan,
        decision: decision.decision,
        ...(decision.decision === "refine" ? { refinement: decision.refinement } : {}),
      });
      if (decision.decision === "execute") {
        await setMode(pi, ctx, state, "agent");
      }
      return textResult(decision.decision === "refine" ? decision.refinement : decision.decision, {
        cancelled: false,
        ...decision,
        mode: state.mode,
      });
    },
  });
}

export function registerBootstrapProviders(
  pi: Pick<ExtensionAPI, "registerProvider">,
  payload: PiBootstrapPayload,
  sensitiveValues = providerSensitiveValues(payload.providers),
): void {
  try {
    for (const provider of payload.providers) {
      // The bootstrap socket is the only source of this literal credential.
      // Escape Pi's config interpolation syntax, add a pre-AgentSession stream
      // redactor, then clear the consumed bootstrap copy.
      const config = structuredClone(provider.config);
      config.apiKey = escapePiConfigLiteral(config.apiKey);
      if (config.headers) {
        for (const [name, value] of Object.entries(config.headers)) {
          config.headers[name] = escapePiConfigLiteral(value);
        }
      }
      for (const model of config.models) {
        if (!model.headers) continue;
        for (const [name, value] of Object.entries(model.headers)) {
          model.headers[name] = escapePiConfigLiteral(value);
        }
      }
      pi.registerProvider(provider.name, {
        ...config,
        streamSimple: createRedactingPiStreamSimple(sensitiveValues),
      } as ProviderConfig);
    }
  } finally {
    for (const provider of payload.providers) {
      provider.config.apiKey = "";
      for (const name of Object.keys(provider.config.headers ?? {})) {
        provider.config.headers![name] = "";
        delete provider.config.headers![name];
      }
      for (const model of provider.config.models) {
        for (const name of Object.keys(model.headers ?? {})) {
          model.headers![name] = "";
          delete model.headers![name];
        }
        delete model.headers;
      }
    }
    payload.providers.length = 0;
  }
}

function mcpReadOnly(state: ExtensionState, name: string): boolean | undefined {
  return state.mcpManager.readOnly(name);
}

function brokerEndpoint(
  socketPath: string | undefined,
  capability: string | undefined,
): PiBrokerEndpoint | undefined {
  return nonEmpty(socketPath) && nonEmpty(capability) ? { socketPath, capability } : undefined;
}

function registerLifecyclePolicies(pi: ExtensionAPI, state: ExtensionState): void {
  pi.on("message_end", (event) => {
    const redacted = redactPiSensitiveValue(event.message, state.sensitiveValues);
    return redacted === event.message ? undefined : { message: redacted };
  });
  pi.on("resources_discover", () => ({
    skillPaths: state.payload.managedSkills.map((skill) => skill.path),
  }));
  pi.on("session_start", (_event, ctx) => {
    const restored = restoreCustomState(ctx.sessionManager.getBranch(), state.payload.mode);
    state.mode = restored.mode;
    state.todos = restored.todos;
    applyActiveTools(state);
    publishStatus(ctx, state);
  });
  pi.on("tool_call", (event) => {
    if (
      state.mcpManager.isManagedTool(event.toolName) &&
      !state.mcpManager.isActiveTool(event.toolName)
    ) {
      return {
        block: true,
        reason: "Managed MCP tool is disabled or unavailable.",
      };
    }
    const decision = evaluatePiToolPolicy({
      mode: state.mode,
      toolName: event.toolName,
      args: event.input,
      mcpReadOnly: mcpReadOnly(state, event.toolName),
    });
    if (!decision.allowed) return { block: true, reason: decision.reason };
    if (decision.patchedArgs) Object.assign(event.input, decision.patchedArgs);
    return undefined;
  });
  pi.on("user_bash", (event) => {
    if (state.mode === "agent") return undefined;
    const decision = evaluatePiToolPolicy({
      mode: state.mode,
      toolName: "bash",
      args: { command: event.command },
    });
    if (decision.allowed) return undefined;
    return {
      result: {
        output: decision.reason ?? "Command rejected by Plan mode policy.",
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });
  pi.on("input", (event) => {
    if (
      /^\/(?:login|reload|extensions?|skills?|packages?|install)(?:\s|$)/iu.test(event.text.trim())
    ) {
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await state.mcpManager.refresh(ctx.signal);
    } finally {
      applyActiveTools(state);
      publishStatus(ctx, state);
    }
    const governed = state.payload.instructions?.trim();
    if (state.mode !== "plan") {
      return governed ? { systemPrompt: `${event.systemPrompt}\n\n${governed}` } : undefined;
    }
    return {
      systemPrompt: [
        event.systemPrompt,
        governed,
        "Piwork Plan mode is active. Do not modify files or external state. Use only read-only tools. Bash commands are accepted only when the fail-closed classifier proves they are read-only. Sub-agents are forced read-only. MCP calls are limited to tools explicitly declared read-only. Use propose_plan to request execution; remain in Plan mode unless the user explicitly selects execute.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  });
  pi.registerCommand("piwork-plan", {
    description: "Enter Piwork Plan mode.",
    handler: async (_args, ctx) => {
      await setMode(pi, ctx, state, "plan");
    },
  });
  pi.registerCommand("piwork-agent", {
    description: "Enter Piwork Agent mode.",
    handler: async (_args, ctx) => {
      await setMode(pi, ctx, state, "agent");
    },
  });
}

function registerFlags(pi: ExtensionAPI): void {
  pi.registerFlag(BOOTSTRAP_SOCKET_FLAG, {
    type: "string",
    description: "Piwork one-time bootstrap socket.",
  });
  pi.registerFlag(SESSION_ID_FLAG, {
    type: "string",
    description: "Piwork session binding.",
  });
  pi.registerFlag(GENERATION_FLAG, {
    type: "string",
    description: "Piwork process generation binding.",
  });
}

/**
 * Sole trusted extension loaded by Piwork's native Pi rpc-entry process.
 * Project/user extensions remain disabled by launcher flags.
 */
export default async function piworkTrustedPiExtension(pi: ExtensionAPI): Promise<void> {
  registerFlags(pi);
  const socketPath = readTrustedExtensionFlag(pi, BOOTSTRAP_SOCKET_FLAG);
  const sessionId = readTrustedExtensionFlag(pi, SESSION_ID_FLAG);
  const generationText = readTrustedExtensionFlag(pi, GENERATION_FLAG);
  const generation = generationText === undefined ? null : integer(generationText);
  if (!nonEmpty(socketPath) || !nonEmpty(sessionId) || generation === null) {
    throw new Error("Piwork trusted extension binding is incomplete.");
  }
  const payload = await consumePiBootstrap({
    socketPath,
    sessionId,
    generation,
  });
  const sensitiveValues = [
    ...providerSensitiveValues(payload.providers),
    payload.taskPolicy.capability,
    payload.mcpBroker?.capability,
    payload.productTools?.userSpaceCapability,
  ].filter((value): value is string => nonEmpty(value));
  const agentSpace = await PiAgentSpace.create(payload.authorizedRoots);
  const mcpEndpoint = payload.mcpBroker;
  const userSpaceCapability = payload.productTools?.userSpaceCapability;
  const taskEndpoint = brokerEndpoint(
    payload.taskPolicy.brokerSocket,
    payload.taskPolicy.capability,
  );
  const mcpManager = new PiMcpManager({
    pi,
    endpoint: mcpEndpoint,
    sessionId: payload.sessionId,
    generation: payload.generation,
    initial: payload.mcp,
  });
  delete payload.mcpBroker;
  delete payload.productTools;
  delete payload.taskPolicy.brokerSocket;
  delete payload.taskPolicy.capability;
  payload.mcp.length = 0;
  const state: ExtensionState = {
    payload,
    mode: payload.mode,
    agentSpace,
    mcpManager,
    userSpaceCapability,
    taskEndpoint,
    mcpEndpoint,
    sensitiveValues,
    todos: [],
  };

  registerBootstrapProviders(pi, payload, sensitiveValues);
  registerNativeTools(pi, state, process.cwd());
  registerAskTool(pi);
  registerTodoTool(pi, state);
  registerTaskTool(pi, state);
  registerPlanTool(pi, state);
  registerLifecyclePolicies(pi, state);
}
