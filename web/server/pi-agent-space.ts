import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AuthorizedRoot } from "./pi-bootstrap-channel.js";

export class PiAgentSpaceError extends Error {
  readonly code:
    | "invalid_path"
    | "outside_authority"
    | "read_only"
    | "symlink_forbidden"
    | "not_regular_file"
    | "changed";

  constructor(code: PiAgentSpaceError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiAgentSpaceError";
    this.code = code;
  }
}

interface CanonicalRoot {
  path: string;
  access: "read" | "write";
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validateAbsolutePath(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new PiAgentSpaceError(
      "invalid_path",
      "Agent Space operations require an absolute safe path.",
    );
  }
  return resolve(path);
}

async function inspectComponents(
  root: string,
  candidate: string,
  options: { allowMissing: boolean },
): Promise<void> {
  const rel = relative(root, candidate);
  if (!isInside(root, candidate)) {
    throw new PiAgentSpaceError(
      "outside_authority",
      "Agent Space path is outside the authorized roots.",
    );
  }
  if (!rel) return;
  let cursor = root;
  const components = rel.split(sep);
  for (let index = 0; index < components.length; index++) {
    cursor = resolve(cursor, components[index]!);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new PiAgentSpaceError(
          "symlink_forbidden",
          "Agent Space paths cannot traverse symbolic links.",
        );
      }
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new PiAgentSpaceError("invalid_path", "Agent Space path parent is not a directory.");
      }
    } catch (error) {
      if (error instanceof PiAgentSpaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return;
      throw error;
    }
  }
}

function sameFile(
  before: Awaited<ReturnType<FileHandle["stat"]>>,
  after: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/**
 * Filesystem operations adapter for Pi's native read/write/edit factories.
 * Pi retains its own offset/limit, truncation, BOM/line-ending, atomic
 * multi-edit, mutation queue, timeout, and cancellation behavior. This class
 * replaces only the operations layer with Agent Space authority checks.
 */
export class PiAgentSpace {
  readonly roots: readonly CanonicalRoot[];
  readonly readOperations: {
    readFile: (absolutePath: string) => Promise<Buffer>;
    access: (absolutePath: string) => Promise<void>;
  };
  readonly writeOperations: {
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    mkdir: (dir: string) => Promise<void>;
  };
  readonly editOperations: {
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    access: (absolutePath: string) => Promise<void>;
  };

  private constructor(roots: CanonicalRoot[]) {
    this.roots = roots;
    this.readOperations = {
      readFile: (path) => this.readFile(path),
      access: (path) => this.accessRead(path),
    };
    this.writeOperations = {
      writeFile: (path, content) => this.writeFile(path, content),
      mkdir: (path) => this.mkdir(path),
    };
    this.editOperations = {
      readFile: (path) => this.readFile(path),
      writeFile: (path, content) => this.writeFile(path, content),
      access: (path) => this.accessEdit(path),
    };
  }

  static async create(authority: readonly AuthorizedRoot[]): Promise<PiAgentSpace> {
    if (!Array.isArray(authority) || authority.length === 0) {
      throw new PiAgentSpaceError(
        "outside_authority",
        "Agent Space requires at least one authorized root.",
      );
    }
    const roots: CanonicalRoot[] = [];
    for (const item of authority) {
      const lexical = validateAbsolutePath(item.path);
      const stat = await lstat(lexical);
      if (stat.isSymbolicLink()) {
        throw new PiAgentSpaceError(
          "symlink_forbidden",
          "Agent Space root cannot be a symbolic link.",
        );
      }
      if (!stat.isDirectory()) {
        throw new PiAgentSpaceError("invalid_path", "Agent Space root must be a directory.");
      }
      const canonical = await realpath(lexical);
      await access(
        canonical,
        item.access === "write" ? constants.R_OK | constants.W_OK : constants.R_OK,
      );
      const existing = roots.find((root) => root.path === canonical);
      if (existing) {
        if (item.access === "write") existing.access = "write";
      } else {
        roots.push({ path: canonical, access: item.access });
      }
    }
    roots.sort((left, right) => right.path.length - left.path.length);
    return new PiAgentSpace(roots);
  }

  private rootFor(path: string, write: boolean): CanonicalRoot {
    const candidate = validateAbsolutePath(path);
    const containing = this.roots.filter((root) => isInside(root.path, candidate));
    if (containing.length === 0) {
      throw new PiAgentSpaceError(
        "outside_authority",
        "Agent Space path is outside the authorized roots.",
      );
    }
    if (!write) return containing[0]!;
    const writable = containing.find((root) => root.access === "write");
    if (!writable) {
      throw new PiAgentSpaceError("read_only", "Agent Space path is read-only.");
    }
    return writable;
  }

  async resolveRead(path: string): Promise<string> {
    const candidate = validateAbsolutePath(path);
    const root = this.rootFor(candidate, false);
    await inspectComponents(root.path, candidate, { allowMissing: false });
    const canonical = await realpath(candidate);
    if (!isInside(root.path, canonical)) {
      throw new PiAgentSpaceError(
        "outside_authority",
        "Agent Space path escaped its authorized root.",
      );
    }
    return canonical;
  }

  async resolveWrite(path: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    const candidate = validateAbsolutePath(path);
    const root = this.rootFor(candidate, true);
    await inspectComponents(root.path, candidate, {
      allowMissing: options.allowMissing ?? true,
    });
    return candidate;
  }

  private async readFile(path: string): Promise<Buffer> {
    const resolved = await this.resolveRead(path);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        resolved,
        constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
      );
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) {
        throw new PiAgentSpaceError(
          "not_regular_file",
          "Agent Space reads require an ordinary single-link file.",
        );
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameFile(before, after)) {
        throw new PiAgentSpaceError("changed", "Agent Space file changed while it was read.");
      }
      return bytes;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async accessRead(path: string): Promise<void> {
    await access(await this.resolveRead(path), constants.R_OK);
  }

  private async accessEdit(path: string): Promise<void> {
    const resolved = await this.resolveRead(path);
    this.rootFor(resolved, true);
    await access(resolved, constants.R_OK | constants.W_OK);
  }

  private async mkdir(path: string): Promise<void> {
    const resolved = await this.resolveWrite(path, { allowMissing: true });
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    const root = this.rootFor(resolved, true);
    await inspectComponents(root.path, resolved, { allowMissing: false });
    const stat = await lstat(resolved);
    if (!stat.isDirectory()) {
      throw new PiAgentSpaceError("invalid_path", "Agent Space mkdir target is not a directory.");
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const resolved = await this.resolveWrite(path, { allowMissing: true });
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        resolved,
        constants.O_WRONLY |
          constants.O_CREAT |
          ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
        0o600,
      );
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) {
        throw new PiAgentSpaceError(
          "not_regular_file",
          "Agent Space writes require an ordinary single-link file.",
        );
      }
      await handle.truncate(0);
      await handle.writeFile(content, "utf8");
      const after = await handle.stat();
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new PiAgentSpaceError(
          "changed",
          "Agent Space file identity changed while it was written.",
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
