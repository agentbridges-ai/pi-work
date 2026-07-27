import * as Diff from "diff";

// Keep User Space text operations behavior-compatible with earendil-works/pi.
// Source of truth:
// https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools
// Last port audit: 8479bd84743e8889f728acb21a62794102db0529.
export const PI_READ_MAX_LINES = 2000;
export const PI_READ_MAX_BYTES = 50 * 1024;

export interface PiReadTextResult {
  content: string;
  totalLines: number;
  outputLines: number;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  nextOffset?: number;
}

export interface PiTextEdit {
  oldText: string;
  newText: string;
}

export interface PiEditTextResult {
  content: string;
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

interface TextReplacement {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface LineSpan {
  start: number;
  end: number;
}

export function readTextLikePi(
  textContent: string,
  path: string,
  offset?: number,
  limit?: number,
): PiReadTextResult {
  const allLines = textContent.split("\n");
  const totalLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= totalLines) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
  }

  const endLine = limit !== undefined ? Math.min(startLine + limit, totalLines) : totalLines;
  const selectedContent = allLines.slice(startLine, endLine).join("\n");
  const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
  const truncation = truncateHeadLikePi(selectedContent);

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatPiSize(utf8ByteLength(allLines[startLine] || ""));
    return {
      content: `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatPiSize(PI_READ_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${quoteUserSpaceShellPath(path)} | head -c ${PI_READ_MAX_BYTES}]`,
      totalLines,
      outputLines: 0,
      truncated: true,
      truncatedBy: "bytes",
    };
  }

  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const suffix =
      truncation.truncatedBy === "lines"
        ? `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
        : `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatPiSize(PI_READ_MAX_BYTES)} limit).\nUse offset=${nextOffset} to continue.]`;
    return {
      content: `${truncation.content}\n\n${suffix}`,
      totalLines,
      outputLines: truncation.outputLines,
      truncated: true,
      truncatedBy: truncation.truncatedBy,
      nextOffset,
    };
  }

  if (userLimitedLines !== undefined && startLine + userLimitedLines < totalLines) {
    const remaining = totalLines - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return {
      content: `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
      totalLines,
      outputLines: truncation.outputLines,
      truncated: false,
      truncatedBy: null,
      nextOffset,
    };
  }

  return {
    content: truncation.content,
    totalLines,
    outputLines: truncation.outputLines,
    truncated: false,
    truncatedBy: null,
  };
}

export function applyTextEditsLikePi(
  rawContent: string,
  edits: PiTextEdit[],
  path: string,
): PiEditTextResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  const { bom, text } = stripBom(rawContent);
  const originalEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLF(text);
  const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
  const diffResult = generateDiffString(baseContent, newContent);
  return {
    content: bom + restoreLineEndings(newContent, originalEnding),
    diff: diffResult.diff,
    patch: Diff.createTwoFilesPatch(path, path, baseContent, newContent, undefined, undefined, {
      context: 4,
      headerOptions: Diff.FILE_HEADERS_ONLY,
    }),
    firstChangedLine: diffResult.firstChangedLine,
  };
}

function truncateHeadLikePi(content: string): {
  content: string;
  outputLines: number;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  firstLineExceedsLimit: boolean;
} {
  const lines = splitLinesForCounting(content);
  const totalBytes = utf8ByteLength(content);
  if (lines.length <= PI_READ_MAX_LINES && totalBytes <= PI_READ_MAX_BYTES) {
    return {
      content,
      outputLines: lines.length,
      truncated: false,
      truncatedBy: null,
      firstLineExceedsLimit: false,
    };
  }
  if (utf8ByteLength(lines[0] || "") > PI_READ_MAX_BYTES) {
    return {
      content: "",
      outputLines: 0,
      truncated: true,
      truncatedBy: "bytes",
      firstLineExceedsLimit: true,
    };
  }
  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < PI_READ_MAX_LINES; index += 1) {
    const lineBytes = utf8ByteLength(lines[index]) + (index > 0 ? 1 : 0);
    if (outputBytes + lineBytes > PI_READ_MAX_BYTES) {
      truncatedBy = "bytes";
      break;
    }
    output.push(lines[index]);
    outputBytes += lineBytes;
  }
  if (output.length >= PI_READ_MAX_LINES && outputBytes <= PI_READ_MAX_BYTES) truncatedBy = "lines";
  return {
    content: output.join("\n"),
    outputLines: output.length,
    truncated: true,
    truncatedBy,
    firstLineExceedsLimit: false,
  };
}

function splitLinesForCounting(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function utf8ByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function formatPiSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function quoteUserSpaceShellPath(path: string): string {
  const absolute = `/${path.replace(/^\/+/, "")}`;
  return `'${absolute.replace(/'/g, `'\\''`)}'`;
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) return "\n";
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function findText(
  content: string,
  oldText: string,
): { found: boolean; index: number; matchLength: number; fuzzy: boolean } {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1)
    return { found: true, index: exactIndex, matchLength: oldText.length, fuzzy: false };
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = normalizedContent.indexOf(normalizedOldText);
  return fuzzyIndex === -1
    ? { found: false, index: -1, matchLength: 0, fuzzy: false }
    : { found: true, index: fuzzyIndex, matchLength: normalizedOldText.length, fuzzy: true };
}

function applyEditsToNormalizedContent(
  content: string,
  edits: PiTextEdit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));
  normalizedEdits.forEach((edit, index) => {
    if (!edit.oldText)
      throw new Error(
        edits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${index}].oldText must not be empty in ${path}.`,
      );
  });
  const fuzzy = normalizedEdits.some((edit) => findText(content, edit.oldText).fuzzy);
  const replacementBase = fuzzy ? normalizeForFuzzyMatch(content) : content;
  const replacements: TextReplacement[] = normalizedEdits
    .map((edit, index) => {
      const match = findText(replacementBase, edit.oldText);
      if (!match.found) {
        throw new Error(
          edits.length === 1
            ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
            : `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
        );
      }
      const occurrences = countOccurrences(replacementBase, edit.oldText);
      if (occurrences > 1) {
        throw new Error(
          edits.length === 1
            ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
            : `Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
        );
      }
      return {
        editIndex: index,
        matchIndex: match.index,
        matchLength: match.matchLength,
        newText: edit.newText,
      };
    })
    .sort((left, right) => left.matchIndex - right.matchIndex);

  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }
  const newContent = fuzzy
    ? applyReplacementsPreservingUnchangedLines(content, replacementBase, replacements)
    : applyReplacements(replacementBase, replacements);
  if (content === newContent) {
    throw new Error(
      edits.length === 1
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  }
  return { baseContent: content, newContent };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement,
): { startLine: number; endLine: number } {
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  const startLine = lines.findIndex(
    (line) => replacement.matchIndex >= line.start && replacement.matchIndex < line.end,
  );
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) endLine += 1;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacementsPreservingUnchangedLines(
  original: string,
  base: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(original);
  const baseLines = getLineSpans(base);
  if (originalLines.length !== baseLines.length)
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  for (const replacement of replacements) {
    const range = replacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
    } else {
      groups.push({ ...range, replacements: [replacement] });
    }
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const start = baseLines[group.startLine].start;
    const end = baseLines[group.endLine - 1].end;
    result += applyReplacements(base.slice(start, end), group.replacements, start);
    originalLineIndex = group.endLine;
  }
  return result + originalLines.slice(originalLineIndex).join("");
}

function generateDiffString(
  oldContent: string,
  newContent: string,
): { diff: string; firstChangedLine?: number } {
  const output: string[] = [];
  const maxLineNumber = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
  const lineNumberWidth = String(maxLineNumber).length;
  let oldLine = 1;
  let newLine = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  const parts = Diff.diffLines(oldContent, newContent);
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(lineNumberWidth, " ")} ${line}`);
          newLine += 1;
        } else {
          output.push(`-${String(oldLine).padStart(lineNumberWidth, " ")} ${line}`);
          oldLine += 1;
        }
      }
      lastWasChange = true;
      continue;
    }
    const nextIsChange =
      partIndex < parts.length - 1 && (parts[partIndex + 1].added || parts[partIndex + 1].removed);
    const leading = lastWasChange;
    const trailing = nextIsChange;
    let visibleStart = 0;
    let visibleEnd = lines.length;
    if (leading && !trailing) visibleEnd = Math.min(4, lines.length);
    if (!leading && trailing) visibleStart = Math.max(0, lines.length - 4);
    if (leading && trailing && lines.length > 8) {
      for (const line of lines.slice(0, 4)) {
        output.push(` ${String(oldLine).padStart(lineNumberWidth, " ")} ${line}`);
        oldLine += 1;
        newLine += 1;
      }
      output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
      const skipped = lines.length - 8;
      oldLine += skipped;
      newLine += skipped;
      visibleStart = lines.length - 4;
    } else if (!leading && !trailing) {
      oldLine += lines.length;
      newLine += lines.length;
      lastWasChange = false;
      continue;
    } else if (visibleStart > 0) {
      output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
      oldLine += visibleStart;
      newLine += visibleStart;
    }
    for (const line of lines.slice(visibleStart, visibleEnd)) {
      output.push(` ${String(oldLine).padStart(lineNumberWidth, " ")} ${line}`);
      oldLine += 1;
      newLine += 1;
    }
    const skippedTail = lines.length - visibleEnd;
    if (skippedTail > 0) {
      output.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
      oldLine += skippedTail;
      newLine += skippedTail;
    }
    lastWasChange = false;
  }
  return { diff: output.join("\n"), firstChangedLine };
}
