#!/usr/bin/env bun
import { isAbsolute } from "node:path";
import { formatUserSpaceBashCapabilities } from "../src/user-space-shell-contract.js";

interface UserSpaceInfo {
  name: string;
  rootName: string;
  status: string;
  canRead?: boolean;
  canWrite?: boolean;
}

interface WorkspaceRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const CLI_NAME = "user-space";
const INTERNAL_FILE_TRANSPORT_HOST = "user-space.piwork.internal";
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const args = process.argv.slice(2);

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const [tool, ...argv] = args;
  if (!tool || tool === "--help" || tool === "-h") {
    printHelp();
    return;
  }

  switch (tool) {
    case "read":
      await readUserSpaceFile(argv);
      return;
    case "write":
      await writeUserSpaceFile(argv);
      return;
    case "edit":
      await editUserSpaceText(argv);
      return;
    case "bash":
      await runPiBashTool(argv);
      return;
    default:
      throw new Error(
        `Unknown User Space tool: ${tool}. The public surface is limited to read, write, edit, and bash.\n\n${helpText()}`,
      );
  }
}

async function readUserSpaceFile(argv: string[]): Promise<void> {
  const target = await resolvePathCommand(
    argv,
    `Usage: ${CLI_NAME} read rootName/path [--offset N] [--limit N]`,
  );
  const options = parseValueOptions(target.rest, ["--offset", "--limit"]);
  const offset = parsePositiveInteger(options.get("--offset"), "--offset");
  const limit = parsePositiveInteger(options.get("--limit"), "--limit");
  const result = (await workspaceOperation("read_file", { path: target.path, offset, limit })) as {
    content?: string;
  };
  if (typeof result.content === "string") {
    process.stdout.write(result.content);
    if (!result.content.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function writeUserSpaceFile(argv: string[]): Promise<void> {
  const target = await resolvePathCommand(
    argv,
    `Usage: ${CLI_NAME} write rootName/path (--content <text> | < stdin)`,
  );
  if (target.space.canWrite !== true) {
    throw new Error(
      `user-space "${target.space.name}" is mounted read-only; writing is unavailable.`,
    );
  }
  const options = parseValueOptions(target.rest, ["--content"]);
  const content = options.has("--content")
    ? options.get("--content")
    : await readStdinIfAvailable();
  if (content === undefined) {
    throw new Error(
      `write requires --content or stdin. Example: printf 'hello\\n' | ${CLI_NAME} write rootName/notes/hello.txt`,
    );
  }
  const result = await workspaceOperation("write_file", {
    path: target.path,
    content,
    createParents: true,
  });
  const message =
    result &&
    typeof result === "object" &&
    typeof (result as { message?: unknown }).message === "string"
      ? (result as { message: string }).message
      : `Successfully wrote ${content.length} bytes to ${target.path}`;
  console.log(message);
}

async function editUserSpaceText(argv: string[]): Promise<void> {
  const usage = `Usage: ${CLI_NAME} edit rootName/path --edits '[{"oldText":"before","newText":"after"}]'`;
  const target = await resolvePathCommand(argv, usage);
  if (target.space.canWrite !== true) {
    throw new Error(
      `user-space "${target.space.name}" is mounted read-only; editing is unavailable.`,
    );
  }
  const options = parseValueOptions(target.rest, ["--edits"]);
  const edits = options.get("--edits");
  if (edits === undefined) throw new Error(usage);
  const result = await workspaceOperation("replace_text", { path: target.path, edits });
  const message =
    result &&
    typeof result === "object" &&
    typeof (result as { message?: unknown }).message === "string"
      ? (result as { message: string }).message
      : `Successfully replaced text in ${target.path}.`;
  console.log(message);
}

async function runPiBashTool(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(`${bashUsage()}\n\n${formatUserSpaceBashCapabilities()}`);
    return;
  }
  if (argv[0] === "--capabilities") {
    if (argv.length !== 1)
      throw new Error(`${bashUsage()}\n--capabilities does not accept other arguments.`);
    console.log(formatUserSpaceBashCapabilities());
    return;
  }
  if (argv[0] !== "--command" || argv.length < 2) throw new Error(bashUsage());
  const command = argv[1];
  const options = parseValueOptions(argv.slice(2), ["--timeout"]);
  const timeoutSeconds = parseFiniteNumber(options.get("--timeout"), "--timeout");
  if (
    timeoutSeconds !== undefined &&
    (timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_SECONDS)
  ) {
    throw new Error(
      timeoutSeconds > MAX_TIMEOUT_SECONDS
        ? `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`
        : "Invalid timeout: must be a finite number of seconds",
    );
  }

  await requireActiveUserSpace();
  const result = (await workspaceOperation("shell_exec", {
    cwd: "/",
    script: command,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
  })) as { stdout?: string; stderr?: string; exitCode?: number };
  const raw = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n");
  const output = truncatePiBashTail(raw);
  let text = output.content || "(no output)";
  if (output.truncated) {
    const startLine = output.totalLines - output.outputLines + 1;
    const range = output.lastLinePartial
      ? `Showing the tail of line ${output.totalLines}`
      : `Showing lines ${startLine}-${output.totalLines} of ${output.totalLines}`;
    text += `\n\n[${range}. Output was truncated; rerun a narrower command. Full output is not exposed as a host path.]`;
  }
  if ((result.exitCode ?? 0) !== 0)
    throw new Error(`${text}\n\nCommand exited with code ${result.exitCode}`);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function truncatePiBashTail(content: string): {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
  lastLinePartial: boolean;
} {
  const maxLines = 2000;
  const maxBytes = 50 * 1024;
  const lines = content
    ? content.endsWith("\n")
      ? content.slice(0, -1).split("\n")
      : content.split("\n")
    : [];
  const totalLines = lines.length;
  if (totalLines <= maxLines && Buffer.byteLength(content, "utf-8") <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      outputLines: totalLines,
      lastLinePartial: false,
    };
  }

  const output: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let index = lines.length - 1; index >= 0 && output.length < maxLines; index -= 1) {
    const lineBytes = Buffer.byteLength(lines[index], "utf-8") + (output.length > 0 ? 1 : 0);
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (output.length === 0) {
        const buffer = Buffer.from(lines[index], "utf-8");
        let start = Math.max(0, buffer.length - maxBytes);
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
        output.unshift(buffer.subarray(start).toString("utf-8"));
        lastLinePartial = true;
      }
      break;
    }
    output.unshift(lines[index]);
    bytes += lineBytes;
  }
  return {
    content: output.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines,
    outputLines: output.length,
    lastLinePartial,
  };
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function envFlag(name: string): boolean {
  const value = envValue(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function apiBase(): string {
  const configuredBase = envValue("PIWORK_USER_SPACE_API_BASE");
  if (configuredBase) return configuredBase.replace(/\/+$/, "");
  const sessionId = envValue("PIWORK_USER_SPACE_SESSION_ID") || envValue("PIWORK_SESSION_ID");
  const port = envValue("PORT") || "3456";
  if (!sessionId) throw new Error("PIWORK_USER_SPACE_SESSION_ID is not set.");
  return `http://127.0.0.1:${port}/internal/user-space-transfer/${encodeURIComponent(sessionId)}`;
}

function isProtectedSandboxApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === INTERNAL_FILE_TRANSPORT_HOST &&
      /^\/internal\/user-space-transfer\/[a-f0-9-]+$/i.test(url.pathname) &&
      Boolean(url.port) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function fetchJson(url: string, init?: WorkspaceRequestInit): Promise<unknown> {
  const token = envValue("PIWORK_USER_SPACE_API_TOKEN");
  if (!token) throw new Error("PIWORK_USER_SPACE_API_TOKEN is not set.");
  const authenticatedInit: WorkspaceRequestInit = {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  };
  const socketPath = envValue("PIWORK_USER_SPACE_API_UNIX");
  if (envFlag("SANDBOX_RUNTIME") && !socketPath && !isProtectedSandboxApiBase(apiBase())) {
    throw new Error("A protected User Space transport is required inside the session sandbox.");
  }
  if (socketPath && (!isAbsolute(socketPath) || socketPath.includes("\0"))) {
    throw new Error("PIWORK_USER_SPACE_API_UNIX must be an absolute Unix socket path.");
  }
  const requestInit: WorkspaceRequestInit & { unix?: string } = {
    ...authenticatedInit,
    ...(socketPath ? { unix: socketPath } : {}),
  };
  const response = await fetch(url, requestInit);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { error?: unknown }) : {};
  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : `Request failed: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

async function workspaceOperation(
  operation: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  return fetchJson(`${apiBase()}/operation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, input: stripUndefined(input) }),
  });
}

async function requireActiveUserSpace(): Promise<UserSpaceInfo> {
  const response = (await fetchJson(`${apiBase()}/mounts`)) as {
    user_space?: {
      name?: unknown;
      rootName?: unknown;
      status?: unknown;
      canRead?: unknown;
      canWrite?: unknown;
    } | null;
  };
  const space = response.user_space;
  if (!space)
    throw new Error(
      "No mounted user-space is available. Add or re-authorize a directory in the browser.",
    );
  const info: UserSpaceInfo = {
    name:
      typeof space.name === "string"
        ? space.name
        : typeof space.rootName === "string"
          ? space.rootName
          : "user-space",
    rootName:
      typeof space.rootName === "string"
        ? space.rootName
        : typeof space.name === "string"
          ? space.name
          : "user-space",
    status: typeof space.status === "string" ? space.status : "expected",
    canRead: space.canRead !== false,
    canWrite: space.canWrite === true,
  };
  if (info.status !== "mounted" || info.canRead === false) {
    throw new Error(`user-space "${info.name}" is ${info.status}; re-authorize it in the browser.`);
  }
  return info;
}

async function resolvePathCommand(
  argv: string[],
  usage: string,
): Promise<{ path: string; rest: string[]; space: UserSpaceInfo }> {
  const target = argv[0];
  if (!target) throw new Error(usage);
  const space = await requireActiveUserSpace();
  return {
    path: resolveRootQualifiedPath(target, space.rootName),
    rest: argv.slice(1),
    space,
  };
}

function resolveRootQualifiedPath(value: string, rootName: string): string {
  const raw = value.trim();
  if (!raw || raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("user-space:/")) {
    throw rootQualifiedPathError(rootName);
  }
  if (raw.includes("\\") || /^[^/]+:\//.test(raw)) throw rootQualifiedPathError(rootName);
  const parts = raw.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0] !== rootName ||
    parts.length < 2
  ) {
    throw rootQualifiedPathError(rootName);
  }
  return parts.slice(1).join("/");
}

function rootQualifiedPathError(rootName: string): Error {
  return new Error(
    `User Space paths must include the active root name and must not start with '/'. Example: ${rootName}/notes/a.txt`,
  );
}

function parseValueOptions(argv: string[], allowed: string[]): Map<string, string> {
  const allowedSet = new Set(allowed);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowedSet.has(option)) throw new Error(`Unsupported option: ${option}`);
    if (values.has(option)) throw new Error(`Option may only be provided once: ${option}`);
    if (index + 1 >= argv.length) throw new Error(`${option} requires a value.`);
    values.set(option, argv[++index]);
  }
  return values;
}

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function parseFiniteNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number.`);
  return parsed;
}

async function readStdinIfAvailable(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function bashUsage(): string {
  return `Usage: ${CLI_NAME} bash --command <command> [--timeout N]`;
}

function helpText(): string {
  return [
    "Usage:",
    `  ${CLI_NAME} read rootName/path [--offset N] [--limit N]`,
    `  printf 'text\\n' | ${CLI_NAME} write rootName/path`,
    `  ${CLI_NAME} write rootName/path --content <text>`,
    `  ${CLI_NAME} edit rootName/path --edits '<json-array>'`,
    `  ${CLI_NAME} bash --command <command> [--timeout N]`,
    `  ${CLI_NAME} bash --capabilities`,
    "",
    "Only read, write, edit, and bash are public tools.",
    "read/write/edit paths must include the exact active root name, for example office/notes/a.txt.",
    "bash is a bounded browser-side just-bash shell; it exposes only the virtual root / and the active User Space under /<current rootName>, so use that current mounted name for file paths.",
    "Binary transfer is available only inside bash: checkout rootName/path returns a session-relative Agent Space shared/path. Use normal Agent Space tools there, then checkin shared/path rootName/path to replace an explicit destination, or omit the destination to create a result in User Space shared/.",
  ].join("\n");
}

function printHelp(): void {
  console.log(helpText());
}
