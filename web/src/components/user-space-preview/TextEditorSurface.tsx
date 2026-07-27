import { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Decoration, EditorView, GutterMarker, gutterLineClass } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { tags } from "@lezer/highlight";

const USER_SPACE_TEXT_HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: [tags.comment, tags.docComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--primary)",
  },
  { tag: [tags.typeName, tags.className], color: "var(--info)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--primary)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--muted-foreground)" },
  { tag: [tags.heading, tags.strong], color: "var(--foreground)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--primary)", textDecoration: "underline" },
]);

function createUserSpaceTextEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
      },
      ".cm-scroller": {
        backgroundColor: "var(--background)",
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
      },
      ".cm-content.cm-lineWrapping": {
        paddingRight: "2ch",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--background)",
        borderColor: "var(--border)",
        color: "var(--muted-foreground)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 1ch 0 2ch",
        userSelect: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-line": {
        backgroundColor: "transparent",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
        {
          backgroundColor: "var(--piwork-text-selection-background)",
        },
      ".cm-content ::selection": {
        backgroundColor: "var(--piwork-text-selection-background)",
      },
    },
    { dark },
  );
}

const USER_SPACE_TEXT_EDITOR_THEME_LIGHT = createUserSpaceTextEditorTheme(false);
const USER_SPACE_TEXT_EDITOR_THEME_DARK = createUserSpaceTextEditorTheme(true);
const USER_SPACE_TEXT_HIGHLIGHT_EXTENSIONS: Extension[] = [
  syntaxHighlighting(USER_SPACE_TEXT_HIGHLIGHT_STYLE),
];
const SEARCH_PREVIEW_HIGHLIGHT_CLASS = "piwork-search-preview-highlight";
const SEARCH_PREVIEW_LINE_NUMBER_CLASS = "piwork-search-preview-line-number";
const SEARCH_PREVIEW_MAX_HIGHLIGHTS = 1000;
const SEARCH_PREVIEW_HIGHLIGHT_THEME = EditorView.theme({
  [`.${SEARCH_PREVIEW_HIGHLIGHT_CLASS}`]: {
    borderRadius: "3px",
    backgroundColor: "color-mix(in oklch, var(--warning) 34%, transparent)",
    color: "var(--foreground)",
    outline: "1px solid color-mix(in oklch, var(--warning) 44%, transparent)",
  },
  [`.cm-lineNumbers .cm-gutterElement.${SEARCH_PREVIEW_LINE_NUMBER_CLASS}`]: {
    borderRadius: "4px",
    backgroundColor: "color-mix(in oklch, var(--warning) 24%, transparent)",
    color: "var(--foreground)",
    fontWeight: "700",
  },
});

class SearchPreviewLineNumberMarker extends GutterMarker {
  override elementClass = SEARCH_PREVIEW_LINE_NUMBER_CLASS;
}

const SEARCH_PREVIEW_LINE_NUMBER_MARKER = new SearchPreviewLineNumberMarker();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSearchPreviewHighlightExtension(query: string): Extension[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const matcher = new RegExp(escapeRegExp(trimmedQuery), "gi");
  const highlight = Decoration.mark({ class: SEARCH_PREVIEW_HIGHLIGHT_CLASS });
  return [
    SEARCH_PREVIEW_HIGHLIGHT_THEME,
    EditorView.decorations.compute(["doc"], (state) => {
      const builder = new RangeSetBuilder<Decoration>();
      const text = state.doc.toString();
      let count = 0;
      for (
        let match = matcher.exec(text);
        match && count < SEARCH_PREVIEW_MAX_HIGHLIGHTS;
        match = matcher.exec(text)
      ) {
        const value = match[0];
        if (!value) {
          matcher.lastIndex += 1;
          continue;
        }
        builder.add(match.index, match.index + value.length, highlight);
        count += 1;
      }
      matcher.lastIndex = 0;
      return builder.finish();
    }),
    gutterLineClass.compute(["doc"], (state) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const text = state.doc.toString();
      const highlightedLines = new Set<number>();
      let count = 0;
      for (
        let match = matcher.exec(text);
        match && count < SEARCH_PREVIEW_MAX_HIGHLIGHTS;
        match = matcher.exec(text)
      ) {
        const value = match[0];
        if (!value) {
          matcher.lastIndex += 1;
          continue;
        }
        const line = state.doc.lineAt(match.index);
        if (!highlightedLines.has(line.from)) {
          builder.add(line.from, line.from, SEARCH_PREVIEW_LINE_NUMBER_MARKER);
          highlightedLines.add(line.from);
        }
        count += 1;
      }
      matcher.lastIndex = 0;
      return builder.finish();
    }),
  ];
}

const BASIC_SETUP = {
  lineNumbers: true,
  highlightActiveLineGutter: false,
  highlightSpecialChars: true,
  history: true,
  foldGutter: false,
  drawSelection: true,
  dropCursor: false,
  allowMultipleSelections: false,
  indentOnInput: false,
  syntaxHighlighting: false,
  bracketMatching: true,
  closeBrackets: false,
  autocompletion: false,
  rectangularSelection: false,
  crosshairCursor: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  closeBracketsKeymap: false,
  defaultKeymap: true,
  searchKeymap: true,
  historyKeymap: true,
  foldKeymap: false,
  completionKeymap: false,
  lintKeymap: false,
} as const;

async function loadLanguageForPath(filePath: string): Promise<Extension | null> {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "ts":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: true,
        typescript: true,
      });
    case "css":
    case "scss":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return (await import("@codemirror/lang-html")).html();
    case "json":
    case "jsonc":
    case "json5":
      return (await import("@codemirror/lang-json")).json();
    case "md":
    case "mdx":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "py":
    case "pyw":
    case "pyi":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "c":
    case "h":
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "xml":
    case "xsl":
    case "xsd":
    case "svg":
      return (await import("@codemirror/lang-xml")).xml();
    case "yml":
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    default:
      return null;
  }
}

function languageKeyForPath(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() || "";
}

export interface TextEditorSurfaceProps {
  ariaLabel: string;
  darkMode: boolean;
  path: string;
  plainText: boolean;
  readOnly: boolean;
  searchHighlightQuery: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
}

export interface TextEditorSurfaceHandle {
  focus: () => void;
  getView: () => EditorView | null;
  redo: () => boolean;
  undo: () => boolean;
}

export const TextEditorSurface = memo(
  forwardRef<TextEditorSurfaceHandle, TextEditorSurfaceProps>(function TextEditorSurface(
    {
      ariaLabel,
      darkMode,
      path,
      plainText,
      readOnly,
      searchHighlightQuery,
      testId,
      value,
      onChange,
    },
    forwardedRef,
  ) {
    const viewRef = useRef<EditorView | null>(null);
    // Directory-only moves must not replace the editor model. The language
    // grammar depends on the extension, not the full workspace path, so keep
    // the loaded extension (and CodeMirror instance) stable across reparenting.
    const languageKey = `language:${languageKeyForPath(path)}`;
    const [languageState, setLanguageState] = useState<{
      key: string;
      extension: Extension | null;
    } | null>(null);

    useEffect(() => {
      if (plainText) return undefined;
      let cancelled = false;
      void loadLanguageForPath(path)
        .then((extension) => {
          if (!cancelled) setLanguageState({ key: languageKey, extension });
        })
        .catch(() => {
          if (!cancelled) setLanguageState({ key: languageKey, extension: null });
        });
      return () => {
        cancelled = true;
      };
    }, [languageKey, path, plainText]);

    const languageReady = plainText || languageState?.key === languageKey;
    const languageExtension = languageReady && !plainText ? languageState?.extension : null;
    const extensions = useMemo(() => {
      const next: Extension[] = [
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        darkMode ? USER_SPACE_TEXT_EDITOR_THEME_DARK : USER_SPACE_TEXT_EDITOR_THEME_LIGHT,
      ];
      if (!plainText) {
        if (languageExtension) next.push(languageExtension);
        next.push(...USER_SPACE_TEXT_HIGHLIGHT_EXTENSIONS);
      }
      next.push(...createSearchPreviewHighlightExtension(searchHighlightQuery));
      return next;
    }, [ariaLabel, darkMode, languageExtension, plainText, searchHighlightQuery]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus: () => viewRef.current?.focus(),
        getView: () => viewRef.current,
        redo: () => (viewRef.current ? redo(viewRef.current) : false),
        undo: () => (viewRef.current ? undo(viewRef.current) : false),
      }),
      [],
    );

    useEffect(() => {
      if (!readOnly) viewRef.current?.focus();
    }, [readOnly]);

    if (!languageReady) {
      return <div className="h-full bg-background" aria-busy="true" />;
    }

    return (
      <div
        className="h-full bg-background"
        data-testid={testId}
        data-language-mode={plainText ? "plaintext" : "language"}
        data-search-highlight-query={searchHighlightQuery.trim() || undefined}
        data-search-highlight-line-numbers={searchHighlightQuery.trim() ? "true" : undefined}
      >
        <CodeMirror
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          editable={!readOnly}
          extensions={extensions}
          theme="none"
          basicSetup={BASIC_SETUP}
          onCreateEditor={(view) => {
            // @uiw/react-codemirror can resolve its EditorView type through a
            // second package instance. The runtime object is the same API, but
            // TypeScript treats CodeMirror's private fields as nominal.
            viewRef.current = view as unknown as EditorView;
            if (!readOnly) view.focus();
          }}
          className="h-full text-sm"
          height="100%"
        />
      </div>
    );
  }),
);
