import { useEffect, useRef, useState } from "react";
import type { ChatMessage, PiMessagePart, ToolExecutionEvent } from "../types.js";
import { ToolBlock } from "./ToolBlock.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import {
  parseUserSpaceReferenceText,
  requestUserSpaceFilePreview,
} from "../user-space-file-refs.js";
import { FileReferenceIcon } from "./FileReferenceIcon.js";
import { uiCopy } from "../ui-copy.js";
import { TaskStopButton } from "./TaskStopButton.js";

export function MessageBubble({
  message,
  sessionId,
}: {
  message: ChatMessage;
  sessionId?: string;
}) {
  if (
    message.role === "assistant" &&
    message.content.trim().toLowerCase() === "(no content)" &&
    !message.contentParts?.length &&
    !message.toolExecutions?.length
  ) {
    return null;
  }

  if (message.role === "system") {
    return (
      <div className="flex min-w-0 items-center gap-3 py-1">
        <div className="h-px flex-1 shrink-0 bg-border" />
        <span className="min-w-0 break-words px-1 text-center font-mono-code text-xs italic text-muted-foreground">
          {message.content}
        </span>
        <div className="h-px flex-1 shrink-0 bg-border" />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div
        className="flex justify-end"
        data-message-anchor-id={message.id}
        data-message-anchor-role="user"
      >
        <div className="piwork-user-bubble max-w-[86%] min-w-0 overflow-hidden rounded-[var(--piwork-message-bubble-radius)] px-3 py-2 text-foreground">
          {message.images && message.images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {message.images.map((image, index) => (
                <img
                  key={`${image.mediaType}:${index}`}
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={uiCopy.message.imageAttachmentAlt}
                  className="max-h-[120px] max-w-[150px] rounded-[var(--piwork-panel-radius)] border border-border/30 object-cover sm:max-h-[150px] sm:max-w-[200px]"
                />
              ))}
            </div>
          )}
          <UserMessageContent text={message.content} sessionId={sessionId} />
        </div>
      </div>
    );
  }

  return <AssistantMessage message={message} sessionId={sessionId} />;
}

function UserMessageContent({ text, sessionId }: { text: string; sessionId?: string }) {
  const parsed = parseUserSpaceReferenceText(text);
  if (!text.trim()) return null;

  return (
    <div className="piwork-user-message-content max-w-full overflow-hidden whitespace-normal text-sm font-medium leading-relaxed text-foreground">
      {parsed.segments.map((segment, index) => {
        if (segment.kind === "text") {
          return <span key={`text:${index}`}>{segment.text}</span>;
        }
        const icon = (
          <span className="mr-1 inline-flex h-4 w-5 shrink-0 items-center justify-center align-[-3px]">
            <FileReferenceIcon path={segment.ref.path} />
          </span>
        );
        if (!sessionId) {
          return (
            <span
              key={`ref:${segment.ref.path}:${index}`}
              className="piwork-user-file-reference inline"
              title={segment.ref.name}
            >
              {icon}
              {segment.ref.name}
            </span>
          );
        }
        return (
          <button
            key={`ref:${segment.ref.path}:${index}`}
            type="button"
            onClick={() => requestUserSpaceFilePreview(sessionId, segment.ref)}
            className="piwork-user-file-reference inline cursor-pointer"
            style={{ font: "inherit" }}
            aria-label={uiCopy.message.previewReferencedFile(segment.ref.name)}
            title={segment.ref.name}
          >
            {icon}
            {segment.ref.name}
          </button>
        );
      })}
    </div>
  );
}

function AssistantMessage({ message, sessionId }: { message: ChatMessage; sessionId?: string }) {
  const parts = message.contentParts ?? [];
  const textParts = parts.filter(
    (part): part is Extract<PiMessagePart, { type: "text" }> => part.type === "text",
  );
  const thinkingParts = parts.filter(
    (part): part is Extract<PiMessagePart, { type: "thinking" }> => part.type === "thinking",
  );
  const imageParts = parts.filter(
    (part): part is Extract<PiMessagePart, { type: "image" }> => part.type === "image",
  );
  const text = textParts.length > 0 ? textParts.map((part) => part.text).join("") : message.content;

  return (
    <div className="min-w-0 space-y-3">
      {thinkingParts.map((part, index) => (
        <ThinkingBlock
          key={`${message.id}:thinking:${index}`}
          text={part.thinking}
          isStreaming={message.isStreaming && message.streamingPhase === "thinking"}
        />
      ))}
      {text.trim() || message.isStreaming ? (
        <MarkdownContent
          text={text}
          isStreaming={message.isStreaming && message.streamingPhase !== "thinking"}
        />
      ) : null}
      {imageParts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageParts.map((part, index) => (
            <img
              key={`${part.mediaType}:${index}`}
              src={`data:${part.mediaType};base64,${part.data}`}
              alt={uiCopy.message.imageAttachmentAlt}
              className="max-h-52 max-w-full rounded-[var(--piwork-panel-radius)] border border-border object-contain"
            />
          ))}
        </div>
      )}
      {message.toolExecutions?.map((execution) => (
        <ToolExecution key={execution.toolCallId} execution={execution} sessionId={sessionId} />
      ))}
    </div>
  );
}

export function MarkdownContent({
  text,
  showCursor,
  isStreaming,
  className = "markdown-body max-w-full overflow-hidden break-words [overflow-wrap:anywhere]",
  paragraphClassName,
}: {
  text: string;
  showCursor?: boolean;
  isStreaming?: boolean;
  className?: string;
  paragraphClassName?: string;
}) {
  return (
    <StreamingMarkdown
      text={text}
      isStreaming={isStreaming || showCursor}
      className={className}
      paragraphClassName={paragraphClassName}
    />
  );
}

function ThinkingBlock({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  const normalized = text.trim();
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setExpanded(false);
  }, [isStreaming]);

  useEffect(() => {
    if (!isStreaming || !expanded || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [expanded, isStreaming, normalized]);

  if (!normalized) return null;
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? uiCopy.message.collapseThinking : uiCopy.message.expandThinking}
        className="flex cursor-pointer items-center gap-2 text-left text-sm font-medium text-muted-foreground/75 transition-colors hover:text-muted-foreground"
      >
        <span>{isStreaming ? uiCopy.message.thinkingStreaming : uiCopy.message.thinkingDone}</span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
          className={`h-4 w-4 text-muted-foreground/70 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4.2 6.1 8 9.9l3.8-3.8 1.1 1.1L8 12 3.1 7.2l1.1-1.1Z" />
        </svg>
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          data-testid="thinking-scroll"
          className="mt-3 max-h-72 overflow-y-auto border-l-2 border-border/70 pl-3 pr-2"
        >
          <StreamingMarkdown
            text={normalized || uiCopy.message.noThinking}
            isStreaming={isStreaming}
            className="markdown-body text-sm leading-7 text-muted-foreground/75 [&_em]:not-italic"
            paragraphClassName="mb-2.5 last:mb-0"
          />
        </div>
      )}
    </div>
  );
}

function ToolExecution({
  execution,
  sessionId,
}: {
  execution: ToolExecutionEvent;
  sessionId?: string;
}) {
  const hasTerminalOutput =
    execution.output !== undefined || execution.error || execution.status !== "started";
  return (
    <div className="space-y-1">
      <ToolBlock
        name={execution.toolName}
        input={execution.input ?? {}}
        toolUseId={execution.toolCallId}
        compact
      />
      {sessionId &&
        execution.toolName === "task" &&
        execution.task?.taskId &&
        (execution.status === "started" || execution.status === "running") && (
          <div className="ml-6">
            <TaskStopButton sessionId={sessionId} taskId={execution.task.taskId} />
          </div>
        )}
      {hasTerminalOutput && (
        <div className="ml-6 overflow-hidden rounded-[var(--piwork-panel-radius)] bg-muted">
          {(execution.output !== undefined || execution.error) && (
            <pre
              className={`max-h-60 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono-code text-xs leading-relaxed ${
                execution.error ? "text-danger" : "text-foreground/70"
              }`}
            >
              {execution.error ||
                (typeof execution.output === "string"
                  ? execution.output
                  : JSON.stringify(execution.output, null, 2))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
