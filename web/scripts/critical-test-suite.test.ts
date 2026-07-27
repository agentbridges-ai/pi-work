import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseCriticalTestPaths,
  runCriticalTestSuite,
  runCriticalTestSuiteCli,
  type CriticalTestSuiteDependencies,
} from "./critical-test-suite.js";

function dependencies(manifest: string, files: string[]): CriticalTestSuiteDependencies {
  return {
    cwd: "/project/web",
    read: vi.fn(() => manifest),
    isFile: vi.fn((path) => files.includes(path)),
    execute: vi.fn(() => 0),
  };
}

describe("critical test suite", () => {
  it("parses comments and blank lines without changing path boundaries", () => {
    expect(parseCriticalTestPaths("# security\n\n server/auth.test.ts \n")).toEqual([
      "server/auth.test.ts",
    ]);
  });

  it("validates every configured test before launching Vitest", () => {
    const deps = dependencies("server/a.test.ts\nserver/b.test.ts\n", [
      "/project/web/server/a.test.ts",
      "/project/web/server/b.test.ts",
    ]);
    expect(runCriticalTestSuite("scripts/critical-tests.txt", deps)).toBe(0);
    expect(deps.execute).toHaveBeenCalledWith(process.execPath, [
      "run",
      "vitest",
      "run",
      "server/a.test.ts",
      "server/b.test.ts",
    ]);
  });

  it("fails closed for empty, missing, absolute, and traversal entries", () => {
    expect(() =>
      runCriticalTestSuite("scripts/critical-tests.txt", dependencies("# empty\n", [])),
    ).toThrow("No critical tests configured");
    expect(() =>
      runCriticalTestSuite(
        "scripts/critical-tests.txt",
        dependencies("server/missing.test.ts\n", []),
      ),
    ).toThrow(/missing or outside/);
    expect(() =>
      runCriticalTestSuite(
        "scripts/critical-tests.txt",
        dependencies("/tmp/foreign.test.ts\n", ["/tmp/foreign.test.ts"]),
      ),
    ).toThrow(/missing or outside/);
    expect(() =>
      runCriticalTestSuite(
        "scripts/critical-tests.txt",
        dependencies("../foreign.test.ts\n", ["/project/foreign.test.ts"]),
      ),
    ).toThrow(/missing or outside/);
  });

  it("propagates a failed or signalled Vitest execution", () => {
    const deps = dependencies("server/a.test.ts\n", ["/project/web/server/a.test.ts"]);
    deps.execute = vi.fn(() => null);
    expect(runCriticalTestSuite("scripts/critical-tests.txt", deps)).toBe(1);
    deps.execute = vi.fn(() => 3);
    expect(runCriticalTestSuite("scripts/critical-tests.txt", deps)).toBe(3);
  });

  it("rejects an absolute manifest path", () => {
    expect(() =>
      runCriticalTestSuite("/tmp/critical-tests.txt", dependencies("server/a.test.ts\n", [])),
    ).toThrow(/project-relative/);
  });

  it("uses the real filesystem and fails closed when dependencies are omitted", () => {
    const projectRoot = process.cwd();
    const fixtureRoot = mkdtempSync(join(projectRoot, "scripts/.critical-suite-"));
    const manifestPath = join(fixtureRoot, "critical-tests.txt");
    try {
      writeFileSync(manifestPath, "scripts/missing.test.ts\n");
      expect(() => runCriticalTestSuite(relative(projectRoot, manifestPath))).toThrow(
        /missing or outside/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns stable CLI exit codes without bypassing suite validation", () => {
    const reportError = vi.fn();
    expect(runCriticalTestSuiteCli([], undefined, reportError)).toBe(2);
    expect(reportError).toHaveBeenCalledWith("Usage: critical-test-suite.ts <manifest>");

    const deps = dependencies("server/a.test.ts\n", ["/project/web/server/a.test.ts"]);
    expect(runCriticalTestSuiteCli(["scripts/critical-tests.txt"], deps, reportError)).toBe(0);
  });
});
