import { useMemo } from "react";
import * as Diff from "diff";
import { uiCopy } from "../ui-copy.js";

export interface DiffViewerProps {
  /** Original text (for computing diff from old/new) */
  oldText?: string;
  /** New text (for computing diff from old/new) */
  newText?: string;
  /** Pre-computed unified diff string for a text change. */
  unifiedDiff?: string;
  /** File name/path for the header */
  fileName?: string;
  /** compact = inline in chat, full = panel (scrollable, line numbers by default) */
  mode?: "compact" | "full";
  /** Explicitly override line number visibility while keeping the selected layout density. */
  showLineNumbers?: boolean;
}

interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

function parsePatchToHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = Diff.structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  return patch.hunks.map((hunk) => {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    const lines: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const raw of hunk.lines) {
      if (isNoNewlineMarker(raw)) {
        continue;
      }
      const prefix = raw[0];
      const content = raw.slice(1);
      if (prefix === "-") {
        lines.push({ type: "del", content, oldLineNo: oldLine++ });
      } else if (prefix === "+") {
        lines.push({ type: "add", content, newLineNo: newLine++ });
      } else {
        lines.push({ type: "context", content, oldLineNo: oldLine++, newLineNo: newLine++ });
      }
    }

    return { header, lines };
  });
}

function parseUnifiedDiffToHunks(diffStr: string): { fileName: string; hunks: DiffHunk[] }[] {
  const files: { fileName: string; hunks: DiffHunk[] }[] = [];
  const diffLines = diffStr.split("\n");
  let currentFile: { fileName: string; hunks: DiffHunk[] } | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffLines) {
    if (line.startsWith("diff --git") || line.startsWith("diff --cc")) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      if (currentFile) files.push(currentFile);
      currentFile = { fileName: "", hunks: [] };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- a/") || line.startsWith("--- /dev/null")) {
      continue;
    }
    if (line.startsWith("+++ b/")) {
      if (currentFile) currentFile.fileName = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("similarity index") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (hunkMatch) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldLineNo: oldLine++,
        newLineNo: newLine++,
      });
    } else if (isNoNewlineMarker(line)) {
      // skip
    }
  }

  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
  if (currentFile) files.push(currentFile);

  return files;
}

function LineContent({ line }: { line: DiffLine }) {
  return <>{line.content}</>;
}

function isNoNewlineMarker(line: string): boolean {
  return line.trim() === "\\ No newline at end of file";
}

function getDisplayLineNumber(line: DiffLine): number | undefined {
  if (line.type === "del") return line.oldLineNo;
  return line.newLineNo ?? line.oldLineNo;
}

function getHunkSummary(hunk: DiffHunk): { added: number; removed: number } {
  return {
    added: hunk.lines.filter((line) => line.type === "add").length,
    removed: hunk.lines.filter((line) => line.type === "del").length,
  };
}

function HunkBlock({ hunk, showLineNumbers }: { hunk: DiffHunk; showLineNumbers: boolean }) {
  const summary = getHunkSummary(hunk);

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        <span
          className={
            showLineNumbers
              ? "diff-hunk-summary diff-hunk-summary-with-gutter"
              : "diff-hunk-summary"
          }
        >
          <span className="diff-hunk-added">+{summary.added}</span>
          <span className="diff-hunk-removed">-{summary.removed}</span>
        </span>
      </div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={`diff-line diff-line-${line.type}`}>
          {showLineNumbers && (
            <span className="diff-gutter">{getDisplayLineNumber(line) ?? ""}</span>
          )}
          <span className="diff-marker">
            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
          </span>
          <span className="diff-content">
            <LineContent line={line} />
            {!line.content && "\u00A0"}
          </span>
        </div>
      ))}
    </div>
  );
}

function FileHeader({ fileName }: { fileName: string }) {
  const parts = fileName.split("/");
  const base = parts.pop() || fileName;
  const dir = parts.join("/");
  return (
    <div className="diff-file-header">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-3.5 h-3.5 text-primary shrink-0"
      >
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
      {dir && <span className="text-muted-foreground">{dir}/</span>}
      <span className="font-semibold text-foreground">{base}</span>
    </div>
  );
}

export function DiffViewer({
  oldText,
  newText,
  unifiedDiff,
  fileName,
  mode = "compact",
  showLineNumbers,
}: DiffViewerProps) {
  const isCompact = mode === "compact";
  const shouldShowLineNumbers = showLineNumbers ?? !isCompact;

  const data = useMemo(() => {
    // Case 1: a pre-computed unified diff string was provided.
    if (unifiedDiff) {
      return parseUnifiedDiffToHunks(unifiedDiff);
    }

    // Case 2: compute diff from old/new text
    const old = oldText ?? "";
    const neu = newText ?? "";
    if (!old && !neu) return [];

    const hunks = parsePatchToHunks(old, neu);
    return [{ fileName: fileName || "", hunks }];
  }, [oldText, newText, unifiedDiff, fileName]);

  // Nothing to show
  if (data.length === 0 || data.every((f) => f.hunks.length === 0)) {
    return (
      <div className="diff-viewer diff-empty">
        <span className="text-muted-foreground text-xs">{uiCopy.diff.noChanges}</span>
      </div>
    );
  }

  return (
    <div className={`diff-viewer ${isCompact ? "diff-compact" : "diff-full"}`}>
      {data.map((file, fi) => (
        <div key={fi} className="diff-file">
          {(file.fileName || fileName) && <FileHeader fileName={file.fileName || fileName || ""} />}
          {file.hunks.map((hunk, hi) => (
            <HunkBlock key={hi} hunk={hunk} showLineNumbers={shouldShowLineNumbers} />
          ))}
        </div>
      ))}
    </div>
  );
}
