import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertChangedExternalCoverageEvidence,
  assertExternalCoverageBoundaryBaseline,
  assertExternalCoverageManifestBaseline,
  calculateDiffCoverage,
  EXTERNAL_COVERAGE_POLICY_FILES,
  inferExecutableLines,
  isCoverageEligiblePath,
  meetsCoverageThreshold,
  normalizeLcovSourcePath,
  parseChangedFiles,
  parseChangedLines,
  parseExternalCoverageBoundaries,
  parseExternalCoverageManifest,
  parseLcov,
  runCli,
  validateExternalCoverageRunner,
} from "./check-diff-coverage.js";

describe("diff coverage paths", () => {
  it("normalizes project-relative, repository-relative, and absolute LCOV sources", () => {
    const options = { repoRoot: "/repo", projectRoot: "/repo/web" };
    expect(normalizeLcovSourcePath("server/example.ts", options)).toBe("web/server/example.ts");
    expect(normalizeLcovSourcePath("web/src/example.ts", options)).toBe("web/src/example.ts");
    expect(normalizeLcovSourcePath("/repo/web/shared/example.ts", options)).toBe(
      "web/shared/example.ts",
    );
    expect(() => normalizeLcovSourcePath("/outside/example.ts", options)).toThrow(
      /outside the repository/,
    );
  });

  it("maps executable LCOV lines and merges duplicate records", () => {
    const coverage = parseLcov(
      [
        "SF:server/example.ts",
        "DA:2,0",
        "DA:3,1",
        "end_of_record",
        "SF:server/example.ts",
        "DA:2,2",
        "end_of_record",
      ].join("\n"),
      (path) => `web/${path}`,
    );
    expect([...coverage.get("web/server/example.ts")!.lines]).toEqual([
      [2, 2],
      [3, 1],
    ]);
  });
});

describe("changed executable lines", () => {
  it("collects new-side hunk lines while ignoring deletions", () => {
    const changed = parseChangedLines(
      [
        "diff --git a/web/server/example.ts b/web/server/example.ts",
        "--- a/web/server/example.ts",
        "+++ b/web/server/example.ts",
        "@@ -2,2 +2,3 @@",
        "diff --git a/web/server/deleted.ts b/web/server/deleted.ts",
        "--- a/web/server/deleted.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
      ].join("\n"),
    );
    expect([...changed.get("web/server/example.ts")!]).toEqual([2, 3, 4]);
    expect(changed.has("web/server/deleted.ts")).toBe(false);
  });

  it("excludes comments and type-only lines when a new source is missing from LCOV", () => {
    const source = [
      "// documentation",
      "interface User { id: string }",
      "type UserId = string;",
      "const answer = 42;",
      "export function read() {",
      "  return answer;",
      "}",
    ].join("\n");
    const executable = inferExecutableLines(source, "web/server/new-module.ts");
    expect(executable.has(1)).toBe(false);
    expect(executable.has(2)).toBe(false);
    expect(executable.has(3)).toBe(false);
    expect(executable.has(4)).toBe(true);
    expect(executable.has(5)).toBe(true);
    expect(executable.has(6)).toBe(true);

    const result = calculateDiffCoverage({
      changedFiles: ["web/server/new-module.ts"],
      coverage: new Map(),
      loadSource: () => source,
    });
    expect(result).toMatchObject({ covered: 0, total: 3, percent: 0 });
    expect(result.files[0].uncoveredLines).toEqual([4, 5, 6]);
  });

  it("infers native C executable lines without counting directives or comments", () => {
    const source = [
      "#include <stdio.h>",
      "/* file documentation",
      " * continued documentation",
      " */",
      "int main(void) {",
      '  /* inline documentation */ puts("ready");',
      "  /* trailing documentation",
      "   * continued */ return 0;",
      "}",
      "// footer",
    ].join("\n");

    expect([...inferExecutableLines(source, "web/server/native.c")]).toEqual([5, 6, 8]);
  });

  it("uses every executable line in each diff-selected file", () => {
    const path = "web/server/example.ts";
    const result = calculateDiffCoverage({
      changedFiles: [path],
      coverage: new Map([
        [
          path,
          {
            path,
            lines: new Map([
              [2, 1],
              [3, 0],
              [5, 2],
            ]),
          },
        ],
      ]),
      loadSource: () => {
        throw new Error("covered sources must not be loaded");
      },
    });
    expect(result).toMatchObject({ covered: 2, total: 3 });
    expect(result.files[0].uncoveredLines).toEqual([3]);
  });

  it("fails explicitly when an uncovered changed source cannot be loaded from head", () => {
    expect(() =>
      calculateDiffCoverage({
        changedFiles: ["web/src/missing.ts"],
        coverage: new Map(),
        loadSource: () => undefined,
      }),
    ).toThrow("Changed coverage source is missing at head: web/src/missing.ts");
  });
});

describe("changed file selection", () => {
  it("keeps destination paths even when a changed file has no added hunk lines", () => {
    expect(
      parseChangedFiles("web/server/deletion-only.ts\0web/src/renamed destination.tsx\0"),
    ).toEqual(["web/server/deletion-only.ts", "web/src/renamed destination.tsx"]);
  });

  it("checks changed executable lines for existing files and whole files for additions", () => {
    const existing = "web/server/existing.ts";
    const added = "web/server/added.ts";
    const coverage = new Map([
      [
        existing,
        {
          path: existing,
          lines: new Map([
            [1, 0],
            [2, 1],
            [3, 1],
          ]),
        },
      ],
      [
        added,
        {
          path: added,
          lines: new Map([
            [1, 0],
            [2, 1],
          ]),
        },
      ],
    ]);
    const result = calculateDiffCoverage({
      changedFiles: [existing, added],
      changedLines: new Map([
        [existing, new Set([2])],
        [added, new Set([2])],
      ]),
      wholeFilePaths: new Set([added]),
      coverage,
      loadSource: () => undefined,
    });

    expect(result.files).toEqual([
      { path: added, covered: 1, total: 2, uncoveredLines: [1] },
      { path: existing, covered: 1, total: 1, uncoveredLines: [] },
    ]);
  });
});

describe("external coverage boundaries", () => {
  it("requires a reason and an audited runner for every explicit boundary", () => {
    expect(
      parseExternalCoverageBoundaries(
        JSON.stringify([
          {
            path: "web/server/native.ts",
            reason: "Runs in a separate native process.",
            runner: { kind: "critical-test", test: "web/server/native.test.ts" },
            evidence: ["web/server/native.test.ts"],
          },
        ]),
      ),
    ).toEqual([
      {
        path: "web/server/native.ts",
        reason: "Runs in a separate native process.",
        runner: { kind: "critical-test", test: "web/server/native.test.ts" },
        evidence: ["web/server/native.test.ts"],
      },
    ]);
    expect(() =>
      parseExternalCoverageBoundaries(
        JSON.stringify([
          {
            path: "web/server/native.ts",
            reason: "",
            runner: { kind: "critical-test", test: "web/server/native.test.ts" },
            evidence: ["web/server/native.test.ts"],
          },
        ]),
      ),
    ).toThrow(/requires path, reason, runner, and evidence/);
    expect(() =>
      parseExternalCoverageBoundaries(
        JSON.stringify([
          {
            path: "web/server/native.ts",
            reason: "one",
            runner: { kind: "critical-test", test: "web/server/native.test.ts" },
            evidence: ["web/server/native.test.ts"],
          },
          {
            path: "web/server/native.ts",
            reason: "two",
            runner: { kind: "make-target", target: "test-native" },
            evidence: ["web/server/native.test.ts"],
          },
        ]),
      ),
    ).toThrow(/Duplicate/);
  });

  it("rejects malformed manifests and unsupported runners", () => {
    expect(() => parseExternalCoverageBoundaries("{}")).toThrow(/must be a JSON array/);
    expect(() => parseExternalCoverageBoundaries("[null]")).toThrow(/must be an object/);
    expect(() =>
      parseExternalCoverageBoundaries(
        JSON.stringify([
          {
            path: "web/server/native.ts",
            reason: "Native process.",
            runner: { kind: "shell", command: "test-native" },
            evidence: ["web/server/native.test.ts"],
          },
        ]),
      ),
    ).toThrow(/invalid critical-test or make-target runner/);
  });

  it("requires a versioned and tested policy change before expanding external boundaries", () => {
    const baseline = parseExternalCoverageManifest("[]");
    const boundary = {
      path: "web/scripts/native-smoke.ts",
      reason: "Runs as a real native process.",
      runner: { kind: "make-target" as const, target: "test-native" },
      evidence: [...EXTERNAL_COVERAGE_POLICY_FILES, "Makefile"],
    };
    const current = parseExternalCoverageManifest(
      JSON.stringify({ policyVersion: 2, boundaries: [boundary] }),
    );

    expect(current).toEqual({ policyVersion: 2, boundaries: [boundary] });
    expect(() =>
      assertExternalCoverageManifestBaseline(current, baseline, [
        boundary.path,
        ...boundary.evidence,
      ]),
    ).not.toThrow();
    expect(() =>
      assertExternalCoverageManifestBaseline(current, baseline, [
        boundary.path,
        EXTERNAL_COVERAGE_POLICY_FILES[0],
        "Makefile",
      ]),
    ).toThrow(/gate implementation and tests/);
    expect(() =>
      assertExternalCoverageManifestBaseline(
        {
          policyVersion: 2,
          boundaries: [{ ...boundary, evidence: ["Makefile"] }],
        },
        baseline,
        [boundary.path, ...EXTERNAL_COVERAGE_POLICY_FILES, "Makefile"],
      ),
    ).toThrow(/requires policy evidence/);
    expect(() =>
      assertExternalCoverageManifestBaseline(current, baseline, [...boundary.evidence]),
    ).toThrow(/source path to change/);
    expect(() =>
      assertExternalCoverageManifestBaseline(
        { policyVersion: 3, boundaries: [boundary] },
        baseline,
        [boundary.path, ...boundary.evidence],
      ),
    ).toThrow(/advance exactly once/);
  });

  it("keeps every pre-existing external boundary immutable during an expansion", () => {
    const prior = {
      path: "web/server/native.ts",
      reason: "Native process.",
      runner: { kind: "critical-test" as const, test: "web/server/native.test.ts" },
      evidence: ["web/server/native.test.ts"],
    };
    const added = {
      path: "web/scripts/new-native.ts",
      reason: "New native process.",
      runner: { kind: "make-target" as const, target: "test-native" },
      evidence: [...EXTERNAL_COVERAGE_POLICY_FILES, "Makefile"],
    };
    expect(() =>
      assertExternalCoverageManifestBaseline(
        {
          policyVersion: 2,
          boundaries: [
            {
              ...prior,
              reason: "Redirected exemption.",
            },
            added,
          ],
        },
        { policyVersion: 1, boundaries: [prior] },
        [
          prior.path,
          added.path,
          ...EXTERNAL_COVERAGE_POLICY_FILES,
          "Makefile",
          "web/server/native.test.ts",
        ],
      ),
    ).toThrow(/cannot be redirected/);
    expect(() =>
      assertExternalCoverageManifestBaseline(
        {
          policyVersion: 2,
          boundaries: [
            {
              ...prior,
              evidence: [],
            },
            added,
          ],
        },
        { policyVersion: 1, boundaries: [prior] },
        [prior.path, added.path, ...EXTERNAL_COVERAGE_POLICY_FILES, "Makefile"],
      ),
    ).toThrow(/evidence cannot be removed/);
  });

  it("freezes external exemptions against the base manifest after bootstrap", () => {
    const baseline = parseExternalCoverageBoundaries(
      JSON.stringify([
        {
          path: "web/server/native.ts",
          reason: "Native process.",
          runner: { kind: "critical-test", test: "web/server/native.test.ts" },
          evidence: ["web/server/native.test.ts"],
        },
      ]),
    );
    expect(() => assertExternalCoverageBoundaryBaseline(baseline, undefined)).not.toThrow();
    expect(() => assertExternalCoverageBoundaryBaseline([], baseline)).not.toThrow();
    expect(() =>
      assertExternalCoverageBoundaryBaseline(
        [
          ...baseline,
          {
            path: "web/server/new-native.ts",
            reason: "New exemption.",
            runner: { kind: "make-target", target: "test-native" },
            evidence: ["web/server/new-native.test.ts"],
          },
        ],
        baseline,
      ),
    ).toThrow(/not present unchanged in the base manifest/);
    expect(() =>
      assertExternalCoverageBoundaryBaseline(
        [{ ...baseline[0], reason: "Redirected exemption." }],
        baseline,
      ),
    ).toThrow(/not present unchanged/);
  });

  it("requires critical tests or make targets to be wired into an executed suite", () => {
    const inputs = {
      criticalTests: "server/native.test.ts\n",
      makefile: "verify: test-native\ntest-native:\n\ttrue\ntest-e2e:\n\ttrue\n",
      workflow: "- run: make test-e2e\n",
    };
    expect(() =>
      validateExternalCoverageRunner(
        {
          path: "web/server/native.ts",
          reason: "Native.",
          runner: { kind: "critical-test", test: "web/server/native.test.ts" },
          evidence: ["web/server/native.test.ts"],
        },
        inputs,
      ),
    ).not.toThrow();
    expect(() =>
      validateExternalCoverageRunner(
        {
          path: "web/server/index.ts",
          reason: "E2E.",
          runner: { kind: "make-target", target: "test-e2e" },
          evidence: ["web/e2e/index.spec.ts"],
        },
        inputs,
      ),
    ).not.toThrow();
    expect(() =>
      validateExternalCoverageRunner(
        {
          path: "web/server/missing.ts",
          reason: "Missing.",
          runner: { kind: "critical-test", test: "web/server/missing.test.ts" },
          evidence: ["web/server/missing.test.ts"],
        },
        inputs,
      ),
    ).toThrow(/not in the critical test suite/);
    expect(() =>
      validateExternalCoverageRunner(
        {
          path: "web/scripts/unwired.ts",
          reason: "Unwired.",
          runner: { kind: "make-target", target: "test-unwired" },
          evidence: ["web/scripts/unwired.test.ts"],
        },
        inputs,
      ),
    ).toThrow(/not declared and wired into CI/);
  });

  it("requires changed external boundaries to update all declared evidence", () => {
    const boundary = {
      path: "web/server/index.ts",
      reason: "Runs through E2E.",
      runner: { kind: "make-target" as const, target: "test-e2e" },
      evidence: ["web/playwright.config.ts", "web/e2e/better-auth.spec.ts"],
    };
    expect(() =>
      assertChangedExternalCoverageEvidence([boundary], [boundary.path, ...boundary.evidence]),
    ).not.toThrow();
    expect(() =>
      assertChangedExternalCoverageEvidence([boundary], [boundary.path, boundary.evidence[0]!]),
    ).not.toThrow();
    expect(() => assertChangedExternalCoverageEvidence([boundary], [boundary.path])).toThrow(
      /matching evidence changes/,
    );
    expect(() => assertChangedExternalCoverageEvidence([boundary], [])).not.toThrow();
  });

  it("includes CLI, scripts, Vite config, and native C in the changed-source policy", () => {
    expect(isCoverageEligiblePath("web/bin/user-space.ts")).toBe(true);
    expect(isCoverageEligiblePath("web/scripts/release.ts")).toBe(true);
    expect(isCoverageEligiblePath("web/vite.config.ts")).toBe(true);
    expect(isCoverageEligiblePath("web/server/native.c")).toBe(true);
    expect(isCoverageEligiblePath("web/scripts/release.test.ts")).toBe(false);
    expect(isCoverageEligiblePath("scripts/outside-web.ts")).toBe(false);
  });
});

describe("coverage threshold", () => {
  it("passes the exact 80 percent boundary for every changed file", () => {
    expect(
      meetsCoverageThreshold(
        {
          covered: 4,
          total: 5,
          files: [{ path: "web/src/a.ts", covered: 4, total: 5, uncoveredLines: [5] }],
        },
        80,
      ),
    ).toBe(true);
    expect(
      meetsCoverageThreshold(
        {
          covered: 79,
          total: 100,
          files: [{ path: "web/src/a.ts", covered: 79, total: 100, uncoveredLines: [80] }],
        },
        80,
      ),
    ).toBe(false);
    expect(meetsCoverageThreshold({ covered: 0, total: 0, files: [] }, 80)).toBe(true);
  });

  it("fails when aggregate coverage passes but one changed file is below 80 percent", () => {
    expect(
      meetsCoverageThreshold(
        {
          covered: 8,
          total: 10,
          files: [
            { path: "web/src/weak.ts", covered: 1, total: 2, uncoveredLines: [2] },
            { path: "web/src/strong.ts", covered: 7, total: 8, uncoveredLines: [8] },
          ],
        },
        80,
      ),
    ).toBe(false);
  });
});

describe("coverage CLI", () => {
  it("evaluates the committed merge-result range with repository-owned policy files", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-diff-coverage-"));
    const previousCwd = process.cwd();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.email", "coverage@example.test");
      git("config", "user.name", "Coverage Test");
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      mkdirSync(join(root, "web/coverage"), { recursive: true });
      mkdirSync(join(root, "web/scripts"), { recursive: true });
      mkdirSync(join(root, "web/src"), { recursive: true });
      writeFileSync(join(root, ".github/workflows/verify.yml"), "- run: make test-e2e\n");
      writeFileSync(join(root, "Makefile"), "verify:\n\ttrue\n");
      writeFileSync(join(root, "web/scripts/critical-tests.txt"), "# none\n");
      writeFileSync(join(root, "web/scripts/external-coverage-boundaries.json"), "[]\n");
      writeFileSync(join(root, "web/src/example.ts"), "export const answer = 1;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");

      writeFileSync(join(root, "web/src/example.ts"), "export const answer = 2;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "head");
      const head = git("rev-parse", "HEAD");
      writeFileSync(
        join(root, "web/coverage/lcov.info"),
        "SF:src/example.ts\nDA:1,1\nend_of_record\n",
      );

      process.chdir(root);
      expect(
        runCli([
          "--base",
          base,
          "--head",
          head,
          "--lcov",
          join(root, "web/coverage/lcov.info"),
          "--project-root",
          join(root, "web"),
          "--external-coverage-manifest",
          join(root, "web/scripts/external-coverage-boundaries.json"),
          "--threshold",
          "80",
        ]),
      ).toBe(0);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
