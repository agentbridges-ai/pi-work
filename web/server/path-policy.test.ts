import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  containsProtectedRuntimePath,
  ensureScopedDirectoryNoSymlink,
  PathPolicyError,
  readScopedFileNoFollow,
  readScopedFileSnapshotNoFollow,
  requireSessionId,
  resolveScopedPath,
  resolveUnprotectedScopedPath,
  withPinnedScopedDirectory,
  writeScopedFileNoFollow,
} from "./path-policy.js";

describe("requireSessionId", () => {
  it.each(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "session_01", "s1"])(
    "accepts a safe application path segment: %s",
    (value) => {
      expect(requireSessionId(value)).toBe(value);
    },
  );

  it.each([
    "",
    ".",
    "..",
    "../other-user",
    "other/user",
    "other\\user",
    "/absolute",
    "C:\\absolute",
    "%2e%2e",
    "%252e%252e",
    "session%2fother",
    " session",
  ])("rejects traversal, separators, and encoded path syntax: %s", (value) => {
    expect(() => requireSessionId(value)).toThrow(PathPolicyError);
  });

  it("rejects 1,000 deterministic traversal and encoding variants", () => {
    for (let index = 0; index < 1_000; index++) {
      const value = [
        `../user-${index}`,
        `session/${index}`,
        `session\\${index}`,
        `%2e%2e-${index}`,
        `%252e%252e-${index}`,
      ][index % 5];
      expect(() => requireSessionId(value)).toThrow(PathPolicyError);
    }
  });
});

describe("resolveScopedPath", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piwork-path-root-"));
    outside = mkdtempSync(join(tmpdir(), "piwork-path-outside-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows existing and not-yet-created paths inside an authorized root", () => {
    mkdirSync(join(root, "workspace"));
    writeFileSync(join(root, "workspace", "existing.txt"), "ok");

    expect(resolveScopedPath(join(root, "workspace", "existing.txt"), [root])).toBe(
      join(root, "workspace", "existing.txt"),
    );
    expect(resolveScopedPath(join(root, "workspace", "new.txt"), [root])).toBe(
      join(root, "workspace", "new.txt"),
    );
  });

  it("rejects lexical traversal, symlink escapes, and encoded traversal remnants", () => {
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "outside-link"));

    expect(resolveScopedPath(join(root, "..", "escape.txt"), [root])).toBeNull();
    expect(resolveScopedPath(join(root, "outside-link", "secret.txt"), [root])).toBeNull();
    expect(resolveScopedPath(join(root, "outside-link", "new.txt"), [root])).toBeNull();
    expect(resolveScopedPath(join(root, "%252e%252e", "secret.txt"), [root])).toBeNull();
  });

  it("writes regular files but rejects existing and dangling leaf symlinks", async () => {
    const regular = join(root, "regular.txt");
    await writeScopedFileNoFollow(regular, "ok", [root]);
    expect(resolveScopedPath(regular, [root])).toBe(regular);

    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "unchanged");
    symlinkSync(victim, join(root, "existing-link.txt"));
    symlinkSync(join(outside, "missing.txt"), join(root, "dangling-link.txt"));
    await expect(
      writeScopedFileNoFollow(join(root, "existing-link.txt"), "bad", [root]),
    ).rejects.toThrow(PathPolicyError);
    await expect(
      writeScopedFileNoFollow(join(root, "dangling-link.txt"), "bad", [root]),
    ).rejects.toThrow(PathPolicyError);
  });

  it("creates parent directories component-by-component and refuses symlink ancestors", async () => {
    const nested = join(root, "one", "two", "three");
    await expect(ensureScopedDirectoryNoSymlink(nested, [root])).resolves.toBe(nested);
    expect(existsSync(nested)).toBe(true);

    const alias = join(root, "outside-alias");
    symlinkSync(outside, alias);
    await expect(
      ensureScopedDirectoryNoSymlink(join(alias, "must-not-exist", "nested"), [root]),
    ).rejects.toThrow(PathPolicyError);
    expect(existsSync(join(outside, "must-not-exist"))).toBe(false);
  });

  it("keeps scoped batch renames on the pinned destination identity", async () => {
    const source = join(root, "source");
    const destination = join(root, "destination");
    const parked = join(root, "parked-destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "one.txt"), "one");
    writeFileSync(join(source, "two.txt"), "two");

    await withPinnedScopedDirectory(destination, [root], async (pinned) => {
      await pinned.renameEntryFromPathNoReplace(join(source, "one.txt"), "one.txt");
      renameSync(destination, parked);
      mkdirSync(destination);
      await pinned.renameEntryFromPathNoReplace(join(source, "two.txt"), "two.txt");

      expect(await pinned.matchesPath(destination)).toBe(false);
      expect(await pinned.statEntry("one.txt")).toMatchObject({ kind: "file", size: 3 });
      expect(await pinned.statEntry("two.txt")).toMatchObject({ kind: "file", size: 3 });
    });

    expect(readFileSync(join(parked, "one.txt"), "utf-8")).toBe("one");
    expect(readFileSync(join(parked, "two.txt"), "utf-8")).toBe("two");
    expect(existsSync(join(destination, "one.txt"))).toBe(false);
  });

  it("rejects a hard-linked final component", async () => {
    const victim = join(outside, "hardlink-victim.txt");
    const target = join(root, "hardlink.txt");
    writeFileSync(victim, "unchanged");
    try {
      linkSync(victim, target);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") return;
      throw error;
    }
    await expect(writeScopedFileNoFollow(target, "bad", [root])).rejects.toThrow(
      /private regular file/i,
    );
    expect(readFileSync(victim, "utf-8")).toBe("unchanged");
  });

  it("reads through one no-follow descriptor and rejects symbolic and hard links", async () => {
    const regular = join(root, "regular-read.txt");
    writeFileSync(regular, "safe");
    expect(Buffer.from(await readScopedFileNoFollow(regular, [root])).toString("utf-8")).toBe(
      "safe",
    );
    const snapshot = await readScopedFileSnapshotNoFollow(regular, [root]);
    expect(snapshot.size).toBe(4);
    expect(snapshot.mtimeMs).toBeGreaterThan(0);
    expect(Buffer.from(snapshot.bytes).toString("utf-8")).toBe("safe");

    const victim = join(outside, "read-victim.txt");
    writeFileSync(victim, "secret");
    symlinkSync(victim, join(root, "read-link.txt"));
    await expect(readScopedFileNoFollow(join(root, "read-link.txt"), [root])).rejects.toThrow(
      PathPolicyError,
    );

    const hardLink = join(root, "read-hardlink.txt");
    try {
      linkSync(victim, hardLink);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") return;
      throw error;
    }
    await expect(readScopedFileNoFollow(hardLink, [root])).rejects.toThrow(/private regular file/i);
  });

  it("rejects protected runtime paths reached through an in-root symlink alias", () => {
    const protectedRoot = join(root, "pi-resources");
    mkdirSync(protectedRoot);
    writeFileSync(join(protectedRoot, "managed.json"), "private");
    symlinkSync(protectedRoot, join(root, "innocent-alias"));

    expect(
      resolveUnprotectedScopedPath(join(root, "innocent-alias", "managed.json"), [root]),
    ).toBeNull();

    const workspaceState = join(root, "workspace-state.json");
    writeFileSync(workspaceState, "{}");
    symlinkSync(workspaceState, join(root, "innocent-state.json"));
    expect(resolveUnprotectedScopedPath(join(root, "innocent-state.json"), [root])).toBeNull();
  });
});

describe("containsProtectedRuntimePath", () => {
  it.each([
    ".operations",
    ".quarantine",
    "pi-resources",
    "profile",
    "recordings",
    "user-space-checkouts",
  ])("rejects the protected component %s case-insensitively", (component) => {
    expect(containsProtectedRuntimePath(`/data/user/${component}/secret`, ["/data/user"])).toBe(
      true,
    );
    expect(
      containsProtectedRuntimePath(`/data/user/${component.toUpperCase()}/secret`, ["/data/user"]),
    ).toBe(true);
  });

  it.each(["preferences.json", "profile.json", "session.json", "workspace-state.json"])(
    "rejects app-owned state file %s and its atomic derivatives",
    (component) => {
      expect(containsProtectedRuntimePath(`/data/user/${component}`, ["/data/user"])).toBe(true);
      expect(
        containsProtectedRuntimePath(`/data/user/${component.toUpperCase()}`, ["/data/user"]),
      ).toBe(true);
      expect(
        containsProtectedRuntimePath(`/data/user/.${component}.tmp-1-2-3`, ["/data/user"]),
      ).toBe(true);
      expect(containsProtectedRuntimePath(`/data/user/${component}.bak-v0`, ["/data/user"])).toBe(
        true,
      );
    },
  );

  it("protects private Pi session roots without hiding same-named workspace directories", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const component of [
      "HOME",
      "TmP",
      "PI-CONFIG",
      "PI-SESSIONS",
      "RECORDINGS",
      "USER-SPACE-CHECKOUTS",
    ]) {
      expect(
        containsProtectedRuntimePath(`/data/user/${sessionId}/${component}/private`, [
          "/data/user",
        ]),
      ).toBe(true);
      expect(
        containsProtectedRuntimePath(
          `/data/tenants/t/users/u/sessions/${sessionId}/${component}/private`,
          ["/data/tenants/t/users/u"],
        ),
      ).toBe(true);
      expect(
        containsProtectedRuntimePath(`/data/user/${sessionId}/workspace/${component}/file`, [
          "/data/user",
        ]),
      ).toBe(false);
    }
  });

  it("allows workspace files and directories that collide with runtime names", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const relativePath of [
      "workspace/profile.json",
      "workspace/session.json",
      "workspace/recordings/result.jsonl",
      "workspace/profile/avatar.png",
      "workspace/pi-config/example.json",
      "workspace/pi-sessions/example.jsonl",
    ]) {
      expect(
        containsProtectedRuntimePath(`/data/user/${sessionId}/${relativePath}`, ["/data/user"]),
      ).toBe(false);
    }
  });
});
