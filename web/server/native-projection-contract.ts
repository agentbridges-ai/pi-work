import type {
  AgentMessage,
  PiHistoryEvent,
  PiMessagePart,
  PiUsage,
  TodoEntry,
  ToolExecutionEvent,
} from "../shared/pi-browser-protocol.js";

/** Bump only when the browser-facing projection shape changes incompatibly. */
export const NATIVE_PROJECTION_CONTRACT_VERSION = 1 as const;

/**
 * The only lossy boundary between native Pi JSONL and the browser protocol.
 *
 * Keep this module pure: REST history, WebSocket recovery snapshots, and
 * replay must all use these exact projections. Unknown native shapes are not
 * displayable by default; rendering an unrecognised record as a user message
 * would turn runtime/control envelopes into apparent conversation content.
 */
export interface NativeProjectionContext {
  id: string;
  parentId: string | null;
  timestamp: number;
  generation: number;
}

type NativeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is NativeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function nativeTimestamp(value: unknown, fallback: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) return fallback;
  if (typeof fallback === "string") {
    const parsed = Date.parse(fallback);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function normalizeNativeParts(value: unknown): PiMessagePart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PiMessagePart[] => {
    if (!isRecord(item)) return [];
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (item.type === "thinking" && typeof item.thinking === "string") {
      return [{ type: "thinking", thinking: item.thinking }];
    }
    if (item.type === "image" && typeof item.data === "string") {
      const mediaType =
        typeof item.mimeType === "string"
          ? item.mimeType
          : typeof item.mediaType === "string"
            ? item.mediaType
            : undefined;
      if (mediaType) return [{ type: "image", data: item.data, mediaType }];
    }
    return [];
  });
}

/** Managed-task delivery is internal, untrusted transport material, never chat. */
export function isManagedTaskEnvelope(value: unknown): boolean {
  const text = normalizeNativeParts(value)
    .filter((part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return (
    text.includes("[Piwork managed task notification]") &&
    text.includes("--- BEGIN MANAGED TASK PAYLOAD ---") &&
    text.includes('"type":"piwork_managed_task_result"')
  );
}

function taskFromDetails(details: unknown): ToolExecutionEvent["task"] | undefined {
  if (!isRecord(details)) return undefined;
  const taskId = string(details.taskId);
  const name = string(details.name);
  const status = string(details.status);
  if (
    !taskId ||
    !name ||
    !status ||
    !["running", "completed", "failed", "stopped"].includes(status)
  ) {
    return undefined;
  }
  return {
    taskId,
    name,
    description: string(details.description),
    execution: details.execution === "background" ? "background" : "foreground",
    status: status as NonNullable<ToolExecutionEvent["task"]>["status"],
    depth: typeof details.depth === "number" && Number.isFinite(details.depth) ? details.depth : 0,
    progress: string(details.progress),
  };
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return "Pi tool execution failed.";
  }
}

/**
 * Project the already transport-normalized tool lifecycle without allowing an
 * unknown or malformed native record to become a browser activity card.
 * `startedAt` is kept outside the event so a reconnect cannot invent timing.
 */
export function projectNativeToolExecution(
  value: unknown,
  context: { generation: number; timestamp: number; startedAt?: number },
): ToolExecutionEvent | null {
  if (!isRecord(value)) return null;
  const phase = value.phase;
  const toolCallId = string(value.tool_call_id);
  const toolName = string(value.tool_name);
  if ((phase !== "start" && phase !== "update" && phase !== "end") || !toolCallId || !toolName) {
    return null;
  }
  if (value.is_error !== undefined && typeof value.is_error !== "boolean") return null;
  const timestamp = nativeTimestamp(undefined, context.timestamp);
  const result = value.result;
  const resultRecord = isRecord(result) ? result : undefined;
  const details = resultRecord && isRecord(resultRecord.details) ? resultRecord.details : result;
  const status: ToolExecutionEvent["status"] =
    phase === "start"
      ? "started"
      : phase === "update"
        ? "running"
        : value.is_error
          ? "failed"
          : "completed";
  const todos =
    toolName === "todo_write" && isRecord(details)
      ? (projectNativeTodos(details.todos) ?? undefined)
      : undefined;
  const task = toolName === "task" ? taskFromDetails(details) : undefined;
  const progress = isRecord(details) ? string(details.progress) : undefined;
  const startedAt =
    typeof context.startedAt === "number" && Number.isFinite(context.startedAt)
      ? context.startedAt
      : undefined;
  return {
    type: "tool_execution",
    generation: context.generation,
    toolCallId,
    toolName,
    status,
    timestamp,
    input: isRecord(value.args) ? value.args : undefined,
    output: result,
    error: value.is_error === true ? errorText(result) : undefined,
    elapsedMs:
      startedAt === undefined ? undefined : Math.max(0, timestamp - Math.max(0, startedAt)),
    progress,
    todos,
    task,
  };
}

/** Project trusted-extension managed task lifecycle events into one Task node. */
export function projectManagedTaskEvent(
  value: unknown,
  context: { generation: number; timestamp: number },
): ToolExecutionEvent | null {
  if (!isRecord(value)) return null;
  const taskId = string(value.taskId);
  const rawStatus = string(value.status);
  if (
    !taskId ||
    !rawStatus ||
    !["starting", "running", "completed", "failed", "stopped"].includes(rawStatus)
  ) {
    return null;
  }
  const taskStatus: NonNullable<ToolExecutionEvent["task"]>["status"] =
    rawStatus === "starting"
      ? "running"
      : (rawStatus as NonNullable<ToolExecutionEvent["task"]>["status"]);
  const taskName = string(value.name) || "Managed Pi task";
  const depth = typeof value.depth === "number" && Number.isFinite(value.depth) ? value.depth : 1;
  const progress = string(value.progress);
  return {
    type: "tool_execution",
    generation: context.generation,
    toolCallId: `task:${taskId}`,
    toolName: "task",
    status:
      taskStatus === "stopped" ? "cancelled" : taskStatus === "running" ? "running" : taskStatus,
    timestamp: nativeTimestamp(undefined, context.timestamp),
    progress,
    task: {
      taskId,
      name: taskName,
      description: string(value.description),
      execution:
        value.background === true || value.execution === "background" ? "background" : "foreground",
      status: taskStatus as NonNullable<ToolExecutionEvent["task"]>["status"],
      depth,
      progress,
    },
  };
}

export function projectNativeMessage(
  message: unknown,
  context: NativeProjectionContext,
): PiHistoryEvent | null {
  if (!isRecord(message)) return null;
  if (message.role === "toolResult") {
    const toolCallId = string(message.toolCallId);
    const toolName = string(message.toolName);
    if (!toolCallId || !toolName) return null;
    const content = normalizeNativeParts(message.content);
    const details = message.details;
    return {
      type: "tool_execution",
      generation: context.generation,
      toolCallId,
      toolName,
      status: message.isError === true ? "failed" : "completed",
      timestamp: nativeTimestamp(message.timestamp, context.timestamp),
      output: details ?? content.map((part) => (part.type === "text" ? part.text : part)),
      error:
        message.isError === true
          ? content
              .filter(
                (part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
          : undefined,
      task: toolName === "task" ? taskFromDetails(details) : undefined,
    };
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (message.role === "user" && isManagedTaskEnvelope(message.content)) return null;
  const modelId =
    typeof message.model === "string"
      ? message.model
      : typeof message.modelId === "string"
        ? message.modelId
        : undefined;
  const model =
    message.role === "assistant" && typeof message.provider === "string" && modelId
      ? {
          key: `${message.provider}/${modelId}`,
          provider: message.provider,
          modelId,
        }
      : undefined;
  const normalized: AgentMessage = {
    id: context.id,
    role: message.role,
    content: normalizeNativeParts(message.content),
    timestamp: nativeTimestamp(message.timestamp, context.timestamp),
    model,
    stopReason: string(message.stopReason) ?? null,
    ...(string(message.error) || string(message.errorMessage)
      ? { error: string(message.error) ?? string(message.errorMessage) }
      : {}),
  };
  return { type: "agent_message", generation: context.generation, message: normalized };
}

export function projectNativeTodos(value: unknown): TodoEntry[] | null {
  if (!Array.isArray(value)) return null;
  const todos: TodoEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      (typeof item.text !== "string" && typeof item.content !== "string")
    )
      return null;
    if (
      !(["pending", "in_progress", "completed"] as const).includes(
        item.status as TodoEntry["status"],
      )
    ) {
      return null;
    }
    todos.push({
      id: item.id,
      content: typeof item.content === "string" ? item.content : (item.text as string),
      status: item.status as TodoEntry["status"],
      ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}),
    });
  }
  return todos;
}

export function normalizeNativeUsage(value: unknown): PiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const number = (item: unknown) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
  const first = (...keys: string[]) =>
    keys.map((key) => value[key]).find((item) => item !== undefined);
  return {
    inputTokens: number(first("input", "inputTokens", "input_tokens")),
    outputTokens: number(first("output", "outputTokens", "output_tokens")),
    cacheReadTokens: number(first("cacheRead", "cacheReadTokens", "cache_read")),
    cacheWriteTokens: number(first("cacheWrite", "cacheWriteTokens", "cache_write")),
  };
}
