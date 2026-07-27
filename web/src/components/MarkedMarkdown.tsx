import { useMemo } from "react";
import { marked, Renderer, type Tokens } from "marked";

export interface MarkedMarkdownProps {
  text: string;
  className?: string;
  softLineBreaks?: boolean;
  resolveImageSrc?: (src: string) => string;
}

export function MarkedMarkdown({
  text,
  className = "marked-markdown markdown-body max-w-full break-words text-sm font-medium leading-relaxed text-foreground [overflow-wrap:anywhere] sm:text-sm",
  softLineBreaks = false,
  resolveImageSrc,
}: MarkedMarkdownProps) {
  const html = useMemo(() => {
    const renderer = createSafeRenderer(resolveImageSrc);
    return marked.parse(text, {
      async: false,
      breaks: softLineBreaks,
      gfm: true,
      renderer,
    }) as string;
  }, [resolveImageSrc, softLineBreaks, text]);

  return (
    <div
      className={className}
      data-markdown-engine="marked"
      data-testid="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function createSafeRenderer(resolveImageSrc?: (src: string) => string): Renderer {
  const renderer = new Renderer();
  const defaultLink = renderer.link.bind(renderer);
  const defaultImage = renderer.image.bind(renderer);
  renderer.html = (token) => sanitizeRawHtml(token.text);
  renderer.link = (token) => {
    if (!isSafeResourceUrl(token.href, false)) {
      return renderer.parser.parseInline(token.tokens);
    }
    const rendered = defaultLink(token);
    return rendered.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
  };
  renderer.image = (token: Tokens.Image) => {
    const resolvedHref = resolveImageSrc?.(token.href) ?? token.href;
    if (!isSafeResourceUrl(resolvedHref, true)) return escapeHtml(token.text);
    return defaultImage({ ...token, href: resolvedHref });
  };
  return renderer;
}

function isSafeResourceUrl(value: string, image: boolean): boolean {
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f\s]+/g, "")
    .toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized)?.[1];
  if (!scheme) return true;
  if (scheme === "http" || scheme === "https") return true;
  if (!image) return scheme === "mailto";
  return scheme === "blob" || (scheme === "data" && normalized.startsWith("data:image/"));
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] || character,
  );
}

const SAFE_RAW_HTML_TAGS = new Set([
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

function sanitizeRawHtml(value: string): string {
  if (typeof document === "undefined") return escapeHtml(value);
  const template = document.createElement("template");
  template.innerHTML = value;
  for (const element of [...template.content.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    if (!SAFE_RAW_HTML_TAGS.has(tag)) {
      element.replaceWith(document.createTextNode(element.outerHTML));
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const safeAlign =
        name === "align" && /^(?:left|right|center|justify)$/.test(attribute.value.toLowerCase());
      const safeSpan =
        (name === "colspan" || name === "rowspan") && /^\d{1,2}$/.test(attribute.value);
      const safeOpen = tag === "details" && name === "open";
      if (!safeAlign && !safeSpan && !safeOpen) element.removeAttribute(attribute.name);
    }
  }
  return template.innerHTML;
}
