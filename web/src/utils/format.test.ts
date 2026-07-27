import { describe, it, expect } from "vitest";
import { formatElapsed, formatResetTime } from "./format.js";

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("formats durations >= 60s as minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(150_000)).toBe("2m 30s");
    expect(formatElapsed(3_600_000)).toBe("60m 0s");
  });
});

describe("formatResetTime", () => {
  it("returns 'now' for past timestamps", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatResetTime(past)).toBe("now");
  });

  it("returns minutes only when under 1 hour", () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+m$/);
  });

  it("returns hours and minutes when under 1 day", () => {
    const future = new Date(Date.now() + 2 * 3_600_000 + 15 * 60_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+h\d+m$/);
  });

  it("returns days, hours, and minutes for multi-day durations", () => {
    const future = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/^\d+d \d+h\d+m$/);
  });

  it("returns 'N/A' for invalid input", () => {
    expect(formatResetTime("not-a-date")).toBe("N/A");
  });
});
