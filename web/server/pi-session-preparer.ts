import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentMode } from "../shared/pi-browser-protocol.js";
import {
  agentBrowserSessionName,
  agentBrowserSocketDir,
  buildAgentBrowserProcessEnv,
  ensureAgentBrowserSocketRoot,
  refreshAgentBrowserSocketLease,
  resolveAgentBrowserRuntime,
} from "./agent-browser-runtime.js";
import { browserControlStatePath, ensureBrowserControlState } from "./browser-control-session.js";
import { resolveBinary } from "./path-resolver.js";
import { isPathInside } from "./path-scope.js";
import { preparePiSessionLayout, type PiSessionLayout } from "./pi-session-layout.js";
import { compileSrtPolicy, type DomainPolicyLayer } from "./srt-policy.js";
import {
  USER_SPACE_BASH_BOUNDARY_SUMMARY,
  USER_SPACE_BASH_PUBLIC_COMMANDS,
} from "../shared/user-space-shell-contract.js";

export interface ManagedSkillFile {
  packageId: string;
  path: string;
  content: string;
}

export interface PiSessionPrepareOptions {
  sessionRoot: string;
  sessionId: string;
  mode?: AgentMode;
  dataRoot: string;
  tenantRoot: string;
  knowledgeDirs: readonly string[];
  domainLayers: readonly DomainPolicyLayer[];
  runtimeReadPaths: readonly string[];
  /**
   * Protected broker transport. macOS may use the server-owned Unix socket;
   * Linux uses the neutral Piwork TLS endpoint through its restricted
   * CONNECT proxy.
   */
  internalSocketPath?: string;
  internalTlsTransport?: {
    baseUrl: string;
    certificatePath: string;
    proxyUrl: string;
  };
  issueUserSpaceCapability: (sessionId: string) => string;
  managedSkillFiles?: readonly ManagedSkillFile[];
  migratedUserSkillsRoot?: string;
}

export interface PreparedPiSession {
  layout: PiSessionLayout;
  managedSkillPaths: string[];
  managedSkills: PreparedManagedSkill[];
  /** Exact parent-session resources task children may reuse read-only. */
  taskReadOnlyPaths: string[];
  sandboxSettings: SandboxRuntimeConfig;
  /** Kept out of the Pi process environment and delivered by one-use bootstrap. */
  userSpaceCapability: string;
  toolEnvironment: Record<string, string>;
  sessionBinDir: string;
  runtimeReadPaths: string[];
  unixSocketPaths: string[];
}

export interface PreparedManagedSkill {
  path: string;
  name: string;
  /** Deterministic SHA-256 of the complete managed Skill tree. */
  sha256: string;
}

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TREE_BYTES = 16 * 1024 * 1024;
const RESERVED_SKILLS = new Set(["user-space", "onlyoffice", "piwork-browser"]);
const __dirname = dirname(fileURLToPath(import.meta.url));

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

function safePackageName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error("Managed Skill package id is invalid");
  }
  return name;
}

function safeRelativePath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Managed Skill path is invalid");
  }
  return path;
}

function resetManagedDirectory(path: string, layout: PiSessionLayout): void {
  const resolved = resolve(path);
  if (!isInside(layout.piResourcesDir, resolved) || resolved === layout.piResourcesDir) {
    throw new Error("Refusing to reset an unsafe managed resource path");
  }
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
}

function resetPrivateCheckoutDirectory(layout: PiSessionLayout): void {
  const path = resolve(layout.userSpaceCheckoutsDir);
  if (
    path !== join(layout.sessionRoot, "user-space-checkouts") ||
    !isInside(layout.sessionRoot, path)
  ) {
    throw new Error("Refusing to reset an unsafe User Space staging path");
  }
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function writeManagedFile(root: string, relativePath: string, content: string): string {
  const safePath = safeRelativePath(relativePath);
  const target = resolve(root, safePath);
  if (!isInside(root, target)) throw new Error("Managed resource escaped its package");
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) {
    throw new Error("Managed Skill file is too large");
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staged = join(dirname(target), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(staged, content, { encoding: "utf8", mode: 0o400, flag: "wx" });
    renameSync(staged, target);
    chmodSync(target, 0o400);
  } finally {
    rmSync(staged, { force: true });
  }
  return target;
}

function userSpaceSkill(): string {
  return [
    "---",
    "name: user-space",
    "description: Work with the single browser-authorized User Space through Piwork's four Pi-aligned tools.",
    "---",
    "",
    "# Piwork User Space",
    "",
    "Agent Space is the session workspace. User Space is a browser-owned directory and is never a host path.",
    "Use the Bash tool to invoke exactly these top-level commands:",
    "- `user-space read rootName/path [--offset N] [--limit N]`",
    "- `user-space write rootName/path --content <text>` (or stdin)",
    "- `user-space edit rootName/path --edits '<json-array>'`",
    "- `user-space bash --command <command> [--timeout N]`",
    "",
    "Never invent a fifth top-level User Space tool. Read ranges are 1-based offset plus limit. Multiple edits are atomic, non-overlapping replacements against the original content. Preserve BOM and line endings.",
    "Recursive `grep -r/-R`, `glob`, `find`, and `tree` run only inside `user-space bash` and use the complete browser index. Do not use host search tools for User Space.",
    `Bash boundary: ${USER_SPACE_BASH_BOUNDARY_SUMMARY.join(" ")}`,
    `Registered commands only: ${USER_SPACE_BASH_PUBLIC_COMMANDS.join(", ")}.`,
    "Use `checkout rootName/path` for binary files, edit the returned session-relative `shared/...` Agent Space path, then use `checkin shared/path rootName/path`. Never expose private staging paths.",
    "",
  ].join("\n");
}

function onlyOfficeSkill(): string {
  return [
    "---",
    "name: onlyoffice",
    "description: Read and edit an Office document already open in the user's browser.",
    "---",
    "",
    "# Piwork OnlyOffice",
    "",
    "Use `onlyoffice active` first, then one `onlyoffice op --json '<operation>'` per Bash call.",
    "The intended document must already be open and focused. Never ask for or expose internal mount identifiers.",
    "Use a locate-plan-act-observe loop and read the affected content after each write. Transport success is not proof of the document result.",
    "Do not inspect Office archives with host tools and do not add a second conversion engine. Browser save and conversion behavior remains authoritative.",
    "",
  ].join("\n");
}

function browserSkill(): string {
  return [
    "---",
    "name: piwork-browser",
    "description: Control the connected desktop Chrome through the managed agent-browser bridge.",
    "---",
    "",
    "# Piwork browser",
    "",
    "Use `agent-browser snapshot -i` before acting and use fresh semantic refs.",
    "Prefer structured click/fill/type/press actions. `press` accepts a key, not an element ref.",
    "Never pass --session, --provider, --cdp, --auto-connect, or --profile; Piwork owns them.",
    "After navigation or a major DOM change, snapshot again. Do not fall back to coordinate/CUA control.",
    "",
  ].join("\n");
}

function installBuiltinSkills(skillsRoot: string): string[] {
  const skills = [
    ["user-space", userSpaceSkill()],
    ["onlyoffice", onlyOfficeSkill()],
  ] as const;
  return skills.map(([name, content]) => {
    const root = join(skillsRoot, name);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeManagedFile(root, "SKILL.md", content);
    return root;
  });
}

function copySafeSkillTree(sourceRoot: string, destinationRoot: string): string[] {
  if (!existsSync(sourceRoot)) return [];
  const sourceInfo = lstatSync(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Migrated Skills root must be a real directory");
  }
  const installedRoots: string[] = [];
  let totalBytes = 0;
  const visit = (source: string, target: string): void => {
    const info = lstatSync(source);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error("Migrated Skills contain an unsupported file type");
    }
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(source).sort()) {
        visit(join(source, name), join(target, name));
      }
      return;
    }
    if (info.nlink !== 1 || info.size > MAX_SKILL_FILE_BYTES) {
      throw new Error("Migrated Skill file is unsafe");
    }
    totalBytes += info.size;
    if (totalBytes > MAX_SKILL_TREE_BYTES) {
      throw new Error("Migrated Skills exceed the size limit");
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chmodSync(target, 0o400);
  };
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Each migrated Skill must be a real directory");
    }
    const name = safePackageName(entry.name);
    const target = join(destinationRoot, name);
    if (RESERVED_SKILLS.has(name) || existsSync(target)) {
      throw new Error(`Migrated Skill conflicts with a managed Skill: ${name}`);
    }
    visit(join(sourceRoot, entry.name), target);
    if (existsSync(join(target, "SKILL.md"))) installedRoots.push(target);
  }
  return installedRoots;
}

function installGovernedSkills(skillsRoot: string, files: readonly ManagedSkillFile[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const packageId = safePackageName(file.packageId);
    const root = join(skillsRoot, packageId);
    if (RESERVED_SKILLS.has(packageId)) {
      throw new Error(`Governed Skill conflicts with a built-in Skill: ${packageId}`);
    }
    if (existsSync(root) && !roots.has(root)) {
      throw new Error(`Governed Skill conflicts with another managed Skill: ${packageId}`);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeManagedFile(root, file.path, file.content);
    roots.add(root);
  }
  for (const root of roots) {
    if (!existsSync(join(root, "SKILL.md"))) {
      throw new Error(`Managed Skill is missing SKILL.md: ${root.split(sep).at(-1)}`);
    }
  }
  return [...roots];
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Managed command path contains NUL");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeWrapper(target: string, executable: string, args: readonly string[]): void {
  const content = [
    "#!/bin/sh",
    "set -eu",
    `exec ${[executable, ...args].map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
  writeManagedFile(dirname(target), target.split(sep).at(-1)!, content);
  chmodSync(target, 0o500);
}

function resolveBunRuntime(): string {
  if (process.versions.bun) return realpathSync(process.execPath);
  const binary = resolveBinary("bun");
  if (!binary) throw new Error("Bun is required for managed User Space tools");
  return realpathSync(binary);
}

function installDocumentToolWrappers(
  layout: PiSessionLayout,
  bun: string,
): { binDir: string; runtimeReadPaths: string[] } {
  const binDir = join(layout.piResourcesDir, "bin");
  resetManagedDirectory(binDir, layout);
  const userSpaceEntry = resolve(__dirname, "../bin/user-space.ts");
  const onlyOfficeEntry = resolve(__dirname, "../bin/onlyoffice.ts");
  writeWrapper(join(binDir, "user-space"), bun, [userSpaceEntry]);
  writeWrapper(join(binDir, "onlyoffice"), bun, [onlyOfficeEntry]);
  return {
    binDir,
    runtimeReadPaths: [bun, resolve(__dirname, "../bin"), resolve(__dirname, "../src")],
  };
}

function installAgentBrowser(
  layout: PiSessionLayout,
  binDir: string,
  sessionId: string,
): {
  skillPath?: string;
  environment: Record<string, string>;
  runtimeReadPaths: string[];
  unixSocketPaths: string[];
  managedReadPaths: string[];
} {
  const runtime = resolveAgentBrowserRuntime();
  if (!runtime.ready) {
    return {
      environment: {},
      runtimeReadPaths: [],
      unixSocketPaths: [],
      managedReadPaths: [],
    };
  }
  ensureAgentBrowserSocketRoot();
  const socketDirPath = agentBrowserSocketDir(sessionId, layout.sessionRoot);
  mkdirSync(socketDirPath, { recursive: true, mode: 0o700 });
  const socketDir = realpathSync(socketDirPath);
  refreshAgentBrowserSocketLease(socketDir, sessionId, layout.sessionRoot);
  const controlFile = browserControlStatePath(layout.sessionRoot);
  ensureBrowserControlState(controlFile, sessionId);

  const sessionName = agentBrowserSessionName(sessionId);
  const wrapper = join(binDir, "agent-browser");
  const script = [
    "#!/bin/sh",
    "set -eu",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    --session|--session=*|--provider|--provider=*|--cdp|--cdp=*|--auto-connect|--auto-connect=*|--profile|--profile=*)",
    "      echo 'Piwork owns the browser runtime arguments.' >&2; exit 2 ;;",
    "  esac",
    "done",
    `exec ${shellQuote(runtime.nativeCli)} --session ${shellQuote(sessionName)} --provider chrome-extension "$@"`,
    "",
  ].join("\n");
  writeManagedFile(binDir, "agent-browser", script);
  chmodSync(wrapper, 0o500);

  const skillRoot = join(layout.managedSkillsDir, "piwork-browser");
  mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
  writeManagedFile(skillRoot, "SKILL.md", browserSkill());
  const environment = buildAgentBrowserProcessEnv(runtime, {
    sessionId,
    socketDir,
  });
  return {
    skillPath: skillRoot,
    environment: {
      ...environment,
      PIWORK_AGENT_BROWSER_CLI: runtime.nativeCli,
      PIWORK_AGENT_BROWSER_CONTROL_FILE: controlFile,
    },
    runtimeReadPaths: [runtime.rootDir, runtime.pluginRunner, runtime.nativeCli],
    unixSocketPaths: [
      join(socketDir, `${sessionName}.sock`),
      join(socketDir, `${sessionName}.stream`),
    ],
    managedReadPaths: [controlFile],
  };
}

function digestManagedSkill(root: string): PreparedManagedSkill {
  const canonicalRoot = realpathSync(root);
  const rootInfo = lstatSync(canonicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Managed Skill root changed during preparation");
  }
  const skill = join(canonicalRoot, "SKILL.md");
  const skillInfo = lstatSync(skill);
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink() || skillInfo.nlink !== 1) {
    throw new Error("Managed SKILL.md changed during preparation");
  }

  // Bind both relative file names and bytes while deliberately excluding the
  // absolute session path. This covers supporting files, not only SKILL.md,
  // and yields the same digest for identical Skill content in two sessions.
  const hash = createHash("sha256");
  hash.update("piwork-managed-skill-v1\0");
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error("Managed Skill changed during preparation");
    }
    const relativePath = relative(canonicalRoot, path).split(sep).join("/");
    if (info.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error("Managed Skill contains an unsafe file");
    }
    hash.update(`file\0${relativePath}\0${info.size}\0`);
    hash.update(readFileSync(path));
  };
  visit(canonicalRoot);
  return {
    path: canonicalRoot,
    name: canonicalRoot.split(sep).at(-1)!,
    sha256: hash.digest("hex"),
  };
}

function sealManagedResources(root: string): void {
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("Managed resources must not contain symlinks");
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      chmodSync(path, 0o500);
      return;
    }
    const executable = isInside(join(root, "bin"), path);
    chmodSync(path, executable ? 0o500 : 0o400);
  };
  visit(root);
}

function unsealManagedResourceDirectories(root: string): void {
  const visit = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("Managed resources must not contain symlinks");
    if (!info.isDirectory()) return;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
}

export class PiSessionPreparer {
  constructor(private readonly bunRuntime: () => string = resolveBunRuntime) {}

  prepare(options: PiSessionPrepareOptions): PreparedPiSession {
    if (!/^[a-f0-9-]{36}$/i.test(options.sessionId)) throw new Error("Invalid session id");
    if (
      options.internalSocketPath !== undefined &&
      (!isAbsolute(options.internalSocketPath) || options.internalSocketPath.includes("\0"))
    ) {
      throw new Error("Protected internal Unix transport must be an absolute socket path");
    }
    if (!options.internalSocketPath && !options.internalTlsTransport) {
      throw new Error("A protected internal file transport is required");
    }
    const layout = preparePiSessionLayout(options.sessionRoot);
    unsealManagedResourceDirectories(layout.piResourcesDir);
    const canonicalDataRoot = realpathSync(options.dataRoot);
    const canonicalTenantRoot = realpathSync(options.tenantRoot);
    if (
      !isPathInside(canonicalDataRoot, canonicalTenantRoot) ||
      !isPathInside(canonicalTenantRoot, layout.sessionRoot)
    ) {
      throw new Error("Pi session layout escapes its tenant authority");
    }

    resetPrivateCheckoutDirectory(layout);
    resetManagedDirectory(layout.managedSkillsDir, layout);
    const managedSkillPaths = installBuiltinSkills(layout.managedSkillsDir);
    if (options.migratedUserSkillsRoot) {
      managedSkillPaths.push(
        ...copySafeSkillTree(options.migratedUserSkillsRoot, layout.managedSkillsDir),
      );
    }
    managedSkillPaths.push(
      ...installGovernedSkills(layout.managedSkillsDir, options.managedSkillFiles || []),
    );
    const documentTools = installDocumentToolWrappers(layout, this.bunRuntime());
    const browser = installAgentBrowser(layout, documentTools.binDir, options.sessionId);
    if (browser.skillPath) managedSkillPaths.push(browser.skillPath);
    const uniqueSkills = [...new Set(managedSkillPaths.map((path) => realpathSync(path)))];
    const managedSkills = uniqueSkills.map(digestManagedSkill);
    sealManagedResources(layout.piResourcesDir);

    const capability = options.issueUserSpaceCapability(options.sessionId);
    if (!capability) throw new Error("User Space capability could not be issued");
    let internalBase = `http://user-space.piwork.internal/internal/user-space-transfer/${options.sessionId}`;
    let internalCertificate: string | undefined;
    let internalProxy: string | undefined;
    if (options.internalTlsTransport) {
      const base = new URL(options.internalTlsTransport.baseUrl);
      const proxy = new URL(options.internalTlsTransport.proxyUrl);
      if (
        base.protocol !== "https:" ||
        base.hostname !== "user-space.piwork.internal" ||
        !base.port ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        proxy.protocol !== "http:" ||
        proxy.hostname !== "127.0.0.1" ||
        !proxy.port ||
        proxy.username ||
        proxy.password ||
        proxy.pathname !== "/" ||
        proxy.search ||
        proxy.hash
      ) {
        throw new Error("Protected internal TLS transport is invalid");
      }
      const certificate = realpathSync(options.internalTlsTransport.certificatePath);
      const certificateInfo = lstatSync(certificate);
      if (
        !certificateInfo.isFile() ||
        certificateInfo.isSymbolicLink() ||
        certificateInfo.nlink !== 1
      ) {
        throw new Error("Protected internal TLS certificate is unsafe");
      }
      base.pathname = `/internal/user-space-transfer/${options.sessionId}`;
      internalBase = base.toString().replace(/\/$/, "");
      internalCertificate = certificate;
      internalProxy = proxy.toString().replace(/\/$/, "");
    }
    const toolEnvironment = {
      ...browser.environment,
      PIWORK_USER_SPACE_SESSION_ID: options.sessionId,
      PIWORK_USER_SPACE_API_BASE: internalBase,
      ...(options.internalSocketPath
        ? { PIWORK_USER_SPACE_API_UNIX: options.internalSocketPath }
        : {}),
      ...(internalCertificate ? { NODE_EXTRA_CA_CERTS: internalCertificate } : {}),
      PIWORK_ONLYOFFICE_API_BASE: internalBase.replace("/user-space-transfer/", "/onlyoffice/"),
    };
    const runtimeReadPaths = [
      ...options.runtimeReadPaths,
      ...(internalCertificate ? [internalCertificate] : []),
      ...documentTools.runtimeReadPaths,
      ...browser.runtimeReadPaths,
    ].map((path) => realpathSync(path));
    const taskReadOnlyPaths = [layout.piResourcesDir, ...browser.managedReadPaths].map((path) =>
      realpathSync(path),
    );
    const unixSocketPaths = [
      ...(options.internalSocketPath ? [options.internalSocketPath] : []),
      ...browser.unixSocketPaths,
    ];
    const sandboxSettings = compileSrtPolicy({
      tenantsRoot: canonicalDataRoot,
      tenantRoot: canonicalTenantRoot,
      sessionRoot: layout.sessionRoot,
      workspaceDir: layout.workspaceDir,
      homeDir: layout.homeDir,
      tmpDir: layout.tmpDir,
      // Pi's writable runtime config is a sibling of immutable Piwork
      // resources, so SRT never has to reopen a read-only child beneath a
      // writable parent.
      piConfigDir: layout.piRuntimeConfigDir,
      piSessionsDir: layout.piSessionsDir,
      managedReadPaths: taskReadOnlyPaths,
      deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
      knowledgeDirs: [...options.knowledgeDirs],
      runtimeReadPaths,
      unixSocketPaths,
      requiredInternalDomains: options.internalTlsTransport ? ["user-space.piwork.internal"] : [],
      domainLayers: [...options.domainLayers],
    });
    if (internalProxy) {
      const directDomains = (sandboxSettings.network?.allowedDomains || []).filter(
        (domain: string) => domain !== "user-space.piwork.internal",
      );
      sandboxSettings.network = {
        ...sandboxSettings.network,
        parentProxy: {
          http: internalProxy,
          https: internalProxy,
          noProxy: directDomains.join(","),
        },
      };
    }

    return {
      layout,
      managedSkillPaths: uniqueSkills,
      managedSkills,
      taskReadOnlyPaths,
      sandboxSettings,
      userSpaceCapability: capability,
      toolEnvironment,
      sessionBinDir: documentTools.binDir,
      runtimeReadPaths,
      unixSocketPaths,
    };
  }
}
