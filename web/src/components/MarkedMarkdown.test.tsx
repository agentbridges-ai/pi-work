// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { MarkedMarkdown } from "./MarkedMarkdown.js";

describe("MarkedMarkdown", () => {
  it("renders raw HTML and unsafe resource URLs as inert text", () => {
    const { container } = render(
      <MarkedMarkdown
        text={
          '<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert(1))\n\n![bad](javascript:alert(1))'
        }
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain('<img src="x" onerror');
    expect(container.textContent).toContain("unsafe");
    expect(container.textContent).toContain("bad");
  });

  it("keeps safe links isolated and resolves local preview images", () => {
    const resolveImageSrc = vi.fn(() => "blob:https://piwork.test/image");
    const { container } = render(
      <MarkedMarkdown
        text={"[docs](https://example.com)\n\n![diagram](images/a.png)"}
        resolveImageSrc={resolveImageSrc}
      />,
    );

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:https://piwork.test/image",
    );
    expect(resolveImageSrc).toHaveBeenCalledWith("images/a.png");
  });
});
