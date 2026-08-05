import { basename, dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import type {
  AgentMessage,
  AgentMessageEvent,
  AskInteractionQuestion,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  HistorySnapshotEvent,
  McpServerDetail,
  PiHistoryEntry,
  PiMessagePart,
  PiRunState,
  PiUsage,
  SessionMessageHistoryPage,
  SessionState,
  ToolExecutionEvent,
  UserSpaceMount,
} from "../shared/pi-browser-protocol.js";
import type { SessionAuthoritySnapshot } from "./control-plane-types.js";
import { piworkBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { encodePiAskBatchResponse, parsePiAskBatchRequest } from "./pi-ask-interaction.js";
import { parsePiPlanRequest } from "./pi-plan-interaction.js";
import type {
  PiAdapter,
  PiBrowserIncomingMessage,
  PiBrowserOutgoingMessage,
} from "./pi-adapter.js";
import type { PiSessionInfo } from "./pi-launcher.js";
import type { PiReadinessResult } from "./pi-readiness.js";
import { PiSessionHistoryError, readPiSessionDocument } from "./pi-session-history.js";
import type { PersistedSession, SessionStore } from "./session-store.js";
import { SessionStateMachine, type SessionPhase } from "./session-state-machine.js";
import type { UserSpaceBroker } from "./user-space-broker.js";
import type { OnlyOfficeBroker } from "./onlyoffice-broker.js";
import type { RecorderManager } from "./recorder.js";
import {
  browserMessageByteLength,
  BROWSER_WS_MAX_MESSAGE_BYTES,
  deduplicateBrowserMessage,
  IDEMPOTENT_BROWSER_MESSAGE_TYPES,
  isUserMessageContentWithinLimit,
  parseBrowserMessage,
} from "./ws-bridge-browser-ingest.js";
import { handleSessionAck, handleSessionSubscribe } from "./ws-bridge-browser.js";
import { piSessionEntriesToHistory, usageFromPiMessage } from "./ws-bridge-history.js";
import { persistSession as persistSessionRecord } from "./ws-bridge-persist.js";
import { broadcastToBrowsers, sendToBrowser } from "./ws-bridge-publish.js";
import { isHistoryBackedEvent } from "./ws-bridge-replay.js";
import {
  makeDefaultState,
  type AttachPiSessionInfo,
  type BrowserSocketData,
  type Session,
} from "./ws-bridge-types.js";
import { normalizeOfflineUserSpace, publicUserSpaceFromMount } from "./user-space-session-state.js";

export type { BrowserSocketData, SocketData } from "./ws-bridge-types.js";

const PROCESSED_CLIENT_MESSAGE_LIMIT = 4_096;
const OFFLINE_QUEUE_LIMIT = 100;
const HISTORY_PAGE_MAX = 500;
const TRUSTED_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "ask",
  "todo_write",
  "task",
  "propose_plan",
] as const;
const IDLE_KILL_THRESHOLD_MS = 30 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

export type PiBridgeControlMessage = Exclude<
  BrowserOutgoingMessage,
  | { type: "agent_message" }
  | { type: "interaction_response" }
  | { type: "session_subscribe" }
  | { type: "session_ack" }
  | { type: "abort" }
  | { type: "compact" }
  | { type: "set_thinking_level" }
  | { type: "mcp_set_servers" }
  | { type: "update_environment_variables" }
  | { type: "user_space_mount" }
  | { type: "user_space_unmount" }
  | { type: "user_space_mutation_authorize" }
  | { type: "user_space_response" }
  | { type: "user_space_status" }
  | { type: "user_space_index_update" }
  | { type: "onlyoffice_status" }
  | { type: "onlyoffice_response" }
>;

export type PiBridgeControlHandler = (
  sessionId: string,
  message: PiBridgeControlMessage,
) => boolean | Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAskInteractionResponse(
  pending: {
    method: "select" | "confirm" | "input" | "editor";
    optionValues: Map<string, string>;
    askQuestions?: AskInteractionQuestion[];
    askBatch?: boolean;
  },
  message: Extract<BrowserOutgoingMessage, { type: "interaction_response"; kind: "ask" }>,
): { value: string } | { confirmed: boolean } | undefined {
  const questions = pending.askQuestions ?? [];
  const responseAnswers = message.answers ?? [];
  if (questions.length === 0 || responseAnswers.length !== questions.length) return undefined;
  const answersByQuestion = new Map(responseAnswers.map((answer) => [answer.questionId, answer]));
  if (answersByQuestion.size !== responseAnswers.length) return undefined;

  const resolved = questions.flatMap((question) => {
    const answer = answersByQuestion.get(question.id);
    if (!answer) return [];
    const selectedIds = [...new Set(answer.selectedOptionIds)];
    if (!question.allowMultiple && selectedIds.length > 1) return [];
    const optionValues = selectedIds.flatMap((optionId) => {
      const option = question.options.find((candidate) => candidate.id === optionId);
      return option ? [option.label] : [];
    });
    if (optionValues.length !== selectedIds.length) return [];
    const freeText = answer.freeText?.trim();
    if (!question.allowFreeText && freeText) return [];
    if (!question.allowMultiple && freeText && optionValues.length > 0) return [];
    const values = [...optionValues, ...(freeText ? [freeText] : [])];
    if (values.length === 0) return [];
    return [
      {
        question: question.question,
        answer: question.allowMultiple ? values : values[0]!,
        selectedIds,
        freeText,
      },
    ];
  });
  if (resolved.length !== questions.length) return undefined;

  if (pending.askBatch) {
    return {
      value: encodePiAskBatchResponse(
        resolved.map(({ question, answer }) => ({ question, answer })),
      ),
    };
  }
  const first = resolved[0]!;
  if (pending.method === "confirm") {
    return { confirmed: first.selectedIds.includes("confirm") };
  }
  const selected = first.selectedIds[0];
  const value = first.freeText ?? (selected ? pending.optionValues.get(selected) : undefined);
  return typeof value === "string" ? { value } : undefined;
}

function normalizedModel(
  model: { provider: string; id?: string; modelId?: string; key?: string } | undefined,
): SessionState["model"] | undefined {
  if (!model?.provider) return undefined;
  const modelId = model.modelId ?? model.id;
  if (!modelId) return undefined;
  return {
    key: model.key || `${model.provider}/${modelId}`,
    provider: model.provider,
    modelId,
  };
}

function commandNames(readiness: PiReadinessResult | undefined): string[] {
  if (!readiness) return [];
  return readiness.commands.flatMap((command) =>
    typeof command.name === "string" ? [command.name] : [],
  );
}

function readinessMcp(
  readiness: PiReadinessResult | undefined,
  existing: readonly McpServerDetail[] = [],
): McpServerDetail[] {
  if (!readiness) return [...existing];
  const prior = new Map(existing.map((server) => [server.name, server]));
  return readiness.mcp.map((server) => {
    const known = prior.get(server.name);
    return {
      name: server.name,
      enabled: server.status !== "disabled",
      status: server.status,
      config: known?.config ?? { type: "stdio" },
      scope: known?.scope ?? "agent",
      serverInfo: known?.serverInfo,
      error: known?.error,
      tools: known?.tools,
    };
  });
}

function usageFromReadiness(readiness: PiReadinessResult | undefined): PiUsage {
  const total: PiUsage = { inputTokens: 0, outputTokens: 0 };
  for (const entry of readiness?.history.entries ?? []) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const usage = usageFromPiMessage(entry.message.usage);
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    total.turns = (total.turns ?? 0) + 1;
  }
  return total;
}

function processRunState(info: PiSessionInfo, attached: boolean): PiRunState {
  if (info.archived || info.lifecycleState === "closed") return "stopped";
  if (!attached || info.state === "exited") return "disconnected";
  if (info.state === "starting") return "starting";
  return "ready";
}

function stateFromInfo(
  info: AttachPiSessionInfo,
  readiness: PiReadinessResult | undefined,
  prior?: SessionState,
  attached = false,
): SessionState {
  const effectiveReadiness = readiness ?? info.readiness;
  const model =
    normalizedModel(effectiveReadiness?.state.model) ?? normalizedModel(info.model) ?? prior?.model;
  const runState = effectiveReadiness?.state.isCompacting
    ? "compacting"
    : effectiveReadiness?.state.isStreaming
      ? "running"
      : processRunState(info, attached);
  return makeDefaultState(info.sessionId, {
    ...prior,
    model: model ?? {
      key: "unconfigured/unconfigured",
      provider: "unconfigured",
      modelId: "unconfigured",
    },
    thinkingLevel:
      effectiveReadiness?.state.thinkingLevel ??
      info.thinkingLevel ??
      prior?.thinkingLevel ??
      "off",
    mode: effectiveReadiness?.extension.mode ?? info.mode ?? prior?.mode ?? "agent",
    cwd: info.cwd || prior?.cwd || "",
    tools: prior?.tools.length ? prior.tools : [...TRUSTED_TOOLS],
    commands:
      commandNames(effectiveReadiness).length > 0
        ? commandNames(effectiveReadiness)
        : (prior?.commands ?? []),
    skills: prior?.skills ?? [],
    mcpServers: readinessMcp(effectiveReadiness, prior?.mcpServers),
    usage:
      effectiveReadiness !== undefined
        ? usageFromReadiness(effectiveReadiness)
        : (prior?.usage ?? { inputTokens: 0, outputTokens: 0 }),
    runState,
    isCompacting: runState === "compacting",
    generation: info.generation,
    userSpace: prior?.userSpace ?? null,
    userSpaces: prior?.userSpaces ?? [],
  });
}

function phaseForRunState(runState: PiRunState): SessionPhase {
  switch (runState) {
    case "starting":
      return "starting";
    case "ready":
      return "ready";
    case "running":
    case "settling":
      return "streaming";
    case "awaiting_interaction":
      return "awaiting_permission";
    case "compacting":
      return "compacting";
    case "reconnecting":
    case "disconnected":
      return "reconnecting";
    case "stopped":
    case "error":
      return "terminated";
  }
}

function messageParts(value: unknown): PiMessagePart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): PiMessagePart[] => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      return [{ type: "thinking", thinking: part.thinking }];
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      (typeof part.mimeType === "string" || typeof part.mediaType === "string")
    ) {
      return [
        {
          type: "image",
          data: part.data,
          mediaType: typeof part.mimeType === "string" ? part.mimeType : (part.mediaType as string),
        },
      ];
    }
    return [];
  });
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return "Pi tool execution failed.";
  }
}

function todosFromDetails(value: unknown): ToolExecutionEvent["todos"] {
  if (!isRecord(value) || !Array.isArray(value.todos)) return undefined;
  const result: NonNullable<ToolExecutionEvent["todos"]> = [];
  for (const todo of value.todos) {
    if (
      !isRecord(todo) ||
      typeof todo.id !== "string" ||
      (typeof todo.content !== "string" && typeof todo.text !== "string") ||
      !["pending", "in_progress", "completed"].includes(String(todo.status))
    ) {
      return undefined;
    }
    result.push({
      id: todo.id,
      content: typeof todo.content === "string" ? todo.content : (todo.text as string),
      status: todo.status as "pending" | "in_progress" | "completed",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
    });
  }
  return result;
}

export class WsBridge {
  private readonly sessions = new Map<string, Session>();
  private readonly idleKillTimers = new Map<string, ReturnType<typeof setInterval>>();
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private userSpaceBroker: UserSpaceBroker | null = null;
  private onlyOfficeBroker: OnlyOfficeBroker | null = null;
  private currentWorkspaceSessionResolver: (() => string | null | undefined) | null = null;
  private controlHandler: PiBridgeControlHandler | null = null;
  private injectedMessageCounter = 0;

  setStore(store: SessionStore): void {
    this.store = store;
  }

  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  setUserSpaceBroker(broker: UserSpaceBroker): void {
    this.userSpaceBroker = broker;
    broker.setSender((sessionId, message) => this.broadcastToSession(sessionId, message));
  }

  setOnlyOfficeBroker(broker: OnlyOfficeBroker): void {
    this.onlyOfficeBroker = broker;
    broker.setSender((socket, message) => sendToBrowser(socket, message));
  }

  setCurrentWorkspaceSessionResolver(resolver: () => string | null | undefined): void {
    this.currentWorkspaceSessionResolver = resolver;
  }

  setControlHandler(handler: PiBridgeControlHandler): void {
    this.controlHandler = handler;
  }

  restoreSession(info: AttachPiSessionInfo, persisted?: PersistedSession | null): Session {
    const existing = this.sessions.get(info.sessionId);
    if (existing) {
      existing.authority = persisted?.authority ?? existing.authority;
      existing.piSessionRelativePath =
        info.piSessionRelativePath ??
        persisted?.piSessionRelativePath ??
        existing.piSessionRelativePath;
      existing.archived = persisted?.archived ?? info.archived;
      existing.archivedAt = persisted?.archivedAt ?? info.archivedAt;
      if (info.readiness) existing.historyLeafId = info.readiness.history.leafId;
      existing.state = stateFromInfo(
        info,
        info.readiness,
        existing.state,
        Boolean(existing.piAdapter),
      );
      this.projectRunState(existing, existing.state.runState, "session_restore");
      return existing;
    }

    const state = stateFromInfo(info, info.readiness, undefined, false);
    const offlineQueue = (persisted?.offlineQueue ?? []).map((entry) => ({
      ...entry,
      message: {
        ...entry.message,
        content: entry.message.content.map((part) => ({ ...part })),
      },
    }));
    const processedClientMessageIds = [...(persisted?.processedClientMessageIds ?? [])];
    const storeDir = this.store?.getSessionDirectory(info.sessionId) ?? undefined;
    const inferredSessionDir = basename(info.cwd) === "workspace" ? dirname(info.cwd) : undefined;
    const historyEntries = info.readiness
      ? piSessionEntriesToHistory(
          info.readiness.history.entries,
          info.generation,
          info.readiness.history.leafId,
        )
      : [];
    const session: Session = {
      id: info.sessionId,
      authority: persisted?.authority,
      piAdapter: null,
      browserSockets: new Set(),
      state,
      offlineQueue,
      processedClientMessageIds,
      processedClientMessageIdSet: new Set(processedClientMessageIds),
      nextEventSeq: 1,
      eventBuffer: [],
      lastAckSeq: 0,
      piSessionRelativePath: info.piSessionRelativePath ?? persisted?.piSessionRelativePath,
      sessionDir: storeDir ?? inferredSessionDir,
      archived: persisted?.archived ?? info.archived,
      archivedAt: persisted?.archivedAt ?? info.archivedAt,
      interactionKinds: new Map(),
      toolStarts: new Map(),
      firstUserPromptSeen: historyEntries.some(
        (entry) => entry.event.type === "agent_message" && entry.event.message.role === "user",
      ),
      historyLeafId: info.readiness?.history.leafId,
      stateMachine: new SessionStateMachine(info.sessionId, phaseForRunState(state.runState)),
    };
    this.wireStateMachine(session);
    this.sessions.set(session.id, session);
    return session;
  }

  attachPiAdapter(
    info: AttachPiSessionInfo,
    adapter: PiAdapter,
    persisted?: PersistedSession | null,
    readiness?: PiReadinessResult,
  ): Session {
    if (adapter.sessionId !== info.sessionId || adapter.generation !== info.generation) {
      throw new Error("Pi adapter authority does not match the session generation.");
    }
    const session = this.restoreSession(
      { ...info, readiness: readiness ?? info.readiness },
      persisted,
    );
    const previous = session.piAdapter;
    if (previous && previous !== adapter) {
      void previous.disconnect().catch(() => undefined);
    }
    session.piAdapter = adapter;
    session.adapterGeneration = info.generation;
    session.state = stateFromInfo(info, readiness ?? info.readiness, session.state, true);
    session.piSessionRelativePath =
      info.piSessionRelativePath ??
      persisted?.piSessionRelativePath ??
      session.piSessionRelativePath;
    session.interactionKinds.clear();
    session.toolStarts.clear();

    const current = () =>
      session.piAdapter === adapter &&
      session.adapterGeneration === adapter.generation &&
      session.state.generation === adapter.generation;
    adapter.onBrowserMessage((message) => {
      if (current()) this.handlePiAdapterMessage(session, message);
    });
    adapter.onSessionMeta((meta) => {
      if (!current()) return;
      if (meta.sessionId && meta.sessionId !== session.id) {
        this.publishError(
          session,
          "pi_session_mismatch",
          "Pi reported a different session identity.",
          false,
        );
        return;
      }
      if (meta.model) {
        session.state.model = meta.model;
        this.broadcastToSession(session.id, {
          type: "session_update",
          session: { model: meta.model, generation: session.state.generation },
        });
      }
    });
    adapter.onExtensionStatus((status) => {
      if (current()) this.handleExtensionStatus(session, status);
    });
    adapter.onInitError((error) => {
      if (!current()) return;
      this.publishError(session, "pi_runtime_error", error, true);
      this.publishRunState(session, "error", error);
    });
    adapter.onDisconnect(() => {
      if (current()) this.detachPiAdapter(session.id, adapter.generation);
    });

    this.projectRunState(session, session.state.runState, "pi_attached");
    persistSessionRecord(session, this.store);
    this.broadcastToSession(session.id, {
      type: "session_init",
      session: session.state,
    });
    this.flushOfflineQueue(session);
    return session;
  }

  detachPiAdapter(sessionId: string, generation: number): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.adapterGeneration !== generation ||
      session.state.generation !== generation
    ) {
      return false;
    }
    session.piAdapter = null;
    delete session.adapterGeneration;
    session.interactionKinds.clear();
    session.toolStarts.clear();
    if (session.state.runState !== "stopped") {
      this.publishRunState(session, "disconnected", "Pi process disconnected.");
    }
    return true;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return [...this.sessions.values()].map((session) => session.state);
  }

  getSessionPhase(sessionId: string): SessionPhase | null {
    return this.sessions.get(sessionId)?.stateMachine.phase ?? null;
  }

  getSessionPhases(): Map<string, SessionPhase> {
    return new Map([...this.sessions].map(([id, session]) => [id, session.stateMachine.phase]));
  }

  getSessionMemoryStats(): {
    id: string;
    browsers: number;
    historyLen: number;
    eventBufferLen: number;
    pendingMsgs: number;
  }[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      browsers: session.browserSockets.size,
      historyLen: 0,
      eventBufferLen: session.eventBuffer.length,
      pendingMsgs: session.offlineQueue.length,
    }));
  }

  setSessionAuthority(sessionId: string, authority: SessionAuthoritySnapshot): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.authority = authority;
    persistSessionRecord(session, this.store);
    return true;
  }

  setSessionNameSource(sessionId: string, source: "manual" | "generated"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.nameSource = source;
    persistSessionRecord(session, this.store);
    return true;
  }

  setUserSpaces(sessionId: string, mounts: UserSpaceMount[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const normalized = this.userSpaceBroker
      ? this.userSpaceBroker.updateMounts(sessionId, mounts)
      : mounts;
    const userSpace =
      this.userSpaceBroker?.getActiveUserSpace(sessionId) ??
      publicUserSpaceFromMount(normalized[0]);
    session.state.userSpace = userSpace;
    session.state.userSpaces = normalized;
    this.broadcastToSession(sessionId, {
      type: "session_update",
      session: { userSpace, userSpaces: normalized },
    });
  }

  broadcastToSession(sessionId: string, message: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    broadcastToBrowsers(session, message, { recorder: this.recorder });
  }

  broadcastNameUpdate(sessionId: string, name: string): void {
    this.broadcastToSession(sessionId, {
      type: "session_name_update",
      name,
    });
  }

  broadcastLifecycleUpdate(sessionId: string, lifecycleState: "enabled" | "closed"): void {
    this.broadcastToSession(sessionId, {
      type: "session_lifecycle_update",
      sessionId,
      lifecycleState,
    });
  }

  handleBrowserOpen(socket: ServerWebSocket<BrowserSocketData>, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || socket.data.sessionId !== sessionId) {
      try {
        socket.close(1008, "Unknown session");
      } catch {}
      return;
    }
    metricsCollector.recordWsConnection("browser", "open");
    this.recorder?.recordEvent(sessionId, "ws_open", "browser");
    this.stopIdleKillWatchdog(sessionId);
    socket.data.subscribed = false;
    socket.data.lastAckSeq = 0;
    session.browserSockets.add(socket);
    sendToBrowser(socket, { type: "session_init", session: session.state });
    if (!session.piAdapter?.isConnected() && session.state.runState !== "stopped") {
      sendToBrowser(socket, {
        type: "run_state",
        state: "disconnected",
        generation: session.state.generation,
        timestamp: Date.now(),
        usage: session.state.usage,
      });
      if (session.offlineQueue.length > 0) {
        piworkBus.emit("session:relaunch-needed", {
          sessionId,
          reason: "queued_message",
        });
      }
    }
  }

  handleBrowserMessage(socket: ServerWebSocket<BrowserSocketData>, raw: string | Buffer): void {
    const session = this.sessions.get(socket.data.sessionId);
    if (!session || !session.browserSockets.has(socket)) return;
    const bytes = browserMessageByteLength(raw);
    if (bytes > BROWSER_WS_MAX_MESSAGE_BYTES) {
      try {
        socket.close(1009, "Browser message exceeds the configured byte limit");
      } catch {}
      return;
    }
    const data = typeof raw === "string" ? raw : raw.toString("utf8");
    this.recorder?.record(session.id, "in", data, "browser", "pi", session.state.cwd);
    const message = parseBrowserMessage(data, socket.data);
    if (!message) return;
    void this.routeBrowserMessage(session, message, socket);
  }

  handleBrowserClose(socket: ServerWebSocket<BrowserSocketData>): void {
    const session = this.sessions.get(socket.data.sessionId);
    metricsCollector.recordWsConnection("browser", "close");
    this.recorder?.recordEvent(socket.data.sessionId, "ws_close", "browser");
    if (!session) return;
    this.onlyOfficeBroker?.removeSocket(session.id, socket);
    session.browserSockets.delete(socket);
    if (session.browserSockets.size > 0) return;
    const mounts = this.userSpaceBroker?.markOffline(session.id);
    if (mounts) {
      const userSpace =
        this.userSpaceBroker?.getActiveUserSpace(session.id) ??
        normalizeOfflineUserSpace(publicUserSpaceFromMount(mounts[0]));
      session.state.userSpace = userSpace;
      session.state.userSpaces = mounts;
    }
    this.startIdleKillWatchdog(session.id);
  }

  injectUserMessage(sessionId: string, content: string | AgentMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const timestamp = Date.now();
    const message: AgentMessage =
      typeof content === "string"
        ? {
            id: `injected-${timestamp}-${this.injectedMessageCounter++}`,
            role: "user",
            content: [{ type: "text", text: content }],
            timestamp,
          }
        : {
            ...content,
            content: content.content.map((part) => ({ ...part })),
          };
    const text = message.content
      .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (message.role !== "user" || !isUserMessageContentWithinLimit(text)) {
      return false;
    }
    return this.acceptAgentMessage(
      session,
      {
        type: "agent_message",
        generation: session.state.generation,
        message,
        clientMsgId: message.id,
      },
      true,
    );
  }

  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.piAdapter?.isConnected()) return false;
    return session.piAdapter.send({ type: "abort" });
  }

  async getMessageHistoryPage(
    sessionId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<SessionMessageHistoryPage | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const entries = await this.readHistory(session);
    const cursor = Math.max(0, Math.floor(options.cursor ?? 0));
    const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(options.limit ?? 50)));
    const page = entries.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      sessionId,
      total: entries.length,
      cursor,
      nextCursor,
      hasMore: nextCursor < entries.length,
      start: cursor,
      end: nextCursor,
      entries: page,
    };
  }

  async firstUserMessage(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const entries = await this.readHistory(session);
    for (const entry of entries) {
      if (entry.event.type !== "agent_message" || entry.event.message.role !== "user") {
        continue;
      }
      const text = entry.event.message.content
        .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return null;
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.stopIdleKillWatchdog(sessionId);
    this.publishRunState(session, "stopped", "Session closed.");
    this.broadcastLifecycleUpdate(sessionId, "closed");
    session.unsubscribeStateMachine?.();
    session.unsubscribeStateMachine = undefined;
    const adapter = session.piAdapter;
    session.piAdapter = null;
    if (adapter) void adapter.disconnect().catch(() => undefined);
    for (const socket of session.browserSockets) {
      try {
        socket.close(1000, "Session closed");
      } catch {}
    }
    session.browserSockets.clear();
    this.userSpaceBroker?.removeSession(sessionId);
    this.recorder?.stopRecording(sessionId);
    this.sessions.delete(sessionId);
    this.store?.remove(sessionId);
  }

  async dispose(): Promise<void> {
    for (const timer of this.idleKillTimers.values()) clearInterval(timer);
    this.idleKillTimers.clear();
    const disconnects: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      session.unsubscribeStateMachine?.();
      if (session.piAdapter) {
        disconnects.push(session.piAdapter.disconnect().catch(() => undefined));
      }
      for (const socket of session.browserSockets) {
        try {
          socket.close(1001, "Runtime shutting down");
        } catch {}
      }
      session.browserSockets.clear();
    }
    this.sessions.clear();
    this.currentWorkspaceSessionResolver = null;
    this.controlHandler = null;
    this.userSpaceBroker = null;
    this.onlyOfficeBroker = null;
    this.recorder = null;
    this.store = null;
    await Promise.allSettled(disconnects);
  }

  private wireStateMachine(session: Session): void {
    session.unsubscribeStateMachine?.();
    session.unsubscribeStateMachine = session.stateMachine.onTransition((event) => {
      piworkBus.emit("session:phase-changed", {
        sessionId: event.sessionId,
        from: event.from,
        to: event.to,
        trigger: event.trigger,
      });
    });
  }

  private projectRunState(session: Session, runState: PiRunState, trigger: string): void {
    const target = phaseForRunState(runState);
    let current = session.stateMachine.phase;
    if (current === target) return;
    if (current === "terminated" && target !== "starting") {
      session.stateMachine.transition("starting", `${trigger}_restart`);
      current = session.stateMachine.phase;
    }
    if (
      current === "starting" &&
      (target === "ready" || target === "awaiting_permission" || target === "compacting")
    ) {
      session.stateMachine.transition("initializing", `${trigger}_initialize`);
      current = session.stateMachine.phase;
    }
    if (
      current === "initializing" &&
      (target === "awaiting_permission" || target === "compacting")
    ) {
      session.stateMachine.transition("streaming", `${trigger}_stream`);
      current = session.stateMachine.phase;
    }
    if (!session.stateMachine.transition(target, trigger)) {
      session.stateMachine.forceState(target);
    }
  }

  private publishRunState(
    session: Session,
    runState: PiRunState,
    reason?: string,
    detail?: Extract<BrowserIncomingMessage, { type: "run_state" }>["detail"],
  ): void {
    session.state.runState = runState;
    session.state.isCompacting = runState === "compacting";
    this.projectRunState(session, runState, `pi_${runState}`);
    const event: BrowserIncomingMessage = {
      type: "run_state",
      state: runState,
      generation: session.state.generation,
      timestamp: Date.now(),
      reason,
      detail,
      usage: session.state.usage,
    };
    this.broadcastToSession(session.id, event);
    if (runState === "ready") {
      piworkBus.emit("message:result", {
        sessionId: session.id,
        message: event,
      });
    }
  }

  private publishError(session: Session, code: string, message: string, retryable: boolean): void {
    this.broadcastToSession(session.id, {
      type: "error",
      code,
      message,
      retryable,
    });
  }

  private handleExtensionStatus(session: Session, value: unknown): void {
    if (!isRecord(value)) return;
    const update: Partial<SessionState> = {};
    if (value.mode === "agent" || value.mode === "plan") {
      session.state.mode = value.mode;
      update.mode = value.mode;
    }
    if (Array.isArray(value.mcp)) {
      const statuses = new Map(
        value.mcp.flatMap((item) =>
          isRecord(item) && typeof item.name === "string" && typeof item.enabled === "boolean"
            ? [[item.name, item.enabled] as const]
            : [],
        ),
      );
      session.state.mcpServers = session.state.mcpServers.map((server) => {
        const enabled = statuses.get(server.name);
        return enabled === undefined
          ? server
          : {
              ...server,
              enabled,
              status: enabled ? server.status : ("disabled" as const),
            };
      });
      update.mcpServers = session.state.mcpServers;
    }
    if (Object.keys(update).length > 0) {
      this.broadcastToSession(session.id, {
        type: "session_update",
        session: update,
      });
    }
  }

  private handlePiAdapterMessage(session: Session, message: PiBrowserIncomingMessage): void {
    metricsCollector.recordMessageProcessed(message.type);
    const generation = session.state.generation;
    switch (message.type) {
      case "agent_message": {
        const role =
          message.message.role === "user" ||
          message.message.role === "system" ||
          message.message.role === "assistant"
            ? message.message.role
            : "system";
        const normalized: AgentMessageEvent = {
          type: "agent_message",
          generation,
          message: {
            id: message.message.id,
            role,
            content: messageParts(message.message.content),
            timestamp: message.message.timestamp ?? Date.now(),
            model:
              message.message.provider && message.message.modelId
                ? {
                    key: `${message.message.provider}/${message.message.modelId}`,
                    provider: message.message.provider,
                    modelId: message.message.modelId,
                  }
                : undefined,
            stopReason: message.message.stopReason ?? null,
            ...(message.message.error ? { error: message.message.error } : {}),
          },
        };
        const nextUsage = usageFromPiMessage(message.message.usage);
        if (nextUsage) {
          session.state.usage = {
            ...session.state.usage,
            ...nextUsage,
            turns: (session.state.usage.turns ?? 0) + 1,
          };
        }
        this.broadcastToSession(session.id, normalized);
        if (role === "assistant") {
          piworkBus.emit("message:assistant", {
            sessionId: session.id,
            message: normalized,
          });
        }
        return;
      }
      case "message_delta":
        this.broadcastToSession(session.id, {
          type: "message_delta",
          generation,
          messageId: message.message_id,
          role: "assistant",
          delta: {
            kind: message.delta_kind === "tool_call" ? "tool_arguments" : message.delta_kind,
            contentIndex: message.content_index ?? 0,
            delta: message.delta,
          },
          timestamp: Date.now(),
        });
        return;
      case "tool_execution": {
        const now = Date.now();
        if (message.phase === "start") {
          session.toolStarts.set(message.tool_call_id, {
            toolName: message.tool_name,
            input: message.args,
            startedAt: now,
          });
        }
        const start = session.toolStarts.get(message.tool_call_id);
        const result = isRecord(message.result) ? message.result : undefined;
        const details = result && isRecord(result.details) ? result.details : result;
        const event: ToolExecutionEvent = {
          type: "tool_execution",
          generation,
          toolCallId: message.tool_call_id,
          toolName: message.tool_name,
          status:
            message.phase === "start"
              ? "started"
              : message.phase === "update"
                ? "running"
                : message.is_error
                  ? "failed"
                  : "completed",
          timestamp: now,
          input: message.args ?? start?.input,
          output: message.phase === "update" ? message.result : message.result,
          error: message.is_error ? errorText(message.result) : undefined,
          elapsedMs: start ? Math.max(0, now - start.startedAt) : undefined,
          progress: details && typeof details.progress === "string" ? details.progress : undefined,
          todos: message.tool_name === "todo_write" ? todosFromDetails(details) : undefined,
          task:
            message.tool_name === "task" &&
            details &&
            typeof details.taskId === "string" &&
            typeof details.name === "string" &&
            ["running", "completed", "failed", "stopped"].includes(String(details.status))
              ? {
                  taskId: details.taskId,
                  name: details.name,
                  description:
                    typeof details.description === "string" ? details.description : undefined,
                  execution: details.execution === "background" ? "background" : "foreground",
                  status: details.status as "running" | "completed" | "failed" | "stopped",
                  depth: typeof details.depth === "number" ? details.depth : 0,
                  progress: typeof details.progress === "string" ? details.progress : undefined,
                }
              : undefined,
        };
        if (message.phase === "end") {
          session.toolStarts.delete(message.tool_call_id);
        }
        this.broadcastToSession(session.id, event);
        return;
      }
      case "interaction_request": {
        if (
          message.method !== "select" &&
          message.method !== "confirm" &&
          message.method !== "input" &&
          message.method !== "editor"
        ) {
          return;
        }
        const batchAsk =
          message.method === "select"
            ? parsePiAskBatchRequest(message.title, message.options)
            : undefined;
        const planRequest =
          !batchAsk && message.method === "select"
            ? parsePiPlanRequest(message.title, message.options)
            : undefined;
        const isPlan = Boolean(planRequest);
        const optionValues = new Map<string, string>();
        const options =
          message.method === "confirm"
            ? [
                { id: "confirm", label: "Confirm" },
                { id: "cancel", label: "Cancel" },
              ]
            : message.options?.map((label, index) => {
                const id = `option-${index}`;
                optionValues.set(id, label);
                const action =
                  label === "__free_text__"
                    ? ("free_text" as const)
                    : label === "__done__"
                      ? ("done" as const)
                      : undefined;
                return {
                  id,
                  label: action ? "" : label,
                  ...(action ? { action } : {}),
                };
              });
        const askQuestions: AskInteractionQuestion[] | undefined = batchAsk
          ? batchAsk.questions.map((question, questionIndex) => ({
              id: `question-${questionIndex}`,
              header: question.header,
              question: question.question,
              options: question.options.map((option, optionIndex) => ({
                id: `question-${questionIndex}-option-${optionIndex}`,
                label: option.label,
                description: option.description,
              })),
              allowMultiple: question.multiSelect,
              allowFreeText: true,
            }))
          : !isPlan
            ? [
                {
                  id: "question-0",
                  question: message.message ?? message.title ?? message.prefill ?? "",
                  options: options ?? [],
                  allowMultiple: false,
                  allowFreeText: message.method === "input" || message.method === "editor",
                },
              ]
            : undefined;
        if (message.method === "confirm") {
          optionValues.set("confirm", "true");
          optionValues.set("cancel", "false");
        }
        const kind = isPlan ? "propose_plan" : "ask";
        session.interactionKinds.set(message.request_id, {
          kind,
          method: message.method,
          optionValues,
          askQuestions,
          askBatch: Boolean(batchAsk),
        });
        this.publishRunState(session, "awaiting_interaction");
        this.broadcastToSession(session.id, {
          type: "interaction_request",
          generation,
          request: isPlan
            ? {
                id: message.request_id,
                kind: "propose_plan",
                toolCallId: planRequest?.toolCallId ?? message.request_id,
                plan: planRequest?.plan ?? "",
                timeoutAt: message.timeout_ms ? Date.now() + message.timeout_ms : undefined,
              }
            : {
                id: message.request_id,
                kind: "ask",
                toolCallId: batchAsk?.toolCallId ?? message.request_id,
                title: batchAsk ? undefined : message.title,
                questions: askQuestions ?? [],
                timeoutAt: message.timeout_ms ? Date.now() + message.timeout_ms : undefined,
              },
          timestamp: Date.now(),
        });
        return;
      }
      case "run_state": {
        const state: PiRunState =
          message.state === "idle" || message.state === "aborted"
            ? "ready"
            : message.state === "retrying"
              ? "running"
              : message.state;
        this.publishRunState(
          session,
          state,
          typeof message.detail === "string" ? message.detail : undefined,
          typeof message.detail === "object" && message.detail !== null
            ? (message.detail as Extract<BrowserIncomingMessage, { type: "run_state" }>["detail"])
            : undefined,
        );
        return;
      }
      case "history_snapshot": {
        session.historyLeafId = message.leaf_id;
        const entries = piSessionEntriesToHistory(message.entries, generation, message.leaf_id);
        this.broadcastToSession(session.id, {
          type: "history_snapshot",
          generation,
          entries,
          total: entries.length,
          cursor: 0,
          nextCursor: entries.length,
          hasMore: false,
          reason: "recovery",
        });
        return;
      }
      case "history_leaf":
        session.historyLeafId = message.leaf_id;
        return;
      case "pi_state": {
        if (message.sessionId && message.sessionId !== session.id) {
          this.publishError(
            session,
            "pi_session_mismatch",
            "Pi reported a different session identity.",
            false,
          );
          return;
        }
        const update: Partial<SessionState> = {};
        if (message.model) {
          session.state.model = message.model;
          update.model = message.model;
        }
        if (message.thinkingLevel) {
          session.state.thinkingLevel = message.thinkingLevel;
          update.thinkingLevel = message.thinkingLevel;
        }
        const nextUsage = usageFromPiMessage(message.usage);
        if (nextUsage) {
          session.state.usage = { ...session.state.usage, ...nextUsage };
          update.usage = session.state.usage;
        }
        if (Object.keys(update).length > 0) {
          this.broadcastToSession(session.id, {
            type: "session_update",
            session: update,
          });
        }
        return;
      }
      case "extension_event":
        this.broadcastToSession(session.id, {
          type: "pi_extension_event",
          generation,
          event: message.event,
          payload: message.payload,
          timestamp: Date.now(),
        });
        if (message.event === "error") {
          this.publishError(
            session,
            "pi_extension_error",
            errorText(message.payload.error) ?? "Pi extension failed.",
            false,
          );
        }
        return;
      case "queue_update":
        this.broadcastToSession(session.id, {
          type: "pi_queue",
          generation,
          steering: message.steering,
          followUp: message.follow_up,
          timestamp: Date.now(),
        });
        return;
    }
  }

  private async routeBrowserMessage(
    session: Session,
    message: BrowserOutgoingMessage,
    socket?: ServerWebSocket<BrowserSocketData>,
  ): Promise<void> {
    if (message.type === "session_subscribe") {
      await handleSessionSubscribe(
        session,
        socket,
        message.lastSeq,
        sendToBrowser,
        (reason) => this.historySnapshot(session, reason),
        isHistoryBackedEvent,
      );
      return;
    }
    if (message.type === "session_ack") {
      handleSessionAck(session, socket, message.lastSeq);
      return;
    }
    if (
      "generation" in message &&
      message.generation !== undefined &&
      message.generation !== session.state.generation
    ) {
      this.publishError(
        session,
        "stale_generation",
        "The browser message belongs to an inactive Pi generation.",
        false,
      );
      return;
    }
    if (
      deduplicateBrowserMessage(
        message,
        IDEMPOTENT_BROWSER_MESSAGE_TYPES,
        session,
        PROCESSED_CLIENT_MESSAGE_LIMIT,
        (value) => persistSessionRecord(value, this.store),
      )
    ) {
      return;
    }

    if (message.type === "user_space_mutation_authorize") {
      if (!socket || !session.browserSockets.has(socket)) return;
      try {
        const authorization = this.userSpaceBroker?.authorizeMutationCommit(
          session.id,
          message.request_id,
          socket,
        );
        if (!authorization) throw new Error("User Space broker is unavailable.");
        sendToBrowser(socket, {
          type: "user_space_mutation_authorization",
          request_id: message.request_id,
          ok: true,
          commit_lease: authorization.commitLease,
          runtime_epoch: authorization.runtimeEpoch,
        });
      } catch (error) {
        sendToBrowser(socket, {
          type: "user_space_mutation_authorization",
          request_id: message.request_id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (message.type === "user_space_mount" || message.type === "user_space_status") {
      this.setUserSpaces(session.id, message.mounts ?? []);
      return;
    }
    if (message.type === "user_space_unmount") {
      const mounts = this.userSpaceBroker?.unmount(session.id, message.mountId) ?? [];
      this.setUserSpaces(session.id, mounts);
      return;
    }
    if (message.type === "user_space_index_update") {
      const mounts =
        this.userSpaceBroker?.updateIndex(
          session.id,
          message.mountId,
          message.fileCount,
          message.lastIndexedAt,
        ) ??
        session.state.userSpaces ??
        [];
      this.setUserSpaces(session.id, mounts);
      return;
    }
    if (message.type === "user_space_response") {
      if (!socket || !session.browserSockets.has(socket)) return;
      this.userSpaceBroker?.handleResponse(
        session.id,
        message.request_id,
        message.ok,
        message.result,
        message.error,
        socket,
        message.commit_lease,
        message.runtime_epoch,
      );
      return;
    }
    if (message.type === "onlyoffice_status") {
      if (socket && session.browserSockets.has(socket)) {
        this.onlyOfficeBroker?.updateStatus(session.id, message, socket);
      }
      return;
    }
    if (message.type === "onlyoffice_response") {
      if (socket && session.browserSockets.has(socket)) {
        this.onlyOfficeBroker?.resolveResponse(
          session.id,
          message.request_id,
          socket,
          message.ok,
          message.result,
          message.error,
        );
      }
      return;
    }
    if (message.type === "agent_message") {
      this.acceptAgentMessage(session, message, false);
      return;
    }
    if (message.type === "interaction_response") {
      this.acceptInteractionResponse(session, message);
      return;
    }
    if (message.type === "abort") {
      if (!session.piAdapter?.send({ type: "abort" })) {
        this.publishError(session, "pi_not_connected", "Pi is not connected.", true);
      }
      return;
    }
    if (message.type === "compact") {
      if (!session.piAdapter?.send({ type: "compact" })) {
        this.publishError(session, "pi_not_connected", "Pi is not connected.", true);
      }
      return;
    }
    if (message.type === "set_model") {
      const accepted = this.controlHandler ? await this.controlHandler(session.id, message) : false;
      if (!accepted) {
        this.publishError(
          session,
          "model_policy_denied",
          "The requested Pi model is unavailable under current policy.",
          false,
        );
      }
      return;
    }
    if (message.type === "set_thinking_level") {
      if (
        !session.piAdapter?.send({
          type: "set_thinking",
          level: message.thinkingLevel,
        })
      ) {
        this.publishError(session, "pi_not_connected", "Pi is not connected.", true);
      }
      return;
    }
    if (message.type === "mcp_get_status" && !this.controlHandler) {
      this.broadcastToSession(session.id, {
        type: "mcp_status",
        servers: session.state.mcpServers,
      });
      return;
    }
    const accepted = this.controlHandler
      ? await this.controlHandler(session.id, message as PiBridgeControlMessage)
      : false;
    if (!accepted) {
      this.publishError(
        session,
        "unsupported_pi_control",
        "The requested Pi control is unavailable.",
        true,
      );
    }
  }

  private acceptAgentMessage(
    session: Session,
    event: Extract<BrowserOutgoingMessage, { type: "agent_message" }>,
    alreadyDeduplicated: boolean,
  ): boolean {
    const id = event.clientMsgId ?? event.message.id;
    if (
      !alreadyDeduplicated &&
      isUserMessageContentWithinLimit(
        event.message.content
          .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ) === false
    ) {
      return false;
    }
    metricsCollector.recordTurnStarted(session.id);
    const browserEvent: AgentMessageEvent = {
      type: "agent_message",
      generation: session.state.generation,
      message: event.message,
    };
    this.broadcastToSession(session.id, browserEvent);
    if (!session.firstUserPromptSeen) {
      const firstText = event.message.content
        .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (firstText) {
        session.firstUserPromptSeen = true;
        piworkBus.emit("session:user-prompt-received", {
          sessionId: session.id,
          firstUserMessage: firstText,
        });
      }
    }
    const outgoing = this.toPiAgentMessage(event.message);
    if (session.piAdapter?.isConnected() && session.piAdapter.send(outgoing)) {
      this.publishRunState(session, "running");
      return true;
    }
    if (session.offlineQueue.length >= OFFLINE_QUEUE_LIMIT) {
      this.publishError(session, "offline_queue_full", "The Pi offline queue is full.", true);
      return false;
    }
    if (!session.offlineQueue.some((entry) => entry.clientMessageId === id)) {
      session.offlineQueue.push({
        clientMessageId: id,
        message: event.message,
        queuedAt: Date.now(),
      });
      persistSessionRecord(session, this.store);
    }
    this.publishRunState(session, "disconnected", "Pi is not connected.");
    piworkBus.emit("session:relaunch-needed", {
      sessionId: session.id,
      reason: "queued_message",
    });
    return true;
  }

  private toPiAgentMessage(message: AgentMessage): PiBrowserOutgoingMessage {
    return {
      type: "agent_message",
      content: message.content
        .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      images: message.content.flatMap((part) =>
        part.type === "image"
          ? [
              {
                type: "image" as const,
                data: part.data,
                mimeType: part.mediaType,
              },
            ]
          : [],
      ),
      client_msg_id: message.id,
    };
  }

  private acceptInteractionResponse(
    session: Session,
    message: Extract<BrowserOutgoingMessage, { type: "interaction_response" }>,
  ): boolean {
    const pending = session.interactionKinds.get(message.requestId);
    if (!pending || pending.kind !== message.kind) {
      this.publishError(
        session,
        "stale_interaction",
        "The interaction is no longer active.",
        false,
      );
      return false;
    }
    let outgoing: PiBrowserOutgoingMessage;
    if (message.status !== "submitted") {
      outgoing = {
        type: "interaction_response",
        request_id: message.requestId,
        cancelled: true,
      };
    } else {
      if (
        message.kind === "propose_plan" &&
        message.decision === "refine" &&
        !message.refinement?.trim()
      ) {
        this.publishError(
          session,
          "invalid_interaction_response",
          "The interaction response is incomplete.",
          false,
        );
        return false;
      }
      const askResponse =
        message.kind === "ask" ? resolveAskInteractionResponse(pending, message) : undefined;
      if (message.kind === "ask" && !askResponse) {
        this.publishError(
          session,
          "invalid_interaction_response",
          "The interaction response is incomplete.",
          false,
        );
        return false;
      }
      if (askResponse && "confirmed" in askResponse) {
        outgoing = {
          type: "interaction_response",
          request_id: message.requestId,
          confirmed: askResponse.confirmed,
        };
      } else {
        const value =
          message.kind === "propose_plan"
            ? message.decision === "refine"
              ? JSON.stringify({
                  decision: "refine",
                  refinement: message.refinement?.trim(),
                })
              : message.decision
            : askResponse && "value" in askResponse
              ? askResponse.value
              : undefined;
        if (typeof value !== "string") {
          this.publishError(
            session,
            "invalid_interaction_response",
            "The interaction response is incomplete.",
            false,
          );
          return false;
        }
        outgoing = {
          type: "interaction_response",
          request_id: message.requestId,
          value,
        };
      }
    }
    if (!session.piAdapter?.send(outgoing)) {
      this.publishError(session, "pi_not_connected", "Pi is not connected.", true);
      return false;
    }
    session.interactionKinds.delete(message.requestId);
    this.broadcastToSession(session.id, {
      ...message,
      generation: session.state.generation,
      timestamp: message.timestamp ?? Date.now(),
    });
    this.publishRunState(session, "running");
    return true;
  }

  private flushOfflineQueue(session: Session): void {
    const adapter = session.piAdapter;
    if (!adapter?.isConnected()) return;
    let delivered = 0;
    while (session.offlineQueue.length > 0) {
      const entry = session.offlineQueue[0]!;
      if (!adapter.send(this.toPiAgentMessage(entry.message))) break;
      session.offlineQueue.shift();
      delivered += 1;
    }
    if (delivered > 0) {
      persistSessionRecord(session, this.store);
      this.publishRunState(session, "running");
    }
  }

  private async readHistory(session: Session): Promise<PiHistoryEntry[]> {
    if (!session.sessionDir || !session.piSessionRelativePath) return [];
    const options = {
      sessionDir: session.sessionDir,
      piSessionRelativePath: session.piSessionRelativePath,
      expectedPiSessionId: session.id,
      expectedCwd: session.state.cwd || undefined,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const document = await readPiSessionDocument(options);
        return piSessionEntriesToHistory(
          document.entries,
          session.state.generation,
          session.historyLeafId ?? document.entries.at(-1)?.id,
        );
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof PiSessionHistoryError &&
          error.code === "file_changed"
        ) {
          continue;
        }
        if (error instanceof PiSessionHistoryError && error.code === "not_found") {
          return [];
        }
        throw error;
      }
    }
    return [];
  }

  private async historySnapshot(
    session: Session,
    reason: HistorySnapshotEvent["reason"],
  ): Promise<HistorySnapshotEvent> {
    const entries = await this.readHistory(session);
    const page = entries.slice(0, HISTORY_PAGE_MAX);
    return {
      type: "history_snapshot",
      generation: session.state.generation,
      entries: page,
      total: entries.length,
      cursor: 0,
      nextCursor: page.length,
      hasMore: page.length < entries.length,
      reason,
    };
  }

  private startIdleKillWatchdog(sessionId: string): void {
    if (this.idleKillTimers.has(sessionId)) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const session = this.sessions.get(sessionId);
      if (!session || session.browserSockets.size > 0) {
        this.stopIdleKillWatchdog(sessionId);
        return;
      }
      if (this.currentWorkspaceSessionResolver?.() === sessionId) return;
      if (
        session.state.runState === "running" ||
        session.state.runState === "awaiting_interaction" ||
        session.state.runState === "compacting"
      ) {
        return;
      }
      if (Date.now() - startedAt < IDLE_KILL_THRESHOLD_MS) return;
      this.stopIdleKillWatchdog(sessionId);
      piworkBus.emit("session:idle-kill", { sessionId });
    }, IDLE_CHECK_INTERVAL_MS);
    timer.unref?.();
    this.idleKillTimers.set(sessionId, timer);
  }

  private stopIdleKillWatchdog(sessionId: string): void {
    const timer = this.idleKillTimers.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.idleKillTimers.delete(sessionId);
  }
}
