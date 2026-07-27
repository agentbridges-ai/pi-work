import { describe, expect, it } from "vitest";
import {
  deriveDeterministicSessionTitle,
  DeterministicSessionTitleGenerator,
} from "./auto-namer.js";

describe("deriveDeterministicSessionTitle", () => {
  it("creates a concise Chinese title without a model subprocess", () => {
    expect(deriveDeterministicSessionTitle("请帮我修复登录流程，并添加回归测试。")).toBe(
      "修复登录流程，并添加回归测试",
    );
  });

  it("normalizes markdown and English request preambles", () => {
    expect(
      deriveDeterministicSessionTitle(
        "## Please investigate the intermittent websocket reconnect regression in production",
      ),
    ).toBe("investigate the intermittent websocket reconnect regression in…");
  });

  it("uses the first meaningful non-code-fence line and truncates deterministically", () => {
    expect(
      deriveDeterministicSessionTitle(
        "```\nCan you design a deterministic local session title generator with no provider credentials",
      ),
    ).toBe("design a deterministic local session title generator with…");
  });

  it("returns null for blank input", async () => {
    const generator = new DeterministicSessionTitleGenerator();
    await expect(
      generator.generate({
        sessionId: "session-1",
        firstUserMessage: " \n\t",
        sessionDir: "/unused",
      }),
    ).resolves.toBeNull();
  });
});
