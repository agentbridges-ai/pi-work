import { useStore } from "./store.js";
import type {
  AgentMessage,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  ChatMessage,
  PiHistoryEntry,
  PiMessagePart,
  PiSessionInfo,
  ToolExecutionEvent,
  UserSpaceOperation,
} from "./types.js";
import { isPlaceholderSessionName } from "./utils/names.js";
import { getPreview } from "./components/ToolBlock.js";
import type { ToolActivityEntry } from "./store/tasks-slice.js";
import {
  executeUserSpaceOperation,
  handleUserSpaceBlobCheckinRequest,
  handleUserSpaceBlobCheckoutRequest,
  resendSessionUserSpaces,
  setUserSpaceTransport,
  syncSessionUserSpaces,
} from "./user-space.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { WS_PROTOCOL_VERSION, type WsEnvelope } from "../shared/api-contracts.js";
import { isBrowserIncomingMessage, isRecord } from "./ws-message-validation.js";
import {
  attachOnlyOfficeTransport,
  handleOnlyOfficeBrowserRequest,
} from "./onlyoffice-browser-executor.js";
import {
  extractTextFromParts,
  mergeAgentMessage,
  mergeChronologicalMessages,
} from "./ws-message-history.js";
import { WsConnectionRegistry, type WsRuntimeContextIdentity } from "./ws-connection-registry.js";
import { api } from "./api.js";
import { userSpaceOperationRequiresMutationCommit } from "../shared/user-space-mutation-policy.js";
import { uiCopy } from "./ui-copy.js";

const WS_RECONNECT_DELAY_MS = 2_000;
const WORKBENCH_HISTORY_PAGE_SIZE = 200;
const MAX_PENDING_OUTGOING_PER_SESSION = 128;
const MAX_PENDING_OUTGOING_SESSIONS = 128;
const connections = new WsConnectionRegistry();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectScopeDetachers = new Map<string, () => void>();
const lastSeqBySession = new Map<string, number>();
const pendingOutgoingBySession = new Map<string, BrowserOutgoingMessage[]>();
const streamingDraftMessageIdBySession = new Map<string, string>();
const streamingPartsBySession = new Map<string, { text: string; thinking: string }>();

interface HistoryState {
  cursor?: string;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error?: string;
}
const historyPagingBySession = new Map<string, HistoryState>();

interface HistoryPageRequest {
  requestId: symbol;
  controller: AbortController;
  ownerUserKey: string;
  ownerEpoch?: number;
  detachScope?: () => void;
}
const historyPageRequests = new Map<string, HistoryPageRequest>();

interface PendingUserSpaceMutation {
  sessionId: string;
  requestId: string;
  operation: UserSpaceOperation;
  input: Record<string, unknown>;
  socket: WebSocket;
  runtimeContext?: WsRuntimeContextIdentity;
  phase: "awaiting_authorization" | "executing";
}
const pendingUserSpaceMutations = new Map<string, PendingUserSpaceMutation>();
const MAX_PENDING_USER_SPACE_MUTATIONS = 256;

let idCounter = 0;
let clientMsgCounter = 0;
const nextId = () => `msg-${Date.now()}-${++idCounter}`;
const nextClientMsgId = () => `cmsg-${Date.now()}-${++clientMsgCounter}`;
export const createClientMessageId = (): string => nextClientMsgId();

function withUserSpacePreferences(
  operation: UserSpaceOperation,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const prefs = useStore.getState().preferences.userSpace;
  if (operation === "list_dir") return { ...input, includeHidden: prefs.showHiddenEntries };
  if (operation === "search" || operation === "search_paths" || operation === "glob") {
    return { ...input, includeHidden: true };
  }
  if (operation === "shell_exec") {
    return {
      ...input,
      showHiddenEntries: prefs.showHiddenEntries,
      searchHiddenEntries: true,
    };
  }
  return input;
}

const mutationKey = (sessionId: string, requestId: string) => `${sessionId}\0${requestId}`;

function encodeWsMessage(
  message: BrowserOutgoingMessage,
  runtimeContext?: WsRuntimeContextIdentity,
): string {
  if (!runtimeContext) return JSON.stringify(message);
  const envelope: WsEnvelope<BrowserOutgoingMessage> = {
    protocolVersion: WS_PROTOCOL_VERSION,
    contextEpoch: runtimeContext.epoch,
    contextId: runtimeContext.contextId,
    eventId:
      "clientMsgId" in message && message.clientMsgId ? message.clientMsgId : nextClientMsgId(),
    kind: message.type,
    payload: message,
  };
  return JSON.stringify(envelope);
}

function sendSocketMessage(
  socket: WebSocket,
  message: BrowserOutgoingMessage,
  context?: WsRuntimeContextIdentity,
): void {
  socket.send(encodeWsMessage(message, context));
}

function sendUserSpaceTerminalResponse(
  pending: PendingUserSpaceMutation,
  authorization: { commitLease: string; runtimeEpoch: string },
  response: { ok: true; result: unknown } | { ok: false; error: string },
): void {
  if (pending.socket.readyState !== WebSocket.OPEN) return;
  try {
    sendSocketMessage(
      pending.socket,
      {
        type: "user_space_response",
        request_id: pending.requestId,
        ...response,
        commit_lease: authorization.commitLease,
        runtime_epoch: authorization.runtimeEpoch,
      },
      pending.runtimeContext,
    );
  } catch {
    // Runtime revocation drains unacknowledged commit evidence fail-closed.
  }
}

function executeAuthorizedUserSpaceMutation(
  pending: PendingUserSpaceMutation,
  authorization: { commitLease: string; runtimeEpoch: string },
): void {
  const key = mutationKey(pending.sessionId, pending.requestId);
  void executeUserSpaceOperation(
    pending.operation,
    withUserSpacePreferences(pending.operation, pending.input),
  )
    .then((result) => sendUserSpaceTerminalResponse(pending, authorization, { ok: true, result }))
    .catch((error) =>
      sendUserSpaceTerminalResponse(pending, authorization, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      if (pendingUserSpaceMutations.get(key) === pending) pendingUserSpaceMutations.delete(key);
    });
}

function discardAwaitingMutationsForSocket(socket: WebSocket): void {
  for (const [key, pending] of pendingUserSpaceMutations) {
    if (pending.socket === socket && pending.phase === "awaiting_authorization") {
      pendingUserSpaceMutations.delete(key);
    }
  }
}

function currentUserKey(): string {
  const user = useStore.getState().currentUser;
  return user?.uuid || user?.userId || "";
}

function isSocketUsable(socket: WebSocket | undefined): boolean {
  return Boolean(
    socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING),
  );
}

function shouldReconnectSession(sessionId: string): boolean {
  const store = useStore.getState();
  const session = store.runtimeSessions.find((entry) => entry.sessionId === sessionId);
  if (session?.archived) return false;
  return (
    store.currentSessionId === sessionId || Object.values(store.agentSessionIds).includes(sessionId)
  );
}

function connectionCandidates(sessions?: PiSessionInfo[]): string[] {
  const store = useStore.getState();
  const known = sessions || store.runtimeSessions;
  const knownById = new Map(known.map((session) => [session.sessionId, session]));
  const ids = new Set<string>();
  if (store.currentSessionId) ids.add(store.currentSessionId);
  for (const id of Object.values(store.agentSessionIds)) if (id) ids.add(id);
  return Array.from(ids).filter((id) => {
    const session =
      knownById.get(id) || store.runtimeSessions.find((entry) => entry.sessionId === id);
    return (
      !session?.archived &&
      Boolean(session || store.sessions.has(id) || store.currentSessionId === id)
    );
  });
}

let pageHidden = typeof document !== "undefined" ? document.hidden : false;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pageHidden = true;
      for (const [sessionId, timer] of reconnectTimers) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
      }
      return;
    }
    pageHidden = false;
    for (const sessionId of connectionCandidates()) {
      if (!shouldReconnectSession(sessionId)) continue;
      const socket = connections.get(sessionId);
      if (!isSocketUsable(socket)) {
        if (socket) {
          try {
            socket.close();
          } catch {}
          connections.remove(sessionId, socket);
        }
        connectSession(sessionId);
      }
    }
  });
}

const getLastSeq = (sessionId: string) => lastSeqBySession.get(sessionId) || 0;
const setLastSeq = (sessionId: string, seq: number) =>
  lastSeqBySession.set(sessionId, Math.max(0, Math.floor(seq)));
const hasHydratedMessages = (sessionId: string) =>
  (useStore.getState().messages.get(sessionId)?.length || 0) > 0;
const subscribeSeq = (sessionId: string) =>
  hasHydratedMessages(sessionId) ? getLastSeq(sessionId) : 0;
const ackSeq = (sessionId: string, seq: number) =>
  sendToSession(sessionId, { type: "session_ack", lastSeq: seq });

function toChatMessage(message: AgentMessage): ChatMessage {
  const parts = message.displayContent || message.content;
  return {
    id: message.id,
    role: message.role,
    content: extractTextFromParts(parts),
    contentParts: parts,
    images: parts
      .filter((part): part is Extract<PiMessagePart, { type: "image" }> => part.type === "image")
      .map((part) => ({ mediaType: part.mediaType, data: part.data })),
    timestamp: message.timestamp,
    parentToolCallId: message.parentToolCallId,
    model: message.model,
    stopReason: message.stopReason,
    error: message.error,
  };
}

function upsertChatMessage(sessionId: string, incoming: ChatMessage): void {
  const store = useStore.getState();
  const current = store.messages.get(sessionId) || [];
  const index = current.findIndex((message) => message.id === incoming.id);
  if (index < 0) return store.appendMessage(sessionId, incoming);
  const next = [...current];
  next[index] =
    incoming.role === "assistant" && current[index]?.role === "assistant"
      ? mergeAgentMessage(current[index], incoming)
      : { ...current[index], ...incoming };
  store.setMessages(sessionId, next);
}

function setStreamingDraft(
  sessionId: string,
  messageId: string,
  parts: { text: string; thinking: string },
  phase: "thinking" | "text",
  timestamp: number,
): void {
  const store = useStore.getState();
  const trackedId = streamingDraftMessageIdBySession.get(sessionId);
  const current = (store.messages.get(sessionId) || []).filter(
    (message) => !message.isStreaming || message.id === trackedId,
  );
  const index = current.findIndex((message) => message.id === messageId);
  const draft: ChatMessage = {
    id: messageId,
    role: "assistant",
    content: parts.text || parts.thinking,
    contentParts: [
      ...(parts.thinking ? [{ type: "thinking" as const, thinking: parts.thinking }] : []),
      ...(parts.text ? [{ type: "text" as const, text: parts.text }] : []),
    ],
    timestamp,
    isStreaming: true,
    streamingPhase: phase,
  };
  streamingDraftMessageIdBySession.set(sessionId, messageId);
  if (index < 0) store.setMessages(sessionId, [...current, draft]);
  else {
    const next = [...current];
    next[index] = { ...next[index], ...draft };
    store.setMessages(sessionId, next);
  }
}

function clearStreaming(sessionId: string): void {
  const store = useStore.getState();
  const current = store.messages.get(sessionId) || [];
  const next = current.filter((message) => !message.isStreaming);
  if (next.length !== current.length) store.setMessages(sessionId, next);
  streamingDraftMessageIdBySession.delete(sessionId);
  streamingPartsBySession.delete(sessionId);
  store.setStreamingStats(sessionId, null);
}

function activityFromEvent(event: ToolExecutionEvent): ToolActivityEntry {
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    preview: event.progress || getPreview(event.toolName, event.input || {}),
    input: event.input,
    output: event.output,
    error: event.error,
    startedAt: event.timestamp - (event.elapsedMs || 0),
    completedAt:
      event.status === "completed" || event.status === "failed" || event.status === "cancelled"
        ? event.timestamp
        : undefined,
    elapsedSeconds: Math.max(0, (event.elapsedMs || 0) / 1_000),
    parentToolCallId: event.parentToolCallId || undefined,
  };
}

function toolMessageFromEvent(event: ToolExecutionEvent): ChatMessage {
  return {
    id: `tool:${event.toolCallId}`,
    role: "assistant",
    content: "",
    toolExecutions: [event],
    timestamp: event.timestamp,
    parentToolCallId: event.parentToolCallId,
  };
}

function applyToolExecution(sessionId: string, event: ToolExecutionEvent): void {
  const store = useStore.getState();
  upsertChatMessage(sessionId, toolMessageFromEvent(event));
  store.upsertToolActivity(sessionId, activityFromEvent(event));
  if (event.status === "started" || event.status === "running") {
    store.setToolProgress(sessionId, event.toolCallId, {
      toolName: event.toolName,
      elapsedSeconds: Math.max(0, (event.elapsedMs || 0) / 1_000),
      text: event.progress,
    });
  } else store.clearToolProgress(sessionId, event.toolCallId);
  if (event.toolName === "todo_write" && event.todos) {
    store.setTasks(
      sessionId,
      event.todos.map((todo) => ({
        id: todo.id,
        subject: todo.content,
        description: "",
        activeForm: todo.activeForm,
        status: todo.status,
      })),
    );
  }
  if (event.toolName === "task" && event.task) {
    store.upsertProcess(sessionId, {
      taskId: event.task.taskId,
      toolCallId: event.toolCallId,
      originatingToolCallId: event.task.originatingToolCallId ?? event.toolCallId,
      name: event.task.name,
      description: event.task.description || "",
      execution: event.task.execution,
      depth: event.task.depth,
      status: event.task.status,
      progress: event.task.progress,
      summary: event.task.summary ?? (typeof event.output === "string" ? event.output : undefined),
      durationMs: event.task.durationMs,
      startedAt: event.timestamp - (event.task.durationMs ?? event.elapsedMs ?? 0),
      completedAt: event.task.status === "running" ? undefined : event.timestamp,
    });
  }
}

function staleGeneration(sessionId: string, generation: number): boolean {
  const current = useStore.getState().sessions.get(sessionId)?.generation;
  return typeof current === "number" && generation < current;
}

function noteGeneration(sessionId: string, generation: number): void {
  const store = useStore.getState();
  const current = store.sessions.get(sessionId);
  if (current && generation > current.generation) {
    // A new Pi process cannot acknowledge a response submitted to its predecessor.
    // Keep the interaction itself so history/replay can decide whether it is still pending.
    store.clearInteractionSubmission(sessionId);
    store.updateSession(sessionId, { generation });
  }
}

type CoreEvent = Extract<
  BrowserIncomingMessage,
  {
    type:
      | "agent_message"
      | "message_delta"
      | "tool_execution"
      | "interaction_request"
      | "interaction_response"
      | "run_state";
  }
>;

function applyCoreEvent(
  sessionId: string,
  event: CoreEvent,
  options: { fromHistory?: boolean } = {},
): void {
  const store = useStore.getState();
  if (!options.fromHistory && staleGeneration(sessionId, event.generation)) return;
  if (!options.fromHistory) noteGeneration(sessionId, event.generation);
  if (!options.fromHistory) store.projectAgentActivity(sessionId, event);
  switch (event.type) {
    case "agent_message":
      clearStreaming(sessionId);
      upsertChatMessage(sessionId, toChatMessage(event.message));
      if (event.message.role === "user") store.clearPromptSuggestions(sessionId);
      break;
    case "message_delta": {
      if (event.delta.kind === "tool_arguments") break;
      const terminalMessage = (store.messages.get(sessionId) || []).some(
        (message) =>
          message.id === event.messageId && message.role === "assistant" && !message.isStreaming,
      );
      if (terminalMessage) break;
      const parts = streamingPartsBySession.get(sessionId) || { text: "", thinking: "" };
      if (event.delta.kind === "text") parts.text += event.delta.delta;
      else parts.thinking += event.delta.delta;
      streamingPartsBySession.set(sessionId, parts);
      setStreamingDraft(
        sessionId,
        event.messageId,
        parts,
        event.delta.kind,
        event.timestamp || Date.now(),
      );
      store.setStreamingStats(sessionId, {
        ...(!store.streamingStartedAt.has(sessionId) ? { startedAt: Date.now() } : {}),
        ...(event.usage?.outputTokens !== undefined
          ? { outputTokens: event.usage.outputTokens }
          : {}),
      });
      break;
    }
    case "tool_execution":
      applyToolExecution(sessionId, event);
      break;
    case "interaction_request":
      store.addInteraction(sessionId, event.request);
      store.setRunState(sessionId, "awaiting_interaction");
      store.setRunActive(sessionId, true);
      break;
    case "interaction_response":
      store.completeInteraction(
        sessionId,
        event.kind === "ask"
          ? {
              requestId: event.requestId,
              kind: "ask",
              status: event.status,
              answers: event.answers,
            }
          : {
              requestId: event.requestId,
              kind: "propose_plan",
              status: event.status,
              decision: event.decision,
              refinement: event.refinement,
            },
        event.timestamp,
      );
      break;
    case "run_state": {
      const active = [
        "starting",
        "running",
        "settling",
        "awaiting_interaction",
        "compacting",
      ].includes(event.state);
      store.setRunState(sessionId, event.state);
      store.setRunActive(sessionId, active);
      store.setRuntimeConnected(
        sessionId,
        event.state !== "disconnected" && event.state !== "stopped",
      );
      store.setRuntimeReconnecting(sessionId, event.state === "reconnecting");
      store.updateSession(sessionId, {
        runState: event.state,
        generation: event.generation,
        isCompacting: event.state === "compacting",
        ...(event.usage ? { usage: event.usage } : {}),
      });
      if (!active) {
        clearStreaming(sessionId);
        store.clearToolProgress(sessionId);
      }
      break;
    }
  }
}

function applyHistory(sessionId: string, entries: PiHistoryEntry[], reset: boolean): void {
  const store = useStore.getState();
  const messages: ChatMessage[] = [];
  const activities: ToolActivityEntry[] = [];
  if (reset) {
    clearStreaming(sessionId);
    store.setTasks(sessionId, []);
    store.setProcesses(sessionId, []);
    store.setToolActivity(sessionId, []);
    store.clearToolProgress(sessionId);
    store.clearPendingInteractions(sessionId);
    store.clearCompletedInteractions(sessionId);
  }
  for (const entry of entries) {
    const event = entry.event;
    if (event.type === "agent_message") messages.push(toChatMessage(event.message));
    else if (event.type === "tool_execution") {
      messages.push(toolMessageFromEvent(event));
      activities.push(activityFromEvent(event));
      applyToolExecution(sessionId, event);
    } else if (event.type === "interaction_request") store.addInteraction(sessionId, event.request);
    else if (event.type === "interaction_response")
      applyCoreEvent(sessionId, event, { fromHistory: true });
  }
  const current = reset
    ? []
    : (store.messages.get(sessionId) || []).filter((message) => !message.isStreaming);
  store.setMessages(sessionId, mergeChronologicalMessages(messages, current));
  if (reset && activities.length > 0) store.setToolActivity(sessionId, activities);
}

export interface SessionHistoryLoadResult {
  cursor?: string;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  error?: string;
  total?: number;
  received?: number;
}

export function getSessionHistoryLoadState(sessionId: string): SessionHistoryLoadResult {
  const state = historyPagingBySession.get(sessionId);
  return {
    cursor: state?.cursor,
    hasMore: state?.hasMore || false,
    loaded: state?.loaded || false,
    loading: state?.loading || false,
    error: state?.error,
  };
}

export async function loadSessionHistoryPage(
  sessionId: string,
  options: { reset?: boolean; limit?: number } = {},
): Promise<SessionHistoryLoadResult> {
  const lease = runtimeContextCoordinator.current();
  const ownerEpoch = lease?.context.epoch;
  const ownerUserKey = currentUserKey();
  const previous = historyPagingBySession.get(sessionId);
  const priorRequest = historyPageRequests.get(sessionId);
  if (
    previous?.loading &&
    priorRequest?.ownerUserKey === ownerUserKey &&
    priorRequest.ownerEpoch === ownerEpoch
  )
    return getSessionHistoryLoadState(sessionId);
  priorRequest?.controller.abort();
  priorRequest?.detachScope?.();
  const request: HistoryPageRequest = {
    requestId: Symbol(sessionId),
    controller: new AbortController(),
    ownerUserKey,
    ownerEpoch,
  };
  if (lease) request.detachScope = lease.scope.add(() => request.controller.abort());
  historyPageRequests.set(sessionId, request);
  const isCurrent = () =>
    historyPageRequests.get(sessionId)?.requestId === request.requestId &&
    currentUserKey() === ownerUserKey &&
    (ownerEpoch === undefined || runtimeContextCoordinator.isCurrent({ epoch: ownerEpoch }));
  const cursor = options.reset ? undefined : previous?.cursor;
  const limit = Math.max(
    1,
    Math.min(500, Math.floor(options.limit ?? WORKBENCH_HISTORY_PAGE_SIZE)),
  );
  historyPagingBySession.set(sessionId, {
    cursor,
    hasMore: options.reset ? false : previous?.hasMore || false,
    loaded: options.reset ? false : previous?.loaded || false,
    loading: true,
  });
  try {
    const page = await api.getSessionMessageHistory(
      sessionId,
      { cursor, limit },
      {
        signal: request.controller.signal,
        ...(ownerEpoch !== undefined ? { contextEpoch: ownerEpoch } : {}),
      },
    );
    if (!isCurrent()) throw new DOMException("History scope changed", "AbortError");
    applyHistory(sessionId, page.entries, options.reset === true);
    const next = {
      cursor: page.nextCursor,
      hasMore: page.hasMore,
      loaded: true,
      loading: false,
      total: page.totalEntries,
      received: page.entries.length,
    };
    historyPagingBySession.set(sessionId, next);
    return next;
  } catch (error) {
    if (!isCurrent()) return getSessionHistoryLoadState(sessionId);
    const next = {
      cursor,
      hasMore: previous?.hasMore || false,
      loaded: previous?.loaded || false,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    };
    historyPagingBySession.set(sessionId, next);
    return next;
  } finally {
    request.detachScope?.();
    if (historyPageRequests.get(sessionId)?.requestId === request.requestId)
      historyPageRequests.delete(sessionId);
  }
}

function handleParsedMessage(
  sessionId: string,
  message: BrowserIncomingMessage,
  options: {
    processSeq?: boolean;
    ackSeqMessage?: boolean;
    sourceSocket?: WebSocket;
    runtimeContext?: WsRuntimeContextIdentity;
  } = {},
): void {
  const { processSeq = true, ackSeqMessage = true, sourceSocket, runtimeContext } = options;
  const store = useStore.getState();
  if (processSeq && typeof message.seq === "number") {
    if (message.seq <= getLastSeq(sessionId)) return;
    setLastSeq(sessionId, message.seq);
    if (ackSeqMessage) ackSeq(sessionId, message.seq);
  }
  switch (message.type) {
    case "session_init":
      if ((store.sessions.get(sessionId)?.generation ?? -1) < message.session.generation)
        store.clearInteractionSubmission(sessionId);
      store.addSession(message.session);
      syncSessionUserSpaces(sessionId, message.session.userSpaces);
      store.setRuntimeConnected(sessionId, true);
      store.setRuntimeReconnecting(sessionId, false);
      store.setRunState(sessionId, message.session.runState);
      store.projectAgentActivity(sessionId, message);
      break;
    case "session_update":
      store.updateSession(sessionId, message.session);
      syncSessionUserSpaces(sessionId, message.session.userSpaces);
      break;
    case "agent_message":
    case "message_delta":
    case "tool_execution":
    case "interaction_request":
    case "interaction_response":
    case "run_state":
      applyCoreEvent(sessionId, message);
      break;
    case "history_snapshot":
      applyHistory(
        sessionId,
        message.entries,
        message.reason === "initial" || message.reason === "gap" || message.reason === "recovery",
      );
      historyPagingBySession.set(sessionId, {
        cursor: message.entries.at(-1)?.id,
        hasMore: message.hasMore,
        loading: false,
        loaded: true,
      });
      break;
    case "error":
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: message.message,
        timestamp: Date.now(),
      });
      break;
    case "pi_queue":
    case "pi_extension_event":
      if (!staleGeneration(sessionId, message.generation)) {
        noteGeneration(sessionId, message.generation);
        store.projectAgentActivity(sessionId, message);
      }
      break;
    case "event_replay": {
      let latest: number | undefined;
      for (const event of message.events) {
        if (event.seq <= getLastSeq(sessionId)) continue;
        setLastSeq(sessionId, event.seq);
        latest = event.seq;
        handleParsedMessage(sessionId, event.message as BrowserIncomingMessage, {
          processSeq: false,
          ackSeqMessage: false,
          sourceSocket,
          runtimeContext,
        });
      }
      if (latest !== undefined) ackSeq(sessionId, latest);
      break;
    }
    case "session_name_update":
      if (isPlaceholderSessionName(store.sessionNames.get(sessionId))) {
        store.setSessionName(sessionId, message.name);
        store.markRecentlyRenamed(sessionId);
      }
      break;
    case "session_lifecycle_update":
      store.setRuntimeSessions(
        store.runtimeSessions.map((session) =>
          session.sessionId === message.sessionId
            ? {
                ...session,
                lifecycleState: message.lifecycleState,
                state: message.lifecycleState === "closed" ? "exited" : session.state,
              }
            : session,
        ),
      );
      if (message.lifecycleState === "closed") {
        store.setRuntimeConnected(message.sessionId, false);
        store.setRuntimeReconnecting(message.sessionId, false);
        store.setRunState(message.sessionId, "stopped");
        store.setRunActive(message.sessionId, false);
        store.setAgentActivityConnection(message.sessionId, "disconnected");
      }
      break;
    case "mcp_status":
      store.setMcpServers(sessionId, message.servers);
      break;
    case "user_space_request":
    case "user_space_mutation_request": {
      const requiresCommit =
        message.type === "user_space_mutation_request" ||
        message.requires_commit === true ||
        userSpaceOperationRequiresMutationCommit(message.operation);
      if (requiresCommit) {
        const socket = sourceSocket || connections.get(sessionId);
        if (!socket || socket.readyState !== WebSocket.OPEN) break;
        const key = mutationKey(sessionId, message.request_id);
        const existing = pendingUserSpaceMutations.get(key);
        if (existing) {
          if (existing.socket === socket && existing.phase === "awaiting_authorization") {
            sendSocketMessage(
              socket,
              { type: "user_space_mutation_authorize", request_id: message.request_id },
              runtimeContext,
            );
          }
          break;
        }
        if (pendingUserSpaceMutations.size >= MAX_PENDING_USER_SPACE_MUTATIONS) break;
        pendingUserSpaceMutations.set(key, {
          sessionId,
          requestId: message.request_id,
          operation: message.operation,
          input: message.input,
          socket,
          runtimeContext,
          phase: "awaiting_authorization",
        });
        sendSocketMessage(
          socket,
          { type: "user_space_mutation_authorize", request_id: message.request_id },
          runtimeContext,
        );
        break;
      }
      void executeUserSpaceOperation(
        message.operation,
        withUserSpacePreferences(message.operation, message.input),
      )
        .then((result) =>
          sendToSession(sessionId, {
            type: "user_space_response",
            request_id: message.request_id,
            ok: true,
            result,
          }),
        )
        .catch((error) =>
          sendToSession(sessionId, {
            type: "user_space_response",
            request_id: message.request_id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      break;
    }
    case "user_space_mutation_authorization": {
      const key = mutationKey(sessionId, message.request_id);
      const pending = pendingUserSpaceMutations.get(key);
      if (!pending || (sourceSocket && pending.socket !== sourceSocket)) break;
      if (!message.ok) {
        pendingUserSpaceMutations.delete(key);
        break;
      }
      if (
        pending.phase !== "awaiting_authorization" ||
        !message.commit_lease ||
        !message.runtime_epoch
      )
        break;
      pending.phase = "executing";
      executeAuthorizedUserSpaceMutation(pending, {
        commitLease: message.commit_lease,
        runtimeEpoch: message.runtime_epoch,
      });
      break;
    }
    case "user_space_blob_checkout_request":
      void handleUserSpaceBlobCheckoutRequest(message).catch((error) =>
        console.warn("[user-space] Blob checkout failed:", error),
      );
      break;
    case "user_space_blob_checkin_request":
      void handleUserSpaceBlobCheckinRequest(message).catch((error) =>
        console.warn("[user-space] Blob checkin failed:", error),
      );
      break;
    case "onlyoffice_request": {
      const socket = sourceSocket || connections.get(sessionId);
      if (!socket || socket.readyState !== WebSocket.OPEN) break;
      void handleOnlyOfficeBrowserRequest(sessionId, message, (response) => {
        if (socket.readyState !== WebSocket.OPEN || !connections.isCurrent(sessionId, socket))
          return;
        sendSocketMessage(socket, response, runtimeContext);
      });
      break;
    }
  }
}

/**
 * Applies a trusted local fixture through the same browser projection reducer.
 * The Recording Hub is server-gated; this deliberately bypasses socket sequence
 * acknowledgement only, not generation or message projection rules.
 */
export function projectRecordingHubFixture(
  sessionId: string,
  message: BrowserIncomingMessage,
): void {
  handleParsedMessage(sessionId, message, { processSeq: false, ackSeqMessage: false });
}

function handleMessage(
  sessionId: string,
  event: MessageEvent,
  expectedContext?: WsRuntimeContextIdentity,
  sourceSocket?: WebSocket,
): void {
  let parsed: unknown;
  try {
    if (typeof event.data !== "string") throw new Error("WebSocket message is not text");
    parsed = JSON.parse(event.data);
  } catch {
    console.warn(`[ws] Ignored malformed incoming message for session ${sessionId}`);
    return;
  }
  if (isRecord(parsed) && parsed.protocolVersion === WS_PROTOCOL_VERSION) {
    const envelope = parsed as unknown as WsEnvelope<unknown>;
    if (
      !expectedContext ||
      envelope.contextEpoch !== expectedContext.epoch ||
      envelope.contextId !== expectedContext.contextId ||
      !runtimeContextCoordinator.isCurrent(expectedContext) ||
      typeof envelope.eventId !== "string" ||
      envelope.eventId.length === 0 ||
      envelope.eventId.length > 200 ||
      typeof envelope.kind !== "string" ||
      !isRecord(envelope.payload) ||
      envelope.kind !== envelope.payload.type
    ) {
      console.warn(`[ws] Ignored stale or invalid envelope for session ${sessionId}`);
      return;
    }
    parsed = envelope.payload;
  } else if (expectedContext) {
    console.warn(`[ws] Ignored non-negotiated event for session ${sessionId}`);
    return;
  }
  if (!isBrowserIncomingMessage(parsed)) {
    console.warn(`[ws] Ignored invalid incoming event for session ${sessionId}`);
    return;
  }
  const store = useStore.getState();
  if (store.connectionStatus.get(sessionId) === "connecting") {
    store.setConnectionStatus(sessionId, "connected");
    store.setAgentActivityConnection(sessionId, "connected");
  }
  handleParsedMessage(sessionId, parsed, { sourceSocket, runtimeContext: expectedContext });
}

function enqueueOutgoing(sessionId: string, message: BrowserOutgoingMessage): boolean {
  if (
    !pendingOutgoingBySession.has(sessionId) &&
    pendingOutgoingBySession.size >= MAX_PENDING_OUTGOING_SESSIONS
  )
    return false;
  const queue = pendingOutgoingBySession.get(sessionId) || [];
  if (queue.length >= MAX_PENDING_OUTGOING_PER_SESSION) queue.shift();
  queue.push(message);
  pendingOutgoingBySession.set(sessionId, queue);
  return true;
}

function flushOutgoing(
  sessionId: string,
  socket: WebSocket,
  context?: WsRuntimeContextIdentity,
): void {
  const queue = pendingOutgoingBySession.get(sessionId);
  if (!queue?.length || socket.readyState !== WebSocket.OPEN) return;
  pendingOutgoingBySession.delete(sessionId);
  for (const message of queue) sendSocketMessage(socket, message, context);
}

const CLIENT_ID_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "agent_message",
  "interaction_response",
  "abort",
  "retry",
  "compact",
  "set_model",
  "set_thinking_level",
  "set_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "end_session",
  "stop_task",
  "user_space_mount",
  "user_space_unmount",
  "user_space_status",
  "user_space_index_update",
]);
const QUEUEABLE_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "set_model",
  "set_thinking_level",
  "set_mode",
  "mcp_get_status",
  "mcp_toggle",
  "user_space_mount",
  "user_space_unmount",
  "user_space_status",
  "user_space_index_update",
]);

function wsUrl(sessionId: string, context?: WsRuntimeContextIdentity): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${location.host}/ws/browser/${sessionId}`;
  return context
    ? `${base}?protocolVersion=${WS_PROTOCOL_VERSION}&contextEpoch=${context.epoch}&contextId=${context.contextId}`
    : base;
}

export function connectSession(sessionId: string): void {
  const lease = runtimeContextCoordinator.current();
  const ownerContext = lease
    ? { epoch: lease.context.epoch, contextId: lease.context.contextId }
    : undefined;
  const existing = connections.get(sessionId);
  const existingContext = connections.context(sessionId);
  if (
    isSocketUsable(existing) &&
    existingContext?.epoch === ownerContext?.epoch &&
    existingContext?.contextId === ownerContext?.contextId
  ) {
    if (existing?.readyState === WebSocket.OPEN && !hasHydratedMessages(sessionId))
      sendSocketMessage(existing, { type: "session_subscribe", lastSeq: 0 }, ownerContext);
    return;
  }
  if (existing) {
    try {
      existing.close();
    } catch {}
    connections.remove(sessionId, existing);
  }
  useStore.getState().setConnectionStatus(sessionId, "connecting");
  useStore.getState().setAgentActivityConnection(sessionId, "connecting");
  const ownerUserKey = currentUserKey();
  const socket = new WebSocket(wsUrl(sessionId, ownerContext));
  let detachOnlyOfficeTransport = () => {};
  connections.attach(sessionId, socket, ownerContext);
  if (lease) {
    connections.attachScope(
      sessionId,
      lease.scope.add(() => {
        if (connections.isCurrent(sessionId, socket)) disconnectSession(sessionId);
      }),
    );
  }
  socket.onopen = () => {
    if (
      !connections.isCurrent(sessionId, socket) ||
      currentUserKey() !== ownerUserKey ||
      (ownerContext && !runtimeContextCoordinator.isCurrent(ownerContext))
    ) {
      connections.remove(sessionId, socket);
      socket.close();
      return;
    }
    sendSocketMessage(
      socket,
      { type: "session_subscribe", lastSeq: subscribeSeq(sessionId) },
      ownerContext,
    );
    detachOnlyOfficeTransport();
    detachOnlyOfficeTransport = attachOnlyOfficeTransport(sessionId, (status) => {
      if (socket.readyState === WebSocket.OPEN && connections.isCurrent(sessionId, socket))
        sendSocketMessage(socket, status, ownerContext);
    });
    flushOutgoing(sessionId, socket, ownerContext);
    resendSessionUserSpaces(sessionId, { force: true });
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
  };
  socket.onmessage = (event) => {
    if (
      !connections.isCurrent(sessionId, socket) ||
      currentUserKey() !== ownerUserKey ||
      (ownerContext && !runtimeContextCoordinator.isCurrent(ownerContext))
    )
      return;
    handleMessage(sessionId, event, ownerContext, socket);
  };
  socket.onclose = () => {
    detachOnlyOfficeTransport();
    discardAwaitingMutationsForSocket(socket);
    if (!connections.remove(sessionId, socket)) return;
    if (
      currentUserKey() !== ownerUserKey ||
      (ownerContext && !runtimeContextCoordinator.isCurrent(ownerContext))
    )
      return;
    const store = useStore.getState();
    store.setConnectionStatus(sessionId, "disconnected");
    store.setRuntimeConnected(sessionId, false);
    store.setAgentActivityConnection(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };
  socket.onerror = () => socket.close();
}

function scheduleReconnect(sessionId: string): void {
  if (reconnectTimers.has(sessionId) || pageHidden) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    reconnectScopeDetachers.get(sessionId)?.();
    reconnectScopeDetachers.delete(sessionId);
    if (!pageHidden && shouldReconnectSession(sessionId)) connectSession(sessionId);
  }, WS_RECONNECT_DELAY_MS);
  reconnectTimers.set(sessionId, timer);
  const lease = runtimeContextCoordinator.current();
  if (lease) {
    reconnectScopeDetachers.set(
      sessionId,
      lease.scope.add(() => {
        if (reconnectTimers.get(sessionId) === timer) {
          clearTimeout(timer);
          reconnectTimers.delete(sessionId);
        }
      }),
    );
  }
}

export function disconnectSession(sessionId: string): void {
  const request = historyPageRequests.get(sessionId);
  request?.controller.abort();
  request?.detachScope?.();
  historyPageRequests.delete(sessionId);
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  reconnectScopeDetachers.get(sessionId)?.();
  reconnectScopeDetachers.delete(sessionId);
  const socket = connections.get(sessionId);
  if (socket) {
    discardAwaitingMutationsForSocket(socket);
    socket.close();
    connections.remove(sessionId, socket);
  } else connections.remove(sessionId);
  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "disconnected");
  store.setRuntimeConnected(sessionId, false);
  store.setAgentActivityConnection(sessionId, "disconnected");
  store.setRunActive(sessionId, false);
  store.setRunState(sessionId, "disconnected");
  store.clearToolProgress(sessionId);
  streamingDraftMessageIdBySession.delete(sessionId);
  streamingPartsBySession.delete(sessionId);
  lastSeqBySession.delete(sessionId);
  historyPagingBySession.delete(sessionId);
  pendingOutgoingBySession.delete(sessionId);
}

export function disconnectAll(): void {
  const ids = new Set([
    ...connections.sessionIds(),
    ...reconnectTimers.keys(),
    ...pendingOutgoingBySession.keys(),
    ...historyPageRequests.keys(),
  ]);
  for (const id of ids) disconnectSession(id);
}

export function connectAllSessions(sessions: PiSessionInfo[]): void {
  if (pageHidden) return;
  for (const sessionId of connectionCandidates(sessions)) connectSession(sessionId);
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lease = runtimeContextCoordinator.current();
    let settled = false;
    let detachScope: (() => void) | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(check);
      clearTimeout(timeout);
      detachScope?.();
      if (error) reject(error);
      else resolve();
    };
    const check = setInterval(() => {
      if (connections.get(sessionId)?.readyState === WebSocket.OPEN) finish();
    }, 50);
    const timeout = setTimeout(() => finish(new Error(uiCopy.piRuntime.connectionTimeout)), 10_000);
    if (lease)
      detachScope = lease.scope.add(() =>
        finish(new DOMException("Runtime context disposed", "AbortError")),
      );
  });
}

export function sendToSession(sessionId: string, message: BrowserOutgoingMessage): boolean {
  let outgoing = message;
  if (CLIENT_ID_TYPES.has(message.type) && !(message as { clientMsgId?: string }).clientMsgId) {
    outgoing = { ...message, clientMsgId: nextClientMsgId() } as BrowserOutgoingMessage;
  }
  const socket = connections.get(sessionId);
  if (socket?.readyState === WebSocket.OPEN) {
    if (outgoing.type === "agent_message") {
      const store = useStore.getState();
      store.setRunState(sessionId, "running");
      store.setRunActive(sessionId, true);
    }
    sendSocketMessage(socket, outgoing, connections.context(sessionId));
    return true;
  }
  if (outgoing.type === "interaction_response") return false;
  return QUEUEABLE_TYPES.has(outgoing.type) ? enqueueOutgoing(sessionId, outgoing) : false;
}

export const sendMcpGetStatus = (sessionId: string): void => {
  sendToSession(sessionId, { type: "mcp_get_status" });
};
export const sendMcpToggle = (sessionId: string, serverName: string, enabled: boolean): void => {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
};
export const sendMcpReconnect = (sessionId: string, serverName: string): void => {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
};
setUserSpaceTransport((sessionId, message) => sendToSession(sessionId, message));
