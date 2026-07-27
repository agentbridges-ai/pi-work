import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Context, Hono } from "hono";
import {
  getSessionDir,
  getTenantSessionDir,
  getTenantUserDataRoot,
  getUserDataRoot,
} from "../local-paths.js";
import {
  createScopedDirectoryNoSymlink,
  deleteScopedEntryNoFollow,
  ensureScopedDirectoryNoSymlink,
  listScopedDirectoryNoFollow,
  PathPolicyError,
  readScopedFileSnapshotNoFollow,
  renameScopedEntryNoReplace,
  requireSessionId,
  statScopedEntryNoFollow,
  withPinnedScopedDirectories,
  writeScopedFileNoFollow,
  type PinnedScopedDirectory,
  type ScopedEntryIdentity,
  type ScopedDirectoryEntry,
} from "../path-policy.js";
import type { AuthenticatedUser } from "../auth-types.js";
import type { UserSpaceBroker } from "../user-space-broker.js";
import { withDiskReservation, type UserDiskQuota } from "../user-disk-quota.js";

type AgentEntryKind = "file" | "directory";

interface AgentSpaceEntry {
  name: string;
  path: string;
  kind: AgentEntryKind;
  size?: number;
  mtime?: number;
}

interface AgentSpaceTreeNode {
  name: string;
  path: string;
  type: AgentEntryKind;
  size?: number;
  mtime?: number;
  children?: AgentSpaceTreeNode[];
}

interface AgentSpaceMove {
  path: string;
  newPath: string;
}

type AgentSpaceMoveErrorCode =
  | "agent_space_move_invalid_destination"
  | "agent_space_move_invalid_source"
  | "agent_space_move_rollback_failed"
  | "agent_space_move_target_exists";

interface TransferFileResult {
  source: string;
  target: string;
  status: "ok" | "exists" | "error";
  size?: number;
  error?: string;
}

interface UserSpaceCheckoutResult {
  localPath?: string;
  size?: number;
  hash?: string;
  baseHash?: string;
  baseMtime?: number;
}

interface TransferTargetResolution {
  path: string;
  status: "ok" | "exists";
}

interface WorkspaceFileSnapshot {
  bytes: Uint8Array;
  size: number;
  mtime: number;
  sha256: string;
}

interface AgentSpaceRouteOptions {
  getCurrentUser: () => AuthenticatedUser;
  userSpaceBroker?: UserSpaceBroker;
  /** Shared Better Auth user quota for every server-managed workspace write. */
  diskQuota?: UserDiskQuota;
  /** Deterministic route-test seam; production callers leave this unset. */
  moveTestHooks?: {
    afterMoveApplied?(move: AgentSpaceMove, index: number): void | Promise<void>;
  };
}

const DEFAULT_TREE_DEPTH = 12;
const MAX_AGENT_SPACE_MOVE_ENTRIES = 1_000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 50 * 1024 * 1024;
const AGENT_SPACE_CONTENT_SECURITY_POLICY = [
  "sandbox",
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");
const ACTIVE_CONTENT_EXTENSIONS = new Set([
  "css",
  "htm",
  "html",
  "js",
  "mjs",
  "cjs",
  "svg",
  "svgz",
  "xhtml",
  "xml",
  "xsl",
  "xslt",
]);
const agentSpaceMutationQueues = new Map<string, Promise<void>>();

export function registerAgentSpaceRoutes(api: Hono, options: AgentSpaceRouteOptions): void {
  api.get("/sessions/:id/agent-space/list", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const path = cleanRelativePath(c.req.query("path") || "");
      const recursive = c.req.query("recursive") === "1" || c.req.query("recursive") === "true";
      const target = await resolveWorkspacePath(root, path, { mustExist: true });
      const info = await statScopedEntryNoFollow(target, [root]);
      if (info.kind !== "directory") return c.json({ error: "path is not a directory" }, 400);
      const depth = clampNumber(c.req.query("depth"), 0, 32, DEFAULT_TREE_DEPTH);
      const listed = await listScopedDirectoryNoFollow(target, [root], {
        depth: recursive ? Math.max(depth, 1) : 1,
      });
      const entries = listed.map((entry) => toAgentSpaceEntry(path, entry));
      const tree = recursive
        ? depth === 0
          ? []
          : listed.map((entry) => toAgentSpaceTree(path, entry))
        : undefined;
      return c.json({ path, rootName: "workspace", entries, tree });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.get("/sessions/:id/agent-space/metadata", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const path = cleanRelativePath(c.req.query("path") || "");
      const target = await resolveWorkspacePath(root, path, { mustExist: false });
      const info = await statScopedEntryNoFollow(target, [root]);
      const kind: AgentEntryKind = info.kind;
      const snapshot =
        kind === "file"
          ? await readWorkspaceFileSnapshot(root, target, {
              maxBytes: MAX_RAW_BYTES,
              tooLargeMessage: "File too large (>50MB)",
            })
          : undefined;
      const metadata: Record<string, unknown> = {
        path,
        name: basename(path || "workspace"),
        kind,
        size: snapshot?.size ?? info.size,
        mtime: snapshot?.mtime ?? info.mtimeMs,
      };
      if (snapshot) metadata.sha256 = snapshot.sha256;
      return c.json(metadata);
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.get("/sessions/:id/agent-space/read", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const path = cleanRelativePath(c.req.query("path") || "");
      if (!path) return c.json({ error: "path required" }, 400);
      const target = await resolveWorkspacePath(root, path, { mustExist: false });
      const snapshot = await readWorkspaceFileSnapshot(root, target, {
        maxBytes: MAX_READ_BYTES,
        tooLargeMessage: "File too large (>2MB)",
      });
      return c.json({
        path,
        content: new TextDecoder().decode(snapshot.bytes),
        size: snapshot.size,
        mtime: snapshot.mtime,
        sha256: snapshot.sha256,
      });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.get("/sessions/:id/agent-space/raw", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const path = cleanRelativePath(c.req.query("path") || "");
      if (!path) return c.json({ error: "path required" }, 400);
      const target = await resolveWorkspacePath(root, path, { mustExist: false });
      const snapshot = await readWorkspaceFileSnapshot(root, target, {
        maxBytes: MAX_RAW_BYTES,
        tooLargeMessage: "File too large (>50MB)",
      });
      return new Response(Buffer.from(snapshot.bytes), {
        headers: {
          "Content-Type": contentTypeForPath(path),
          "Content-Disposition": contentDispositionForPath(path),
          "Content-Security-Policy": AGENT_SPACE_CONTENT_SECURITY_POLICY,
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
          "X-Piwork-Agent-Space-Path": encodeURIComponent(path),
          "X-Piwork-Agent-Space-Mtime": String(snapshot.mtime),
          "X-Piwork-Agent-Space-Size": String(snapshot.size),
          "X-Piwork-Agent-Space-Sha256": snapshot.sha256,
        },
      });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.put("/sessions/:id/agent-space/write", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const path = cleanRelativePath(requireString(body.path, "path"));
      const content = requireString(body.content, "content");
      if (!path) return c.json({ error: "path required" }, 400);
      const result = await withAgentSpaceMutation(root, async () => {
        const target = await resolveWorkspacePath(root, path, { mustExist: false });
        await withDiskReservation(
          options.diskQuota,
          Buffer.byteLength(content, "utf8"),
          async () => {
            await ensureParentInside(root, target);
            await writeScopedFileNoFollow(target, content, [root]);
          },
        );
        const snapshot = await readWorkspaceFileSnapshot(root, target);
        return {
          ok: true,
          path,
          size: snapshot.size,
          mtime: snapshot.mtime,
          sha256: snapshot.sha256,
        };
      });
      return c.json(result);
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.post("/sessions/:id/agent-space/create", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const path = cleanRelativePath(requireString(body.path, "path"));
      const kind = body.kind === "directory" ? "directory" : "file";
      if (!path) return c.json({ error: "path required" }, 400);
      const result = await withAgentSpaceMutation(root, async () => {
        const target = await resolveWorkspacePath(root, path, { mustExist: false });
        let size: number;
        let mtime: number;
        if (kind === "directory") {
          await ensureParentInside(root, target);
          const info = await createScopedDirectoryNoSymlink(target, [root]);
          size = info.size;
          mtime = info.mtimeMs;
        } else {
          const content = typeof body.content === "string" ? body.content : "";
          await withDiskReservation(
            options.diskQuota,
            Buffer.byteLength(content, "utf8"),
            async () => {
              await ensureParentInside(root, target);
              await writeScopedFileNoFollow(target, content, [root], { exclusive: true });
            },
          );
          const snapshot = await readWorkspaceFileSnapshot(root, target);
          size = snapshot.size;
          mtime = snapshot.mtime;
        }
        return { ok: true, path, kind, size, mtime };
      });
      return c.json(result);
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.delete("/sessions/:id/agent-space/delete", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const path = cleanRelativePath(requireString(body.path, "path"));
      if (!path) return c.json({ error: "path required" }, 400);
      await withAgentSpaceMutation(root, async () => {
        const target = await resolveWorkspacePath(root, path, { mustExist: false });
        await deleteScopedEntryNoFollow(target, [root], { recursive: body.recursive === true });
      });
      return c.json({ ok: true, path });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.post("/sessions/:id/agent-space/rename", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const path = cleanRelativePath(requireString(body.path, "path"));
      const newPath = cleanRelativePath(requireString(body.newPath, "newPath"));
      if (!path || !newPath) return c.json({ error: "path and newPath required" }, 400);
      const conflict = await withAgentSpaceMutation(root, async () => {
        const source = await resolveWorkspacePath(root, path, { mustExist: false });
        const target = await resolveWorkspacePath(root, newPath, { mustExist: false });
        await ensureParentInside(root, target);
        try {
          await renameScopedEntryNoReplace(source, target, [root]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
          throw error;
        }
        return false;
      });
      if (conflict) return c.json({ error: "target already exists" }, 409);
      return c.json({ ok: true, path, newPath });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.post("/sessions/:id/agent-space/move", async (c) => {
    try {
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const paths = cleanMoveSourcePaths(body.paths);
      const targetDirPath = cleanRelativePath(requireString(body.targetDirPath, "targetDirPath"));
      const moves = await withAgentSpaceMutation(root, () =>
        moveWorkspaceEntries(root, paths, targetDirPath, options.moveTestHooks),
      );
      return c.json({ ok: true, moves });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.post("/sessions/:id/transfer/user-to-agent", async (c) => {
    try {
      const broker = requireUserSpaceBroker(options.userSpaceBroker);
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const sourcePath = cleanUserSpacePath(requireString(body.path, "path"));
      const results = await withAgentSpaceMutation(root, () =>
        transferUserToAgent(broker, sessionId, root, sourcePath, options.diskQuota),
      );
      return c.json({ ok: results.every((item) => item.status !== "error"), files: results });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });

  api.post("/sessions/:id/transfer/agent-to-user", async (c) => {
    try {
      const broker = requireUserSpaceBroker(options.userSpaceBroker);
      const sessionId = cleanSessionId(c.req.param("id"));
      const root = await getWorkspaceRoot(options.getCurrentUser(), sessionId);
      const body = await readJsonBody(c.req.raw);
      const sourcePath = cleanRelativePath(requireString(body.path, "path"));
      const targetPath =
        typeof body.targetPath === "string" && body.targetPath.trim()
          ? cleanUserSpacePath(body.targetPath)
          : undefined;
      const results = await withAgentSpaceMutation(root, () =>
        transferAgentToUser(broker, sessionId, root, sourcePath, targetPath),
      );
      return c.json({ ok: results.every((item) => item.status !== "error"), files: results });
    } catch (error) {
      return jsonRouteError(c, error);
    }
  });
}

async function getWorkspaceRoot(user: AuthenticatedUser, sessionId: string): Promise<string> {
  const userRoot = user.tenantId
    ? getTenantUserDataRoot(user.tenantId, user.uuid)
    : getUserDataRoot(user.uuid);
  const sessionDir = user.tenantId
    ? getTenantSessionDir(user.tenantId, user.uuid, sessionId)
    : getSessionDir(user.uuid, sessionId);
  const root = join(sessionDir, "workspace");
  await ensureScopedDirectoryNoSymlink(root, [userRoot]);
  const info = await statScopedEntryNoFollow(root, [userRoot]);
  if (info.kind !== "directory") {
    throw new PathPolicyError("Agent Space workspace root is not a private directory", 403);
  }
  return root;
}

async function withAgentSpaceMutation<T>(root: string, mutation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = agentSpaceMutationQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  agentSpaceMutationQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (agentSpaceMutationQueues.get(key) === tail) agentSpaceMutationQueues.delete(key);
  }
}

async function resolveWorkspacePath(
  root: string,
  path: string,
  options: { mustExist: boolean },
): Promise<string> {
  const target = resolve(root, path);
  guardInside(root, target);
  if (options.mustExist) await statScopedEntryNoFollow(target, [root]);
  return target;
}

async function ensureParentInside(root: string, target: string): Promise<void> {
  guardInside(root, target);
  const parent = dirname(target);
  await ensureScopedDirectoryNoSymlink(parent, [root]);
}

async function moveWorkspaceEntries(
  root: string,
  paths: string[],
  targetDirPath: string,
  testHooks?: AgentSpaceRouteOptions["moveTestHooks"],
): Promise<AgentSpaceMove[]> {
  const targetDirectory = await resolveWorkspacePath(root, targetDirPath, { mustExist: false });
  const targetInfo = await statScopedEntryNoFollow(targetDirectory, [root]);
  if (targetInfo.kind !== "directory") {
    throw agentSpaceMoveError(
      "agent_space_move_invalid_destination",
      "targetDirPath is not a directory",
      400,
    );
  }

  const sourceParentPaths = Array.from(new Set(paths.map(parentRelativePath)));
  const sourceParentDirectories = await Promise.all(
    sourceParentPaths.map((path) =>
      resolveWorkspacePath(root, path, {
        mustExist: false,
      }),
    ),
  );

  return withPinnedScopedDirectories(
    [targetDirectory, ...sourceParentDirectories],
    [root],
    async ([pinnedTarget, ...pinnedSourceParents]) => {
      if (!pinnedTarget) {
        throw agentSpaceMoveError(
          "agent_space_move_invalid_destination",
          "Target directory could not be pinned",
          400,
        );
      }
      const sourceParents = new Map<
        string,
        { absolutePath: string; directory: PinnedScopedDirectory }
      >();
      sourceParentPaths.forEach((path, index) => {
        const directory = pinnedSourceParents[index];
        const absolutePath = sourceParentDirectories[index];
        if (directory && absolutePath) sourceParents.set(path, { absolutePath, directory });
      });

      const sourceEntries: Array<{
        path: string;
        info: Awaited<ReturnType<typeof statScopedEntryNoFollow>>;
        identity: ScopedEntryIdentity;
        name: string;
        parentAbsolutePath: string;
        parentDirectory: PinnedScopedDirectory;
        parentPath: string;
      }> = [];
      for (const path of paths) {
        const parentPath = parentRelativePath(path);
        const parent = sourceParents.get(parentPath);
        if (!parent) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_source",
            "Source parent directory could not be pinned",
            400,
          );
        }
        const name = basename(path);
        const inspection = await parent.directory.inspectEntry(name);
        if (!inspection) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_source",
            "Source entry no longer exists",
            400,
          );
        }
        sourceEntries.push({
          path,
          info: inspection.stat,
          identity: inspection.identity,
          name,
          parentAbsolutePath: parent.absolutePath,
          parentDirectory: parent.directory,
          parentPath,
        });
      }
      const maximalSources = collapseAgentMoveSources(sourceEntries);

      const plans: Array<
        AgentSpaceMove & {
          sourceIdentity: ScopedEntryIdentity;
          sourceName: string;
          sourceParentAbsolutePath: string;
          sourceParentDirectory: PinnedScopedDirectory;
          sourceParentPath: string;
        }
      > = [];
      const targetPaths = new Set<string>();
      for (const source of maximalSources) {
        const { path } = source;
        if (path === targetDirPath) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_destination",
            "Cannot move an entry onto itself",
            400,
          );
        }
        if (source.parentPath === targetDirPath) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_destination",
            "Cannot move an entry into its current parent",
            400,
          );
        }
        if (isRelativeDescendant(targetDirPath, path)) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_destination",
            "Cannot move an entry into one of its descendants",
            400,
          );
        }

        const newPath = joinPosix(targetDirPath, source.name);
        if (targetPaths.has(newPath)) {
          throw agentSpaceMoveError(
            "agent_space_move_target_exists",
            "Multiple selected entries have the same target name",
            409,
          );
        }
        targetPaths.add(newPath);
        plans.push({
          path,
          newPath,
          sourceIdentity: source.identity,
          sourceName: source.name,
          sourceParentAbsolutePath: source.parentAbsolutePath,
          sourceParentDirectory: source.parentDirectory,
          sourceParentPath: source.parentPath,
        });
      }

      if (!(await pinnedTarget.matchesPath(targetDirectory))) {
        throw agentSpaceMoveError(
          "agent_space_move_invalid_destination",
          "Target directory changed during Agent Space move",
          400,
        );
      }
      for (const plan of plans) {
        if (!(await plan.sourceParentDirectory.matchesPath(plan.sourceParentAbsolutePath))) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_source",
            "Source parent directory changed during Agent Space move",
            400,
          );
        }
      }

      // Check conflicts relative to the same destination descriptor used by
      // every rename. Path replacement cannot redirect later items elsewhere.
      for (const plan of plans) {
        if (await pinnedTarget.statEntry(basename(plan.newPath))) {
          throw agentSpaceMoveError("agent_space_move_target_exists", "target already exists", 409);
        }
      }

      const applied: Array<(typeof plans)[number] & { movedIdentity: ScopedEntryIdentity }> = [];
      try {
        for (const [index, plan] of plans.entries()) {
          const movedIdentity = await plan.sourceParentDirectory.renameEntryToDirectoryNoReplace(
            plan.sourceName,
            pinnedTarget,
            basename(plan.newPath),
            plan.sourceIdentity,
          );
          applied.push({ ...plan, movedIdentity });
          await testHooks?.afterMoveApplied?.({ path: plan.path, newPath: plan.newPath }, index);
        }
        if (!(await pinnedTarget.matchesPath(targetDirectory))) {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_destination",
            "Target directory changed during Agent Space move",
            400,
          );
        }
        for (const plan of plans) {
          if (!(await plan.sourceParentDirectory.matchesPath(plan.sourceParentAbsolutePath))) {
            throw agentSpaceMoveError(
              "agent_space_move_invalid_source",
              "Source parent directory changed during Agent Space move",
              400,
            );
          }
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const plan of [...applied].reverse()) {
          try {
            await pinnedTarget.renameEntryToDirectoryNoReplace(
              basename(plan.newPath),
              plan.sourceParentDirectory,
              plan.sourceName,
              plan.movedIdentity,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }

        if (rollbackErrors.length > 0) {
          throw agentSpaceMoveError(
            "agent_space_move_rollback_failed",
            "Agent Space move failed and could not be rolled back",
            500,
            error,
          );
        }
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === "EEXIST") {
          throw agentSpaceMoveError(
            "agent_space_move_target_exists",
            "target already exists",
            409,
            error,
          );
        }
        if (errorCode === "ESTALE" || errorCode === "ENOENT") {
          throw agentSpaceMoveError(
            "agent_space_move_invalid_source",
            "Source entry changed during Agent Space move",
            400,
            error,
          );
        }
        throw error;
      }

      return plans.map(({ path, newPath }) => ({ path, newPath }));
    },
  );
}

function cleanMoveSourcePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw agentSpaceMoveError(
      "agent_space_move_invalid_source",
      "paths must be a non-empty array",
      400,
    );
  }
  if (value.length > MAX_AGENT_SPACE_MOVE_ENTRIES) {
    throw agentSpaceMoveError(
      "agent_space_move_invalid_source",
      `paths must contain at most ${MAX_AGENT_SPACE_MOVE_ENTRIES} entries`,
      400,
    );
  }

  const candidates = value.map((item) => {
    const path = cleanRelativePath(requireString(item, "paths[]"));
    if (!path) {
      throw agentSpaceMoveError(
        "agent_space_move_invalid_source",
        "paths must not contain the workspace root",
        400,
      );
    }
    return path;
  });

  return Array.from(new Set(candidates));
}

function agentSpaceMoveError(
  publicCode: AgentSpaceMoveErrorCode,
  message: string,
  status: number,
  cause?: unknown,
): Error & { publicCode: AgentSpaceMoveErrorCode; status: number } {
  return Object.assign(new Error(message), { publicCode, status, ...(cause ? { cause } : {}) });
}

function collapseAgentMoveSources<T extends { path: string; info: { kind: string } }>(
  entries: T[],
): T[] {
  const selectedDirectories = new Set(
    entries.filter(({ info }) => info.kind === "directory").map(({ path }) => path),
  );
  return entries.filter(({ path }) => {
    let parent = parentRelativePath(path);
    while (parent) {
      if (selectedDirectories.has(parent)) return false;
      parent = parentRelativePath(parent);
    }
    return true;
  });
}

function parentRelativePath(path: string): string {
  const parent = dirname(path).replaceAll("\\", "/");
  return parent === "." ? "" : parent;
}

function isRelativeDescendant(path: string, possibleParent: string): boolean {
  return possibleParent.length > 0 && path.startsWith(`${possibleParent}/`);
}

function guardInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw Object.assign(new Error("Path escapes Agent Space workspace"), { status: 403 });
  }
}

function toAgentSpaceEntry(dirPath: string, entry: ScopedDirectoryEntry): AgentSpaceEntry {
  return {
    name: entry.name,
    path: joinPosix(dirPath, entry.name),
    kind: entry.kind,
    size: entry.size,
    mtime: entry.mtimeMs,
  };
}

function toAgentSpaceTree(dirPath: string, entry: ScopedDirectoryEntry): AgentSpaceTreeNode {
  const path = joinPosix(dirPath, entry.name);
  return {
    name: entry.name,
    path,
    type: entry.kind,
    size: entry.size,
    mtime: entry.mtimeMs,
    children:
      entry.kind === "directory"
        ? (entry.children?.map((child) => toAgentSpaceTree(path, child)) ?? [])
        : undefined,
  };
}

async function transferUserToAgent(
  broker: UserSpaceBroker,
  sessionId: string,
  root: string,
  sourcePath: string,
  diskQuota?: UserDiskQuota,
): Promise<TransferFileResult[]> {
  const sourceInfo = await probeUserSpaceEntry(broker, sessionId, sourcePath);
  const sourceName = basename(sourcePath) || "user-space";
  const targetRootRel =
    sourceInfo.kind === "directory"
      ? await prepareAgentDirectoryRoot(root, joinPosix("shared", sourceName))
      : joinPosix("shared", sourceName);
  const files =
    sourceInfo.kind === "directory"
      ? await listUserSpaceFilesRecursive(broker, sessionId, sourcePath)
      : [{ path: sourcePath, relativePath: basename(sourcePath) }];
  const results: TransferFileResult[] = [];

  for (const file of files) {
    const requestedTargetRel =
      sourceInfo.kind === "directory" ? joinPosix(targetRootRel, file.relativePath) : targetRootRel;
    let targetRel = requestedTargetRel;
    try {
      const checkout = await checkoutUserSpaceFile(broker, sessionId, file.path);
      if (!checkout.localPath) throw new Error("Browser checkout did not provide a local path.");
      const bytes = await broker.consumeBlobCheckout(sessionId, {
        localPath: checkout.localPath,
        expectedSize: checkout.size,
        expectedHash: checkout.hash,
      });
      const sourceHash = createHash("sha256").update(bytes).digest("hex");
      const targetResolution = await resolveAgentFileTransferTarget(
        root,
        requestedTargetRel,
        sourceHash,
      );
      targetRel = targetResolution.path;
      if (targetResolution.status === "exists") {
        results.push({
          source: `user-space:/${file.path}`,
          target: `workspace/${targetRel}`,
          status: "exists",
          size: checkout.size,
        });
        continue;
      }
      const target = await resolveWorkspacePath(root, targetRel, { mustExist: false });
      await withDiskReservation(diskQuota, bytes.byteLength, async () => {
        await ensureParentInside(root, target);
        await writeScopedFileNoFollow(target, bytes, [root], { exclusive: true });
      });
      results.push({
        source: `user-space:/${file.path}`,
        target: `workspace/${targetRel}`,
        status: "ok",
        size: bytes.byteLength,
      });
    } catch (error) {
      if ((error as { status?: unknown })?.status === 507) throw error;
      results.push({
        source: `user-space:/${file.path}`,
        target: `workspace/${targetRel}`,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function transferAgentToUser(
  broker: UserSpaceBroker,
  sessionId: string,
  root: string,
  sourcePath: string,
  explicitTargetPath?: string,
): Promise<TransferFileResult[]> {
  if (!sourcePath) throw new Error("path required");
  const lexicalSource = await resolveWorkspacePath(root, sourcePath, { mustExist: false });
  const sourceStat = await statScopedEntryNoFollow(lexicalSource, [root]);
  const source = lexicalSource;
  const sourceName = basename(sourcePath);
  if (sourceStat.kind === "directory" && explicitTargetPath) {
    throw new Error(
      "An explicit User Space target is currently supported only for a single Agent Space file.",
    );
  }
  const targetRoot =
    explicitTargetPath ||
    (sourceStat.kind === "directory"
      ? await prepareUserSpaceDirectoryRoot(
          broker,
          sessionId,
          joinPosix("shared", sourceName || "agent-space"),
        )
      : joinPosix("shared", sourceName || "agent-file"));
  const files =
    sourceStat.kind === "directory"
      ? await listAgentFilesRecursive(root, source, sourcePath)
      : [{ path: source, relativePath: basename(sourcePath), sourceRel: sourcePath }];
  const results: TransferFileResult[] = [];

  if (sourceStat.kind === "directory") {
    await ensureUserSpaceDirectories(
      broker,
      sessionId,
      targetRoot,
      files.map((file) => dirname(file.relativePath)),
    );
  } else {
    await ensureUserSpaceDirectories(broker, sessionId, dirname(targetRoot), [""]);
  }

  for (const file of files) {
    const requestedTargetPath =
      sourceStat.kind === "directory" ? joinPosix(targetRoot, file.relativePath) : targetRoot;
    let targetPath = requestedTargetPath;
    try {
      const snapshot = await readWorkspaceFileSnapshot(root, file.path);
      const targetResolution = explicitTargetPath
        ? await writeExplicitUserSpaceFileTarget(broker, sessionId, requestedTargetPath, snapshot)
        : await resolveUserSpaceFileTransferTarget(
            broker,
            sessionId,
            requestedTargetPath,
            snapshot.sha256,
          );
      targetPath = targetResolution.path;
      if (targetResolution.status === "exists") {
        results.push({
          source: `workspace/${file.sourceRel}`,
          target: `user-space:/${targetPath}`,
          status: "exists",
          size: snapshot.size,
        });
        continue;
      }
      if (explicitTargetPath) {
        results.push({
          source: `workspace/${file.sourceRel}`,
          target: `user-space:/${targetPath}`,
          status: "ok",
          size: snapshot.size,
        });
        continue;
      }
      await broker.requestBlobCheckin(sessionId, {
        path: targetPath,
        baseHash: "",
        body: snapshot.bytes,
        create: true,
      });
      results.push({
        source: `workspace/${file.sourceRel}`,
        target: `user-space:/${targetPath}`,
        status: "ok",
        size: snapshot.size,
      });
    } catch (error) {
      if ((error as { status?: unknown })?.status === 507) throw error;
      results.push({
        source: `workspace/${file.sourceRel}`,
        target: `user-space:/${targetPath}`,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function writeExplicitUserSpaceFileTarget(
  broker: UserSpaceBroker,
  sessionId: string,
  targetPath: string,
  source: WorkspaceFileSnapshot,
): Promise<TransferTargetResolution> {
  const clean = cleanUserSpacePath(targetPath);
  const existing = await tryProbeUserSpaceEntry(broker, sessionId, clean);
  if (!existing) {
    await ensureUserSpaceParentDirectory(broker, sessionId, clean);
    await broker.requestBlobCheckin(sessionId, {
      path: clean,
      baseHash: "",
      body: source.bytes,
      create: true,
    });
    return { path: clean, status: "ok" };
  }
  if (existing.kind !== "file") {
    throw new Error(`Explicit User Space target is not a file: ${clean}`);
  }

  // Snapshot the current destination immediately before the write. The
  // browser validates this hash/mtime again, so a concurrent User Space edit
  // fails closed instead of being silently overwritten.
  const baseline = await checkoutUserSpaceFile(broker, sessionId, clean);
  const baselineBytes = baseline.localPath
    ? await broker.consumeBlobCheckout(sessionId, {
        localPath: baseline.localPath,
        expectedSize: baseline.size,
        expectedHash: baseline.hash,
      })
    : null;
  const baselineHash = baselineBytes
    ? createHash("sha256").update(baselineBytes).digest("hex")
    : "";
  if (!baselineHash) throw new Error("Browser checkout did not provide a destination hash.");
  if (baselineHash === source.sha256) return { path: clean, status: "exists" };
  await broker.requestBlobCheckin(sessionId, {
    path: clean,
    baseHash: baseline.baseHash || baselineHash,
    baseMtime: baseline.baseMtime,
    body: source.bytes,
    create: false,
  });
  return { path: clean, status: "ok" };
}

async function probeUserSpaceEntry(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<{ kind: AgentEntryKind }> {
  try {
    await broker.requestOperation(sessionId, "list_dir", { path, includeHidden: true, limit: 1 });
    return { kind: "directory" };
  } catch {
    await broker.requestOperation(sessionId, "read_file", { path, maxBytes: 1 });
    return { kind: "file" };
  }
}

async function listUserSpaceFilesRecursive(
  broker: UserSpaceBroker,
  sessionId: string,
  rootPath: string,
): Promise<Array<{ path: string; relativePath: string }>> {
  const files: Array<{ path: string; relativePath: string }> = [];
  async function visit(dirPath: string): Promise<void> {
    let cursor = 0;
    while (true) {
      const result = (await broker.requestOperation(sessionId, "list_dir", {
        path: dirPath,
        includeHidden: true,
        limit: 200,
        cursor,
      })) as { entries?: Array<{ path: string; kind: AgentEntryKind }>; nextCursor?: string };
      for (const entry of result.entries || []) {
        if (entry.kind === "directory") await visit(entry.path);
        else {
          files.push({
            path: entry.path,
            relativePath: relativeUserSpacePath(rootPath, entry.path),
          });
        }
      }
      if (!result.nextCursor) break;
      cursor = Number(result.nextCursor);
      if (!Number.isFinite(cursor)) break;
    }
  }
  await visit(rootPath);
  return files;
}

async function listAgentFilesRecursive(
  root: string,
  dir: string,
  sourceRootRel: string,
): Promise<Array<{ path: string; relativePath: string; sourceRel: string }>> {
  const files: Array<{ path: string; relativePath: string; sourceRel: string }> = [];
  const entries = await listScopedDirectoryNoFollow(dir, [root], { depth: 256 });
  function visit(currentEntries: ScopedDirectoryEntry[], relFromSourceRoot: string): void {
    for (const entry of currentEntries) {
      const nextRel = joinPosix(relFromSourceRoot, entry.name);
      const sourceRel = joinPosix(sourceRootRel, nextRel);
      if (entry.kind === "directory") {
        if (!entry.children) {
          throw new PathPolicyError("Agent Space directory nesting exceeds the secure limit", 403);
        }
        visit(entry.children, nextRel);
      } else {
        files.push({
          path: resolve(root, sourceRel),
          relativePath: nextRel,
          sourceRel,
        });
      }
    }
  }
  visit(entries, "");
  return files;
}

async function checkoutUserSpaceFile(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<UserSpaceCheckoutResult> {
  return (await broker.requestBlobCheckout(sessionId, { path })) as UserSpaceCheckoutResult;
}

async function prepareAgentDirectoryRoot(root: string, relPath: string): Promise<string> {
  const clean = cleanRelativePath(relPath);
  const existing = await tryStatWorkspacePath(root, clean);
  if (!existing) {
    const target = await resolveWorkspacePath(root, clean, { mustExist: false });
    await ensureParentInside(root, target);
    await createScopedDirectoryNoSymlink(target, [root]);
    return clean;
  }
  if (existing.kind === "directory") return clean;

  for (let index = 1; index < 1000; index++) {
    const candidate = copyPathName(clean, index);
    const target = await resolveWorkspacePath(root, candidate, { mustExist: false });
    await ensureParentInside(root, target);
    try {
      await createScopedDirectoryNoSymlink(target, [root]);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not find a unique Agent Space directory target.");
}

async function resolveAgentFileTransferTarget(
  root: string,
  relPath: string,
  sourceHash: string,
): Promise<TransferTargetResolution> {
  const clean = cleanRelativePath(relPath);
  for (let index = 0; index < 1000; index++) {
    const candidate = index === 0 ? clean : copyPathName(clean, index);
    const existing = await tryStatWorkspacePath(root, candidate);
    if (!existing) return { path: candidate, status: "ok" };
    if (existing.kind !== "file") continue;
    const target = await resolveWorkspacePath(root, candidate, { mustExist: false });
    if ((await readWorkspaceFileSnapshot(root, target)).sha256 === sourceHash) {
      return { path: candidate, status: "exists" };
    }
  }
  throw new Error("Could not find a unique Agent Space file target.");
}

async function prepareUserSpaceDirectoryRoot(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<string> {
  const clean = cleanUserSpacePath(path);
  const existing = await tryProbeUserSpaceEntry(broker, sessionId, clean);
  if (!existing) {
    await ensureUserSpaceParentDirectory(broker, sessionId, clean);
    await createUserSpaceDirectory(broker, sessionId, clean);
    return clean;
  }
  if (existing.kind === "directory") return clean;

  for (let index = 1; index < 1000; index++) {
    const candidate = copyPathName(clean, index);
    const candidateEntry = await tryProbeUserSpaceEntry(broker, sessionId, candidate);
    if (!candidateEntry) {
      await ensureUserSpaceParentDirectory(broker, sessionId, candidate);
      await createUserSpaceDirectory(broker, sessionId, candidate);
      return candidate;
    }
    if (candidateEntry.kind === "directory") continue;
  }
  throw new Error("Could not find a unique User Space directory target.");
}

async function resolveUserSpaceFileTransferTarget(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
  sourceHash: string,
): Promise<TransferTargetResolution> {
  const clean = cleanUserSpacePath(path);
  for (let index = 0; index < 1000; index++) {
    const candidate = index === 0 ? clean : copyPathName(clean, index);
    const existing = await tryProbeUserSpaceEntry(broker, sessionId, candidate);
    if (!existing) return { path: candidate, status: "ok" };
    if (existing.kind !== "file") continue;
    if ((await userSpaceFileHash(broker, sessionId, candidate)) === sourceHash) {
      return { path: candidate, status: "exists" };
    }
  }
  throw new Error("Could not find a unique User Space file target.");
}

async function userSpaceFileHash(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<string> {
  const checkout = await checkoutUserSpaceFile(broker, sessionId, path);
  if (!checkout.localPath) throw new Error("Browser checkout did not provide a local path.");
  const bytes = await broker.consumeBlobCheckout(sessionId, {
    localPath: checkout.localPath,
    expectedSize: checkout.size,
    expectedHash: checkout.hash,
  });
  return createHash("sha256").update(bytes).digest("hex");
}

async function tryProbeUserSpaceEntry(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<{ kind: AgentEntryKind } | null> {
  try {
    return await probeUserSpaceEntry(broker, sessionId, path);
  } catch {
    return null;
  }
}

async function createUserSpaceDirectory(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<void> {
  const clean = cleanUserSpacePath(path);
  if (!clean) return;
  await broker.requestOperation(sessionId, "create_entry", {
    parentPath: dirname(clean) === "." ? "" : dirname(clean),
    name: basename(clean),
    kind: "directory",
  });
}

async function ensureUserSpaceParentDirectory(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<void> {
  const parentPath = dirname(cleanUserSpacePath(path));
  if (!parentPath || parentPath === ".") return;
  await ensureUserSpaceDirectoryPath(broker, sessionId, parentPath);
}

async function ensureUserSpaceDirectoryPath(
  broker: UserSpaceBroker,
  sessionId: string,
  path: string,
): Promise<void> {
  const clean = cleanUserSpacePath(path);
  if (!clean) return;
  let current = "";
  for (const part of clean.split("/")) {
    current = joinPosix(current, part);
    await createUserSpaceDirectory(broker, sessionId, current).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/exists/i.test(message) && !/已存在/.test(message)) throw error;
      const existing = await tryProbeUserSpaceEntry(broker, sessionId, current);
      if (existing?.kind !== "directory") throw error;
    });
  }
}

async function tryStatWorkspacePath(
  root: string,
  relPath: string,
): Promise<Awaited<ReturnType<typeof statScopedEntryNoFollow>> | null> {
  const target = await resolveWorkspacePath(root, relPath, { mustExist: false });
  try {
    return await statScopedEntryNoFollow(target, [root]);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function ensureUserSpaceDirectories(
  broker: UserSpaceBroker,
  sessionId: string,
  rootPath: string,
  relativeDirs: string[],
): Promise<void> {
  const dirs = Array.from(new Set(["", ...relativeDirs])).filter((dir) => dir !== ".");
  dirs.sort((a, b) => a.length - b.length);
  for (const dir of dirs) {
    const path = dir ? joinPosix(rootPath, dir) : rootPath;
    await ensureUserSpaceDirectoryPath(broker, sessionId, path);
  }
}

function relativeUserSpacePath(rootPath: string, path: string): string {
  const root = rootPath.replace(/^\/+|\/+$/g, "");
  const target = path.replace(/^\/+|\/+$/g, "");
  if (!root) return target;
  if (target === root) return basename(target);
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : basename(target);
}

function cleanSessionId(value: string): string {
  return requireSessionId(value);
}

function cleanRelativePath(value: string): string {
  const raw = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw Object.assign(new Error("Path traversal is not allowed"), { status: 400 });
    parts.push(part);
  }
  return parts.join("/");
}

function cleanUserSpacePath(value: string): string {
  return cleanRelativePath(value.replace(/^user-space:\//, ""));
}

function joinPosix(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

function copyPathName(path: string, index: number): string {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  const suffix = index === 1 ? " copy" : ` copy ${index}`;
  const name = `${stem}${suffix}${ext}`;
  return dir === "." ? name : joinPosix(dir, name);
}

async function readWorkspaceFileSnapshot(
  root: string,
  target: string,
  options: { maxBytes?: number; tooLargeMessage?: string } = {},
): Promise<WorkspaceFileSnapshot> {
  let file: Awaited<ReturnType<typeof readScopedFileSnapshotNoFollow>>;
  try {
    file = await readScopedFileSnapshotNoFollow(target, [root], {
      maxBytes: options.maxBytes,
    });
  } catch (error) {
    if (
      error instanceof PathPolicyError &&
      error.message === "File is too large for secure read" &&
      options.tooLargeMessage
    ) {
      throw Object.assign(new Error(options.tooLargeMessage), { status: 413 });
    }
    throw error;
  }
  return {
    bytes: file.bytes,
    size: file.size,
    mtime: file.mtimeMs,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  };
}

function contentTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase().slice(1);
  if (ACTIVE_CONTENT_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json",
    ts: "text/plain; charset=utf-8",
    pdf: "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

function contentDispositionForPath(path: string): string {
  const name = basename(path) || "download";
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw Object.assign(new Error(`${field} must be a string`), { status: 400 });
  return value;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function requireUserSpaceBroker(broker: UserSpaceBroker | undefined): UserSpaceBroker {
  if (!broker)
    throw Object.assign(new Error("User Space transfer is unavailable."), { status: 503 });
  return broker;
}

function jsonRouteError(c: Context, error: unknown) {
  const status =
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 400;
  const message = error instanceof Error ? error.message : String(error);
  const publicCode =
    typeof (error as { publicCode?: unknown }).publicCode === "string"
      ? (error as { publicCode: string }).publicCode
      : "";
  return c.json(
    publicCode ? { error: message, code: publicCode } : { error: message },
    status as any,
  );
}
