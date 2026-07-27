import { gunzipSync as fflateGunzipSync, gzipSync as fflateGzipSync } from "fflate";
import type {
  BufferEncoding,
  Command,
  CommandContext,
  CommandName,
  ExecResult,
  FileContent,
  FsStat,
  IFileSystem,
} from "just-bash/browser";
import type { IndexedWorkspaceContentMatch, IndexedWorkspaceEntry } from "../user-space-index.js";
import { uiCopy } from "../ui-copy.js";
import { RUOK_FIXTURE_SOURCE_ROOT } from "../fixtures/user-space-ruok.js";
import {
  USER_SPACE_BASH_COMMANDS,
  USER_SPACE_BASH_EXECUTION_LIMITS,
  USER_SPACE_BASH_MOUNT_NAME,
} from "../user-space-shell-contract.js";
import {
  createRuokCleanupCase,
  createRuokCleanupScript,
  createRuokSetupScript,
  formatRuokCaseReport,
  formatRuokStats,
  RUOK_COMMAND_MATRIX,
  RUOK_SHELL_LIKE_MATRIX,
  truncateRuokOutput,
  type ShellSelfTestCase,
} from "../user-space-shell-self-test.js";

const DEFAULT_USER_SPACE_SHELL_MOUNT_NAME = USER_SPACE_BASH_MOUNT_NAME;
const LEGACY_USER_SPACE_SHELL_HOME_PATH = "/user-dir";
const USER_SPACE_SHELL_FS_KIND = "piwork-user-space";

type ShellWriteFileOptions = { encoding?: BufferEncoding };

type JustBashBrowserModule = typeof import("just-bash/browser");

let justBashBrowserModule: Promise<JustBashBrowserModule> | null = null;

const SHELL_COMMANDS = USER_SPACE_BASH_COMMANDS satisfies readonly CommandName[];

export interface UserSpaceShellVisibility {
  showHiddenEntries: boolean;
  searchHiddenEntries: boolean;
}

export interface UserSpaceShellFileSystem extends IFileSystem {
  readonly userSpaceShellKind: typeof USER_SPACE_SHELL_FS_KIND;
  readonly shellMountName: string;
  readonly shellMountPath: string;
  changedDirectoryPaths(): string[];
  primePathSnapshot(): Promise<void>;
  indexSubtree(path: string, maxDepth?: number): Promise<void>;
  searchIndexedContent(input: {
    query: string;
    mode: "text" | "regex";
    path: string;
    ignoreCase: boolean;
    invert: boolean;
    limit: number;
    contextLines: number;
  }): Promise<{ matches: IndexedWorkspaceContentMatch[]; truncated?: boolean }>;
  globIndexedPaths(input: {
    pattern: string;
    path: string;
    filesOnly: boolean;
    directoriesOnly: boolean;
    limit: number;
  }): Promise<{ entries: IndexedWorkspaceEntry[]; truncated?: boolean }>;
  listEntries(path: string, includeHidden: boolean): Promise<IndexedWorkspaceEntry[]>;
  includeHiddenForTree(): boolean;
  includeHiddenForFind(): boolean;
  findEntry(path: string): Promise<IndexedWorkspaceEntry | null>;
  readRawFileBuffer(path: string): Promise<Uint8Array>;
}

export interface ExecuteUserSpaceShellOptions {
  mountId: string;
  rootName: string;
  input: Record<string, unknown>;
  createFileSystem(visibility: UserSpaceShellVisibility): UserSpaceShellFileSystem;
}

export async function executeUserSpaceShell(options: ExecuteUserSpaceShellOptions): Promise<{
  mountId: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  changedDirs?: string[];
}> {
  const { input } = options;
  const script = requireString(input.script, "script");
  const shellMountPath = shellMountPathForName(options.rootName);
  const cwd = normalizeShellCwdInput(
    typeof input.cwd === "string" ? input.cwd : "",
    shellMountPath,
  );
  const stdin = typeof input.stdin === "string" ? input.stdin : "";
  const timeoutMs = optionalFiniteNumber(input.timeoutMs, "timeoutMs");
  const sessionId = typeof input.__sessionId === "string" ? input.__sessionId : "";
  if (timeoutMs !== undefined && (timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
    throw new Error(
      "Invalid timeout: must be a finite positive duration no greater than 2147483647ms",
    );
  }
  const preflightError = validateShellScript(script);
  if (preflightError) {
    return {
      mountId: options.mountId,
      cwd,
      stdout: "",
      stderr: `${preflightError}\n`,
      exitCode: 2,
    };
  }

  const justBash = await loadJustBashBrowser();
  const fs = options.createFileSystem({
    showHiddenEntries: input.showHiddenEntries === true,
    searchHiddenEntries: true,
  });
  await fs.primePathSnapshot();
  const bash = new justBash.Bash({
    fs,
    cwd,
    commands: [...SHELL_COMMANDS],
    customCommands: createShellCustomCommands(justBash, sessionId, options.rootName),
    env: {
      HOME: "/",
      PATH: "/usr/bin:/bin",
      USER: "user",
      LOGNAME: "user",
      HOSTNAME: "localhost",
      PIWORK_USER_SPACE_ROOT_NAME: options.rootName,
    },
    executionLimits: USER_SPACE_BASH_EXECUTION_LIMITS,
    python: false,
    javascript: false,
  });

  const controller = new AbortController();
  const timeout =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    let result: Awaited<ReturnType<typeof bash.exec>>;
    try {
      result = await bash.exec(script, { cwd, stdin, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && timeoutMs !== undefined) {
        throw new Error(`Command timed out after ${timeoutMs / 1000} seconds`);
      }
      throw error;
    }
    return {
      mountId: options.mountId,
      cwd: normalizeShellPath(result.env.PWD || cwd, cwd),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      changedDirs: fs.changedDirectoryPaths(),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function loadJustBashBrowser(): Promise<JustBashBrowserModule> {
  justBashBrowserModule ||= import("just-bash/browser");
  return justBashBrowserModule;
}

function isUserSpaceShellFileSystem(fs: IFileSystem): fs is UserSpaceShellFileSystem {
  return "userSpaceShellKind" in fs && fs.userSpaceShellKind === USER_SPACE_SHELL_FS_KIND;
}

function asUserSpaceShellFileSystem(fs: IFileSystem): UserSpaceShellFileSystem | null {
  return isUserSpaceShellFileSystem(fs) ? fs : null;
}

function createShellCustomCommands(
  justBash: JustBashBrowserModule,
  sessionId: string,
  rootName: string,
): Command[] {
  return [
    createShellLsCommand(justBash),
    createShellCatCommand(justBash),
    createShellHeadCommand(justBash),
    createShellTailCommand(justBash),
    createShellGrepCommand(justBash),
    createShellGrepAliasCommand(justBash, "fgrep", { fixed: true }),
    createShellGrepAliasCommand(justBash, "egrep", { fixed: false }),
    createShellGlobCommand(justBash),
    createShellTreeCommand(justBash),
    createShellFindCommand(justBash),
    createShellFileCommand(justBash),
    createShellWhichCommand(justBash),
    createShellGzipCommand(justBash),
    createShellGunzipCommand(justBash),
    createShellZcatCommand(justBash),
    createShellTransferCommand(justBash, "checkout", sessionId, rootName),
    createShellTransferCommand(justBash, "checkin", sessionId, rootName),
    createShellRuokCommand(justBash),
  ];
}

function createShellGlobCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("glob", async (args, ctx) => {
    const usage = "usage: glob PATTERN [PATH] [--files-only|--directories-only] [--limit N]";
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      return {
        stdout: `${usage}\nRecursively matches the browser file-tree path index; quote PATTERN to prevent shell expansion.\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
    if (!workspaceFs)
      return {
        stdout: "",
        stderr: "glob: a mounted User Space directory is required\n",
        exitCode: 2,
      };
    let pattern = "";
    let path = ".";
    let pathSet = false;
    let filesOnly = false;
    let directoriesOnly = false;
    let limit = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--files-only") {
        filesOnly = true;
      } else if (arg === "--directories-only") {
        directoriesOnly = true;
      } else if (arg === "--limit") {
        const value = args[++index];
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          return { stdout: "", stderr: "glob: --limit requires a positive integer\n", exitCode: 2 };
        }
        limit = parsed;
      } else if (arg.startsWith("-")) {
        return { stdout: "", stderr: `glob: unsupported option ${arg}\n`, exitCode: 2 };
      } else if (!pattern) {
        pattern = arg;
      } else if (!pathSet) {
        path = arg;
        pathSet = true;
      } else {
        return { stdout: "", stderr: `glob: ${usage}\n`, exitCode: 2 };
      }
    }
    if (!pattern || (filesOnly && directoriesOnly)) {
      return { stdout: "", stderr: `glob: ${usage}\n`, exitCode: 2 };
    }
    const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
    try {
      const result = await workspaceFs.globIndexedPaths({
        pattern,
        path: fullPath,
        filesOnly,
        directoriesOnly,
        limit,
      });
      const stdout =
        result.entries.length > 0
          ? `${result.entries.map((entry) => entry.path).join("\n")}\n`
          : "";
      const stderr = result.truncated
        ? "glob: results truncated; increase --limit or narrow PATH\n"
        : "";
      return { stdout, stderr, exitCode: result.entries.length > 0 ? 0 : 1 };
    } catch (error) {
      return { stdout: "", stderr: `glob: ${shellErrorMessage(error)}\n`, exitCode: 2 };
    }
  });
}

type AgentSpaceTransferFile = {
  source?: unknown;
  target?: unknown;
  status?: unknown;
  size?: unknown;
  error?: unknown;
};

function createShellTransferCommand(
  justBash: JustBashBrowserModule,
  direction: "checkout" | "checkin",
  sessionId: string,
  rootName: string,
): Command {
  return justBash.defineCommand(direction, async (args, ctx) => {
    const usage =
      direction === "checkout"
        ? "usage: checkout ROOT_NAME/USER_SPACE_PATH"
        : "usage: checkin AGENT_SPACE_PATH [ROOT_NAME/USER_SPACE_PATH]";
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      const detail =
        direction === "checkout"
          ? "Copies a User Space file or directory to this session's Agent Space shared/. Continue with normal Agent Space tools; the returned path is not visible inside user-space bash."
          : "Copies an Agent Space result back to User Space. With an explicit root-qualified target it safely replaces that file; without one it creates a non-destructive result under shared/.";
      return { stdout: `${usage}\n${detail}\n`, stderr: "", exitCode: 0 };
    }
    const validArgCount =
      direction === "checkout" ? args.length === 1 : args.length === 1 || args.length === 2;
    if (!validArgCount || !args[0]) {
      return { stdout: "", stderr: `${direction}: ${usage}\n`, exitCode: 2 };
    }
    if (!sessionId) {
      return {
        stdout: "",
        stderr: `${direction}: session transfer context is unavailable\n`,
        exitCode: 2,
      };
    }

    try {
      const path =
        direction === "checkout"
          ? resolveShellCheckoutPath(args[0], ctx, rootName)
          : normalizeAgentSpaceTransferPath(args[0]);
      const targetPath =
        direction === "checkin" && args[1]
          ? resolveShellCheckoutPath(args[1], ctx, rootName)
          : undefined;
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/transfer/${direction === "checkout" ? "user-to-agent" : "agent-to-user"}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, ...(targetPath ? { targetPath } : {}) }),
        },
      );
      const responseText = await response.text();
      const body = responseText
        ? (() => {
            try {
              return JSON.parse(responseText) as {
                error?: unknown;
                message?: unknown;
                files?: unknown;
              };
            } catch {
              return {};
            }
          })()
        : {};
      if (!response.ok) {
        const message =
          typeof body.error === "string"
            ? body.error
            : typeof body.message === "string"
              ? body.message
              : responseText.trim() || `${response.status} ${response.statusText}`;
        return { stdout: "", stderr: `${direction}: ${message}\n`, exitCode: 1 };
      }
      const files = Array.isArray(body.files) ? (body.files as AgentSpaceTransferFile[]) : [];
      return formatShellTransferResult(direction, files);
    } catch (error) {
      return {
        stdout: "",
        stderr: `${direction}: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

function resolveShellCheckoutPath(path: string, ctx: CommandContext, rootName: string): string {
  if (!isUserSpaceShellFileSystem(ctx.fs))
    throw new Error("a mounted User Space directory is required");
  const rootPrefix = `${rootName}/`;
  const shellPath = path.startsWith(rootPrefix)
    ? userPathToShellPath(path.slice(rootPrefix.length), ctx.fs.shellMountPath)
    : path;
  const absolutePath = ctx.fs.resolvePath(ctx.cwd, shellPath);
  const userPath = shellPathToUserPath(absolutePath, ctx.fs.shellMountPath);
  if (!userPath) throw new Error("checkout requires a file or directory below the User Space root");
  return userPath;
}

function normalizeAgentSpaceTransferPath(path: string): string {
  const raw = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^workspace\/?/, "");
  if (!raw || raw.startsWith("/") || /^[^/]+:\//.test(raw)) {
    throw new Error(
      "checkin requires a session-relative Agent Space path such as shared/result.bin",
    );
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("checkin path must stay inside Agent Space workspace");
  }
  return parts.join("/");
}

function formatShellTransferResult(
  direction: "checkout" | "checkin",
  files: AgentSpaceTransferFile[],
): ExecResult {
  if (files.length === 0) {
    return { stdout: "", stderr: `${direction}: transfer returned no files\n`, exitCode: 1 };
  }
  let stdout = "";
  let stderr = "";
  for (const file of files) {
    const source = typeof file.source === "string" ? file.source : "source";
    const target = typeof file.target === "string" ? file.target : "target";
    const size = typeof file.size === "number" ? ` (${file.size} bytes)` : "";
    if (file.status === "ok" || file.status === "exists") {
      stdout += `${file.status}: ${source} -> ${target}${size}\n`;
      if (direction === "checkout" && target.startsWith("workspace/")) {
        stdout += `Agent Space path: ${target.slice("workspace/".length)} (use normal Agent Space tools; do not use this path inside user-space bash)\n`;
      }
    } else {
      const error = typeof file.error === "string" ? `: ${file.error}` : "";
      stderr += `${direction}: ${source} -> ${target}${error}\n`;
    }
  }
  return { stdout, stderr, exitCode: stderr ? 1 : 0 };
}

type ShellLsOptions = {
  showAll: boolean;
  showAlmostAll: boolean;
  directoryOnly: boolean;
  longFormat: boolean;
  humanReadable: boolean;
  recursive: boolean;
  reverse: boolean;
  sortBySize: boolean;
  sortByTime: boolean;
  classify: boolean;
};

type ShellLsEntry = {
  name: string;
  path: string;
  stat: FsStat;
};

function createShellLsCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("ls", async (args, ctx) => runShellLsCommand(args, ctx));
}

async function runShellLsCommand(args: string[], ctx: CommandContext): Promise<ExecResult> {
  const parsed = parseShellLsArgs(args);
  if (!parsed.ok) return { stdout: "", stderr: parsed.error, exitCode: 2 };
  if (parsed.help) return { stdout: SHELL_LS_HELP, stderr: "", exitCode: 0 };
  const targets = parsed.targets.length > 0 ? parsed.targets : ["."];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const multipleTargets = targets.length > 1;

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const resolvedPath = ctx.fs.resolvePath(ctx.cwd, target);
    try {
      const stat = await ctx.fs.stat(resolvedPath);
      if (parsed.options.directoryOnly || !stat.isDirectory) {
        const outputName = target;
        stdout += parsed.options.longFormat
          ? `${formatShellLsLongLine(outputName, stat, parsed.options)}\n`
          : `${outputName}${formatShellLsIndicator(stat, parsed.options, false)}\n`;
        continue;
      }
      if (index > 0 && stdout && !stdout.endsWith("\n\n")) stdout += "\n";
      stdout += await formatShellLsDirectory(
        target,
        resolvedPath,
        parsed.options,
        ctx,
        multipleTargets || parsed.options.recursive,
        0,
      );
    } catch {
      stderr += `ls: cannot access '${target}': No such file or directory\n`;
      exitCode = 2;
    }
  }

  return { stdout, stderr, exitCode };
}

function parseShellLsArgs(
  args: string[],
):
  | { ok: true; help: boolean; options: ShellLsOptions; targets: string[] }
  | { ok: false; error: string } {
  const options: ShellLsOptions = {
    showAll: false,
    showAlmostAll: false,
    directoryOnly: false,
    longFormat: false,
    humanReadable: false,
    recursive: false,
    reverse: false,
    sortBySize: false,
    sortByTime: false,
    classify: false,
  };
  const targets: string[] = [];
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === "--help") {
      return { ok: true, help: true, options, targets };
    }
    if (parsingOptions && arg.startsWith("--") && arg.length > 2) {
      switch (arg) {
        case "--all":
          options.showAll = true;
          break;
        case "--almost-all":
          options.showAlmostAll = true;
          break;
        case "--directory":
          options.directoryOnly = true;
          break;
        case "--classify":
          options.classify = true;
          break;
        case "--human-readable":
          options.humanReadable = true;
          break;
        case "--recursive":
          options.recursive = true;
          break;
        case "--reverse":
          options.reverse = true;
          break;
        default:
          return { ok: false, error: `ls: unrecognized option '${arg}'\n` };
      }
      continue;
    }
    if (parsingOptions && /^-[^-]/.test(arg)) {
      for (const flag of arg.slice(1)) {
        switch (flag) {
          case "a":
            options.showAll = true;
            break;
          case "A":
            options.showAlmostAll = true;
            break;
          case "d":
            options.directoryOnly = true;
            break;
          case "F":
            options.classify = true;
            break;
          case "h":
            options.humanReadable = true;
            break;
          case "l":
            options.longFormat = true;
            break;
          case "r":
            options.reverse = true;
            break;
          case "R":
            options.recursive = true;
            break;
          case "S":
            options.sortBySize = true;
            options.sortByTime = false;
            break;
          case "t":
            options.sortByTime = true;
            options.sortBySize = false;
            break;
          case "1":
            break;
          default:
            return { ok: false, error: `ls: invalid option -- '${flag}'\n` };
        }
      }
      continue;
    }
    targets.push(arg);
  }
  return { ok: true, help: false, options, targets };
}

const SHELL_LS_HELP = [
  "Usage: ls [OPTION]... [FILE]...",
  "List information about files and directories.",
  "",
  "  -a, --all            do not ignore entries starting with .",
  "  -A, --almost-all     do not list implied . and ..",
  "  -d, --directory      list directories themselves, not their contents",
  "  -F, --classify       append indicator (one of */@)",
  "  -h, --human-readable with -l, print sizes like 1K 234M 2G",
  "  -l                   use a long listing format",
  "  -r, --reverse        reverse order while sorting",
  "  -R, --recursive      list subdirectories recursively",
  "  -S                   sort by file size, largest first",
  "  -t                   sort by time, newest first",
  "  -1                   list one file per line",
  "      --help           display this help and exit",
  "",
].join("\n");

async function formatShellLsDirectory(
  displayPath: string,
  dirPath: string,
  options: ShellLsOptions,
  ctx: CommandContext,
  includeHeader: boolean,
  depth: number,
): Promise<string> {
  if (depth > 100) return "";
  const entries = await readShellLsDirectoryEntries(displayPath, dirPath, options, ctx);
  let output = includeHeader ? `${displayPath}:\n` : "";
  if (options.longFormat) output += `total ${entries.length}\n`;
  output += entries
    .map((entry) =>
      options.longFormat
        ? formatShellLsLongLine(entry.name, entry.stat, options)
        : `${entry.name}${formatShellLsIndicator(entry.stat, options, false)}`,
    )
    .join("\n");
  if (entries.length > 0) output += "\n";

  if (options.recursive) {
    const childDirs = entries.filter(
      (entry) => entry.stat.isDirectory && entry.name !== "." && entry.name !== "..",
    );
    for (const child of childDirs) {
      const childDisplayPath =
        displayPath === "." ? `./${child.name}` : joinShellDisplayPath(displayPath, child.name);
      output += `\n${await formatShellLsDirectory(childDisplayPath, child.path, options, ctx, true, depth + 1)}`;
    }
  }
  return output;
}

async function readShellLsDirectoryEntries(
  displayPath: string,
  dirPath: string,
  options: ShellLsOptions,
  ctx: CommandContext,
): Promise<ShellLsEntry[]> {
  let names = await ctx.fs.readdir(dirPath);
  if (!options.showAll && !options.showAlmostAll)
    names = names.filter((name) => !name.startsWith("."));
  const entries: ShellLsEntry[] = [];
  if (options.showAll) {
    entries.push(
      { name: ".", path: dirPath, stat: await ctx.fs.stat(dirPath) },
      {
        name: "..",
        path: ctx.fs.resolvePath(dirPath, ".."),
        stat: await ctx.fs.stat(ctx.fs.resolvePath(dirPath, "..")),
      },
    );
  }
  for (const name of names) {
    const path = joinShellFsPath(dirPath, name);
    try {
      entries.push({ name, path, stat: await ctx.fs.stat(path) });
    } catch {
      entries.push({ name, path, stat: fallbackShellLsStat() });
    }
  }

  const dotEntries = entries.filter((entry) => entry.name === "." || entry.name === "..");
  const normalEntries = entries.filter((entry) => entry.name !== "." && entry.name !== "..");
  normalEntries.sort((left, right) => sortShellLsEntries(left, right, options));
  if (options.reverse) normalEntries.reverse();
  return [...dotEntries, ...normalEntries].map((entry) => ({
    ...entry,
    name:
      displayPath === "." || entry.name === "." || entry.name === ".." ? entry.name : entry.name,
  }));
}

function sortShellLsEntries(
  left: ShellLsEntry,
  right: ShellLsEntry,
  options: ShellLsOptions,
): number {
  if (options.sortBySize && left.stat.size !== right.stat.size)
    return right.stat.size - left.stat.size;
  if (options.sortByTime && left.stat.mtime.getTime() !== right.stat.mtime.getTime()) {
    return right.stat.mtime.getTime() - left.stat.mtime.getTime();
  }
  return left.name.localeCompare(right.name);
}

function formatShellLsLongLine(name: string, stat: FsStat, options: ShellLsOptions): string {
  const mode = formatShellPermissionMode(stat);
  const size = options.humanReadable
    ? formatShellHumanSize(stat.size).padStart(5)
    : String(stat.size).padStart(5);
  const time = formatShellLsTime(stat.mtime);
  return `${mode} 1 user user ${size} ${time} ${name}${formatShellLsIndicator(stat, options, true)}`;
}

function formatShellPermissionMode(stat: FsStat): string {
  const type = stat.isDirectory ? "d" : stat.isSymbolicLink ? "l" : "-";
  const bit = (mask: number, char: string) => (stat.mode & mask ? char : "-");
  return [
    type,
    bit(0o400, "r"),
    bit(0o200, "w"),
    bit(0o100, "x"),
    bit(0o040, "r"),
    bit(0o020, "w"),
    bit(0o010, "x"),
    bit(0o004, "r"),
    bit(0o002, "w"),
    bit(0o001, "x"),
  ].join("");
}

function formatShellLsIndicator(
  stat: FsStat,
  options: ShellLsOptions,
  longFormat: boolean,
): string {
  if (stat.isDirectory) return longFormat || options.classify ? "/" : "";
  if (stat.isSymbolicLink) return options.classify ? "@" : "";
  if (options.classify && (stat.mode & 0o111) !== 0) return "*";
  return "";
}

function formatShellHumanSize(size: number): string {
  if (size < 1024) return String(size);
  if (size < 1024 * 1024) {
    const value = size / 1024;
    return value < 10 ? `${value.toFixed(1)}K` : `${Math.round(value)}K`;
  }
  if (size < 1024 * 1024 * 1024) {
    const value = size / (1024 * 1024);
    return value < 10 ? `${value.toFixed(1)}M` : `${Math.round(value)}M`;
  }
  const value = size / (1024 * 1024 * 1024);
  return value < 10 ? `${value.toFixed(1)}G` : `${Math.round(value)}G`;
}

function formatShellLsTime(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[date.getMonth()] || "Jan";
  const day = String(date.getDate()).padStart(2, " ");
  const recentCutoff = Date.now() - 4320 * 60 * 60 * 1000;
  if (date.getTime() > recentCutoff) {
    return `${month} ${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${month} ${day}  ${date.getFullYear()}`;
}

function joinShellFsPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function joinShellDisplayPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

function fallbackShellLsStat(): FsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    mode: 0o644,
    size: 0,
    mtime: new Date(0),
  };
}

function createShellRuokCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("ruok", async (args, ctx) => {
    if (!ctx.exec)
      return { stdout: "", stderr: "ruok: shell executor is unavailable\n", exitCode: 2 };
    const verbose = args.includes("--verbose") || args.includes("-v");
    const unknown = args.filter((arg) => !["--verbose", "-v"].includes(arg));
    if (unknown.length > 0) {
      return {
        stdout: "",
        stderr: `ruok: unsupported option ${unknown[0]}\nusage: ruok [--verbose]\n`,
        exitCode: 2,
      };
    }
    const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
    if (!workspaceFs) {
      return {
        stdout: "",
        stderr:
          "ruok: a mounted user-space directory is required. Add or re-authorize a user-space before running ruok.\n",
        exitCode: 2,
      };
    }

    const upstreamCommands = new Set(
      justBash.getCommandNames().filter((name) => !["rg", "xargs"].includes(name)),
    );
    const coveredCommands = new Set(RUOK_COMMAND_MATRIX.map((item) => item.name));
    const missing = Array.from(upstreamCommands)
      .filter((name) => !coveredCommands.has(name))
      .sort();
    const extra = Array.from(coveredCommands)
      .filter((name) => !upstreamCommands.has(name))
      .sort();
    const commandCases = RUOK_COMMAND_MATRIX.filter((item) => item.name !== "rm");
    const baseName = `piwork-ruok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const parentCwd = ruokParentCwd(ctx.cwd, workspaceFs);
    const testCwd = normalizeShellPath(baseName, parentCwd);
    const startedAt = Date.now();
    let stdout = `ruok: preparing ${testCwd}\nruok: fixture ${RUOK_FIXTURE_SOURCE_ROOT}\n`;
    const failures: string[] = [];

    if (missing.length > 0 || extra.length > 0) {
      if (missing.length > 0)
        failures.push(`command matrix missing upstream commands: ${missing.join(", ")}`);
      if (extra.length > 0)
        failures.push(`command matrix has non-upstream commands: ${extra.join(", ")}`);
    }

    const setup = await ctx.exec(createRuokSetupScript(baseName), { cwd: parentCwd, stdin: "" });
    if (setup.exitCode !== 0) {
      const cleanup = await ctx.exec(createRuokCleanupScript(baseName), {
        cwd: parentCwd,
        stdin: "",
      });
      if (cleanup.exitCode !== 0)
        stdout += `ruok: setup cleanup failed; test dir may remain at ${testCwd}\n`;
      return {
        stdout: `${stdout}ruok: setup failed\n`,
        stderr: `ruok setup failed\n${setup.stderr || setup.stdout}${cleanup.exitCode !== 0 ? `\nruok cleanup failed\n${cleanup.stderr || cleanup.stdout}` : ""}`,
        exitCode: setup.exitCode || 1,
      };
    }

    const commandResult = await runRuokCases("command", commandCases, ctx, testCwd, verbose, {
      total: RUOK_COMMAND_MATRIX.length,
      includeSummary: false,
    });
    stdout += commandResult.stdout;
    failures.push(...commandResult.failures);

    const shellLikeResult = await runRuokCases(
      "shell-like",
      RUOK_SHELL_LIKE_MATRIX,
      ctx,
      testCwd,
      verbose,
    );
    stdout += shellLikeResult.stdout;
    failures.push(...shellLikeResult.failures);

    const cleanupResult = await runRuokCases(
      "command",
      [createRuokCleanupCase(baseName)],
      ctx,
      parentCwd,
      verbose,
      {
        startIndex: commandCases.length,
        total: RUOK_COMMAND_MATRIX.length,
        includeSummary: false,
      },
    );
    stdout += cleanupResult.stdout;
    failures.push(...cleanupResult.failures);
    stdout += `ruok: command ${commandResult.passed + cleanupResult.passed}/${RUOK_COMMAND_MATRIX.length} passed\n`;

    const total = RUOK_COMMAND_MATRIX.length + RUOK_SHELL_LIKE_MATRIX.length;
    const commandPassed = commandResult.passed + cleanupResult.passed;
    const passed = commandPassed + shellLikeResult.passed;
    stdout += formatRuokStats({
      total,
      passed,
      failed: failures.length,
      commandTotal: RUOK_COMMAND_MATRIX.length,
      commandPassed,
      shellLikeTotal: RUOK_SHELL_LIKE_MATRIX.length,
      shellLikePassed: shellLikeResult.passed,
      durationMs: Date.now() - startedAt,
    });

    if (failures.length > 0) {
      stdout += `ruok: failed ${failures.length} check${failures.length === 1 ? "" : "s"}\n`;
      stdout += failures.map((failure) => `ruok: ${failure}`).join("\n");
      if (cleanupResult.failures.length > 0)
        stdout += `\nruok: cleanup failed; test dir may remain at ${testCwd}\n`;
      else stdout += "\nruok: test dir removed\n";
      return { stdout, stderr: "", exitCode: 1 };
    }

    stdout += "ruok: test dir removed\n";
    stdout += `ruok: ok (${RUOK_COMMAND_MATRIX.length} commands, ${RUOK_SHELL_LIKE_MATRIX.length} shell-like checks)\n`;
    return { stdout, stderr: "", exitCode: 0 };
  });
}

async function runRuokCases(
  group: string,
  cases: ShellSelfTestCase[],
  ctx: CommandContext,
  cwd: string,
  verbose: boolean,
  options: { startIndex?: number; total?: number; includeSummary?: boolean } = {},
): Promise<{ stdout: string; failures: string[]; passed: number }> {
  let stdout = "";
  const failures: string[] = [];
  let passed = 0;
  const startIndex = options.startIndex || 0;
  const total = options.total || cases.length;
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    const prefix = `${group}/${item.name}`;
    const startedAt = Date.now();
    const result = await ctx.exec?.(item.script, { cwd, stdin: "" });
    if (!result) {
      failures.push(`${prefix}: shell executor unavailable`);
      stdout += formatRuokCaseReport({
        group,
        index: startIndex + index,
        total,
        item,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: "shell executor unavailable",
      });
      continue;
    }
    const ok =
      result.exitCode === 0 && (item.stdout === undefined || result.stdout.includes(item.stdout));
    if (ok) {
      passed++;
    } else {
      failures.push(
        [
          `${prefix}: exit ${result.exitCode}`,
          item.stdout === undefined
            ? ""
            : `expected stdout to contain ${JSON.stringify(item.stdout)}`,
          result.stdout ? `stdout=${JSON.stringify(truncateRuokOutput(result.stdout))}` : "",
          result.stderr ? `stderr=${JSON.stringify(truncateRuokOutput(result.stderr))}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      );
    }
    stdout += formatRuokCaseReport({
      group,
      index: startIndex + index,
      total,
      item,
      ok,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      verbose,
    });
  }
  if (options.includeSummary !== false)
    stdout += `ruok: ${group} ${passed}/${cases.length} passed\n`;
  return { stdout, failures, passed };
}

function ruokParentCwd(cwd: string, fs: UserSpaceShellFileSystem): string {
  if (isShellVirtualRoot(cwd, fs.shellMountPath)) return fs.shellMountPath;
  if (isShellPathInUserSpace(cwd, fs.shellMountPath))
    return normalizeShellPath(cwd, fs.shellMountPath);
  return fs.shellMountPath;
}

function createShellWhichCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("which", async (args, ctx) => {
    if (args.length === 0)
      return { stdout: "", stderr: "which: missing command name\n", exitCode: 1 };
    const commands = new Set(ctx.getRegisteredCommands?.() || SHELL_COMMANDS);
    let stdout = "";
    let missing = false;
    for (const name of args) {
      if (commands.has(name)) stdout += `/usr/bin/${name}\n`;
      else missing = true;
    }
    return { stdout, stderr: "", exitCode: missing ? 1 : 0 };
  });
}

function createShellGzipCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("gzip", async (args, ctx) =>
    runShellGzipCommand("gzip", args, ctx),
  );
}

function createShellGunzipCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("gunzip", async (args, ctx) =>
    runShellGzipCommand("gunzip", args, ctx),
  );
}

function createShellZcatCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("zcat", async (args, ctx) =>
    runShellGzipCommand("zcat", args, ctx),
  );
}

type ShellGzipCommand = "gzip" | "gunzip" | "zcat";
type ShellGzipLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

type ShellGzipOptions = {
  stdout: boolean;
  decompress: boolean;
  force: boolean;
  keep: boolean;
  list: boolean;
  name: boolean;
  quiet: boolean;
  recursive: boolean;
  suffix: string;
  test: boolean;
  verbose: boolean;
  level: ShellGzipLevel | undefined;
};

type ShellGzipParseResult =
  { ok: true; options: ShellGzipOptions; files: string[] } | { ok: false; error: ExecResult };

async function runShellGzipCommand(
  command: ShellGzipCommand,
  args: string[],
  ctx: CommandContext,
): Promise<ExecResult> {
  const parsed = parseShellGzipArgs(command, args);
  if (!parsed.ok) return parsed.error;
  const options = parsed.options;
  const files = parsed.files.length > 0 ? parsed.files : ["-"];
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let stdoutKind: ExecResult["stdoutKind"] | undefined;
  let stdoutEncoding: ExecResult["stdoutEncoding"] | undefined;

  if (options.list) stdout += "  compressed uncompressed  ratio uncompressed_name\n";
  for (const file of files) {
    const result = options.list
      ? await runShellGzipList(ctx, file, options, command)
      : options.test
        ? await runShellGzipTest(ctx, file, options, command)
        : await runShellGzipTarget(ctx, file, options, command);
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) exitCode = result.exitCode;
    if (result.stdoutKind === "bytes") {
      stdoutKind = "bytes";
      stdoutEncoding = "binary";
    }
  }

  return { stdout, stderr, exitCode, stdoutKind, stdoutEncoding };
}

function parseShellGzipArgs(command: ShellGzipCommand, args: string[]): ShellGzipParseResult {
  const options: ShellGzipOptions = {
    stdout: command === "zcat",
    decompress: command === "gunzip" || command === "zcat",
    force: false,
    keep: command === "zcat",
    list: false,
    name: false,
    quiet: false,
    recursive: false,
    suffix: ".gz",
    test: false,
    verbose: false,
    level: undefined,
  };
  const files: string[] = [];
  const readValue = (
    arg: string,
    index: number,
  ): { value?: string; nextIndex: number; error?: ExecResult } => {
    const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
    if (inline !== undefined) return { value: inline, nextIndex: index };
    const value = args[index + 1];
    if (!value)
      return {
        nextIndex: index,
        error: shellGzipParseError(command, `${arg} requires an argument`),
      };
    return { value, nextIndex: index + 1 };
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      files.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      files.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      switch (arg.split("=")[0]) {
        case "--stdout":
        case "--to-stdout":
          options.stdout = true;
          options.keep = true;
          continue;
        case "--decompress":
        case "--uncompress":
          options.decompress = true;
          continue;
        case "--force":
          options.force = true;
          continue;
        case "--keep":
          options.keep = true;
          continue;
        case "--list":
          options.list = true;
          continue;
        case "--name":
          options.name = true;
          continue;
        case "--no-name":
          options.name = false;
          continue;
        case "--quiet":
          options.quiet = true;
          continue;
        case "--recursive":
          options.recursive = true;
          continue;
        case "--suffix": {
          const parsed = readValue(arg, index);
          if (parsed.error) return { ok: false, error: parsed.error };
          options.suffix = parsed.value || ".gz";
          index = parsed.nextIndex;
          continue;
        }
        case "--test":
          options.test = true;
          continue;
        case "--verbose":
          options.verbose = true;
          continue;
        case "--fast":
          options.level = 1;
          continue;
        case "--best":
          options.level = 9;
          continue;
        case "--help":
          return { ok: false, error: shellGzipHelp(command) };
        default:
          return { ok: false, error: shellGzipParseError(command, `unrecognized option ${arg}`) };
      }
    }

    for (let flagIndex = 1; flagIndex < arg.length; flagIndex++) {
      const flag = arg[flagIndex];
      switch (flag) {
        case "c":
          options.stdout = true;
          options.keep = true;
          break;
        case "d":
          options.decompress = true;
          break;
        case "f":
          options.force = true;
          break;
        case "k":
          options.keep = true;
          break;
        case "l":
          options.list = true;
          break;
        case "n":
          options.name = false;
          break;
        case "N":
          options.name = true;
          break;
        case "q":
          options.quiet = true;
          break;
        case "r":
          options.recursive = true;
          break;
        case "S": {
          const inline = arg.slice(flagIndex + 1);
          if (inline) {
            options.suffix = inline;
          } else {
            const value = args[index + 1];
            if (!value)
              return { ok: false, error: shellGzipParseError(command, "-S requires an argument") };
            options.suffix = value;
            index++;
          }
          flagIndex = arg.length;
          break;
        }
        case "t":
          options.test = true;
          break;
        case "v":
          options.verbose = true;
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
          options.level = Number(flag) as ShellGzipLevel;
          break;
        default:
          return { ok: false, error: shellGzipParseError(command, `invalid option -- '${flag}'`) };
      }
    }
  }

  return { ok: true, options, files };
}

async function runShellGzipTarget(
  ctx: CommandContext,
  target: string,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
): Promise<ExecResult> {
  const input = await readShellGzipTarget(ctx, target, options, command);
  if (!input.ok) return input.error;
  if (input.directory) return runShellGzipDirectory(ctx, input.path, options, command);

  if (options.decompress) {
    if (!input.stdin && !target.endsWith(options.suffix)) {
      return shellGzipDataError(command, target, "unknown suffix -- ignored", options);
    }
    if (!isGzipBytes(input.bytes))
      return shellGzipDataError(command, target, "not in gzip format", options);
    let output: Uint8Array;
    try {
      output = fflateGunzipSync(input.bytes);
    } catch (error) {
      return shellGzipDataError(command, target, shellErrorMessage(error), options);
    }
    if (options.stdout || input.stdin) return shellBytesExecResult(output);
    const outputPath = options.name
      ? ctx.fs.resolvePath(
          ctx.cwd,
          parseGzipHeader(input.bytes).originalName || target.slice(0, -options.suffix.length),
        )
      : input.path.slice(0, -options.suffix.length);
    const write = await writeShellGzipOutput(
      ctx,
      input.path,
      outputPath,
      output,
      options,
      command,
      target,
      input.bytes.length,
    );
    return write;
  }

  if (!input.stdin && target.endsWith(options.suffix)) {
    return shellGzipDataError(
      command,
      target,
      `already has ${options.suffix} suffix -- unchanged`,
      options,
    );
  }
  let output: Uint8Array;
  try {
    output = fflateGzipSync(
      input.bytes,
      options.level === undefined ? undefined : { level: options.level },
    );
  } catch (error) {
    return shellGzipDataError(command, target, shellErrorMessage(error), options);
  }
  if (options.stdout || input.stdin) return shellBytesExecResult(output);
  return writeShellGzipOutput(
    ctx,
    input.path,
    `${input.path}${options.suffix}`,
    output,
    options,
    command,
    target,
    input.bytes.length,
  );
}

async function runShellGzipDirectory(
  ctx: CommandContext,
  path: string,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
): Promise<ExecResult> {
  if (!options.recursive) {
    return shellGzipDataError(command, path, "is a directory -- ignored", options);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let stdoutKind: ExecResult["stdoutKind"] | undefined;
  let stdoutEncoding: ExecResult["stdoutEncoding"] | undefined;
  for (const name of await ctx.fs.readdir(path)) {
    const child = ctx.fs.resolvePath(path, name);
    const result = await runShellGzipTarget(ctx, child, options, command);
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) exitCode = result.exitCode;
    if (result.stdoutKind === "bytes") {
      stdoutKind = "bytes";
      stdoutEncoding = "binary";
    }
  }
  return { stdout, stderr, exitCode, stdoutKind, stdoutEncoding };
}

async function runShellGzipList(
  ctx: CommandContext,
  target: string,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
): Promise<ExecResult> {
  const input = await readShellGzipTarget(ctx, target, options, command);
  if (!input.ok) return input.error;
  if (input.directory)
    return runShellGzipDirectory(ctx, input.path, { ...options, list: true }, command);
  if (!isGzipBytes(input.bytes))
    return shellGzipDataError(command, target, "not in gzip format", options);
  const compressed = input.bytes.length;
  const uncompressed = gzipUncompressedSize(input.bytes);
  const ratio = uncompressed > 0 ? ((1 - compressed / uncompressed) * 100).toFixed(1) : "0.0";
  const name =
    parseGzipHeader(input.bytes).originalName ||
    (target === "-" ? "" : target.replace(new RegExp(`${escapeRegExp(options.suffix)}$`), ""));
  return {
    stdout: `${String(compressed).padStart(10)} ${String(uncompressed).padStart(10)} ${ratio.padStart(5)}% ${name}\n`,
    stderr: "",
    exitCode: 0,
  };
}

async function runShellGzipTest(
  ctx: CommandContext,
  target: string,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
): Promise<ExecResult> {
  const input = await readShellGzipTarget(ctx, target, options, command);
  if (!input.ok) return input.error;
  if (input.directory)
    return runShellGzipDirectory(ctx, input.path, { ...options, test: true }, command);
  if (!isGzipBytes(input.bytes))
    return shellGzipDataError(command, target, "not in gzip format", options);
  try {
    fflateGunzipSync(input.bytes);
    return { stdout: "", stderr: options.verbose ? `${target}:\tOK\n` : "", exitCode: 0 };
  } catch (error) {
    return shellGzipDataError(command, target, shellErrorMessage(error), options);
  }
}

async function writeShellGzipOutput(
  ctx: CommandContext,
  inputPath: string,
  outputPath: string,
  output: Uint8Array,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
  displayTarget: string,
  originalSize: number,
): Promise<ExecResult> {
  if (!options.force) {
    try {
      await ctx.fs.stat(outputPath);
      return {
        stdout: "",
        stderr: `${command}: ${outputPath} already exists; not overwritten\n`,
        exitCode: 1,
      };
    } catch {
      // Missing output path is the expected path.
    }
  }
  await ctx.fs.writeFile(outputPath, output);
  if (!options.keep) await ctx.fs.rm(inputPath);
  if (!options.verbose) return { stdout: "", stderr: "", exitCode: 0 };
  const ratio = originalSize > 0 ? ((1 - output.length / originalSize) * 100).toFixed(1) : "0.0";
  return {
    stdout: "",
    stderr: `${displayTarget}:\t${ratio}% -- replaced with ${basenameUserPath(shellPathToUserPath(outputPath, shellMountPathForContext(ctx)))}\n`,
    exitCode: 0,
  };
}

async function readShellGzipTarget(
  ctx: CommandContext,
  target: string,
  options: ShellGzipOptions,
  command: ShellGzipCommand,
): Promise<
  | { ok: true; stdin: true; directory: false; path: "-"; bytes: Uint8Array }
  | { ok: true; stdin: false; directory: false; path: string; bytes: Uint8Array }
  | { ok: true; stdin: false; directory: true; path: string; bytes: Uint8Array }
  | { ok: false; error: ExecResult }
> {
  if (target === "-" || target === "") {
    return {
      ok: true,
      stdin: true,
      directory: false,
      path: "-",
      bytes: shellByteStringToBytes(ctx.stdin),
    };
  }
  const path = ctx.fs.resolvePath(ctx.cwd, target);
  let stat: FsStat;
  try {
    stat = await ctx.fs.stat(path);
  } catch {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${command}: ${target}: No such file or directory\n`,
        exitCode: 1,
      },
    };
  }
  if (stat.isDirectory)
    return { ok: true, stdin: false, directory: true, path, bytes: new Uint8Array() };
  try {
    return {
      ok: true,
      stdin: false,
      directory: false,
      path,
      bytes: await readShellRawCommandFile(ctx, path),
    };
  } catch (error) {
    if (options.quiet) return { ok: false, error: { stdout: "", stderr: "", exitCode: 1 } };
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${command}: ${target}: ${shellErrorMessage(error)}\n`,
        exitCode: 1,
      },
    };
  }
}

async function readShellRawCommandFile(ctx: CommandContext, path: string): Promise<Uint8Array> {
  const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
  if (workspaceFs) return workspaceFs.readRawFileBuffer(path);
  return ctx.fs.readFileBuffer(path);
}

function shellBytesExecResult(bytes: Uint8Array): ExecResult {
  return {
    stdout: bytesToShellLatin1(bytes),
    stderr: "",
    exitCode: 0,
    stdoutKind: "bytes",
    stdoutEncoding: "binary",
  };
}

function shellByteStringToBytes(value: unknown): Uint8Array {
  const text = String(value || "");
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

export function normalizeShellWriteContent(
  content: FileContent,
  options?: ShellWriteFileOptions | BufferEncoding,
): FileContent {
  return typeof content === "string" && isShellBinaryEncoding(shellWriteEncoding(options))
    ? shellByteStringToBytes(content)
    : content;
}

export function shellWriteEncoding(
  options?: ShellWriteFileOptions | BufferEncoding,
): BufferEncoding | undefined {
  return typeof options === "string" ? options : options?.encoding;
}

export function isShellBinaryEncoding(encoding?: BufferEncoding | null): boolean {
  return encoding === "binary" || encoding === "latin1";
}

function bytesToShellLatin1(bytes: Uint8Array): string {
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return output;
}

function shellGzipDataError(
  command: ShellGzipCommand,
  target: string,
  message: string,
  options: ShellGzipOptions,
): ExecResult {
  return {
    stdout: "",
    stderr: options.quiet ? "" : `${command}: ${target}: ${message}\n`,
    exitCode: 1,
  };
}

function shellGzipParseError(command: ShellGzipCommand, message: string): ExecResult {
  return { stdout: "", stderr: `${command}: ${message}\n`, exitCode: 2 };
}

function shellGzipHelp(command: ShellGzipCommand): ExecResult {
  const usage =
    command === "gzip"
      ? "gzip [OPTION]... [FILE]..."
      : command === "gunzip"
        ? "gunzip [OPTION]... [FILE]..."
        : "zcat [OPTION]... [FILE]...";
  return {
    stdout: `${usage}\n  -c, --stdout      write to standard output\n  -d, --decompress  decompress\n  -k, --keep        keep input files\n  -l, --list        list compressed file contents\n  -t, --test        test compressed file integrity\n`,
    stderr: "",
    exitCode: 0,
  };
}

function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function gzipUncompressedSize(bytes: Uint8Array): number {
  if (bytes.length < 4) return 0;
  const index = bytes.length - 4;
  return (
    (bytes[index] |
      (bytes[index + 1] << 8) |
      (bytes[index + 2] << 16) |
      (bytes[index + 3] << 24)) >>>
    0
  );
}

function parseGzipHeader(bytes: Uint8Array): { originalName: string | null } {
  if (bytes.length < 10 || !isGzipBytes(bytes)) return { originalName: null };
  const flags = bytes[3];
  let index = 10;
  if (flags & 4) {
    if (index + 2 > bytes.length) return { originalName: null };
    index += 2 + (bytes[index] | (bytes[index + 1] << 8));
  }
  if (flags & 8) {
    const start = index;
    while (index < bytes.length && bytes[index] !== 0) index++;
    if (index < bytes.length) {
      return { originalName: new TextDecoder().decode(bytes.slice(start, index)) };
    }
  }
  return { originalName: null };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createShellCatCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("cat", async (args, ctx) => {
    const targets = args.length > 0 ? args : ["-"];
    let stdout = "";
    let stderr = "";
    for (const target of targets) {
      if (target === "-") {
        stdout += decodeShellByteString(ctx.stdin);
        continue;
      }
      try {
        stdout += await readShellTextTarget(ctx, target);
      } catch (error) {
        stderr += `cat: ${target}: ${shellErrorMessage(error)}\n`;
      }
    }
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

function createShellHeadCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("head", async (args, ctx) => {
    const parsed = parseShellLineLimitArgs(args, 10);
    if (!parsed.ok) return { stdout: "", stderr: `head: ${parsed.error}\n`, exitCode: 2 };
    return runShellLineCommand("head", parsed.files, ctx, (lines) => lines.slice(0, parsed.lines));
  });
}

function createShellTailCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("tail", async (args, ctx) => {
    const parsed = parseShellLineLimitArgs(args, 10);
    if (!parsed.ok) return { stdout: "", stderr: `tail: ${parsed.error}\n`, exitCode: 2 };
    return runShellLineCommand("tail", parsed.files, ctx, (lines) => lines.slice(-parsed.lines));
  });
}

async function runShellLineCommand(
  command: "head" | "tail",
  files: string[],
  ctx: CommandContext,
  select: (lines: string[]) => string[],
): Promise<ExecResult> {
  const targets = files.length > 0 ? files : ["-"];
  let stdout = "";
  let stderr = "";
  for (const target of targets) {
    try {
      const content =
        target === "-" ? decodeShellByteString(ctx.stdin) : await readShellTextTarget(ctx, target);
      const lines = splitShellTextLines(content);
      stdout += `${select(lines).join("\n")}\n`;
    } catch (error) {
      stderr += `${command}: ${target}: ${shellErrorMessage(error)}\n`;
    }
  }
  return { stdout, stderr, exitCode: stderr ? 1 : 0 };
}

function splitShellTextLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function readShellTextTarget(ctx: CommandContext, target: string): Promise<string> {
  const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
  const stat = await ctx.fs.stat(fullPath);
  if (stat.isDirectory) throw new Error("Is a directory");
  return ctx.fs.readFile(fullPath);
}

type ShellLineLimitParseResult =
  { ok: true; lines: number; files: string[] } | { ok: false; error: string };

function parseShellLineLimitArgs(args: string[], defaultLines: number): ShellLineLimitParseResult {
  const files: string[] = [];
  let lines = defaultLines;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      files.push(...args.slice(index + 1));
      break;
    }
    if (arg === "-n" || arg === "--lines") {
      const value = args[++index];
      if (!value) return { ok: false, error: `${arg} requires a line count` };
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0)
        return { ok: false, error: `invalid line count: ${value}` };
      lines = parsed;
      continue;
    }
    if (arg.startsWith("-n") && arg.length > 2) {
      const parsed = Number(arg.slice(2));
      if (!Number.isInteger(parsed) || parsed < 0)
        return { ok: false, error: `invalid line count: ${arg.slice(2)}` };
      lines = parsed;
      continue;
    }
    if (/^-\d+$/.test(arg)) {
      lines = Number(arg.slice(1));
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, error: `unsupported option ${arg}` };
    files.push(arg);
  }
  return { ok: true, lines, files };
}

function createShellGrepCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("grep", async (args, ctx) => {
    const parsed = parseShellGrepArgs(args, "grep");
    if (parsed.ok === false) return parsed.error;
    const { pattern, files, flags } = parsed;
    if (flags.recursive) {
      return runShellRecursiveGrepCommand("grep", pattern, files, flags, ctx);
    }
    return runShellExplicitGrepCommand("grep", pattern, files, flags, ctx);
  });
}

async function runShellRecursiveGrepCommand(
  command: "grep" | "fgrep" | "egrep",
  pattern: string,
  files: string[],
  flags: ShellGrepFlags,
  ctx: CommandContext,
): Promise<ExecResult> {
  const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
  if (!workspaceFs) {
    return {
      stdout: "",
      stderr: `${command}: a mounted User Space directory is required\n`,
      exitCode: 2,
    };
  }
  const targets = files.length > 0 ? files : ["."];
  let stdout = "";
  let stderr = "";
  let matchedAny = false;

  for (const target of targets) {
    const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
    let stat: FsStat;
    try {
      stat = await ctx.fs.stat(fullPath);
    } catch (error) {
      stderr += `${command}: ${target}: ${shellErrorMessage(error)}\n`;
      continue;
    }
    if (!stat.isDirectory) {
      const explicit = await runShellExplicitGrepCommand(
        command,
        pattern,
        [target],
        { ...flags, recursive: false },
        ctx,
      );
      stdout += explicit.stdout;
      stderr += explicit.stderr;
      if (explicit.exitCode === 0) matchedAny = true;
      continue;
    }

    const result = await workspaceFs.searchIndexedContent({
      query: pattern,
      mode: flags.fixed ? "text" : "regex",
      path: fullPath,
      ignoreCase: flags.ignoreCase,
      invert: flags.invert,
      limit: Number.MAX_SAFE_INTEGER,
      contextLines: 0,
    });
    const counts = new Map<string, number>();
    for (const match of result.matches) counts.set(match.path, (counts.get(match.path) ?? 0) + 1);
    if (counts.size > 0) matchedAny = true;
    if (flags.quiet && counts.size > 0) return { stdout: "", stderr, exitCode: stderr ? 2 : 0 };
    if (flags.filesWithMatches) {
      stdout += [...counts.keys()].map((path) => `${path}\n`).join("");
      continue;
    }
    if (flags.count) {
      stdout += [...counts]
        .map(([path, count]) => `${flags.noFilename ? "" : `${path}:`}${count}\n`)
        .join("");
      continue;
    }
    for (const match of result.matches) {
      const prefix = [
        flags.noFilename ? "" : match.path,
        flags.lineNumber ? String(match.lineNumber) : "",
      ]
        .filter(Boolean)
        .join(":");
      stdout += `${prefix ? `${prefix}:` : ""}${match.line}\n`;
    }
  }

  return { stdout, stderr, exitCode: stderr ? 2 : matchedAny ? 0 : 1 };
}

async function runShellExplicitGrepCommand(
  command: "grep" | "fgrep" | "egrep",
  pattern: string,
  files: string[],
  flags: ShellGrepFlags,
  ctx: CommandContext,
): Promise<ExecResult> {
  const matcher = createShellGrepMatcher(pattern, flags);
  const targets = files.length > 0 ? files : ["-"];

  let stdout = "";
  let stderr = "";
  let matchedAny = false;
  let hadError = false;
  const showFilename = targets.length > 1 && !flags.noFilename;

  for (const target of targets) {
    let content: string;
    if (target === "-") {
      content = decodeShellByteString(ctx.stdin);
    } else {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          stderr += `${command}: ${target}: Is a directory\n`;
          hadError = true;
          continue;
        }
        content = await ctx.fs.readFile(fullPath);
      } catch (error) {
        stderr += `${command}: ${target}: ${shellErrorMessage(error)}\n`;
        hadError = true;
        continue;
      }
    }

    const lines = content.split(/\r?\n/);
    let matchCount = 0;
    const outputLines: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const hit = matcher(line);
      const selected = flags.invert ? !hit : hit;
      if (!selected) continue;
      matchCount++;
      if (flags.quiet) return { stdout: "", stderr: "", exitCode: 0 };
      if (flags.count || flags.filesWithMatches) continue;
      const prefix = [showFilename ? target : "", flags.lineNumber ? String(index + 1) : ""]
        .filter(Boolean)
        .join(":");
      outputLines.push(prefix ? `${prefix}:${line}` : line);
    }

    if (matchCount > 0) matchedAny = true;
    if (flags.filesWithMatches && matchCount > 0 && target !== "-") {
      stdout += `${target}\n`;
    } else if (flags.count) {
      const countLine =
        showFilename && target !== "-" ? `${target}:${matchCount}` : String(matchCount);
      stdout += `${countLine}\n`;
    } else if (outputLines.length > 0) {
      stdout += `${outputLines.join("\n")}\n`;
    }
  }

  return {
    stdout,
    stderr,
    exitCode: hadError ? 2 : matchedAny ? 0 : 1,
  };
}

function createShellGrepAliasCommand(
  justBash: JustBashBrowserModule,
  name: "fgrep" | "egrep",
  defaults: { fixed: boolean },
): Command {
  return justBash.defineCommand(name, async (args, ctx) => {
    const parsed = parseShellGrepArgs(args, name);
    if (parsed.ok === false) return parsed.error;
    parsed.flags.fixed = defaults.fixed;
    return parsed.flags.recursive
      ? runShellRecursiveGrepCommand(name, parsed.pattern, parsed.files, parsed.flags, ctx)
      : runShellExplicitGrepCommand(name, parsed.pattern, parsed.files, parsed.flags, ctx);
  });
}

function createShellTreeCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("tree", async (args, ctx) => {
    const parsed = parseShellTreeArgs(args);
    if (!parsed.ok) return parsed.error;
    let stdout = "";
    let stderr = "";
    let dirCount = 0;
    let fileCount = 0;
    for (const target of parsed.targets) {
      const root = ctx.fs.resolvePath(ctx.cwd, target);
      try {
        const stat = await ctx.fs.stat(root);
        if (!stat.isDirectory) {
          stdout += `${target}\n`;
          fileCount++;
          continue;
        }
        const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
        await workspaceFs?.indexSubtree(root, parsed.maxDepth ?? undefined);
        stdout += `${target}\n`;
        const result = await renderShellTree(
          ctx,
          root,
          "",
          0,
          parsed.maxDepth,
          parsed.directoriesOnly,
        );
        stdout += result.output;
        dirCount += result.dirCount;
        fileCount += result.fileCount;
      } catch (error) {
        stderr += `tree: ${target}: ${shellErrorMessage(error)}\n`;
      }
    }
    stdout += `\n${dirCount} director${dirCount === 1 ? "y" : "ies"}`;
    if (!parsed.directoriesOnly) stdout += `, ${fileCount} file${fileCount === 1 ? "" : "s"}`;
    stdout += "\n";
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

function createShellFindCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("find", async (args, ctx) => {
    const parsed = parseShellFindArgs(args);
    if (!parsed.ok) return parsed.error;
    let stdout = "";
    let stderr = "";
    for (const target of parsed.targets) {
      try {
        const root = ctx.fs.resolvePath(ctx.cwd, target);
        const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
        await workspaceFs?.indexSubtree(root, parsed.maxDepth ?? undefined);
        const rows = await collectShellFindRows(ctx, root, target, parsed);
        stdout += rows.map((row) => row.display).join("");
      } catch (error) {
        stderr += `find: ${target}: ${shellErrorMessage(error)}\n`;
      }
    }
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

type ShellFindFilter = {
  maxDepth: number | null;
  minDepth: number;
  kind: "file" | "directory" | null;
  namePattern: RegExp | null;
  pathPattern: RegExp | null;
};

type ShellFindParseResult =
  | {
      ok: true;
      targets: string[];
      maxDepth: number | null;
      minDepth: number;
      kind: "file" | "directory" | null;
      namePattern: RegExp | null;
      pathPattern: RegExp | null;
    }
  | { ok: false; error: ExecResult };

function parseShellFindArgs(args: string[]): ShellFindParseResult {
  const targets: string[] = [];
  const filter: ShellFindFilter = {
    maxDepth: null,
    minDepth: 0,
    kind: null,
    namePattern: null,
    pathPattern: null,
  };
  let parsingTargets = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (parsingTargets && !arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")") {
      targets.push(arg);
      continue;
    }
    parsingTargets = false;
    switch (arg) {
      case "-print":
        break;
      case "-maxdepth": {
        const value = Number(args[++index]);
        if (!Number.isFinite(value) || value < 0)
          return shellExecParseError("find: -maxdepth requires a non-negative number");
        filter.maxDepth = Math.floor(value);
        break;
      }
      case "-mindepth": {
        const value = Number(args[++index]);
        if (!Number.isFinite(value) || value < 0)
          return shellExecParseError("find: -mindepth requires a non-negative number");
        filter.minDepth = Math.floor(value);
        break;
      }
      case "-type": {
        const value = args[++index];
        if (value === "f") filter.kind = "file";
        else if (value === "d") filter.kind = "directory";
        else return shellExecParseError("find: user-space v1 supports only -type f and -type d");
        break;
      }
      case "-name":
        filter.namePattern = shellGlobToRegex(args[++index] || "");
        break;
      case "-iname":
        filter.namePattern = shellGlobToRegex(args[++index] || "", true);
        break;
      case "-path":
        filter.pathPattern = shellGlobToRegex(args[++index] || "");
        break;
      case "-ipath":
        filter.pathPattern = shellGlobToRegex(args[++index] || "", true);
        break;
      case "-exec":
      case "-execdir":
      case "-delete":
      case "-ok":
      case "-okdir":
        return shellExecParseError(`find: ${arg} is not available in user-space v1`);
      default:
        return shellExecParseError(`find: unsupported option ${arg}`);
    }
  }
  return { ok: true, targets: targets.length > 0 ? targets : ["."], ...filter };
}

async function collectShellFindRows(
  ctx: CommandContext,
  root: string,
  displayRoot: string,
  filter: ShellFindFilter,
): Promise<Array<{ display: string }>> {
  const rows: Array<{ display: string }> = [];
  const normalizedRoot = normalizeShellPath(root, "/");
  const rootStat = await ctx.fs.stat(normalizedRoot);
  await visitShellFindPath(ctx, normalizedRoot, displayRoot || ".", rootStat, 0, filter, rows);
  return rows;
}

async function visitShellFindPath(
  ctx: CommandContext,
  path: string,
  displayPath: string,
  stat: FsStat,
  depth: number,
  filter: ShellFindFilter,
  rows: Array<{ display: string }>,
): Promise<void> {
  const kind = stat.isDirectory ? "directory" : "file";
  if (
    depth >= filter.minDepth &&
    shellFindMatches(
      displayPath,
      basenameUserPath(normalizeShellPath(path, "/")) || displayPath,
      kind,
      filter,
    )
  ) {
    rows.push({ display: `${displayPath}\n` });
  }
  if (!stat.isDirectory) return;
  if (filter.maxDepth !== null && depth >= filter.maxDepth) return;
  const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
  const entries = workspaceFs
    ? (await workspaceFs.listEntries(path, workspaceFs.includeHiddenForFind())).map(
        indexedEntryToShellDirent,
      )
    : (await ctx.fs.readdirWithFileTypes?.(path)) || [];
  for (const entry of entries) {
    const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    const childDisplay =
      displayPath === "." ? `./${entry.name}` : `${displayPath.replace(/\/$/, "")}/${entry.name}`;
    await visitShellFindPath(
      ctx,
      childPath,
      childDisplay,
      {
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
        mode: entry.isDirectory ? 0o755 : 0o644,
        size: 0,
        mtime: new Date(0),
      },
      depth + 1,
      filter,
      rows,
    );
  }
}

function shellFindMatches(
  displayPath: string,
  name: string,
  kind: "file" | "directory",
  filter: ShellFindFilter,
): boolean {
  if (filter.kind && filter.kind !== kind) return false;
  if (filter.namePattern && !filter.namePattern.test(name)) return false;
  if (filter.pathPattern && !filter.pathPattern.test(displayPath)) return false;
  return true;
}

function shellGlobToRegex(pattern: string, ignoreCase = false): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, ignoreCase ? "i" : "");
}

function createShellFileCommand(justBash: JustBashBrowserModule): Command {
  return justBash.defineCommand("file", async (args, ctx) => {
    if (args.length === 0) {
      return { stdout: "", stderr: "file: missing operand\n", exitCode: 1 };
    }
    let stdout = "";
    let stderr = "";
    for (const target of args) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, target);
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          stdout += `${target}: directory\n`;
          continue;
        }
        const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
        const entry = workspaceFs ? await workspaceFs.findEntry(fullPath) : null;
        stdout += `${target}: ${shellFileDescription(entry?.previewKind)}\n`;
      } catch (error) {
        stderr += `file: ${target}: ${shellErrorMessage(error)}\n`;
      }
    }
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

function shellFileDescription(kind?: IndexedWorkspaceEntry["previewKind"]): string {
  switch (kind) {
    case "text":
      return "UTF-8 text";
    case "image":
      return "image";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "pdf":
      return "PDF document";
    case "office":
      return "office document";
    case "binary":
      return "binary data";
    default:
      return "regular file";
  }
}

type ShellTreeParseResult =
  | { ok: true; targets: string[]; maxDepth: number | null; directoriesOnly: boolean }
  | { ok: false; error: ExecResult };

function parseShellTreeArgs(args: string[]): ShellTreeParseResult {
  const targets: string[] = [];
  let maxDepth: number | null = null;
  let directoriesOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-L") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value < 0)
        return shellExecParseError("tree: -L requires a non-negative depth");
      maxDepth = Math.floor(value);
      continue;
    }
    if (arg.startsWith("-L") && arg.length > 2) {
      const value = Number(arg.slice(2));
      if (!Number.isFinite(value) || value < 0)
        return shellExecParseError("tree: -L requires a non-negative depth");
      maxDepth = Math.floor(value);
      continue;
    }
    if (arg === "-d") {
      directoriesOnly = true;
      continue;
    }
    if (arg === "-a" || arg === "-f") {
      continue;
    }
    if (arg.startsWith("-")) return shellExecParseError(`tree: unsupported option ${arg}`);
    targets.push(arg);
  }
  return { ok: true, targets: targets.length > 0 ? targets : ["."], maxDepth, directoriesOnly };
}

async function renderShellTree(
  ctx: CommandContext,
  path: string,
  prefix: string,
  depth: number,
  maxDepth: number | null,
  directoriesOnly: boolean,
): Promise<{ output: string; dirCount: number; fileCount: number }> {
  if (maxDepth !== null && depth >= maxDepth) return { output: "", dirCount: 0, fileCount: 0 };
  const workspaceFs = asUserSpaceShellFileSystem(ctx.fs);
  const entries = workspaceFs
    ? (await workspaceFs.listEntries(path, workspaceFs.includeHiddenForTree())).map(
        indexedEntryToShellDirent,
      )
    : (await ctx.fs.readdirWithFileTypes?.(path)) || [];
  const visible = entries
    .filter((entry) => !directoriesOnly || entry.isDirectory)
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  let output = "";
  let dirCount = 0;
  let fileCount = 0;
  for (let index = 0; index < visible.length; index++) {
    const entry = visible[index];
    const isLast = index === visible.length - 1;
    const connector = isLast ? "`-- " : "|-- ";
    output += `${prefix}${connector}${entry.name}${entry.isDirectory ? "/" : ""}\n`;
    if (entry.isDirectory) {
      dirCount++;
      const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      const child = await renderShellTree(
        ctx,
        childPath,
        `${prefix}${isLast ? "    " : "|   "}`,
        depth + 1,
        maxDepth,
        directoriesOnly,
      );
      output += child.output;
      dirCount += child.dirCount;
      fileCount += child.fileCount;
    } else {
      fileCount++;
    }
  }
  return { output, dirCount, fileCount };
}

type ShellGrepFlags = {
  ignoreCase: boolean;
  fixed: boolean;
  invert: boolean;
  lineNumber: boolean;
  count: boolean;
  filesWithMatches: boolean;
  quiet: boolean;
  noFilename: boolean;
  recursive: boolean;
};

type ShellGrepParseResult =
  | { ok: true; pattern: string; files: string[]; flags: ShellGrepFlags }
  | { ok: false; error: ExecResult };

function parseShellGrepArgs(args: string[], command = "grep"): ShellGrepParseResult {
  const flags: ShellGrepFlags = {
    ignoreCase: false,
    fixed: false,
    invert: false,
    lineNumber: false,
    count: false,
    filesWithMatches: false,
    quiet: false,
    noFilename: false,
    recursive: false,
  };
  const files: string[] = [];
  let pattern: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      const rest = args.slice(index + 1);
      if (pattern === null) pattern = rest.shift() || null;
      files.push(...rest);
      break;
    }
    if (arg === "-e") {
      pattern = args[++index] || "";
      continue;
    }
    if (arg === "-r" || arg === "-R" || arg === "--recursive") {
      flags.recursive = true;
      continue;
    }
    if (arg.startsWith("--")) {
      switch (arg) {
        case "--ignore-case":
          flags.ignoreCase = true;
          continue;
        case "--fixed-strings":
          flags.fixed = true;
          continue;
        case "--invert-match":
          flags.invert = true;
          continue;
        case "--line-number":
          flags.lineNumber = true;
          continue;
        case "--count":
          flags.count = true;
          continue;
        case "--files-with-matches":
          flags.filesWithMatches = true;
          continue;
        case "--quiet":
        case "--silent":
          flags.quiet = true;
          continue;
        case "--no-filename":
          flags.noFilename = true;
          continue;
        default:
          return shellParseError(`${command}: unsupported option ${arg}`);
      }
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (const flag of arg.slice(1)) {
        switch (flag) {
          case "i":
            flags.ignoreCase = true;
            break;
          case "F":
            flags.fixed = true;
            break;
          case "v":
            flags.invert = true;
            break;
          case "n":
            flags.lineNumber = true;
            break;
          case "c":
            flags.count = true;
            break;
          case "l":
            flags.filesWithMatches = true;
            break;
          case "q":
            flags.quiet = true;
            break;
          case "h":
            flags.noFilename = true;
            break;
          case "r":
          case "R":
            flags.recursive = true;
            break;
          default:
            return shellParseError(`${command}: unsupported option -${flag}`);
        }
      }
      continue;
    }
    if (pattern === null) {
      pattern = arg;
    } else {
      files.push(arg);
    }
  }

  if (pattern === null) return shellParseError(`${command}: missing pattern`);
  return { ok: true, pattern, files, flags };
}

function shellParseError(message: string): ShellGrepParseResult {
  return { ok: false, error: { stdout: "", stderr: `${message}\n`, exitCode: 2 } };
}

function shellExecParseError(message: string): { ok: false; error: ExecResult } {
  return { ok: false, error: { stdout: "", stderr: `${message}\n`, exitCode: 2 } };
}

function createShellGrepMatcher(pattern: string, flags: ShellGrepFlags): (line: string) => boolean {
  if (flags.fixed) {
    const needle = flags.ignoreCase ? pattern.toLowerCase() : pattern;
    return (line) => (flags.ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, flags.ignoreCase ? "i" : "");
  return (line) => regex.test(line);
}

function validateShellScript(script: string): string | null {
  if (
    /\bsed\b[^\n;&|]*(?:^|\s)-i\S*(?:\s|$)/.test(script) ||
    /\bsed\b[^\n;&|]*\s--in-place(?:\s|$)/.test(script)
  ) {
    return "sed -i is not available for user-space v1. Use user-space edit or write for explicit edits.";
  }
  if (/\bawk\b[\s\S]*\bsystem\s*\(/.test(script)) {
    return "awk system() is not available for user-space v1.";
  }
  return null;
}

export function shellMountPathForName(name: string): string {
  const normalized = name
    .trim()
    .replace(/\//g, "-")
    .replace(/^\/+|\/+$/g, "");
  return `/${normalized || DEFAULT_USER_SPACE_SHELL_MOUNT_NAME}`;
}

function shellMountPathForContext(ctx: CommandContext): string {
  const fs = asUserSpaceShellFileSystem(ctx.fs);
  return fs?.shellMountPath ?? shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME);
}

export function userPathToShellPath(
  path: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): string {
  const normalized = normalizeRelativeUserPath(path);
  if (!normalized) return shellMountPath;
  return shellMountPath === "/" ? `/${normalized}` : `${shellMountPath}/${normalized}`;
}

export function shellPathToUserPath(
  path: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): string {
  const normalized = normalizeShellPath(path, shellMountPath);
  if (normalized === shellMountPath) return "";
  if (shellMountPath === "/") return normalizeRelativeUserPath(normalized.slice(1));
  if (normalized.startsWith(`${shellMountPath}/`)) {
    return normalizeRelativeUserPath(normalized.slice(shellMountPath.length + 1));
  }
  throw new Error(`Path is outside ${shellMountPath}.`);
}

export function normalizeShellCwdInput(
  cwd: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): string {
  const raw = cwd.trim();
  if (!raw) return shellMountPath;
  if (raw === LEGACY_USER_SPACE_SHELL_HOME_PATH) return shellMountPath;
  if (raw.startsWith(`${LEGACY_USER_SPACE_SHELL_HOME_PATH}/`)) {
    return userPathToShellPath(
      raw.slice(LEGACY_USER_SPACE_SHELL_HOME_PATH.length + 1),
      shellMountPath,
    );
  }
  const normalized = normalizeShellPath(raw, shellMountPath);
  if (isShellVirtualRoot(normalized, shellMountPath)) return "/";
  if (isShellPathInUserSpace(normalized, shellMountPath)) return normalized;
  return userPathToShellPath(raw, shellMountPath);
}

export function isShellPathInUserSpace(
  path: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): boolean {
  const normalized = normalizeShellPath(path, shellMountPath);
  if (shellMountPath === "/") return normalized.startsWith("/");
  return normalized === shellMountPath || normalized.startsWith(`${shellMountPath}/`);
}

export function isShellVirtualRoot(
  path: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): boolean {
  return shellMountPath !== "/" && normalizeShellPath(path, shellMountPath) === "/";
}

export function isShellMountRoot(
  path: string,
  shellMountPath = shellMountPathForName(DEFAULT_USER_SPACE_SHELL_MOUNT_NAME),
): boolean {
  return normalizeShellPath(path, shellMountPath) === shellMountPath;
}

export function normalizeShellPath(path: string, base: string): string {
  const raw = path.replace(/\\/g, "/").trim();
  const combined = raw.startsWith("/") ? raw : `${base || "/"}/${raw || "."}`;
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function normalizeRelativeUserPath(path: string): string {
  const raw = path.replace(/\\/g, "/").trim();
  if (!raw || raw === ".") return "";
  if (raw.startsWith("/")) {
    throw new Error(uiCopy.userSpace.runtimeErrors.absolutePathUnsupported);
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw new Error("Path traversal outside the mounted directory is not allowed.");
    }
    parts.push(part);
  }
  return parts.join("/");
}

function basenameUserPath(path: string): string {
  const parts = path ? path.split("/") : [];
  return parts[parts.length - 1] || "";
}

function indexedEntryToShellDirent(entry: IndexedWorkspaceEntry): {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
} {
  return {
    name: entry.name,
    isFile: entry.kind === "file",
    isDirectory: entry.kind === "directory",
    isSymbolicLink: false,
  };
}

function decodeShellByteString(value: unknown): string {
  const text = String(value || "");
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0xff) return text;
  }
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

function shellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalFiniteNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}
