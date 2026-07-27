// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ChatMessage } from "../types.js";
import type { FeedDisplayItem } from "./chat-work-groups.js";
import { uiCopy } from "../ui-copy.js";
import { createActiveTocStore, deriveMessageTocItems, MessageToc } from "./MessageToc.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function messageEntry(message: ChatMessage): FeedDisplayItem {
  return { kind: "message", msg: message };
}

describe("deriveMessageTocItems", () => {
  it("creates one toc item per user message and pairs the latest assistant reply", () => {
    const entries = [
      messageEntry(makeMessage({ id: "u1", role: "user", content: "  请分析\n这个项目  " })),
      messageEntry(makeMessage({ id: "a1", role: "assistant", content: "先检查文件" })),
      messageEntry(makeMessage({ id: "a2", role: "assistant", content: "最终结论" })),
      messageEntry(
        makeMessage({
          id: "u2",
          role: "user",
          content: "",
          images: [{ mediaType: "image/png", data: "abc" }],
        }),
      ),
    ];

    expect(deriveMessageTocItems(entries)).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "请分析 这个项目",
        responsePreview: "最终结论",
        imageCount: 0,
      },
      {
        id: "u2",
        ordinal: 2,
        preview: uiCopy.messageToc.imageMessage,
        responsePreview: "",
        imageCount: 1,
      },
    ]);
  });

  it("caps very long previews", () => {
    const longText = "x".repeat(320);
    const [item] = deriveMessageTocItems([
      messageEntry(makeMessage({ id: "u1", role: "user", content: longText })),
    ]);

    expect(item?.preview).toHaveLength(281);
    expect(item?.preview.endsWith("…")).toBe(true);
  });

  it("derives previews from native Pi text and thinking parts", () => {
    const [item] = deriveMessageTocItems([
      messageEntry(
        makeMessage({
          id: "u-parts",
          role: "user",
          contentParts: [
            { type: "thinking", thinking: "先想一想" },
            { type: "text", text: "再回答" },
          ],
        }),
      ),
      messageEntry(
        makeMessage({
          id: "a-parts",
          role: "assistant",
          contentParts: [{ type: "text", text: "Pi 原生回复" }],
        }),
      ),
    ]);

    expect(item).toMatchObject({
      id: "u-parts",
      preview: "先想一想 再回答",
      responsePreview: "Pi 原生回复",
    });
  });
});

describe("MessageToc", () => {
  const items = [
    { id: "u1", ordinal: 1, preview: "第一条", responsePreview: "回复一", imageCount: 0 },
    { id: "u2", ordinal: 2, preview: "第二条", responsePreview: "", imageCount: 1 },
  ];

  it("renders toc ticks and selects a message", async () => {
    const onSelect = vi.fn();
    const activeStore = createActiveTocStore();
    activeStore.set({ currentId: "u2", visibleIds: ["u1", "u2"] });

    render(<MessageToc items={items} activeStore={activeStore} onSelect={onSelect} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });
    expect(screen.getByTestId("message-toc")).toHaveStyle({ left: "24px" });
    expect(screen.getByRole("navigation", { name: uiCopy.messageToc.label })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(1, items[0]!.preview) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) }),
    ).toHaveAttribute("aria-current", "location");

    fireEvent.click(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(1, items[0]!.preview) }),
    );

    expect(onSelect).toHaveBeenCalledWith("u1");

    fireEvent.click(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) }),
    );

    expect(onSelect).toHaveBeenLastCalledWith("u2");
  });

  it("keeps right-side ticks anchored when expanding the rail for full magnification", async () => {
    const activeStore = createActiveTocStore();

    render(
      <MessageToc
        items={items}
        activeStore={activeStore}
        onSelect={vi.fn()}
        railLeftPx={42}
        railWidthPx={24}
        side="right"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });
    expect(screen.getByTestId("message-toc")).toHaveStyle({ left: "32px", width: "34px" });
    expect(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(1, items[0]!.preview) }),
    ).toHaveStyle({ right: "2px" });
  });

  it("uses the Synara magnified width even when the right rail is narrow", async () => {
    const activeStore = createActiveTocStore();

    render(
      <MessageToc
        items={items}
        activeStore={activeStore}
        onSelect={vi.fn()}
        railLeftPx={250}
        railWidthPx={16}
        side="right"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });

    fireEvent.focus(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) })
          .style.width,
      ).toBe("30px");
    });
  });

  it("stays visible in a narrow message pane", async () => {
    const activeStore = createActiveTocStore();

    render(
      <div style={{ width: 280 }}>
        <MessageToc
          items={items}
          activeStore={activeStore}
          onSelect={vi.fn()}
          railLeftPx={250}
          railWidthPx={16}
          side="right"
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });
  });

  it("shows the preview tooltip from the non-scrolling rail layer on hover", async () => {
    const activeStore = createActiveTocStore();
    activeStore.set({ currentId: "u1", visibleIds: ["u1"] });

    render(<MessageToc items={items} activeStore={activeStore} onSelect={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });

    const viewport = screen.getByTestId("message-toc-viewport");
    const tooltip = screen.getByTestId("message-toc-tooltip");
    Object.defineProperty(viewport, "clientHeight", { value: 200, configurable: true });
    viewport.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 56,
      bottom: 200,
      width: 56,
      height: 200,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(viewport, { pointerType: "mouse", clientY: 12 });

    await waitFor(() => {
      expect(tooltip.style.visibility).toBe("visible");
      expect(tooltip.textContent).toContain("第一条");
      expect(tooltip.textContent).toContain("回复一");
    });
  });

  it("only highlights the focused tick while interacting", async () => {
    const activeStore = createActiveTocStore();
    activeStore.set({ currentId: "u1", visibleIds: ["u1", "u2"] });

    render(<MessageToc items={items} activeStore={activeStore} onSelect={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });

    fireEvent.focus(
      screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(1, items[0]!.preview) })
          .style.opacity,
      ).toBe("0.2");
      expect(
        screen.getByRole("button", { name: uiCopy.messageToc.jumpToMessage(2, items[1]!.preview) })
          .style.opacity,
      ).toBe("1");
    });
  });

  it("stays hidden when there is only one item", async () => {
    const activeStore = createActiveTocStore();
    const { rerender } = render(
      <MessageToc items={[items[0]!]} activeStore={activeStore} onSelect={vi.fn()} />,
    );

    expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "true");

    rerender(<MessageToc items={items} activeStore={activeStore} onSelect={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("message-toc")).toHaveAttribute("aria-hidden", "false");
    });
  });
});
