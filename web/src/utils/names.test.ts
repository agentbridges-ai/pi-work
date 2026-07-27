import { DEFAULT_SESSION_NAME, isPlaceholderSessionName } from "./names.js";

describe("isPlaceholderSessionName", () => {
  it("treats only empty names as placeholders", () => {
    expect(isPlaceholderSessionName(undefined)).toBe(true);
    expect(isPlaceholderSessionName("")).toBe(true);
    expect(isPlaceholderSessionName("  ")).toBe(true);
  });

  it("does not treat concrete names as placeholders", () => {
    expect(isPlaceholderSessionName(DEFAULT_SESSION_NAME)).toBe(false);
    expect(isPlaceholderSessionName("未命名")).toBe(false);
    expect(isPlaceholderSessionName("ITAgent")).toBe(false);
    expect(isPlaceholderSessionName("Firm Tide")).toBe(false);
    expect(isPlaceholderSessionName("月度报销审核")).toBe(false);
  });
});
