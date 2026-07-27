import type { ChatMessage, PiMessagePart, ToolExecutionEvent } from "./types.js";

export function extractTextFromParts(parts: PiMessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function partKey(part: PiMessagePart): string {
  if (part.type === "text") return `text:${part.text}`;
  if (part.type === "thinking") return `thinking:${part.thinking}`;
  return `image:${part.mediaType}:${part.data}`;
}

export function mergeMessageParts(
  previous?: PiMessagePart[],
  incoming?: PiMessagePart[],
): PiMessagePart[] | undefined {
  const all = [...(previous || []), ...(incoming || [])];
  if (all.length === 0) return undefined;
  const seen = new Set<string>();
  return all.filter((part) => {
    const key = partKey(part);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeToolExecutions(
  previous?: ToolExecutionEvent[],
  incoming?: ToolExecutionEvent[],
): ToolExecutionEvent[] | undefined {
  if (!previous?.length && !incoming?.length) return undefined;
  const byId = new Map<string, ToolExecutionEvent>();
  for (const event of [...(previous || []), ...(incoming || [])]) {
    byId.set(event.toolCallId, { ...byId.get(event.toolCallId), ...event });
  }
  return Array.from(byId.values()).sort((left, right) => left.timestamp - right.timestamp);
}

export function mergeAgentMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  const contentParts = mergeMessageParts(previous.contentParts, incoming.contentParts);
  return {
    ...previous,
    ...incoming,
    content:
      contentParts && contentParts.length > 0
        ? extractTextFromParts(contentParts)
        : incoming.content || previous.content,
    contentParts,
    toolExecutions: mergeToolExecutions(previous.toolExecutions, incoming.toolExecutions),
    timestamp: previous.timestamp ?? incoming.timestamp,
    isStreaming: incoming.isStreaming,
  };
}

export function mergeChronologicalMessages(
  older: ChatMessage[],
  newer: ChatMessage[],
): ChatMessage[] {
  const merged: ChatMessage[] = [];
  const seen = new Map<string, number>();
  for (const message of [...older, ...newer]) {
    const index = seen.get(message.id);
    if (index === undefined) {
      seen.set(message.id, merged.length);
      merged.push(message);
    } else if (message.role === "assistant" && merged[index]?.role === "assistant") {
      merged[index] = mergeAgentMessage(merged[index], message);
    }
  }
  return merged.sort((left, right) => left.timestamp - right.timestamp);
}
