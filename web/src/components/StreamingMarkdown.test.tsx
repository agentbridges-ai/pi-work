// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { StreamingMarkdown } from "./StreamingMarkdown.js";

describe("StreamingMarkdown", () => {
  it("renders streaming Markdown with the Lobe UI engine", async () => {
    const { container } = render(
      <StreamingMarkdown text={"## Summary\n\n- First item\n- Second item"} isStreaming />,
    );

    await waitFor(
      () =>
        expect(screen.getByTestId("markdown").getAttribute("data-markdown-engine")).toBe("lobe-ui"),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId("markdown").querySelector("h2")?.textContent).toBe("Summary");
    await waitFor(() => expect(container.querySelector("li")?.textContent).toBe("First item"), {
      timeout: 5_000,
    });
  });

  it("adds heading ids for same-document Markdown links", async () => {
    render(<StreamingMarkdown text={"# 标题层级测试\n\n[跳转到标题层级测试](#标题层级测试)"} />);

    await waitFor(() =>
      expect(screen.getByTestId("markdown").querySelector("h1")?.textContent).toBe("标题层级测试"),
    );
    const heading = screen.getByTestId("markdown").querySelector("h1");

    expect(heading?.id).toBe("标题层级测试");
    expect(document.getElementById("标题层级测试")).toBe(heading);
  });

  it("renders Markdown separators with the high-contrast message divider", async () => {
    render(<StreamingMarkdown text={"Before\n\n---\n\nAfter"} />);

    await waitFor(() => expect(screen.getByTestId("markdown").querySelector("hr")).toBeTruthy());

    expect(
      screen
        .getByTestId("markdown")
        .querySelector("hr")
        ?.classList.contains("piwork-markdown-divider"),
    ).toBe(true);
  });

  it("renders fenced session code as a semantic code block", async () => {
    render(<StreamingMarkdown text={'```python\nreturn "你好"\n```'} />);

    await waitFor(() =>
      expect(screen.getByTestId("markdown").querySelector("pre code")?.textContent).toContain(
        'return "你好"',
      ),
    );
  });
});
