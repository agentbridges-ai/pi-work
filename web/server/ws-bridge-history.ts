import type { PiHistoryEntry, PiHistoryEvent, PiUsage } from "../shared/pi-browser-protocol.js";
import type { PiSessionEntry } from "./pi-session-history.js";
import {
  nativeTimestamp,
  normalizeNativeParts,
  normalizeNativeUsage,
  projectNativeMessage,
  projectNativeTodos,
} from "./native-projection-contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  const event = projectNativeMessage(entry.message, {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: nativeTimestamp(undefined, entry.timestamp),
    generation,
  });
  if (event?.type === "tool_execution") {
    const input = inputs.get(event.toolCallId);
    return input ? { ...event, input } : event;
  }
  return event;
}

function customHistoryEvent(entry: PiSessionEntry, generation: number): PiHistoryEvent | null {
  const data = isRecord(entry.data) ? entry.data : {};
  if (entry.customType === "piwork.todo") {
    const normalized = projectNativeTodos(data.todos);
    if (normalized === null) return null;
    return {
      type: "tool_execution",
      generation,
      toolCallId: entry.id,
      toolName: "todo_write",
      status: "completed",
      timestamp: nativeTimestamp(undefined, entry.timestamp),
      todos: normalized,
      output: { todos: normalized },
    };
  }
  if (entry.customType === "piwork.plan") {
    const decision = typeof data.decision === "string" ? data.decision : undefined;
    if (
      decision !== "execute" &&
      decision !== "continue_planning" &&
      decision !== "refine" &&
      decision !== "cancelled"
    ) {
      return null;
    }
    const refinement = typeof data.refinement === "string" ? data.refinement.trim() : undefined;
    if (decision === "refine" && !refinement) return null;
    return {
      type: "interaction_response",
      generation,
      requestId: entry.id,
      kind: "propose_plan",
      status: decision === "cancelled" ? "cancelled" : "submitted",
      ...(decision === "cancelled" ? {} : { decision }),
      ...(refinement ? { refinement } : {}),
      timestamp: nativeTimestamp(undefined, entry.timestamp),
    };
  }
  return null;
}

function systemMessage(
  entry: PiSessionEntry,
  generation: number,
  content: unknown,
): PiHistoryEvent | null {
  const normalized = normalizeNativeParts(content);
  if (normalized.length === 0) return null;
  return {
    type: "agent_message",
    generation,
    message: {
      id: entry.id,
      role: "system",
      content: normalized,
      timestamp: nativeTimestamp(undefined, entry.timestamp),
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
    timestamp: nativeTimestamp(undefined, typed.timestamp),
    event,
  };
}

export function piSessionEntriesToHistory(
  entries: readonly (PiSessionEntry | Record<string, unknown>)[],
  generation: number,
  leafId?: string | null,
): PiHistoryEntry[] {
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
    if (ancestry.size > 0) {
      selected = entries.filter((entry) => isRecord(entry) && ancestry.has(entry.id as string));
    }
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
  return normalizeNativeUsage(value);
}
