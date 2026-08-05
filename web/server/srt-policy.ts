import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { isPathInside } from "./path-scope.js";

export interface DomainPolicyLayer {
  allowedDomains: string[];
  deniedDomains: string[];
}

/**
 * The nested mode is a deployment property, never a user-controlled toggle.
 * Native Linux keeps the strict PID/proc boundary; Compose selects this only
 * after the Runtime container security gate has verified its outer boundary.
 */
export type SrtExecutionMode = "native" | "compose-nested";

/** Root-owned runtime helper present only in the fixed Compose image. */
export const COMPOSE_NESTED_BWRAP_PATH = "/usr/local/bin/piwork-bwrap";

export interface SrtPolicyInput {
  tenantsRoot: string;
  tenantRoot: string;
  sessionRoot: string;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
  piConfigDir: string;
  piSessionsDir: string;
  deniedSessionDirs: string[];
  /** Server-curated, read-only session resources such as managed Skills. */
  managedReadPaths?: readonly string[];
  knowledgeDirs: string[];
  /** Trusted runtime files/package roots needed to execute Pi through SRT. */
  runtimeReadPaths?: readonly string[];
  /** Server-owned IPC sockets. Never source these paths from a session/workspace. */
  unixSocketPaths?: readonly string[];
  requiredInternalDomains: string[];
  domainLayers: DomainPolicyLayer[];
  executionMode?: SrtExecutionMode;
}

export interface TaskSrtPolicyInput {
  /** Fully compiled, fail-closed policy of the root Pi session. */
  parent: SandboxRuntimeConfig;
  rootSessionRoot: string;
  /** The one Agent Space shared by the root Pi process and every task child. */
  sharedWorkspaceDir: string;
  /** Exact parent-session resources explicitly approved for read-only reuse. */
  sharedReadOnlyPaths: readonly string[];
  childSessionRoot: string;
  childHomeDir: string;
  childTmpDir: string;
  childPiRuntimeConfigDir: string;
  childPiSessionsDir: string;
  childDeniedSessionDirs: readonly string[];
  readOnlyWorkspace: boolean;
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function intersectAllowed(layers: DomainPolicyLayer[]): Set<string> {
  if (!layers.length) return new Set();
  let result = new Set(layers[0].allowedDomains.map(normalizeDomain).filter(Boolean));
  for (const layer of layers.slice(1)) {
    const next = new Set(layer.allowedDomains.map(normalizeDomain).filter(Boolean));
    result = new Set([...result].filter((domain) => next.has(domain)));
  }
  return result;
}

function canonicalWithin(root: string, path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const canonicalRoot = realpathSync(root);
  const canonical = realpathSync(resolve(path));
  if (!isPathInside(canonicalRoot, canonical)) throw new Error(`${label} escapes its tenant root.`);
  return canonical;
}

function canonicalExisting(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  const canonical = realpathSync(resolve(path));
  const stat = lstatSync(canonical);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`${label} must be a regular file or directory.`);
  }
  return canonical;
}

function canonicalSocketPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("Unix socket path must be absolute.");
  }
  const parent = realpathSync(dirname(resolve(path)));
  const canonical = join(parent, basename(path));
  return canonical;
}

function hostPrivateReadRoots(): string[] {
  if (process.platform === "darwin") {
    return ["/Users", "/Volumes", "/tmp", "/private/tmp", "/private/var/folders", "/usr/local"];
  }
  if (process.platform === "linux") {
    return ["/home", "/root", "/tmp", "/var/tmp", "/mnt", "/media", "/run/user", "/run/secrets"];
  }
  return [];
}

function topLevelReadDenyPaths(): string[] {
  return readdirSync("/", { withFileTypes: true }).map((entry) => join("/", entry.name));
}

/**
 * Immutable OS runtime material needed by shells, dynamic linkers, TLS, and
 * DNS. Never grant broad application/config roots such as /etc, /opt, /srv,
 * /var, /usr/local, or /System: those commonly contain deployment secrets or,
 * on macOS, aliases into the writable Data volume.
 */
function systemRuntimeReadPaths(): string[] {
  const candidates =
    process.platform === "darwin"
      ? [
          "/bin",
          "/sbin",
          "/usr/bin",
          "/usr/lib",
          "/usr/libexec",
          "/usr/sbin",
          "/System/Library",
          "/Library/Apple/System/Library",
          "/private/etc/hosts",
          "/private/etc/resolv.conf",
          "/private/etc/passwd",
          "/private/etc/group",
          "/private/etc/localtime",
          "/private/etc/ssl",
          "/private/var/db/timezone/zoneinfo",
          "/dev/null",
          "/dev/random",
          "/dev/urandom",
        ]
      : process.platform === "linux"
        ? [
            "/bin",
            "/lib",
            "/lib32",
            "/lib64",
            "/sbin",
            "/usr/bin",
            "/usr/lib",
            "/usr/lib64",
            "/usr/libexec",
            "/usr/sbin",
            // The fixed Compose image keeps Node/Bun in these root-owned
            // runtime directories. Re-open the directories (not only exact
            // files) after the top-level /usr/local deny so bubblewrap can
            // create bind parents for exact runtime-file grants.
            "/usr/local/bin",
            "/usr/local/bun/bin",
            "/usr/share/ca-certificates",
            "/usr/share/zoneinfo",
            "/etc/ca-certificates",
            "/etc/ssl/certs",
            "/etc/pki/tls/certs",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/nsswitch.conf",
            "/etc/gai.conf",
            "/etc/passwd",
            "/etc/group",
            "/etc/localtime",
            "/etc/ld.so.cache",
            "/dev/null",
            "/dev/random",
            "/dev/urandom",
            // SRT mounts a new PID namespace and fresh /proc before the
            // workload starts, so this does not expose host processes.
            "/proc",
          ]
        : [];
  return Array.from(
    new Set(
      candidates
        .filter((path) => existsSync(path))
        .flatMap((path) => {
          const canonical = realpathSync(path);
          // SRT keeps directory deny paths in their original spelling. Preserve
          // both sides of usr-merged aliases so a later /bin or /sbin tmpfs mask
          // can restore the same trusted target it aliases under /usr.
          return process.platform === "linux" && canonical !== path
            ? [path, canonical]
            : [canonical];
        }),
    ),
  );
}

function overlaps(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

function canonicalDirectory(path: string, label: string): string {
  const canonical = canonicalExisting(path, label);
  if (!lstatSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return canonical;
}

function absolutePolicyPath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(path);
}

function policyGrantCovers(grants: readonly string[], candidate: string): boolean {
  return grants.some((grant) => isPathInside(absolutePolicyPath(grant, "SRT grant"), candidate));
}

function outsideSessionGrants(
  paths: readonly string[],
  sessionRoot: string,
  label: string,
): string[] {
  return paths.flatMap((path) => {
    const canonical = absolutePolicyPath(path, label);
    if (isPathInside(sessionRoot, canonical)) return [];
    if (isPathInside(canonical, sessionRoot)) {
      throw new Error(`${label} must not span the root session.`);
    }
    return [canonical];
  });
}

function outsideSessionRestrictions(paths: readonly string[], sessionRoot: string): string[] {
  return paths.filter((path) => {
    if (!isAbsolute(path)) return true;
    return !isPathInside(sessionRoot, resolve(path));
  });
}

/**
 * Rebuild a task child's filesystem authority from the root policy.
 *
 * A task intentionally shares only Agent Space and explicitly named immutable
 * resources. It receives fresh HOME/TMP/Pi state directories and never
 * inherits a broad grant for the root session's private runtime state.
 */
export function deriveTaskSrtPolicy(input: TaskSrtPolicyInput): SandboxRuntimeConfig {
  const rootSessionRoot = canonicalDirectory(input.rootSessionRoot, "root session");
  const sharedWorkspaceDir = canonicalWithin(
    rootSessionRoot,
    input.sharedWorkspaceDir,
    "shared task workspace",
  );
  const childSessionRoot = canonicalWithin(
    rootSessionRoot,
    input.childSessionRoot,
    "task child session",
  );
  const childWritable = [
    input.childHomeDir,
    input.childTmpDir,
    input.childPiRuntimeConfigDir,
    input.childPiSessionsDir,
  ].map((path) => canonicalWithin(childSessionRoot, path, "task child runtime path"));
  const childDenied = input.childDeniedSessionDirs.map((path) =>
    canonicalWithin(childSessionRoot, path, "task child private path"),
  );
  const sharedReadOnlyPaths = input.sharedReadOnlyPaths.map((path) =>
    canonicalWithin(rootSessionRoot, path, "shared task resource"),
  );

  if (sharedWorkspaceDir !== join(rootSessionRoot, "workspace")) {
    throw new Error("Shared task workspace must be the root session workspace.");
  }
  for (const privatePath of childDenied) {
    if (childWritable.some((allowedPath) => overlaps(allowedPath, privatePath))) {
      throw new Error("Task child private and writable paths must not overlap.");
    }
  }
  for (const sharedPath of sharedReadOnlyPaths) {
    if (
      overlaps(sharedWorkspaceDir, sharedPath) ||
      childWritable.some((allowedPath) => overlaps(allowedPath, sharedPath)) ||
      childDenied.some((privatePath) => overlaps(privatePath, sharedPath))
    ) {
      throw new Error("Shared task resources must be exact read-only paths.");
    }
  }

  const parentFilesystem = input.parent.filesystem;
  const parentNetwork = input.parent.network;
  if (
    !parentFilesystem ||
    parentFilesystem.disabled === true ||
    parentFilesystem.allowGitConfig !== false ||
    !parentNetwork ||
    parentNetwork.allowAllUnixSockets === true ||
    parentNetwork.allowLocalBinding === true ||
    input.parent.enableWeakerNestedSandbox === true ||
    input.parent.enableWeakerNetworkIsolation === true
  ) {
    throw new Error("Parent SRT policy is not fail-closed.");
  }

  const parentAllowRead = parentFilesystem.allowRead || [];
  const parentAllowWrite = parentFilesystem.allowWrite || [];
  if (!policyGrantCovers(parentAllowRead, sharedWorkspaceDir)) {
    throw new Error("Parent SRT policy does not grant the shared task workspace.");
  }
  if (!input.readOnlyWorkspace && !policyGrantCovers(parentAllowWrite, sharedWorkspaceDir)) {
    throw new Error("Parent SRT policy does not grant writable Agent Space.");
  }
  for (const sharedPath of sharedReadOnlyPaths) {
    if (!policyGrantCovers(parentAllowRead, sharedPath)) {
      throw new Error("Shared task resource is not granted by the parent SRT policy.");
    }
    if (
      parentAllowWrite.some((path) =>
        overlaps(absolutePolicyPath(path, "SRT write grant"), sharedPath),
      )
    ) {
      throw new Error("Shared task resource overlaps a parent SRT write grant.");
    }
  }

  // The root compiler never grants writes outside its own session. Treat any
  // such path as a policy-integrity failure instead of silently inheriting it.
  for (const path of parentAllowWrite) {
    const canonical = absolutePolicyPath(path, "SRT write grant");
    if (!isPathInside(rootSessionRoot, canonical)) {
      throw new Error("Parent SRT write grant escapes the root session.");
    }
  }

  const externalAllowRead = outsideSessionGrants(
    parentAllowRead,
    rootSessionRoot,
    "SRT read grant",
  );
  const inheritedDenyRead = outsideSessionRestrictions(
    parentFilesystem.denyRead || [],
    rootSessionRoot,
  );
  const inheritedDenyWrite = outsideSessionRestrictions(
    parentFilesystem.denyWrite || [],
    rootSessionRoot,
  );

  return {
    filesystem: {
      denyRead: Array.from(new Set([...inheritedDenyRead, ...childDenied])),
      allowRead: Array.from(
        new Set([
          ...externalAllowRead,
          sharedWorkspaceDir,
          ...sharedReadOnlyPaths,
          ...childWritable,
        ]),
      ),
      allowWrite: Array.from(
        new Set([...childWritable, ...(input.readOnlyWorkspace ? [] : [sharedWorkspaceDir])]),
      ),
      denyWrite: Array.from(
        new Set([
          ...inheritedDenyWrite,
          ...childDenied,
          ...(input.readOnlyWorkspace ? [sharedWorkspaceDir] : []),
        ]),
      ),
      allowGitConfig: false,
    },
    network: {
      ...structuredClone(parentNetwork),
      allowedDomains: [...(parentNetwork.allowedDomains || [])],
      deniedDomains: [...(parentNetwork.deniedDomains || [])],
      allowUnixSockets: [...(parentNetwork.allowUnixSockets || [])],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
}

export function compileSrtPolicy(input: SrtPolicyInput): SandboxRuntimeConfig {
  const tenantsRoot = realpathSync(input.tenantsRoot);
  const tenantRoot = canonicalWithin(input.tenantsRoot, input.tenantRoot, "tenant root");
  const sessionRoot = canonicalWithin(tenantRoot, input.sessionRoot, "session root");
  const writable = [
    input.workspaceDir,
    input.homeDir,
    input.tmpDir,
    input.piConfigDir,
    input.piSessionsDir,
  ].map((path) => canonicalWithin(sessionRoot, path, "writable session path"));
  const managedReadPaths = (input.managedReadPaths || []).map((path) =>
    canonicalWithin(sessionRoot, path, "managed session resource"),
  );
  const knowledge = input.knowledgeDirs.map((path) =>
    canonicalWithin(tenantRoot, path, "knowledge path"),
  );
  const deniedSessionDirs = input.deniedSessionDirs.map((path) =>
    canonicalWithin(sessionRoot, path, "private session path"),
  );
  const runtimeReadPaths = (input.runtimeReadPaths || []).map((path) => {
    const canonical = canonicalExisting(path, "runtime read path");
    const stat = lstatSync(canonical);
    // Exact trusted runtime files may live beneath the data root. A directory
    // grant must never overlap the tenant
    // tree: allowRead wins over denyRead in SRT and would reopen user data.
    if (
      stat.isDirectory() &&
      (isPathInside(canonical, tenantsRoot) || isPathInside(tenantsRoot, canonical))
    ) {
      throw new Error("runtime read directory must not overlap tenant data");
    }
    if (deniedSessionDirs.some((privatePath) => isPathInside(privatePath, canonical))) {
      throw new Error("runtime read path must not expose a private session path");
    }
    return canonical;
  });
  const unixSocketPaths = (input.unixSocketPaths || []).map((path) => {
    const canonical = canonicalSocketPath(path);
    if (isPathInside(tenantRoot, canonical)) {
      throw new Error("Unix socket path must be outside tenant-controlled data.");
    }
    return canonical;
  });
  for (const privatePath of deniedSessionDirs) {
    if (
      writable.some(
        (allowedPath) =>
          isPathInside(allowedPath, privatePath) || isPathInside(privatePath, allowedPath),
      )
    ) {
      throw new Error("private and allowed session paths must not overlap");
    }
  }
  for (const managedPath of managedReadPaths) {
    if (
      writable.some(
        (allowedPath) =>
          isPathInside(allowedPath, managedPath) || isPathInside(managedPath, allowedPath),
      ) ||
      deniedSessionDirs.some(
        (privatePath) =>
          isPathInside(privatePath, managedPath) || isPathInside(managedPath, privatePath),
      )
    ) {
      throw new Error("managed read-only and writable/private session paths must not overlap");
    }
  }
  const denied = new Set(
    input.domainLayers.flatMap((layer) => layer.deniedDomains.map(normalizeDomain)),
  );
  const allowed = intersectAllowed(input.domainLayers);
  for (const domain of denied) allowed.delete(domain);
  for (const domain of input.requiredInternalDomains.map(normalizeDomain)) allowed.add(domain);

  return {
    filesystem: {
      denyRead: [
        // SRT read policy is otherwise allow-by-default. A literal root deny
        // cannot be safely reopened by Seatbelt, so snapshot every root entry
        // into the deny set, then reopen only immutable OS runtime material
        // and the server-owned paths below. The sandbox cannot create new root
        // entries because its write policy is allow-only.
        ...topLevelReadDenyPaths(),
        ...hostPrivateReadRoots(),
        tenantsRoot,
        "/proc",
        "~/.ssh",
        "~/.aws",
        "~/.netrc",
        "~/.gnupg",
        ...deniedSessionDirs,
      ],
      // SRT gives allowRead precedence over denyRead. Never allow the whole
      // session root: doing so would re-open private staging directories that
      // are denied above. List only the four intended runtime subtrees.
      allowRead: Array.from(
        new Set([
          ...systemRuntimeReadPaths(),
          ...writable,
          ...managedReadPaths,
          ...knowledge,
          ...runtimeReadPaths,
        ]),
      ),
      allowWrite: Array.from(new Set(writable)),
      denyWrite: Array.from(new Set([...knowledge, ...deniedSessionDirs])),
      allowGitConfig: false,
    },
    network: {
      allowedDomains: [...allowed].sort(),
      deniedDomains: [...denied].sort(),
      allowUnixSockets: Array.from(new Set(unixSocketPaths)),
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      parentProxy: undefined,
    },
    // This is intentionally derived from a typed server-side deployment mode;
    // no environment value or browser request is read here.
    enableWeakerNestedSandbox: input.executionMode === "compose-nested",
    enableWeakerNetworkIsolation: false,
    ...(input.executionMode === "compose-nested" ? { bwrapPath: COMPOSE_NESTED_BWRAP_PATH } : {}),
  };
}
