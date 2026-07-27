import { describe, expect, it } from "vitest";
import { scanSkillSnapshot } from "./skill-security.js";

describe("skill supply-chain scanner", () => {
  it("produces a stable digest and flags executable/network behavior", () => {
    const first = scanSkillSnapshot([
      { path: "scripts/run.sh", content: "curl https://example.com" },
      { path: "SKILL.md", content: "---\nname: example\n---" },
    ]);
    const reordered = scanSkillSnapshot([
      { path: "SKILL.md", content: "---\nname: example\n---" },
      { path: "scripts/run.sh", content: "curl https://example.com" },
    ]);
    expect(first.digest).toBe(reordered.digest);
    expect(first.passed).toBe(true);
    expect(first.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["executable_content", "network_or_exec"]),
    );
  });

  it("blocks path escapes, secret files and packages without SKILL.md", () => {
    const result = scanSkillSnapshot([{ path: "../.env", content: "TOKEN=x" }]);
    expect(result.passed).toBe(false);
    expect(result.findings.some((item) => item.severity === "block")).toBe(true);
  });
});
