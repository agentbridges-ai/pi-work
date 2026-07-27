import Markdown from "@lobehub/ui/es/Markdown/Markdown";
import type { MarkdownProps } from "@lobehub/ui/es/Markdown/type";
import { useMemo, type ComponentProps } from "react";
import rehypeSlug from "rehype-slug";

const headingRehypePlugins: NonNullable<MarkdownProps["rehypePlugins"]> = [rehypeSlug];

export interface StreamingMarkdownEngineProps {
  text: string;
  isStreaming?: boolean;
  className?: string;
  paragraphClassName?: string;
}

export function StreamingMarkdownEngine({
  text,
  isStreaming = false,
  className = "markdown-body max-w-full overflow-hidden break-words [overflow-wrap:anywhere]",
  paragraphClassName,
}: StreamingMarkdownEngineProps) {
  const trimmedText = text.trim();
  const components = useMemo<MarkdownProps["components"]>(
    () => ({
      hr: () => <hr className="piwork-markdown-divider" />,
      ...(paragraphClassName
        ? {
            p: ({ children }: ComponentProps<"p">) => (
              <p className={paragraphClassName}>{children}</p>
            ),
          }
        : {}),
    }),
    [paragraphClassName],
  );

  if (!trimmedText) {
    return <div className={className} data-markdown-engine="lobe-ui" data-testid="markdown" />;
  }

  return (
    <Markdown
      allowHtml={false}
      animated={isStreaming}
      className={className}
      components={components}
      data-markdown-engine="lobe-ui"
      data-testid="markdown"
      enableStream={isStreaming}
      rehypePlugins={headingRehypePlugins}
      streamAnimationGranularity="word"
      variant="chat"
    >
      {text}
    </Markdown>
  );
}
