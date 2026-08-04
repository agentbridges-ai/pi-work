import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { describe, expect, it } from "vitest";

const actionPinning: any = await import("../../scripts/" + "verify-github-actions-pinning.mjs");
const { findMutableExternalActionUses, scanGithubActionPins } = actionPinning;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

describe("GitHub Actions supply-chain pins", () => {
  it("pins every external Action in the repository to a full SHA with a version comment", () => {
    const result = scanGithubActionPins(root);
    expect(result.externalUses).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });

  it("parses every workflow and composite Action as YAML", async () => {
    const files = [
      ...yamlFiles(resolve(root, ".github/actions")),
      ...yamlFiles(resolve(root, ".github/workflows")),
    ];
    for (const path of files) {
      await expect(format(readFileSync(path, "utf8"), { parser: "yaml" })).resolves.toBeTypeOf(
        "string",
      );
    }
  });

  it("rejects mutable tags and undocumented SHAs", () => {
    expect(
      findMutableExternalActionUses([
        { path: "mutable.yml", source: "steps:\n  - uses: actions/checkout@v6\n" },
      ]).failures,
    ).toEqual(["mutable.yml:2: external Action is not pinned to a full SHA"]);
    expect(
      findMutableExternalActionUses([
        { path: "expression.yml", source: "steps:\n  - uses: ${{ matrix.action }}\n" },
      ]).failures,
    ).toEqual(["expression.yml:2: external Action is not pinned to a full SHA"]);
    expect(
      findMutableExternalActionUses([
        {
          path: "undocumented.yml",
          source: `steps:\n  - uses: actions/checkout@${"a".repeat(40)}\n`,
        },
      ]).failures,
    ).toEqual(["undocumented.yml:2: pinned Action is missing an exact version comment"]);
  });
});
