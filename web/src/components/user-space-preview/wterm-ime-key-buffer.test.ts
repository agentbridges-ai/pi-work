import { afterEach, describe, expect, it, vi } from "vitest";
import { WtermImeKeyBuffer } from "./wterm-ime-key-buffer.js";

function key(overrides: Partial<Parameters<WtermImeKeyBuffer["deferIfPrintable"]>[0]> = {}) {
  return {
    key: "n",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe("WtermImeKeyBuffer", () => {
  afterEach(() => vi.useRealTimers());

  it("discards the provisional first letter when IME composition starts", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const buffer = new WtermImeKeyBuffer(emit);

    expect(buffer.deferIfPrintable(key())).toBe(true);
    buffer.compositionStarted();
    vi.runAllTimers();

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits ordinary printable input after the composition detection window", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const buffer = new WtermImeKeyBuffer(emit);

    expect(buffer.deferIfPrintable(key({ key: "a" }))).toBe(true);
    vi.runAllTimers();

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("a");
  });

  it("leaves control, option, navigation, and active-composition keys to Wterm", () => {
    const buffer = new WtermImeKeyBuffer(vi.fn());

    expect(buffer.deferIfPrintable(key({ ctrlKey: true }))).toBe(false);
    expect(buffer.deferIfPrintable(key({ altKey: true }))).toBe(false);
    expect(buffer.deferIfPrintable(key({ metaKey: true }))).toBe(false);
    expect(buffer.deferIfPrintable(key({ key: "Enter" }))).toBe(false);
    expect(buffer.deferIfPrintable(key({ isComposing: true }))).toBe(false);
  });
});
