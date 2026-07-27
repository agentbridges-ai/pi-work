import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePiSessionFile,
  preparePiSessionLayout,
  resolvePiResumeFile,
} from "./pi-session-layout.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    makeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) makeRemovable(join(path, entry));
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-layout-")));
  roots.push(root);
  return preparePiSessionLayout(join(root, "session"));
}

describe("Pi session layout", () => {
  it("creates only the fixed runtime directories", () => {
    const layout = fixture();
    for (const path of [
      layout.workspaceDir,
      layout.homeDir,
      layout.tmpDir,
      layout.piConfigDir,
      layout.piRuntimeConfigDir,
      layout.piSessionsDir,
      layout.piResourcesDir,
      layout.managedSkillsDir,
      layout.recordingsDir,
      layout.userSpaceCheckoutsDir,
      layout.sessionRoot,
    ]) {
      expect(existsSync(path)).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    }
    expect(layout.sessionJsonPath).toBe(join(layout.sessionRoot, "session.json"));
  });

  it("repairs permissive modes on an existing fixed tree", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-layout-mode-")));
    roots.push(root);
    const sessionRoot = join(root, "session");
    mkdirSync(sessionRoot, { mode: 0o777 });
    for (const directory of [
      "workspace",
      "home",
      "tmp",
      "pi-config",
      "pi-sessions",
      "recordings",
      "user-space-checkouts",
    ]) {
      const path = join(sessionRoot, directory);
      mkdirSync(path, { recursive: true });
      chmodSync(path, 0o777);
    }
    chmodSync(sessionRoot, 0o777);

    const layout = preparePiSessionLayout(sessionRoot);

    for (const path of [
      layout.sessionRoot,
      layout.workspaceDir,
      layout.homeDir,
      layout.tmpDir,
      layout.piConfigDir,
      layout.piRuntimeConfigDir,
      layout.piSessionsDir,
      layout.piResourcesDir,
      layout.managedSkillsDir,
      layout.recordingsDir,
      layout.userSpaceCheckoutsDir,
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    }
  });

  it("preserves sealed managed resource modes on repeated layout validation", () => {
    const layout = fixture();
    chmodSync(layout.managedSkillsDir, 0o500);
    chmodSync(layout.piResourcesDir, 0o500);

    const repeated = preparePiSessionLayout(layout.sessionRoot);

    expect(lstatSync(repeated.piResourcesDir).mode & 0o777).toBe(0o500);
    expect(lstatSync(repeated.managedSkillsDir).mode & 0o777).toBe(0o500);
    expect(lstatSync(repeated.piConfigDir).mode & 0o777).toBe(0o700);
  });

  it("rejects a session root below a symbolic-link ancestor without creating it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-layout-parent-link-")));
    roots.push(root);
    const target = join(root, "target");
    const alias = join(root, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);

    expect(() => preparePiSessionLayout(join(alias, "session"))).toThrow(/symbolic|redirected/);
    expect(existsSync(join(target, "session"))).toBe(false);
  });

  it("rejects the filesystem root", () => {
    expect(() => preparePiSessionLayout("/")).toThrow(/filesystem root/);
  });

  it("rejects a redirected fixed directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-layout-link-")));
    roots.push(root);
    const sessionRoot = join(root, "session");
    const outside = join(root, "outside");
    mkdirSync(sessionRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(sessionRoot, "workspace"));
    expect(() => preparePiSessionLayout(sessionRoot)).toThrow(/real directory|escapes/);
  });
});

describe("Pi session resume authority", () => {
  it("initializes one exact native Pi v3 JSONL header and safely reuses it", () => {
    const layout = fixture();
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = ensurePiSessionFile(layout, sessionId);
    expect(path).toBe(join(layout.piSessionsDir, `${sessionId}.jsonl`));
    expect(ensurePiSessionFile(layout, sessionId)).toBe(path);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(resolvePiResumeFile(layout, path)).toBe(path);
  });

  it("accepts only an exact direct-child Pi v3 JSONL with matching cwd", () => {
    const layout = fixture();
    const path = join(layout.piSessionsDir, "conversation.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: new Date().toISOString(),
        cwd: layout.workspaceDir,
      })}\n`,
      { mode: 0o600 },
    );
    expect(resolvePiResumeFile(layout, path)).toBe(path);
  });

  it("rejects traversal, symlinks, old formats, and another cwd", () => {
    const layout = fixture();
    const outside = join(layout.sessionRoot, "outside.jsonl");
    writeFileSync(
      outside,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "outside",
        cwd: layout.workspaceDir,
      })}\n`,
    );
    expect(() => resolvePiResumeFile(layout, outside)).toThrow(/direct child/);

    const linked = join(layout.piSessionsDir, "linked.jsonl");
    symlinkSync(outside, linked);
    expect(() => resolvePiResumeFile(layout, linked)).toThrow();

    const old = join(layout.piSessionsDir, "old.jsonl");
    writeFileSync(
      old,
      `${JSON.stringify({ type: "session", version: 2, id: "old", cwd: layout.workspaceDir })}\n`,
    );
    expect(() => resolvePiResumeFile(layout, old)).toThrow(/v3/);

    const wrongCwd = join(layout.piSessionsDir, "wrong.jsonl");
    writeFileSync(
      wrongCwd,
      `${JSON.stringify({ type: "session", version: 3, id: "wrong", cwd: "/tmp/other" })}\n`,
    );
    expect(() => resolvePiResumeFile(layout, wrongCwd)).toThrow(/cwd/);
  });

  it("binds resume authority to an explicit canonical launch cwd", () => {
    const layout = fixture();
    const sharedWorkspace = join(layout.sessionRoot, "..", "shared-workspace");
    mkdirSync(sharedWorkspace);
    const canonicalWorkspace = realpathSync(sharedWorkspace);
    const path = join(layout.piSessionsDir, "shared.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "shared",
        cwd: canonicalWorkspace,
      })}\n`,
    );
    expect(resolvePiResumeFile(layout, path, canonicalWorkspace)).toBe(path);
    expect(() => resolvePiResumeFile(layout, path)).toThrow(/cwd/);
  });

  it("requires a strict LF-terminated session header", () => {
    const layout = fixture();
    const crlf = join(layout.piSessionsDir, "crlf.jsonl");
    const unterminated = join(layout.piSessionsDir, "unterminated.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "strict-lf",
      cwd: layout.workspaceDir,
    });
    writeFileSync(crlf, `${header}\r\n`);
    writeFileSync(unterminated, header);

    expect(() => resolvePiResumeFile(layout, crlf)).toThrow(/strict LF/);
    expect(() => resolvePiResumeFile(layout, unterminated)).toThrow(/end with LF/);
  });
});
