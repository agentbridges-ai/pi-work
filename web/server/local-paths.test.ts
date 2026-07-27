import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getPiSessionPaths,
  getSessionDir,
  getTenantPiSessionPaths,
  getTenantUserPiSkillsRoot,
  getUserDataRoot,
  getUserPiSessionPaths,
  getUserPiSkillsRoot,
} from "./local-paths.js";

describe("local user/session path isolation", () => {
  let root: string;
  let previousDataRoot: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piwork-local-paths-"));
    previousDataRoot = process.env.PIWORK_DATA_ROOT;
    process.env.PIWORK_DATA_ROOT = root;
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.PIWORK_DATA_ROOT;
    else process.env.PIWORK_DATA_ROOT = previousDataRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("maps two Better Auth users to different canonical roots", () => {
    const canonicalRoot = realpathSync(root);
    expect(getUserDataRoot("user-a")).toBe(join(canonicalRoot, "user-a"));
    expect(getUserDataRoot("user-b")).toBe(join(canonicalRoot, "user-b"));
    expect(getUserDataRoot("user-a")).not.toBe(getUserDataRoot("user-b"));
  });

  it("rejects user-root and session-root symbolic-link aliases", () => {
    const userB = getUserDataRoot("user-b");
    symlinkSync(userB, join(root, "user-a"));
    expect(() => getUserDataRoot("user-a")).toThrow(/must not be a symbolic link/);

    const userC = getUserDataRoot("user-c");
    const realSession = join(userC, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    mkdirSync(realSession);
    symlinkSync(realSession, join(userC, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(() => getSessionDir("user-c", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toThrow(
      /must not be a symbolic link/,
    );
  });

  it("rejects a broken session-root symbolic link", () => {
    const user = getUserDataRoot("user-a");
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    symlinkSync(join(root, "missing-target"), join(user, sessionId));
    expect(() => getSessionDir("user-a", sessionId)).toThrow(/must not be a symbolic link/);
  });

  it.each(["..", "../user-b", "%2e%2e", "%252e%252e", "a/b", "a\\b"])(
    "rejects an unsafe session path segment: %s",
    (sessionId) => {
      expect(() => getSessionDir("user-a", sessionId)).toThrow(/Invalid session id/);
    },
  );

  it("returns the fixed Pi v1 session layout without creating child paths", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionRoot = getSessionDir("user-a", sessionId);
    const paths = getUserPiSessionPaths("user-a", sessionId);

    expect(paths).toEqual({
      root: sessionRoot,
      workspaceDir: join(sessionRoot, "workspace"),
      homeDir: join(sessionRoot, "home"),
      tmpDir: join(sessionRoot, "tmp"),
      piConfigDir: join(sessionRoot, "pi-config"),
      piSessionsDir: join(sessionRoot, "pi-sessions"),
      recordingsDir: join(sessionRoot, "recordings"),
      userSpaceCheckoutsDir: join(sessionRoot, "user-space-checkouts"),
      sessionFile: join(sessionRoot, "session.json"),
    });
    expect(existsSync(sessionRoot)).toBe(false);
    expect(existsSync(paths.piConfigDir)).toBe(false);
  });

  it("maps tenant sessions to the same fixed Pi layout", () => {
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const paths = getTenantPiSessionPaths("tenant-a", "user-a", sessionId);
    expect(paths.root).toBe(
      join(realpathSync(root), "tenants", "tenant-a", "users", "user-a", "sessions", sessionId),
    );
    expect(paths.piConfigDir).toBe(join(paths.root, "pi-config"));
    expect(paths.piSessionsDir).toBe(join(paths.root, "pi-sessions"));
  });

  it("keeps managed Pi skills in per-user resource roots", () => {
    expect(getUserPiSkillsRoot("user-a")).toBe(
      join(realpathSync(root), "user-a", "pi-resources", "skills"),
    );
    expect(getTenantUserPiSkillsRoot("tenant-a", "user-a")).toBe(
      join(realpathSync(root), "tenants", "tenant-a", "users", "user-a", "pi-resources", "skills"),
    );
  });

  it("normalizes an explicit session root without filesystem side effects", () => {
    const explicit = join(root, "a", "..", "session");
    const paths = getPiSessionPaths(explicit);
    expect(paths.root).toBe(join(root, "session"));
    expect(existsSync(paths.root)).toBe(false);
  });
});
