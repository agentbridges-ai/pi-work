import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommandNames } from "just-bash/browser";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setUiCopyLanguage } from "./ui-copy.js";

beforeEach(() => setUiCopyLanguage("zh-CN"));
import {
  attachUserSpaceMountsToSession,
  configureUserSpacePersistenceForTests,
  createRuokSetupScript,
  detachUserSpaceFromSession,
  executeUserSpaceOperation,
  getMountedUserSpaces,
  getUserSpaceSnapshot,
  getUserSpaceFile,
  handleUserSpaceBlobCheckinRequest,
  handleUserSpaceBlobCheckoutRequest,
  isUserSpacePickerAbort,
  mountUserSpace,
  normalizeUserSpacePath,
  remountUserSpace,
  renameUserSpaceMount,
  resendSessionUserSpaces,
  resetUserSpaceStateForTests,
  restorePersistedUserSpace,
  restorePersistedUserSpaces,
  RUOK_COMMAND_MATRIX,
  saveUserSpaceFile,
  setUserSpaceTransport,
  subscribeUserSpace,
  syncUserSpaceMetadata,
  updateUserSpaceAccess,
} from "./user-space.js";
import {
  RUOK_FIXTURE_DIRECTORIES,
  RUOK_FIXTURE_FILES,
  RUOK_FIXTURE_SOURCE_ROOT,
} from "./fixtures/user-space-ruok.js";
import {
  formatUserSpaceBashCapabilities,
  USER_SPACE_BASH_COMMANDS,
  USER_SPACE_BASH_PUBLIC_COMMANDS,
} from "../shared/user-space-shell-contract.js";
import type { IndexedWorkspaceEntry } from "./user-space-index.js";
import type {
  PersistedUserSpaceRecord,
  UserSpacePersistenceAdapter,
  UserSpacePersistenceScope,
} from "./user-space-persistence.js";

const userSpaceTestDir = dirname(fileURLToPath(import.meta.url));
const TEST_PERSISTENCE_SCOPE: UserSpacePersistenceScope = {
  userId: "better-auth-user-a",
  tenantId: "tenant-a",
};

const USER_SPACE_SHELL_COMMAND_MATRIX: Array<{
  command: string;
  script: string;
  stdout?: string;
}> = [
  { command: "echo", script: "echo echo-ok", stdout: "echo-ok" },
  { command: "cat", script: "cat matrix/text.txt", stdout: "alpha" },
  { command: "printf", script: "printf 'printf-ok\\n'", stdout: "printf-ok" },
  { command: "ls", script: "ls matrix", stdout: "text.txt" },
  { command: "mkdir", script: "mkdir -p matrix/mkdir/sub && ls matrix/mkdir", stdout: "sub" },
  { command: "rmdir", script: "mkdir -p matrix/rmdir-empty && rmdir matrix/rmdir-empty" },
  {
    command: "touch",
    script: "touch matrix/touched.txt && ls matrix/touched.txt",
    stdout: "matrix/touched.txt",
  },
  {
    command: "cp",
    script: "cp matrix/text.txt matrix/cp.txt && cat matrix/cp.txt",
    stdout: "beta",
  },
  {
    command: "mv",
    script:
      "printf move-ok > matrix/mv-src.txt && mv matrix/mv-src.txt matrix/mv-dst.txt && cat matrix/mv-dst.txt",
    stdout: "move-ok",
  },
  {
    command: "ln",
    script: "ln -s text.txt matrix/link.txt && readlink matrix/link.txt",
    stdout: "text.txt",
  },
  { command: "chmod", script: "chmod 644 matrix/text.txt" },
  { command: "pwd", script: "pwd", stdout: "/" },
  {
    command: "readlink",
    script: "ln -s text.txt matrix/readlink.txt && readlink matrix/readlink.txt",
    stdout: "text.txt",
  },
  { command: "head", script: "head -n 1 matrix/text.txt", stdout: "alpha" },
  { command: "tail", script: "tail -n 1 matrix/text.txt", stdout: "gamma" },
  { command: "wc", script: "wc -l matrix/text.txt", stdout: "matrix/text.txt" },
  { command: "stat", script: "stat matrix/text.txt", stdout: "matrix/text.txt" },
  {
    command: "grep",
    script: "grep -n grep-markdown-ok matrix/notes.md",
    stdout: "3:grep-markdown-ok",
  },
  { command: "fgrep", script: "fgrep beta matrix/text.txt", stdout: "beta" },
  { command: "egrep", script: "egrep 'alpha|delta' matrix/text.txt", stdout: "alpha" },
  { command: "sed", script: "printf 'hello\\n' | sed 's/hello/sed-ok/'", stdout: "sed-ok" },
  { command: "awk", script: "printf '1 2\\n' | awk '{print $1 + $2}'", stdout: "3" },
  { command: "sort", script: "printf 'b\\na\\n' | sort", stdout: "a\nb" },
  { command: "uniq", script: "printf 'a\\na\\nb\\n' | uniq", stdout: "a\nb" },
  { command: "comm", script: "comm matrix/comm-a.txt matrix/comm-b.txt", stdout: "a" },
  { command: "cut", script: "printf 'a:b\\n' | cut -d: -f2", stdout: "b" },
  { command: "paste", script: "paste matrix/comm-a.txt matrix/comm-b.txt", stdout: "a\tb" },
  { command: "tr", script: "printf 'abc' | tr a-z A-Z", stdout: "ABC" },
  { command: "rev", script: "printf 'abc\\n' | rev", stdout: "cba" },
  { command: "nl", script: "printf 'line\\n' | nl", stdout: "line" },
  { command: "fold", script: "printf 'abcdef\\n' | fold -w 3", stdout: "abc\ndef" },
  { command: "expand", script: "printf 'a\\tb\\n' | expand -t 4", stdout: "a   b" },
  { command: "unexpand", script: "printf 'a   b\\n' | unexpand -a -t 4", stdout: "a\tb" },
  { command: "strings", script: "printf 'hello\\0world\\n' | strings", stdout: "hello" },
  {
    command: "split",
    script: "printf 'abcdef' | split -b 3 - matrix/split- && cat matrix/split-aa matrix/split-ab",
    stdout: "abcdef",
  },
  { command: "column", script: "printf 'a b\\ncc dd\\n' | column -t", stdout: "cc" },
  { command: "join", script: "join matrix/join-a.txt matrix/join-b.txt", stdout: "1 one uno" },
  { command: "tee", script: "printf 'tee-ok\\n' | tee matrix/tee.txt", stdout: "tee-ok" },
  { command: "find", script: "find matrix -type f -name '*.md'", stdout: "matrix/notes.md" },
  { command: "basename", script: "basename matrix/text.txt", stdout: "text.txt" },
  { command: "dirname", script: "dirname matrix/text.txt", stdout: "matrix" },
  { command: "tree", script: "tree -L 1 matrix", stdout: "text.txt" },
  { command: "du", script: "du matrix", stdout: "matrix" },
  { command: "env", script: "env MATRIX_ENV=ok printenv MATRIX_ENV", stdout: "ok" },
  { command: "printenv", script: "printenv HOME", stdout: "/" },
  {
    command: "alias",
    script: "alias hi='echo alias-ok'\nalias hi",
    stdout: "alias hi='echo alias-ok'",
  },
  { command: "unalias", script: "alias bye='echo bye'\nunalias bye\ntrue" },
  { command: "history", script: "echo history-ok\nhistory", stdout: "history" },
  { command: "true", script: "true" },
  { command: "false", script: "false || echo false-ok", stdout: "false-ok" },
  { command: "clear", script: "clear", stdout: "\u001b[2J\u001b[H" },
  { command: "bash", script: "bash -c 'echo bash-ok'", stdout: "bash-ok" },
  { command: "sh", script: "sh -c 'echo sh-ok'", stdout: "sh-ok" },
  { command: "jq", script: "jq .name matrix/data.json", stdout: '"nexo"' },
  { command: "base64", script: "printf 'base64-ok' | base64", stdout: "YmFzZTY0LW9r" },
  { command: "diff", script: "diff matrix/text.txt matrix/text-copy.txt" },
  { command: "date", script: "date", stdout: "UTC" },
  { command: "sleep", script: "sleep 0 && echo sleep-ok", stdout: "sleep-ok" },
  { command: "timeout", script: "timeout 2 echo timeout-ok", stdout: "timeout-ok" },
  { command: "time", script: "time echo time-ok", stdout: "time-ok" },
  { command: "seq", script: "seq 1 3", stdout: "1\n2\n3" },
  { command: "expr", script: "expr 1 + 2", stdout: "3" },
  {
    command: "md5sum",
    script: "printf 'hash-ok' | md5sum",
    stdout: "97eeac6703d1882b638dab67bee4de2b",
  },
  {
    command: "sha1sum",
    script: "printf 'hash-ok' | sha1sum",
    stdout: "0195e79cc02332602ea47a7a4b3d4125c45632c3",
  },
  {
    command: "sha256sum",
    script: "printf 'hash-ok' | sha256sum",
    stdout: "b653becc3302186e314d0b44675c52bc1d3ef7886c3e737836ba089672cddd4b",
  },
  { command: "file", script: "file matrix/text.txt", stdout: "UTF-8 text" },
  { command: "html-to-markdown", script: "html-to-markdown matrix/page.html", stdout: "# Hi" },
  { command: "help", script: "help echo", stdout: "echo" },
  { command: "which", script: "which echo", stdout: "echo" },
  { command: "tac", script: "printf 'a\\nb\\n' | tac", stdout: "b\na" },
  { command: "hostname", script: "hostname", stdout: "localhost" },
  { command: "whoami", script: "whoami", stdout: "user" },
  { command: "od", script: "printf A | od -An -t x1", stdout: "41" },
  { command: "gzip", script: "printf 'gzip-ok\\n' | gzip | gunzip", stdout: "gzip-ok" },
  { command: "gunzip", script: "printf 'gunzip-ok\\n' | gzip | gunzip", stdout: "gunzip-ok" },
  { command: "zcat", script: "printf 'zcat-ok\\n' | gzip | zcat", stdout: "zcat-ok" },
  {
    command: "rm",
    script: "printf doomed > matrix/rm.txt && rm matrix/rm.txt && test ! -e matrix/rm.txt",
  },
];

class MockFileHandle {
  kind = "file" as const;
  lastModified = Date.now();
  getFileCalls = 0;

  constructor(
    public name: string,
    public content: BlobPart,
    public type = "text/plain",
  ) {}

  async queryPermission() {
    return "granted" as PermissionState;
  }

  async requestPermission() {
    return "granted" as PermissionState;
  }

  async isSameEntry(other: unknown) {
    return other === this;
  }

  async getFile() {
    this.getFileCalls++;
    return new File([this.content], this.name, {
      lastModified: this.lastModified,
      type: this.type,
    });
  }

  async createWritable(_options?: { keepExistingData?: boolean; mode?: "exclusive" | "siloed" }) {
    let stagedContent = this.content;
    let stagedType = this.type;
    return {
      write: async (data: string | Blob | BufferSource) => {
        if (typeof data === "string") {
          stagedContent = data;
        } else if (data instanceof Blob) {
          stagedContent = new Uint8Array(await data.arrayBuffer());
          stagedType = data.type || stagedType;
        } else {
          stagedContent = data as BufferSource;
        }
      },
      close: async () => {
        this.content = stagedContent;
        this.type = stagedType;
        this.lastModified = Date.now();
      },
      abort: async () => {},
    };
  }
}

class MockDirectoryHandle {
  kind = "directory" as const;
  entriesMap = new Map<string, MockDirectoryHandle | MockFileHandle>();
  iteratedEntries = 0;

  constructor(
    public name: string,
    public permission: PermissionState = "granted",
    public requestedPermission: PermissionState = permission,
  ) {}

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    this.permission = this.requestedPermission;
    return this.permission;
  }

  async isSameEntry(other: unknown) {
    return other === this;
  }

  async *values() {
    for (const value of this.entriesMap.values()) {
      this.iteratedEntries++;
      yield value;
    }
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === "directory") return existing;
    if (!options?.create) throw new DOMException("Not found", "NotFoundError");
    const dir = new MockDirectoryHandle(name, this.permission, this.requestedPermission);
    this.entriesMap.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.entriesMap.get(name);
    if (existing?.kind === "file") return existing;
    if (!options?.create) throw new DOMException("Not found", "NotFoundError");
    const file = new MockFileHandle(name, "");
    this.entriesMap.set(name, file);
    return file;
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    if (!this.entriesMap.delete(name)) throw new DOMException("Not found", "NotFoundError");
  }

  dir(name: string) {
    const dir = new MockDirectoryHandle(name, this.permission, this.requestedPermission);
    this.entriesMap.set(name, dir);
    return dir;
  }

  file(name: string, content: BlobPart, type?: string) {
    const file = new MockFileHandle(name, content, type);
    this.entriesMap.set(name, file);
    return file;
  }
}

function makeRoot(
  permission: PermissionState = "granted",
  requestedPermission: PermissionState = permission,
) {
  const root = new MockDirectoryHandle("Project", permission, requestedPermission);
  root.file(".secret", "hidden\nvalue");
  root.file("README.md", "hello\nworld");
  const src = root.dir("src");
  src.file("a.txt", "alpha\nbeta\ngamma");
  return root;
}

function mockPicker(root: MockDirectoryHandle) {
  const target = {};
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  Object.defineProperty(target, "showDirectoryPicker", {
    configurable: true,
    value: async () => root,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function bytes(size: number) {
  return new Uint8Array(size);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createMemoryPersistenceAdapter() {
  const records = new Map<string, PersistedUserSpaceRecord<MockDirectoryHandle>>();
  const adapter: UserSpacePersistenceAdapter<any> = {
    put: async (record) => {
      records.set(
        persistedRecordKey(record, record.mountId),
        record as PersistedUserSpaceRecord<MockDirectoryHandle>,
      );
    },
    get: async (scope, mountId) => records.get(persistedRecordKey(scope, mountId)) || null,
    getAll: async (scope) =>
      Array.from(records.values()).filter(
        (record) =>
          record.ownerUserId === scope.userId && record.ownerTenantId === (scope.tenantId || ""),
      ),
    delete: async (scope, mountId) => {
      records.delete(persistedRecordKey(scope, mountId));
    },
  };
  return {
    records,
    adapter,
  };
}

function persistedRecordKey(
  scope:
    | UserSpacePersistenceScope
    | Pick<PersistedUserSpaceRecord<unknown>, "ownerUserId" | "ownerTenantId">,
  mountId: string,
): string {
  const ownerUserId = "ownerUserId" in scope ? scope.ownerUserId : scope.userId;
  const ownerTenantId = "ownerTenantId" in scope ? scope.ownerTenantId : scope.tenantId || "";
  return JSON.stringify([ownerUserId, ownerTenantId, mountId]);
}

async function waitForPersistedRecord<T>(
  records: Map<string, T>,
  mountId: string,
  scope: UserSpacePersistenceScope = TEST_PERSISTENCE_SCOPE,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const record = records.get(persistedRecordKey(scope, mountId));
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for persisted user-space record ${mountId}.`);
}

async function waitForPersistedRecordCount<T>(
  records: Map<string, T>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (records.size === count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${count} persisted user-space records.`);
}

describe("user-space service", () => {
  beforeEach(() => {
    configureUserSpacePersistenceForTests(null);
    resetUserSpaceStateForTests();
    setUserSpaceTransport(() => {});
    mockPicker(makeRoot());
  });

  it("normalizes paths, rejects traversal, and allows explicit dot paths", async () => {
    // Normalization preserves the literal path; visibility is an output/search
    // preference rather than a low-level filesystem access restriction.
    expect(normalizeUserSpacePath("./src//a.txt")).toBe("src/a.txt");
    expect(normalizeUserSpacePath(".secret")).toBe(".secret");
    expect(() => normalizeUserSpacePath("../outside.txt")).toThrow("Path traversal");
    expect(() => normalizeUserSpacePath("/tmp/outside.txt")).toThrow("绝对路径");

    const mount = await mountUserSpace();
    const hidden = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: ".secret",
    })) as { content: string };

    expect(hidden.content).toBe("hidden\nvalue");
  });

  it("identifies a canceled directory picker as a benign abort", () => {
    // Chrome rejects showDirectoryPicker with AbortError when the user cancels
    // the native picker; callers use this to avoid showing a failure state.
    const abort = new Error(
      "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.",
    );
    abort.name = "AbortError";

    expect(isUserSpacePickerAbort(abort)).toBe(true);
    expect(isUserSpacePickerAbort(new Error("Permission denied"))).toBe(false);
  });

  it("fully indexes hidden and ignored-looking paths while default listing hides dot entries", async () => {
    const root = makeRoot();
    const config = root.dir(".config");
    config.file("a.json", '{"token":"secret-json"}');
    const git = root.dir(".git");
    git.file("config", "git hidden config");
    const nodeModules = root.dir("node_modules");
    const pkg = nodeModules.dir("pkg");
    pkg.file("index.js", "export const packageNeedle = true;");
    const dist = root.dir("dist");
    dist.file("app.js", "console.log('distNeedle');");
    mockPicker(root);

    const mount = await mountUserSpace();
    const synced = await syncUserSpaceMetadata(mount.mountId);
    const defaultList = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 20,
    })) as { entries: Array<{ name: string; kind: string; hidden?: boolean }> };
    const hiddenList = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      includeHidden: true,
      limit: 20,
    })) as { entries: Array<{ name: string; kind: string; hidden?: boolean }> };

    expect(synced.fileCount).toBe(7);
    expect(defaultList.entries.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining([".secret", ".config", ".git"]),
    );
    expect(defaultList.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["dist", "node_modules", "README.md", "src"]),
    );
    expect(hiddenList.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: ".secret", kind: "file", hidden: true }),
        expect.objectContaining({ name: ".config", kind: "directory", hidden: true }),
        expect.objectContaining({ name: ".git", kind: "directory", hidden: true }),
        expect.objectContaining({ name: "node_modules", kind: "directory", hidden: false }),
        expect.objectContaining({ name: "dist", kind: "directory", hidden: false }),
      ]),
    );
  });

  it("classifies extensionless and unknown-extension text files through indexed metadata", async () => {
    const root = new MockDirectoryHandle("Typed Project");
    root.file("Dockerfile", "FROM oven/bun:1\nRUN bun install\n", "");
    root.file("Dockerfile.server", "FROM node:22\nCMD node server.js\n", "");
    root.file("asset.server", new Uint8Array([0, 1, 2, 3, 4]), "application/octet-stream");
    root.file("README.md", "# Known markdown\n", "text/markdown");
    root.file("theme.mp3", new Uint8Array([1, 2, 3, 4]), "audio/mpeg");
    root.file("clip.mp4", new Uint8Array([1, 2, 3, 4]), "video/mp4");
    mockPicker(root);

    const mount = await mountUserSpace();
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 20,
    })) as {
      entries: Array<{
        name: string;
        previewKind?: string;
        supportsLineEdit?: boolean;
      }>;
    };

    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "Dockerfile",
        previewKind: "text",
        supportsLineEdit: true,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "Dockerfile.server",
        previewKind: "text",
        supportsLineEdit: true,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "README.md",
        previewKind: "text",
        supportsLineEdit: true,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "theme.mp3",
        previewKind: "audio",
        supportsLineEdit: false,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "clip.mp4",
        previewKind: "video",
        supportsLineEdit: false,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "asset.server",
        previewKind: "binary",
        supportsLineEdit: false,
      }),
    );
  });

  it("does not filter metadata and applies pi read truncation instead of legacy type limits", async () => {
    const root = new MockDirectoryHandle("Sized Project");
    const largeText = "x".repeat(1024 * 1024 + 1);
    root.file(
      "office-over-old-limit.docx",
      bytes(20 * 1024 * 1024 + 1),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    root.file("text-over-old-limit.txt", largeText, "text/plain");
    root.file("other-over-old-limit.bin", bytes(10 * 1024 * 1024 + 1), "application/octet-stream");
    mockPicker(root);

    const mount = await mountUserSpace();
    const synced = await syncUserSpaceMetadata(mount.mountId);
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 20,
    })) as {
      entries: Array<{
        name: string;
        previewKind?: string;
        supportsLineEdit?: boolean;
      }>;
    };
    const readLargeText = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "text-over-old-limit.txt",
    })) as { content: string; bytesRead: number; truncated: boolean };

    expect(synced.fileCount).toBe(3);
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "office-over-old-limit.docx",
        previewKind: "office",
        supportsLineEdit: false,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "text-over-old-limit.txt",
        previewKind: "text",
        supportsLineEdit: true,
      }),
    );
    expect(listed.entries).toContainEqual(
      expect.objectContaining({
        name: "other-over-old-limit.bin",
        previewKind: "binary",
        supportsLineEdit: false,
      }),
    );
    expect(readLargeText.bytesRead).toBe(largeText.length);
    expect(readLargeText.content).toContain("Line 1 is 1.0MB, exceeds 50.0KB limit");
    expect(readLargeText.truncated).toBe(true);
  });

  it("reuses an existing mount when the same directory is picked again", async () => {
    const root = makeRoot();
    mockPicker(root);

    const mount = await mountUserSpace();
    const repeated = await mountUserSpace();

    const listed = (await executeUserSpaceOperation("list_mounts")) as {
      mounts: Array<{ mountId: string; rootName: string }>;
    };
    expect(repeated.mountId).toBe(mount.mountId);
    expect(listed.mounts).toEqual([
      expect.objectContaining({ mountId: mount.mountId, rootName: "Project" }),
    ]);
  });

  it("renames a distinct same-named directory before registering the mount", async () => {
    const firstRoot = makeRoot();
    mockPicker(firstRoot);
    const first = await mountUserSpace();

    const secondRoot = makeRoot();
    mockPicker(secondRoot);
    const onNameConflict = vi.fn(async () => "Project Archive");
    const second = await mountUserSpace("readwrite", {
      existingRootNames: [first.rootName],
      onNameConflict,
    });

    expect(onNameConflict).toHaveBeenCalledWith({
      name: "Project",
      existingNames: ["Project"],
    });
    expect(second).toEqual(
      expect.objectContaining({ name: "Project Archive", rootName: "Project Archive" }),
    );
    expect(getMountedUserSpaces()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mountId: first.mountId, rootName: "Project" }),
        expect.objectContaining({ mountId: second.mountId, rootName: "Project Archive" }),
      ]),
    );
    const shell = (await executeUserSpaceOperation("shell_exec", {
      mountId: second.mountId,
      cwd: "/",
      script: "ls / && cd '/Project Archive' && pwd && ls",
    })) as { stdout: string; stderr: string; exitCode: number; cwd: string };
    expect(shell.exitCode).toBe(0);
    expect(shell.stderr).toBe("");
    expect(shell.cwd).toBe("/Project Archive");
    expect(shell.stdout).toContain("Project Archive\n");
    expect(shell.stdout).toContain("README.md");
  });

  it("updates a mounted directory alias without replacing its browser handle", async () => {
    const root = makeRoot();
    mockPicker(root);
    const mount = await mountUserSpace();

    const renamed = await renameUserSpaceMount(mount.mountId, "Client Archive");

    expect(renamed).toEqual(
      expect.objectContaining({
        mountId: mount.mountId,
        name: "Client Archive",
        rootName: "Client Archive",
      }),
    );
    expect(getMountedUserSpaces()).toContainEqual(
      expect.objectContaining({ mountId: mount.mountId, rootName: "Client Archive" }),
    );
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      path: "",
    })) as { entries: Array<{ name: string }> };
    expect(listed.entries.length).toBeGreaterThan(0);
  });

  it("releases a mounted runtime after the last session detaches it", async () => {
    const root = makeRoot();
    mockPicker(root);

    const mount = await mountUserSpace();
    attachUserSpaceMountsToSession("s1", [mount.mountId]);
    expect(getMountedUserSpaces()).toEqual([expect.objectContaining({ mountId: mount.mountId })]);

    detachUserSpaceFromSession("s1", mount.mountId);
    expect(getMountedUserSpaces()).toEqual([]);
    await expect(executeUserSpaceOperation("list_dir", { mountId: mount.mountId })).rejects.toThrow(
      "用户空间未在当前浏览器授权",
    );

    const remounted = await mountUserSpace();
    expect(remounted.mountId).not.toBe(mount.mountId);
  });

  it("deduplicates unchanged session mount announcements but forces one after reconnect", async () => {
    const transport = vi.fn();
    setUserSpaceTransport(transport);
    const mount = await mountUserSpace();

    attachUserSpaceMountsToSession("s1", [mount.mountId]);
    resendSessionUserSpaces("s1");
    resendSessionUserSpaces("s1");

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_space_mount",
        mounts: [expect.objectContaining({ mountId: mount.mountId, status: "mounted" })],
      }),
    );

    resendSessionUserSpaces("s1", { force: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared mounted runtime until every session detaches it", async () => {
    const mount = await mountUserSpace();
    attachUserSpaceMountsToSession("s1", [mount.mountId]);
    attachUserSpaceMountsToSession("s2", [mount.mountId]);

    detachUserSpaceFromSession("s1", mount.mountId);
    expect(getMountedUserSpaces()).toEqual([expect.objectContaining({ mountId: mount.mountId })]);

    detachUserSpaceFromSession("s2", mount.mountId);
    expect(getMountedUserSpaces()).toEqual([]);
  });

  it("keeps multiple user-space mounts attached to the same session", async () => {
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    mockPicker(firstRoot);
    const first = await mountUserSpace();
    mockPicker(secondRoot);
    const second = await mountUserSpace();

    attachUserSpaceMountsToSession("s1", [first.mountId, second.mountId]);

    expect(getMountedUserSpaces()).toEqual([
      expect.objectContaining({ mountId: first.mountId }),
      expect.objectContaining({ mountId: second.mountId }),
    ]);
    await expect(
      executeUserSpaceOperation("list_dir", { mountId: first.mountId }),
    ).resolves.toEqual(
      expect.objectContaining({
        entries: expect.any(Array),
      }),
    );
  });

  it("prunes old persisted records for the same picked directory", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);

    const first = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    attachUserSpaceMountsToSession("s1", [first.mountId]);
    await waitForPersistedRecord(persistence.records, first.mountId);
    detachUserSpaceFromSession("s1", first.mountId);

    const second = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    attachUserSpaceMountsToSession("s1", [second.mountId]);
    await waitForPersistedRecord(persistence.records, second.mountId);
    await waitForPersistedRecordCount(persistence.records, 1);

    expect(persistence.records.has(persistedRecordKey(TEST_PERSISTENCE_SCOPE, first.mountId))).toBe(
      false,
    );
    expect(
      persistence.records.has(persistedRecordKey(TEST_PERSISTENCE_SCOPE, second.mountId)),
    ).toBe(true);
  });

  it("mounts an automation workspace from localStorage without opening the native picker", async () => {
    // Browser automation cannot reliably drive Chromium's native directory
    // picker. The dev/test mount fixture exercises the same in-memory handle
    // registry without blocking on OS UI.
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) || null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    storage.set(
      "piwork:test-user-space",
      JSON.stringify({
        name: "Automation Files",
        directories: ["docs"],
        files: {
          "README.md": "hello automation",
          "docs/notes.txt": "nested note",
        },
      }),
    );

    const mount = await mountUserSpace();
    const root = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string; kind: string }> };
    const nested = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "docs/notes.txt",
    })) as { content: string };

    expect(mount.rootName).toBe("Automation Files");
    expect(root.entries).toContainEqual(
      expect.objectContaining({ name: "README.md", kind: "file" }),
    );
    expect(root.entries).toContainEqual(
      expect.objectContaining({ name: "docs", kind: "directory" }),
    );
    expect(nested.content).toBe("nested note");
  });

  it("paginates the current directory from native handles without scanning the whole directory", async () => {
    const root = new MockDirectoryHandle("Large Project");
    for (let index = 0; index < 100; index++) {
      root.file(`file-${String(index).padStart(3, "0")}.txt`, `content ${index}`);
    }
    mockPicker(root);

    const mount = await mountUserSpace();
    expect(mount.fileCount).toBeUndefined();
    expect(root.iteratedEntries).toBe(0);
    const first = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 10,
    })) as {
      entries: Array<{ name: string }>;
      nextCursor?: string;
      loaded: number;
      total?: number;
    };

    expect(first.entries).toHaveLength(10);
    expect(first.nextCursor).toBe("10");
    expect(first.total).toBeUndefined();
    expect(root.iteratedEntries).toBe(11);

    const second = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 10,
      cursor: first.nextCursor,
    })) as {
      entries: Array<{ name: string }>;
      nextCursor?: string;
      loaded: number;
      total?: number;
    };

    expect(second.entries[0]?.name).toBe("file-010.txt");
    expect(second.nextCursor).toBe("20");
    expect(second.total).toBeUndefined();
    expect(root.iteratedEntries).toBe(32);
  });

  it("bounds large directory responses while reading only the requested native page", async () => {
    const root = new MockDirectoryHandle("Huge Project");
    for (let index = 0; index < 300; index++) {
      root.file(`asset-${String(index).padStart(3, "0")}.txt`, `content ${index}`);
    }
    mockPicker(root);

    const mount = await mountUserSpace();
    expect(mount.fileCount).toBeUndefined();
    expect(root.iteratedEntries).toBe(0);
    const first = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 500,
    })) as {
      entries: Array<{ name: string }>;
      nextCursor?: string;
      loaded: number;
      total?: number;
    };

    expect(first.entries).toHaveLength(200);
    expect(first.loaded).toBe(200);
    expect(first.nextCursor).toBe("200");
    expect(first.total).toBeUndefined();
    expect(root.iteratedEntries).toBe(201);
  });

  it("does not persist metadata arrays across refresh restore", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = new MockDirectoryHandle("Huge Persisted Project");
    for (let index = 0; index < 2001; index++) {
      root.file(`asset-${String(index).padStart(4, "0")}.txt`, `content ${index}`);
    }
    mockPicker(root);

    const mount = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    expect(mount.fileCount).toBeUndefined();
    expect(
      (await waitForPersistedRecord(persistence.records, mount.mountId)).metadataEntries,
    ).toBeUndefined();

    root.iteratedEntries = 0;
    resetUserSpaceStateForTests();

    const restored = await restorePersistedUserSpaces(TEST_PERSISTENCE_SCOPE, [
      { ...mount, status: "offline" },
    ]);
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 10,
    })) as { entries: Array<{ name: string }>; total?: number };

    expect(restored).toEqual([
      expect.objectContaining({ mountId: mount.mountId, status: "mounted" }),
    ]);
    expect(listed.entries).toHaveLength(10);
    expect(listed.total).toBeUndefined();
    expect(root.iteratedEntries).toBe(11);
    expect(
      persistence.records.get(persistedRecordKey(TEST_PERSISTENCE_SCOPE, mount.mountId))
        ?.metadataEntries,
    ).toBeUndefined();
  });

  it("uses native listing as the source of truth and syncs metadata explicitly", async () => {
    const root = makeRoot();
    mockPicker(root);
    const mount = await mountUserSpace();
    root.file("new-local-file.txt", "fresh");

    const native = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string }> };
    expect(native.entries.map((entry) => entry.name)).toContain("new-local-file.txt");

    const synced = await syncUserSpaceMetadata(mount.mountId);
    const fresh = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string }> };

    expect(synced.fileCount).toBe(4);
    expect(fresh.entries.map((entry) => entry.name)).toContain("new-local-file.txt");
  });

  it("rejects the removed startLine/endLine read contract", async () => {
    const mount = await mountUserSpace();
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "src/a.txt",
        startLine: 2,
        endLine: 2,
      }),
    ).rejects.toThrow("offset plus limit");
  });

  it("uses pi offset and limit semantics for exact line ranges", async () => {
    const root = makeRoot();
    root.file("lines.txt", "one\n\nthree\nfour\nfive");
    mockPicker(root);
    const mount = await mountUserSpace();

    const blankLine = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "lines.txt",
      offset: 2,
      limit: 1,
    })) as { content: string; nextOffset?: number; totalLines: number };
    const range = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "lines.txt",
      offset: 3,
      limit: 2,
    })) as { content: string; nextOffset?: number };

    expect(blankLine.content).toBe("\n\n[3 more lines in file. Use offset=3 to continue.]");
    expect(blankLine.nextOffset).toBe(3);
    expect(blankLine.totalLines).toBe(5);
    expect(range.content).toBe("three\nfour\n\n[1 more lines in file. Use offset=5 to continue.]");
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "lines.txt",
        offset: 6,
      }),
    ).rejects.toThrow("Offset 6 is beyond end of file (5 lines total)");
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "lines.txt",
        offset: 0,
      }),
    ).rejects.toThrow("positive integer");
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "lines.txt",
        limit: 1.5,
      }),
    ).rejects.toThrow("positive integer");
  });

  it("truncates pi reads at 2000 lines and returns a continuation offset", async () => {
    const root = makeRoot();
    root.file(
      "many-lines.txt",
      Array.from({ length: 2500 }, (_, index) => `Line ${index + 1}`).join("\n"),
    );
    mockPicker(root);
    const mount = await mountUserSpace();

    const result = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "many-lines.txt",
    })) as { content: string; truncated: boolean; truncatedBy?: string; nextOffset?: number };

    expect(result.content).toContain("Line 2000");
    expect(result.content).not.toContain("Line 2001");
    expect(result.content).toContain(
      "[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]",
    );
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.nextOffset).toBe(2001);
  });

  it("preserves readonly access and rejects destructive write operations", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const mount = await mountUserSpace("readonly", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });

    expect(mount.access).toBe("readonly");
    expect(mount.canWrite).toBe(false);
    expect((await waitForPersistedRecord(persistence.records, mount.mountId)).access).toBe(
      "readonly",
    );
    await expect(
      executeUserSpaceOperation("write_file", {
        mountId: mount.mountId,
        path: "notes.txt",
        content: "nope",
      }),
    ).rejects.toThrow("只读");

    const updated = await updateUserSpaceAccess(mount.mountId, "readwrite");
    expect(updated.access).toBe("readwrite");
    expect(updated.canWrite).toBe(true);
    expect(
      persistence.records.get(persistedRecordKey(TEST_PERSISTENCE_SCOPE, mount.mountId))?.access,
    ).toBe("readwrite");
  });

  it("returns blob metadata for non-text files without content or base64", async () => {
    const root = makeRoot();
    root.file("image.bin", new Uint8Array([0, 1, 2, 3]), "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace();

    const result = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "image.bin",
    })) as {
      kind?: string;
      canCheckout?: boolean;
      base64?: string;
      content?: string;
      hint?: string;
    };

    expect(result.kind).toBe("blob");
    expect(result.canCheckout).toBe(false);
    expect(result.base64).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.hint).toContain("session-relative Agent Space shared/path");
    expect(result.hint).toContain("checkin shared/path rootName/path");
  });

  it("returns a browser File for local preview without going through the backend", async () => {
    // The left-side preview reads from the in-memory File System Access handle
    // registry, preserving the browser-only workspace boundary.
    const mount = await mountUserSpace();
    const file = await getUserSpaceFile(mount.mountId, "README.md");

    expect(file.name).toBe("README.md");
    expect(await file.text()).toBe("hello\nworld");
  });

  it("saves browser preview blobs back through the mounted file handle", async () => {
    const root = makeRoot();
    const report = root.file(
      "report.docx",
      new Uint8Array([1, 2, 3]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const savedFile = new File([new Uint8Array([9, 8, 7, 6])], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const result = await saveUserSpaceFile(mount.mountId, "report.docx", savedFile);
    const updated = await report.getFile();

    expect(result).toMatchObject({
      mountId: mount.mountId,
      path: "report.docx",
      bytesWritten: 4,
    });
    expect(new Uint8Array(await updated.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6]));
    expect(updated.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("can create an OOXML target when a legacy Office preview save migrates extensions", async () => {
    const root = makeRoot();
    root.file("legacy.xls", new Uint8Array([1, 2, 3]), "application/vnd.ms-excel");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const savedFile = new File([new Uint8Array([80, 75, 3, 4])], "legacy.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await saveUserSpaceFile(mount.mountId, "legacy.xlsx", savedFile, {
      create: true,
    });
    const created = root.entriesMap.get("legacy.xlsx") as MockFileHandle | undefined;

    expect(result).toMatchObject({
      mountId: mount.mountId,
      path: "legacy.xlsx",
      bytesWritten: 4,
    });
    expect(created?.kind).toBe("file");
    expect(new Uint8Array(await (await created!.getFile()).arrayBuffer())).toEqual(
      new Uint8Array([80, 75, 3, 4]),
    );
    expect(root.entriesMap.has("legacy.xls")).toBe(true);
  });

  it("does not retain browser File snapshots between repeated previews", async () => {
    // Reopening the same file should ask the File System Access handle for a
    // fresh snapshot, so closing preview tabs can release the previous File.
    const root = makeRoot();
    const readmeFile = root.entriesMap.get("README.md") as MockFileHandle;
    mockPicker(root);

    const mount = await mountUserSpace();
    const metadataReadsAfterMount = readmeFile.getFileCalls;
    await getUserSpaceFile(mount.mountId, "README.md");
    await getUserSpaceFile(mount.mountId, "README.md");

    expect(readmeFile.getFileCalls).toBe(metadataReadsAfterMount + 2);
  });

  it("persists directory handles and restores them after an in-memory reset", async () => {
    // FileSystemDirectoryHandle objects are serializable into IndexedDB. The
    // service restores those handles after a refresh without opening the picker.
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);

    const mount = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    const persisted = await waitForPersistedRecord(persistence.records, mount.mountId);
    expect(persisted.root).toBe(root);
    expect(persisted.metadataVersion).toBeUndefined();
    expect(persisted.metadataEntries).toBeUndefined();

    const srcDir = root.entriesMap.get("src") as MockDirectoryHandle;
    root.iteratedEntries = 0;
    srcDir.iteratedEntries = 0;

    resetUserSpaceStateForTests();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        showDirectoryPicker: async () => {
          throw new Error("picker should not be used for persisted restore");
        },
      },
    });

    const restored = await restorePersistedUserSpaces(TEST_PERSISTENCE_SCOPE, [
      { ...mount, status: "offline" },
    ]);
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string }> };
    const readme = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "README.md",
    })) as { content: string };

    expect(restored).toEqual([
      expect.objectContaining({ mountId: mount.mountId, status: "mounted" }),
    ]);
    expect(listed.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["README.md", "src"]),
    );
    expect(listed.entries).toHaveLength(2);
    expect(root.iteratedEntries).toBe(3);
    expect(srcDir.iteratedEntries).toBe(0);
    expect(readme.content).toBe("hello\nworld");
  });

  it("keeps a persisted directory offline until reauthorization is requested", async () => {
    // Automatic refresh restore only queries permission. A user-initiated
    // reauthorization may call requestPermission and then mount the saved handle.
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);

    const mount = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    root.permission = "prompt";
    root.requestedPermission = "granted";
    resetUserSpaceStateForTests();

    const passive = await restorePersistedUserSpaces(TEST_PERSISTENCE_SCOPE, [
      { ...mount, status: "offline" },
    ]);
    expect(passive).toEqual([
      expect.objectContaining({ mountId: mount.mountId, status: "offline" }),
    ]);
    await expect(executeUserSpaceOperation("list_dir", { mountId: mount.mountId })).rejects.toThrow(
      "用户空间未在当前浏览器授权",
    );

    const restored = await restorePersistedUserSpace(
      TEST_PERSISTENCE_SCOPE,
      { ...mount, status: "offline" },
      { requestPermission: true },
    );
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string }> };

    expect(restored).toEqual(
      expect.objectContaining({ mountId: mount.mountId, status: "mounted" }),
    );
    expect(listed.entries.map((entry) => entry.name)).toContain("README.md");
  });

  it("does not register a persisted handle whose permission check finishes after dispose", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);
    const mount = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    await waitForPersistedRecord(persistence.records, mount.mountId);
    resetUserSpaceStateForTests();

    const permissionStarted = deferred<void>();
    const permission = deferred<PermissionState>();
    root.queryPermission = async () => {
      permissionStarted.resolve();
      return permission.promise;
    };
    const pending = restorePersistedUserSpaces(TEST_PERSISTENCE_SCOPE, [
      { ...mount, status: "offline" },
    ]);
    await permissionStarted.promise;

    resetUserSpaceStateForTests();
    permission.resolve("granted");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getMountedUserSpaces()).toEqual([]);
  });

  it("does not register a directory picker result that arrives after dispose", async () => {
    const picked = deferred<MockDirectoryHandle>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { showDirectoryPicker: () => picked.promise },
    });
    const pending = mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });

    resetUserSpaceStateForTests();
    picked.resolve(makeRoot());

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getMountedUserSpaces()).toEqual([]);
  });

  it("reuses a same-name persisted directory handle when restoring a mount with a new id", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot("prompt", "granted");
    mockPicker(root);

    const original = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    await waitForPersistedRecord(persistence.records, original.mountId);
    resetUserSpaceStateForTests();

    const expected = {
      ...original,
      mountId: "uw-shirai-session",
      status: "offline" as const,
      canRead: false,
      canWrite: false,
    };
    const restored = await restorePersistedUserSpace(TEST_PERSISTENCE_SCOPE, expected, {
      requestPermission: true,
    });
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: "uw-shirai-session",
    })) as { entries: Array<{ name: string }> };

    expect(restored).toEqual(
      expect.objectContaining({ mountId: "uw-shirai-session", status: "mounted" }),
    );
    expect(listed.entries.map((entry) => entry.name)).toContain("README.md");
    expect(
      persistence.records.get(persistedRecordKey(TEST_PERSISTENCE_SCOPE, "uw-shirai-session"))
        ?.root,
    ).toBe(root);
  });

  it("does not reuse exact-id or same-name handles across accounts or tenants", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);

    const original = await mountUserSpace("readwrite", {
      persistenceScope: TEST_PERSISTENCE_SCOPE,
    });
    await waitForPersistedRecord(persistence.records, original.mountId);
    resetUserSpaceStateForTests();

    const otherAccount = { userId: "better-auth-user-b", tenantId: "tenant-a" };
    const exactId = await restorePersistedUserSpace(otherAccount, {
      ...original,
      status: "offline",
    });
    const sameName = await restorePersistedUserSpace(otherAccount, {
      ...original,
      mountId: "uw-other-account-same-name",
      status: "offline",
    });
    const otherTenant = await restorePersistedUserSpace(
      { userId: TEST_PERSISTENCE_SCOPE.userId, tenantId: "tenant-b" },
      { ...original, status: "offline" },
    );

    expect(exactId).toEqual(expect.objectContaining({ status: "offline" }));
    expect(sameName).toEqual(expect.objectContaining({ status: "offline" }));
    expect(otherTenant).toEqual(expect.objectContaining({ status: "offline" }));
    expect(getMountedUserSpaces()).toEqual([]);
  });

  it("ignores ownerless v1 records even when an adapter returns them", async () => {
    const root = makeRoot();
    const expected = {
      mountId: "uw-legacy",
      name: root.name,
      rootName: root.name,
      status: "offline" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };
    const legacyRecord = {
      ...expected,
      status: undefined,
      updatedAt: Date.now(),
      root,
    };
    configureUserSpacePersistenceForTests({
      put: async () => {},
      get: async () => legacyRecord as unknown as PersistedUserSpaceRecord<any>,
      getAll: async () => [legacyRecord as unknown as PersistedUserSpaceRecord<any>],
      delete: async () => {},
    });

    const restored = await restorePersistedUserSpace(TEST_PERSISTENCE_SCOPE, expected, {
      requestPermission: true,
    });

    expect(restored).toEqual(
      expect.objectContaining({ mountId: expected.mountId, status: "offline" }),
    );
    expect(getMountedUserSpaces()).toEqual([]);
  });

  it("remounts a picked directory while preserving the expected mount id", async () => {
    const persistence = createMemoryPersistenceAdapter();
    configureUserSpacePersistenceForTests(persistence.adapter);
    const root = makeRoot();
    mockPicker(root);

    const remounted = await remountUserSpace(
      {
        mountId: "uw-existing-session",
        name: "Old Name",
        rootName: "Old Name",
        status: "offline",
        access: "readwrite",
        includeHidden: true,
      },
      { persistenceScope: TEST_PERSISTENCE_SCOPE },
    );
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: "uw-existing-session",
    })) as { entries: Array<{ name: string }> };

    expect(remounted).toEqual(
      expect.objectContaining({
        mountId: "uw-existing-session",
        rootName: "Project",
        status: "mounted",
      }),
    );
    expect(listed.entries.map((entry) => entry.name)).toContain("README.md");
    expect(
      persistence.records.get(persistedRecordKey(TEST_PERSISTENCE_SCOPE, "uw-existing-session"))
        ?.root,
    ).toBe(root);
  });

  it("searches text files and returns line-level matches", async () => {
    // Validates on-demand text search through cached handles without sending a
    // full directory snapshot to the backend.
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "beta",
      pathPrefix: "src",
    })) as { matches: Array<{ path: string; lineNumber: number; line: string }> };

    expect(result.matches).toEqual([
      expect.objectContaining({ path: "src/a.txt", lineNumber: 2, line: "beta" }),
    ]);
  });

  it("applies grep-style include and exclude globs recursively by basename", async () => {
    const root = new MockDirectoryHandle("Grep Glob Project");
    root.file("root.ts", "needle root");
    const src = root.dir("src");
    src.file("keep.ts", "needle keep");
    src.file("skip.test.ts", "needle skip");
    src.file("other.js", "needle js");
    mockPicker(root);

    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "needle",
      includeGlobs: ["*.ts"],
      excludeGlobs: ["*.test.ts"],
    })) as { matches: Array<{ path: string }> };

    expect(result.matches.map((match) => match.path)).toEqual(["root.ts", "src/keep.ts"]);
  });

  it("searches indexed paths through the user-space operation bridge", async () => {
    const root = new MockDirectoryHandle("Search Project");
    const docs = root.dir("docs");
    docs.file("guide.md", "# guide");
    const guideFolder = root.dir("guide-folder");
    guideFolder.file("child.txt", "child");
    const hidden = root.dir(".config");
    hidden.file("guide-secret.json", "{}");
    mockPicker(root);

    const mount = await mountUserSpace();
    const visibleSearch = (await executeUserSpaceOperation("search_paths", {
      mountId: mount.mountId,
      query: "guide",
      limit: 20,
    })) as { entries: Array<{ path: string }> };
    const hiddenSearch = (await executeUserSpaceOperation("search_paths", {
      mountId: mount.mountId,
      query: "guide",
      includeHidden: true,
      limit: 20,
    })) as { entries: Array<{ path: string }> };

    expect(visibleSearch.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["docs/guide.md", "guide-folder"]),
    );
    expect(visibleSearch.entries.map((entry) => entry.path)).not.toContain(
      "guide-folder/child.txt",
    );
    expect(hiddenSearch.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["docs/guide.md", ".config/guide-secret.json"]),
    );
    expect(hiddenSearch.entries.map((entry) => entry.path)).not.toContain("guide-folder/child.txt");
  });

  it("recursively globs file-tree paths with globstar, character classes, and hidden filtering", async () => {
    const root = new MockDirectoryHandle("Glob Project");
    root.file("root.ts", "root");
    const src = root.dir("src");
    src.file("app.ts", "app");
    src.file("app.tsx", "tsx");
    const nested = src.dir("nested");
    nested.file("a1.ts", "nested");
    nested.file("b2.js", "js");
    const hidden = root.dir(".hidden");
    hidden.file("secret.ts", "secret");
    mockPicker(root);

    const mount = await mountUserSpace();
    const recursive = (await executeUserSpaceOperation("glob", {
      mountId: mount.mountId,
      pattern: "**/*.ts",
      filesOnly: true,
    })) as { entries: Array<{ path: string }> };
    const characterClass = (await executeUserSpaceOperation("glob", {
      mountId: mount.mountId,
      pattern: "**/[ab]?.*",
      filesOnly: true,
    })) as { entries: Array<{ path: string }> };
    const hiddenIncluded = (await executeUserSpaceOperation("glob", {
      mountId: mount.mountId,
      pattern: "**/*.ts",
      includeHidden: true,
      filesOnly: true,
    })) as { entries: Array<{ path: string }> };

    expect(recursive.entries.map((entry) => entry.path)).toEqual([
      "root.ts",
      "src/app.ts",
      "src/nested/a1.ts",
    ]);
    expect(characterClass.entries.map((entry) => entry.path)).toEqual([
      "src/nested/a1.ts",
      "src/nested/b2.js",
    ]);
    expect(hiddenIncluded.entries.map((entry) => entry.path)).toContain(".hidden/secret.ts");
  });

  it("does not cap default user-space search results at 50", async () => {
    const root = new MockDirectoryHandle("Large Search Project");
    for (let index = 0; index < 65; index++) {
      root.file(`match-${String(index).padStart(2, "0")}.txt`, `hit line ${index}`);
    }
    mockPicker(root);

    const mount = await mountUserSpace();
    const pathSearch = (await executeUserSpaceOperation("search_paths", {
      mountId: mount.mountId,
      query: "match-",
    })) as { entries: Array<{ path: string }>; nextCursor?: string };
    const contentSearch = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "hit line",
    })) as { matches: Array<{ path: string }>; truncated?: boolean };

    expect(pathSearch.entries).toHaveLength(65);
    expect(pathSearch.nextCursor).toBeUndefined();
    expect(contentSearch.matches).toHaveLength(65);
    expect(contentSearch.truncated).toBe(false);
  });

  it("searches a single file path prefix without treating it as a directory", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "beta",
      pathPrefix: "src/a.txt",
    })) as { matches: Array<{ path: string; lineNumber: number; line: string }> };

    expect(result.matches).toEqual([
      expect.objectContaining({ path: "src/a.txt", lineNumber: 2, line: "beta" }),
    ]);
  });

  it("indexes all text-preview files and applies searchHiddenEntries-style filtering", async () => {
    const root = new MockDirectoryHandle("Search Project");
    root.file("README", "visibleNeedle in extensionless text");
    root.file("app.js", "const visibleNeedle = true;");
    root.file("notes.md", "visibleNeedle in markdown should be indexed");
    const config = root.dir(".config");
    config.file("settings.json", '{"hiddenNeedle":true}');
    mockPicker(root);

    const mount = await mountUserSpace();
    const visibleSearch = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "visibleNeedle",
      limit: 20,
    })) as { matches: Array<{ path: string }> };
    const hiddenDefault = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "hiddenNeedle",
      limit: 20,
    })) as { matches: Array<{ path: string }> };
    const hiddenIncluded = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "hiddenNeedle",
      includeHidden: true,
      limit: 20,
    })) as { matches: Array<{ path: string }> };

    expect(visibleSearch.matches.map((match) => match.path)).toEqual(
      expect.arrayContaining(["README", "app.js", "notes.md"]),
    );
    expect(visibleSearch.matches).toHaveLength(3);
    expect(hiddenDefault.matches).toEqual([]);
    expect(hiddenIncluded.matches.map((match) => match.path)).toEqual([".config/settings.json"]);
  });

  it("writes, replaces, and deletes entries through directory handles", async () => {
    // Validates destructive operations use File System Access write/remove APIs
    // and update subsequent on-demand reads/lists.
    const mount = await mountUserSpace();
    await executeUserSpaceOperation("write_file", {
      mountId: mount.mountId,
      path: "notes/new.txt",
      content: "one two four",
      createParents: true,
    });
    await executeUserSpaceOperation("replace_text", {
      mountId: mount.mountId,
      path: "notes/new.txt",
      edits: [
        { oldText: "one", newText: "three" },
        { oldText: "four", newText: "three" },
      ],
    });
    const read = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "notes/new.txt",
    })) as { content: string };
    await executeUserSpaceOperation("delete_entry", {
      mountId: mount.mountId,
      path: "notes/new.txt",
    });
    const listed = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      path: "notes",
    })) as { entries: Array<{ name: string }> };

    expect(read.content).toBe("three two three");
    expect(listed.entries.map((entry) => entry.name)).not.toContain("new.txt");
  });

  it("rejects a delayed write after the mounted directory is replaced", async () => {
    const originalRoot = makeRoot();
    const originalFile = originalRoot.entriesMap.get("README.md") as MockFileHandle;
    mockPicker(originalRoot);
    const mount = await mountUserSpace("readwrite");
    const permissionStarted = deferred<void>();
    const permission = deferred<PermissionState>();
    originalRoot.queryPermission = async () => {
      permissionStarted.resolve();
      return permission.promise;
    };

    const pendingWrite = executeUserSpaceOperation("write_file", {
      mountId: mount.mountId,
      path: "README.md",
      content: "stale write",
    });
    await permissionStarted.promise;

    const replacementRoot = makeRoot();
    mockPicker(replacementRoot);
    await remountUserSpace(mount);
    permission.resolve("granted");

    await expect(pendingWrite).rejects.toThrow();
    expect(await (await originalFile.getFile()).text()).toBe("hello\nworld");
    expect(
      await (
        await (replacementRoot.entriesMap.get("README.md") as MockFileHandle).getFile()
      ).text(),
    ).toBe("hello\nworld");
  });

  it("rechecks revoked directory permission before writing", async () => {
    const root = makeRoot();
    const file = root.entriesMap.get("README.md") as MockFileHandle;
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const writable = await file.createWritable();
    const writableRequested = deferred<void>();
    const writableReady = deferred<typeof writable>();
    file.createWritable = async () => {
      writableRequested.resolve();
      return writableReady.promise;
    };

    const pendingWrite = executeUserSpaceOperation("write_file", {
      mountId: mount.mountId,
      path: "README.md",
      content: "must not be written",
    });
    await writableRequested.promise;
    root.permission = "denied";
    root.requestedPermission = "denied";
    writableReady.resolve(writable);

    await expect(pendingWrite).rejects.toThrow("permission");
    expect(await (await file.getFile()).text()).toBe("hello\nworld");
  });

  it("aborts a staged file write when the directory changes before close", async () => {
    const originalRoot = makeRoot();
    const originalFile = originalRoot.entriesMap.get("README.md") as MockFileHandle;
    mockPicker(originalRoot);
    const mount = await mountUserSpace("readwrite");
    const writeStarted = deferred<void>();
    const finishWrite = deferred<void>();
    let staged: BlobPart = originalFile.content;
    let closed = false;
    let aborted = false;
    originalFile.createWritable = async () => ({
      write: async (data: string | Blob | BufferSource) => {
        staged = data;
        writeStarted.resolve();
        await finishWrite.promise;
      },
      close: async () => {
        closed = true;
        originalFile.content = staged;
      },
      abort: async () => {
        aborted = true;
      },
    });

    const pendingWrite = executeUserSpaceOperation("write_file", {
      mountId: mount.mountId,
      path: "README.md",
      content: "stale staged write",
    });
    await writeStarted.promise;

    mockPicker(makeRoot());
    await remountUserSpace(mount);
    finishWrite.resolve();

    await expect(pendingWrite).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
    expect(await (await originalFile.getFile()).text()).toBe("hello\nworld");
  });

  it("rejects a delayed read-modify-write edit after the directory is replaced", async () => {
    const originalRoot = makeRoot();
    const originalFile = originalRoot.entriesMap.get("README.md") as MockFileHandle;
    const nativeGetFile = originalFile.getFile.bind(originalFile);
    const textStarted = deferred<void>();
    const finishText = deferred<void>();
    originalFile.getFile = async () => {
      const snapshot = await nativeGetFile();
      Object.defineProperty(snapshot, "text", {
        configurable: true,
        value: async () => {
          textStarted.resolve();
          await finishText.promise;
          return "hello\nworld";
        },
      });
      return snapshot;
    };
    mockPicker(originalRoot);
    const mount = await mountUserSpace("readwrite");

    const pendingEdit = executeUserSpaceOperation("replace_text", {
      mountId: mount.mountId,
      path: "README.md",
      edits: [{ oldText: "hello", newText: "stale" }],
    });
    await textStarted.promise;
    mockPicker(makeRoot());
    await remountUserSpace(mount);
    finishText.resolve();

    await expect(pendingEdit).rejects.toThrow();
    expect(originalFile.content).toBe("hello\nworld");
    expect(getUserSpaceSnapshot().recentOperations).toEqual([]);
  });

  it("matches pi edit uniqueness, multi-edit atomicity, fuzzy text, and CRLF preservation", async () => {
    const root = makeRoot();
    root.file("duplicate.txt", "foo foo foo");
    root.file("multi.txt", "alpha\nbeta\ngamma\ndelta\n");
    root.file("fuzzy.txt", "console.log(‘hello’);  \r\nkeep  \r\n");
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("replace_text", {
        mountId: mount.mountId,
        path: "duplicate.txt",
        edits: [{ oldText: "foo", newText: "bar" }],
      }),
    ).rejects.toThrow("Found 3 occurrences");

    await executeUserSpaceOperation("replace_text", {
      mountId: mount.mountId,
      path: "multi.txt",
      edits: [
        { oldText: "alpha\n", newText: "ALPHA\n" },
        { oldText: "gamma\n", newText: "GAMMA\n" },
      ],
    });
    const multi = await getUserSpaceFile(mount.mountId, "multi.txt");
    expect(await multi.text()).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");

    await executeUserSpaceOperation("replace_text", {
      mountId: mount.mountId,
      path: "fuzzy.txt",
      edits: [{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" }],
    });
    const fuzzy = await getUserSpaceFile(mount.mountId, "fuzzy.txt");
    expect(await fuzzy.text()).toBe("console.log('world');\r\nkeep  \r\n");
  });

  it("creates and manages files through structured file operations", async () => {
    const mount = await mountUserSpace();
    const createdDir = (await executeUserSpaceOperation("create_entry", {
      mountId: mount.mountId,
      parentPath: "",
      name: "notes",
      kind: "directory",
    })) as { path: string; kind: string };
    const createdFile = (await executeUserSpaceOperation("create_entry", {
      mountId: mount.mountId,
      parentPath: "notes",
      name: "todo.txt",
      kind: "file",
      content: "ship issue 21",
    })) as { path: string; kind: string };
    const renamed = (await executeUserSpaceOperation("rename_entry", {
      mountId: mount.mountId,
      path: "notes/todo.txt",
      name: "done.txt",
    })) as { newPath: string; renamed: boolean };
    const duplicated = (await executeUserSpaceOperation("duplicate_entry", {
      mountId: mount.mountId,
      path: "notes/done.txt",
    })) as { path: string };
    const copied = (await executeUserSpaceOperation("copy_entry", {
      mountId: mount.mountId,
      sourcePath: "notes/done.txt",
      targetDirPath: "notes",
      conflict: "rename",
    })) as { path: string };
    const copiedDir = (await executeUserSpaceOperation("copy_entry", {
      mountId: mount.mountId,
      sourcePath: "notes",
      targetDirPath: "",
      conflict: "rename",
    })) as { path: string };
    const copiedDirRead = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: `${copiedDir.path}/done.txt`,
    })) as { content: string };
    await expect(
      executeUserSpaceOperation("copy_entry", {
        mountId: mount.mountId,
        sourcePath: "notes",
        targetDirPath: "notes",
        conflict: "rename",
      }),
    ).rejects.toThrow("不能将");
    const read = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "notes/done.txt",
    })) as { content: string };
    const extensionRenamed = (await executeUserSpaceOperation("rename_entry", {
      mountId: mount.mountId,
      path: "notes/done.txt",
      name: "done.md",
    })) as { newPath: string; renamed: boolean };
    const extensionRenamedRead = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "notes/done.md",
    })) as { content: string };
    await executeUserSpaceOperation("delete_entry", {
      mountId: mount.mountId,
      path: "notes",
      recursive: true,
    });
    await executeUserSpaceOperation("delete_entry", {
      mountId: mount.mountId,
      path: copiedDir.path,
      recursive: true,
    });
    const root = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
    })) as { entries: Array<{ name: string }> };

    expect(createdDir).toEqual(expect.objectContaining({ path: "notes", kind: "directory" }));
    expect(createdFile).toEqual(expect.objectContaining({ path: "notes/todo.txt", kind: "file" }));
    expect(renamed).toEqual(expect.objectContaining({ newPath: "notes/done.txt", renamed: true }));
    expect(duplicated.path).toBe("notes/done 副本.txt");
    expect(copied.path).toBe("notes/done 副本 2.txt");
    expect(copiedDir.path).toBe("notes 副本");
    expect(copiedDirRead.content).toBe("ship issue 21");
    expect(read.content).toBe("ship issue 21");
    expect(extensionRenamed).toEqual(
      expect.objectContaining({ newPath: "notes/done.md", renamed: true }),
    );
    expect(extensionRenamedRead.content).toBe("ship issue 21");
    expect(root.entries.map((entry) => entry.name)).not.toContain("notes");
    expect(root.entries.map((entry) => entry.name)).not.toContain("notes 副本");
  });

  it("copies a maximal multi-selection of files and folders without removing the sources", async () => {
    const root = makeRoot();
    root.dir("archive");
    mockPicker(root);
    const mount = await mountUserSpace();

    const copied = (await executeUserSpaceOperation("copy_entries", {
      mountId: mount.mountId,
      paths: ["README.md", "src", "src/a.txt"],
      targetDirPath: "archive",
    })) as {
      moves: Array<{ sourcePath: string; path: string; kind: string }>;
      changedDirs: string[];
    };

    expect(copied.moves).toEqual([
      { sourcePath: "README.md", path: "archive/README.md", kind: "file" },
      { sourcePath: "src", path: "archive/src", kind: "directory" },
    ]);
    expect(copied.changedDirs).toEqual(expect.arrayContaining(["archive"]));
    expect(
      await (await (root.entriesMap.get("README.md") as MockFileHandle).getFile()).text(),
    ).toBe("hello\nworld");
    expect(
      await (
        await (
          (root.entriesMap.get("src") as MockDirectoryHandle).entriesMap.get(
            "a.txt",
          ) as MockFileHandle
        ).getFile()
      ).text(),
    ).toBe("alpha\nbeta\ngamma");

    const copiedReadme = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "archive/README.md",
    })) as { content: string };
    const copiedNestedFile = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "archive/src/a.txt",
    })) as { content: string };
    expect(copiedReadme.content).toBe("hello\nworld");
    expect(copiedNestedFile.content).toBe("alpha\nbeta\ngamma");
  });

  it("copies trailing-space and literal-backslash filenames without aliasing similar entries", async () => {
    const root = makeRoot();
    root.file("draft.txt ", "trailing-space source");
    root.file("draft.txt", "plain source");
    root.file("draft\\v1.txt", "backslash source");
    root.file("draftv1.txt", "compact source");
    const archive = root.dir("archive");
    archive.file("draft.txt", "plain destination sentinel");
    archive.file("draftv1.txt", "compact destination sentinel");
    mockPicker(root);
    const mount = await mountUserSpace();

    const copied = (await executeUserSpaceOperation("copy_entries", {
      mountId: mount.mountId,
      paths: ["draft.txt ", "draft\\v1.txt"],
      targetDirPath: "archive",
    })) as { moves: Array<{ sourcePath: string; path: string; kind: string }> };

    expect(copied.moves).toEqual([
      { sourcePath: "draft.txt ", path: "archive/draft.txt ", kind: "file" },
      { sourcePath: "draft\\v1.txt", path: "archive/draft\\v1.txt", kind: "file" },
    ]);
    expect(
      await (await (archive.entriesMap.get("draft.txt ") as MockFileHandle).getFile()).text(),
    ).toBe("trailing-space source");
    expect(
      await (await (archive.entriesMap.get("draft\\v1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("backslash source");
    expect(
      await (await (archive.entriesMap.get("draft.txt") as MockFileHandle).getFile()).text(),
    ).toBe("plain destination sentinel");
    expect(
      await (await (archive.entriesMap.get("draftv1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("compact destination sentinel");
    expect(
      await (await (root.entriesMap.get("draft.txt ") as MockFileHandle).getFile()).text(),
    ).toBe("trailing-space source");
    expect(
      await (await (root.entriesMap.get("draft\\v1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("backslash source");
  });

  it("moves a maximal multi-selection of files and folders and reconciles the index", async () => {
    const root = makeRoot();
    root.dir("archive");
    mockPicker(root);
    const mount = await mountUserSpace();
    await syncUserSpaceMetadata(mount.mountId);

    const moved = (await executeUserSpaceOperation("move_entries", {
      mountId: mount.mountId,
      paths: ["README.md", "src", "src/a.txt"],
      targetDirPath: "archive",
    })) as {
      moves: Array<{ sourcePath: string; path: string; kind: string }>;
      changedDirs: string[];
    };

    expect(moved.moves).toEqual([
      { sourcePath: "README.md", path: "archive/README.md", kind: "file" },
      { sourcePath: "src", path: "archive/src", kind: "directory" },
    ]);
    expect(moved.changedDirs).toEqual(["", "archive"]);
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "README.md",
      }),
    ).rejects.toThrow();
    await expect(
      executeUserSpaceOperation("read_file", {
        mountId: mount.mountId,
        path: "src/a.txt",
      }),
    ).rejects.toThrow();
    const movedFile = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "archive/src/a.txt",
    })) as { content: string };
    expect(movedFile.content).toBe("alpha\nbeta\ngamma");

    const indexed = (await executeUserSpaceOperation("search_paths", {
      mountId: mount.mountId,
      query: "a.txt",
      includeHidden: true,
    })) as { entries: Array<{ path: string }> };
    expect(indexed.entries.map((entry) => entry.path)).toEqual(["archive/src/a.txt"]);
  });

  it("moves trailing-space and literal-backslash filenames without touching similar entries", async () => {
    const root = makeRoot();
    root.file("draft.txt ", "trailing-space source");
    root.file("draft.txt", "plain source sentinel");
    root.file("draft\\v1.txt", "backslash source");
    root.file("draftv1.txt", "compact source sentinel");
    const archive = root.dir("archive");
    archive.file("draft.txt", "plain destination sentinel");
    archive.file("draftv1.txt", "compact destination sentinel");
    mockPicker(root);
    const mount = await mountUserSpace();

    const moved = (await executeUserSpaceOperation("move_entries", {
      mountId: mount.mountId,
      paths: ["draft.txt ", "draft\\v1.txt"],
      targetDirPath: "archive",
    })) as { moves: Array<{ sourcePath: string; path: string; kind: string }> };

    expect(moved.moves).toEqual([
      { sourcePath: "draft.txt ", path: "archive/draft.txt ", kind: "file" },
      { sourcePath: "draft\\v1.txt", path: "archive/draft\\v1.txt", kind: "file" },
    ]);
    expect(root.entriesMap.has("draft.txt ")).toBe(false);
    expect(root.entriesMap.has("draft\\v1.txt")).toBe(false);
    expect(
      await (await (root.entriesMap.get("draft.txt") as MockFileHandle).getFile()).text(),
    ).toBe("plain source sentinel");
    expect(
      await (await (root.entriesMap.get("draftv1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("compact source sentinel");
    expect(
      await (await (archive.entriesMap.get("draft.txt ") as MockFileHandle).getFile()).text(),
    ).toBe("trailing-space source");
    expect(
      await (await (archive.entriesMap.get("draft\\v1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("backslash source");
    expect(
      await (await (archive.entriesMap.get("draft.txt") as MockFileHandle).getFile()).text(),
    ).toBe("plain destination sentinel");
    expect(
      await (await (archive.entriesMap.get("draftv1.txt") as MockFileHandle).getFile()).text(),
    ).toBe("compact destination sentinel");
  });

  it("preflights the whole move before changing a source or destination", async () => {
    const root = makeRoot();
    const archive = root.dir("archive");
    archive.file("README.md", "existing");
    const srcChild = root.entriesMap.get("src") as MockDirectoryHandle;
    srcChild.dir("nested");
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: [],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("没有可移动");

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["README.md", "src"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("已存在");
    expect(await (await root.getFileHandle("README.md")).getFile()).toBeDefined();
    expect(await root.getDirectoryHandle("src")).toBe(srcChild);
    await expect(archive.getDirectoryHandle("src")).rejects.toMatchObject({
      name: "NotFoundError",
    });

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["src"],
        targetDirPath: "src",
      }),
    ).rejects.toThrow("它自己");
    expect(await root.getDirectoryHandle("src")).toBe(srcChild);

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["src"],
        targetDirPath: "src/nested",
      }),
    ).rejects.toThrow("子目录");
    expect(await root.getDirectoryHandle("src")).toBe(srcChild);

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["README.md"],
        targetDirPath: "",
      }),
    ).rejects.toThrow("已经位于目标文件夹");
    expect(await (await root.getFileHandle("README.md")).getFile()).toBeDefined();
  });

  it("fails closed when destination enumeration cannot prove a move or copy target is absent", async () => {
    const root = makeRoot();
    const archive = root.dir("archive");
    archive.file("README.md", "existing destination");
    mockPicker(root);
    const mount = await mountUserSpace();
    archive.values = async function* () {
      await Promise.reject(new DOMException("Destination lookup blocked", "NotAllowedError"));
      yield archive;
    };

    for (const operation of ["copy_entries", "move_entries"] as const) {
      await expect(
        executeUserSpaceOperation(operation, {
          mountId: mount.mountId,
          paths: ["README.md"],
          targetDirPath: "archive",
        }),
      ).rejects.toMatchObject({ name: "NotAllowedError" });
    }

    expect(
      await (await root.getFileHandle("README.md")).getFile().then((file) => file.text()),
    ).toBe("hello\nworld");
    expect(
      await archive.getFileHandle("README.md").then((handle) => handle.getFile()),
    ).toBeDefined();
    expect(
      await (await archive.getFileHandle("README.md")).getFile().then((file) => file.text()),
    ).toBe("existing destination");
  });

  it("does not overwrite or clean up a target created between planning and creation", async () => {
    const root = makeRoot();
    root.file("copy.txt", "copy source");
    root.file("move.txt", "move source");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    archive.getFileHandle = async (name, options) => {
      if (
        options?.create &&
        (name === "copy.txt" || name === "move.txt") &&
        !archive.entriesMap.has(name)
      ) {
        archive.file(name, `external ${name}`);
      }
      return getArchiveFileHandle(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("copy_entries", {
        mountId: mount.mountId,
        paths: ["copy.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("已存在");
    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["move.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("已存在");

    expect(await root.getFileHandle("copy.txt").then((handle) => handle.getFile())).toBeDefined();
    expect(await root.getFileHandle("move.txt").then((handle) => handle.getFile())).toBeDefined();
    expect(
      await (await archive.getFileHandle("copy.txt")).getFile().then((file) => file.text()),
    ).toBe("external copy.txt");
    expect(
      await (await archive.getFileHandle("move.txt")).getFile().then((file) => file.text()),
    ).toBe("external move.txt");
  });

  it("aborts before close and preserves a target changed while copy bytes are staged", async () => {
    const root = makeRoot();
    root.file("copy.txt", "copy source");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    archive.getFileHandle = async (name, options) => {
      const handle = await getArchiveFileHandle(name, options);
      if (name !== "copy.txt" || !options?.create) return handle;
      const createWritable = handle.createWritable.bind(handle);
      handle.createWritable = async (writableOptions) => {
        const writable = await createWritable(writableOptions);
        const write = writable.write.bind(writable);
        writable.write = async (data) => {
          await write(data);
          handle.content = "external staged-race bytes";
          handle.lastModified += 1;
        };
        return writable;
      };
      return handle;
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("copy_entries", {
        mountId: mount.mountId,
        paths: ["copy.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("已存在");

    expect(
      await (await archive.getFileHandle("copy.txt")).getFile().then((file) => file.text()),
    ).toBe("external staged-race bytes");
    expect(await (await root.getFileHandle("copy.txt")).getFile().then((file) => file.text())).toBe(
      "copy source",
    );
  });

  it("cancels a folder move without deleting the source when a nested file changes during copy", async () => {
    const root = makeRoot();
    const archive = root.dir("archive");
    const sourceDirectory = root.entriesMap.get("src") as MockDirectoryHandle;
    const sourceFile = sourceDirectory.entriesMap.get("a.txt") as MockFileHandle;
    const getArchiveDirectoryHandle = archive.getDirectoryHandle.bind(archive);
    let destinationWrapped = false;
    archive.getDirectoryHandle = async (name, options) => {
      const directory = await getArchiveDirectoryHandle(name, options);
      if (name !== "src" || !options?.create || destinationWrapped) return directory;
      destinationWrapped = true;
      const getDestinationFileHandle = directory.getFileHandle.bind(directory);
      directory.getFileHandle = async (childName, childOptions) => {
        const handle = await getDestinationFileHandle(childName, childOptions);
        if (childName !== "a.txt" || !childOptions?.create) return handle;
        const createWritable = handle.createWritable.bind(handle);
        handle.createWritable = async () => {
          const writable = await createWritable();
          const write = writable.write.bind(writable);
          writable.write = async (data) => {
            await write(data);
            // Keep size and timestamp stable so the safety check must compare bytes.
            sourceFile.content = "ALPHA\nbeta\ngamma";
          };
          return writable;
        };
        return handle;
      };
      return directory;
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["src"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("复制过程中发生变化");

    expect(
      await sourceDirectory.getFileHandle("a.txt").then((handle) => handle.getFile()),
    ).toBeDefined();
    expect(await sourceFile.getFile().then((file) => file.text())).toBe("ALPHA\nbeta\ngamma");
    await expect(archive.getDirectoryHandle("src")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("preserves a distinct source replacement with the same bytes and timestamp", async () => {
    const root = makeRoot();
    const source = root.file("one.txt", "same bytes");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    let replacement: MockFileHandle | undefined;
    archive.getFileHandle = async (name, options) => {
      const handle = await getArchiveFileHandle(name, options);
      if (name !== "one.txt" || !options?.create || replacement) return handle;
      const createWritable = handle.createWritable.bind(handle);
      handle.createWritable = async (writableOptions) => {
        const writable = await createWritable(writableOptions);
        const close = writable.close.bind(writable);
        writable.close = async () => {
          await close();
          replacement = root.file("one.txt", "same bytes");
          replacement.lastModified = source.lastModified;
        };
        return writable;
      };
      return handle;
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["one.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("复制过程中发生变化");

    expect(replacement).toBeDefined();
    expect(await root.getFileHandle("one.txt")).toBe(replacement);
    expect(await replacement?.getFile().then((file) => file.text())).toBe("same bytes");
    await expect(archive.getFileHandle("one.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("rechecks directory shape after comparison and catches a child added mid-verification", async () => {
    const root = makeRoot();
    const archive = root.dir("archive");
    const sourceDirectory = root.entriesMap.get("src") as MockDirectoryHandle;
    const sourceFile = sourceDirectory.entriesMap.get("a.txt") as MockFileHandle;
    mockPicker(root);
    const mount = await mountUserSpace();
    const getSourceFile = sourceFile.getFile.bind(sourceFile);
    let sourceReads = 0;
    sourceFile.getFile = async () => {
      sourceReads++;
      if (sourceReads === 2) sourceDirectory.file("late.txt", "added during verification");
      return getSourceFile();
    };

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["src"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("复制过程中发生变化");

    expect(await sourceDirectory.getFileHandle("late.txt")).toBeDefined();
    await expect(archive.getDirectoryHandle("src")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("never recursively deletes an early source path recreated while later siblings are verified", async () => {
    const root = makeRoot();
    const sourceDirectory = root.dir("bundle");
    sourceDirectory.file("a.txt", "original a");
    const laterFile = sourceDirectory.file("z.txt", "original z");
    const archive = root.dir("archive");
    const getLaterFile = laterFile.getFile.bind(laterFile);
    let laterReads = 0;
    laterFile.getFile = async () => {
      laterReads++;
      if (laterReads === 2) sourceDirectory.file("a.txt", "external replacement");
      return getLaterFile();
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["bundle"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("手动清理");

    expect(
      await sourceDirectory
        .getFileHandle("a.txt")
        .then((handle) => handle.getFile())
        .then((file) => file.text()),
    ).toBe("external replacement");
    const retainedTarget = await archive.getDirectoryHandle("bundle");
    expect(
      await retainedTarget
        .getFileHandle("a.txt")
        .then((handle) => handle.getFile())
        .then((file) => file.text()),
    ).toBe("original a");
    expect(
      await retainedTarget
        .getFileHandle("z.txt")
        .then((handle) => handle.getFile())
        .then((file) => file.text()),
    ).toBe("original z");
  });

  it("preserves a source changed after verification when deletion reports failure", async () => {
    const root = makeRoot();
    const source = root.file("one.txt", "original");
    const archive = root.dir("archive");
    const removeRootEntry = root.removeEntry.bind(root);
    root.removeEntry = async (name, options) => {
      if (name === "one.txt") {
        // Same-size, same-timestamp external data must never be overwritten by rollback.
        source.content = "EXTERNAL";
        throw new Error("delete exploded after external edit");
      }
      await removeRootEntry(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["one.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("delete exploded after external edit");

    expect(await source.getFile().then((file) => file.text())).toBe("EXTERNAL");
    expect(
      await (await archive.getFileHandle("one.txt")).getFile().then((file) => file.text()),
    ).toBe("original");
  });

  it("preserves a completed target changed externally before batch cleanup", async () => {
    const root = makeRoot();
    root.file("one.txt", "one");
    root.file("two.txt", "two");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    archive.getFileHandle = async (name, options) => {
      if (name === "two.txt" && options?.create) {
        const completedTarget = archive.entriesMap.get("one.txt") as MockFileHandle;
        // Keep size and timestamp stable so cleanup must validate bytes.
        completedTarget.content = "EXT";
        throw new Error("second copy exploded");
      }
      return getArchiveFileHandle(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("copy_entries", {
        mountId: mount.mountId,
        paths: ["one.txt", "two.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("second copy exploded");

    expect(
      await (await archive.getFileHandle("one.txt")).getFile().then((file) => file.text()),
    ).toBe("EXT");
    expect(await root.getFileHandle("one.txt")).toBeDefined();
    expect(await root.getFileHandle("two.txt")).toBeDefined();
  });

  it("preserves a distinct target replacement with the same bytes and timestamp", async () => {
    const root = makeRoot();
    root.file("one.txt", "one");
    root.file("two.txt", "two");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    let replacement: MockFileHandle | undefined;
    archive.getFileHandle = async (name, options) => {
      if (name === "two.txt" && options?.create) {
        const completedTarget = archive.entriesMap.get("one.txt") as MockFileHandle;
        replacement = archive.file("one.txt", "one");
        replacement.lastModified = completedTarget.lastModified;
        throw new Error("second copy exploded");
      }
      return getArchiveFileHandle(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("copy_entries", {
        mountId: mount.mountId,
        paths: ["one.txt", "two.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("second copy exploded");

    expect(replacement).toBeDefined();
    expect(await archive.getFileHandle("one.txt")).toBe(replacement);
    expect(await replacement?.getFile().then((file) => file.text())).toBe("one");
    expect(await root.getFileHandle("one.txt")).toBeDefined();
    expect(await root.getFileHandle("two.txt")).toBeDefined();
  });

  it("rejects colliding multi-move basenames before creating either target", async () => {
    const root = makeRoot();
    root.dir("left").file("same.txt", "left");
    root.dir("right").file("same.txt", "right");
    const archive = root.dir("archive");
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["left/same.txt", "right/same.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("已存在");
    expect(await (await root.getDirectoryHandle("left")).getFileHandle("same.txt")).toBeDefined();
    expect(await (await root.getDirectoryHandle("right")).getFileHandle("same.txt")).toBeDefined();
    await expect(archive.getFileHandle("same.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("keeps every source and cleans copied targets when a batch copy fails", async () => {
    const root = makeRoot();
    root.file("one.txt", "one");
    root.file("two.txt", "two");
    const archive = root.dir("archive");
    const getArchiveFileHandle = archive.getFileHandle.bind(archive);
    archive.getFileHandle = async (name, options) => {
      if (name === "two.txt" && options?.create) throw new Error("copy exploded");
      return getArchiveFileHandle(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["one.txt", "two.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("copy exploded");
    expect(await (await root.getFileHandle("one.txt")).getFile()).toBeDefined();
    expect(await (await root.getFileHandle("two.txt")).getFile()).toBeDefined();
    await expect(archive.getFileHandle("one.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(archive.getFileHandle("two.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("cleans a partially copied directory when a nested entry fails", async () => {
    const root = makeRoot();
    const bundle = root.dir("bundle");
    bundle.file("one.txt", "one");
    bundle.file("two.txt", "two");
    const archive = root.dir("archive");
    const getArchiveDirectoryHandle = archive.getDirectoryHandle.bind(archive);
    archive.getDirectoryHandle = async (name, options) => {
      const directory = await getArchiveDirectoryHandle(name, options);
      if (name !== "bundle" || !options?.create) return directory;
      const getTargetFileHandle = directory.getFileHandle.bind(directory);
      directory.getFileHandle = async (childName, childOptions) => {
        if (childName === "two.txt" && childOptions?.create) {
          throw new Error("nested copy exploded");
        }
        return getTargetFileHandle(childName, childOptions);
      };
      return directory;
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("copy_entries", {
        mountId: mount.mountId,
        paths: ["bundle"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("nested copy exploded");

    expect(await bundle.getFileHandle("one.txt")).toBeDefined();
    expect(await bundle.getFileHandle("two.txt")).toBeDefined();
    await expect(archive.getDirectoryHandle("bundle")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("restores deleted sources and removes every destination when move deletion fails", async () => {
    const root = makeRoot();
    root.file("one.txt", "one");
    root.file("two.txt", "two");
    const archive = root.dir("archive");
    const removeRootEntry = root.removeEntry.bind(root);
    const deletionAttempts: string[] = [];
    root.removeEntry = async (name, options) => {
      deletionAttempts.push(name);
      if (name === "two.txt") throw new Error("delete exploded");
      await removeRootEntry(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    await expect(
      executeUserSpaceOperation("move_entries", {
        mountId: mount.mountId,
        paths: ["one.txt", "two.txt"],
        targetDirPath: "archive",
      }),
    ).rejects.toThrow("delete exploded");

    expect(deletionAttempts).toEqual(["one.txt", "two.txt"]);
    expect(await (await root.getFileHandle("one.txt")).getFile().then((file) => file.text())).toBe(
      "one",
    );
    expect(await (await root.getFileHandle("two.txt")).getFile().then((file) => file.text())).toBe(
      "two",
    );
    await expect(archive.getFileHandle("one.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(archive.getFileHandle("two.txt")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("queues replace_text behind a blocked move so an edit cannot be silently lost", async () => {
    const root = makeRoot();
    const archive = root.dir("archive");
    const source = root.entriesMap.get("README.md") as MockFileHandle;
    const getSourceFile = source.getFile.bind(source);
    const deletionStarted = deferred<void>();
    const resumeDeletion = deferred<void>();
    let deletionBlocked = false;
    let editReadObserved = false;
    source.getFile = async () => {
      if (deletionBlocked) editReadObserved = true;
      return getSourceFile();
    };
    const removeRootEntry = root.removeEntry.bind(root);
    root.removeEntry = async (name, options) => {
      if (name === "README.md") {
        deletionBlocked = true;
        deletionStarted.resolve();
        await resumeDeletion.promise;
      }
      await removeRootEntry(name, options);
    };
    mockPicker(root);
    const mount = await mountUserSpace();

    const pendingMove = executeUserSpaceOperation("move_entries", {
      mountId: mount.mountId,
      paths: ["README.md"],
      targetDirPath: "archive",
    });
    await deletionStarted.promise;

    const pendingEdit = executeUserSpaceOperation("replace_text", {
      mountId: mount.mountId,
      path: "README.md",
      edits: [{ oldText: "hello", newText: "edited" }],
    });
    const editFailure = expect(pendingEdit).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editReadObserved).toBe(false);

    resumeDeletion.resolve();
    await pendingMove;
    await editFailure;
    expect(
      await (await archive.getFileHandle("README.md")).getFile().then((file) => file.text()),
    ).toBe("hello\nworld");
    await expect(root.getFileHandle("README.md")).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("allows explicit create, write, rename, and delete operations on dot files", async () => {
    const mount = await mountUserSpace();
    await executeUserSpaceOperation("create_entry", {
      mountId: mount.mountId,
      parentPath: "",
      name: ".env",
      kind: "file",
      content: "TOKEN=one",
    });
    await executeUserSpaceOperation("write_file", {
      mountId: mount.mountId,
      path: ".env",
      content: "TOKEN=two",
    });
    const renamed = (await executeUserSpaceOperation("rename_entry", {
      mountId: mount.mountId,
      path: ".env",
      name: ".env.local",
    })) as { newPath: string };
    const read = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: ".env.local",
    })) as { content: string };
    const defaultList = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      limit: 20,
    })) as { entries: Array<{ name: string }> };
    const hiddenList = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      includeHidden: true,
      limit: 20,
    })) as { entries: Array<{ name: string }> };
    await executeUserSpaceOperation("delete_entry", {
      mountId: mount.mountId,
      path: ".env.local",
    });
    const afterDelete = (await executeUserSpaceOperation("list_dir", {
      mountId: mount.mountId,
      includeHidden: true,
      limit: 20,
    })) as { entries: Array<{ name: string }> };

    expect(renamed.newPath).toBe(".env.local");
    expect(read.content).toBe("TOKEN=two");
    expect(defaultList.entries.map((entry) => entry.name)).not.toContain(".env.local");
    expect(hiddenList.entries.map((entry) => entry.name)).toContain(".env.local");
    expect(afterDelete.entries.map((entry) => entry.name)).not.toContain(".env.local");
  });

  it("runs v1 shell commands over the mounted user-space", async () => {
    const root = makeRoot();
    mockPicker(root);

    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "pwd",
        "ls",
        "cat README.md | grep hello",
        "find . -type f -name '*.txt'",
        "tree -L 2",
        "file README.md",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number; cwd: string };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.cwd).toBe("/Project");
    expect(result.stdout).toContain("/Project\n");
    expect(result.stdout).toContain("README.md");
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("./src/a.txt");
    expect(result.stdout).toContain("UTF-8 text");
  });

  it("does not expose private mount identifiers through shell environment", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "printenv PIWORK_USER_SPACE_MOUNT_ID || true\nprintenv PIWORK_USER_SPACE_ROOT_NAME",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Project");
    expect(result.stdout).not.toContain(mount.mountId);
  });

  it("reports just-bash changed directories for user-space refreshes", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "printf shell-sync > shell-sync.txt",
        "mkdir -p generated/nested",
        "rm shell-sync.txt",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number; changedDirs: string[] };
    const snapshot = getUserSpaceSnapshot();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.changedDirs).toEqual(
      expect.arrayContaining(["", "generated", "generated/nested"]),
    );
    expect(snapshot.recentOperations[0]).toEqual(
      expect.objectContaining({
        mountId: mount.mountId,
        operation: "shell_exec",
        status: "ok",
        changedDirs: expect.arrayContaining(["", "generated"]),
      }),
    );
    expect(snapshot.recentFileChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mountId: mount.mountId,
          changedDirs: expect.arrayContaining([""]),
        }),
      ]),
    );
    expect(
      snapshot.recentFileChanges.some((change) => change.changedDirs.includes("generated")),
    ).toBe(true);
  });

  it("emits file change snapshots while ruok is still running", async () => {
    const mount = await mountUserSpace();
    const liveSnapshots: Array<{ hasRootChange: boolean; hasFinalShellOperation: boolean }> = [];
    const unsubscribe = subscribeUserSpace(() => {
      const snapshot = getUserSpaceSnapshot();
      liveSnapshots.push({
        hasRootChange: snapshot.recentFileChanges.some(
          (change) => change.mountId === mount.mountId && change.changedDirs.includes(""),
        ),
        hasFinalShellOperation: snapshot.recentOperations.some(
          (operation) =>
            operation.mountId === mount.mountId && operation.operation === "shell_exec",
        ),
      });
    });

    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "ruok",
    })) as { stdout: string; stderr: string; exitCode: number };
    unsubscribe();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      liveSnapshots.some((snapshot) => snapshot.hasRootChange && !snapshot.hasFinalShellOperation),
    ).toBe(true);
  });

  it("exposes only the virtual root and the active browser user-space under its current name", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      cwd: "/",
      script: [
        "pwd",
        "printf 'root=' && ls /",
        "printf 'home=' && printenv HOME",
        "cd / && pwd && ls",
        "cd /Project && pwd",
        "cd /Project/src && pwd",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number; cwd: string };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.cwd).toBe("/Project/src");
    expect(result.stdout).toMatch(/^\/\n/);
    expect(result.stdout).toContain("/Project\n");
    expect(result.stdout).toContain("root=Project\n");
    expect(result.stdout).toContain("home=/\n");
    expect(result.stdout).toContain("/Project/src\n");
  });

  it("runs recursive metadata and search commands from the virtual root", async () => {
    const root = new MockDirectoryHandle("日常售前技术支持");
    root.file("README.md", "virtual-root-needle\n");
    root.dir("src").file("a.txt", "alpha\n");
    mockPicker(root);
    const mount = await mountUserSpace();

    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      cwd: "/",
      script: [
        "tree /",
        "find / -type f -name '*.txt'",
        "glob '*.txt' /",
        "grep -r virtual-root-needle /",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("日常售前技术支持/");
    expect(result.stdout).toContain("/日常售前技术支持/src/a.txt");
    expect(result.stdout).toContain("src/a.txt");
    expect(result.stdout).toContain("README.md:virtual-root-needle");
  });

  it("allows metadata-recursive find and file-tree-backed recursive content search", async () => {
    const root = makeRoot();
    root.file("notes.md", "# Notes\n\nmarkdownBeta\n", "text/markdown");
    mockPicker(root);
    const mount = await mountUserSpace();

    const find = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "find . -type f -name '*.md'",
    })) as { stdout: string; stderr: string; exitCode: number };
    const search = (await executeUserSpaceOperation("search", {
      mountId: mount.mountId,
      query: "markdownBeta",
    })) as { matches: Array<{ path: string; line: number; text: string }> };
    const grepRecursive = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "grep -rn markdownBeta .",
    })) as { stdout: string; stderr: string; exitCode: number };
    const rg = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "rg markdownBeta",
    })) as { stdout: string; stderr: string; exitCode: number };
    const xargs = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "printf 'README.md\\n' | xargs cat",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(find.exitCode).toBe(0);
    expect(find.stdout).toContain("./notes.md");
    expect(search.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "notes.md", lineNumber: 3, line: "markdownBeta" }),
      ]),
    );
    expect(grepRecursive.exitCode).toBe(0);
    expect(grepRecursive.stderr).toBe("");
    expect(grepRecursive.stdout).toContain("notes.md:3:markdownBeta");
    expect(rg.exitCode).not.toBe(0);
    expect(xargs.exitCode).not.toBe(0);
  });

  it("supports upstream just-bash clear in the user-space shell", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "clear",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("\u001b[2J\u001b[H");
  });

  it("keeps the committed ruok fixture directory aligned with the bundled setup manifest", () => {
    const fixtureRoot = resolve(userSpaceTestDir, "fixtures/user-space-ruok");

    expect(RUOK_FIXTURE_SOURCE_ROOT).toBe("web/src/fixtures/user-space-ruok");
    expect(RUOK_FIXTURE_DIRECTORIES).toEqual(["matrix", "src"]);
    for (const file of RUOK_FIXTURE_FILES) {
      expect(readFileSync(resolve(fixtureRoot, file.path), "utf8"), file.path).toBe(file.content);
    }

    const setupScript = createRuokSetupScript("piwork-ruok-fixture-test");
    expect(setupScript).not.toContain("rm -rf");
    expect(setupScript).toContain("mkdir -p piwork-ruok-fixture-test/matrix");
    expect(setupScript).toContain("mkdir -p piwork-ruok-fixture-test/src");
    expect(setupScript).toContain(
      "printf 'alpha\\nbeta\\ngamma\\n' > piwork-ruok-fixture-test/matrix/text.txt",
    );
    expect(setupScript).toContain(
      "printf '# Ruok Notes\\n\\ngrep-markdown-ok\\n' > piwork-ruok-fixture-test/matrix/notes.md",
    );
  });

  it("runs the just-bash browser command matrix over user-space", async () => {
    const mount = await mountUserSpace();
    const covered = new Set(USER_SPACE_SHELL_COMMAND_MATRIX.map((item) => item.command));
    expect(covered).toEqual(
      new Set(getCommandNames().filter((command) => !["rg", "xargs"].includes(command))),
    );
    expect(new Set(USER_SPACE_BASH_COMMANDS)).toEqual(covered);
    expect(USER_SPACE_BASH_PUBLIC_COMMANDS).toEqual([
      ...USER_SPACE_BASH_COMMANDS,
      "glob",
      "checkout",
      "checkin",
      "ruok",
    ]);
    expect(covered.has("rg")).toBe(false);
    expect(covered.has("xargs")).toBe(false);

    const setup = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "mkdir -p matrix",
        "printf 'alpha\\nbeta\\ngamma\\n' > matrix/text.txt",
        "printf 'alpha\\nbeta\\ngamma\\n' > matrix/text-copy.txt",
        "printf 'alpha\\nbeta\\ndelta\\n' > matrix/other.txt",
        "printf 'a\\nb\\n' > matrix/comm-a.txt",
        "printf 'b\\nc\\n' > matrix/comm-b.txt",
        "printf '1 one\\n2 two\\n' > matrix/join-a.txt",
        "printf '1 uno\\n2 dos\\n' > matrix/join-b.txt",
        "printf '# Ruok Notes\\n\\ngrep-markdown-ok\\n' > matrix/notes.md",
        'printf \'{"name":"nexo","items":[1,2]}\\n\' > matrix/data.json',
        "printf '<h1>Hi</h1>\\n<p>There</p>\\n' > matrix/page.html",
        "printf 'name,score\\nana,7\\nbob,9\\n' > matrix/data.csv",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number };
    expect(setup.exitCode).toBe(0);
    expect(setup.stderr).toBe("");

    for (const item of USER_SPACE_SHELL_COMMAND_MATRIX) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script: item.script,
      })) as { stdout: string; stderr: string; exitCode: number };
      expect(result.exitCode, `${item.command} failed with stderr: ${result.stderr}`).toBe(0);
      if (item.stdout !== undefined) {
        expect(result.stdout, `${item.command} stdout mismatch`).toContain(item.stdout);
      }
    }
  });

  it("publishes an explicit just-bash capability boundary", () => {
    const capabilities = formatUserSpaceBashCapabilities();

    expect(capabilities).toContain("not a host/container shell");
    expect(capabilities).toContain("Registered commands (81)");
    expect(capabilities).toContain("echo cat printf");
    expect(capabilities).toContain("zcat glob checkout checkin ruok");
    expect(capabilities).toContain("Recursive content search uses the file-tree index");
    expect(capabilities).toContain("intended mainly for binary files");
    expect(capabilities).toContain("sed -i, awk system()");
    expect(capabilities).toContain("500 commands, 1000 loop iterations");
    expect(USER_SPACE_BASH_PUBLIC_COMMANDS).not.toContain("curl");
    expect(USER_SPACE_BASH_PUBLIC_COMMANDS).not.toContain("python");
  });

  it("runs recursive grep inside bash through the file-tree content index", async () => {
    const root = makeRoot();
    root.file("root.txt", "needle root");
    root.dir("nested").file("child.txt", "before\nneedle child\nafter");
    mockPicker(root);
    const mount = await mountUserSpace();

    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "grep -Rni needle .",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("root.txt:1:needle root");
    expect(result.stdout).toContain("nested/child.txt:2:needle child");
  });

  it("exposes binary checkout and checkin only as bounded bash commands", async () => {
    const mount = await mountUserSpace();
    const nativeFetch = globalThis.fetch;
    const requests: Array<{ url: string; path: string; targetPath?: string }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = JSON.parse(String(init?.body || "{}")) as {
          path: string;
          targetPath?: string;
        };
        requests.push({
          url,
          path: path.path,
          ...(path.targetPath ? { targetPath: path.targetPath } : {}),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            files: [
              {
                source: url.endsWith("user-to-agent")
                  ? `user-space:/${path.path}`
                  : `workspace/${path.path}`,
                target: url.endsWith("user-to-agent")
                  ? "workspace/shared/a.bin"
                  : `user-space:/${path.targetPath || "shared/a.bin"}`,
                status: "ok",
                size: 3,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        __sessionId: "session-1",
        script:
          "checkout Project/src/a.txt && checkout ./src/a.txt && checkin shared/a.bin Project/src/a.txt",
      })) as { stdout: string; stderr: string; exitCode: number };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("user-space:/src/a.txt -> workspace/shared/a.bin");
      expect(result.stdout).toContain("Agent Space path: shared/a.bin");
      expect(result.stdout).toContain("do not use this path inside user-space bash");
      expect(result.stdout).toContain("workspace/shared/a.bin -> user-space:/src/a.txt");
      expect(requests).toEqual([
        { url: "/api/sessions/session-1/transfer/user-to-agent", path: "src/a.txt" },
        { url: "/api/sessions/session-1/transfer/user-to-agent", path: "src/a.txt" },
        {
          url: "/api/sessions/session-1/transfer/agent-to-user",
          path: "shared/a.bin",
          targetPath: "src/a.txt",
        },
      ]);
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }
  });

  it("preserves a non-JSON transfer error instead of reducing it to the HTTP status", async () => {
    const mount = await mountUserSpace();
    const nativeFetch = globalThis.fetch;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () =>
        new Response("User Space file was not found", { status: 400, statusText: "Bad Request" }),
    });

    try {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        __sessionId: "session-1",
        script: "checkout Project/missing.docx",
      })) as { stdout: string; stderr: string; exitCode: number };

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("checkout: User Space file was not found");
      expect(result.stderr).not.toContain("400 Bad Request");
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }
  });

  it("supports browser gzip, gunzip, and zcat byte streams over user-space files", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "printf 'browser-gzip\\n' > gzip-source.txt",
        "gzip -c gzip-source.txt > gzip-source.txt.gz",
        "gzip -t gzip-source.txt.gz",
        "gzip -l gzip-source.txt.gz",
        "printf 'gunzip-c='",
        "gunzip -c gzip-source.txt.gz",
        "printf 'zcat='",
        "zcat gzip-source.txt.gz",
        "printf 'inplace-ok\\n' > inplace.txt",
        "gzip inplace.txt",
        "test ! -e inplace.txt",
        "gunzip inplace.txt.gz",
        "cat inplace.txt",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("gzip-source.txt");
    expect(result.stdout).toContain("gunzip-c=browser-gzip");
    expect(result.stdout).toContain("zcat=browser-gzip");
    expect(result.stdout).toContain("inplace-ok");
  });

  it("supports the documented long and short options for bounded shell commands", async () => {
    const mount = await mountUserSpace();
    const setup = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "printf 'hello\\nworld\\n' > option-lines.txt",
        "mkdir -p option-dir/nested",
        "printf 'Needle\\nother\\n' > option-dir/nested/match.TXT",
      ].join("\n"),
    })) as { stderr: string; exitCode: number };
    expect(setup.exitCode).toBe(0);
    expect(setup.stderr).toBe("");

    const cases: Array<{ script: string; stdout: string }> = [
      {
        script:
          "ls --all --almost-all --directory --classify --human-readable --recursive --reverse .",
        stdout: ".",
      },
      { script: "ls -aAdFhlrRSt1 .", stdout: "." },
      { script: "head --lines 1 option-lines.txt", stdout: "hello" },
      { script: "head -n1 option-lines.txt", stdout: "hello" },
      { script: "tail -1 option-lines.txt", stdout: "world" },
      { script: "head -- option-lines.txt", stdout: "hello" },
      {
        script:
          "grep --ignore-case --fixed-strings --line-number --no-filename -e HELLO option-lines.txt",
        stdout: "1:hello",
      },
      {
        script: "grep --invert-match --count --no-filename world option-lines.txt",
        stdout: "2",
      },
      {
        script: "grep --files-with-matches hello option-lines.txt",
        stdout: "option-lines.txt",
      },
      { script: "grep --quiet hello option-lines.txt && echo quiet-ok", stdout: "quiet-ok" },
      { script: "grep -iFvnh other option-dir/nested/match.TXT", stdout: "1:Needle" },
      {
        script:
          "find . -maxdepth 3 -mindepth 1 -type f -iname '*.txt' -ipath './option-dir/*' -print",
        stdout: "./option-dir/nested/match.TXT",
      },
      {
        script: "find . -maxdepth 1 -type d -name 'option-dir' -path './option-*'",
        stdout: "./option-dir",
      },
      { script: "tree -L2 -d -a -f option-dir", stdout: "nested/" },
    ];

    for (const item of cases) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script: item.script,
      })) as { stdout: string; stderr: string; exitCode: number };
      expect(result.exitCode, `${item.script}: ${result.stderr}`).toBe(0);
      expect(result.stdout, item.script).toContain(item.stdout);
    }
  });

  it("returns stable errors for unsupported shell options and unsafe find actions", async () => {
    const mount = await mountUserSpace();
    const cases: Array<{ script: string; stderr: string }> = [
      { script: "glob", stderr: "usage: glob" },
      {
        script: "glob '*.txt' --files-only --directories-only",
        stderr: "usage: glob",
      },
      { script: "glob '*.txt' --limit 0", stderr: "--limit requires a positive integer" },
      { script: "glob '*.txt' --bogus", stderr: "unsupported option --bogus" },
      { script: "glob a b c", stderr: "usage: glob" },
      { script: "ls --unsupported", stderr: "unrecognized option" },
      { script: "ls -Z", stderr: "invalid option" },
      { script: "ls missing", stderr: "No such file or directory" },
      { script: "head -n", stderr: "requires a line count" },
      { script: "tail -n nope", stderr: "invalid line count" },
      { script: "head -Z", stderr: "unsupported option" },
      { script: "grep", stderr: "missing pattern" },
      { script: "grep --unsupported pattern", stderr: "unsupported option" },
      { script: "grep -Z pattern", stderr: "unsupported option" },
      { script: "find . -maxdepth -1", stderr: "requires a non-negative number" },
      { script: "find . -mindepth nope", stderr: "requires a non-negative number" },
      { script: "find . -type x", stderr: "supports only -type f and -type d" },
      { script: "find . -delete", stderr: "is not available in user-space v1" },
      { script: "find . -unknown", stderr: "unsupported option" },
      { script: "tree -L -1", stderr: "requires a non-negative depth" },
      { script: "tree -Lnope", stderr: "requires a non-negative depth" },
      { script: "tree -Z", stderr: "unsupported option" },
      { script: "file", stderr: "missing operand" },
      { script: "file missing", stderr: "No such file or directory" },
      { script: "which", stderr: "missing command name" },
    ];

    for (const item of cases) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script: item.script,
      })) as { stderr: string; exitCode: number };
      expect(result.exitCode, item.script).not.toBe(0);
      expect(result.stderr, item.script).toContain(item.stderr);
    }
  });

  it("honors gzip compatibility aliases, recursion, overwrite protection, and help", async () => {
    const mount = await mountUserSpace();
    const setup = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "mkdir -p gzip-options/nested",
        "printf 'one\\n' > gzip-options/one.txt",
        "printf 'two\\n' > gzip-options/nested/two.txt",
        "printf 'existing\\n' > overwrite.txt",
        "printf 'occupied\\n' > overwrite.txt.gz",
        "printf 'plain\\n' > plain.txt",
        "printf 'suffix\\n' > already.gz",
      ].join("\n"),
    })) as { stderr: string; exitCode: number };
    expect(setup.exitCode).toBe(0);
    expect(setup.stderr).toBe("");

    const helpCases = [
      ["gzip --help", "gzip [OPTION]"],
      ["gunzip --help", "gunzip [OPTION]"],
      ["zcat --help", "zcat [OPTION]"],
    ] as const;
    for (const [script, stdout] of helpCases) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script,
      })) as { stdout: string; stderr: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(stdout);
    }

    const parserCases = [
      "gzip --stdout --force --keep --name --no-name --quiet --recursive --suffix=.zz --verbose --fast --best missing",
      "gzip --decompress --list --test --suffix .zz missing",
      "gzip -cdfklnNqrtv123456789 missing",
      "gzip -S.zz missing",
      "gzip -- --fast",
    ];
    for (const script of parserCases) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script,
      })) as { exitCode: number };
      expect(result.exitCode, script).not.toBe(0);
    }

    const rejected = [
      ["gzip --suffix", "requires an argument"],
      ["gzip -S", "requires an argument"],
      ["gzip --wat", "unrecognized option"],
      ["gzip -Z", "invalid option"],
    ] as const;
    for (const [script, stderr] of rejected) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script,
      })) as { stderr: string; exitCode: number };
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(stderr);
    }

    const directory = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gzip gzip-options",
    })) as { stderr: string; exitCode: number };
    expect(directory.exitCode).toBe(1);
    expect(directory.stderr).toContain("is a directory");

    const recursive = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gzip -rv gzip-options",
    })) as { stderr: string; exitCode: number };
    expect(recursive.exitCode).toBe(0);
    expect(recursive.stderr).toContain("replaced with");

    const protectedOutput = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gzip overwrite.txt",
    })) as { stderr: string; exitCode: number };
    expect(protectedOutput.exitCode).toBe(1);
    expect(protectedOutput.stderr).toContain("already exists; not overwritten");

    const forced = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gzip -fv overwrite.txt",
    })) as { stderr: string; exitCode: number };
    expect(forced.exitCode).toBe(0);
    expect(forced.stderr).toContain("replaced with");

    const suffix = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gzip already.gz",
    })) as { stderr: string; exitCode: number };
    expect(suffix.exitCode).toBe(1);
    expect(suffix.stderr).toContain("already has .gz suffix");

    const plain = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "gunzip -S.txt plain.txt",
    })) as { stderr: string; exitCode: number };
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain("not in gzip format");
  });

  it("matches upstream just-bash shell-like syntax over user-space", async () => {
    const mount = await mountUserSpace();
    const scripts = [
      {
        name: "pipeline",
        script: "printf 'c\\nb\\na\\n' | sort | head -n 1",
        stdout: "a",
      },
      {
        name: "redirection and append",
        script:
          "printf 'one\\n' > shell-like.txt\nprintf 'two\\n' >> shell-like.txt\ncat shell-like.txt",
        stdout: "one\ntwo",
      },
      {
        name: "here string",
        script: "cat <<< 'here-string-ok'",
        stdout: "here-string-ok",
      },
      {
        name: "heredoc",
        script: "cat <<'EOF'\nheredoc-ok\nEOF",
        stdout: "heredoc-ok",
      },
      {
        name: "and-or lists",
        script: "false || echo or-ok\ntrue && echo and-ok",
        stdout: "or-ok\nand-ok",
      },
      {
        name: "variables and export",
        script: 'NAME=nexo\nexport NAME\necho "$NAME"\nprintenv NAME',
        stdout: "nexo\nnexo",
      },
      {
        name: "command substitution",
        script: 'echo "sub-$(printf ok)"',
        stdout: "sub-ok",
      },
      {
        name: "glob expansion",
        script:
          "mkdir -p glob\nprintf a > glob/a.txt\nprintf b > glob/b.txt\nprintf '%s\\n' glob/*.txt | sort",
        stdout: "glob/a.txt\nglob/b.txt",
      },
      {
        name: "recursive indexed glob expansion",
        script: "mkdir -p glob/nested\nprintf c > glob/nested/c.ts\nglob '**/*.ts' --files-only",
        stdout: "glob/nested/c.ts",
      },
      {
        name: "subshell",
        script: "(cd src && pwd) && pwd",
        stdout: "/src\n/",
      },
      {
        name: "bash -c positional args",
        script: "bash -c 'echo \"$1-$2\"' -- alpha beta",
        stdout: "alpha-beta",
      },
    ];

    for (const item of scripts) {
      const result = (await executeUserSpaceOperation("shell_exec", {
        mountId: mount.mountId,
        script: item.script,
      })) as { stdout: string; stderr: string; exitCode: number };
      expect(result.exitCode, `${item.name} failed with stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout, `${item.name} stdout mismatch`).toContain(item.stdout);
    }
  });

  it("runs the ruok self-test command inside the user-space shell", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "ruok",
      cwd: "/Project/src",
      timeoutMs: 30000,
    })) as { stdout: string; stderr: string; exitCode: number; cwd: string };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const commandCount = RUOK_COMMAND_MATRIX.length;
    expect(result.stdout).toContain(`ruok: command ${commandCount}/${commandCount} passed`);
    expect(result.stdout).toContain("ruok: shell-like 10/10 passed");
    expect(result.stdout).toContain(`ruok: [command 1/${commandCount}] echo PASS`);
    expect(result.stdout).toContain(`ruok: [command ${commandCount}/${commandCount}] rm PASS`);
    expect(result.stdout).toContain("ruok: preparing /Project/src/piwork-ruok-");
    expect(result.stdout).toContain('input: "echo echo-ok"');
    expect(result.stdout).toContain('stdout: "echo-ok\\n"');
    expect(result.stdout).toContain("ruok: stats");
    expect(result.stdout).toContain(`total: ${commandCount + 10}`);
    expect(result.stdout).toContain("failed: 0");
    expect(result.stdout).toContain("ruok: test dir removed");
    expect(result.stdout).toContain("ruok: ok");
    expect(result.stdout).not.toContain("test dir kept");
    expect(result.cwd).toBe("/Project/src");

    const prepared = result.stdout.match(/ruok: preparing \/Project\/src\/([^\n]+)/)?.[1];
    expect(prepared).toBeTruthy();
    const cleanupCheck = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: `test ! -e src/${prepared}`,
    })) as { stderr: string; exitCode: number };
    expect(cleanupCheck.exitCode).toBe(0);
    expect(cleanupCheck.stderr).toBe("");
  });

  it("keeps tree visibility configurable while find always searches hidden entries", async () => {
    const root = new MockDirectoryHandle("Cli Project");
    const visible = root.dir("visible");
    const level1 = visible.dir("level1");
    const level2 = level1.dir("level2");
    const level3 = level2.dir("level3");
    level3.file("leaf.txt", "deep");
    const hidden = root.dir(".config");
    hidden.file("settings.json", '{"hiddenShellNeedle":true}');
    mockPicker(root);

    const mount = await mountUserSpace();
    const hiddenDefault = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "tree",
    })) as { stdout: string; stderr: string; exitCode: number };
    const hiddenSearchDefault = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: ["find . -type f -name '*.json'", "find . -type f -name 'leaf.txt'"].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number };
    const hiddenIncluded = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      showHiddenEntries: true,
      script: "tree",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(hiddenDefault.exitCode).toBe(0);
    expect(hiddenDefault.stderr).toBe("");
    expect(hiddenDefault.stdout).toContain("leaf.txt");
    expect(hiddenDefault.stdout).not.toContain(".config");
    expect(hiddenDefault.stdout).not.toContain("settings.json");
    expect(hiddenSearchDefault.exitCode).toBe(0);
    expect(hiddenSearchDefault.stdout).toContain("./.config/settings.json");
    expect(hiddenSearchDefault.stdout).toContain("./visible/level1/level2/level3/leaf.txt");
    expect(hiddenIncluded.exitCode).toBe(0);
    expect(hiddenIncluded.stdout).toContain(".config");
    expect(hiddenIncluded.stdout).toContain("settings.json");
  });

  it("keeps shell writes visible inside the same script without a full synchronous rebuild", async () => {
    const mount = await mountUserSpace();
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: [
        "mkdir notes",
        "printf hi > notes/a.txt",
        "ls notes",
        "mv notes/a.txt notes/b.txt",
        "cp notes/b.txt notes/c.txt",
        "rm notes/b.txt",
        "find notes -type f",
      ].join("\n"),
    })) as { stdout: string; stderr: string; exitCode: number };
    const read = (await executeUserSpaceOperation("read_file", {
      mountId: mount.mountId,
      path: "notes/c.txt",
    })) as { content: string };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("a.txt");
    expect(result.stdout).toContain("notes/c.txt");
    expect(result.stdout).not.toContain("notes/b.txt");
    expect(read.content).toBe("hi");
  });

  it("rejects shell write commands on readonly mounts", async () => {
    const mount = await mountUserSpace("readonly");
    const result = (await executeUserSpaceOperation("shell_exec", {
      mountId: mount.mountId,
      script: "touch nope.txt",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("只读");
  });

  it("reflects readonly user-space access in shell permission bits", async () => {
    const readonlyMount = await mountUserSpace("readonly");
    const readonlyResult = (await executeUserSpaceOperation("shell_exec", {
      mountId: readonlyMount.mountId,
      script: "ls -ld . README.md",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(readonlyResult.exitCode).toBe(0);
    expect(readonlyResult.stderr).toBe("");
    expect(readonlyResult.stdout).toContain("dr-xr-xr-x");
    expect(readonlyResult.stdout).toContain("-r--r--r--");

    const readwriteMount = await updateUserSpaceAccess(readonlyMount.mountId, "readwrite");
    const readwriteResult = (await executeUserSpaceOperation("shell_exec", {
      mountId: readwriteMount.mountId,
      script: "ls -ld . README.md",
    })) as { stdout: string; stderr: string; exitCode: number };

    expect(readwriteResult.exitCode).toBe(0);
    expect(readwriteResult.stderr).toBe("");
    expect(readwriteResult.stdout).toContain("drwxr-xr-x");
    expect(readwriteResult.stdout).toContain("-rw-r--r--");
  });

  it("handles browser-side blob checkout and checkin with binary fetch bodies", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([4, 5, 6]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => "legacy-token-that-must-not-be-used" },
    });
    const baseHash = await sha256Hex(originalBytes);
    const nextHash = await sha256Hex(nextBytes);
    const nativeFetch = globalThis.fetch;
    const uploads: Uint8Array[] = [];
    const completions: unknown[] = [];
    const transferRequests: RequestInit[] = [];

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        transferRequests.push(init || {});
        if (url === "/upload") {
          const body = init?.body;
          if (!body) throw new Error("missing upload body");
          uploads.push(new Uint8Array(await new Response(body).arrayBuffer()));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url === "/download") {
          return new Response(nextBytes, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (url === "/commit") {
          return new Response(JSON.stringify({ commitLease: "lease-t2" }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      await expect(
        handleUserSpaceBlobCheckoutRequest({
          type: "user_space_blob_checkout_request",
          transfer_id: "t1",
          mountId: mount.mountId,
          path: "asset.bin",
          uploadUrl: "/upload",
          completeUrl: "/complete",
          maxBytes: 2,
        }),
      ).rejects.toThrow("transfer limit");

      await handleUserSpaceBlobCheckoutRequest({
        type: "user_space_blob_checkout_request",
        transfer_id: "t1-allowed",
        mountId: mount.mountId,
        path: "asset.bin",
        uploadUrl: "/upload",
        completeUrl: "/complete",
        maxBytes: originalBytes.byteLength,
      });

      await handleUserSpaceBlobCheckinRequest({
        type: "user_space_blob_checkin_request",
        transfer_id: "t2",
        mountId: mount.mountId,
        path: "asset.bin",
        baseHash,
        baseMtime: asset.lastModified,
        size: nextBytes.byteLength,
        hash: nextHash,
        downloadUrl: "/download",
        commitUrl: "/commit",
        completeUrl: "/complete",
      });
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    const updated = await asset.getFile();
    expect(uploads[0]).toEqual(originalBytes);
    expect(new Uint8Array(await updated.arrayBuffer())).toEqual(nextBytes);
    expect(transferRequests).not.toHaveLength(0);
    for (const request of transferRequests) {
      expect(request.credentials).toBe("include");
      expect(new Headers(request.headers).has("Authorization")).toBe(false);
    }
    expect(completions).toContainEqual(
      expect.objectContaining({ ok: true, size: originalBytes.byteLength }),
    );
    expect(completions).toContainEqual(
      expect.objectContaining({
        ok: true,
        size: nextBytes.byteLength,
        hash: nextHash,
        commitLease: "lease-t2",
      }),
    );
  });

  it("does not write checkin bytes when generation authorization fails after download", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([4, 5, 6]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const baseHash = await sha256Hex(originalBytes);
    const nextHash = await sha256Hex(nextBytes);
    const nativeFetch = globalThis.fetch;
    let downloadStarted = false;
    const completions: Array<Record<string, unknown>> = [];

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") {
          downloadStarted = true;
          return new Response(nextBytes, { status: 200 });
        }
        if (url === "/commit") {
          expect(downloadStarted).toBe(true);
          return new Response(JSON.stringify({ error: "runtime generation changed" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      await expect(
        handleUserSpaceBlobCheckinRequest({
          type: "user_space_blob_checkin_request",
          transfer_id: "stale-checkin",
          mountId: mount.mountId,
          path: "asset.bin",
          baseHash,
          baseMtime: asset.lastModified,
          size: nextBytes.byteLength,
          hash: nextHash,
          downloadUrl: "/download",
          commitUrl: "/commit",
          completeUrl: "/complete",
        }),
      ).rejects.toThrow("runtime generation changed");
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    const unchanged = await asset.getFile();
    expect(new Uint8Array(await unchanged.arrayBuffer())).toEqual(originalBytes);
    expect(completions).toContainEqual(
      expect.objectContaining({ ok: false, error: "runtime generation changed" }),
    );
  });

  it("finishes an authorized checkin and reports its terminal result after runtime revocation", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([7, 8, 9]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const writableRequested = deferred<void>();
    const resumeWritable = deferred<void>();
    const nativeCreateWritable = asset.createWritable.bind(asset);
    asset.createWritable = async () => {
      writableRequested.resolve();
      await resumeWritable.promise;
      return nativeCreateWritable();
    };

    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;
    let runtimeRevoked = false;
    let completionAfterRevocation = false;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") return new Response(nextBytes, { status: 200 });
        if (url === "/commit") {
          return new Response(JSON.stringify({ commitLease: "authorized-lease" }), {
            status: 200,
          });
        }
        if (url === "/complete") {
          completionAfterRevocation = runtimeRevoked;
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      const pendingCheckin = handleUserSpaceBlobCheckinRequest({
        type: "user_space_blob_checkin_request",
        transfer_id: "authorized-checkin-during-revocation",
        mountId: mount.mountId,
        path: "asset.bin",
        baseHash: await sha256Hex(originalBytes),
        baseMtime: asset.lastModified,
        size: nextBytes.byteLength,
        hash: await sha256Hex(nextBytes),
        downloadUrl: "/download",
        commitUrl: "/commit",
        completeUrl: "/complete",
      });

      await writableRequested.promise;
      runtimeRevoked = true;
      resumeWritable.resolve();
      await pendingCheckin;
    } finally {
      resumeWritable.resolve();
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(completionAfterRevocation).toBe(true);
    expect(new Uint8Array(await (await asset.getFile()).arrayBuffer())).toEqual(nextBytes);
    expect(completions).toEqual([
      expect.objectContaining({
        ok: true,
        size: nextBytes.byteLength,
        hash: await sha256Hex(nextBytes),
        commitLease: "authorized-lease",
      }),
    ]);
  });

  it("does not downgrade a committed checkin when the terminal success response is lost", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([4, 5, 6]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") return new Response(nextBytes, { status: 200 });
        if (url === "/commit") {
          return new Response(JSON.stringify({ commitLease: "committed-lease" }), { status: 200 });
        }
        if (url === "/complete") {
          const completion = init?.body ? JSON.parse(String(init.body)) : {};
          completions.push(completion);
          if (completion.ok === true) throw new Error("terminal response was lost");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      await expect(
        handleUserSpaceBlobCheckinRequest({
          type: "user_space_blob_checkin_request",
          transfer_id: "committed-checkin-lost-terminal-response",
          mountId: mount.mountId,
          path: "asset.bin",
          baseHash: await sha256Hex(originalBytes),
          baseMtime: asset.lastModified,
          size: nextBytes.byteLength,
          hash: await sha256Hex(nextBytes),
          downloadUrl: "/download",
          commitUrl: "/commit",
          completeUrl: "/complete",
        }),
      ).rejects.toThrow("terminal response was lost");
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(new Uint8Array(await (await asset.getFile()).arrayBuffer())).toEqual(nextBytes);
    expect(completions).toEqual([
      expect.objectContaining({
        ok: true,
        size: nextBytes.byteLength,
        hash: await sha256Hex(nextBytes),
        commitLease: "committed-lease",
      }),
    ]);
  });

  it("retries an idempotent commit authorization when its first response is lost", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([7, 8, 9]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;
    let authorizationAttempts = 0;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") return new Response(nextBytes, { status: 200 });
        if (url === "/commit") {
          authorizationAttempts += 1;
          if (authorizationAttempts === 1) throw new Error("commit response was lost");
          return new Response(JSON.stringify({ commitLease: "idempotent-lease" }), {
            status: 200,
          });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      await handleUserSpaceBlobCheckinRequest({
        type: "user_space_blob_checkin_request",
        transfer_id: "idempotent-commit-authorization",
        mountId: mount.mountId,
        path: "asset.bin",
        baseHash: await sha256Hex(originalBytes),
        baseMtime: asset.lastModified,
        size: nextBytes.byteLength,
        hash: await sha256Hex(nextBytes),
        downloadUrl: "/download",
        commitUrl: "/commit",
        completeUrl: "/complete",
      });
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(authorizationAttempts).toBe(2);
    expect(new Uint8Array(await (await asset.getFile()).arrayBuffer())).toEqual(nextBytes);
    expect(completions).toEqual([
      expect.objectContaining({ ok: true, commitLease: "idempotent-lease" }),
    ]);
  });

  it("does not complete a checkout from a directory replaced during upload", async () => {
    const root = makeRoot();
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const uploadStarted = deferred<void>();
    const finishUpload = deferred<void>();
    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/upload") {
          uploadStarted.resolve();
          await finishUpload.promise;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      const pendingCheckout = handleUserSpaceBlobCheckoutRequest({
        type: "user_space_blob_checkout_request",
        transfer_id: "stale-checkout",
        mountId: mount.mountId,
        path: "README.md",
        uploadUrl: "/upload",
        completeUrl: "/complete",
        maxBytes: 1024,
      });
      await uploadStarted.promise;
      mockPicker(makeRoot());
      await remountUserSpace(mount);
      finishUpload.resolve();

      await expect(pendingCheckout).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(completions).toEqual([
      expect.objectContaining({ ok: false, error: "User Space runtime was disposed." }),
    ]);
    expect(getUserSpaceSnapshot().recentOperations).toEqual([]);
  });

  it("does not write checkin bytes after the directory changes during commit authorization", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const nextBytes = new Uint8Array([7, 8, 9]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const commitStarted = deferred<void>();
    const finishCommit = deferred<void>();
    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") return new Response(nextBytes, { status: 200 });
        if (url === "/commit") {
          commitStarted.resolve();
          await finishCommit.promise;
          return new Response(JSON.stringify({ commitLease: "stale-lease" }), { status: 200 });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      const pendingCheckin = handleUserSpaceBlobCheckinRequest({
        type: "user_space_blob_checkin_request",
        transfer_id: "stale-checkin-after-commit",
        mountId: mount.mountId,
        path: "asset.bin",
        baseHash: await sha256Hex(originalBytes),
        baseMtime: asset.lastModified,
        size: nextBytes.byteLength,
        hash: await sha256Hex(nextBytes),
        downloadUrl: "/download",
        commitUrl: "/commit",
        completeUrl: "/complete",
      });
      await commitStarted.promise;
      mockPicker(makeRoot());
      await remountUserSpace(mount);
      finishCommit.resolve();

      await expect(pendingCheckin).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(new Uint8Array(await (await asset.getFile()).arrayBuffer())).toEqual(originalBytes);
    expect(completions).toEqual([
      expect.objectContaining({ ok: false, commitLease: "stale-lease" }),
    ]);
    expect(getUserSpaceSnapshot().recentOperations).toEqual([]);
  });

  it("rechecks the checkout base after commit authorization before replacing the file", async () => {
    const root = makeRoot();
    const originalBytes = new Uint8Array([1, 2, 3]);
    const externalBytes = new Uint8Array([4, 4, 4]);
    const checkinBytes = new Uint8Array([7, 8, 9]);
    const asset = root.file("asset.bin", originalBytes, "application/octet-stream");
    mockPicker(root);
    const mount = await mountUserSpace("readwrite");
    const commitStarted = deferred<void>();
    const finishCommit = deferred<void>();
    const completions: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/download") return new Response(checkinBytes, { status: 200 });
        if (url === "/commit") {
          commitStarted.resolve();
          await finishCommit.promise;
          return new Response(JSON.stringify({ commitLease: "conflict-lease" }), { status: 200 });
        }
        if (url === "/complete") {
          completions.push(init?.body ? JSON.parse(String(init.body)) : {});
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    try {
      const pendingCheckin = handleUserSpaceBlobCheckinRequest({
        type: "user_space_blob_checkin_request",
        transfer_id: "checkin-base-changed-during-authorization",
        mountId: mount.mountId,
        path: "asset.bin",
        baseHash: await sha256Hex(originalBytes),
        baseMtime: asset.lastModified,
        size: checkinBytes.byteLength,
        hash: await sha256Hex(checkinBytes),
        downloadUrl: "/download",
        commitUrl: "/commit",
        completeUrl: "/complete",
      });
      await commitStarted.promise;
      const externalWrite = await asset.createWritable();
      await externalWrite.write(externalBytes);
      await externalWrite.close();
      finishCommit.resolve();

      await expect(pendingCheckin).rejects.toThrow("checkout 后发生变化");
    } finally {
      finishCommit.resolve();
      Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
    }

    expect(new Uint8Array(await (await asset.getFile()).arrayBuffer())).toEqual(externalBytes);
    expect(completions).toEqual([
      expect.objectContaining({ ok: false, commitLease: "conflict-lease" }),
    ]);
  });

  it("fails mounting when the browser permission request is denied", async () => {
    // Validates that the service surfaces permission failures instead of keeping
    // a half-mounted workspace in memory.
    mockPicker(makeRoot("denied"));

    await expect(mountUserSpace()).rejects.toThrow("permission");
  });
});
