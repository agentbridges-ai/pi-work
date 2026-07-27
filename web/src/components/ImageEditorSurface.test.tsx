// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageEditorSurface, type ImageEditorLabels } from "./ImageEditorSurface.js";

vi.mock("react-konva", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const component = (name: string) =>
    React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement> & {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }
    >((props, ref) => (
      <div
        ref={ref}
        data-konva-component={name}
        data-konva-x={props.x}
        data-konva-y={props.y}
        data-konva-width={props.width}
        data-konva-height={props.height}
      >
        {props.children}
      </div>
    ));
  const Stage = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => (
      <div ref={ref} data-konva-component="Stage">
        {props.children}
      </div>
    ),
  );
  return {
    Arrow: component("Arrow"),
    Ellipse: component("Ellipse"),
    Group: component("Group"),
    Image: component("Image"),
    Layer: component("Layer"),
    Line: component("Line"),
    Rect: component("Rect"),
    Stage,
    Text: component("Text"),
  };
});

vi.mock("react-konva-utils", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return { Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const labels: ImageEditorLabels = {
  toolbar: "图片编辑工具栏",
  select: "选择",
  crop: "裁剪",
  pen: "画笔",
  arrow: "箭头",
  rectangle: "矩形",
  ellipse: "椭圆",
  text: "文字",
  undo: "撤销",
  redo: "重做",
  color: "颜色",
  customColor: "自定义颜色",
  strokeWidth: "线条粗细",
  applyCrop: "应用裁剪",
  textPlaceholder: "输入文字",
  loading: "正在加载图片编辑器",
  loadFailed: "图片编辑器加载失败",
};

describe("ImageEditorSurface", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("provides the localized screenshot annotation tools", () => {
    const onDirtyChange = vi.fn();
    render(
      <ImageEditorSurface
        source="blob:http://localhost/photo"
        fileName="photo.png"
        mimeType="image/png"
        labels={labels}
        onDirtyChange={onDirtyChange}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "图片编辑工具栏" });
    expect(toolbar).toBeInTheDocument();
    expect(
      Array.from(toolbar.querySelectorAll("button"))
        .slice(0, 2)
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["撤销", "重做"]);
    expect(screen.getByRole("button", { name: "箭头" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "裁剪" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "画笔" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "矩形" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "椭圆" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文字" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "画笔" })).toHaveClass(
      "text-[var(--piwork-editor-foreground)]",
    );
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    const colorButton = screen.getByRole("button", { name: "颜色" });
    expect(colorButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(colorButton);
    expect(screen.getByRole("dialog", { name: "颜色" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^颜色 #/ })).toHaveLength(6);
    expect(screen.getByLabelText("自定义颜色")).toHaveAttribute("type", "color");
    fireEvent.click(screen.getByRole("button", { name: "颜色 #3b82f6" }));
    expect(screen.queryByRole("dialog", { name: "颜色" })).not.toBeInTheDocument();

    const strokeSlider = screen.getByRole("slider", { name: "线条粗细" });
    expect(strokeSlider).toHaveAttribute("min", "1");
    expect(strokeSlider).toHaveAttribute("max", "24");
    fireEvent.change(strokeSlider, { target: { value: "12" } });
    expect(screen.getByText("12px")).toHaveClass("text-[var(--piwork-editor-foreground)]");

    fireEvent.click(screen.getByRole("button", { name: "画笔" }));
    expect(screen.getByRole("button", { name: "画笔" })).toHaveAttribute("aria-pressed", "true");
    expect(onDirtyChange).toHaveBeenCalledWith(false);
  });

  it("renders its scrollable toolbar into the preview title bar slot", async () => {
    render(
      <>
        <div id="image-title-toolbar" data-testid="image-title-toolbar" />
        <ImageEditorSurface
          source="blob:http://localhost/photo"
          fileName="photo.png"
          mimeType="image/png"
          labels={labels}
          onDirtyChange={vi.fn()}
          toolbarPortalId="image-title-toolbar"
        />
      </>,
    );

    const slot = screen.getByTestId("image-title-toolbar");
    const toolbar = await within(slot).findByRole("toolbar", { name: "图片编辑工具栏" });
    expect(toolbar).toHaveClass("piwork-scrollbar-hidden", "overflow-x-auto");
    expect(within(screen.getByTestId("image-editor-surface")).queryByRole("toolbar")).toBeNull();
    expect(screen.getByTestId("image-editor-canvas")).toHaveClass("bg-background");
    expect(screen.getByTestId("image-editor-canvas")).not.toHaveClass("bg-muted/25");
    expect(screen.getByTestId("image-preview-zoom-controls-photo.png")).toBeInTheDocument();
    expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%");

    fireEvent.click(
      screen
        .getByTestId("image-preview-zoom-controls-photo.png")
        .querySelector<HTMLElement>("[data-image-preview-action='zoom-in']")!,
    );
    expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("120%");
    fireEvent.click(
      screen
        .getByTestId("image-preview-zoom-controls-photo.png")
        .querySelector<HTMLElement>("[data-image-preview-action='reset']")!,
    );
    expect(screen.getByTestId("image-preview-scale-photo.png")).toHaveTextContent("100%");
  });

  it("restores an undone annotation when redo is clicked", () => {
    let loadedImage: { onload: ((event: Event) => void) | null } | null = null;
    class MockImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) {}
      constructor() {
        loadedImage = this;
      }
    }
    vi.stubGlobal("Image", MockImage);
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);

    const { container } = render(
      <ImageEditorSurface
        source="blob:http://localhost/photo"
        fileName="photo.png"
        mimeType="image/png"
        labels={labels}
        onDirtyChange={vi.fn()}
      />,
    );
    act(() => loadedImage?.onload?.(new Event("load")));
    expect(container.querySelectorAll('[data-konva-component="Rect"]')).toHaveLength(0);

    const interactionLayer = screen.getByTestId("image-editor-interaction-layer");
    fireEvent.pointerDown(interactionLayer, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(interactionLayer, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
    expect(container.querySelectorAll('[data-konva-component="Arrow"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(container.querySelectorAll('[data-konva-component="Arrow"]')).toHaveLength(0);
    expect(screen.getByRole("button", { name: "重做" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    expect(container.querySelectorAll('[data-konva-component="Arrow"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
  });

  it("keeps a crop selection fixed after the pointer is released", () => {
    let loadedImage: { onload: ((event: Event) => void) | null } | null = null;
    class MockImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) {}
      constructor() {
        loadedImage = this;
      }
    }
    vi.stubGlobal("Image", MockImage);
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);

    const { container } = render(
      <ImageEditorSurface
        source="blob:http://localhost/photo"
        fileName="photo.png"
        mimeType="image/png"
        labels={labels}
        onDirtyChange={vi.fn()}
      />,
    );
    act(() => loadedImage?.onload?.(new Event("load")));

    fireEvent.click(screen.getByRole("button", { name: "裁剪" }));
    const interactionLayer = screen.getByTestId("image-editor-interaction-layer");
    fireEvent.pointerDown(interactionLayer, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(interactionLayer, {
      buttons: 1,
      pointerId: 1,
      clientX: 150,
      clientY: 130,
    });
    fireEvent.pointerUp(interactionLayer, { button: 0, pointerId: 1, clientX: 150, clientY: 130 });

    expect(screen.getByRole("button", { name: "应用裁剪" })).toBeEnabled();
    const fixedOutline = Array.from(container.querySelectorAll('[data-konva-component="Rect"]')).at(
      -1,
    );
    expect(fixedOutline).toHaveAttribute("data-konva-width", "50");
    expect(fixedOutline).toHaveAttribute("data-konva-height", "30");

    fireEvent.pointerMove(interactionLayer, {
      buttons: 0,
      pointerId: 1,
      clientX: 190,
      clientY: 170,
    });
    const outlineAfterMove = Array.from(
      container.querySelectorAll('[data-konva-component="Rect"]'),
    ).at(-1);
    expect(outlineAfterMove).toHaveAttribute("data-konva-width", "50");
    expect(outlineAfterMove).toHaveAttribute("data-konva-height", "30");

    fireEvent.click(screen.getByRole("button", { name: "画笔" }));
    expect(screen.queryByRole("button", { name: "应用裁剪" })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-konva-component="Rect"]')).toHaveLength(0);
    expect(screen.getByRole("button", { name: "画笔" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens a native text input on the canvas and commits its text", () => {
    let loadedImage: { onload: ((event: Event) => void) | null } | null = null;
    class MockImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) {}
      constructor() {
        loadedImage = this;
      }
    }
    vi.stubGlobal("Image", MockImage);
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);

    const { container } = render(
      <ImageEditorSurface
        source="blob:http://localhost/photo"
        fileName="photo.png"
        mimeType="image/png"
        labels={labels}
        onDirtyChange={vi.fn()}
      />,
    );
    act(() => loadedImage?.onload?.(new Event("load")));

    fireEvent.click(screen.getByRole("button", { name: "文字" }));
    const interactionLayer = screen.getByTestId("image-editor-interaction-layer");
    fireEvent.click(interactionLayer, { button: 0, clientX: 100, clientY: 100 });
    const input = screen.getByRole("textbox", { name: "输入文字" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "说明文字" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByRole("textbox", { name: "输入文字" })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-konva-component="Text"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();
  });
});
