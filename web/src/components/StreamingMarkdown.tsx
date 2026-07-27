import { lazy, Suspense } from "react";
import type { StreamingMarkdownEngineProps } from "./StreamingMarkdownEngine.js";

export type StreamingMarkdownProps = StreamingMarkdownEngineProps;

const DEFAULT_CLASS_NAME =
  "markdown-body max-w-full overflow-hidden break-words [overflow-wrap:anywhere]";

const StreamingMarkdownEngine = lazy(async () => {
  const module = await import("./StreamingMarkdownEngine.js");
  return { default: module.StreamingMarkdownEngine };
});

/** Defers the message parser until a message actually needs rich rendering. */
export function StreamingMarkdown({
  className = DEFAULT_CLASS_NAME,
  ...props
}: StreamingMarkdownProps) {
  const fallbackWhitespaceClass = className.includes("whitespace-normal")
    ? ""
    : " whitespace-pre-wrap";

  return (
    <Suspense
      fallback={
        <div
          className={`${className}${fallbackWhitespaceClass}`}
          data-markdown-engine="plain-fallback"
          data-testid="markdown"
        >
          {props.text}
        </div>
      }
    >
      <StreamingMarkdownEngine {...props} className={className} />
    </Suspense>
  );
}
