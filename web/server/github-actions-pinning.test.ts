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

  it("keeps the CI lanes deduplicated and Pages deployment governed", () => {
    const verify = readFileSync(resolve(root, ".github/workflows/verify.yml"), "utf8");
    const deepVerify = readFileSync(resolve(root, ".github/workflows/deep-verify.yml"), "utf8");
    const srt = readFileSync(resolve(root, ".github/workflows/srt-linux.yml"), "utf8");
    const deploy = readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8");
    const toolchain = readFileSync(
      resolve(root, ".github/actions/setup-toolchain/action.yml"),
      "utf8",
    );
    const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
    const landingLock = readFileSync(resolve(root, "landing-page/bun.lock"), "utf8");

    expect(verify).not.toMatch(/test-targeted test-pi-rpc-contract/);
    expect(srt).toContain("test-pi-rpc-contract test-srt-isolation test-srt-pi");
    expect(deepVerify).toContain("VERIFY_SRT=${{ needs.changes.outputs.srt");
    expect(deepVerify).toContain("ONLYOFFICE_RELEASE_VERIFY_ARGS=--online");
    expect(deepVerify).not.toContain("Verify published OnlyOffice release descriptor");
    expect(makefile).toContain("VERIFY_SRT ?= 1");
    expect(makefile).toContain("$(VERIFY_SRT_TARGETS)");
    expect(toolchain).toContain("path: ~/.bun/install/cache");
    expect(toolchain).toContain(
      "hashFiles('mise.toml', 'mise.lock', 'web/bun.lock', 'landing-page/bun.lock')",
    );
    expect(verify).toContain("path: ~/.cache/ms-playwright");
    expect(deploy).toContain("bun install --frozen-lockfile --backend copyfile --linker isolated");
    expect(deploy).toContain("bunx --no-install wrangler pages deploy");
    expect(deploy).toContain("Production Pages deployments must run from refs/heads/main.");
    expect(deploy).toContain("DEPLOY_URL");
    expect(landingLock).toContain('"wrangler": "4.118.0"');
  });
});
