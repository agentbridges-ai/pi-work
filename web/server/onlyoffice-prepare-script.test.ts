import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("OnlyOffice prepare script", () => {
  it("restores the repo-local development branch instead of the released manifest commit", () => {
    const script = resolve(repoRoot, "scripts/ensure-onlyoffice-browser.sh");
    const result = spawnSync("bash", [script, "--self-test-development-checkout"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("development checkout self-test ready");
  });

  it("detects stale editor host runtime assets when runtime source changes", () => {
    const script = resolve(repoRoot, "scripts/ensure-onlyoffice-browser.sh");
    const result = spawnSync("bash", [script, "--self-test-runtime-assets-stale"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("runtime asset stale self-test ready");
  });

  it("detects host runtime bundles that missed source-level OnlyOffice bridges", () => {
    const script = resolve(repoRoot, "scripts/ensure-onlyoffice-browser.sh");
    const result = spawnSync("bash", [script, "--self-test-runtime-bundle-signature"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("runtime bundle signature self-test ready");
  });

  it("rejects unoptimized OnlyOffice runtime assets", () => {
    const script = resolve(repoRoot, "scripts/ensure-onlyoffice-browser.sh");
    const result = spawnSync("bash", [script, "--self-test-runtime-asset-optimization"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("runtime asset optimization self-test ready");
  });
});
