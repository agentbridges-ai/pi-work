// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditorSurface } from "./MarkdownEditorSurface.js";

const { commandCall, crepeConfigs, destroyCrepe, markdownListeners, updateRoot } = vi.hoisted(
  () => ({
    commandCall: vi.fn(),
    crepeConfigs: [] as Array<Record<string, unknown>>,
    destroyCrepe: vi.fn(),
    markdownListeners: [] as Array<(ctx: unknown, markdown: string) => void>,
    updateRoot: vi.fn(),
  }),
);

vi.mock("@milkdown/crepe", () => {
  class MockCrepe {
    private readonly root?: HTMLElement;
    private readonly markdown: string;
    editor = {
      action: (callback: (ctx: { get: () => unknown }) => void) =>
        callback({
          get: () => ({
            call: commandCall,
            updateRoot,
            state: { selection: { from: 0 } },
          }),
        }),
    };

    constructor(config: { root?: HTMLElement; defaultValue?: string }) {
      crepeConfigs.push(config);
      this.root = config.root;
      this.markdown = config.defaultValue || "";
    }

    setReadonly() {
      return this;
    }

    on(
      register: (listener: {
        markdownUpdated: (callback: (ctx: unknown, markdown: string) => void) => void;
      }) => void,
    ) {
      register({
        markdownUpdated: (callback) => markdownListeners.push(callback),
      });
      return this;
    }

    async create() {
      const milkdown = document.createElement("div");
      milkdown.className = "milkdown";
      const editor = document.createElement("div");
      editor.className = "ProseMirror";
      editor.setAttribute("contenteditable", "true");
      const heading = document.createElement("h1");
      heading.textContent = this.markdown.replace(/^#\s*/, "");
      editor.append(heading);
      milkdown.append(editor);
      this.root?.replaceChildren(milkdown);
    }

    async destroy() {
      destroyCrepe();
    }
  }

  return { Crepe: MockCrepe };
});

const toolbarCopy = {
  actions: {
    bold: "加粗",
    italic: "斜体",
    strikethrough: "删除线",
    "bullet-list": "无序列表",
    "ordered-list": "有序列表",
    "task-list": "任务列表",
    table: "表格",
    "code-block": "代码块",
    quote: "引用",
    divider: "分割线",
  },
  headings: ["一级标题", "二级标题", "三级标题", "四级标题", "五级标题", "六级标题"],
  label: "Markdown 编辑工具栏",
  paragraph: "正文",
  stylePicker: "段落样式",
} as const;

describe("MarkdownEditorSurface", () => {
  beforeEach(() => {
    commandCall.mockReset();
    crepeConfigs.length = 0;
    destroyCrepe.mockReset();
    markdownListeners.length = 0;
    updateRoot.mockReset();
  });

  it("keeps slash editing and the custom top bar while disabling the selection toolbar", async () => {
    render(
      <MarkdownEditorSurface
        ariaLabel="Markdown 编辑器 README.md"
        darkMode
        path="README.md"
        readOnly={false}
        testId="markdown-wysiwyg"
        toolbarCopy={toolbarCopy}
        value="# Hello"
        onChange={vi.fn()}
      />,
    );

    const surface = screen.getByTestId("markdown-wysiwyg");
    expect(await within(surface).findByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(surface.querySelector(".milkdown")?.parentElement).toHaveClass(
      "px-5",
      "min-h-full",
      "w-full",
      "flex-1",
    );
    expect(surface.querySelector(".ProseMirror")).toHaveAttribute(
      "aria-label",
      "Markdown 编辑器 README.md",
    );
    expect(surface.querySelector(".cm-editor")).not.toBeInTheDocument();
    await waitFor(() => expect(surface.querySelector(".ProseMirror")).toHaveFocus());
    expect(crepeConfigs.at(-1)?.features).toEqual({
      "top-bar": false,
      "block-edit": true,
      toolbar: false,
    });
    expect(within(surface).getByRole("toolbar", { name: "Markdown 编辑工具栏" })).toBeVisible();
    const stylePicker = within(surface).getByRole("button", { name: /段落样式/ });
    expect(stylePicker).toHaveClass("piwork-markdown-style-picker");
    expect(stylePicker.querySelector(".piwork-markdown-style-picker-indicator")).toHaveClass(
      "piwork-markdown-style-picker-indicator",
    );
  });

  it("forwards rich document edits and toolbar commands to Milkdown", async () => {
    const onChange = vi.fn();
    render(
      <MarkdownEditorSurface
        ariaLabel="Markdown 编辑器 README.md"
        darkMode={false}
        path="README.md"
        readOnly={false}
        testId="markdown-wysiwyg"
        toolbarCopy={toolbarCopy}
        value="# Hello"
        onChange={onChange}
      />,
    );

    const surface = screen.getByTestId("markdown-wysiwyg");
    const editor = await waitFor(() => {
      const element = surface.querySelector<HTMLElement>(".ProseMirror");
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    fireEvent.input(editor);
    markdownListeners[0]?.({}, "# Changed");
    expect(onChange).toHaveBeenCalledWith("# Changed");

    fireEvent.pointerDown(within(surface).getByRole("button", { name: "加粗" }));
    expect(commandCall).toHaveBeenCalledTimes(1);
  });

  it("removes focus in preview mode and restores it automatically in edit mode", async () => {
    const props = {
      ariaLabel: "Markdown 编辑器 README.md",
      darkMode: false,
      path: "README.md",
      testId: "markdown-wysiwyg",
      toolbarCopy,
      value: "# Hello",
      onChange: vi.fn(),
    } as const;
    const view = render(<MarkdownEditorSurface {...props} readOnly={false} />);
    const surface = screen.getByTestId("markdown-wysiwyg");
    const editor = await waitFor(() => {
      const element = surface.querySelector<HTMLElement>(".ProseMirror");
      expect(element).toHaveFocus();
      return element as HTMLElement;
    });

    view.rerender(<MarkdownEditorSurface {...props} readOnly />);
    await waitFor(() => expect(editor).not.toHaveFocus());

    view.rerender(<MarkdownEditorSurface {...props} readOnly={false} />);
    await waitFor(() => expect(editor).toHaveFocus());
  });

  it("keeps the Milkdown instance and viewport stable across a directory-only move", async () => {
    const props = {
      ariaLabel: "Markdown 编辑器 README.md",
      darkMode: false,
      readOnly: false,
      testId: "markdown-wysiwyg",
      toolbarCopy,
      value: "# Hello",
      onChange: vi.fn(),
    } as const;
    const view = render(<MarkdownEditorSurface {...props} path="notes/README.md" />);
    const surface = screen.getByTestId("markdown-wysiwyg");
    const editor = await waitFor(() => {
      const element = surface.querySelector<HTMLElement>(".ProseMirror");
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    surface.scrollTop = 144;
    editor.dataset.selectionHead = "6";

    view.rerender(<MarkdownEditorSurface {...props} path="archive/notes/README.md" />);

    expect(surface.querySelector(".ProseMirror")).toBe(editor);
    expect(editor).toHaveAttribute("data-selection-head", "6");
    expect(surface.scrollTop).toBe(144);
    expect(crepeConfigs).toHaveLength(1);
    expect(destroyCrepe).not.toHaveBeenCalled();
  });

  it("does not recreate the editor for controlled value updates", async () => {
    const props = {
      ariaLabel: "Markdown 编辑器 README.md",
      darkMode: false,
      path: "README.md",
      readOnly: false,
      testId: "markdown-wysiwyg",
      toolbarCopy,
      onChange: vi.fn(),
    } as const;
    const view = render(<MarkdownEditorSurface {...props} value="# Initial" />);
    const surface = screen.getByTestId("markdown-wysiwyg");
    const editor = await waitFor(() => {
      const element = surface.querySelector<HTMLElement>(".ProseMirror");
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });

    view.rerender(<MarkdownEditorSurface {...props} value="# Updated" />);

    expect(surface.querySelector(".ProseMirror")).toBe(editor);
    expect(crepeConfigs).toHaveLength(1);
    expect(destroyCrepe).not.toHaveBeenCalled();
  });
});
