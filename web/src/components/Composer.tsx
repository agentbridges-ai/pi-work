import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "./ui/heroui.js";
import { useStore } from "../store.js";
import { createClientMessageId, sendToSession } from "../ws.js";
import { readFileAsBase64, type ImageAttachment } from "../utils/image.js";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { CodexArrowIcon, CodexPlusIcon } from "./CodexIcons.js";
import type { PiSessionInfo, SessionState } from "../types.js";
import { normalizeAgentMode } from "../utils/backends.js";
import {
  type UserSpaceFileReference,
  clearUserSpaceFileRefs,
  formatUserSpaceFileRefsForPrompt,
  formatUserSpaceVisibleContent,
  getUserSpaceFileRefs,
  removeUserSpaceFileRef,
  requestUserSpaceFilePreview,
  subscribeUserSpaceFileRefs,
} from "../user-space-file-refs.js";
import { uiCopy } from "../ui-copy.js";

const emptyStringArray: string[] = [];
const FILE_REF_MARKER = "\uFFFC";
const FILE_REF_TOKEN_ATTR = "data-composer-file-ref-token";
const FILE_REF_KEY_ATTR = "data-composer-file-ref-key";

function normalizeEditorText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

function splitEditorLines(text: string): string[] {
  return normalizeEditorText(text).split("\n");
}

function fileRefKey(ref: Pick<UserSpaceFileReference, "path">): string {
  return ref.path;
}

function isFileRefTokenElement(node: Node): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).getAttribute(FILE_REF_TOKEN_ATTR) === "true"
  );
}

function getNodeModelLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return normalizeEditorText(node.textContent ?? "").length;
  if (isFileRefTokenElement(node)) return 1;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  return Array.from(node.childNodes).reduce((sum, child) => sum + getNodeModelLength(child), 0);
}

function getNodeModelText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeEditorText(node.textContent ?? "");
  if (isFileRefTokenElement(node)) return FILE_REF_MARKER;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  return Array.from(node.childNodes).map(getNodeModelText).join("");
}

function createEditorParagraph(
  documentRef: Document,
  line: string,
  createFileToken: () => HTMLElement | null,
): HTMLParagraphElement {
  const paragraph = documentRef.createElement("p");
  if (line.length === 0) {
    paragraph.appendChild(documentRef.createElement("br"));
  } else {
    let textBuffer = "";
    for (const char of line) {
      if (char !== FILE_REF_MARKER) {
        textBuffer += char;
        continue;
      }
      if (textBuffer) {
        paragraph.appendChild(documentRef.createTextNode(textBuffer));
        textBuffer = "";
      }
      const token = createFileToken();
      if (token) paragraph.appendChild(token);
    }
    if (textBuffer) paragraph.appendChild(documentRef.createTextNode(textBuffer));
  }
  return paragraph;
}

function getEditorParagraphs(editor: HTMLDivElement): HTMLParagraphElement[] {
  return Array.from(editor.children).filter(
    (child): child is HTMLParagraphElement => child.tagName === "P",
  );
}

function hasEditorParagraphModel(editor: HTMLDivElement): boolean {
  return (
    editor.childNodes.length > 0 &&
    Array.from(editor.childNodes).every(
      (node) => node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "P",
    )
  );
}

function getEditorText(editor: HTMLDivElement): string {
  const paragraphs = getEditorParagraphs(editor);
  if (paragraphs.length > 0) {
    return paragraphs.map((paragraph) => getNodeModelText(paragraph)).join("\n");
  }
  return Array.from(editor.childNodes).map(getNodeModelText).join("");
}

function getEditorFileRefKeys(editor: HTMLDivElement): string[] {
  return Array.from(editor.querySelectorAll<HTMLElement>(`[${FILE_REF_TOKEN_ATTR}="true"]`))
    .map((element) => element.getAttribute(FILE_REF_KEY_ATTR))
    .filter((key): key is string => Boolean(key));
}

function findContainingFileRefToken(node: Node): HTMLElement | null {
  if (isFileRefTokenElement(node)) return node;
  if (node.nodeType !== Node.ELEMENT_NODE && !node.parentElement) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(`[${FILE_REF_TOKEN_ATTR}="true"]`) ?? null;
}

function getEditorOffsetForDomPosition(
  editor: HTMLDivElement,
  container: Node,
  offset: number,
): number {
  const containingToken = findContainingFileRefToken(container);
  if (containingToken && containingToken.parentNode) {
    const parent = containingToken.parentNode;
    const childIndex = Array.from(parent.childNodes).indexOf(containingToken);
    return getEditorOffsetForDomPosition(editor, parent, childIndex + 1);
  }

  let found = false;
  let total = 0;

  function walk(node: Node): void {
    if (found) return;
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += normalizeEditorText(node.textContent ?? "").slice(0, offset).length;
      } else {
        const children = Array.from(node.childNodes);
        for (const [index, child] of children.slice(0, offset).entries()) {
          if (
            node === editor &&
            index > 0 &&
            children[index - 1]?.nodeName === "P" &&
            child.nodeName === "P"
          ) {
            total += 1;
          }
          total += getNodeModelLength(child);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE || isFileRefTokenElement(node)) {
      total += getNodeModelLength(node);
      return;
    }
    const children = Array.from(node.childNodes);
    for (const [index, child] of children.entries()) {
      if (
        node === editor &&
        index > 0 &&
        children[index - 1]?.nodeName === "P" &&
        child.nodeName === "P"
      ) {
        total += 1;
      }
      walk(child);
      if (found) return;
    }
  }

  walk(editor);
  return found ? total : getEditorText(editor).length;
}

function getEditorCaretOffset(editor: HTMLDivElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return getEditorText(editor).length;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return getEditorText(editor).length;
  return getEditorOffsetForDomPosition(editor, range.startContainer, range.startOffset);
}

function setRangeBeforeChild(selection: Selection, child: Node) {
  const range = document.createRange();
  range.setStartBefore(child);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setRangeAfterChild(selection: Selection, child: Node) {
  const range = document.createRange();
  range.setStartAfter(child);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setEditorCaretOffset(editor: HTMLDivElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const paragraphs = getEditorParagraphs(editor);
  let remaining = Math.max(0, offset);

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const children = Array.from(paragraph.childNodes).filter((child) => child.nodeName !== "BR");

    // The filler <br> is not part of the editor model. Chrome's IME loses its
    // composition range when the caret is placed after that node (DOM offset
    // 1), so anchor empty paragraphs before it instead (DOM offset 0).
    if (children.length === 0) {
      const range = document.createRange();
      range.setStart(paragraph, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    for (const child of children) {
      const length = getNodeModelLength(child);
      if (remaining === 0) {
        setRangeBeforeChild(selection, child);
        return;
      }
      if (child.nodeType === Node.TEXT_NODE && remaining <= length) {
        const range = document.createRange();
        range.setStart(child, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      if (isFileRefTokenElement(child) && remaining <= length) {
        setRangeAfterChild(selection, child);
        return;
      }
      remaining -= length;
    }

    if (remaining === 0 || paragraphIndex === paragraphs.length - 1) {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }

    if (remaining <= 1) {
      const nextParagraph = paragraphs[paragraphIndex + 1];
      const range = document.createRange();
      range.selectNodeContents(nextParagraph);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= 1;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function getEditorSelectionOffsets(editor: HTMLDivElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    const length = getEditorText(editor).length;
    return { start: length, end: length };
  }
  const range = selection.getRangeAt(0);
  const start = getEditorOffsetForDomPosition(editor, range.startContainer, range.startOffset);
  const end = getEditorOffsetForDomPosition(editor, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

function insertPlainTextAtCaret(
  editor: HTMLDivElement,
  insertion: string,
): { nextText: string; nextCursor: number } {
  const currentText = getEditorText(editor);
  const { start, end } = getEditorSelectionOffsets(editor);
  const normalizedInsertion = normalizeEditorText(insertion);
  const nextText = `${currentText.slice(0, start)}${normalizedInsertion}${currentText.slice(end)}`;
  const nextCursor = start + normalizedInsertion.length;
  return { nextText, nextCursor };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function countFileRefMarkers(text: string): number {
  return Array.from(text).filter((char) => char === FILE_REF_MARKER).length;
}

function markerOrdinalBeforeOffset(text: string, offset: number): number {
  return countFileRefMarkers(text.slice(0, Math.max(0, offset)));
}

function markerIndexForOrdinal(text: string, ordinal: number): number {
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== FILE_REF_MARKER) continue;
    if (seen === ordinal) return index;
    seen += 1;
  }
  return -1;
}

function removeRangeFromEditorModel(
  text: string,
  keys: string[],
  start: number,
  end: number,
): { nextText: string; nextKeys: string[]; removedKeys: string[] } {
  const removedKeys: string[] = [];
  let markerOrdinal = 0;
  let nextText = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const inRange = index >= start && index < end;
    if (char === FILE_REF_MARKER) {
      const key = keys[markerOrdinal];
      if (inRange && key) removedKeys.push(key);
      markerOrdinal += 1;
    }
    if (!inRange) nextText += char;
  }

  const removedKeySet = new Set(removedKeys);
  return {
    nextText,
    nextKeys: keys.filter((key) => !removedKeySet.has(key)),
    removedKeys,
  };
}

function plainTextFromEditorModel(text: string): string {
  return text.replaceAll(FILE_REF_MARKER, "");
}

function visibleContentFromEditorModel(
  text: string,
  refs: UserSpaceFileReference[],
  keys: string[],
): string {
  if (!text.includes(FILE_REF_MARKER)) {
    return formatUserSpaceVisibleContent(text, refs);
  }

  const refsByKey = new Map(refs.map((ref) => [fileRefKey(ref), ref]));
  let markerOrdinal = 0;
  let visible = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== FILE_REF_MARKER) {
      visible += char;
      continue;
    }

    const key = keys[markerOrdinal];
    markerOrdinal += 1;
    const ref = key ? refsByKey.get(key) : undefined;
    if (!ref) continue;

    const token = `[user-space:/${ref.path.replace(/^\/+/, "")}]`;
    if (visible && !/\s$/.test(visible)) visible += " ";
    visible += token;
    if (index < text.length - 1 && !/[\s\n]/.test(text[index + 1] || "")) visible += " ";
  }

  return visible.trim();
}

export interface ComposerDraftRequest {
  id: number;
  text: string;
}

export function Composer({
  sessionId,
  draftRequest = null,
}: {
  sessionId: string;
  draftRequest?: ComposerDraftRequest | null;
}) {
  const [text, setText] = useState("");
  const [inlineRefKeys, setInlineRefKeys] = useState<string[]>([]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const compositionFrameRef = useRef<number | null>(null);
  const fileDragDepthRef = useRef(0);
  const textRef = useRef("");
  const inlineRefKeysRef = useRef<string[]>([]);
  const previousFileRefKeysRef = useRef<string[]>([]);
  const lastEditorSelectionOffsetRef = useRef(0);
  const appliedDraftRequestIdRef = useRef<number | null>(null);
  const sessionData = useStore((s) => s.sessions.get(sessionId));
  const runtimeSessions = useStore((s) => s.runtimeSessions);
  const browserConnectionStatus = useStore((s) => s.connectionStatus?.get(sessionId));
  const runActive = useStore((s) => Boolean(s.runActive.get(sessionId)));
  const promptSuggestionsRaw = useStore((s) => s.promptSuggestions.get(sessionId));
  const clearPromptSuggestions = useStore((s) => s.clearPromptSuggestions);

  const isConnected = browserConnectionStatus !== "disconnected";
  const showStopButton = runActive;
  const fileRefs = useSyncExternalStore(
    subscribeUserSpaceFileRefs,
    () => getUserSpaceFileRefs(sessionId),
    () => getUserSpaceFileRefs(sessionId),
  );
  const canSend =
    (plainTextFromEditorModel(text).trim().length > 0 ||
      fileRefs.length > 0 ||
      images.length > 0) &&
    isConnected &&
    !showStopButton;
  const runtimeSession = runtimeSessions.find((session) => session.sessionId === sessionId);
  const agentMode = normalizeAgentMode(sessionData?.mode || runtimeSession?.mode);
  const planModeActive = agentMode === "plan";
  const promptSuggestions = promptSuggestionsRaw ?? emptyStringArray;

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    inlineRefKeysRef.current = inlineRefKeys;
  }, [inlineRefKeys]);

  useEffect(
    () => () => {
      if (compositionFrameRef.current !== null) {
        cancelAnimationFrame(compositionFrameRef.current);
      }
    },
    [],
  );

  const commitEditorModel = useCallback(
    (nextText: string, nextKeys: string[], nextCursor: number | null = null) => {
      textRef.current = nextText;
      inlineRefKeysRef.current = nextKeys;
      setText(nextText);
      setInlineRefKeys(nextKeys);

      const editor = editorRef.current;
      if (!editor) return;
      renderEditorModel(editor, nextText, fileRefs, nextKeys, (ref) =>
        requestUserSpaceFilePreview(sessionId, ref),
      );
      if (nextCursor !== null) {
        const clampedCursor = Math.max(0, Math.min(nextCursor, nextText.length));
        setEditorCaretOffset(editor, clampedCursor);
        lastEditorSelectionOffsetRef.current = clampedCursor;
      }
    },
    [fileRefs, sessionId],
  );

  useEffect(() => {
    if (!draftRequest || appliedDraftRequestIdRef.current === draftRequest.id) return;
    appliedDraftRequestIdRef.current = draftRequest.id;
    const requestedText = draftRequest.text.trim();
    if (requestedText) {
      const currentText = textRef.current;
      const nextText =
        currentText.trim().length > 0 ? `${currentText}\n${requestedText}` : requestedText;
      commitEditorModel(nextText, inlineRefKeysRef.current, nextText.length);
    }
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [commitEditorModel, draftRequest]);

  function rememberEditorSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    lastEditorSelectionOffsetRef.current = getEditorCaretOffset(editor);
  }

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;
    const currentText = getEditorText(editor);
    const currentKeys = getEditorFileRefKeys(editor);
    if (
      currentText !== text ||
      !hasEditorParagraphModel(editor) ||
      !arraysEqual(currentKeys, inlineRefKeys)
    ) {
      const cursor = Math.min(getEditorCaretOffset(editor), text.length);
      renderEditorModel(editor, text, fileRefs, inlineRefKeys, (ref) =>
        requestUserSpaceFilePreview(sessionId, ref),
      );
      setEditorCaretOffset(editor, cursor);
      lastEditorSelectionOffsetRef.current = cursor;
    }
  }, [commitEditorModel, fileRefs, inlineRefKeys, sessionId, text]);

  useEffect(() => {
    const currentRefKeys = fileRefs.map(fileRefKey);
    const previousRefKeys = previousFileRefKeysRef.current;
    let nextText = textRef.current;
    let nextKeys = inlineRefKeysRef.current.slice();
    let nextCursor: number | null = null;
    let changed = false;

    for (const removedKey of previousRefKeys) {
      if (currentRefKeys.includes(removedKey)) continue;
      const markerOrdinal = nextKeys.indexOf(removedKey);
      if (markerOrdinal >= 0) {
        const markerIndex = markerIndexForOrdinal(nextText, markerOrdinal);
        if (markerIndex >= 0) {
          nextText = `${nextText.slice(0, markerIndex)}${nextText.slice(markerIndex + 1)}`;
          nextCursor = Math.min(lastEditorSelectionOffsetRef.current, nextText.length);
        }
        nextKeys.splice(markerOrdinal, 1);
        changed = true;
      }
    }

    for (const addedKey of currentRefKeys) {
      if (previousRefKeys.includes(addedKey)) continue;
      const insertOffset = Math.max(
        0,
        Math.min(lastEditorSelectionOffsetRef.current, nextText.length),
      );
      const markerOrdinal = markerOrdinalBeforeOffset(nextText, insertOffset);
      nextText = `${nextText.slice(0, insertOffset)}${FILE_REF_MARKER}${nextText.slice(insertOffset)}`;
      nextKeys.splice(markerOrdinal, 0, addedKey);
      lastEditorSelectionOffsetRef.current = insertOffset + 1;
      nextCursor = insertOffset + 1;
      changed = true;
    }

    previousFileRefKeysRef.current = currentRefKeys;
    if (changed) commitEditorModel(nextText, nextKeys, nextCursor);
  }, [commitEditorModel, fileRefs]);

  function appendLocalUserMessage(
    content: string,
    attachedImages: ImageAttachment[] = [],
    visibleContent = content,
  ): boolean {
    const clientMsgId = createClientMessageId();
    const imageParts =
      attachedImages.length > 0
        ? attachedImages.map((img) => ({
            type: "image" as const,
            mediaType: img.mediaType,
            data: img.base64,
          }))
        : [];
    const timestamp = Date.now();
    const generation = sessionData?.generation ?? runtimeSession?.generation ?? 0;
    const sent = sendToSession(sessionId, {
      type: "agent_message",
      generation,
      message: {
        id: clientMsgId,
        role: "user",
        content: [{ type: "text", text: content }, ...imageParts],
        displayContent:
          visibleContent === content
            ? undefined
            : [{ type: "text", text: visibleContent }, ...imageParts],
        timestamp,
      },
      clientMsgId,
    });
    if (!sent) return false;

    const store = useStore.getState();
    store.appendMessageAndSetSessionStatus(
      sessionId,
      {
        id: clientMsgId,
        role: "user" as const,
        content: visibleContent,
        contentParts: [{ type: "text", text: visibleContent }, ...imageParts],
        images: attachedImages.map((img) => ({ mediaType: img.mediaType, data: img.base64 })),
        timestamp,
      },
      "running",
    );
    store.setRunActive(sessionId, true);
    return true;
  }

  function handleSend() {
    const msg = plainTextFromEditorModel(text).trim();
    if ((!msg && fileRefs.length === 0 && images.length === 0) || !isConnected || showStopButton) {
      return;
    }

    const refsPrompt = formatUserSpaceFileRefsForPrompt(fileRefs);
    const userText =
      msg ||
      (fileRefs.length > 0
        ? uiCopy.composer.defaultFileRefMessage
        : uiCopy.composer.defaultImageMessage);
    const outgoing = [userText, refsPrompt].filter(Boolean).join("\n\n");
    const visibleContent = visibleContentFromEditorModel(text, fileRefs, inlineRefKeysRef.current);
    if (!appendLocalUserMessage(outgoing, images, visibleContent)) return;
    commitEditorModel("", [], 0);
    setImages([]);
    clearUserSpaceFileRefs(sessionId);

    editorRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    if (composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }

    if ((e.key === "Backspace" || e.key === "Delete") && editorRef.current) {
      const editor = editorRef.current;
      const modelText = getEditorText(editor);
      const selection = getEditorSelectionOffsets(editor);
      let deleteStart = selection.start;
      let deleteEnd = selection.end;

      if (selection.start === selection.end) {
        if (
          e.key === "Backspace" &&
          selection.start > 0 &&
          modelText[selection.start - 1] === FILE_REF_MARKER
        ) {
          deleteStart = selection.start - 1;
        } else if (e.key === "Delete" && modelText[selection.start] === FILE_REF_MARKER) {
          deleteEnd = selection.start + 1;
        } else {
          rememberEditorSelection();
          return;
        }
      } else if (!modelText.slice(deleteStart, deleteEnd).includes(FILE_REF_MARKER)) {
        rememberEditorSelection();
        return;
      }

      e.preventDefault();
      const result = removeRangeFromEditorModel(
        modelText,
        inlineRefKeysRef.current,
        deleteStart,
        deleteEnd,
      );
      commitEditorModel(result.nextText, result.nextKeys, deleteStart);
      const refsByKey = new Map(fileRefs.map((ref) => [fileRefKey(ref), ref]));
      for (const removedKey of result.removedKeys) {
        const ref = refsByKey.get(removedKey);
        if (ref) removeUserSpaceFileRef(sessionId, ref);
      }
      requestAnimationFrame(() => editorRef.current?.focus());
      return;
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      togglePlanMode();
      return;
    }

    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (!editorRef.current) return;
      const result = insertPlainTextAtCaret(editorRef.current, "\n");
      commitEditorModel(result.nextText, inlineRefKeysRef.current, result.nextCursor);
    }
  }

  function handleInput(e: React.FormEvent<HTMLDivElement>) {
    const editor = e.currentTarget;
    const nativeIsComposing = Boolean((e.nativeEvent as InputEvent).isComposing);
    if (nativeIsComposing) {
      composingRef.current = true;
      setIsComposing(true);
    }

    // Leave the live DOM and selection entirely browser-owned during IME
    // composition. The final model is read once composition has settled.
    if (composingRef.current) return;

    const hadParagraphModel = hasEditorParagraphModel(editor);
    const nextCursor = hadParagraphModel
      ? getEditorCaretOffset(editor)
      : getEditorText(editor).length;
    const nextText = getEditorText(editor);
    const nextKeys = getEditorFileRefKeys(editor);
    const removedKeys = inlineRefKeysRef.current.filter((key) => !nextKeys.includes(key));
    // Browsers temporarily reshape a contentEditable subtree while an IME is
    // composing. Replacing that subtree cancels the active composition and can
    // leave its first phonetic character detached from the rest of the input.
    // Keep the browser-owned DOM intact until compositionend.
    if (!hadParagraphModel) {
      renderEditorModel(editor, nextText, fileRefs, nextKeys, (ref) =>
        requestUserSpaceFilePreview(sessionId, ref),
      );
      setEditorCaretOffset(editor, nextCursor);
    }
    textRef.current = nextText;
    inlineRefKeysRef.current = nextKeys;
    lastEditorSelectionOffsetRef.current = nextCursor;
    setText(nextText);
    setInlineRefKeys(nextKeys);

    if (removedKeys.length > 0) {
      const refsByKey = new Map(fileRefs.map((ref) => [fileRefKey(ref), ref]));
      for (const removedKey of removedKeys) {
        const ref = refsByKey.get(removedKey);
        if (ref) removeUserSpaceFileRef(sessionId, ref);
      }
    }
  }

  function handleInterrupt() {
    sendToSession(sessionId, {
      type: "abort",
      generation: sessionData?.generation ?? runtimeSession?.generation ?? 0,
      clientMsgId: createClientMessageId(),
    });
  }

  function updateLocalAgentMode(mode: "agent" | "plan") {
    const normalizedMode = normalizeAgentMode(mode);
    const store = useStore.getState();
    store.updateSession(sessionId, { mode: normalizedMode } as Partial<SessionState>);
    store.setRuntimeSessions(
      store.runtimeSessions.map((session: PiSessionInfo) =>
        session.sessionId === sessionId ? { ...session, mode: normalizedMode } : session,
      ),
    );
  }

  function togglePlanMode() {
    const nextMode = planModeActive ? "agent" : "plan";
    updateLocalAgentMode(nextMode);
    if (nextMode === "plan") {
      useStore.getState().setPreviousAgentMode(sessionId, "agent");
    }
    sendToSession(sessionId, {
      type: "set_mode",
      mode: nextMode,
      clientMsgId: createClientMessageId(),
    });
  }

  async function addImageFiles(files: Iterable<File>) {
    const newImages: ImageAttachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    if (newImages.length > 0) setImages((prev) => [...prev, ...newImages]);
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    await addImageFiles(Array.from(files));
    e.target.value = "";
  }

  function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleFileDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!isConnected || showStopButton) return;
    fileDragDepthRef.current += 1;
    setImageDragActive(true);
  }

  function handleFileDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isConnected && !showStopButton ? "copy" : "none";
  }

  function handleFileDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setImageDragActive(false);
  }

  async function handleFileDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepthRef.current = 0;
    setImageDragActive(false);
    if (!isConnected || showStopButton) return;
    await addImageFiles(Array.from(e.dataTransfer.files));
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({
        name: `pasted-${Date.now()}.${file.type.split("/")[1]}`,
        base64,
        mediaType,
      });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
      return;
    }
    const plainText = e.clipboardData.getData("text/plain");
    if (plainText && editorRef.current) {
      e.preventDefault();
      const result = insertPlainTextAtCaret(editorRef.current, plainText);
      commitEditorModel(result.nextText, inlineRefKeysRef.current, result.nextCursor);
    }
  }

  return (
    <div
      data-testid="composer-shell"
      className="relative shrink-0 px-3 pb-[var(--piwork-composer-bottom-gap)] pt-3 sm:px-6"
    >
      <div className="mx-auto w-full max-w-[var(--piwork-composer-width)]">
        {!isConnected && (
          <div
            className="mb-2 rounded-[var(--piwork-control-radius)] border border-warning/40 bg-warning-muted px-3 py-2 text-xs font-medium text-warning"
            role="status"
            aria-live="polite"
          >
            {uiCopy.composer.connectionUnavailable}
          </div>
        )}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="h-12 w-12 rounded-lg border border-border object-cover"
                />
                <button
                  onClick={() => removeImage(i)}
                  aria-label={uiCopy.common.removeImage}
                  className="absolute -right-1.5 -top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--piwork-control-radius)] bg-danger text-primary-foreground opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          aria-label={uiCopy.common.attachImages}
        />

        {promptSuggestions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {promptSuggestions.map((suggestion, i) => (
              <button
                key={i}
                onClick={() => {
                  if (!isConnected || showStopButton) return;
                  if (appendLocalUserMessage(suggestion)) clearPromptSuggestions(sessionId);
                }}
                disabled={!isConnected || showStopButton}
                className="max-w-[280px] cursor-pointer truncate rounded-[var(--piwork-control-radius)] border border-border bg-muted px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                title={suggestion}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <div data-testid="composer-card-stage" className="relative isolate">
          <div
            data-testid="composer-bottom-mask"
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--piwork-composer-bottom-gap)*-1)] top-[var(--piwork-composer-radius)] bg-[var(--piwork-composer-tray-background)]"
          />
          <div
            data-testid="composer-card"
            data-drop-target={imageDragActive ? "true" : undefined}
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            className="piwork-composer-card relative z-10 flex flex-col overflow-visible rounded-[var(--piwork-composer-radius)] transition-colors"
          >
            <div data-testid="composer-body" className="relative z-10 flex min-h-0 flex-1 flex-col">
              <div
                data-testid="composer-inline-input"
                className="flex max-h-[25dvh] min-h-12 flex-grow flex-wrap items-start gap-x-1.5 gap-y-1.5 overflow-y-auto px-3 pb-2 pt-3 text-sm font-[430] leading-[21px] text-foreground"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) {
                    event.preventDefault();
                    editorRef.current?.focus();
                  }
                }}
              >
                <div
                  ref={editorRef}
                  role="textbox"
                  contentEditable="true"
                  suppressContentEditableWarning
                  onInput={handleInput}
                  onKeyDown={handleKeyDown}
                  onKeyUp={rememberEditorSelection}
                  onMouseUp={rememberEditorSelection}
                  onFocus={rememberEditorSelection}
                  onCompositionStart={() => {
                    if (compositionFrameRef.current !== null) {
                      cancelAnimationFrame(compositionFrameRef.current);
                      compositionFrameRef.current = null;
                    }
                    composingRef.current = true;
                    setIsComposing(true);
                  }}
                  onCompositionEnd={() => {
                    // Chrome can emit one final input event after compositionend.
                    // Keep the DOM browser-owned until that event has completed.
                    if (compositionFrameRef.current !== null) {
                      cancelAnimationFrame(compositionFrameRef.current);
                    }
                    compositionFrameRef.current = requestAnimationFrame(() => {
                      compositionFrameRef.current = null;
                      composingRef.current = false;
                      setIsComposing(false);
                      if (!editorRef.current) return;
                      const nextCursor = getEditorCaretOffset(editorRef.current);
                      commitEditorModel(
                        getEditorText(editorRef.current),
                        getEditorFileRefKeys(editorRef.current),
                        nextCursor,
                      );
                    });
                  }}
                  onPaste={handlePaste}
                  aria-label={uiCopy.common.messageInput}
                  aria-placeholder={uiCopy.composer.shortcuts}
                  aria-multiline="true"
                  aria-disabled={!isConnected}
                  data-empty={text.length === 0 && !isComposing ? "true" : "false"}
                  data-placeholder={uiCopy.composer.shortcuts}
                  className="piwork-prosemirror-editor relative h-auto min-h-5 min-w-[8rem] flex-1 overflow-visible [white-space:break-spaces] break-words border-0 bg-transparent px-0 py-0 text-sm font-[430] leading-5 text-foreground outline-none focus:ring-0"
                />
              </div>

              <div className="composer-footer flex min-h-9 items-center justify-between gap-2 px-2 py-2">
                <div className="flex min-w-0 items-center gap-[5px]">
                  <Button
                    onPress={() => fileInputRef.current?.click()}
                    isDisabled={!isConnected || showStopButton}
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    className="h-[var(--piwork-composer-control-size)] min-h-[var(--piwork-composer-control-size)] w-[var(--piwork-composer-control-size)] min-w-[var(--piwork-composer-control-size)] shrink-0 rounded-[var(--piwork-control-radius)] p-0 text-muted-foreground hover:bg-muted hover:text-foreground data-[hover=true]:bg-muted"
                    aria-label={uiCopy.common.attachImage}
                  >
                    <CodexPlusIcon className="h-5 w-5" />
                  </Button>
                  {planModeActive && (
                    <span
                      data-testid="composer-plan-status"
                      className="px-2 text-sm font-medium text-foreground"
                    >
                      {uiCopy.composer.planLabel}
                    </span>
                  )}
                </div>

                <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
                  <ModelSwitcher sessionId={sessionId} />

                  {showStopButton ? (
                    <Button
                      onPress={handleInterrupt}
                      size="sm"
                      variant="danger-soft"
                      isIconOnly
                      className="h-[var(--piwork-composer-control-size)] min-h-[var(--piwork-composer-control-size)] w-[var(--piwork-composer-control-size)] min-w-[var(--piwork-composer-control-size)] shrink-0 rounded-[var(--piwork-control-radius)] p-0"
                      aria-label={uiCopy.common.stopGeneration}
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
                        <rect x="3" y="3" width="10" height="10" rx="1" />
                      </svg>
                    </Button>
                  ) : (
                    <Button
                      onPress={handleSend}
                      isDisabled={!canSend}
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      className="h-[var(--piwork-composer-control-size)] min-h-[var(--piwork-composer-control-size)] w-[var(--piwork-composer-control-size)] min-w-[var(--piwork-composer-control-size)] shrink-0 rounded-[var(--piwork-control-radius)] bg-primary p-0 text-primary-foreground hover:bg-primary/90 data-[hover=true]:bg-primary/90"
                      aria-label={uiCopy.common.sendMessage}
                    >
                      <CodexArrowIcon className="h-5 w-5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {imageDragActive && (
              <div
                data-testid="composer-file-drop-overlay"
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[var(--piwork-composer-radius)] border-2 border-dashed border-primary bg-[color-mix(in_oklch,var(--piwork-composer-background)_88%,var(--primary))] px-4 text-center text-sm font-medium text-foreground"
              >
                {uiCopy.composer.dropImages}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getFileReferenceTokenLabel(name: string): string {
  const displayName = name || "file";
  const maxLength = 18;
  if (displayName.length <= maxLength) return `@${displayName}`;

  const dotIndex = displayName.lastIndexOf(".");
  const extension = dotIndex > 0 ? displayName.slice(dotIndex) : "";
  const stem = extension ? displayName.slice(0, dotIndex) : displayName;
  const available = Math.max(8, maxLength - extension.length - 3);
  const headLength = Math.max(2, Math.ceil(available * 0.45));
  const tailLength = Math.max(2, available - headLength);
  return `@${stem.slice(0, headLength)}...${stem.slice(-tailLength)}${extension}`;
}

function createFileReferenceTokenElement(
  documentRef: Document,
  ref: UserSpaceFileReference,
  onPreview: (ref: UserSpaceFileReference) => void,
): HTMLElement {
  const label = getFileReferenceTokenLabel(ref.name);
  const token = documentRef.createElement("span");
  token.setAttribute(FILE_REF_TOKEN_ATTR, "true");
  token.setAttribute(FILE_REF_KEY_ATTR, fileRefKey(ref));
  token.setAttribute("contenteditable", "false");
  token.setAttribute("role", "button");
  token.setAttribute("tabindex", "0");
  token.setAttribute("aria-label", uiCopy.composer.previewReferencedFile(ref.name));
  token.title = ref.name;
  token.className =
    "mx-0.5 inline-flex h-5 cursor-pointer items-baseline align-baseline text-sm font-[430] leading-5 text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

  const labelNode = documentRef.createElement("span");
  labelNode.className = "min-w-0";
  labelNode.textContent = label;
  token.append(labelNode);

  token.addEventListener("click", () => onPreview(ref));
  token.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPreview(ref);
  });

  return token;
}

function renderEditorModel(
  editor: HTMLDivElement,
  text: string,
  refs: UserSpaceFileReference[],
  keys: string[],
  onPreview: (ref: UserSpaceFileReference) => void,
) {
  const documentRef = editor.ownerDocument;
  const refsByKey = new Map(refs.map((ref) => [fileRefKey(ref), ref]));
  let markerOrdinal = 0;
  const paragraphs = splitEditorLines(text).map((line) =>
    createEditorParagraph(documentRef, line, () => {
      const key = keys[markerOrdinal];
      markerOrdinal += 1;
      const ref = key ? refsByKey.get(key) : undefined;
      return ref ? createFileReferenceTokenElement(documentRef, ref, onPreview) : null;
    }),
  );
  editor.replaceChildren(...paragraphs);
}
