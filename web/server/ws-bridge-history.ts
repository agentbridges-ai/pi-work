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

function messageHistoryEvent(entry: PiSessionEntry, generation: number): PiHistoryEvent | null {
  return projectNativeMessage(entry.message, {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: nativeTimestamp(undefined, entry.timestamp),
    generation,
  });
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
    event = messageHistoryEvent(typed, generation);
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
): PiHistoryEntry[] {
  return entries.flatMap((entry) => {
    const normalized = piSessionEntryToHistoryEntry(entry, generation);
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
