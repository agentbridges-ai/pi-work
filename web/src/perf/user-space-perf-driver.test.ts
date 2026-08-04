// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("user space performance driver", () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

  beforeAll(async () => {
    originalRequestAnimationFrame = window.requestAnimationFrame;
    if (!originalRequestAnimationFrame) {
      Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
          callback(performance.now());
          return 1;
        },
      });
    }
    await import("./user-space-perf-driver.js");
  });

  afterAll(() => {
    if (!originalRequestAnimationFrame) {
      delete (window as Partial<Window>).requestAnimationFrame;
    }
  });

  it("runs the index scenario through commit, abort, query, and clear", async () => {
    const driver = window.__PIWORK_USER_SPACE_PERF__;
    expect(driver).toBeDefined();

    const result = await driver!.run("index", { count: 3 });

    expect(result.scenario).toBe("index");
    expect(result.metrics).toMatchObject({
      count: 3,
      committed: { fileCount: 3, entryCount: 3 },
      pageSize: 1,
      searchMatches: 1,
      abortedVisible: 0,
      afterClear: { fileCount: 0, entryCount: 0, building: false },
    });
  });
});
