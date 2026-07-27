import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Terminal, type TerminalHandle } from "@wterm/react";
import "@wterm/react/css";
import { useStore } from "../../store.js";
import type { UserSpaceMount } from "../../types.js";
import { executeUserSpaceOperation } from "../../user-space.js";
import { uiCopy } from "../../ui-copy.js";
import { WtermImeKeyBuffer } from "./wterm-ime-key-buffer.js";

const workspaceCopy = uiCopy.userSpace;
const WTERM_SELECTING_CLASS = "piwork-wterm-selecting";

type WtermLayout = {
  cols: number;
  rows: number;
  rowHeight: number;
};

type WtermShellExecResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cwd?: string;
};

function wtermPrompt(cwd: string): string {
  return `\x1b[1;32muser@wterm\x1b[0m:\x1b[1;34m${cwd || "/"}\x1b[0m$ `;
}

function clearWtermTextareaAriaHidden(host: HTMLElement | null): void {
  if (!host) return;
  for (const textarea of host.querySelectorAll("textarea[aria-hidden='true']")) {
    textarea.removeAttribute("aria-hidden");
  }
}

function measureWtermLayout(host: HTMLElement): WtermLayout {
  const probeTerm = document.createElement("div");
  probeTerm.className = "wterm piwork-wterm-terminal";
  probeTerm.style.position = "absolute";
  probeTerm.style.visibility = "hidden";
  probeTerm.style.pointerEvents = "none";
  probeTerm.style.inset = "0 auto auto 0";
  const row = document.createElement("div");
  row.className = "term-row";
  const probe = document.createElement("span");
  probe.textContent = "W";
  row.appendChild(probe);
  probeTerm.appendChild(row);
  host.appendChild(probeTerm);
  const charWidth = probe.getBoundingClientRect().width;
  const rowHeight = Math.ceil(row.getBoundingClientRect().height);
  const style = getComputedStyle(probeTerm);
  const horizontalPadding =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const verticalPadding =
    (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  probeTerm.remove();
  if (charWidth <= 0 || rowHeight <= 0 || host.clientWidth <= 0 || host.clientHeight <= 0) {
    return { cols: 80, rows: 24, rowHeight: 17 };
  }
  return {
    cols: Math.max(1, Math.floor((host.clientWidth - horizontalPadding) / charWidth)),
    rows: Math.max(1, Math.floor((host.clientHeight - verticalPadding) / rowHeight)),
    rowHeight,
  };
}

function focusWterm(ref: RefObject<TerminalHandle | null>): void {
  ref.current?.focus();
}

function isNodeWithin(
  target: EventTarget | null,
  element: HTMLElement | null | undefined,
): boolean {
  return Boolean(element && target instanceof Node && element.contains(target));
}

function wtermChars(value: string): string[] {
  return Array.from(value);
}

function wtermSlice(value: string, start: number, end?: number): string {
  return wtermChars(value).slice(start, end).join("");
}

function wtermLength(value: string): number {
  return wtermChars(value).length;
}

function readWtermControlSequence(
  data: string,
  start: number,
): { sequence: string; nextIndex: number } | null {
  if (data[start] !== "\x1b") return null;
  const marker = data[start + 1];
  if (marker === "[") {
    let index = start + 2;
    while (index < data.length && /[0-9;?]/.test(data[index] || "")) index++;
    if (index < data.length)
      return { sequence: data.slice(start, index + 1), nextIndex: index + 1 };
  }
  if (marker === "O" && start + 2 < data.length) {
    return { sequence: data.slice(start, start + 3), nextIndex: start + 3 };
  }
  return { sequence: data[start], nextIndex: start + 1 };
}

function normalizeWtermOutput(text: string): string {
  return text
    .replace(/\x1b\[2J\x1b\[H/g, "\x1b[3J\x1b[2J\x1b[H")
    .replace(/\x1b\[H\x1b\[2J/g, "\x1b[3J\x1b[H\x1b[2J");
}

export const WtermPreview = memo(function WtermPreview({
  mount,
  visible,
}: {
  mount?: UserSpaceMount;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const clearSelectionGuardRef = useRef<(() => void) | null>(null);
  const cwdRef = useRef("/");
  const lineRef = useRef("");
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const busyRef = useRef(false);
  const initializedRef = useRef(false);
  const initialPromptWrittenRef = useRef(false);
  const initialPromptTimerRef = useRef<number | null>(null);
  const layoutRefreshTimersRef = useRef<number[]>([]);
  const [layout, setLayout] = useState<WtermLayout | null>(null);
  const [error, setError] = useState("");
  const showHiddenEntries = useStore((state) => state.preferences.userSpace.showHiddenEntries);

  const clearTextareaAriaHidden = useCallback(() => {
    clearWtermTextareaAriaHidden(hostRef.current);
  }, []);

  const clearSelectionGuard = useCallback(() => {
    clearSelectionGuardRef.current?.();
  }, []);

  const armSelectionGuard = useCallback(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (clearSelectionGuardRef.current) return;
    document.documentElement.classList.add(WTERM_SELECTING_CLASS);
    const clear = () => {
      window.removeEventListener("pointerup", clear, true);
      window.removeEventListener("pointercancel", clear, true);
      window.removeEventListener("mouseup", clear, true);
      window.removeEventListener("blur", clear, true);
      document.documentElement.classList.remove(WTERM_SELECTING_CLASS);
      clearSelectionGuardRef.current = null;
    };
    clearSelectionGuardRef.current = clear;
    window.addEventListener("pointerup", clear, true);
    window.addEventListener("pointercancel", clear, true);
    window.addEventListener("mouseup", clear, true);
    window.addEventListener("blur", clear, true);
  }, []);

  const handleTerminalSelectionStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>) => {
      const terminalElement = terminalRef.current?.instance?.element;
      if (isNodeWithin(event.target, terminalElement)) {
        armSelectionGuard();
        return;
      }
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      focusWterm(terminalRef);
    },
    [armSelectionGuard],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    clearWtermTextareaAriaHidden(host);
    const Observer = typeof MutationObserver === "undefined" ? null : MutationObserver;
    const observer = Observer ? new Observer(() => clearWtermTextareaAriaHidden(host)) : null;
    observer?.observe(host, {
      attributes: true,
      attributeFilter: ["aria-hidden"],
      childList: true,
      subtree: true,
    });
    host.addEventListener("focusin", clearTextareaAriaHidden);
    return () => {
      observer?.disconnect();
      host.removeEventListener("focusin", clearTextareaAriaHidden);
    };
  }, [clearTextareaAriaHidden]);

  const writePrompt = useCallback(() => {
    lineRef.current = "";
    cursorRef.current = 0;
    const text = wtermPrompt(cwdRef.current);
    terminalRef.current?.write(text);
  }, []);

  const writeTerminalText = useCallback((text: string) => {
    const normalized = normalizeWtermOutput(text).replace(/\n/g, "\r\n");
    terminalRef.current?.write(normalized);
  }, []);

  const redrawInputLine = useCallback((line: string, cursor = wtermLength(line)) => {
    const length = wtermLength(line);
    const nextCursor = Math.max(0, Math.min(cursor, length));
    lineRef.current = line;
    cursorRef.current = nextCursor;
    const tailLength = length - nextCursor;
    terminalRef.current?.write(
      `\r\x1b[2K${wtermPrompt(cwdRef.current)}${line}${tailLength > 0 ? `\x1b[${tailLength}D` : ""}`,
    );
  }, []);

  const moveInputCursor = useCallback((nextCursor: number) => {
    const length = wtermLength(lineRef.current);
    const clamped = Math.max(0, Math.min(nextCursor, length));
    const delta = clamped - cursorRef.current;
    if (delta === 0) return;
    cursorRef.current = clamped;
    terminalRef.current?.write(delta > 0 ? `\x1b[${delta}C` : `\x1b[${-delta}D`);
  }, []);

  const resetHistoryNavigation = useCallback(() => {
    historyIndexRef.current = null;
    historyDraftRef.current = "";
  }, []);

  const commitHistory = useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        const history = historyRef.current;
        if (history[history.length - 1] !== line) history.push(line);
        if (history.length > 200) history.splice(0, history.length - 200);
      }
      resetHistoryNavigation();
    },
    [resetHistoryNavigation],
  );

  const recallHistory = useCallback(
    (direction: "previous" | "next") => {
      const history = historyRef.current;
      if (history.length === 0) return;
      let index = historyIndexRef.current;
      if (direction === "previous") {
        if (index === null) {
          historyDraftRef.current = lineRef.current;
          index = history.length - 1;
        } else {
          index = Math.max(0, index - 1);
        }
        historyIndexRef.current = index;
        redrawInputLine(history[index] || "");
        return;
      }

      if (index === null) return;
      if (index >= history.length - 1) {
        historyIndexRef.current = null;
        redrawInputLine(historyDraftRef.current);
        historyDraftRef.current = "";
        return;
      }
      index += 1;
      historyIndexRef.current = index;
      redrawInputLine(history[index] || "");
    },
    [redrawInputLine],
  );

  const insertInputText = useCallback(
    (text: string) => {
      if (!text) return;
      resetHistoryNavigation();
      const current = wtermChars(lineRef.current);
      const insert = wtermChars(text);
      const cursor = cursorRef.current;
      const atEnd = cursor === current.length;
      current.splice(cursor, 0, ...insert);
      const next = current.join("");
      const nextCursor = cursor + insert.length;
      if (atEnd) {
        lineRef.current = next;
        cursorRef.current = nextCursor;
        terminalRef.current?.write(text);
        return;
      }
      redrawInputLine(next, nextCursor);
    },
    [redrawInputLine, resetHistoryNavigation],
  );

  const deleteInputBeforeCursor = useCallback(() => {
    const current = wtermChars(lineRef.current);
    const cursor = cursorRef.current;
    if (cursor <= 0) return;
    resetHistoryNavigation();
    const atEnd = cursor === current.length;
    current.splice(cursor - 1, 1);
    const next = current.join("");
    const nextCursor = cursor - 1;
    if (atEnd) {
      lineRef.current = next;
      cursorRef.current = nextCursor;
      terminalRef.current?.write("\b \b");
      return;
    }
    redrawInputLine(next, nextCursor);
  }, [redrawInputLine, resetHistoryNavigation]);

  const deleteInputAtCursor = useCallback(() => {
    const current = wtermChars(lineRef.current);
    const cursor = cursorRef.current;
    if (cursor >= current.length) return;
    resetHistoryNavigation();
    current.splice(cursor, 1);
    redrawInputLine(current.join(""), cursor);
  }, [redrawInputLine, resetHistoryNavigation]);

  const clearInputLine = useCallback(() => {
    resetHistoryNavigation();
    redrawInputLine("", 0);
  }, [redrawInputLine, resetHistoryNavigation]);

  const handleControlSequence = useCallback(
    (sequence: string) => {
      switch (sequence) {
        case "\x1b[A":
          recallHistory("previous");
          return;
        case "\x1b[B":
          recallHistory("next");
          return;
        case "\x1b[D":
          moveInputCursor(cursorRef.current - 1);
          return;
        case "\x1b[C":
          moveInputCursor(cursorRef.current + 1);
          return;
        case "\x1b[H":
        case "\x1bOH":
          moveInputCursor(0);
          return;
        case "\x1b[F":
        case "\x1bOF":
          moveInputCursor(wtermLength(lineRef.current));
          return;
        case "\x1b[3~":
          deleteInputAtCursor();
          return;
        default:
          return;
      }
    },
    [deleteInputAtCursor, moveInputCursor, recallHistory],
  );

  const clearLayoutRefreshTimers = useCallback(() => {
    for (const timer of layoutRefreshTimersRef.current) window.clearTimeout(timer);
    layoutRefreshTimersRef.current = [];
  }, []);

  const scheduleLayoutRefresh = useCallback(() => {
    if (!visible || typeof window === "undefined") return;
    clearLayoutRefreshTimers();
    for (const delay of [0, 32, 120]) {
      const timer = window.setTimeout(() => {
        layoutRefreshTimersRef.current = layoutRefreshTimersRef.current.filter(
          (item) => item !== timer,
        );
        if (!visible) return;
        clearWtermTextareaAriaHidden(hostRef.current);
        focusWterm(terminalRef);
      }, delay);
      layoutRefreshTimersRef.current.push(timer);
    }
  }, [clearLayoutRefreshTimers, visible]);

  useEffect(() => {
    if (visible) scheduleLayoutRefresh();
    else clearLayoutRefreshTimers();
    return clearLayoutRefreshTimers;
  }, [clearLayoutRefreshTimers, scheduleLayoutRefresh, visible]);

  useEffect(() => clearSelectionGuard, [clearSelectionGuard]);

  useEffect(() => {
    if (!visible || typeof window === "undefined") return undefined;
    const host = terminalHostRef.current;
    if (!host) return undefined;

    let frame: number | null = null;
    const updateLayout = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const nextHost = terminalHostRef.current;
        if (!nextHost) return;
        const next = measureWtermLayout(nextHost);
        setLayout((previous) => {
          if (
            previous &&
            previous.cols === next.cols &&
            previous.rows === next.rows &&
            previous.rowHeight === next.rowHeight
          ) {
            return previous;
          }
          return next;
        });
      });
    };

    updateLayout();
    const Observer = typeof ResizeObserver === "undefined" ? null : ResizeObserver;
    const observer = Observer ? new Observer(updateLayout) : null;
    observer?.observe(host);
    const timer = window.setTimeout(updateLayout, 32);

    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [visible]);

  const scheduleInitialPrompt = useCallback(() => {
    if (initialPromptWrittenRef.current || initialPromptTimerRef.current !== null) return;
    let attempts = 0;
    const tryWrite = () => {
      initialPromptTimerRef.current = null;
      if (initialPromptWrittenRef.current) return;
      if (terminalRef.current) {
        initialPromptWrittenRef.current = true;
        writePrompt();
        terminalRef.current.focus();
        return;
      }
      attempts += 1;
      if (attempts < 6 && typeof window !== "undefined") {
        initialPromptTimerRef.current = window.setTimeout(tryWrite, 16);
      }
    };
    if (typeof window === "undefined") {
      tryWrite();
      return;
    }
    initialPromptTimerRef.current = window.setTimeout(tryWrite, 16);
  }, [writePrompt]);

  useEffect(() => {
    return () => {
      if (initialPromptTimerRef.current !== null) {
        window.clearTimeout(initialPromptTimerRef.current);
        initialPromptTimerRef.current = null;
      }
      clearLayoutRefreshTimers();
    };
  }, [clearLayoutRefreshTimers]);

  const executeLine = useCallback(
    async (line: string) => {
      if (!mount?.mountId || busyRef.current) return;
      const script = line;
      if (!script.trim()) {
        writePrompt();
        return;
      }
      busyRef.current = true;
      setError("");
      try {
        const result = (await executeUserSpaceOperation("shell_exec", {
          mountId: mount.mountId,
          script,
          cwd: cwdRef.current,
          showHiddenEntries,
          searchHiddenEntries: true,
        })) as WtermShellExecResult;
        if (result.stdout) writeTerminalText(result.stdout);
        if (result.stderr) writeTerminalText(`\x1b[31m${result.stderr}\x1b[0m`);
        cwdRef.current = typeof result.cwd === "string" ? result.cwd : cwdRef.current;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        writeTerminalText(`\x1b[31m${message}\x1b[0m\n`);
      } finally {
        busyRef.current = false;
        writePrompt();
      }
    },
    [mount?.mountId, showHiddenEntries, writePrompt, writeTerminalText],
  );

  const handleReady = useCallback(() => {
    clearTextareaAriaHidden();
    if (initializedRef.current) {
      terminalRef.current?.focus();
      scheduleLayoutRefresh();
      return;
    }
    initializedRef.current = true;
    initialPromptWrittenRef.current = false;
    cwdRef.current = "/";
    lineRef.current = "";
    cursorRef.current = 0;
    historyIndexRef.current = null;
    historyDraftRef.current = "";
    if (!mount?.mountId) {
      const message = workspaceCopy.wterm.requiresMountedWorkspace;
      setError(message);
      writeTerminalText(`${message}\n`);
    }
    scheduleInitialPrompt();
    scheduleLayoutRefresh();
  }, [
    clearTextareaAriaHidden,
    mount?.mountId,
    scheduleInitialPrompt,
    scheduleLayoutRefresh,
    writeTerminalText,
  ]);

  const handleData = useCallback(
    (data: string) => {
      let skipLineFeed = false;
      let index = 0;
      while (index < data.length) {
        if (busyRef.current) break;
        const sequence = readWtermControlSequence(data, index);
        if (sequence) {
          handleControlSequence(sequence.sequence);
          index = sequence.nextIndex;
          continue;
        }
        const char = wtermChars(data.slice(index))[0] || "";
        index += char.length;
        if (char === "\r" || char === "\n") {
          if (char === "\n" && skipLineFeed) {
            skipLineFeed = false;
            continue;
          }
          skipLineFeed = char === "\r";
          const line = lineRef.current;
          commitHistory(line);
          lineRef.current = "";
          cursorRef.current = 0;
          terminalRef.current?.write("\r\n");
          void executeLine(line);
          continue;
        }
        skipLineFeed = false;
        if (char === "\x7f" || char === "\b") {
          deleteInputBeforeCursor();
          continue;
        }
        if (char === "\x03") {
          lineRef.current = "";
          cursorRef.current = 0;
          resetHistoryNavigation();
          terminalRef.current?.write("^C\r\n");
          writePrompt();
          continue;
        }
        if (char === "\x0c") {
          terminalRef.current?.write("\x1b[3J\x1b[2J\x1b[H");
          redrawInputLine(lineRef.current, cursorRef.current);
          continue;
        }
        if (char === "\x01") {
          moveInputCursor(0);
          continue;
        }
        if (char === "\x05") {
          moveInputCursor(wtermLength(lineRef.current));
          continue;
        }
        if (char === "\x15") {
          clearInputLine();
          continue;
        }
        if (char === "\x0b") {
          const next = wtermSlice(lineRef.current, 0, cursorRef.current);
          resetHistoryNavigation();
          redrawInputLine(next, cursorRef.current);
          continue;
        }
        if (char === "\t" || char < " ") continue;
        insertInputText(char);
      }
    },
    [
      clearInputLine,
      commitHistory,
      deleteInputBeforeCursor,
      executeLine,
      handleControlSequence,
      insertInputText,
      moveInputCursor,
      redrawInputLine,
      resetHistoryNavigation,
      writePrompt,
    ],
  );

  const handleDataRef = useRef(handleData);
  handleDataRef.current = handleData;
  const imeKeyBufferRef = useRef<WtermImeKeyBuffer | null>(null);
  if (!imeKeyBufferRef.current) {
    imeKeyBufferRef.current = new WtermImeKeyBuffer((data) => handleDataRef.current(data));
  }

  useEffect(() => {
    const buffer = imeKeyBufferRef.current;
    return () => buffer?.dispose();
  }, []);

  const handleTerminalKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!imeKeyBufferRef.current?.deferIfPrintable(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleTerminalCompositionStartCapture = useCallback(
    (_event: ReactCompositionEvent<HTMLDivElement>) => {
      imeKeyBufferRef.current?.compositionStarted();
    },
    [],
  );

  return (
    <div
      ref={hostRef}
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="user-space-wterm-preview"
      onFocusCapture={clearTextareaAriaHidden}
    >
      {error && (
        <div
          className="shrink-0 border-b border-danger/25 bg-danger-muted px-3 py-2 text-xs font-medium text-danger"
          role="alert"
        >
          {error}
        </div>
      )}
      <div
        ref={terminalHostRef}
        className="piwork-wterm-selection-shell flex min-h-0 flex-1 flex-col justify-start overflow-hidden"
        onMouseDownCapture={handleTerminalSelectionStart}
        onPointerDownCapture={handleTerminalSelectionStart}
        onKeyDownCapture={handleTerminalKeyDownCapture}
        onCompositionStartCapture={handleTerminalCompositionStartCapture}
      >
        {layout && (
          <Terminal
            ref={terminalRef}
            cols={layout.cols}
            rows={layout.rows}
            onReady={handleReady}
            onData={handleData}
            onError={(err) => setError(err instanceof Error ? err.message : String(err))}
            className="piwork-wterm-terminal min-h-0 w-full shrink-0"
            data-testid="user-space-wterm-terminal"
          />
        )}
      </div>
    </div>
  );
});
