// @vitest-environment jsdom
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { setUiCopyLanguage } from "../ui-copy.js";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("../analytics.js", () => ({
  captureException: captureExceptionMock,
}));

function Crasher(): ReactElement {
  throw new Error("render failed");
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    setUiCopyLanguage("zh-CN");
  });

  it("shows localized Chinese fallback UI and reports exceptions", () => {
    // Validates React render-time crashes are both user-visible and passed to the local no-op reporter.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Crasher />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "发生运行时错误" })).toBeTruthy();
    expect(screen.getByText("请重新加载页面以恢复。错误已上报。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
    expect(captureExceptionMock).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("shows English fallback UI when English is active", () => {
    setUiCopyLanguage("en-US");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Crasher />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "A runtime error occurred" })).toBeTruthy();
    expect(
      screen.getByText("Reload the page to recover. The error has been reported."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    consoleErrorSpy.mockRestore();
  });
});
