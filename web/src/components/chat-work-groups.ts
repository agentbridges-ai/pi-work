import type { ChatMessage, ToolExecutionEvent } from "../types.js";
import { uiCopy } from "../ui-copy.js";

export interface WorkToolStep {
  kind: "tool";
  id: string;
  sourceMessageId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  execution: ToolExecutionEvent;
}

export interface WorkResultStep {
  kind: "result";
  id: string;
  sourceMessageId: string;
  toolUseId: string;
  name?: string;
  content: string;
  isError: boolean;
}

export interface WorkThinkingStep {
  kind: "thinking";
  id: string;
  sourceMessageId: string;
  text: string;
}

export type WorkStep = WorkToolStep | WorkResultStep | WorkThinkingStep;

export interface WorkGroupEntry {
  kind: "work_group";
  id: string;
  firstId: string;
  steps: WorkStep[];
}

export interface SubagentGroupEntry {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  status?: string;
  children: FeedDisplayItem[];
}

export type FeedDisplayItem =
  { kind: "message"; msg: ChatMessage } | WorkGroupEntry | SubagentGroupEntry;

interface TaskInfo {
  description: string;
  status?: string;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasVisibleAssistantText(message: ChatMessage): boolean {
  if (message.content.trim() && message.content.trim().toLowerCase() !== "(no content)")
    return true;
  return Boolean(
    message.contentParts?.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
}

function executionSteps(messageId: string, execution: ToolExecutionEvent): WorkStep[] {
  const steps: WorkStep[] = [
    {
      kind: "tool",
      id: execution.toolCallId,
      sourceMessageId: messageId,
      toolUseId: execution.toolCallId,
      name: execution.toolName,
      input: execution.input ?? {},
      execution,
    },
  ];
  if (
    execution.output !== undefined ||
    execution.error ||
    execution.status === "failed" ||
    execution.status === "cancelled"
  ) {
    steps.push({
      kind: "result",
      id: `${messageId}:result:${execution.toolCallId}`,
      sourceMessageId: messageId,
      toolUseId: execution.toolCallId,
      name: execution.toolName,
      content: execution.error || stringifyOutput(execution.output),
      isError: execution.status === "failed" || Boolean(execution.error),
    });
  }
  return steps;
}

function extractWorkSteps(message: ChatMessage): WorkStep[] {
  if (message.role !== "assistant" || hasVisibleAssistantText(message)) return [];
  const steps: WorkStep[] = [];
  message.contentParts?.forEach((part, index) => {
    if (part.type === "thinking" && part.thinking.trim()) {
      steps.push({
        kind: "thinking",
        id: `${message.id}:thinking:${index}`,
        sourceMessageId: message.id,
        text: part.thinking,
      });
    }
  });
  for (const execution of message.toolExecutions ?? []) {
    steps.push(...executionSteps(message.id, execution));
  }
  return steps;
}

function isInvisibleAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || hasVisibleAssistantText(message)) return false;
  const hasThinking = message.contentParts?.some(
    (part) => part.type === "thinking" && part.thinking.trim(),
  );
  return !hasThinking && !message.toolExecutions?.length;
}

function makeWorkGroup(steps: WorkStep[]): WorkGroupEntry {
  const first = steps[0]!;
  return {
    kind: "work_group",
    id: `work-${first.sourceMessageId}-${first.id}`,
    firstId: first.sourceMessageId,
    steps,
  };
}

function groupWorkMessages(messages: ChatMessage[]): FeedDisplayItem[] {
  const entries: FeedDisplayItem[] = [];
  let bufferedSteps: WorkStep[] = [];
  const flush = () => {
    if (bufferedSteps.length === 0) return;
    entries.push(makeWorkGroup(bufferedSteps));
    bufferedSteps = [];
  };

  for (const message of messages) {
    const steps = extractWorkSteps(message);
    if (steps.length > 0) {
      bufferedSteps.push(...steps);
      continue;
    }
    if (isInvisibleAssistantMessage(message)) continue;
    flush();
    entries.push({ kind: "message", msg: message });
  }
  flush();
  return entries;
}

function getTaskInfo(messages: ChatMessage[]): Map<string, TaskInfo> {
  const tasks = new Map<string, TaskInfo>();
  for (const message of messages) {
    for (const execution of message.toolExecutions ?? []) {
      if (execution.toolName !== "task") continue;
      tasks.set(execution.toolCallId, {
        description:
          execution.task?.description ||
          execution.task?.name ||
          String(execution.input?.description || uiCopy.timeline.subagent),
        status: execution.task?.status || execution.status,
      });
    }
  }
  return tasks;
}

function getTaskIdsFromEntry(entry: FeedDisplayItem): string[] {
  if (entry.kind === "message") {
    return (entry.msg.toolExecutions ?? [])
      .filter((execution) => execution.toolName === "task")
      .map((execution) => execution.toolCallId);
  }
  if (entry.kind === "work_group") {
    return entry.steps
      .filter((step): step is WorkToolStep => step.kind === "tool" && step.name === "task")
      .map((step) => step.toolUseId);
  }
  return [];
}

function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<string, TaskInfo>,
  childrenByParent: Map<string, ChatMessage[]>,
): FeedDisplayItem[] {
  const result: FeedDisplayItem[] = [];
  for (const entry of groupWorkMessages(messages)) {
    result.push(entry);
    for (const taskId of getTaskIdsFromEntry(entry)) {
      const children = childrenByParent.get(taskId);
      if (!children?.length) continue;
      const info = taskInfo.get(taskId) ?? {
        description: uiCopy.timeline.subagent,
      };
      result.push({
        kind: "subagent",
        taskToolUseId: taskId,
        description: info.description,
        status: info.status,
        children: buildEntries(children, taskInfo, childrenByParent),
      });
    }
  }
  return result;
}

export function buildFeedDisplayItems(messages: ChatMessage[]): FeedDisplayItem[] {
  const taskInfo = getTaskInfo(messages);
  if (taskInfo.size === 0) return groupWorkMessages(messages);

  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];
  for (const message of messages) {
    if (message.parentToolCallId && taskInfo.has(message.parentToolCallId)) {
      const children = childrenByParent.get(message.parentToolCallId) ?? [];
      children.push(message);
      childrenByParent.set(message.parentToolCallId, children);
    } else {
      topLevel.push(message);
    }
  }
  return buildEntries(topLevel, taskInfo, childrenByParent);
}

export function getWorkStepToolUseId(step: WorkStep): string | null {
  return step.kind === "thinking" ? null : step.toolUseId;
}

export function summarizeWorkSteps(steps: WorkStep[]): string {
  return uiCopy.toolSummary.steps(steps.length);
}
