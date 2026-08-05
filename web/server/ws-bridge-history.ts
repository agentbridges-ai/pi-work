import type {
  AgentMessage,
  PiHistoryEntry,
  PiHistoryEvent,
  PiMessagePart,
  PiUsage,
  TodoEntry,
} from "../shared/pi-browser-protocol.js";
import type { PiSessionEntry } from "./pi-session-history.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timestamp(value: unknown, fallback: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof fallback === "string") {
    const parsed = Date.parse(fallback);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parts(value: unknown): PiMessagePart[] {
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
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      return [
        {
          type: "image",
          data: item.data,
          mediaType: item.mimeType,
        },
      ];
    }
    return [];
  });
}

function usage(value: unknown): PiUsage | undefined {
  if (!isRecord(value)) return undefined;
  const number = (item: unknown): number =>
    typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : 0;
  return {
    inputTokens: number(value.input),
    outputTokens: number(value.output),
    cacheReadTokens: number(value.cacheRead),
    cacheWriteTokens: number(value.cacheWrite),
  };
}

function toolCallInputs(entry: PiSessionEntry): Map<string, Record<string, unknown>> {
  const inputs = new Map<string, Record<string, unknown>>();
  if (!isRecord(entry.message) || !Array.isArray(entry.message.content)) return inputs;
  for (const part of entry.message.content) {
    if (!isRecord(part) || (part.type !== "toolCall" && part.type !== "tool_call")) continue;
    const id = string(part.id) ?? string(part.toolCallId) ?? string(part.tool_call_id);
    const input = isRecord(part.arguments)
      ? part.arguments
      : isRecord(part.args)
        ? part.args
        : isRecord(part.input)
          ? part.input
          : undefined;
    if (id && input) inputs.set(id, input);
  }
  return inputs;
}

function messageHistoryEvent(
  entry: PiSessionEntry,
  generation: number,
  inputs: ReadonlyMap<string, Record<string, unknown>>,
): PiHistoryEvent | null {
  if (!isRecord(entry.message)) return null;
  const message = entry.message;
  const messageTimestamp = timestamp(message.timestamp, entry.timestamp);
  if (message.role === "toolResult") {
    const toolCallId = string(message.toolCallId);
    const toolName = string(message.toolName);
    if (!toolCallId || !toolName) return null;
    return {
      type: "tool_execution",
      generation,
      toolCallId,
      toolName,
      status: message.isError === true ? "failed" : "completed",
      timestamp: messageTimestamp,
      input: inputs.get(toolCallId),
      output:
        message.details ??
        parts(message.content).map((part) => (part.type === "text" ? part.text : part)),
      error:
        message.isError === true
          ? parts(message.content)
              .filter(
                (part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
          : undefined,
    };
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  const model =
    message.role === "assistant" &&
    typeof message.provider === "string" &&
    typeof message.model === "string"
      ? {
          key: `${message.provider}/${message.model}`,
          provider: message.provider,
          modelId: message.model,
        }
      : undefined;
  const normalized: AgentMessage = {
    id: entry.id,
    role: message.role,
    content: parts(message.content),
    timestamp: messageTimestamp,
    model,
    stopReason: string(message.stopReason) ?? null,
    ...(string(message.errorMessage) || string(message.error)
      ? { error: string(message.errorMessage) ?? string(message.error) }
      : {}),
  };
  return {
    type: "agent_message",
    generation,
    message: normalized,
  };
}

function todos(value: unknown): TodoEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: TodoEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.text !== "string" ||
      !["pending", "in_progress", "completed"].includes(String(item.status))
    ) {
      return undefined;
    }
    normalized.push({
      id: item.id,
      content: item.text,
      status: item.status as TodoEntry["status"],
    });
  }
  return normalized;
}

function customHistoryEvent(entry: PiSessionEntry, generation: number): PiHistoryEvent | null {
  const data = isRecord(entry.data) ? entry.data : {};
  if (entry.customType === "piwork.todo") {
    const normalized = todos(data.todos);
    if (!normalized) return null;
    return {
      type: "tool_execution",
      generation,
      toolCallId: entry.id,
      toolName: "todo_write",
      status: "completed",
      timestamp: timestamp(undefined, entry.timestamp),
      todos: normalized,
      output: { todos: normalized },
    };
  }
  if (entry.customType === "piwork.plan") {
    const decision = string(data.decision);
    if (decision !== "execute" && decision !== "continue_planning" && decision !== "refine") {
      return null;
    }
    const refinement = string(data.refinement)?.trim();
    if (decision === "refine" && !refinement) return null;
    return {
      type: "interaction_response",
      generation,
      requestId: entry.id,
      kind: "propose_plan",
      status: "submitted",
      decision,
      ...(refinement ? { refinement } : {}),
      timestamp: timestamp(undefined, entry.timestamp),
    };
  }
  return null;
}

function systemMessage(
  entry: PiSessionEntry,
  generation: number,
  content: unknown,
): PiHistoryEvent | null {
  const normalized = parts(content);
  if (normalized.length === 0) return null;
  return {
    type: "agent_message",
    generation,
    message: {
      id: entry.id,
      role: "system",
      content: normalized,
      timestamp: timestamp(undefined, entry.timestamp),
    },
  };
}

export function piSessionEntryToHistoryEntry(
  entry: PiSessionEntry | Record<string, unknown>,
  generation: number,
  toolInputs: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): PiHistoryEntry | null {
  if (
    !isRecord(entry) ||
    typeof entry.id !== "string" ||
    typeof entry.type !== "string" ||
    typeof entry.timestamp !== "string"
  ) {
    return null;
  }
  const typed = entry as PiSessionEntry;
  let event: PiHistoryEvent | null = null;
  if (typed.type === "message") {
    event = messageHistoryEvent(typed, generation, toolInputs);
  } else if (typed.type === "custom") {
    event = customHistoryEvent(typed, generation);
  } else if (typed.type === "custom_message" && typed.display === true) {
    event = systemMessage(typed, generation, typed.content);
  } else if (typed.type === "compaction") {
    event = systemMessage(typed, generation, typed.summary);
  } else if (typed.type === "branch_summary") {
    event = systemMessage(typed, generation, typed.summary);
  }
  if (!event) return null;
  return {
    id: typed.id,
    parentId: typeof typed.parentId === "string" || typed.parentId === null ? typed.parentId : null,
    timestamp: timestamp(undefined, typed.timestamp),
    event,
  };
}

export function piSessionEntriesToHistory(
  entries: readonly (PiSessionEntry | Record<string, unknown>)[],
  generation: number,
  leafId?: string | null,
): PiHistoryEntry[] {
  // Pi can retain alternate branches in one JSONL. Project only the ancestry
  // selected by its active leaf; the original records remain the authority.
  const byId = new Map<string, PiSessionEntry | Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  let selected = entries;
  if (leafId) {
    const ancestry = new Set<string>();
    let current = byId.get(leafId);
    while (current && isRecord(current) && typeof current.id === "string") {
      if (ancestry.has(current.id)) break;
      ancestry.add(current.id);
      current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
    }
    // A malformed/stale leaf must not erase history from the browser view.
    if (ancestry.size > 0)
      selected = entries.filter((entry) => isRecord(entry) && ancestry.has(entry.id as string));
  }
  const inputs = new Map<string, Record<string, unknown>>();
  for (const entry of selected) {
    if (isRecord(entry) && typeof entry.id === "string") {
      for (const [id, input] of toolCallInputs(entry as PiSessionEntry)) inputs.set(id, input);
    }
  }
  return selected.flatMap((entry) => {
    const normalized = piSessionEntryToHistoryEntry(entry, generation, inputs);
    return normalized ? [normalized] : [];
  });
}

export function sumHistoryUsage(entries: readonly PiHistoryEntry[]): PiUsage {
  const total: PiUsage = { inputTokens: 0, outputTokens: 0 };
  for (const entry of entries) {
    const event = entry.event;
    const current = event.type === "run_state" ? event.usage : undefined;
    if (!current) continue;
    total.inputTokens += current.inputTokens ?? 0;
    total.outputTokens += current.outputTokens ?? 0;
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0);
  }
  return total;
}

export function usageFromPiMessage(value: unknown): PiUsage | undefined {
  return usage(value);
}
