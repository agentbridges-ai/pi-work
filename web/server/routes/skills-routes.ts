import { existsSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Context, Hono } from "hono";
import {
  ensureScopedDirectoryNoSymlink,
  isPathInside,
  PathPolicyError,
  readScopedFileNoFollow,
  writeScopedFileNoFollow,
} from "../path-policy.js";
import { withDiskReservation, type UserDiskQuota } from "../user-disk-quota.js";

export interface SkillRouteOptions {
  /** Better Auth user-scoped Pi Skills directory, never a host-wide home. */
  skillsDir: string;
  /** Shared Better Auth user quota for every server-managed skill write. */
  diskQuota?: UserDiskQuota;
}

interface SkillsRoot {
  canonical: string;
  lexical: string;
}

const SKILL_FILE = "SKILL.md";
const SKILL_FILE_MAX_BYTES = 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isValidSlug(slug: string): boolean {
  return Boolean(
    slug &&
    slug !== "." &&
    slug !== ".." &&
    !slug.includes("..") &&
    !slug.includes("/") &&
    !slug.includes("\\") &&
    !slug.includes("\0") &&
    !/%[0-9a-f]{2}/i.test(slug),
  );
}

function invalidBoundary(c: Context) {
  return c.json({ error: "Invalid skill path" }, 400);
}

function notFound(c: Context) {
  return c.json({ error: "Skill not found" }, 404);
}

function unexpected(c: Context, error: unknown) {
  const status = (error as { status?: unknown })?.status === 507 ? 507 : 500;
  return c.json({ error: String(error) }, status);
}

function isBoundaryError(error: unknown): boolean {
  return error instanceof PathPolicyError;
}

async function inspectSkillsRoot(skillsDir: string): Promise<SkillsRoot> {
  const lexical = resolve(skillsDir);
  const rootStat = await lstat(lexical);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new PathPolicyError("Skills root must be a real directory", 403);
  }

  const canonical = await realpath(lexical);
  const canonicalStat = await lstat(canonical);
  if (
    canonicalStat.isSymbolicLink() ||
    !canonicalStat.isDirectory() ||
    canonicalStat.dev !== rootStat.dev ||
    canonicalStat.ino !== rootStat.ino
  ) {
    throw new PathPolicyError("Skills root changed during validation", 403);
  }
  return { canonical, lexical };
}

async function ensureSkillsRoot(skillsDir: string): Promise<SkillsRoot> {
  if (!existsSync(skillsDir)) {
    // The per-user Pi Skills directory is the trusted application-owned
    // parent. Once `skills` exists, every content operation is scoped to its
    // canonical directory rather than this broader parent.
    await ensureScopedDirectoryNoSymlink(resolve(skillsDir), [dirname(resolve(skillsDir))]);
  }
  return inspectSkillsRoot(skillsDir);
}

async function inspectSkillDirectory(root: SkillsRoot, slug: string): Promise<string> {
  const candidate = resolve(root.canonical, slug);
  if (!isPathInside(root.canonical, candidate) || candidate === root.canonical) {
    throw new PathPolicyError("Skill directory escaped the skills root", 403);
  }

  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PathPolicyError("Skill path must be a real directory", 403);
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate || !isPathInside(root.canonical, canonical)) {
    throw new PathPolicyError("Skill directory is an alias", 403);
  }
  return canonical;
}

async function readSkill(
  root: SkillsRoot,
  slug: string,
): Promise<{ content: string; path: string }> {
  const skillDir = await inspectSkillDirectory(root, slug);
  const path = resolve(skillDir, SKILL_FILE);
  const bytes = await readScopedFileNoFollow(path, [root.canonical], {
    maxBytes: SKILL_FILE_MAX_BYTES,
  });
  return { content: Buffer.from(bytes).toString("utf-8"), path };
}

function publicSkillPath(root: SkillsRoot, slug: string): string {
  return resolve(root.lexical, slug, SKILL_FILE);
}

export function registerSkillRoutes(api: Hono, options: SkillRouteOptions): void {
  const skillsDir = resolve(options.skillsDir);

  api.get("/skills", async (c) => {
    try {
      if (!existsSync(skillsDir)) return c.json([]);
      const root = await inspectSkillsRoot(skillsDir);
      const entries = await readdir(root.canonical, { withFileTypes: true });
      const skills = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
        let content: string;
        try {
          ({ content } = await readSkill(root, entry.name));
        } catch (error) {
          // Missing files, links, hardlinks, and raced directory entries are
          // not skills. Unexpected I/O failures still surface to the caller.
          if (isMissing(error) || isBoundaryError(error)) continue;
          throw error;
        }
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        let name = entry.name;
        let description = "";
        if (fmMatch) {
          for (const line of fmMatch[1].split("\n")) {
            const nameMatch = line.match(/^name:\s*(.+)/);
            if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
            const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
            if (descMatch) description = descMatch[1];
          }
        }
        skills.push({
          slug: entry.name,
          name,
          description,
          path: publicSkillPath(root, entry.name),
        });
      }
      return c.json(skills);
    } catch (error) {
      return isBoundaryError(error) ? invalidBoundary(c) : unexpected(c, error);
    }
  });

  api.get("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isValidSlug(slug)) return c.json({ error: "Invalid slug" }, 400);
    try {
      if (!existsSync(skillsDir)) return notFound(c);
      const root = await inspectSkillsRoot(skillsDir);
      const { content } = await readSkill(root, slug);
      return c.json({ slug, path: publicSkillPath(root, slug), content });
    } catch (error) {
      if (isMissing(error)) return notFound(c);
      return isBoundaryError(error) ? invalidBoundary(c) : unexpected(c, error);
    }
  });

  api.post("/skills", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, description, content } = body;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }

    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (!isValidSlug(slug)) return c.json({ error: "Invalid name" }, 400);

    try {
      const md = `---\nname: ${slug}\ndescription: ${JSON.stringify(description || `Skill: ${name}`)}\n---\n\n${content || `# ${name}\n\nDescribe what this skill does and how to use it.\n`}`;
      return await withDiskReservation(
        options.diskQuota,
        Buffer.byteLength(md, "utf8"),
        async () => {
          const root = await ensureSkillsRoot(skillsDir);
          const skillDir = resolve(root.canonical, slug);
          if (existsSync(skillDir)) {
            await inspectSkillDirectory(root, slug);
          } else {
            await ensureScopedDirectoryNoSymlink(skillDir, [root.canonical]);
          }
          await writeScopedFileNoFollow(resolve(skillDir, SKILL_FILE), md, [root.canonical], {
            exclusive: true,
          });

          return c.json({
            slug,
            name,
            description: description || `Skill: ${name}`,
            path: publicSkillPath(root, slug),
          });
        },
      );
    } catch (error) {
      if (isAlreadyExists(error)) {
        return c.json({ error: `Skill "${slug}" already exists` }, 409);
      }
      return isBoundaryError(error) ? invalidBoundary(c) : unexpected(c, error);
    }
  });

  api.put("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isValidSlug(slug)) return c.json({ error: "Invalid slug" }, 400);
    try {
      if (!existsSync(skillsDir)) return notFound(c);
      const root = await inspectSkillsRoot(skillsDir);
      const skillDir = await inspectSkillDirectory(root, slug);
      const skillMdPath = resolve(skillDir, SKILL_FILE);
      if (!existsSync(skillMdPath)) return notFound(c);
      const body = await c.req.json().catch(() => ({}));
      if (typeof body.content !== "string") {
        return c.json({ error: "content is required" }, 400);
      }
      await withDiskReservation(options.diskQuota, Buffer.byteLength(body.content, "utf8"), () =>
        writeScopedFileNoFollow(skillMdPath, body.content, [root.canonical]),
      );
      return c.json({ ok: true, slug, path: publicSkillPath(root, slug) });
    } catch (error) {
      if (isMissing(error)) return notFound(c);
      return isBoundaryError(error) ? invalidBoundary(c) : unexpected(c, error);
    }
  });

  api.delete("/skills/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isValidSlug(slug)) return c.json({ error: "Invalid slug" }, 400);
    try {
      if (!existsSync(skillsDir)) return notFound(c);
      const root = await inspectSkillsRoot(skillsDir);
      const skillDir = await inspectSkillDirectory(root, slug);
      // fs.rm unlinks symbolic links instead of traversing them. The directory
      // itself was also lstat/realpath checked above, so recursive deletion is
      // rooted at the already validated canonical child.
      await rm(skillDir, { recursive: true, force: true });
      return c.json({ ok: true, slug });
    } catch (error) {
      if (isMissing(error)) return notFound(c);
      return isBoundaryError(error) ? invalidBoundary(c) : unexpected(c, error);
    }
  });
}
