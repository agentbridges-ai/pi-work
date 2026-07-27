import { beforeEach, describe, expect, it, vi } from "vitest";

const userSpaceModule = vi.hoisted(() => ({
  disposeUserSpaceRuntimeState: vi.fn(),
}));

vi.mock("./user-space.js", () => userSpaceModule);

describe("user-space runtime lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    userSpaceModule.disposeUserSpaceRuntimeState.mockClear();
  });

  it("does not load User Space just to dispose an unopened workbench", async () => {
    const lifecycle = await import("./user-space-runtime-lifecycle.js");

    lifecycle.disposeLoadedUserSpaceRuntimeState();

    expect(userSpaceModule.disposeUserSpaceRuntimeState).not.toHaveBeenCalled();
  });

  it("deduplicates route loading and synchronously disposes the loaded runtime", async () => {
    const lifecycle = await import("./user-space-runtime-lifecycle.js");

    await Promise.all([
      lifecycle.ensureUserSpaceRuntimeLoaded(),
      lifecycle.ensureUserSpaceRuntimeLoaded(),
    ]);
    lifecycle.disposeLoadedUserSpaceRuntimeState();

    expect(userSpaceModule.disposeUserSpaceRuntimeState).toHaveBeenCalledTimes(1);
  });
});
