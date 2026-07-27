import { describe, expect, it } from "vitest";
import { releaseReaderLockBestEffort } from "./web-stream-compat.js";

describe("releaseReaderLockBestEffort", () => {
  it("preserves the reader receiver for callable hooks without Function.prototype", () => {
    const reader: { releaseLock?: () => void } = {};
    const releaseLock = Object.setPrototypeOf(function (this: unknown) {
      expect(this).toBe(reader);
    }, null) as () => void;
    reader.releaseLock = releaseLock;

    expect(() => releaseReaderLockBestEffort(reader)).not.toThrow();
  });

  it("accepts a missing release hook", () => {
    expect(() => releaseReaderLockBestEffort({})).not.toThrow();
  });

  it("does not replace the completed read when release throws", () => {
    expect(() =>
      releaseReaderLockBestEffort({
        releaseLock() {
          throw new TypeError("Runtime lock release failed");
        },
      }),
    ).not.toThrow();
  });
});
