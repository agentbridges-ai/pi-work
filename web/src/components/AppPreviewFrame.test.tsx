// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AppPreviewFrame, isIndependentAppUrl } from "./AppPreviewFrame.js";
import { uiCopy } from "../ui-copy.js";

describe("AppPreviewFrame", () => {
  it("allows an independent Cloudflare HTTPS origin without granting top-level navigation", () => {
    const url = "https://demo.example.workers.dev";
    expect(isIndependentAppUrl(url, "http://localhost:3458")).toBe(true);
    render(<AppPreviewFrame appName="Demo" url={url} />);

    const frame = screen.getByTitle(uiCopy.apps.previewTitle("Demo"));
    expect(frame).toHaveAttribute("src", url);
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(screen.getByRole("status")).toHaveTextContent(uiCopy.apps.previewLoading);
    fireEvent.load(frame);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("fails closed for same-origin, local HTTP, and malformed preview URLs", () => {
    expect(isIndependentAppUrl("http://localhost:3458/apps/demo", "http://localhost:3458")).toBe(
      false,
    );
    expect(isIndependentAppUrl("http://demo.localhost:8790", "http://localhost:3458")).toBe(false);
    expect(isIndependentAppUrl("not-a-url", "http://localhost:3458")).toBe(false);
    render(<AppPreviewFrame appName="Demo" url="/apps/demo" />);
    expect(screen.getByRole("alert")).toHaveTextContent(uiCopy.apps.previewUnsafe);
    expect(screen.queryByTitle(uiCopy.apps.previewTitle("Demo"))).not.toBeInTheDocument();
  });
});
