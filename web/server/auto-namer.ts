export interface SessionTitleRequest {
  sessionId: string;
  firstUserMessage: string;
  sessionDir: string;
  timeoutMs?: number;
}

export interface SessionTitleGenerator {
  generate(request: SessionTitleRequest): Promise<string | null>;
}

function stripRequestPreamble(value: string): string {
  const withoutMarkdown = value
    .replace(/^\s*(?:#{1,6}|>|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .replace(/^\s*@(?:piwork|pi)\b[:,：]?\s*/i, "")
    .trim();
  const withoutChinesePreamble = withoutMarkdown.replace(
    /^(?:(?:请(?:你)?|麻烦(?:你)?|劳驾|能否|可以(?:请你)?)(?:帮我|帮忙)?|帮我|帮忙)\s*/,
    "",
  );
  return withoutChinesePreamble
    .replace(
      /^(?:please\s+|could\s+you\s+|can\s+you\s+|would\s+you\s+|help\s+me\s+(?:to\s+)?)/i,
      "",
    )
    .trim();
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points
    .slice(0, Math.max(1, maximum - 1))
    .join("")
    .trimEnd()}…`;
}

/**
 * Derive a stable local title without launching another model process or
 * handling provider credentials. The same first message always produces the
 * same title on every machine.
 */
export function deriveDeterministicSessionTitle(firstUserMessage: string): string | null {
  const firstLine = firstUserMessage
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^```/.test(line));
  if (!firstLine) return null;

  const unquoted = firstLine
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const stripped = stripRequestPreamble(unquoted) || unquoted;
  const sentence = stripped.split(/(?<=[。！？!?])\s+|[。！？!?]+$/u)[0]?.trim() || stripped;
  const cleaned = sentence.replace(/[，,;；:：.。!?！？\s]+$/u, "").trim();
  if (!cleaned) return null;

  if (/[\u3400-\u9fff]/u.test(cleaned)) return truncateCodePoints(cleaned, 24);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const wordLimited = words.length > 8 ? `${words.slice(0, 8).join(" ")}…` : cleaned;
  return truncateCodePoints(wordLimited, 64);
}

export class DeterministicSessionTitleGenerator implements SessionTitleGenerator {
  async generate(request: SessionTitleRequest): Promise<string | null> {
    return deriveDeterministicSessionTitle(request.firstUserMessage);
  }
}
