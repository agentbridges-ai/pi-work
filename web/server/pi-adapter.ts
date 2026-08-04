import type {
  PiExtensionUiRequest,
  PiImageContent,
  PiModel,
  PiRpcNotification,
  PiThinkingLevel,
} from "./pi-rpc-contract.js";
import type { PiRpcTransport } from "./pi-rpc-transport.js";

export type PiBrowserOutgoingMessage =
  | {
      type: "agent_message";
      content: string;
      images?: PiImageContent[];
      delivery?: "prompt" | "steer" | "follow_up";
      client_msg_id?: string;
    }
  | {
      type: "interaction_response";
      request_id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
      client_msg_id?: string;
    }
  | { type: "abort"; client_msg_id?: string }
  | { type: "retry_abort"; client_msg_id?: string }
  | {
      type: "compact";
      instructions?: string;
      client_msg_id?: string;
    }
  | {
      type: "set_model";
      model: { provider: string; modelId: string };
      client_msg_id?: string;
    }
  | {
      type: "set_thinking";
      level: PiThinkingLevel;
      client_msg_id?: string;
    }
  | {
      type: "history_request";
      since?: string;
      client_msg_id?: string;
    };

export type PiBrowserIncomingMessage =
  | {
      type: "agent_message";
      message: {
        id: string;
        role: string;
        content: unknown;
        timestamp?: number;
        provider?: string;
        modelId?: string;
        stopReason?: string;
        error?: string;
        usage?: unknown;
      };
    }
  | {
      type: "message_delta";
      message_id: string;
      content_index?: number;
      delta_kind: "text" | "thinking" | "tool_call";
      delta: string;
    }
  | {
      type: "tool_execution";
      phase: "start" | "update" | "end";
      tool_call_id: string;
      tool_name: string;
      args?: Record<string, unknown>;
      result?: Record<string, unknown>;
      is_error?: boolean;
    }
  | {
      type: "interaction_request";
      request_id: string;
      method: PiExtensionUiRequest["method"];
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      timeout_ms?: number;
    }
  | {
      type: "run_state";
      state: "idle" | "running" | "compacting" | "retrying" | "aborted" | "error";
      detail?: unknown;
    }
  | {
      type: "history_snapshot";
      entries: Record<string, unknown>[];
      leaf_id: string | null;
    }
  | {
      type: "pi_state";
      model?: { key: string; provider: string; modelId: string };
      thinkingLevel?: PiThinkingLevel;
      sessionId?: string;
      usage?: unknown;
    }
  | {
      type: "extension_event";
      event: "notify" | "status" | "widget" | "title" | "editor_text" | "error";
      payload: Record<string, unknown>;
    };

export interface PiAdapterOptions {
  transport: PiRpcTransport;
  sessionId: string;
  generation: number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function modelRef(model: PiModel): {
  key: string;
  provider: string;
  modelId: string;
} {
  return {
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    modelId: model.id,
  };
}

function interactionRequest(request: PiExtensionUiRequest): PiBrowserIncomingMessage {
  switch (request.method) {
    case "select":
      return {
        type: "interaction_request",
        request_id: request.id,
        method: request.method,
        title: request.title,
        options: request.options,
        timeout_ms: request.timeout,
      };
    case "confirm":
      return {
        type: "interaction_request",
        request_id: request.id,
        method: request.method,
        title: request.title,
        message: request.message,
        timeout_ms: request.timeout,
      };
    case "input":
      return {
        type: "interaction_request",
        request_id: request.id,
        method: request.method,
        title: request.title,
        placeholder: request.placeholder,
        timeout_ms: request.timeout,
      };
    case "editor":
      return {
        type: "interaction_request",
        request_id: request.id,
        method: request.method,
        title: request.title,
        prefill: request.prefill,
      };
    default:
      throw new Error("Extension UI request is not interactive.");
  }
}

/**
 * Pure Pi RPC ↔ browser protocol adapter. Sequencing, acknowledgement, replay,
 * lifecycle phase, and generation filtering remain owned by the session bridge.
 */
export class PiAdapter {
  readonly sessionId: string;
  readonly generation: number;
  private readonly transport: PiRpcTransport;
  private browserMessage?: (message: PiBrowserIncomingMessage) => void;
  private sessionMeta?: (meta: {
    sessionId?: string;
    model?: { key: string; provider: string; modelId: string };
  }) => void;
  private disconnectHandler?: () => void;
  private initError?: (error: string) => void;
  private extensionStatus?: (value: unknown) => void;
  private activeMessageId: string | null = null;
  private messageCounter = 0;
  private pendingInteractions = new Map<string, PiExtensionUiRequest["method"]>();
  private disconnected = false;

  constructor(options: PiAdapterOptions) {
    this.transport = options.transport;
    this.sessionId = options.sessionId;
    this.generation = options.generation;
  }

  isConnected(): boolean {
    return !this.disconnected && !this.transport.isClosed;
  }

  onBrowserMessage(callback: (message: PiBrowserIncomingMessage) => void): void {
    this.browserMessage = callback;
  }

  onSessionMeta(
    callback: (meta: {
      sessionId?: string;
      model?: { key: string; provider: string; modelId: string };
    }) => void,
  ): void {
    this.sessionMeta = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectHandler = callback;
  }

  onInitError(callback: (error: string) => void): void {
    this.initError = callback;
  }

  onExtensionStatus(callback: (value: unknown) => void): void {
    this.extensionStatus = callback;
  }

  private emit(message: PiBrowserIncomingMessage): void {
    this.browserMessage?.(message);
  }

  private reportFailure(): void {
    this.emit({
      type: "run_state",
      state: "error",
      detail: "Pi RPC command failed.",
    });
    this.initError?.("Pi RPC command failed.");
  }

  send(message: PiBrowserOutgoingMessage): boolean {
    if (!this.isConnected()) return false;
    let operation: Promise<unknown>;
    switch (message.type) {
      case "agent_message":
        if (message.delivery === "steer") {
          operation = this.transport.steer(message.content);
        } else if (message.delivery === "follow_up") {
          operation = this.transport.followUp(message.content);
        } else {
          operation = this.transport.prompt(message.content, {
            images: message.images,
          });
        }
        break;
      case "interaction_response": {
        const method = this.pendingInteractions.get(message.request_id);
        if (!method) return false;
        this.pendingInteractions.delete(message.request_id);
        if (message.cancelled) {
          operation = this.transport.sendExtensionUiResponse({
            type: "extension_ui_response",
            id: message.request_id,
            cancelled: true,
          });
        } else if (method === "confirm") {
          if (typeof message.confirmed !== "boolean") return false;
          operation = this.transport.sendExtensionUiResponse({
            type: "extension_ui_response",
            id: message.request_id,
            confirmed: message.confirmed,
          });
        } else {
          if (typeof message.value !== "string") return false;
          operation = this.transport.sendExtensionUiResponse({
            type: "extension_ui_response",
            id: message.request_id,
            value: message.value,
          });
        }
        break;
      }
      case "abort":
        operation = this.transport.abort();
        break;
      case "retry_abort":
        operation = this.transport.abortRetry();
        break;
      case "compact":
        operation = this.transport.compact(message.instructions);
        break;
      case "set_model":
        operation = this.transport
          .setModel(message.model.provider, message.model.modelId)
          .then((model) => {
            const normalized = modelRef(model);
            this.sessionMeta?.({ model: normalized });
            this.emit({ type: "pi_state", model: normalized });
          });
        break;
      case "set_thinking":
        operation = this.transport
          .setThinkingLevel(message.level)
          .then(() => this.emit({ type: "pi_state", thinkingLevel: message.level }));
        break;
      case "history_request":
        operation = this.transport.replayHistory(message.since).then((history) =>
          this.emit({
            type: "history_snapshot",
            entries: history.entries,
            leaf_id: history.leafId,
          }),
        );
        break;
      default:
        return false;
    }
    void operation.catch(() => this.reportFailure());
    return true;
  }

  private messageId(): string {
    if (!this.activeMessageId) {
      this.messageCounter += 1;
      this.activeMessageId = `pi-${this.generation}-message-${this.messageCounter}`;
    }
    return this.activeMessageId;
  }

  private emitFinalMessage(message: Record<string, unknown>): void {
    const id = this.messageId();
    const normalized: Extract<PiBrowserIncomingMessage, { type: "agent_message" }> = {
      type: "agent_message",
      message: {
        id,
        role: optionalString(message.role) ?? "assistant",
        content: message.content,
        ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
        ...(optionalString(message.provider) ? { provider: optionalString(message.provider) } : {}),
        ...(optionalString(message.model) ? { modelId: optionalString(message.model) } : {}),
        ...(optionalString(message.stopReason)
          ? { stopReason: optionalString(message.stopReason) }
          : {}),
        ...(optionalString(message.errorMessage)
          ? { error: optionalString(message.errorMessage) }
          : {}),
        ...(message.usage !== undefined ? { usage: message.usage } : {}),
      },
    };
    this.emit(normalized);
    this.activeMessageId = null;
  }

  private handleUiRequest(request: PiExtensionUiRequest): void {
    if (
      request.method === "select" ||
      request.method === "confirm" ||
      request.method === "input" ||
      request.method === "editor"
    ) {
      this.pendingInteractions.set(request.id, request.method);
      this.emit(interactionRequest(request));
      return;
    }
    if (request.method === "setStatus") {
      let parsed: unknown = request.statusText;
      if (request.statusKey === "piwork.extension" && request.statusText) {
        try {
          parsed = JSON.parse(request.statusText) as unknown;
          this.extensionStatus?.(parsed);
        } catch {
          this.extensionStatus?.(undefined);
        }
      }
      this.emit({
        type: "extension_event",
        event: "status",
        payload: {
          key: request.statusKey,
          value: parsed,
        },
      });
      return;
    }
    const event =
      request.method === "notify"
        ? "notify"
        : request.method === "setWidget"
          ? "widget"
          : request.method === "setTitle"
            ? "title"
            : "editor_text";
    this.emit({
      type: "extension_event",
      event,
      payload: { ...request },
    });
  }

  /** Pass directly as PiRpcTransport's onNotification callback. */
  handleNotification(notification: PiRpcNotification): void {
    if (notification.type === "extension_ui_request") {
      this.handleUiRequest(notification);
      return;
    }
    switch (notification.type) {
      case "agent_start":
        this.emit({ type: "run_state", state: "running" });
        return;
      case "agent_end":
        if (notification.willRetry) {
          this.emit({ type: "run_state", state: "retrying" });
        }
        return;
      case "agent_settled":
        this.emit({ type: "run_state", state: "idle" });
        return;
      case "message_start":
        this.messageId();
        return;
      case "message_update": {
        const event = notification.assistantMessageEvent;
        if (
          (event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "toolcall_delta") &&
          typeof event.delta === "string"
        ) {
          this.emit({
            type: "message_delta",
            message_id: this.messageId(),
            ...(typeof event.contentIndex === "number"
              ? { content_index: event.contentIndex }
              : {}),
            delta_kind:
              event.type === "text_delta"
                ? "text"
                : event.type === "thinking_delta"
                  ? "thinking"
                  : "tool_call",
            delta: event.delta,
          });
        }
        return;
      }
      case "message_end":
        this.emitFinalMessage(notification.message);
        return;
      case "tool_execution_start":
        this.emit({
          type: "tool_execution",
          phase: "start",
          tool_call_id: notification.toolCallId,
          tool_name: notification.toolName,
          args: notification.args,
        });
        return;
      case "tool_execution_update":
        this.emit({
          type: "tool_execution",
          phase: "update",
          tool_call_id: notification.toolCallId,
          tool_name: notification.toolName,
          args: notification.args,
          result: notification.partialResult,
        });
        return;
      case "tool_execution_end":
        this.emit({
          type: "tool_execution",
          phase: "end",
          tool_call_id: notification.toolCallId,
          tool_name: notification.toolName,
          result: notification.result,
          is_error: notification.isError,
        });
        return;
      case "compaction_start":
        this.emit({
          type: "run_state",
          state: "compacting",
          detail: { reason: notification.reason },
        });
        return;
      case "compaction_end":
        this.emit({
          type: "run_state",
          state: notification.aborted ? "aborted" : "idle",
          detail: {
            reason: notification.reason,
            willRetry: notification.willRetry,
            error: notification.errorMessage,
          },
        });
        return;
      case "auto_retry_start":
        this.emit({
          type: "run_state",
          state: "retrying",
          detail: {
            attempt: notification.attempt,
            maxAttempts: notification.maxAttempts,
            delayMs: notification.delayMs,
          },
        });
        return;
      case "auto_retry_end":
        this.emit({
          type: "run_state",
          state: notification.success ? "running" : "error",
          detail: { attempt: notification.attempt },
        });
        return;
      case "thinking_level_changed":
        this.emit({ type: "pi_state", thinkingLevel: notification.level });
        return;
      case "session_info_changed":
      case "entry_appended":
      case "queue_update":
      case "turn_start":
      case "turn_end":
      case "bash_execution_update":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        return;
      case "extension_error":
        this.emit({
          type: "extension_event",
          event: "error",
          payload: { event: notification.event, error: notification.error },
        });
        return;
    }
  }

  async replayHistory(since?: string): Promise<void> {
    const history = await this.transport.replayHistory(since);
    this.emit({
      type: "history_snapshot",
      entries: history.entries,
      leaf_id: history.leafId,
    });
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    this.pendingInteractions.clear();
    this.transport.dispose();
    this.disconnectHandler?.();
  }

  handleTransportClose(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.pendingInteractions.clear();
    this.disconnectHandler?.();
  }
}
