import { useMemo, type ReactNode } from "react";
import type { ChatMessage, ToolExecutionEvent } from "../types.js";
import type { ToolActivityEntry } from "../store/tasks-slice.js";
import { MessageBubble, MarkdownContent } from "./MessageBubble.js";
import { TimelineRailItem, TimelineRailScope, type TimelineTone } from "./TimelineRail.js";
import { TimelinePlanNode, type PlanApprovalStatus } from "./TimelinePlanNode.js";
import { getPreview, getToolLabel, ToolDetail } from "./ToolBlock.js";
import { TaskStopButton } from "./TaskStopButton.js";
import type {
  FeedDisplayItem,
  SubagentGroupEntry,
  WorkGroupEntry,
  WorkResultStep,
  WorkStep,
  WorkThinkingStep,
} from "./chat-work-groups.js";
import { uiCopy } from "../ui-copy.js";

interface ToolTimelineNode {
  kind: "tool";
  id: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  execution: ToolExecutionEvent;
  result?: WorkResultStep;
}

type WorkTimelineNode = WorkThinkingStep | ToolTimelineNode;

export interface TimelineRenderContext {
  entryCount: number;
}

export interface TimelineDisclosureController {
  isOpen: (id: string, defaultOpen: boolean) => boolean;
  onOpenChange: (id: string, open: boolean, defaultOpen: boolean) => void;
}

const EMPTY_TOOL_IDS = new Set<string>();
const TOOL_PANEL_MAX_HEIGHT = 320;

function getTimelineDisclosureProps(
  disclosureController: TimelineDisclosureController | undefined,
  id: string,
  defaultOpen: boolean,
) {
  if (!disclosureController) return {};
  return {
    open: disclosureController.isOpen(id, defaultOpen),
    onOpenChange: (open: boolean) => disclosureController.onOpenChange(id, open, defaultOpen),
  };
}

export function createTimelineRenderContext(entries: FeedDisplayItem[]): TimelineRenderContext {
  return { entryCount: entries.length };
}

export function TimelineEntries({
  entries,
  sessionId,
  toolActivity,
  runningToolIds = EMPTY_TOOL_IDS,
  awaitingToolIds = EMPTY_TOOL_IDS,
  disclosureController,
}: {
  entries: FeedDisplayItem[];
  sessionId?: string;
  toolActivity?: ToolActivityEntry[];
  runningToolIds?: Set<string>;
  awaitingToolIds?: Set<string>;
  renderContext?: TimelineRenderContext;
  disclosureController?: TimelineDisclosureController;
}) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "message") {
          return (
            <TimelineMessage
              key={entry.msg.id || `message:${index}`}
              message={entry.msg}
              sessionId={sessionId}
              toolActivity={toolActivity}
              runningToolIds={runningToolIds}
              awaitingToolIds={awaitingToolIds}
              disclosureController={disclosureController}
            />
          );
        }
        if (entry.kind === "subagent") {
          return (
            <TimelineSubagent
              key={entry.taskToolUseId}
              group={entry}
              sessionId={sessionId}
              toolActivity={toolActivity}
              runningToolIds={runningToolIds}
              awaitingToolIds={awaitingToolIds}
              disclosureController={disclosureController}
            />
          );
        }
        return (
          <TimelineWorkGroup
            key={entry.id}
            group={entry}
            sessionId={sessionId}
            toolActivity={toolActivity}
            runningToolIds={runningToolIds}
            awaitingToolIds={awaitingToolIds}
            disclosureController={disclosureController}
          />
        );
      })}
    </>
  );
}

function TimelineMessage({
  message,
  sessionId,
  toolActivity,
  runningToolIds,
  awaitingToolIds,
  disclosureController,
}: {
  message: ChatMessage;
  sessionId?: string;
  toolActivity?: ToolActivityEntry[];
  runningToolIds: Set<string>;
  awaitingToolIds: Set<string>;
  disclosureController?: TimelineDisclosureController;
}) {
  if (message.role !== "assistant") {
    return <MessageBubble message={message} sessionId={sessionId} />;
  }

  const thinkingParts =
    message.contentParts?.filter(
      (part): part is Extract<(typeof message.contentParts)[number], { type: "thinking" }> =>
        part.type === "thinking",
    ) ?? [];
  const textParts =
    message.contentParts?.filter(
      (part): part is Extract<(typeof message.contentParts)[number], { type: "text" }> =>
        part.type === "text",
    ) ?? [];
  const text = textParts.length > 0 ? textParts.map((part) => part.text).join("") : message.content;
  const hasImages = message.contentParts?.some((part) => part.type === "image");

  return (
    <>
      {thinkingParts.map((part, index) => (
        <TimelineThinkingNode
          key={`${message.id}:thinking:${index}`}
          id={`${message.id}:thinking:${index}`}
          text={part.thinking}
          isStreaming={message.isStreaming && message.streamingPhase === "thinking"}
          disclosureController={disclosureController}
        />
      ))}
      {(text.trim() || message.isStreaming) && (
        <TimelineAssistantText
          id={message.id}
          text={text}
          isStreaming={message.isStreaming && message.streamingPhase !== "thinking"}
        />
      )}
      {hasImages && (
        <MessageBubble
          message={{
            ...message,
            content: "",
            contentParts: message.contentParts?.filter((part) => part.type === "image"),
            toolExecutions: [],
          }}
        />
      )}
      {(message.toolExecutions ?? []).map((execution) => (
        <TimelineToolNode
          key={execution.toolCallId}
          node={toolNodeFromExecution(execution)}
          sessionId={sessionId}
          toolActivity={toolActivity}
          runningToolIds={runningToolIds}
          awaitingToolIds={awaitingToolIds}
          disclosureController={disclosureController}
        />
      ))}
    </>
  );
}

function TimelineWorkGroup({
  group,
  sessionId,
  toolActivity,
  runningToolIds,
  awaitingToolIds,
  disclosureController,
}: {
  group: WorkGroupEntry;
  sessionId?: string;
  toolActivity?: ToolActivityEntry[];
  runningToolIds: Set<string>;
  awaitingToolIds: Set<string>;
  disclosureController?: TimelineDisclosureController;
}) {
  const nodes = useMemo(() => buildTimelineNodes(group.steps), [group.steps]);
  return (
    <div data-testid="work-group" className="timeline-work-group space-y-2">
      {nodes.map((node) =>
        node.kind === "thinking" ? (
          <TimelineThinkingNode
            key={node.id}
            id={node.id}
            text={node.text}
            disclosureController={disclosureController}
          />
        ) : (
          <TimelineToolNode
            key={node.id}
            node={node}
            sessionId={sessionId}
            toolActivity={toolActivity}
            runningToolIds={runningToolIds}
            awaitingToolIds={awaitingToolIds}
            disclosureController={disclosureController}
          />
        ),
      )}
    </div>
  );
}

function TimelineAssistantText({
  id,
  text,
  isStreaming,
}: {
  id: string;
  text: string;
  isStreaming?: boolean;
}) {
  if (!text.trim() && !isStreaming) return null;
  return (
    <TimelineRailItem
      id={id}
      tone={isStreaming ? "running" : "muted"}
      compactHeader
      defaultOpen
      forceBody
    >
      <MarkdownContent text={text} isStreaming={isStreaming} />
    </TimelineRailItem>
  );
}

function TimelineThinkingNode({
  id,
  text,
  isStreaming = false,
  disclosureController,
}: {
  id: string;
  text: string;
  isStreaming?: boolean;
  disclosureController?: TimelineDisclosureController;
}) {
  return (
    <TimelineRailItem
      id={id}
      tone={isStreaming ? "running" : "idle"}
      title={uiCopy.timeline.thinking}
      titleClassName="text-muted-foreground/75"
      defaultOpen={false}
      autoOpenOnActive={false}
      {...getTimelineDisclosureProps(disclosureController, id, false)}
    >
      <MarkdownContent
        text={text.trim() || uiCopy.timeline.noThinking}
        isStreaming={isStreaming}
        className="markdown-body text-sm leading-7 text-muted-foreground/75 [&_em]:not-italic"
        paragraphClassName="mb-2.5 last:mb-0"
      />
    </TimelineRailItem>
  );
}

function TimelineToolNode({
  node,
  sessionId,
  toolActivity,
  runningToolIds,
  awaitingToolIds,
  disclosureController,
}: {
  node: ToolTimelineNode;
  sessionId?: string;
  toolActivity?: ToolActivityEntry[];
  runningToolIds: Set<string>;
  awaitingToolIds: Set<string>;
  disclosureController?: TimelineDisclosureController;
}) {
  const activity = toolActivity?.find((entry) => entry.toolCallId === node.toolUseId);
  const status = activity?.status ?? node.execution.status;
  const isAwaiting = awaitingToolIds.has(node.toolUseId);
  const isRunning =
    !isAwaiting &&
    (runningToolIds.has(node.toolUseId) || status === "started" || status === "running");
  const tone: TimelineTone =
    node.result?.isError || status === "failed"
      ? "error"
      : isAwaiting || status === "cancelled"
        ? "warning"
        : isRunning
          ? "running"
          : status === "completed"
            ? "success"
            : "idle";
  const preview = getPreview(node.name, node.input);
  const title = compactTitle([getToolLabel(node.name), preview].filter(Boolean).join(" "));
  const plan = node.name === "propose_plan" ? String(node.input.plan || "").trim() : "";

  if (node.name === "ask" && !node.result && !node.execution.output) {
    return (
      <TimelineRailItem
        id={node.id}
        tone={tone}
        title={uiCopy.interaction.askTitle}
        autoOpenOnActive={false}
      />
    );
  }

  if (plan) {
    return (
      <TimelinePlanNode
        id={node.id}
        plan={plan}
        tone={tone}
        approvalStatus={getPlanApprovalStatus(node)}
      />
    );
  }

  return (
    <TimelineRailItem
      id={node.id}
      tone={tone}
      title={node.name === "ask" ? uiCopy.interaction.askTitle : title}
      defaultOpen={node.name === "ask"}
      autoOpenOnActive={false}
      {...getTimelineDisclosureProps(disclosureController, node.id, node.name === "ask")}
    >
      <ToolIOPanel node={node} />
      {sessionId &&
        node.name === "task" &&
        node.execution.task?.taskId &&
        (status === "started" || status === "running") && (
          <div className="mt-2">
            <TaskStopButton sessionId={sessionId} taskId={node.execution.task.taskId} />
          </div>
        )}
    </TimelineRailItem>
  );
}

function ToolIOPanel({ node }: { node: ToolTimelineNode }) {
  const output = node.result?.content ?? stringifyOutput(node.execution.output);

  if (node.name === "ask") {
    return (
      <AskUserQuestionReviewPanel
        input={node.input}
        output={node.result?.content}
        result={node.execution.output}
        isError={Boolean(node.result?.isError || node.execution.error)}
      />
    );
  }

  const hasInput = Object.keys(node.input).length > 0;
  const hideSuccessfulFileOutput =
    (node.name === "write" || node.name === "edit") && !node.result?.isError;
  const hasOutput = Boolean(output.trim()) && !hideSuccessfulFileOutput;
  const showLabels = hasInput && hasOutput;

  return (
    <div className="piwork-superellipse-panel overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border/75 bg-card">
      <div className="overflow-auto" style={{ maxHeight: `${TOOL_PANEL_MAX_HEIGHT}px` }}>
        {hasInput && (
          <IOSection label="IN" showLabel={showLabels}>
            <ToolDetail name={node.name} input={node.input} />
          </IOSection>
        )}
        {hasOutput && (
          <IOSection label="OUT" separated={hasInput} showLabel={showLabels}>
            <pre
              className={`m-0 overflow-x-auto whitespace-pre-wrap p-0 font-mono-code text-xs leading-6 ${
                node.result?.isError || node.execution.error ? "text-danger" : "text-foreground/74"
              }`}
            >
              {output}
            </pre>
          </IOSection>
        )}
        {!hasInput && !hasOutput && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {uiCopy.timeline.noToolDetails}
          </div>
        )}
      </div>
    </div>
  );
}

interface AskUserQuestionReviewItem {
  header?: string;
  question: string;
  answer?: string;
}

function AskUserQuestionReviewPanel({
  input,
  output,
  result,
  isError,
}: {
  input: Record<string, unknown>;
  output?: string;
  result?: unknown;
  isError?: boolean;
}) {
  const review = parseAskUserQuestionReview(output) ?? parseAskUserQuestionReview(result);
  const questions = mergeAskUserQuestionReview(input, review?.questions ?? []);

  return (
    <div className="piwork-superellipse-panel rounded-[var(--piwork-panel-radius)] border border-border/75 bg-card">
      {questions.length > 0 ? (
        <div className="space-y-3 px-3 py-3">
          {questions.map((item, index) => (
            <div key={`${item.question}:${index}`} className="space-y-1.5">
              <div className="text-[13px] font-semibold leading-5 text-foreground">
                {item.question}
              </div>
              {item.answer ? (
                <div className="py-1.5 text-[13px] leading-5 text-foreground/74">{item.answer}</div>
              ) : (
                <div className="text-xs leading-5 text-muted-foreground">
                  {uiCopy.timeline.waitingAnswer}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : output?.trim() ? (
        <pre
          className={`m-0 whitespace-pre-wrap px-3 py-2.5 font-mono-code text-xs leading-6 ${
            isError ? "text-danger" : "text-foreground/74"
          }`}
        >
          {output}
        </pre>
      ) : (
        <div className="px-3 py-2.5 text-xs text-muted-foreground">
          {uiCopy.timeline.waitingAnswer}
        </div>
      )}
    </div>
  );
}

function parseAskUserQuestionReview(
  value: unknown,
): { questions: AskUserQuestionReviewItem[] } | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      return parseAskUserQuestionReview(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "ask_user_question_review") {
    return normalizeAskReviewRecord(record);
  }
  if ("details" in record) {
    const details = parseAskUserQuestionReview(record.details);
    if (details) return details;
  }
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as Record<string, unknown>).text;
      const parsed = parseAskUserQuestionReview(text);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function normalizeAskReviewRecord(record: Record<string, unknown>): {
  questions: AskUserQuestionReviewItem[];
} {
  const answers =
    record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)
      ? (record.answers as Record<string, unknown>)
      : {};
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  return {
    questions: rawQuestions.flatMap((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const item = raw as Record<string, unknown>;
      const question = typeof item.question === "string" ? item.question.trim() : "";
      if (!question) return [];
      const header =
        typeof item.header === "string" && item.header.trim() ? item.header.trim() : undefined;
      const answer =
        formatAskUserAnswer(item.answer) ??
        formatAskUserAnswer(answers[question]) ??
        formatAskUserAnswer(answers[String(index)]);
      return [{ header, question, answer }];
    }),
  };
}

function mergeAskUserQuestionReview(
  input: Record<string, unknown>,
  review: AskUserQuestionReviewItem[],
): AskUserQuestionReviewItem[] {
  const reviewByQuestion = new Map(
    review.map((item) => [normalizeQuestionKey(item.question), item]),
  );
  const inputQuestions = extractAskUserQuestionInputItems(input).map((item, index) => ({
    ...item,
    answer:
      reviewByQuestion.get(normalizeQuestionKey(item.question))?.answer ?? review[index]?.answer,
  }));
  return inputQuestions.length > 0 ? inputQuestions : review;
}

function extractAskUserQuestionInputItems(
  input: Record<string, unknown>,
): AskUserQuestionReviewItem[] {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const question = typeof item.question === "string" ? item.question.trim() : "";
    if (!question) return [];
    const header =
      typeof item.header === "string" && item.header.trim() ? item.header.trim() : undefined;
    return [{ header, question }];
  });
}

function normalizeQuestionKey(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

function formatAskUserAnswer(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.map(formatAskUserAnswer).filter(Boolean).join("、");
    return joined || undefined;
  }
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function IOSection({
  label,
  children,
  separated,
  showLabel = true,
}: {
  label: string;
  children: ReactNode;
  separated?: boolean;
  showLabel?: boolean;
}) {
  if (!showLabel) {
    return (
      <div className={separated ? "border-t border-border/70" : ""}>
        <div className="min-w-0 px-3 py-2.5">{children}</div>
      </div>
    );
  }
  return (
    <div
      className={`grid grid-cols-[46px_minmax(0,1fr)] items-baseline ${
        separated ? "border-t border-border/70" : ""
      }`}
    >
      <div className="select-none py-2.5 pl-3 pr-2 font-mono-code text-xs font-semibold leading-6 tracking-wide text-muted-foreground/65">
        {label}
      </div>
      <div className="min-w-0 py-2.5 pl-0 pr-3 leading-6">{children}</div>
    </div>
  );
}

function TimelineSubagent({
  group,
  sessionId,
  toolActivity,
  runningToolIds,
  awaitingToolIds,
  disclosureController,
}: {
  group: SubagentGroupEntry;
  sessionId?: string;
  toolActivity?: ToolActivityEntry[];
  runningToolIds: Set<string>;
  awaitingToolIds: Set<string>;
  disclosureController?: TimelineDisclosureController;
}) {
  const status = normalizeSubagentStatus(group.status);
  const tone: TimelineTone =
    status === "failed"
      ? "error"
      : status === "completed"
        ? "success"
        : status === "running"
          ? "running"
          : "warning";

  return (
    <TimelineRailItem
      tone={tone}
      title={group.description || uiCopy.timeline.subagent}
      defaultOpen={false}
      autoOpenOnActive={false}
      {...getTimelineDisclosureProps(disclosureController, group.taskToolUseId, false)}
    >
      <TimelineRailScope className="space-y-3 border-l border-border/70 pl-4">
        <TimelineEntries
          entries={group.children}
          sessionId={sessionId}
          toolActivity={toolActivity}
          runningToolIds={runningToolIds}
          awaitingToolIds={awaitingToolIds}
          disclosureController={disclosureController}
        />
      </TimelineRailScope>
    </TimelineRailItem>
  );
}

function buildTimelineNodes(steps: WorkStep[]): WorkTimelineNode[] {
  const results = new Map<string, WorkResultStep>();
  for (const step of steps) {
    if (step.kind === "result") results.set(step.toolUseId, step);
  }
  return steps.flatMap((step): WorkTimelineNode[] => {
    if (step.kind === "result") return [];
    if (step.kind === "thinking") return [step];
    return [
      {
        kind: "tool",
        id: step.id,
        toolUseId: step.toolUseId,
        name: step.name,
        input: step.input,
        execution: step.execution,
        result: results.get(step.toolUseId),
      },
    ];
  });
}

function toolNodeFromExecution(execution: ToolExecutionEvent): ToolTimelineNode {
  const content = execution.error || stringifyOutput(execution.output);
  return {
    kind: "tool",
    id: execution.toolCallId,
    toolUseId: execution.toolCallId,
    name: execution.toolName,
    input: execution.input ?? {},
    execution,
    result: content
      ? {
          kind: "result",
          id: `${execution.toolCallId}:result`,
          sourceMessageId: execution.toolCallId,
          toolUseId: execution.toolCallId,
          name: execution.toolName,
          content,
          isError: execution.status === "failed" || Boolean(execution.error),
        }
      : undefined,
  };
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
}

function getPlanApprovalStatus(node: ToolTimelineNode): PlanApprovalStatus | undefined {
  const result = (node.result?.content || stringifyOutput(node.execution.output)).toLowerCase();
  if (!result) return undefined;
  if (result.includes("execute")) return "approved";
  if (result.includes("cancel")) return "cancelled";
  if (result.includes("continue_planning") || result.includes("refine")) return "rejected";
  return undefined;
}

function normalizeSubagentStatus(
  status?: string,
): "pending" | "running" | "completed" | "failed" | null {
  const normalized = (status || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "completed") return "completed";
  if (normalized === "failed" || normalized === "error" || normalized === "errored")
    return "failed";
  if (
    normalized === "pending" ||
    normalized === "pendinginit" ||
    normalized === "pending_init" ||
    normalized === "stopped"
  )
    return "pending";
  return "running";
}
