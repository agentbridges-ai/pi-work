// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { disposePwaLifecycleForTests } from "../pwa/lifecycle.js";
import type { ClientPlatform, PlatformSupportResult } from "../pwa/platform-support.js";
import { useStore } from "../store.js";
import { PwaPlatformGate } from "./PwaPlatformGate.js";

function support(platform: ClientPlatform): PlatformSupportResult {
  return {
    platform,
    supported: platform === "desktop-chromium",
    pwa: {
      available: true,
      secureContext: true,
      serviceWorker: true,
      issues: [],
    },
  };
}

beforeEach(() => {
  useStore.getState().setUiLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  disposePwaLifecycleForTests();
});

describe("PwaPlatformGate", () => {
  it.each([
    ["safari" as const, "Safari 不受支持"],
    ["firefox" as const, "Firefox 不受支持"],
    ["mobile" as const, "移动设备不受支持"],
    ["other" as const, "当前浏览器不受支持"],
  ])("blocks %s before mounting the application", (platform, heading) => {
    const mounted = vi.fn();
    function ApplicationProbe() {
      useEffect(() => mounted(), []);
      return <div>private workbench</div>;
    }

    render(
      <PwaPlatformGate support={support(platform)}>
        <ApplicationProbe />
      </PwaPlatformGate>,
    );

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText("桌面 Chrome / Edge / Chromium")).toBeInTheDocument();
    expect(screen.queryByText("private workbench")).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
  });

  it("allows desktop Chromium to mount the workbench", () => {
    render(
      <PwaPlatformGate support={support("desktop-chromium")}>
        <div>private workbench</div>
      </PwaPlatformGate>,
    );

    expect(screen.getByText("private workbench")).toBeInTheDocument();
    expect(screen.queryByText("支持范围")).not.toBeInTheDocument();
  });

  it("reads English unsupported-platform copy from the shared catalog", () => {
    useStore.getState().setUiLanguage("en-US");

    render(
      <PwaPlatformGate support={support("safari")}>
        <div>private workbench</div>
      </PwaPlatformGate>,
    );

    expect(screen.getByRole("heading", { name: "Safari isn't supported" })).toBeInTheDocument();
    expect(screen.getByText("Support scope")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("has no axe violations on the unsupported platform page", async () => {
    const { container } = render(
      <PwaPlatformGate support={support("safari")}>
        <div>private workbench</div>
      </PwaPlatformGate>,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
