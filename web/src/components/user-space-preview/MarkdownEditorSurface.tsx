import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Code2,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Strikethrough,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Crepe, CrepeConfig } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  selectTextNearPosCommand,
  setBlockTypeCommand,
  toggleEmphasisCommand,
  toggleStrongCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { createTable, toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { uiCopy } from "../../ui-copy.js";
import { ListBoxEngine as ListBox, SelectEngine as Select } from "../ui/index.js";

export type MarkdownToolbarCommand =
  | "bold"
  | "italic"
  | "strikethrough"
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "table"
  | "code-block"
  | "quote"
  | "divider";

export interface MarkdownEditorToolbarCopy {
  actions: Record<MarkdownToolbarCommand, string>;
  headings: readonly [string, string, string, string, string, string];
  label: string;
  paragraph: string;
  stylePicker: string;
}

export interface MarkdownEditorSurfaceProps {
  ariaLabel: string;
  darkMode: boolean;
  detached?: boolean;
  path: string;
  readOnly: boolean;
  resolveImageSrc?: (src: string) => string;
  testId: string;
  toolbarPortalId?: string;
  toolbarCopy: MarkdownEditorToolbarCopy;
  value: string;
  onChange: (value: string) => void;
}

export const MarkdownEditorSurface = memo(function MarkdownEditorSurface({
  ariaLabel,
  darkMode,
  detached = false,
  path: _path,
  readOnly,
  resolveImageSrc = (src) => src,
  testId,
  toolbarPortalId,
  toolbarCopy,
  value,
  onChange,
}: MarkdownEditorSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const resolveImageSrcRef = useRef(resolveImageSrc);
  const readOnlyRef = useRef(readOnly);
  const valueRef = useRef(value);
  const userEditedRef = useRef(false);
  const resolvedImageSourcesRef = useRef(new Map<string, string>());
  const [initError, setInitError] = useState("");
  const [loading, setLoading] = useState(true);
  const [toolbarPortalTarget, setToolbarPortalTarget] = useState<HTMLElement | null>(null);

  valueRef.current = value;

  useLayoutEffect(() => {
    if (readOnly || !toolbarPortalId) {
      setToolbarPortalTarget(null);
      return;
    }
    const ownerDocument = containerRef.current?.ownerDocument;
    if (!ownerDocument) return;
    const syncTarget = () => setToolbarPortalTarget(ownerDocument.getElementById(toolbarPortalId));
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(ownerDocument.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [detached, readOnly, toolbarPortalId]);

  useEffect(() => {
    onChangeRef.current = onChange;
    resolveImageSrcRef.current = resolveImageSrc;
    readOnlyRef.current = readOnly;
  }, [onChange, readOnly, resolveImageSrc]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    syncMarkdownEditorImageSources(root, resolveImageSrc, resolvedImageSourcesRef.current);
  }, [resolveImageSrc]);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    crepe.setReadonly(readOnly);
    if (readOnly) {
      blurMarkdownEditor(rootRef.current);
      return;
    }
    const frame = requestAnimationFrame(() => focusMarkdownEditor(rootRef.current));
    return () => cancelAnimationFrame(frame);
  }, [readOnly]);

  const runToolbarCommand = useCallback((command: MarkdownToolbarCommand) => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    userEditedRef.current = true;
    runMarkdownToolbarCommand(crepe, command);
  }, []);

  const runBlockStyle = useCallback((level: number | null) => {
    const crepe = crepeRef.current;
    if (!crepe) return;
    userEditedRef.current = true;
    setMarkdownBlockStyle(crepe, level);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const markUserEdited = () => {
      userEditedRef.current = true;
    };
    const eventNames = ["beforeinput", "input", "change", "paste", "drop", "cut"];
    for (const eventName of eventNames) root.addEventListener(eventName, markUserEdited, true);
    return () => {
      for (const eventName of eventNames) root.removeEventListener(eventName, markUserEdited, true);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const syncImages = () =>
      syncMarkdownEditorImageSources(
        root,
        resolveImageSrcRef.current,
        resolvedImageSourcesRef.current,
      );
    syncImages();
    const observer = new MutationObserver(syncImages);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["src"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let disposed = false;
    let crepe: Crepe | null = null;
    userEditedRef.current = false;
    resolvedImageSourcesRef.current.clear();
    setInitError("");
    setLoading(true);

    void import("@milkdown/crepe")
      .then(({ Crepe }) => {
        if (disposed) return undefined;
        crepe = new Crepe({
          root,
          defaultValue: valueRef.current,
          features: createMarkdownCrepeFeatures(),
          featureConfigs: createMarkdownCrepeFeatureConfigs(darkMode),
        });
        crepeRef.current = crepe;
        crepe.setReadonly(readOnlyRef.current).on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            if (!userEditedRef.current) return;
            onChangeRef.current(
              restoreResolvedImageSources(markdown, resolvedImageSourcesRef.current),
            );
          });
        });
        return crepe.create();
      })
      .then(() => {
        if (!crepe) return;
        if (disposed) {
          void crepe.destroy();
          return;
        }
        updateMarkdownEditorRoot(crepe);
        crepe.setReadonly(readOnlyRef.current);
        const editor = root.querySelector<HTMLElement>(".ProseMirror");
        editor?.setAttribute("aria-label", ariaLabel);
        syncMarkdownEditorImageSources(
          root,
          resolveImageSrcRef.current,
          resolvedImageSourcesRef.current,
        );
        if (readOnlyRef.current) blurMarkdownEditor(root);
        else focusMarkdownEditor(root);
        setLoading(false);
      })
      .catch((reason) => {
        if (disposed) return;
        setLoading(false);
        setInitError(reason instanceof Error ? reason.message : uiCopy.markdownEditor.loadFailed);
      });

    return () => {
      disposed = true;
      if (crepeRef.current === crepe) crepeRef.current = null;
      if (crepe) void crepe.destroy().catch(() => undefined);
    };
  }, [ariaLabel, darkMode]);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (crepe) updateMarkdownEditorRoot(crepe);
  }, [detached]);

  useEffect(() => {
    if (!detached) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const button = target?.closest?.<HTMLElement>("[data-markdown-toolbar-command]");
      if (!button || (!container.contains(button) && !toolbarPortalTarget?.contains(button)))
        return;
      const command = button.dataset.markdownToolbarCommand as MarkdownToolbarCommand | undefined;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runToolbarCommand(command);
    };
    const eventRoots = toolbarPortalTarget ? [container, toolbarPortalTarget] : [container];
    for (const eventRoot of eventRoots) {
      eventRoot.addEventListener("pointerdown", handlePointerDown);
    }
    return () => {
      for (const eventRoot of eventRoots) {
        eventRoot.removeEventListener("pointerdown", handlePointerDown);
      }
    };
  }, [detached, runToolbarCommand, toolbarPortalTarget]);

  const toolbar = !readOnly ? (
    <div className="piwork-markdown-top-bar" role="toolbar" aria-label={toolbarCopy.label}>
      <Select
        aria-label={toolbarCopy.stylePicker}
        className="piwork-markdown-style-select"
        selectedKey={null}
        onSelectionChange={(key) => {
          const value = String(key);
          runBlockStyle(value === "body" ? null : Number(value));
        }}
      >
        <Select.Trigger className="piwork-markdown-style-picker" data-markdown-block-style="true">
          <Select.Value className="piwork-markdown-style-picker-value">
            {toolbarCopy.stylePicker}
          </Select.Value>
          <Select.Indicator className="piwork-markdown-style-picker-indicator" />
        </Select.Trigger>
        <Select.Popover
          className="piwork-dropdown-motion piwork-superellipse-panel piwork-markdown-style-picker-popover rounded-xl"
          placement="bottom start"
        >
          <ListBox
            aria-label={toolbarCopy.stylePicker}
            className="piwork-markdown-style-picker-listbox"
          >
            <ListBox.Item
              id="body"
              textValue={toolbarCopy.paragraph}
              className="piwork-markdown-style-picker-option"
            >
              <MarkdownBlockStyleIcon level={null} />
              <span className="piwork-markdown-style-picker-option-label">
                {toolbarCopy.paragraph}
              </span>
            </ListBox.Item>
            {toolbarCopy.headings.map((label, index) => (
              <ListBox.Item
                key={label}
                id={String(index + 1)}
                textValue={label}
                className="piwork-markdown-style-picker-option"
              >
                <MarkdownBlockStyleIcon level={index + 1} />
                <span className="piwork-markdown-style-picker-option-label">{label}</span>
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <ToolbarDivider />
      <ToolbarButton
        command="bold"
        icon={Bold}
        label={toolbarCopy.actions.bold}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="italic"
        icon={Italic}
        label={toolbarCopy.actions.italic}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="strikethrough"
        icon={Strikethrough}
        label={toolbarCopy.actions.strikethrough}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarDivider />
      <ToolbarButton
        command="bullet-list"
        icon={List}
        label={toolbarCopy.actions["bullet-list"]}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="ordered-list"
        icon={ListOrdered}
        label={toolbarCopy.actions["ordered-list"]}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="task-list"
        icon={ListTodo}
        label={toolbarCopy.actions["task-list"]}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarDivider />
      <ToolbarButton
        command="table"
        icon={Table2}
        label={toolbarCopy.actions.table}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarDivider />
      <ToolbarButton
        command="code-block"
        icon={Code2}
        label={toolbarCopy.actions["code-block"]}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="quote"
        icon={Quote}
        label={toolbarCopy.actions.quote}
        detached={detached}
        onCommand={runToolbarCommand}
      />
      <ToolbarButton
        command="divider"
        icon={Minus}
        label={toolbarCopy.actions.divider}
        detached={detached}
        onCommand={runToolbarCommand}
      />
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className="piwork-markdown-crepe flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain"
      data-testid={testId}
      data-dark-mode={darkMode ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
    >
      {toolbar &&
        (toolbarPortalTarget
          ? createPortal(toolbar, toolbarPortalTarget)
          : toolbarPortalId
            ? null
            : toolbar)}
      {initError && (
        <div className="m-3 rounded-[var(--piwork-control-radius)] border border-danger/35 bg-danger-muted px-3 py-1.5 text-xs text-danger">
          {initError}
        </div>
      )}
      <div
        ref={rootRef}
        className="px-5 min-h-full w-full flex-1"
        aria-busy={loading || undefined}
      />
    </div>
  );
});

const MARKDOWN_BLOCK_STYLE_ICON_PATHS = [
  "M5 5.5C5 6.33 5.67 7 6.5 7H10.5V17.5C10.5 18.33 11.17 19 12 19C12.83 19 13.5 18.33 13.5 17.5V7H17.5C18.33 7 19 6.33 19 5.5C19 4.67 18.33 4 17.5 4H6.5C5.67 4 5 4.67 5 5.5Z",
  "M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM12 17H14V7H10V9H12V17Z",
  "M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15H11V13H13C14.1 13 15 12.11 15 11V9C15 7.89 14.1 7 13 7H9V9H13V11H11C9.9 11 9 11.89 9 13V17H15V15Z",
  "M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15V13.5C15 12.67 14.33 12 13.5 12C14.33 12 15 11.33 15 10.5V9C15 7.89 14.1 7 13 7H9V9H13V11H11V13H13V15H9V17H13C14.1 17 15 16.11 15 15Z",
  "M19.04 3H5.04004C3.94004 3 3.04004 3.9 3.04004 5V19C3.04004 20.1 3.94004 21 5.04004 21H19.04C20.14 21 21.04 20.1 21.04 19V5C21.04 3.9 20.14 3 19.04 3ZM19.04 19H5.04004V5H19.04V19ZM13.04 17H15.04V7H13.04V11H11.04V7H9.04004V13H13.04V17Z",
  "M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19ZM15 15V13C15 11.89 14.1 11 13 11H11V9H15V7H9V13H13V15H9V17H13C14.1 17 15 16.11 15 15Z",
  "M11 17H13C14.1 17 15 16.11 15 15V13C15 11.89 14.1 11 13 11H11V9H15V7H11C9.9 7 9 7.89 9 9V15C9 16.11 9.9 17 11 17ZM11 13H13V15H11V13ZM19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM19 19H5V5H19V19Z",
] as const;

function MarkdownBlockStyleIcon({ level }: { level: number | null }) {
  return (
    <span className="piwork-markdown-style-picker-option-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d={MARKDOWN_BLOCK_STYLE_ICON_PATHS[level ?? 0]} />
      </svg>
    </span>
  );
}

function ToolbarButton({
  command,
  detached,
  icon: Icon,
  label,
  onCommand,
}: {
  command: MarkdownToolbarCommand;
  detached: boolean;
  icon: LucideIcon;
  label: string;
  onCommand: (command: MarkdownToolbarCommand) => void;
}) {
  return (
    <button
      type="button"
      className="piwork-markdown-toolbar-button"
      data-markdown-toolbar-command={command}
      aria-label={label}
      title={label}
      onPointerDown={
        detached
          ? undefined
          : (event) => {
              event.preventDefault();
              onCommand(command);
            }
      }
      onClick={(event) => {
        if (event.detail === 0) onCommand(command);
      }}
    >
      <Icon className="h-4 w-4" aria-hidden={true} />
    </button>
  );
}

function ToolbarDivider() {
  return <span className="piwork-markdown-toolbar-divider" aria-hidden="true" />;
}

function runMarkdownToolbarCommand(crepe: Crepe, command: MarkdownToolbarCommand): void {
  crepe.editor.action((ctx) => {
    const commands = ctx.get(commandsCtx);
    if (command === "bold") commands.call(toggleStrongCommand.key);
    else if (command === "italic") commands.call(toggleEmphasisCommand.key);
    else if (command === "strikethrough") commands.call(toggleStrikethroughCommand.key);
    else if (command === "bullet-list") {
      commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) });
    } else if (command === "ordered-list") {
      commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) });
    } else if (command === "task-list") {
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: listItemSchema.type(ctx),
        attrs: { checked: false },
      });
    } else if (command === "table") {
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;
      commands.call(addBlockTypeCommand.key, { nodeType: createTable(ctx, 3, 3) });
      commands.call(selectTextNearPosCommand.key, { pos: from });
    } else if (command === "code-block") {
      commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) });
    } else if (command === "quote") {
      commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
    } else if (command === "divider") {
      commands.call(addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) });
    }
  });
}

function setMarkdownBlockStyle(crepe: Crepe, level: number | null): void {
  crepe.editor.action((ctx) => {
    const commands = ctx.get(commandsCtx);
    commands.call(
      setBlockTypeCommand.key,
      level === null
        ? { nodeType: paragraphSchema.type(ctx) }
        : { nodeType: headingSchema.type(ctx), attrs: { level } },
    );
  });
}

function updateMarkdownEditorRoot(crepe: Crepe): void {
  crepe.editor.action((ctx) => {
    ctx.get(editorViewCtx).updateRoot();
  });
}

function focusMarkdownEditor(root: HTMLElement | null): void {
  root?.querySelector<HTMLElement>(".ProseMirror")?.focus({ preventScroll: true });
}

function blurMarkdownEditor(root: HTMLElement | null): void {
  root?.querySelector<HTMLElement>(".ProseMirror")?.blur();
}

function createMarkdownCrepeFeatures(): NonNullable<CrepeConfig["features"]> {
  return {
    "top-bar": false,
    "block-edit": true,
    toolbar: false,
  };
}

function createMarkdownCrepeFeatureConfigs(
  darkMode: boolean,
): NonNullable<CrepeConfig["featureConfigs"]> {
  const markdown = uiCopy.markdownEditor;
  return {
    "block-edit": {
      textGroup: {
        label: markdown.blockEdit.textGroup.label,
        text: { label: markdown.blockEdit.textGroup.text },
        h1: { label: markdown.blockEdit.textGroup.h1 },
        h2: { label: markdown.blockEdit.textGroup.h2 },
        h3: { label: markdown.blockEdit.textGroup.h3 },
        h4: { label: markdown.blockEdit.textGroup.h4 },
        h5: { label: markdown.blockEdit.textGroup.h5 },
        h6: { label: markdown.blockEdit.textGroup.h6 },
        quote: { label: markdown.blockEdit.textGroup.quote },
        divider: { label: markdown.blockEdit.textGroup.divider },
      },
      listGroup: {
        label: markdown.blockEdit.listGroup.label,
        bulletList: { label: markdown.blockEdit.listGroup.bulletList },
        orderedList: { label: markdown.blockEdit.listGroup.orderedList },
        taskList: { label: markdown.blockEdit.listGroup.taskList },
      },
      advancedGroup: {
        label: markdown.blockEdit.advancedGroup.label,
        image: { label: markdown.blockEdit.advancedGroup.image },
        codeBlock: { label: markdown.blockEdit.advancedGroup.codeBlock },
        table: { label: markdown.blockEdit.advancedGroup.table },
        math: { label: markdown.blockEdit.advancedGroup.math },
      },
    },
    placeholder: { text: markdown.placeholder },
    "link-tooltip": { inputPlaceholder: markdown.linkTooltip.pasteLink },
    "image-block": {
      inlineUploadButton: markdown.imageBlock.inlineUpload,
      inlineUploadPlaceholderText: markdown.imageBlock.pasteLink,
      blockUploadButton: markdown.imageBlock.uploadImage,
      blockConfirmButton: markdown.imageBlock.confirm,
      blockCaptionPlaceholderText: markdown.imageBlock.captionPlaceholder,
      blockUploadPlaceholderText: markdown.imageBlock.pasteLink,
    },
    "code-mirror": {
      theme: darkMode ? oneDark : syntaxHighlighting(defaultHighlightStyle),
      searchPlaceholder: markdown.codeMirror.searchLanguage,
      noResultText: markdown.codeMirror.noResult,
      copyText: markdown.codeMirror.copy,
      previewToggleText: (previewOnlyMode: boolean) =>
        previewOnlyMode ? markdown.codeMirror.edit : markdown.codeMirror.hide,
      previewLabel: markdown.codeMirror.preview,
      previewLoading: markdown.codeMirror.loading,
    },
  };
}

const ORIGINAL_IMAGE_SRC_ATTRIBUTE = "data-piwork-markdown-image-src";

function syncMarkdownEditorImageSources(
  root: HTMLElement,
  resolveImageSrc: (src: string) => string,
  resolvedSources: Map<string, string>,
): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    const originalSrc =
      image.getAttribute(ORIGINAL_IMAGE_SRC_ATTRIBUTE) || image.getAttribute("src") || "";
    if (!originalSrc) continue;
    if (!image.hasAttribute(ORIGINAL_IMAGE_SRC_ATTRIBUTE)) {
      image.setAttribute(ORIGINAL_IMAGE_SRC_ATTRIBUTE, originalSrc);
    }
    const resolvedSrc = resolveImageSrc(originalSrc);
    if (!resolvedSrc) continue;
    resolvedSources.set(resolvedSrc, originalSrc);
    if (image.getAttribute("src") !== resolvedSrc) image.setAttribute("src", resolvedSrc);
  }
}

function restoreResolvedImageSources(markdown: string, sources: Map<string, string>): string {
  let restored = markdown;
  for (const [resolvedSrc, originalSrc] of sources) {
    if (resolvedSrc && restored.includes(resolvedSrc)) {
      restored = restored.split(resolvedSrc).join(originalSrc);
    }
  }
  return restored;
}
