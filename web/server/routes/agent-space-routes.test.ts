import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Hono } from "hono";
import { registerAgentSpaceRoutes } from "./agent-space-routes.js";
import { ENV } from "../environment.js";
import type { UserSpaceBroker } from "../user-space-broker.js";
import { UserDiskQuota } from "../user-disk-quota.js";

const user = {
  userId: "user-a",
  uuid: "user-a",
  username: "user-a",
  displayName: "User A",
  orgId: "local",
  orgName: "Local",
  roles: [],
};

class FakeUserSpaceBroker {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>([""]);
  private checkoutIndex = 0;

  constructor(private readonly tempRoot: string) {}

  setFile(path: string, content: string | Uint8Array): void {
    const clean = cleanUserPath(path);
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    this.ensureDir(dirname(clean) === "." ? "" : dirname(clean));
    this.files.set(clean, bytes);
  }

  getFile(path: string): Uint8Array | undefined {
    return this.files.get(cleanUserPath(path));
  }

  async requestOperation(
    _sessionId: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (operation === "list_dir") {
      const path = cleanUserPath(typeof input.path === "string" ? input.path : "");
      if (!this.dirs.has(path)) throw new Error("directory not found");
      return { entries: [], nextCursor: undefined };
    }
    if (operation === "read_file") {
      const path = cleanUserPath(typeof input.path === "string" ? input.path : "");
      const bytes = this.files.get(path);
      if (!bytes) throw new Error("file not found");
      return { content: new TextDecoder().decode(bytes), size: bytes.byteLength };
    }
    if (operation === "create_entry") {
      const parentPath = cleanUserPath(
        typeof input.parentPath === "string" ? input.parentPath : "",
      );
      const name = typeof input.name === "string" ? input.name : "";
      const kind = input.kind === "file" ? "file" : "directory";
      const path = joinUserPath(parentPath, name);
      if (this.dirs.has(path) || this.files.has(path)) throw new Error("entry exists");
      this.ensureDir(parentPath);
      if (kind === "directory") this.dirs.add(path);
      else this.files.set(path, new Uint8Array());
      return { path, kind, created: true };
    }
    throw new Error(`Unsupported fake user-space operation: ${operation}`);
  }

  async requestBlobCheckout(_sessionId: string, input: { path: string }): Promise<unknown> {
    const path = cleanUserPath(input.path);
    const bytes = this.files.get(path);
    if (!bytes) throw new Error("file not found");
    const localPath = join(this.tempRoot, `checkout-${++this.checkoutIndex}-${basename(path)}`);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, bytes);
    const hash = sha256(bytes);
    return { localPath, size: bytes.byteLength, hash, baseHash: hash };
  }

  async consumeBlobCheckout(
    _sessionId: string,
    input: { localPath: string; expectedSize?: number; expectedHash?: string },
  ): Promise<Uint8Array> {
    const bytes = new Uint8Array(readFileSync(input.localPath));
    if (bytes.byteLength !== input.expectedSize || sha256(bytes) !== input.expectedHash) {
      throw new Error("checkout changed");
    }
    rmSync(input.localPath, { force: true });
    return bytes;
  }

  async requestBlobCheckin(
    _sessionId: string,
    input: { path: string; body: Uint8Array; create?: boolean },
  ): Promise<unknown> {
    const path = cleanUserPath(input.path);
    if (input.create === true && (this.files.has(path) || this.dirs.has(path)))
      throw new Error("entry exists");
    this.setFile(path, input.body);
    return { bytesWritten: input.body.byteLength, hash: sha256(input.body) };
  }

  private ensureDir(path: string): void {
    const clean = cleanUserPath(path);
    if (!clean) {
      this.dirs.add("");
      return;
    }
    const parts = clean.split("/");
    let current = "";
    for (const part of parts) {
      current = joinUserPath(current, part);
      this.dirs.add(current);
    }
  }
}

function cleanUserPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^user-space:\//, "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function joinUserPath(...parts: string[]): string {
  return parts.join("/").replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("agent-space routes", () => {
  let dataRoot = "";
  let previousDataRoot: string | undefined;
  let app: Hono;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "piwork-agent-space-"));
    previousDataRoot = process.env[ENV.PIWORK_DATA_ROOT];
    process.env[ENV.PIWORK_DATA_ROOT] = dataRoot;
    app = new Hono();
    registerAgentSpaceRoutes(app, { getCurrentUser: () => user });
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env[ENV.PIWORK_DATA_ROOT];
    else process.env[ENV.PIWORK_DATA_ROOT] = previousDataRoot;
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  });

  function workspacePath(...parts: string[]): string {
    return join(dataRoot, user.uuid, "s1", "workspace", ...parts);
  }

  it("lists and reads workspace-relative Agent Space files", async () => {
    mkdirSync(workspacePath("src"), { recursive: true });
    writeFileSync(workspacePath("src", "app.ts"), "export const ok = true;\n");

    const list = await app.request("/sessions/s1/agent-space/list?recursive=1");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      rootName: string;
      tree: Array<{ path: string; type: string; children?: Array<{ path: string }> }>;
    };
    expect(listBody.rootName).toBe("workspace");
    expect(listBody.tree[0]).toEqual(expect.objectContaining({ path: "src", type: "directory" }));
    expect(listBody.tree[0].children).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    );

    const depthZero = await app.request("/sessions/s1/agent-space/list?recursive=1&depth=0");
    expect(depthZero.status).toBe(200);
    await expect(depthZero.json()).resolves.toEqual(expect.objectContaining({ tree: [] }));

    const read = await app.request("/sessions/s1/agent-space/read?path=src%2Fapp.ts");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(
      expect.objectContaining({
        path: "src/app.ts",
        content: "export const ok = true;\n",
        sha256: expect.any(String),
      }),
    );

    const metadata = await app.request("/sessions/s1/agent-space/metadata?path=src%2Fapp.ts");
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toEqual(
      expect.objectContaining({
        path: "src/app.ts",
        name: "app.ts",
        kind: "file",
        size: Buffer.byteLength("export const ok = true;\n"),
        sha256: expect.any(String),
      }),
    );
  });

  it("serves raw file bytes through an authenticated session route", async () => {
    mkdirSync(workspacePath("images"), { recursive: true });
    writeFileSync(workspacePath("images", "pixel.png"), new Uint8Array([137, 80, 78, 71]));

    const res = await app.request("/sessions/s1/agent-space/raw?path=images%2Fpixel.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("pixel.png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("X-Piwork-Agent-Space-Sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("atomically reclaims binary native edits against the source digest", async () => {
    mkdirSync(workspacePath("docs"), { recursive: true });
    const original = new Uint8Array([1, 2, 3]);
    const changed = new Uint8Array([4, 5, 6, 7]);
    writeFileSync(workspacePath("docs", "artifact.bin"), original);
    const baseline = sha256(original);

    const replaced = await app.request(
      `/sessions/s1/agent-space/raw?path=docs%2Fartifact.bin&baselineSha256=${baseline}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: changed,
      },
    );
    expect(replaced.status).toBe(200);
    expect(new Uint8Array(readFileSync(workspacePath("docs", "artifact.bin")))).toEqual(changed);

    const stale = await app.request(
      `/sessions/s1/agent-space/raw?path=docs%2Fartifact.bin&baselineSha256=${baseline}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: original,
      },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "native_edit_source_changed",
    });

    const copy = await app.request(
      "/sessions/s1/agent-space/raw?path=docs%2Fartifact-copy.bin&create=1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: original,
      },
    );
    expect(copy.status).toBe(200);
    expect(new Uint8Array(readFileSync(workspacePath("docs", "artifact-copy.bin")))).toEqual(
      original,
    );
  });

  it("forces active Agent Space content to download under a strict sandbox policy", async () => {
    mkdirSync(workspacePath("pages"), { recursive: true });
    const active = '<script>top.location="https://example.invalid"</script>';
    for (const name of [
      "unsafe.html",
      "unsafe.js",
      "unsafe.svg",
      "unsafe.xml",
      "unsafe.css",
      "unsafe.xhtml",
    ]) {
      writeFileSync(workspacePath("pages", name), active);
      const res = await app.request(
        `/sessions/s1/agent-space/raw?path=${encodeURIComponent(`pages/${name}`)}`,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="download"; filename*=UTF-8''${name}`,
      );
      expect(res.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(await res.text()).toBe(active);
    }
  });

  it("rejects traversal and symlink escapes", async () => {
    mkdirSync(workspacePath("safe"), { recursive: true });
    mkdirSync(join(dataRoot, "outside"), { recursive: true });
    writeFileSync(join(dataRoot, "outside", "secret.txt"), "nope");
    symlinkSync(join(dataRoot, "outside", "secret.txt"), workspacePath("safe", "secret-link.txt"));

    const traversal = await app.request("/sessions/s1/agent-space/read?path=..%2Fsecret.txt");
    expect(traversal.status).toBe(400);

    const symlink = await app.request("/sessions/s1/agent-space/read?path=safe%2Fsecret-link.txt");
    expect(symlink.status).toBe(403);

    const encodedSession = await app.request(
      "/sessions/%252e%252e/agent-space/read?path=secret.txt",
    );
    expect(encodedSession.status).toBe(400);
  });

  it("rejects a symlinked Agent Space workspace root before creating content", async () => {
    const sessionDir = dirname(workspacePath());
    const outsideWorkspace = join(dataRoot, "outside-workspace");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(outsideWorkspace, { recursive: true });
    symlinkSync(outsideWorkspace, workspacePath());

    const response = await app.request("/sessions/s1/agent-space/list?recursive=1");

    expect(response.status).toBe(403);
    expect(existsSync(join(outsideWorkspace, ".piwork-boundary-check"))).toBe(false);
  });

  it("rejects final-component symlinks and hard links on every Agent Space file read", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    mkdirSync(workspacePath("safe"), { recursive: true });
    const real = workspacePath("safe", "real.txt");
    writeFileSync(real, "private");
    symlinkSync(real, workspacePath("safe", "alias.txt"));
    linkSync(real, workspacePath("safe", "hard-alias.txt"));

    for (const path of ["safe/alias.txt", "safe/hard-alias.txt"]) {
      for (const route of ["read", "raw", "metadata"]) {
        const response = await app.request(
          `/sessions/s1/agent-space/${route}?path=${encodeURIComponent(path)}`,
        );
        expect(response.status).toBe(403);
      }
    }

    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });
    const transfer = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/alias.txt" }),
    });
    expect(transfer.status).toBe(403);
    expect(broker.getFile("shared/alias.txt")).toBeUndefined();
  });

  it("writes only inside the session workspace", async () => {
    const write = await app.request("/sessions/s1/agent-space/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/result.txt", content: "done\n" }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual(
      expect.objectContaining({
        ok: true,
        path: "shared/result.txt",
        sha256: expect.any(String),
      }),
    );

    const escaped = await app.request("/sessions/s1/agent-space/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../result.txt", content: "bad" }),
    });
    expect(escaped.status).toBe(400);
  });

  it("creates, renames, and deletes Agent Space entries inside the workspace", async () => {
    const createDir = await app.request("/sessions/s1/agent-space/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/reports", kind: "directory" }),
    });
    expect(createDir.status).toBe(200);
    expect(existsSync(workspacePath("shared", "reports"))).toBe(true);

    const createFile = await app.request("/sessions/s1/agent-space/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/reports/today.txt", kind: "file", content: "ok" }),
    });
    expect(createFile.status).toBe(200);

    const rename = await app.request("/sessions/s1/agent-space/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "shared/reports/today.txt",
        newPath: "shared/reports/done.txt",
      }),
    });
    expect(rename.status).toBe(200);
    expect(existsSync(workspacePath("shared", "reports", "done.txt"))).toBe(true);

    const del = await app.request("/sessions/s1/agent-space/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/reports", recursive: true }),
    });
    expect(del.status).toBe(200);
    expect(existsSync(workspacePath("shared", "reports"))).toBe(false);
  });

  it("returns 507 before an Agent Space file write exceeds the user quota", async () => {
    const quota = new UserDiskQuota({ maxBytes: 4, reservedHeadroomBytes: 1 });
    quota.addRoot(dataRoot);
    await quota.reconcile();
    const quotaApp = new Hono();
    registerAgentSpaceRoutes(quotaApp, {
      getCurrentUser: () => user,
      diskQuota: quota,
    });

    const response = await quotaApp.request("/sessions/s1/agent-space/write", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "blocked.txt", content: "12345" }),
    });

    expect(response.status).toBe(507);
    expect(existsSync(workspacePath("blocked.txt"))).toBe(false);
  });

  it("renames with atomic no-replace semantics", async () => {
    mkdirSync(workspacePath("safe"), { recursive: true });
    writeFileSync(workspacePath("safe", "source.txt"), "source");
    writeFileSync(workspacePath("safe", "target.txt"), "target");

    const response = await app.request("/sessions/s1/agent-space/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/source.txt", newPath: "safe/target.txt" }),
    });

    expect(response.status).toBe(409);
    expect(readFileSync(workspacePath("safe", "source.txt"), "utf-8")).toBe("source");
    expect(readFileSync(workspacePath("safe", "target.txt"), "utf-8")).toBe("target");
  });

  it("moves multiple Agent Space entries into one workspace directory", async () => {
    mkdirSync(workspacePath("incoming"), { recursive: true });
    mkdirSync(workspacePath("archive"), { recursive: true });
    writeFileSync(workspacePath("incoming", "a.txt"), "a");
    writeFileSync(workspacePath("incoming", "b.txt"), "b");

    const response = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["incoming/a.txt", "incoming/b.txt"],
        targetDirPath: "archive",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      moves: [
        { path: "incoming/a.txt", newPath: "archive/a.txt" },
        { path: "incoming/b.txt", newPath: "archive/b.txt" },
      ],
    });
    expect(existsSync(workspacePath("incoming", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("incoming", "b.txt"))).toBe(false);
    expect(readFileSync(workspacePath("archive", "a.txt"), "utf-8")).toBe("a");
    expect(readFileSync(workspacePath("archive", "b.txt"), "utf-8")).toBe("b");
  });

  it("deduplicates descendants when an Agent Space parent is also selected", async () => {
    mkdirSync(workspacePath("source", "nested"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("source", "top.txt"), "top");
    writeFileSync(workspacePath("source", "nested", "child.txt"), "child");

    const response = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["source/nested/child.txt", "source", "source/top.txt", "source"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      moves: [{ path: "source", newPath: "target/source" }],
    });
    expect(readFileSync(workspacePath("target", "source", "top.txt"), "utf-8")).toBe("top");
    expect(readFileSync(workspacePath("target", "source", "nested", "child.txt"), "utf-8")).toBe(
      "child",
    );
  });

  it("deduplicates a selected descendant even when a similarly prefixed sibling sorts between it and its parent", async () => {
    mkdirSync(workspacePath("a"), { recursive: true });
    mkdirSync(workspacePath("a-b"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("a", "child.txt"), "child");
    writeFileSync(workspacePath("a-b", "sibling.txt"), "sibling");

    const response = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["a", "a-b", "a/child.txt"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      moves: [
        { path: "a", newPath: "target/a" },
        { path: "a-b", newPath: "target/a-b" },
      ],
    });
    expect(readFileSync(workspacePath("target", "a", "child.txt"), "utf-8")).toBe("child");
    expect(readFileSync(workspacePath("target", "a-b", "sibling.txt"), "utf-8")).toBe("sibling");
  });

  it("validates every source before treating a selected parent as a directory", async () => {
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("source.txt"), "source");

    const response = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["source.txt", "source.txt/not-a-child"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(403);
    expect(readFileSync(workspacePath("source.txt"), "utf-8")).toBe("source");
    expect(existsSync(workspacePath("target", "source.txt"))).toBe(false);
  });

  it("rejects same-parent, self, and descendant Agent Space move targets", async () => {
    mkdirSync(workspacePath("folder", "nested"), { recursive: true });
    writeFileSync(workspacePath("folder", "a.txt"), "a");

    for (const request of [
      { paths: ["folder/a.txt"], targetDirPath: "folder" },
      { paths: ["folder"], targetDirPath: "folder" },
      { paths: ["folder"], targetDirPath: "folder/nested" },
    ]) {
      const response = await app.request("/sessions/s1/agent-space/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "agent_space_move_invalid_destination",
      });
    }

    expect(readFileSync(workspacePath("folder", "a.txt"), "utf-8")).toBe("a");
    expect(existsSync(workspacePath("folder", "nested"))).toBe(true);
  });

  it("rejects deterministic Agent Space move conflicts before moving any entry", async () => {
    mkdirSync(workspacePath("source"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("source", "a.txt"), "source-a");
    writeFileSync(workspacePath("source", "b.txt"), "source-b");
    writeFileSync(workspacePath("target", "b.txt"), "existing-b");

    const response = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["source/a.txt", "source/b.txt"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "target already exists",
      code: "agent_space_move_target_exists",
    });
    expect(readFileSync(workspacePath("source", "a.txt"), "utf-8")).toBe("source-a");
    expect(readFileSync(workspacePath("source", "b.txt"), "utf-8")).toBe("source-b");
    expect(existsSync(workspacePath("target", "a.txt"))).toBe(false);
    expect(readFileSync(workspacePath("target", "b.txt"), "utf-8")).toBe("existing-b");
  });

  it("rolls back earlier Agent Space moves when a later no-replace rename races", async () => {
    mkdirSync(workspacePath("source"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("source", "a.txt"), "source-a");
    writeFileSync(workspacePath("source", "b.txt"), "source-b");
    const racingApp = new Hono();
    registerAgentSpaceRoutes(racingApp, {
      getCurrentUser: () => user,
      moveTestHooks: {
        afterMoveApplied(_move, index) {
          if (index === 0) writeFileSync(workspacePath("target", "b.txt"), "external-b");
        },
      },
    });

    const response = await racingApp.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["source/a.txt", "source/b.txt"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "target already exists",
      code: "agent_space_move_target_exists",
    });
    expect(readFileSync(workspacePath("source", "a.txt"), "utf-8")).toBe("source-a");
    expect(readFileSync(workspacePath("source", "b.txt"), "utf-8")).toBe("source-b");
    expect(existsSync(workspacePath("target", "a.txt"))).toBe(false);
    expect(readFileSync(workspacePath("target", "b.txt"), "utf-8")).toBe("external-b");
  });

  it("pins one destination identity and rolls back when its pathname is replaced mid-batch", async () => {
    mkdirSync(workspacePath("incoming"), { recursive: true });
    mkdirSync(workspacePath("archive"), { recursive: true });
    writeFileSync(workspacePath("incoming", "a.txt"), "a");
    writeFileSync(workspacePath("incoming", "b.txt"), "b");
    let swapped = false;
    const pinnedApp = new Hono();
    registerAgentSpaceRoutes(pinnedApp, {
      getCurrentUser: () => user,
      moveTestHooks: {
        afterMoveApplied(_move, index) {
          if (index !== 0 || swapped) return;
          swapped = true;
          renameSync(workspacePath("archive"), workspacePath("parked-archive"));
          mkdirSync(workspacePath("archive"));
        },
      },
    });

    const response = await pinnedApp.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["incoming/a.txt", "incoming/b.txt"],
        targetDirPath: "archive",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Target directory changed during Agent Space move",
      code: "agent_space_move_invalid_destination",
    });
    expect(readFileSync(workspacePath("incoming", "a.txt"), "utf-8")).toBe("a");
    expect(readFileSync(workspacePath("incoming", "b.txt"), "utf-8")).toBe("b");
    expect(existsSync(workspacePath("parked-archive", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("parked-archive", "b.txt"))).toBe(false);
    expect(existsSync(workspacePath("archive", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("archive", "b.txt"))).toBe(false);
  });

  it("rolls back into the pinned source parent when its pathname is replaced mid-batch", async () => {
    mkdirSync(workspacePath("incoming"), { recursive: true });
    mkdirSync(workspacePath("archive"), { recursive: true });
    writeFileSync(workspacePath("incoming", "a.txt"), "a");
    writeFileSync(workspacePath("incoming", "b.txt"), "b");
    const pinnedApp = new Hono();
    registerAgentSpaceRoutes(pinnedApp, {
      getCurrentUser: () => user,
      moveTestHooks: {
        afterMoveApplied(_move, index) {
          if (index !== 0) return;
          renameSync(workspacePath("incoming"), workspacePath("parked-incoming"));
          mkdirSync(workspacePath("incoming"));
        },
      },
    });

    const response = await pinnedApp.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["incoming/a.txt", "incoming/b.txt"],
        targetDirPath: "archive",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Source parent directory changed during Agent Space move",
      code: "agent_space_move_invalid_source",
    });
    expect(readFileSync(workspacePath("parked-incoming", "a.txt"), "utf-8")).toBe("a");
    expect(readFileSync(workspacePath("parked-incoming", "b.txt"), "utf-8")).toBe("b");
    expect(existsSync(workspacePath("incoming", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("incoming", "b.txt"))).toBe(false);
    expect(existsSync(workspacePath("archive", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("archive", "b.txt"))).toBe(false);
  });

  it("rejects a source entry replaced after preflight and rolls back earlier moves", async () => {
    mkdirSync(workspacePath("source"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("source", "a.txt"), "source-a");
    writeFileSync(workspacePath("source", "b.txt"), "source-b");
    const pinnedApp = new Hono();
    registerAgentSpaceRoutes(pinnedApp, {
      getCurrentUser: () => user,
      moveTestHooks: {
        afterMoveApplied(_move, index) {
          if (index !== 0) return;
          writeFileSync(workspacePath("source", "replacement-b.txt"), "external-b");
          renameSync(
            workspacePath("source", "replacement-b.txt"),
            workspacePath("source", "b.txt"),
          );
        },
      },
    });

    const response = await pinnedApp.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["source/a.txt", "source/b.txt"],
        targetDirPath: "target",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Source entry changed during Agent Space move",
      code: "agent_space_move_invalid_source",
    });
    expect(readFileSync(workspacePath("source", "a.txt"), "utf-8")).toBe("source-a");
    expect(readFileSync(workspacePath("source", "b.txt"), "utf-8")).toBe("external-b");
    expect(existsSync(workspacePath("target", "a.txt"))).toBe(false);
    expect(existsSync(workspacePath("target", "b.txt"))).toBe(false);
  });

  it("keeps batch Agent Space moves inside the workspace and rejects symlink paths", async () => {
    mkdirSync(workspacePath("safe"), { recursive: true });
    mkdirSync(join(dataRoot, "outside"), { recursive: true });
    mkdirSync(workspacePath("target"), { recursive: true });
    writeFileSync(workspacePath("safe", "source.txt"), "safe");
    writeFileSync(join(dataRoot, "outside", "secret.txt"), "private");
    symlinkSync(join(dataRoot, "outside"), workspacePath("safe", "outside-link"));
    symlinkSync(join(dataRoot, "outside", "secret.txt"), workspacePath("safe", "source-link.txt"));

    const escaped = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["safe/source.txt"], targetDirPath: "../outside" }),
    });
    expect(escaped.status).toBe(400);

    const linked = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["safe/source.txt"], targetDirPath: "safe/outside-link" }),
    });
    expect(linked.status).toBe(403);

    const linkedSource = await app.request("/sessions/s1/agent-space/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["safe/source-link.txt"], targetDirPath: "target" }),
    });
    expect(linkedSource.status).toBe(403);
    expect(readFileSync(workspacePath("safe", "source.txt"), "utf-8")).toBe("safe");
    expect(readFileSync(join(dataRoot, "outside", "secret.txt"), "utf-8")).toBe("private");
    expect(existsSync(join(dataRoot, "outside", "source.txt"))).toBe(false);
  });

  it("guards Agent Space mutations against traversal and symlink escapes", async () => {
    mkdirSync(workspacePath("safe"), { recursive: true });
    mkdirSync(join(dataRoot, "outside"), { recursive: true });
    symlinkSync(join(dataRoot, "outside"), workspacePath("safe", "outside-link"));

    const createEscaped = await app.request("/sessions/s1/agent-space/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../evil.txt", kind: "file" }),
    });
    expect(createEscaped.status).toBe(400);

    const writeThroughLink = await app.request("/sessions/s1/agent-space/write", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/outside-link/evil.txt", content: "bad" }),
    });
    expect(writeThroughLink.status).toBe(403);

    const createThroughLink = await app.request("/sessions/s1/agent-space/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "safe/outside-link/new-parent/evil.txt",
        kind: "file",
      }),
    });
    expect(createThroughLink.status).toBe(403);
    expect(existsSync(join(dataRoot, "outside", "new-parent"))).toBe(false);

    const renameEscaped = await app.request("/sessions/s1/agent-space/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe", newPath: "../safe2" }),
    });
    expect(renameEscaped.status).toBe(400);

    const victim = workspacePath("safe", "victim.txt");
    const alias = workspacePath("safe", "victim-link.txt");
    writeFileSync(victim, "unchanged");
    symlinkSync(victim, alias);

    const deleteLink = await app.request("/sessions/s1/agent-space/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/victim-link.txt" }),
    });
    expect(deleteLink.status).toBe(403);

    const renameLink = await app.request("/sessions/s1/agent-space/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/victim-link.txt", newPath: "safe/moved.txt" }),
    });
    expect(renameLink.status).toBe(403);
    expect(readFileSync(victim, "utf-8")).toBe("unchanged");

    const hardAlias = workspacePath("safe", "victim-hard.txt");
    try {
      linkSync(victim, hardAlias);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") return;
      throw error;
    }
    const deleteHardLink = await app.request("/sessions/s1/agent-space/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/victim-hard.txt" }),
    });
    expect(deleteHardLink.status).toBe(403);

    const renameHardLink = await app.request("/sessions/s1/agent-space/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "safe/victim-hard.txt", newPath: "safe/hard-moved.txt" }),
    });
    expect(renameHardLink.status).toBe(403);
    expect(readFileSync(victim, "utf-8")).toBe("unchanged");
  });

  it("rejects existing and dangling final-component symlinks on Agent Space writes", async () => {
    mkdirSync(workspacePath("safe"), { recursive: true });
    const outside = join(dataRoot, "outside");
    mkdirSync(outside, { recursive: true });
    const existingVictim = join(outside, "existing.txt");
    const missingVictim = join(outside, "missing.txt");
    writeFileSync(existingVictim, "unchanged");
    symlinkSync(existingVictim, workspacePath("safe", "existing-link.txt"));
    symlinkSync(missingVictim, workspacePath("safe", "dangling-link.txt"));

    for (const path of ["safe/existing-link.txt", "safe/dangling-link.txt"]) {
      const response = await app.request("/sessions/s1/agent-space/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "overwritten" }),
      });
      expect(response.status).toBe(403);

      const createResponse = await app.request("/sessions/s1/agent-space/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, kind: "file", content: "overwritten" }),
      });
      expect(createResponse.status).toBe(403);
    }

    expect(readFileSync(existingVictim, "utf-8")).toBe("unchanged");
    expect(existsSync(missingVictim)).toBe(false);
  });

  it("serializes Agent Space mutations and continues after a queued transfer fails", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    const transferStarted = deferred<void>();
    const releaseTransfer = deferred<void>();
    vi.spyOn(broker, "requestOperation").mockImplementation(async (_sessionId, operation) => {
      if (operation === "list_dir") throw new Error("not a directory");
      if (operation === "read_file") {
        transferStarted.resolve(undefined);
        await releaseTransfer.promise;
        throw new Error("deferred source failure");
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const queuedApp = new Hono();
    registerAgentSpaceRoutes(queuedApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const failedTransfer = queuedApp.request("/sessions/s1/transfer/user-to-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "blocked.txt" }),
    });
    await transferStarted.promise;

    let writeSettled = false;
    const queuedWrite = Promise.resolve(
      queuedApp.request("/sessions/s1/agent-space/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "queued.txt", content: "after failure" }),
      }),
    ).then((response) => {
      writeSettled = true;
      return response;
    });
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 20));

    expect(writeSettled).toBe(false);
    expect(existsSync(workspacePath("queued.txt"))).toBe(false);

    releaseTransfer.resolve(undefined);
    const failedResponse = await failedTransfer;
    expect(failedResponse.status).toBe(400);
    await expect(failedResponse.json()).resolves.toEqual({ error: "deferred source failure" });

    const writeResponse = await queuedWrite;
    expect(writeResponse.status).toBe(200);
    expect(readFileSync(workspacePath("queued.txt"), "utf-8")).toBe("after failure");
  });

  it("skips user-to-agent transfer copies when the target file has the same hash", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("report.txt", "same content");
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "report.txt"), "same content");
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/user-to-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "report.txt" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "user-space:/report.txt",
          target: "workspace/shared/report.txt",
          status: "exists",
        }),
      ],
    });
    expect(existsSync(workspacePath("shared", "report copy.txt"))).toBe(false);
  });

  it("uses the active tenant session workspace as Agent Space", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("项目级别.docx", new Uint8Array([1, 2, 3]));
    const tenantId = "personal-user-a";
    const tenantApp = new Hono();
    registerAgentSpaceRoutes(tenantApp, {
      getCurrentUser: () => ({ ...user, tenantId, tenantType: "personal" }),
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await tenantApp.request("/sessions/s1/transfer/user-to-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "项目级别.docx" }),
    });

    expect(res.status).toBe(200);
    const tenantTarget = join(
      dataRoot,
      "tenants",
      tenantId,
      "users",
      user.uuid,
      "sessions",
      "s1",
      "workspace",
      "shared",
      "项目级别.docx",
    );
    expect(readFileSync(tenantTarget)).toEqual(Buffer.from([1, 2, 3]));
    expect(existsSync(workspacePath("shared", "项目级别.docx"))).toBe(false);
  });

  it("creates a user-to-agent copy when the target name exists with a different hash", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("report.txt", "new content");
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "report.txt"), "old content");
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/user-to-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "report.txt" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "user-space:/report.txt",
          target: "workspace/shared/report copy.txt",
          status: "ok",
        }),
      ],
    });
    expect(readFileSync(workspacePath("shared", "report.txt"), "utf-8")).toBe("old content");
    expect(readFileSync(workspacePath("shared", "report copy.txt"), "utf-8")).toBe("new content");
  });

  it("fails closed when a user-to-agent destination is a dangling symlink", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("report.txt", "new content");
    mkdirSync(workspacePath("shared"), { recursive: true });
    const outsideTarget = join(dataRoot, "outside", "created.txt");
    mkdirSync(dirname(outsideTarget), { recursive: true });
    symlinkSync(outsideTarget, workspacePath("shared", "report.txt"));
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/user-to-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "report.txt" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      files: [expect.objectContaining({ status: "error" })],
    });
    expect(existsSync(outsideTarget)).toBe(false);
  });

  it("skips agent-to-user transfer copies when the target file has the same hash", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("shared/artifact.pdf", new Uint8Array([1, 2, 3]));
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "artifact.pdf"), new Uint8Array([1, 2, 3]));
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/artifact.pdf" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "workspace/shared/artifact.pdf",
          target: "user-space:/shared/artifact.pdf",
          status: "exists",
        }),
      ],
    });
    expect(broker.getFile("shared/artifact copy.pdf")).toBeUndefined();
  });

  it("creates the user-space shared directory for a new agent-to-user transfer", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    mkdirSync(workspacePath(), { recursive: true });
    writeFileSync(workspacePath("result.txt"), "fresh");
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "result.txt" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "workspace/result.txt",
          target: "user-space:/shared/result.txt",
          status: "ok",
        }),
      ],
    });
    expect(new TextDecoder().decode(broker.getFile("shared/result.txt")!)).toBe("fresh");
  });

  it("creates an agent-to-user copy when the target name exists with a different hash", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("shared/artifact.pdf", new Uint8Array([9, 9, 9]));
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "artifact.pdf"), new Uint8Array([1, 2, 3]));
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/artifact.pdf" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "workspace/shared/artifact.pdf",
          target: "user-space:/shared/artifact copy.pdf",
          status: "ok",
        }),
      ],
    });
    expect(broker.getFile("shared/artifact.pdf")).toEqual(new Uint8Array([9, 9, 9]));
    expect(broker.getFile("shared/artifact copy.pdf")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("safely writes an Agent Space file to an explicit User Space destination", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    broker.setFile("日常售前技术支持/项目级别.docx", new Uint8Array([1, 2, 3]));
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "项目级别.docx"), new Uint8Array([4, 5, 6]));
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "shared/项目级别.docx",
        targetPath: "日常售前技术支持/项目级别.docx",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      files: [
        expect.objectContaining({
          source: "workspace/shared/项目级别.docx",
          target: "user-space:/日常售前技术支持/项目级别.docx",
          status: "ok",
        }),
      ],
    });
    expect(broker.getFile("日常售前技术支持/项目级别.docx")).toEqual(new Uint8Array([4, 5, 6]));
    expect(broker.getFile("shared/项目级别.docx")).toBeUndefined();
  });

  it("preserves 507 when an Agent Space to User Space checkin exceeds quota", async () => {
    const broker = new FakeUserSpaceBroker(dataRoot);
    vi.spyOn(broker, "requestBlobCheckin").mockRejectedValue(
      Object.assign(new Error("User disk quota exceeded"), { status: 507 }),
    );
    mkdirSync(workspacePath("shared"), { recursive: true });
    writeFileSync(workspacePath("shared", "result.txt"), "fresh");
    const transferApp = new Hono();
    registerAgentSpaceRoutes(transferApp, {
      getCurrentUser: () => user,
      userSpaceBroker: broker as unknown as UserSpaceBroker,
    });

    const res = await transferApp.request("/sessions/s1/transfer/agent-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "shared/result.txt" }),
    });

    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({ error: "User disk quota exceeded" });
  });
});
