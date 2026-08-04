import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface LineCoverageRecord {
  path: string;
  lines: Map<number, number>;
}

export interface FileDiffCoverage {
  path: string;
  covered: number;
  total: number;
  uncoveredLines: number[];
}

export interface DiffCoverageResult {
  covered: number;
  total: number;
  percent: number;
  files: FileDiffCoverage[];
}

export interface CoveragePathOptions {
  repoRoot: string;
  projectRoot: string;
}

export type ExternalCoverageRunner =
  { kind: "critical-test"; test: string } | { kind: "make-target"; target: string };

export interface ExternalCoverageBoundary {
  path: string;
  reason: string;
  runner: ExternalCoverageRunner;
  /** Files that must change with this boundary so external behavior evidence cannot go stale. */
  evidence: string[];
}

export interface ExternalCoverageManifest {
  policyVersion: number;
  boundaries: ExternalCoverageBoundary[];
}

export const EXTERNAL_COVERAGE_POLICY_FILES = [
  "web/scripts/check-diff-coverage.ts",
  "web/scripts/check-diff-coverage.test.ts",
] as const;

export interface CalculateDiffCoverageOptions {
  /** Every source file selected by the diff, including deletion-only modifications. */
  changedFiles: Iterable<string>;
  /** New-side hunk lines for existing files. Omit to evaluate every executable line. */
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Files whose complete executable surface must meet the threshold (normally additions). */
  wholeFilePaths?: ReadonlySet<string>;
  coverage: Map<string, LineCoverageRecord>;
  loadSource(path: string): string | undefined;
  isEligiblePath?: (path: string) => boolean;
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function insideRepo(path: string): boolean {
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

export function normalizeLcovSourcePath(sourcePath: string, options: CoveragePathOptions): string {
  const decoded = sourcePath.startsWith("file:") ? fileURLToPath(sourcePath) : sourcePath;
  const absolute = isAbsolute(decoded)
    ? resolve(decoded)
    : resolve(decoded.startsWith("web/") ? options.repoRoot : options.projectRoot, decoded);
  const repoRelative = posixPath(relative(options.repoRoot, absolute));
  if (!insideRepo(repoRelative)) {
    throw new Error(`LCOV source is outside the repository: ${sourcePath}`);
  }
  return repoRelative;
}

export function parseLcov(
  input: string,
  normalizeSource: (sourcePath: string) => string,
): Map<string, LineCoverageRecord> {
  const records = new Map<string, LineCoverageRecord>();
  let current: LineCoverageRecord | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    if (rawLine.startsWith("SF:")) {
      const path = normalizeSource(rawLine.slice(3));
      current = records.get(path) || { path, lines: new Map() };
      records.set(path, current);
      continue;
    }
    if (rawLine.startsWith("DA:") && current) {
      const [lineText, hitsText] = rawLine.slice(3).split(",", 3);
      const line = Number(lineText);
      const hits = Number(hitsText);
      if (Number.isSafeInteger(line) && line > 0 && Number.isFinite(hits) && hits >= 0) {
        current.lines.set(line, Math.max(current.lines.get(line) || 0, hits));
      }
      continue;
    }
    if (rawLine === "end_of_record") current = null;
  }
  return records;
}

export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let currentPath: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      currentPath = path === "/dev/null" ? null : path.replace(/^b\//, "");
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count <= 0) continue;
    const lines = changed.get(currentPath) || new Set<number>();
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
    changed.set(currentPath, lines);
  }
  return changed;
}

export function parseChangedFiles(nameOnlyDiff: string): string[] {
  return nameOnlyDiff.split("\0").filter(Boolean);
}

function parseExternalCoverageBoundaryArray(value: unknown): ExternalCoverageBoundary[] {
  if (!Array.isArray(value)) {
    throw new Error("External coverage boundary manifest must be a JSON array");
  }
  const boundaries = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`External coverage boundary ${index + 1} must be an object`);
    }
    const { path, reason, runner, evidence } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      !path.trim() ||
      typeof reason !== "string" ||
      !reason.trim() ||
      !runner ||
      typeof runner !== "object" ||
      Array.isArray(runner) ||
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      evidence.some(
        (item) =>
          typeof item !== "string" ||
          !item.trim() ||
          isAbsolute(item) ||
          item.split("/").includes(".."),
      )
    ) {
      throw new Error(
        `External coverage boundary ${index + 1} requires path, reason, runner, and evidence`,
      );
    }
    const runnerRecord = runner as Record<string, unknown>;
    let parsedRunner: ExternalCoverageRunner;
    if (
      runnerRecord.kind === "critical-test" &&
      typeof runnerRecord.test === "string" &&
      runnerRecord.test.trim()
    ) {
      parsedRunner = { kind: "critical-test", test: runnerRecord.test };
    } else if (
      runnerRecord.kind === "make-target" &&
      typeof runnerRecord.target === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runnerRecord.target)
    ) {
      parsedRunner = { kind: "make-target", target: runnerRecord.target };
    } else {
      throw new Error(
        `External coverage boundary ${index + 1} has an invalid critical-test or make-target runner`,
      );
    }
    const parsedEvidence = [...new Set(evidence as string[])];
    if (
      parsedEvidence.length !== evidence.length ||
      !parsedEvidence.some((item) => item !== path)
    ) {
      throw new Error(
        `External coverage boundary ${index + 1} requires unique evidence beyond the source path`,
      );
    }
    return { path, reason, runner: parsedRunner, evidence: parsedEvidence };
  });
  const duplicate = boundaries.find(
    (boundary, index) => boundaries.findIndex((item) => item.path === boundary.path) !== index,
  );
  if (duplicate) throw new Error(`Duplicate external coverage boundary: ${duplicate.path}`);
  return boundaries;
}

export function parseExternalCoverageBoundaries(input: string): ExternalCoverageBoundary[] {
  return parseExternalCoverageBoundaryArray(JSON.parse(input) as unknown);
}

/**
 * Legacy manifests are policy version 1. A versioned object makes every future
 * expansion of the externally executed surface an explicit, reviewable gate
 * policy change instead of a silent exemption.
 */
export function parseExternalCoverageManifest(input: string): ExternalCoverageManifest {
  const value: unknown = JSON.parse(input);
  if (Array.isArray(value)) {
    return { policyVersion: 1, boundaries: parseExternalCoverageBoundaryArray(value) };
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "policyVersion" && key !== "boundaries")
  ) {
    throw new Error("External coverage manifest must be a legacy array or versioned object");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.policyVersion) ||
    (record.policyVersion as number) < 1 ||
    !Array.isArray(record.boundaries)
  ) {
    throw new Error("Versioned external coverage manifest requires policyVersion and boundaries");
  }
  return {
    policyVersion: record.policyVersion as number,
    boundaries: parseExternalCoverageBoundaryArray(record.boundaries),
  };
}

function externalBoundaryIdentity(boundary: ExternalCoverageBoundary): string {
  return JSON.stringify(boundary);
}

/**
 * The first rollout may bootstrap a baseline when the base revision has no
 * manifest. Once committed, exemptions are immutable except for deletion;
 * adding or redirecting a runner requires an explicit gate-policy change.
 */
export function assertExternalCoverageBoundaryBaseline(
  current: readonly ExternalCoverageBoundary[],
  baseline: readonly ExternalCoverageBoundary[] | undefined,
): void {
  if (baseline === undefined) return;
  const allowed = new Set(baseline.map(externalBoundaryIdentity));
  for (const boundary of current) {
    if (!allowed.has(externalBoundaryIdentity(boundary))) {
      throw new Error(
        `External coverage boundary is not present unchanged in the base manifest: ${boundary.path}`,
      );
    }
  }
}

export function assertExternalCoverageManifestBaseline(
  current: ExternalCoverageManifest,
  baseline: ExternalCoverageManifest | undefined,
  changedFiles: readonly string[],
): void {
  if (baseline === undefined) return;
  if (current.policyVersion === baseline.policyVersion) {
    assertExternalCoverageBoundaryBaseline(current.boundaries, baseline.boundaries);
    return;
  }
  if (current.policyVersion !== baseline.policyVersion + 1) {
    throw new Error(
      `External coverage policyVersion must remain ${baseline.policyVersion} or advance exactly once`,
    );
  }

  const changed = new Set(changedFiles);
  const missingPolicyFiles = EXTERNAL_COVERAGE_POLICY_FILES.filter((path) => !changed.has(path));
  if (missingPolicyFiles.length) {
    throw new Error(
      `External coverage policy change requires gate implementation and tests: ${missingPolicyFiles.join(", ")}`,
    );
  }

  const baselineByPath = new Map(
    baseline.boundaries.map((boundary) => [boundary.path, boundary] as const),
  );
  for (const boundary of current.boundaries) {
    const prior = baselineByPath.get(boundary.path);
    if (!prior) continue;
    if (
      prior.reason !== boundary.reason ||
      JSON.stringify(prior.runner) !== JSON.stringify(boundary.runner)
    ) {
      throw new Error(
        `Existing external coverage boundary cannot be redirected during policy expansion: ${boundary.path}`,
      );
    }
    const removedEvidence = prior.evidence.filter((path) => !boundary.evidence.includes(path));
    if (removedEvidence.length) {
      throw new Error(
        `Existing external coverage boundary evidence cannot be removed: ${boundary.path} -> ${removedEvidence.join(", ")}`,
      );
    }
  }

  const baselineIdentities = new Set(baseline.boundaries.map(externalBoundaryIdentity));
  const expanded = current.boundaries.filter(
    (boundary) => !baselineIdentities.has(externalBoundaryIdentity(boundary)),
  );
  if (expanded.length === 0) {
    throw new Error("External coverage policyVersion advanced without a new or changed boundary");
  }
  for (const boundary of expanded) {
    if (!changed.has(boundary.path)) {
      throw new Error(
        `New external coverage boundary requires the source path to change: ${boundary.path}`,
      );
    }
    const missingEvidence = EXTERNAL_COVERAGE_POLICY_FILES.filter(
      (path) => !boundary.evidence.includes(path),
    );
    if (missingEvidence.length) {
      throw new Error(
        `New external coverage boundary requires policy evidence: ${boundary.path} -> ${missingEvidence.join(", ")}`,
      );
    }
    const prior = baselineByPath.get(boundary.path);
    const evidenceAdded = prior
      ? boundary.evidence.filter((path) => !prior.evidence.includes(path))
      : boundary.evidence;
    const staleEvidence = evidenceAdded.filter((path) => !changed.has(path));
    if (staleEvidence.length) {
      throw new Error(
        `Expanded external coverage boundary requires changed evidence: ${boundary.path} -> ${staleEvidence.join(", ")}`,
      );
    }
  }
}

function listedCriticalTests(input: string): Set<string> {
  return new Set(
    input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => (line.startsWith("web/") ? line : `web/${line}`)),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateExternalCoverageRunner(
  boundary: ExternalCoverageBoundary,
  inputs: { criticalTests: string; makefile: string; workflow: string },
): void {
  if (boundary.runner.kind === "critical-test") {
    if (!listedCriticalTests(inputs.criticalTests).has(boundary.runner.test)) {
      throw new Error(
        `External coverage runner is not in the critical test suite: ${boundary.runner.test}`,
      );
    }
    return;
  }

  const escaped = escapeRegex(boundary.runner.target);
  const declared = new RegExp(`^${escaped}\\s*:`, "m").test(inputs.makefile);
  const verifyDependencies = inputs.makefile
    .split(/\r?\n/)
    .find((line) => /^verify\s*:/.test(line));
  const inVerify = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(
    verifyDependencies?.replace(/^verify\s*:/, "") || "",
  );
  const inWorkflow = inputs.workflow.split(/\r?\n/).some((line) => {
    const command = line.replace(/#.*/, "");
    return /\bmake\b/.test(command) && new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(command);
  });
  if (!declared || (!inVerify && !inWorkflow)) {
    throw new Error(
      `External coverage make target is not declared and wired into CI: ${boundary.runner.target}`,
    );
  }
}

/** A changed external boundary must update at least one declared execution-evidence path. */
export function assertChangedExternalCoverageEvidence(
  boundaries: readonly ExternalCoverageBoundary[],
  changedFiles: readonly string[],
): void {
  const changed = new Set(changedFiles);
  for (const boundary of boundaries) {
    if (!changed.has(boundary.path)) continue;
    if (!boundary.evidence.some((path) => changed.has(path))) {
      throw new Error(
        `Changed external coverage boundary requires matching evidence changes: ${boundary.path}`,
      );
    }
  }
}

export function isCoverageEligiblePath(path: string): boolean {
  if (!/^web\/(?:server|src|shared|bin|scripts)\//.test(path) && path !== "web/vite.config.ts")
    return false;
  if (!/(?:\.[cm]?[jt]sx?|\.c)$/.test(path)) return false;
  return !/(?:^|\/)\w[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(".d.ts");
}

function inferCExecutableLines(source: string): Set<number> {
  const executable = new Set<number>();
  let blockComment = false;
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    let line = rawLine;
    if (blockComment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      blockComment = false;
      line = line.slice(end + 2);
    }
    while (line.includes("/*")) {
      const start = line.indexOf("/*");
      const end = line.indexOf("*/", start + 2);
      if (end < 0) {
        blockComment = true;
        line = line.slice(0, start);
        break;
      }
      line = `${line.slice(0, start)}${line.slice(end + 2)}`;
    }
    const trimmed = line.replace(/\/\/.*$/, "").trim();
    if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed.startsWith("#")) continue;
    executable.add(index + 1);
  }
  return executable;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!ts.getModifiers(node as ts.HasModifiers)?.some((modifier) => modifier.kind === kind);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((item) => item.isTypeOnly)
  );
}

function skipRuntimeSubtree(node: ts.Node): boolean {
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return true;
  }
  if (ts.isImportDeclaration(node) && isTypeOnlyImport(node)) return true;
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
  if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return true;
  if (ts.isFunctionDeclaration(node) && !node.body) return true;
  if (ts.isEnumDeclaration(node) && hasModifier(node, ts.SyntaxKind.ConstKeyword)) {
    return true;
  }
  return false;
}

/** Infer runtime-bearing lines only when a changed source file is absent from LCOV. */
export function inferExecutableLines(source: string, path: string): Set<number> {
  if (path.endsWith(".c")) return inferCExecutableLines(source);
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (skipRuntimeSubtree(node)) return;
    if (
      (ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node)) ||
      ts.isExpression(node) ||
      (ts.isPropertyDeclaration(node) && !!node.initializer)
    ) {
      lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export function calculateDiffCoverage(options: CalculateDiffCoverageOptions): DiffCoverageResult {
  const eligible = options.isEligiblePath || isCoverageEligiblePath;
  const files: FileDiffCoverage[] = [];
  let covered = 0;
  let total = 0;

  for (const path of [...new Set(options.changedFiles)].sort((a, b) => a.localeCompare(b))) {
    if (!eligible(path)) continue;
    const record = options.coverage.get(path);
    let executableLines: Set<number>;
    if (record) {
      executableLines = new Set(record.lines.keys());
    } else {
      const source = options.loadSource(path);
      if (source === undefined) {
        throw new Error(`Changed coverage source is missing at head: ${path}`);
      }
      executableLines = inferExecutableLines(source, path);
    }

    const fileResult: FileDiffCoverage = {
      path,
      covered: 0,
      total: 0,
      uncoveredLines: [],
    };
    const wholeFile = !options.changedLines || options.wholeFilePaths?.has(path) === true;
    const selectedLines = wholeFile
      ? executableLines
      : new Set(
          [...executableLines].filter(
            (line) => options.changedLines?.get(path)?.has(line) === true,
          ),
        );
    for (const line of [...selectedLines].sort((a, b) => a - b)) {
      fileResult.total += 1;
      total += 1;
      if ((record?.lines.get(line) || 0) > 0) {
        fileResult.covered += 1;
        covered += 1;
      } else {
        fileResult.uncoveredLines.push(line);
      }
    }
    // Keep executable changed files in the report; type-only files have no
    // runtime denominator and therefore pass without diluting the aggregate.
    if (fileResult.total > 0) files.push(fileResult);
  }

  return {
    covered,
    total,
    percent: total === 0 ? 100 : (covered / total) * 100,
    files,
  };
}

export function meetsCoverageThreshold(
  result: Pick<DiffCoverageResult, "covered" | "total" | "files">,
  threshold: number,
): boolean {
  const aggregatePasses = result.total === 0 || result.covered * 100 >= threshold * result.total;
  return (
    aggregatePasses &&
    result.files.every((file) => file.total === 0 || file.covered * 100 >= threshold * file.total)
  );
}

interface CliOptions {
  base: string;
  head: string;
  lcov: string;
  threshold: number;
  projectRoot: string;
  externalCoverageManifest: string;
}

function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list: ${args.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  const base = values.get("base") || "";
  const head = values.get("head") || "";
  const lcov = values.get("lcov") || "coverage/lcov.info";
  const threshold = Number(values.get("threshold") || "80");
  const projectRoot = resolve(values.get("project-root") || process.cwd());
  const externalCoverageManifest = resolve(
    values.get("external-coverage-manifest") || "scripts/external-coverage-boundaries.json",
  );
  if (!base || !head) throw new Error("--base and --head are required");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("--threshold must be between 0 and 100");
  }
  return {
    base,
    head,
    lcov: resolve(lcov),
    threshold,
    projectRoot,
    externalCoverageManifest,
  };
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitFile(repoRoot: string, revision: string, path: string): string {
  return git(repoRoot, ["show", `${revision}:${path}`]);
}

function optionalGitFile(repoRoot: string, revision: string, path: string): string | undefined {
  try {
    return gitFile(repoRoot, revision, path);
  } catch {
    return undefined;
  }
}

function printResult(
  result: DiffCoverageResult,
  threshold: number,
  externalBoundaries: ExternalCoverageBoundary[],
): void {
  for (const boundary of externalBoundaries) {
    const runner =
      boundary.runner.kind === "critical-test"
        ? `critical test ${boundary.runner.test}`
        : `CI make target ${boundary.runner.target}`;
    console.log(`EXTERNAL ${boundary.path}: ${runner}; ${boundary.reason}`);
  }
  for (const file of result.files) {
    const percent = ((file.covered / file.total) * 100).toFixed(2);
    const uncovered = file.uncoveredLines.length
      ? `; uncovered lines: ${file.uncoveredLines.join(", ")}`
      : "";
    const status = file.covered * 100 >= threshold * file.total ? "PASS" : "FAIL";
    console.log(`${status} ${file.path}: ${file.covered}/${file.total} (${percent}%)${uncovered}`);
  }
  console.log(
    `Changed executable lines (whole-file for additions): ${result.covered}/${result.total} (${result.percent.toFixed(2)}%); required per file and aggregate: ${threshold.toFixed(2)}%`,
  );
}

export function runCli(args = process.argv.slice(2)): number {
  const options = parseCliOptions(args);
  // Git canonicalizes the worktree path on some platforms (notably macOS
  // under /var -> /private/var). Canonicalize both sides before enforcing the
  // repository boundary so a legitimate repo-owned manifest is not rejected.
  const repoRoot = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  const projectRoot = realpathSync(options.projectRoot);
  const coverageRoots = [
    "web/server",
    "web/src",
    "web/shared",
    "web/bin",
    "web/scripts",
    "web/vite.config.ts",
  ];
  const repositoryChangedFiles = parseChangedFiles(
    git(repoRoot, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      "--diff-filter=ACMR",
      options.base,
      options.head,
    ]),
  );
  const changedFiles = parseChangedFiles(
    git(repoRoot, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      "--diff-filter=ACMR",
      options.base,
      options.head,
      "--",
      ...coverageRoots,
    ]),
  );
  const changedLines = parseChangedLines(
    git(repoRoot, [
      "-c",
      "core.quotepath=false",
      "diff",
      "--unified=0",
      "--no-color",
      "--find-renames",
      "--diff-filter=ACMR",
      options.base,
      options.head,
      "--",
      ...coverageRoots,
    ]),
  );
  const manifestPath = posixPath(
    relative(repoRoot, realpathSync(options.externalCoverageManifest)),
  );
  if (!insideRepo(manifestPath)) {
    throw new Error("External coverage boundary manifest must be inside the repository");
  }
  const externalManifest = parseExternalCoverageManifest(
    gitFile(repoRoot, options.head, manifestPath),
  );
  const externalBoundaries = externalManifest.boundaries;
  const baselineManifest = optionalGitFile(repoRoot, options.base, manifestPath);
  assertExternalCoverageManifestBaseline(
    externalManifest,
    baselineManifest === undefined ? undefined : parseExternalCoverageManifest(baselineManifest),
    repositoryChangedFiles,
  );
  const runnerInputs = {
    criticalTests: gitFile(repoRoot, options.head, "web/scripts/critical-tests.txt"),
    makefile: gitFile(repoRoot, options.head, "Makefile"),
    // External make-target boundaries may be owned by a specialised required
    // workflow (for example the SRT canary), rather than the fast verify lane.
    // Validate the union of maintained workflows without forcing heavyweight
    // sandbox dependencies into the quality job.
    workflow: [".github/workflows/verify.yml", ".github/workflows/srt-linux.yml"]
      .map((path) => optionalGitFile(repoRoot, options.head, path))
      .filter((workflow): workflow is string => workflow !== undefined)
      .join("\n"),
  };
  for (const boundary of externalBoundaries) {
    if (!isCoverageEligiblePath(boundary.path)) {
      throw new Error(
        `External coverage boundary is not an eligible source path: ${boundary.path}`,
      );
    }
    validateExternalCoverageRunner(boundary, runnerInputs);
    const requiredPaths = [
      boundary.path,
      ...boundary.evidence,
      ...(boundary.runner.kind === "critical-test" ? [boundary.runner.test] : []),
    ];
    for (const path of requiredPaths) {
      if (boundary.runner.kind === "critical-test" && path === boundary.runner.test) {
        if (!/(?:^|\/)\w[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
          throw new Error(`External coverage boundary test is not a test path: ${path}`);
        }
      }
      try {
        execFileSync("git", ["cat-file", "-e", `${options.head}:${path}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
      } catch {
        throw new Error(`External coverage boundary path is missing at head: ${path}`);
      }
    }
  }
  assertChangedExternalCoverageEvidence(externalBoundaries, repositoryChangedFiles);
  const changedExternalBoundaries = externalBoundaries.filter((boundary) =>
    changedFiles.includes(boundary.path),
  );
  const lcovChangedFiles = changedFiles.filter(
    (path) => !externalBoundaries.some((boundary) => boundary.path === path),
  );
  const wholeFilePaths = new Set(
    lcovChangedFiles.filter((path) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${options.base}:${path}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        return false;
      } catch {
        return true;
      }
    }),
  );
  const lcov = parseLcov(readFileSync(options.lcov, "utf8"), (path) =>
    normalizeLcovSourcePath(path, { repoRoot, projectRoot }),
  );
  const result = calculateDiffCoverage({
    changedFiles: lcovChangedFiles,
    changedLines,
    wholeFilePaths,
    coverage: lcov,
    loadSource(path) {
      try {
        return git(repoRoot, ["show", `${options.head}:${path}`]);
      } catch {
        return undefined;
      }
    },
  });
  printResult(result, options.threshold, changedExternalBoundaries);
  return meetsCoverageThreshold(result, options.threshold) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
