// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { TextEditorSurface } from "./TextEditorSurface.js";

const { editorThemeCalls } = vi.hoisted(() => ({
  editorThemeCalls: [] as Array<{
    options?: { dark?: boolean };
    spec: Record<string, unknown>;
  }>,
}));

vi.mock("@codemirror/view", async () => {
  const actual = await vi.importActual<typeof import("@codemirror/view")>("@codemirror/view");
  const originalTheme = actual.EditorView.theme.bind(actual.EditorView);
  vi.spyOn(actual.EditorView, "theme").mockImplementation((spec, options) => {
    editorThemeCalls.push({
      spec: spec as Record<string, unknown>,
      options: options as { dark?: boolean } | undefined,
    });
    return originalTheme(spec, options);
  });
  return actual;
});

vi.mock("@uiw/react-codemirror", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    default: ({
      extensions,
      onCreateEditor,
      value,
    }: {
      extensions?: unknown[];
      onCreateEditor?: (view: { focus: () => void }) => void;
      value?: string;
    }) => {
      const editorRef = React.useRef<HTMLTextAreaElement>(null);
      const viewRef = React.useRef({
        focus: () => editorRef.current?.focus(),
      });
      React.useEffect(() => {
        onCreateEditor?.(viewRef.current);
      }, [onCreateEditor]);
      return React.createElement("textarea", {
        ref: editorRef,
        defaultValue: value,
        "data-testid": "codemirror-editor",
        "data-extension-count": String(extensions?.length || 0),
      });
    },
  };
});

describe("TextEditorSurface", () => {
  it("keeps wrapped content and line numbers clear of the editor edges", () => {
    const baseThemeCalls = editorThemeCalls.filter(
      ({ spec }) => ".cm-content.cm-lineWrapping" in spec,
    );

    expect(baseThemeCalls).toHaveLength(2);
    expect(baseThemeCalls.map(({ options }) => options?.dark)).toEqual([false, true]);
    for (const { spec } of baseThemeCalls) {
      expect(spec[".cm-content.cm-lineWrapping"]).toEqual({
        paddingRight: "2ch",
      });
      expect(spec[".cm-lineNumbers .cm-gutterElement"]).toEqual({
        padding: "0 1ch 0 2ch",
        userSelect: "none",
      });
    }
  });

  it("loads a syntax language extension for JSON files", async () => {
    render(
      <TextEditorSurface
        ariaLabel="package.json editor"
        darkMode
        path="package.json"
        plainText={false}
        readOnly
        searchHighlightQuery=""
        testId="text-editor"
        value={'{"name":"piwork"}'}
        onChange={vi.fn()}
      />,
    );

    const editor = await screen.findByTestId("text-editor");
    expect(editor).toHaveAttribute("data-language-mode", "language");
    expect(screen.getByTestId("codemirror-editor")).toHaveAttribute("data-extension-count", "5");
  });

  it("keeps explicit plaintext previews free of language and highlight extensions", () => {
    render(
      <TextEditorSurface
        ariaLabel="large file editor"
        darkMode
        path="large.ts"
        plainText
        readOnly
        searchHighlightQuery=""
        testId="text-editor"
        value="const large = true;"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("text-editor")).toHaveAttribute("data-language-mode", "plaintext");
    expect(screen.getByTestId("codemirror-editor")).toHaveAttribute("data-extension-count", "3");
  });

  it("keeps the editor instance mounted when only its directory path changes", async () => {
    const props = {
      ariaLabel: "app.ts editor",
      darkMode: true,
      plainText: false,
      readOnly: false,
      searchHighlightQuery: "",
      testId: "text-editor",
      value: "const answer = 42;",
      onChange: vi.fn(),
    } as const;
    const view = render(<TextEditorSurface {...props} path="src/app.ts" />);

    const editor = await screen.findByTestId("codemirror-editor");
    editor.dataset.selectionHead = "9";
    editor.scrollTop = 128;

    view.rerender(<TextEditorSurface {...props} path="archive/src/app.ts" />);

    expect(await screen.findByTestId("codemirror-editor")).toBe(editor);
    expect(editor).toHaveAttribute("data-selection-head", "9");
    expect(editor.scrollTop).toBe(128);
  });

  it("focuses the editor at the document start when editing begins without a prior selection", async () => {
    const props = {
      ariaLabel: "notes.txt editor",
      darkMode: false,
      path: "notes.txt",
      plainText: true,
      searchHighlightQuery: "",
      testId: "text-editor",
      value: "Start writing here",
      onChange: vi.fn(),
    } as const;
    const view = render(<TextEditorSurface {...props} readOnly />);
    const editor = screen.getByTestId("codemirror-editor");

    expect(editor).not.toHaveFocus();
    view.rerender(<TextEditorSurface {...props} readOnly={false} />);

    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor).toHaveProperty("selectionStart", 0);
    expect(editor).toHaveProperty("selectionEnd", 0);
  });

  it("preserves the previous selection when editing resumes", async () => {
    const props = {
      ariaLabel: "notes.txt editor",
      darkMode: false,
      path: "notes.txt",
      plainText: true,
      searchHighlightQuery: "",
      testId: "text-editor",
      value: "Start writing here",
      onChange: vi.fn(),
    } as const;
    const view = render(<TextEditorSurface {...props} readOnly />);
    const editor = screen.getByTestId("codemirror-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(6, 13);

    view.rerender(<TextEditorSurface {...props} readOnly={false} />);

    await waitFor(() => expect(editor).toHaveFocus());
    expect(editor.selectionStart).toBe(6);
    expect(editor.selectionEnd).toBe(13);
  });
});
