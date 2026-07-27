import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CriticalTestSuiteDependencies {
  cwd: string;
  read(path: string): string;
  isFile(path: string): boolean;
  execute(command: string, args: string[]): number | null;
}

export function parseCriticalTestPaths(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function runCriticalTestSuite(
  manifestArgument: string,
  dependencies: CriticalTestSuiteDependencies = {
    cwd: process.cwd(),
    read: (path) => readFileSync(path, "utf8"),
    isFile: isRegularFile,
    execute: (command, args) => spawnSync(command, args, { stdio: "inherit" }).status,
  },
): number {
  const manifestPath = resolve(dependencies.cwd, manifestArgument);
  if (isAbsolute(manifestArgument) || !isInside(dependencies.cwd, manifestPath)) {
    throw new Error("Critical test manifest must be a project-relative path");
  }
  const tests = parseCriticalTestPaths(dependencies.read(manifestPath));
  if (!tests.length) throw new Error("No critical tests configured");
  for (const test of tests) {
    const testPath = resolve(dependencies.cwd, test);
    if (
      isAbsolute(test) ||
      !isInside(dependencies.cwd, testPath) ||
      !dependencies.isFile(testPath)
    ) {
      throw new Error(`Critical test is missing or outside the project: ${test}`);
    }
  }
  return dependencies.execute(process.execPath, ["run", "vitest", "run", ...tests]) ?? 1;
}

export function runCriticalTestSuiteCli(
  args = process.argv.slice(2),
  dependencies?: CriticalTestSuiteDependencies,
  reportError: (message: string) => void = console.error,
): number {
  try {
    const manifest = args[0];
    if (!manifest) throw new Error("Usage: critical-test-suite.ts <manifest>");
    return runCriticalTestSuite(manifest, dependencies);
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = runCriticalTestSuiteCli();
}
