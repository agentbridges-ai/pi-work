import { beforeEach, describe, expect, it, vi } from "vitest";

const wsModule = vi.hoisted(() => ({
  connectSession: vi.fn(),
  disconnectAll: vi.fn(),
}));
const userSpaceLifecycle = vi.hoisted(() => ({
  ensureUserSpaceRuntimeLoaded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ws.js", () => wsModule);
vi.mock("./user-space-runtime-lifecycle.js", () => userSpaceLifecycle);

describe("WebSocket runtime lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    wsModule.connectSession.mockClear();
    wsModule.disconnectAll.mockClear();
    userSpaceLifecycle.ensureUserSpaceRuntimeLoaded.mockClear();
  });

  it("loads the session client on demand", async () => {
    const lifecycle = await import("./ws-runtime-lifecycle.js");

    lifecycle.connectSession("session-a");

    await vi.waitFor(() => expect(wsModule.connectSession).toHaveBeenCalledWith("session-a"));
    expect(userSpaceLifecycle.ensureUserSpaceRuntimeLoaded).toHaveBeenCalledTimes(1);
  });

  it("disconnects a loaded client and invalidates older connect requests", async () => {
    const lifecycle = await import("./ws-runtime-lifecycle.js");
    lifecycle.connectSession("warmup");
    await vi.waitFor(() => expect(wsModule.connectSession).toHaveBeenCalledWith("warmup"));
    wsModule.connectSession.mockClear();

    lifecycle.connectSession("session-a");
    lifecycle.disconnectAll();

    expect(wsModule.disconnectAll).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(wsModule.connectSession).not.toHaveBeenCalled();
  });
});
