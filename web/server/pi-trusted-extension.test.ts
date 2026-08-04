import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
  consumeBootstrap: vi.fn(),
  createAgentSpace: vi.fn(),
  requestBroker: vi.fn(),
  localExec: vi.fn(),
  nativeDefinitions: [] as Array<{
    name: string;
    cwd: string;
    options: Record<string, unknown>;
  }>,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashToolDefinition: vi.fn((cwd: string, options: Record<string, unknown>) => {
    mocks.nativeDefinitions.push({ name: "bash", cwd, options });
    return nativeDefinition("bash");
  }),
  createEditToolDefinition: vi.fn((cwd: string, options: Record<string, unknown>) => {
    mocks.nativeDefinitions.push({ name: "edit", cwd, options });
    return nativeDefinition("edit");
  }),
  createLocalBashOperations: vi.fn(() => ({ exec: mocks.localExec })),
  createReadToolDefinition: vi.fn((cwd: string, options: Record<string, unknown>) => {
    mocks.nativeDefinitions.push({ name: "read", cwd, options });
    return nativeDefinition("read");
  }),
  createWriteToolDefinition: vi.fn((cwd: string, options: Record<string, unknown>) => {
    mocks.nativeDefinitions.push({ name: "write", cwd, options });
    return nativeDefinition("write");
  }),
}));

vi.mock("./pi-agent-space.js", () => ({
  PiAgentSpace: class {
    static create = mocks.createAgentSpace;
  },
}));

vi.mock("./pi-bootstrap-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-bootstrap-channel.js")>()),
  consumePiBootstrap: mocks.consumeBootstrap,
}));

vi.mock("./pi-broker-client.js", () => ({
  requestPiBroker: mocks.requestBroker,
}));

import {
  buildPiShellEnvironment,
  default as piworkTrustedPiExtension,
  isManagedProductCliCommand,
  managedMcpToolName,
  parsePiPlanDecision,
  readTrustedExtensionFlag,
  registerBootstrapProviders,
  scrubPiShellEnvironment,
} from "./pi-trusted-extension.js";
import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import { encodePiAskBatchResponse, PI_ASK_BATCH_OPTION } from "./pi-ask-interaction.js";
import { PI_PLAN_OPTIONS } from "./pi-plan-interaction.js";

function nativeDefinition(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object" },
    execute: vi.fn(),
  };
}

interface RegisteredCommand {
  handler: (...args: unknown[]) => unknown;
}

interface ExtensionFixture {
  activeTools: string[][];
  commands: Map<string, RegisteredCommand>;
  context: ExtensionContext;
  events: Map<string, (...args: unknown[]) => unknown>;
  payload: PiBootstrapPayload;
  pi: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  ui: {
    input: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
}

function mcpServer(enabled = true) {
  return {
    name: "docs",
    enabled,
    status: enabled ? ("connected" as const) : ("disabled" as const),
    transport: "streamable-http" as const,
    tools: enabled
      ? [
          { name: "search", description: "Search documents", readOnly: true },
          { name: "mutate", description: "Mutate documents", readOnly: false },
        ]
      : [],
  };
}

function bootstrapPayload(overrides: Partial<PiBootstrapPayload> = {}): PiBootstrapPayload {
  return {
    version: 1,
    sessionId: "session-1",
    generation: 7,
    authorizedRoots: [{ path: process.cwd(), access: "write" }],
    mode: "plan",
    instructions: "Follow managed instructions.",
    providers: [
      {
        name: "managed",
        config: {
          api: "openai-responses",
          apiKey: "provider-secret",
          headers: { "X-Provider-Token": "provider-header-secret" },
          models: [
            {
              id: "model-1",
              name: "Managed Model",
              headers: { "X-Model-Token": "model-header-secret" },
            },
          ],
        },
      },
    ],
    managedSkills: [
      {
        path: "/managed/skills/research",
        name: "research",
        sha256: "a".repeat(64),
      },
    ],
    mcp: [mcpServer()],
    taskPolicy: {
      depth: 0,
      maxDepth: 2,
      maxParallel: 4,
      brokerSocket: "/tmp/piwork-task.sock",
      capability: "task-capability",
    },
    productTools: { userSpaceCapability: "user-space-capability" },
    mcpBroker: {
      socketPath: "/tmp/piwork-mcp.sock",
      capability: "mcp-capability",
    },
    ...overrides,
  };
}

async function extensionFixture(
  overrides: Partial<PiBootstrapPayload> = {},
): Promise<ExtensionFixture> {
  const payload = bootstrapPayload(overrides);
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, RegisteredCommand>();
  const activeTools: string[][] = [];
  const flags = new Map<string, string>([
    ["piwork-bootstrap-socket", "/tmp/piwork-bootstrap.sock"],
    ["piwork-session-id", payload.sessionId],
    ["piwork-generation", String(payload.generation)],
  ]);
  const ui = {
    input: vi.fn(),
    select: vi.fn(),
    setStatus: vi.fn(),
  };
  const pi = {
    appendEntry: vi.fn(),
    getAllTools: vi.fn(() =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: {
          path: "<test>",
          resolvedPath: "<test>",
          source: "explicit",
        },
      })),
    ),
    getFlag: vi.fn((name: string) => flags.get(name)),
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      events.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    }),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    }),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools.push([...names]);
    }),
  } as unknown as ExtensionAPI;
  const context = {
    hasUI: true,
    model: { provider: "managed", id: "model-1" },
    sessionManager: { getBranch: vi.fn(() => []) },
    signal: new AbortController().signal,
    ui,
  } as unknown as ExtensionContext;
  mocks.consumeBootstrap.mockResolvedValueOnce(payload);
  await piworkTrustedPiExtension(pi);
  return { activeTools, commands, context, events, payload, pi, tools, ui };
}

function executeTool(
  fixture: ExtensionFixture,
  name: string,
  params: unknown,
  context = fixture.context,
  onUpdate?: (value: unknown) => void,
) {
  const tool = fixture.tools.get(name);
  if (!tool) throw new Error(`Missing test tool: ${name}`);
  return tool.execute("call-1", params as never, context.signal, onUpdate as never, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativeDefinitions.length = 0;
  mocks.createAgentSpace.mockResolvedValue({
    readOperations: { readFile: vi.fn(), access: vi.fn() },
    writeOperations: { writeFile: vi.fn(), mkdir: vi.fn() },
    editOperations: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      access: vi.fn(),
    },
  });
  mocks.localExec.mockResolvedValue({ exitCode: 0 });
  mocks.requestBroker.mockImplementation(async (options: { operation?: string }) =>
    options.operation === "mcp.status" ? { servers: [mcpServer()] } : { ok: true },
  );
});

describe("Piwork trusted Pi extension helpers", () => {
  it("reads only non-secret process-binding flags and rejects duplicates", () => {
    const pi = { getFlag: () => undefined };
    expect(
      readTrustedExtensionFlag(pi, "piwork-session-id", ["--piwork-session-id", "session-1"]),
    ).toBe("session-1");
    expect(() =>
      readTrustedExtensionFlag(pi, "piwork-session-id", [
        "--piwork-session-id=a",
        "--piwork-session-id=b",
      ]),
    ).toThrow(/Duplicate/u);
  });

  it("removes credential-shaped variables from native bash environments", () => {
    expect(
      scrubPiShellEnvironment({
        PATH: "/usr/bin",
        API_KEY: "secret",
        ACCESS_TOKEN: "secret",
        BASH_ENV: "/tmp/inject.sh",
        BASH_FUNC_user_space: "() { env; }",
        LD_PRELOAD: "/tmp/inject.so",
        NODE_OPTIONS: "--require=/tmp/inject.cjs",
        PYTHONPATH: "/tmp/inject",
        PIWORK_MODE: "agent",
      }),
    ).toEqual({ PATH: "/usr/bin", PIWORK_MODE: "agent" });
  });

  it("injects the protected-file capability only for one literal managed CLI command", () => {
    expect(isManagedProductCliCommand("user-space read documents/report.md --limit 20")).toBe(true);
    expect(isManagedProductCliCommand('onlyoffice op --json \'{"type":"read"}\'')).toBe(true);
    expect(
      isManagedProductCliCommand(String.raw`onlyoffice op --json '{"text":"line\nquote\""}'`),
    ).toBe(true);
    for (const command of [
      "user-space read documents/report.md; env",
      "user-space read $(env)",
      "user-space read documents/report.md | cat",
      "TOKEN=value user-space read documents/report.md",
      "./user-space read documents/report.md",
      'user-space read "documents/$TARGET"',
      String.raw`user-space read 'missing\' ; env # '`,
      String.raw`onlyoffice op --json '{"text":"missing\' ; env # "}'`,
    ]) {
      expect(isManagedProductCliCommand(command), command).toBe(false);
      expect(
        buildPiShellEnvironment(
          command,
          {
            PATH: "/managed/bin:/usr/bin",
            API_KEY: "provider-secret",
            PIWORK_USER_SPACE_API_TOKEN: "inherited-secret",
          },
          "one-command-capability",
        ),
      ).toEqual({ PATH: "/managed/bin:/usr/bin" });
    }
    expect(
      buildPiShellEnvironment(
        "user-space read documents/report.md",
        { PATH: "/managed/bin:/usr/bin", API_KEY: "provider-secret" },
        "one-command-capability",
      ),
    ).toEqual({
      PATH: "/managed/bin:/usr/bin",
      PIWORK_USER_SPACE_API_TOKEN: "one-command-capability",
    });
  });

  it("creates deterministic Pi-native managed MCP tool names", () => {
    expect(managedMcpToolName("files.prod", "read/file")).toBe("mcp__files_prod__read_file");
  });

  it("accepts only exact plan decisions and preserves a bounded refinement", () => {
    expect(parsePiPlanDecision("execute")).toEqual({ decision: "execute" });
    expect(parsePiPlanDecision("continue_planning")).toEqual({
      decision: "continue_planning",
    });
    expect(
      parsePiPlanDecision(JSON.stringify({ decision: "refine", refinement: "  Add validation  " })),
    ).toEqual({ decision: "refine", refinement: "Add validation" });
    expect(parsePiPlanDecision("refine")).toBeUndefined();
    expect(
      parsePiPlanDecision(JSON.stringify({ decision: "execute", refinement: "smuggled" })),
    ).toBeUndefined();
    expect(
      parsePiPlanDecision(JSON.stringify({ decision: "refine", refinement: "valid", extra: true })),
    ).toBeUndefined();
  });

  it("registers escaped provider literals and clears every bootstrap credential reference", () => {
    const registered: unknown[] = [];
    const pi = {
      registerProvider: vi.fn((_name: string, config: unknown) => {
        registered.push(config);
      }),
    };
    const payload = {
      providers: [
        {
          name: "managed",
          config: {
            api: "openai-responses",
            apiKey: "!provider-secret-$CANARY",
            headers: { "X-Provider-Token": "$HEADER-provider-header-canary" },
            models: [
              {
                id: "model",
                name: "Model",
                headers: { "X-Model-Token": "!model-header-$CANARY" },
              },
            ],
          },
        },
      ],
    } as unknown as PiBootstrapPayload;

    registerBootstrapProviders(
      pi as unknown as Parameters<typeof registerBootstrapProviders>[0],
      payload,
    );

    expect(payload.providers).toEqual([]);
    expect(registered).toEqual([
      expect.objectContaining({
        apiKey: "$!provider-secret-$$CANARY",
        headers: { "X-Provider-Token": "$$HEADER-provider-header-canary" },
        models: [
          expect.objectContaining({
            id: "model",
            headers: { "X-Model-Token": "$!model-header-$$CANARY" },
          }),
        ],
        streamSimple: expect.any(Function),
      }),
    ]);
  });
});

describe("Piwork trusted Pi extension runtime", () => {
  it("requires complete generation-bound bootstrap flags", async () => {
    const pi = {
      getFlag: vi.fn((name: string) =>
        name === "piwork-generation" ? "not-an-integer" : undefined,
      ),
      registerFlag: vi.fn(),
    };
    await expect(piworkTrustedPiExtension(pi as unknown as ExtensionAPI)).rejects.toThrow(
      /binding is incomplete/u,
    );
    expect(mocks.consumeBootstrap).not.toHaveBeenCalled();
  });

  it("registers native and product tools while clearing bootstrap capabilities", async () => {
    const value = await extensionFixture();

    expect(mocks.consumeBootstrap).toHaveBeenCalledWith({
      socketPath: "/tmp/piwork-bootstrap.sock",
      sessionId: "session-1",
      generation: 7,
    });
    expect(mocks.createAgentSpace).toHaveBeenCalledWith([{ path: process.cwd(), access: "write" }]);
    expect([...value.tools.keys()]).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "ask",
        "todo_write",
        "todo_read",
        "task",
        "deploy_app",
        "list_apps",
        "list_app_versions",
        "rollback_app",
        "delete_app",
        "restore_app",
        "open_app_preview",
        "native_file",
        "propose_plan",
        "mcp__docs__search",
        "mcp__docs__mutate",
      ]),
    );
    expect(value.tools.has("get_app_logs")).toBe(false);
    expect(value.tools.has("set_app_visibility")).toBe(false);
    expect(value.pi.registerProvider).toHaveBeenCalledTimes(1);
    expect(value.payload.providers).toEqual([]);
    expect(value.payload.mcp).toEqual([]);
    expect(value.payload.mcpBroker).toBeUndefined();
    expect(value.payload.productTools).toBeUndefined();
    expect(value.payload.taskPolicy).not.toHaveProperty("brokerSocket");
    expect(value.payload.taskPolicy).not.toHaveProperty("capability");

    const bash = mocks.nativeDefinitions.find((item) => item.name === "bash");
    const operations = bash?.options.operations as
      | {
          exec(
            command: string,
            cwd: string,
            options: {
              env?: NodeJS.ProcessEnv;
              onData(data: Buffer): void;
            },
          ): Promise<unknown>;
        }
      | undefined;
    expect(operations).toBeDefined();
    await operations!.exec("user-space read report.md", process.cwd(), {
      env: { PATH: "/usr/bin", API_KEY: "must-not-leak" },
      onData: vi.fn(),
    });
    expect(mocks.localExec).toHaveBeenCalledWith(
      "user-space read report.md",
      process.cwd(),
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          PIWORK_USER_SPACE_API_TOKEN: "user-space-capability",
        },
      }),
    );
    expect(bash?.options.exposeSessionEnvironment).toBe(false);
  });

  it("brokers typed native file actions in Agent mode and rejects Plan mode", async () => {
    const plan = await extensionFixture();
    await expect(
      executeTool(plan, "native_file", {
        action: "file.quickLook",
        path: "report.docx",
      }),
    ).rejects.toThrow(/unavailable in Plan mode/u);
    expect(mocks.requestBroker).not.toHaveBeenCalled();

    const agent = await extensionFixture({ mode: "agent" });
    mocks.requestBroker.mockResolvedValueOnce({
      operationId: "operation-a",
      action: "file.quickLook",
      state: "shown",
    });
    await expect(
      executeTool(agent, "native_file", {
        action: "file.quickLook",
        path: "report.docx",
      }),
    ).resolves.toMatchObject({
      details: {
        operationId: "operation-a",
        action: "file.quickLook",
        state: "shown",
      },
    });
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        generation: 7,
        operation: "native-file.action",
        payload: {
          action: "file.quickLook",
          path: "report.docx",
        },
      }),
    );
  });

  it("asks a group of questions in one trusted interaction and returns a review payload", async () => {
    const value = await extensionFixture();
    const noUi = { ...value.context, hasUI: false } as ExtensionContext;
    const questions = [
      {
        header: "Style",
        question: "Choose a style",
        options: [
          { label: "Minimal", description: "Keep the UI quiet" },
          { label: "Expressive", description: "Use stronger visual accents" },
        ],
        multiSelect: false,
      },
      {
        header: "Scope",
        question: "Choose the scope",
        options: [
          { label: "Frontend", description: "Change the browser UI" },
          { label: "Backend", description: "Change the server" },
        ],
        multiSelect: true,
      },
    ];
    await expect(executeTool(value, "ask", { questions }, noUi)).rejects.toThrow(/unavailable/u);
    await expect(
      executeTool(value, "ask", {
        questions: [questions[0], { ...questions[0] }],
      }),
    ).rejects.toThrow(/questions must be unique/u);
    await expect(
      executeTool(value, "ask", {
        questions: [
          {
            ...questions[0],
            options: [questions[0].options[0], { ...questions[0].options[0] }],
          },
        ],
      }),
    ).rejects.toThrow(/option labels must be unique/u);

    value.ui.select.mockResolvedValueOnce(undefined);
    await expect(executeTool(value, "ask", { questions, timeoutMs: 50 })).resolves.toMatchObject({
      details: { cancelled: true },
    });

    value.ui.select.mockResolvedValueOnce(
      encodePiAskBatchResponse([
        { question: "Choose a style", answer: "Minimal" },
        { question: "Choose the scope", answer: ["Frontend", "Backend"] },
      ]),
    );
    await expect(executeTool(value, "ask", { questions })).resolves.toMatchObject({
      details: {
        kind: "ask_user_question_review",
        answers: {
          "Choose a style": "Minimal",
          "Choose the scope": ["Frontend", "Backend"],
        },
      },
    });
    expect(value.ui.select).toHaveBeenLastCalledWith(
      expect.stringContaining('"kind":"piwork_ask_batch"'),
      [PI_ASK_BATCH_OPTION],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    value.ui.select.mockResolvedValueOnce('{"kind":"invalid"}');
    await expect(executeTool(value, "ask", { questions })).rejects.toThrow(/invalid/u);
  });

  it("replaces and reads Pi session todo state while enforcing one active item", async () => {
    const value = await extensionFixture();
    const todo = { id: "one", text: "First", status: "pending" };
    await expect(executeTool(value, "todo_write", { todos: [todo, todo] })).rejects.toThrow(
      /unique/u,
    );
    await expect(
      executeTool(value, "todo_write", {
        todos: [
          { ...todo, status: "in_progress" },
          { id: "two", text: "Second", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow(/Only one todo/u);
    await expect(
      executeTool(value, "todo_write", {
        todos: [todo, { id: "two", text: "Second", status: "completed" }],
      }),
    ).resolves.toMatchObject({
      details: {
        todos: [todo, { id: "two", text: "Second", status: "completed" }],
      },
    });
    expect(value.pi.appendEntry).toHaveBeenCalledWith("piwork.todo", {
      version: 1,
      todos: [todo, { id: "two", text: "Second", status: "completed" }],
    });
    await expect(executeTool(value, "todo_read", {})).resolves.toMatchObject({
      content: [
        {
          text: JSON.stringify({
            todos: [todo, { id: "two", text: "Second", status: "completed" }],
          }),
        },
      ],
    });
  });

  it("enforces task broker inputs, depth, read-only inheritance, and progress", async () => {
    const value = await extensionFixture();
    await expect(executeTool(value, "task", { action: "stop" })).rejects.toThrow(
      /taskId is required/u,
    );
    mocks.requestBroker.mockResolvedValueOnce({ stopped: true });
    await expect(
      executeTool(value, "task", { action: "stop", taskId: "task-1" }),
    ).resolves.toMatchObject({
      content: [{ text: '{"stopped":true}' }],
      details: { stopped: true },
    });
    await expect(executeTool(value, "task", { action: "start" })).rejects.toThrow(
      /prompt is required/u,
    );

    const onUpdate = vi.fn();
    mocks.requestBroker.mockImplementationOnce(
      async (options: { onProgress?: (progress: unknown) => void; operation?: string }) => {
        options.onProgress?.({ phase: "running" });
        return { taskId: "task-2" };
      },
    );
    await expect(
      executeTool(
        value,
        "task",
        {
          action: "start",
          prompt: "Research",
          description: "Research evidence",
          background: true,
        },
        value.context,
        onUpdate,
      ),
    ).resolves.toMatchObject({
      content: [{ text: '{"taskId":"task-2"}' }],
      details: { taskId: "task-2" },
    });
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: '{"phase":"running"}' }],
      details: { phase: "running" },
    });
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "task.start",
        payload: expect.objectContaining({
          background: true,
          description: "Research evidence",
          depth: 1,
          maxDepth: 2,
          maxParallel: 4,
          mcp: ["docs"],
          mode: "plan",
          model: { provider: "managed", modelId: "model-1" },
          readOnly: true,
          skills: [
            {
              path: "/managed/skills/research",
              name: "research",
              sha256: "a".repeat(64),
            },
          ],
        }),
      }),
    );

    mocks.requestBroker.mockResolvedValueOnce({
      tasks: [{ taskId: "task-2", status: "running" }],
    });
    await expect(executeTool(value, "task", { action: "list" })).resolves.toMatchObject({
      content: [{ text: '{"tasks":[{"taskId":"task-2","status":"running"}]}' }],
    });
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "task.list" }),
    );

    await expect(executeTool(value, "task", { action: "wait" })).rejects.toThrow(
      /taskId is required/u,
    );
    mocks.requestBroker.mockResolvedValueOnce({ taskId: "task-2", status: "completed" });
    await expect(
      executeTool(value, "task", {
        action: "wait",
        taskId: "task-2",
        timeoutMs: 12_000,
      }),
    ).resolves.toMatchObject({
      content: [{ text: '{"taskId":"task-2","status":"completed"}' }],
    });
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "task.wait",
        payload: { taskId: "task-2", timeoutMs: 12_000 },
        timeoutMs: 17_000,
      }),
    );

    await expect(executeTool(value, "task", { action: "steer", taskId: "task-2" })).rejects.toThrow(
      /message is required/u,
    );
    mocks.requestBroker.mockResolvedValueOnce({ taskId: "task-2", status: "running" });
    await executeTool(value, "task", {
      action: "steer",
      taskId: "task-2",
      message: "Focus on the signed source.",
    });
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "task.steer",
        payload: {
          taskId: "task-2",
          message: "Focus on the signed source.",
        },
      }),
    );

    const atDepthLimit = await extensionFixture({
      taskPolicy: {
        depth: 2,
        maxDepth: 2,
        maxParallel: 4,
        brokerSocket: "/tmp/piwork-task.sock",
        capability: "task-capability",
      },
    });
    await expect(
      executeTool(atDepthLimit, "task", {
        action: "start",
        prompt: "Too deep",
      }),
    ).rejects.toThrow(/depth limit/u);

    const unavailable = await extensionFixture({
      taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 4 },
    });
    await expect(
      executeTool(unavailable, "task", {
        action: "start",
        prompt: "No broker",
      }),
    ).rejects.toThrow(/unavailable/u);
  });

  it("keeps App broker tools scoped to the root Agent and fails closed without a broker", async () => {
    const plan = await extensionFixture();
    await expect(executeTool(plan, "deploy_app", { path: "demo" })).rejects.toThrow(/Plan mode/u);
    await expect(executeTool(plan, "list_apps", { scope: "tenant" })).resolves.toMatchObject({
      details: { ok: true },
    });
    await expect(executeTool(plan, "list_app_versions", { appId: "app-1" })).resolves.toMatchObject(
      { details: { ok: true } },
    );

    const agent = await extensionFixture({ mode: "agent" });
    for (const [name, params] of [
      ["rollback_app", { appId: "app-1", deploymentId: "deployment-1" }],
      ["delete_app", { appId: "app-1", publishIntent: "user_requested" }],
      ["restore_app", { appId: "app-1" }],
      ["open_app_preview", { appId: "app-1" }],
    ] as const) {
      await expect(executeTool(agent, name, params)).resolves.toMatchObject({
        details: { ok: true },
      });
    }
    expect(mocks.requestBroker.mock.calls.map(([options]) => options.operation)).toEqual(
      expect.arrayContaining([
        "app.list",
        "app.versions",
        "app.rollback",
        "app.delete",
        "app.restore",
        "app.preview",
      ]),
    );

    const child = await extensionFixture({
      mode: "agent",
      taskPolicy: { depth: 1, maxDepth: 2, maxParallel: 4 },
    });
    await expect(
      executeTool(child, "rollback_app", { appId: "app-1", deploymentId: "deployment-1" }),
    ).rejects.toThrow(/root Agent/u);

    const unavailable = await extensionFixture({
      taskPolicy: { depth: 0, maxDepth: 2, maxParallel: 4 },
    });
    await expect(executeTool(unavailable, "list_apps", { scope: "tenant" })).rejects.toThrow(
      /Managed App runtime/u,
    );
  });

  it("keeps Plan mode until explicit execution confirmation", async () => {
    const value = await extensionFixture();
    const noUi = { ...value.context, hasUI: false } as ExtensionContext;
    await expect(executeTool(value, "propose_plan", { plan: "Plan" }, noUi)).rejects.toThrow(
      /unavailable/u,
    );

    value.ui.select
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("continue_planning")
      .mockResolvedValueOnce(JSON.stringify({ decision: "refine", refinement: "Add validation" }))
      .mockResolvedValueOnce("execute");
    await expect(executeTool(value, "propose_plan", { plan: "Plan" })).resolves.toMatchObject({
      details: { cancelled: true },
    });
    await expect(executeTool(value, "propose_plan", { plan: "Plan" })).resolves.toMatchObject({
      details: { decision: "continue_planning", mode: "plan" },
    });
    await expect(executeTool(value, "propose_plan", { plan: "Plan" })).resolves.toMatchObject({
      content: [{ text: "Add validation" }],
      details: { decision: "refine", mode: "plan" },
    });
    await expect(executeTool(value, "propose_plan", { plan: "Plan" })).resolves.toMatchObject({
      details: { decision: "execute", mode: "agent" },
    });
    expect(value.ui.select).toHaveBeenLastCalledWith(
      expect.stringContaining('"kind":"piwork_plan_request"'),
      [...PI_PLAN_OPTIONS],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.requestBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mode.set",
        payload: { mode: "agent" },
      }),
    );
    expect(value.ui.setStatus).toHaveBeenCalled();
  });

  it("locks local tools before a Plan broker transition can emit task follow-ups", async () => {
    const value = await extensionFixture({ mode: "agent" });
    const toolCall = value.events.get("tool_call")!;
    let releaseBroker!: (value: unknown) => void;
    mocks.requestBroker.mockImplementationOnce(
      () =>
        new Promise((resolveBroker) => {
          releaseBroker = resolveBroker;
        }),
    );

    const transition = value.commands.get("piwork-plan")!.handler("", value.context);
    await Promise.resolve();
    expect(toolCall({ toolName: "write", input: { path: "/tmp/file" } })).toMatchObject({
      block: true,
      reason: expect.stringMatching(/disabled/u),
    });

    releaseBroker({ mode: "plan" });
    await transition;
  });

  it("restores state and applies fail-closed lifecycle policies", async () => {
    const value = await extensionFixture();
    const sessionStart = value.events.get("session_start")!;
    const sessionTree = value.events.get("session_tree")!;
    const resourcesDiscover = value.events.get("resources_discover")!;
    const messageEnd = value.events.get("message_end")!;
    const toolCall = value.events.get("tool_call")!;
    const userBash = value.events.get("user_bash")!;
    const input = value.events.get("input")!;
    const restoredContext = {
      ...value.context,
      sessionManager: {
        getBranch: () => [
          { type: "message", text: "ignored" },
          { type: "custom", customType: "piwork.mode", data: { mode: "agent" } },
          {
            type: "custom",
            customType: "piwork.todo",
            data: {
              todos: [{ id: "restored", text: "Restored", status: "pending" }],
            },
          },
        ],
      },
    } as unknown as ExtensionContext;

    expect(await sessionStart({ type: "session_start" }, restoredContext)).toBeUndefined();
    expect(await sessionTree({ type: "session_tree" }, restoredContext)).toBeUndefined();
    expect(mocks.requestBroker).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mode.set",
        payload: { mode: "agent" },
      }),
    );
    await expect(executeTool(value, "todo_read", {})).resolves.toMatchObject({
      details: {
        todos: [{ id: "restored", text: "Restored", status: "pending" }],
      },
    });
    expect(resourcesDiscover()).toEqual({
      skillPaths: ["/managed/skills/research"],
    });
    const secretMessage = {
      role: "user",
      content: "provider-secret",
      timestamp: 1,
    };
    expect(messageEnd({ message: secretMessage })).toEqual({
      message: { ...secretMessage, content: "[REDACTED]" },
    });
    const cleanMessage = { ...secretMessage, content: "safe" };
    expect(messageEnd({ message: cleanMessage })).toEqual({
      message: cleanMessage,
    });

    expect(toolCall({ toolName: "write", input: { path: "/tmp/file" } })).toBeUndefined();
    expect(userBash({ command: "touch file" })).toBeUndefined();
    expect(input({ text: " /login " })).toEqual({ action: "handled" });
    expect(input({ text: "/packages add unknown" })).toEqual({ action: "handled" });
    expect(input({ text: "continue" })).toEqual({ action: "continue" });

    const planBranchContext = {
      ...restoredContext,
      sessionManager: {
        getBranch: () => [{ type: "custom", customType: "piwork.mode", data: { mode: "plan" } }],
      },
    } as unknown as ExtensionContext;
    expect(await sessionTree({ type: "session_tree" }, planBranchContext)).toBeUndefined();
    expect(mocks.requestBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "mode.set",
        payload: { mode: "plan" },
      }),
    );
    expect(toolCall({ toolName: "write", input: { path: "/tmp/file" } })).toMatchObject({
      block: true,
      reason: expect.stringMatching(/disabled/u),
    });
    const taskInput: Record<string, unknown> = { action: "start", prompt: "inspect" };
    expect(toolCall({ toolName: "task", input: taskInput })).toBeUndefined();
    expect(taskInput.readOnly).toBe(true);
    expect(toolCall({ toolName: "mcp__docs__search", input: {} })).toBeUndefined();
    expect(toolCall({ toolName: "mcp__docs__mutate", input: {} })).toMatchObject({
      block: true,
      reason: expect.stringMatching(/read-only/u),
    });
    expect(userBash({ command: "pwd" })).toBeUndefined();
    expect(userBash({ command: "echo unsafe > file" })).toEqual({
      result: expect.objectContaining({ exitCode: 126, cancelled: false }),
    });
  });

  it("refreshes MCP state without rewriting the system prompt and disables stale tools", async () => {
    const value = await extensionFixture();
    const beforeAgentStart = value.events.get("before_agent_start")!;
    const toolCall = value.events.get("tool_call")!;

    expect(await beforeAgentStart({ systemPrompt: "Base prompt" }, value.context)).toBeUndefined();

    mocks.requestBroker.mockResolvedValueOnce({ servers: [mcpServer(false)] });
    await beforeAgentStart({ systemPrompt: "Base prompt" }, value.context);
    expect(toolCall({ toolName: "mcp__docs__search", input: {} })).toEqual({
      block: true,
      reason: "Managed MCP tool is disabled or unavailable.",
    });

    await value.commands.get("piwork-agent")!.handler("", value.context);
    expect(await beforeAgentStart({ systemPrompt: "Base prompt" }, value.context)).toBeUndefined();

    mocks.requestBroker.mockRejectedValueOnce(new Error("mcp unavailable"));
    await expect(beforeAgentStart({ systemPrompt: "Base prompt" }, value.context)).rejects.toThrow(
      /mcp unavailable/u,
    );
    expect(value.ui.setStatus).toHaveBeenCalled();
    expect(value.activeTools.length).toBeGreaterThan(0);
  });
});
