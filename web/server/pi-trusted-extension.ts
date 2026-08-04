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
import { APP_BUILD_COMMAND, APP_BUILD_TIMEOUT_MS, inspectAppSource } from "./app-build.js";
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

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
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
  if (mode === "plan") {
    // Lock the local tool surface before the broker stops writable children.
    // Their completion notifications may start a Pi follow-up turn while the
    // broker transition is still in flight.
    state.mode = "plan";
    applyActiveTools(state);
    publishStatus(ctx, state);
  }
  await syncModeBroker(state, mode, ctx.signal);
  state.mode = mode;
  pi.appendEntry(MODE_ENTRY, { version: 1, mode });
  applyActiveTools(state);
  publishStatus(ctx, state);
}

async function syncModeBroker(
  state: ExtensionState,
  mode: PiAgentMode,
  signal?: AbortSignal,
): Promise<void> {
  if (state.taskEndpoint) {
    await requestPiBroker({
      endpoint: state.taskEndpoint,
      sessionId: state.payload.sessionId,
      generation: state.payload.generation,
      operation: "mode.set",
      payload: { mode },
      signal,
    });
  }
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
      "Ask the user one to four related questions only when the answer materially changes the outcome or grants new authority. Continue with safe, reversible assumptions instead of interrupting for minor choices. Keep questions concise, provide two to four distinct options per question, and mark multiSelect only when multiple options may be combined.",
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
      const questionTexts = new Set<string>();
      for (const question of params.questions) {
        const normalizedQuestion = question.question.trim();
        if (questionTexts.has(normalizedQuestion)) {
          return failTool("Ask questions must be unique.");
        }
        questionTexts.add(normalizedQuestion);
        const labels = new Set<string>();
        for (const option of question.options) {
          const normalizedLabel = option.label.trim();
          if (labels.has(normalizedLabel)) {
            return failTool("Ask option labels must be unique within each question.");
          }
          labels.add(normalizedLabel);
        }
      }
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
    description:
      "Replace the complete session todo list for substantial multi-step work. Keep at most one item in progress, update it as work advances, and mark work completed only after the available evidence or verification supports completion. Avoid todos for a trivial single action.",
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
      if (params.todos.filter((todo) => todo.status === "in_progress").length > 1) {
        return failTool("Only one todo may be in progress.");
      }
      state.todos = params.todos.map((todo) => ({ ...todo }));
      pi.appendEntry(TODO_ENTRY, { version: 1, todos: state.todos });
      return textResult(`Stored ${state.todos.length} todos.`, {
        todos: state.todos,
      });
    },
  });
  pi.registerTool({
    name: "todo_read",
    label: "todo_read",
    description:
      "Read the current session todo list after resume, compaction, branching, or before updating unfamiliar task state.",
    parameters: Type.Object({}),
    async execute() {
      return textResult(jsonText({ todos: state.todos }), {
        todos: state.todos.map((todo) => ({ ...todo })),
      });
    },
  });
}

function registerTaskTool(pi: ExtensionAPI, state: ExtensionState): void {
  pi.registerTool({
    name: "task",
    label: "task",
    description:
      "Delegate a bounded, self-contained research or document task to an isolated managed Pi agent. Use foreground work when its result is needed immediately; use background work for independent parallel investigation, then let its Pi follow-up arrive or call wait/status. Running tasks can be redirected with steer. Do not delegate trivial work or tightly coupled edits.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("wait"),
        Type.Literal("steer"),
        Type.Literal("stop"),
      ]),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
      background: Type.Optional(Type.Boolean()),
      readOnly: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1_800_000,
          description: "Maximum wait or delegated execution time in milliseconds.",
        }),
      ),
    }),
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!state.taskEndpoint) return failTool("Managed task broker is unavailable.");
      if (params.action === "list") {
        const value = await requestPiBroker({
          endpoint: state.taskEndpoint,
          sessionId: state.payload.sessionId,
          generation: state.payload.generation,
          operation: "task.list",
          signal,
        });
        return textResult(jsonText(value), value);
      }
      if (params.action === "stop" || params.action === "status" || params.action === "wait") {
        if (!nonEmpty(params.taskId)) {
          return failTool(`taskId is required to ${params.action} a task.`);
        }
        const waitTimeoutMs = params.timeoutMs ?? 30_000;
        const value = await requestPiBroker({
          endpoint: state.taskEndpoint,
          sessionId: state.payload.sessionId,
          generation: state.payload.generation,
          operation: `task.${params.action}`,
          payload: {
            taskId: params.taskId,
            ...(params.action === "wait" ? { timeoutMs: waitTimeoutMs } : {}),
          },
          signal,
          ...(params.action === "wait" ? { timeoutMs: waitTimeoutMs + 5_000 } : {}),
        });
        return textResult(jsonText(value), value);
      }
      if (params.action === "steer") {
        if (!nonEmpty(params.taskId)) {
          return failTool("taskId is required to steer a task.");
        }
        if (!nonEmpty(params.message)) {
          return failTool("message is required to steer a task.");
        }
        const value = await requestPiBroker({
          endpoint: state.taskEndpoint,
          sessionId: state.payload.sessionId,
          generation: state.payload.generation,
          operation: "task.steer",
          payload: { taskId: params.taskId, message: params.message },
          signal,
        });
        return textResult(jsonText(value), value);
      }
      if (!nonEmpty(params.prompt)) {
        return failTool("prompt is required to start a task.");
      }
      if (state.payload.taskPolicy.depth >= state.payload.taskPolicy.maxDepth) {
        return failTool("Managed task depth limit reached.");
      }
      const readOnly =
        state.mode === "plan" || state.payload.taskPolicy.readOnly === true || params.readOnly;
      const runTimeoutMs = params.timeoutMs ?? 1_800_000;
      const value = await requestPiBroker({
        endpoint: state.taskEndpoint,
        sessionId: state.payload.sessionId,
        generation: state.payload.generation,
        operation: "task.start",
        payload: {
          prompt: params.prompt,
          ...(nonEmpty(params.description) ? { description: params.description.trim() } : {}),
          background: params.background === true,
          timeoutMs: runTimeoutMs,
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
        timeoutMs: params.background ? 60_000 : runTimeoutMs + 5_000,
        onProgress: (progress) =>
          onUpdate?.({
            content: [{ type: "text", text: JSON.stringify(progress) }],
            details: progress,
          }),
      });
      return textResult(jsonText(value), value);
    },
  });
}

const APP_BUILD_LOG_LIMIT_BYTES = 256 * 1024;

async function requestAppBroker(
  state: ExtensionState,
  operation: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!state.taskEndpoint) return failTool("Managed App runtime is unavailable.");
  return requestPiBroker({
    endpoint: state.taskEndpoint,
    sessionId: state.payload.sessionId,
    generation: state.payload.generation,
    operation,
    payload,
    signal,
    timeoutMs: operation === "app.deploy" ? APP_BUILD_TIMEOUT_MS + 60_000 : undefined,
  });
}

function requireRootAppMutation(state: ExtensionState): void {
  if (state.mode !== "agent") failTool("App mutations are unavailable in Plan mode.");
  if (state.payload.taskPolicy.depth !== 0 || state.payload.taskPolicy.readOnly === true) {
    failTool("App mutations are available only to the root Agent task.");
  }
}

function registerAppTools(pi: ExtensionAPI, state: ExtensionState, cwd: string): void {
  pi.registerTool({
    name: "deploy_app",
    label: "deploy_app",
    description:
      "Build and publish an App from a directory in the current session Agent Space. The source must contain package.json, bun.lock, piwork.app.json, and emit build/server/wrangler.json. First publish requires publishIntent=user_requested. dryRun builds and validates without changing deployment state.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4_096 }),
      appId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      slug: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
      dryRun: Type.Optional(Type.Boolean()),
      publishIntent: Type.Optional(Type.Literal("user_requested")),
    }),
    async execute(_id, params, signal, onUpdate) {
      requireRootAppMutation(state);
      const source = await inspectAppSource(cwd, params.path);
      const localBash = createLocalBashOperations();
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      const result = await localBash.exec(APP_BUILD_COMMAND, source.sourceRoot, {
        timeout: APP_BUILD_TIMEOUT_MS,
        signal,
        env: scrubPiShellEnvironment({
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
        }),
        onData(data) {
          if (capturedBytes < APP_BUILD_LOG_LIMIT_BYTES) {
            const remaining = APP_BUILD_LOG_LIMIT_BYTES - capturedBytes;
            const chunk = data.subarray(0, remaining);
            chunks.push(chunk);
            capturedBytes += chunk.byteLength;
          }
          onUpdate?.({
            content: [{ type: "text", text: data.toString("utf8") }],
            details: { phase: "building" },
          });
        },
      });
      const buildLog = Buffer.concat(chunks).toString("utf8");
      if (result.exitCode !== 0) {
        return failTool(
          `App build failed with exit code ${String(result.exitCode)}${
            buildLog ? `\n${buildLog}` : ""
          }`,
        );
      }
      const value = await requestAppBroker(
        state,
        "app.deploy",
        {
          path: params.path,
          ...(params.appId ? { appId: params.appId } : {}),
          ...(params.slug ? { slug: params.slug } : {}),
          dryRun: params.dryRun === true,
          publishIntent: params.publishIntent,
          build: {
            command: APP_BUILD_COMMAND,
            exitCode: result.exitCode,
            log: buildLog,
            logTruncated: capturedBytes >= APP_BUILD_LOG_LIMIT_BYTES,
            sourceDigestBeforeBuild: source.sourceDigest,
          },
        },
        signal,
      );
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "list_apps",
    label: "list_apps",
    description: "List Apps visible in the current session, owned by the current user, or tenant.",
    parameters: Type.Object({
      scope: Type.Union([
        Type.Literal("current-session"),
        Type.Literal("mine"),
        Type.Literal("tenant"),
      ]),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    }),
    async execute(_id, params, signal) {
      const value = await requestAppBroker(state, "app.list", params, signal);
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "list_app_versions",
    label: "list_app_versions",
    description: "List immutable successful deployment versions for one App.",
    parameters: Type.Object({
      appId: Type.String({ minLength: 1, maxLength: 128 }),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    }),
    async execute(_id, params, signal) {
      const value = await requestAppBroker(state, "app.versions", params, signal);
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "rollback_app",
    label: "rollback_app",
    description:
      "Redeploy an immutable historical App artifact. This rolls back code and bindings only, never KV, R2, D1, or Durable Object data.",
    parameters: Type.Object({
      appId: Type.String({ minLength: 1, maxLength: 128 }),
      deploymentId: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    async execute(_id, params, signal) {
      requireRootAppMutation(state);
      const value = await requestAppBroker(state, "app.rollback", params, signal);
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "delete_app",
    label: "delete_app",
    description:
      "Archive this App in Piwork without deleting its Worker or resources from the user's Cloudflare account. Requires explicit user intent.",
    parameters: Type.Object({
      appId: Type.String({ minLength: 1, maxLength: 128 }),
      publishIntent: Type.Literal("user_requested"),
    }),
    async execute(_id, params, signal) {
      requireRootAppMutation(state);
      const value = await requestAppBroker(state, "app.delete", params, signal);
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "restore_app",
    label: "restore_app",
    description: "Restore an archived App link in Piwork without changing Cloudflare resources.",
    parameters: Type.Object({ appId: Type.String({ minLength: 1, maxLength: 128 }) }),
    async execute(_id, params, signal) {
      requireRootAppMutation(state);
      const value = await requestAppBroker(state, "app.restore", params, signal);
      return textResult(jsonText(value), value);
    },
  });

  pi.registerTool({
    name: "open_app_preview",
    label: "open_app_preview",
    description: "Open a ready Temporary or BYOC App URL in Piwork's isolated App preview.",
    parameters: Type.Object({ appId: Type.String({ minLength: 1, maxLength: 128 }) }),
    async execute(_id, params, signal) {
      requireRootAppMutation(state);
      const value = await requestAppBroker(state, "app.preview", params, signal);
      return textResult(jsonText(value), value);
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

function registerNativeFileTool(pi: ExtensionAPI, state: ExtensionState): void {
  pi.registerTool({
    name: "native_file",
    label: "native_file",
    description:
      "Use a typed macOS file action for one Agent Space file. Supported actions are Quick Look, open, Open With, print, export, reveal, share, and an explicit native-edit handoff. This tool never accepts shell commands or host paths. User Space binaries must first be checked out to Agent Space.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("file.quickLook"),
        Type.Literal("file.open"),
        Type.Literal("file.openWith"),
        Type.Literal("file.print"),
        Type.Literal("file.saveAs"),
        Type.Literal("file.revealExport"),
        Type.Literal("file.share"),
        Type.Literal("file.nativeEdit"),
      ]),
      path: Type.String({ minLength: 1, maxLength: 4_096 }),
    }),
    async execute(_id, params, signal) {
      if (state.mode === "plan") {
        return failTool("native_file is unavailable in Plan mode.");
      }
      if (!state.taskEndpoint) return failTool("Native file helper is unavailable.");
      const value = await requestPiBroker({
        endpoint: state.taskEndpoint,
        sessionId: state.payload.sessionId,
        generation: state.payload.generation,
        operation: "native-file.action",
        payload: {
          action: params.action,
          path: params.path,
        },
        signal,
      });
      return textResult(jsonText(value), value);
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
  const restoreSessionState = async (ctx: ExtensionContext) => {
    const restored = restoreCustomState(ctx.sessionManager.getBranch(), state.payload.mode);
    const modeChanged = restored.mode !== state.mode;
    if (modeChanged && restored.mode === "plan") {
      state.mode = "plan";
      state.todos = restored.todos;
      applyActiveTools(state);
      publishStatus(ctx, state);
    }
    if (modeChanged) {
      await syncModeBroker(state, restored.mode, ctx.signal);
    }
    state.mode = restored.mode;
    state.todos = restored.todos;
    applyActiveTools(state);
    publishStatus(ctx, state);
  };
  pi.on("session_start", (_event, ctx) => restoreSessionState(ctx));
  pi.on("session_tree", (_event, ctx) => restoreSessionState(ctx));
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
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      await state.mcpManager.refresh(ctx.signal);
    } finally {
      applyActiveTools(state);
      publishStatus(ctx, state);
    }
    return undefined;
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
  registerAppTools(pi, state, process.cwd());
  registerNativeFileTool(pi, state);
  registerPlanTool(pi, state);
  registerLifecyclePolicies(pi, state);
}
