import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const script = join(repositoryRoot, "scripts", "pi-reset-legacy-sessions.sh");
const fixtures: string[] = [];

function fixture(): string {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-reset-")));
  const dataRoot = join(container, "data");
  mkdirSync(dataRoot);
  fixtures.push(container);
  return dataRoot;
}

function run(
  dataRoot: string,
  overrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dirnameForFixture(dataRoot), "home"),
    PIWORK_DATA_ROOT: dataRoot,
    CONFIRM_EXTERNAL_PI_DATA_ROOT: "1",
    PIWORK_RUNNER_LOCK_PATH: join(dirnameForFixture(dataRoot), "runner.lock"),
    PIWORK_MAINTENANCE_LOCK_DIR: join(dirnameForFixture(dataRoot), "maintenance.lock"),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return spawnSync("bash", [script], { cwd: repositoryRoot, env: environment, encoding: "utf8" });
}

function dirnameForFixture(path: string): string {
  return resolve(path, "..");
}

function writeSkill(
  root: string,
  name: string,
  content = "# Safe skill\n",
  source = "claude-config-source",
): string {
  const skill = join(root, source, "skills", name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), content);
  return skill;
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("pi-reset-legacy-sessions", () => {
  it("defaults to a mutation-free dry run", () => {
    const root = fixture();
    const user = join(root, "user-a");
    mkdirSync(join(user, "session-a", "workspace"), { recursive: true });
    writeFileSync(join(user, "session-a", "session.json"), "{}");
    writeSkill(user, "summarize");

    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode: DRY RUN");
    expect(result.stdout).toContain("Set CONFIRM_PI_SESSION_RESET=1 to apply");
    expect(existsSync(join(user, "session-a"))).toBe(true);
    expect(existsSync(join(user, "pi-resources"))).toBe(false);
    expect(existsSync(join(root, ".runtime", "runtime-layout.json"))).toBe(false);
  });

  it("requires the exact apply confirmation value", () => {
    const root = fixture();
    const session = join(root, "user-a", "session-a");
    mkdirSync(join(session, "workspace"), { recursive: true });

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "true" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mode: DRY RUN");
    expect(existsSync(session)).toBe(true);
  });

  it("migrates safe skills, resets local and tenant sessions, and preserves authority data", () => {
    const root = fixture();
    const user = join(root, "user-a");
    const tenant = join(root, "tenants", "tenant-a");
    const tenantUser = join(tenant, "users", "user-b");
    for (const directory of [
      "workspace",
      "home",
      "tmp",
      "pi-config",
      "pi-sessions",
      "recordings",
      "history",
      "checkouts",
      "user-space-checkouts",
      "claude-config",
    ]) {
      mkdirSync(join(user, "session-a", directory), { recursive: true });
    }
    writeFileSync(join(user, "session-a", "session.json"), "{}");
    mkdirSync(join(tenantUser, "sessions", "session-b", "home"), { recursive: true });
    mkdirSync(join(tenant, "knowledge", "shared"), { recursive: true });
    writeFileSync(join(tenant, "knowledge", "shared", "keep.txt"), "knowledge");
    writeFileSync(join(user, "profile.json"), '{"name":"Keep"}');
    writeFileSync(join(user, "preferences.json"), '{"language":"zh-CN"}');
    writeFileSync(join(root, "postgres.keep"), "external database marker");
    writeFileSync(join(root, "better-auth.keep"), "auth database marker");
    writeFileSync(join(root, "control-plane.keep"), "control plane database marker");
    writeFileSync(join(user, "launcher.json"), "{}");
    writeFileSync(join(user, "session-names.json"), "{}");
    const runtime = join(root, ".runtime");
    mkdirSync(runtime, { recursive: true });
    for (const artifact of [
      "runtime-layout.json",
      "sdk-bypass.key",
      "sdk-bypass.crt",
      ".sdk-bypass-ready",
      "ccrv2-bridge.json",
      "claude-config.json",
    ]) {
      writeFileSync(join(runtime, artifact), "{}");
    }
    writeSkill(user, "summarize", "# Summarize\n");
    writeSkill(user, "profile-skill", "# Profile skill\n", "profile/claude-config-source");
    writeFileSync(
      join(user, "workspace-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        updatedAt: new Date(0).toISOString(),
        data: {
          selectedAgentId: "agent",
          currentSessionId: "session-a",
          agentSessionIds: { agent: "session-a" },
          agentSessionHistoryIds: { agent: ["session-a"] },
          agentUserSpaces: { agent: [{ mountId: "m1", name: "Files" }] },
        },
      }),
    );

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(user, "session-a"))).toBe(false);
    expect(existsSync(join(tenantUser, "sessions"))).toBe(false);
    expect(existsSync(join(user, "launcher.json"))).toBe(false);
    expect(existsSync(join(user, "session-names.json"))).toBe(false);
    expect(
      readFileSync(join(user, "pi-resources", "skills", "summarize", "SKILL.md"), "utf8"),
    ).toBe("# Summarize\n");
    expect(
      readFileSync(join(user, "pi-resources", "skills", "profile-skill", "SKILL.md"), "utf8"),
    ).toBe("# Profile skill\n");
    expect(existsSync(join(user, "profile", "claude-config-source"))).toBe(false);
    expect(readFileSync(join(user, "profile.json"), "utf8")).toContain("Keep");
    expect(readFileSync(join(user, "preferences.json"), "utf8")).toContain("zh-CN");
    expect(readFileSync(join(tenant, "knowledge", "shared", "keep.txt"), "utf8")).toBe("knowledge");
    expect(readFileSync(join(root, "postgres.keep"), "utf8")).toBe("external database marker");
    expect(readFileSync(join(root, "better-auth.keep"), "utf8")).toBe("auth database marker");
    expect(readFileSync(join(root, "control-plane.keep"), "utf8")).toBe(
      "control plane database marker",
    );
    for (const artifact of [
      "sdk-bypass.key",
      "sdk-bypass.crt",
      ".sdk-bypass-ready",
      "ccrv2-bridge.json",
      "claude-config.json",
    ]) {
      expect(existsSync(join(runtime, artifact))).toBe(false);
    }

    const workspace = JSON.parse(readFileSync(join(user, "workspace-state.json"), "utf8"));
    expect(workspace.revision).toBe(4);
    expect(workspace.data.currentSessionId).toBeNull();
    expect(workspace.data.agentSessionIds).toEqual({});
    expect(workspace.data.agentSessionHistoryIds).toEqual({});
    expect(workspace.data.agentUserSpaces.agent[0].mountId).toBe("m1");

    const markerPath = join(root, ".runtime", "runtime-layout.json");
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
      format: "piwork-runtime-layout",
      version: 1,
      backend: "pi",
    });
    expect(lstatSync(markerPath).mode & 0o777).toBe(0o600);
  });

  it("rejects an unsafe skill before deleting any session", () => {
    const root = fixture();
    const user = join(root, "user-a");
    mkdirSync(join(user, "session-a", "workspace"), { recursive: true });
    const skill = writeSkill(user, "unsafe");
    writeFileSync(join(skill, ".env"), "TOKEN=do-not-copy");

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("forbidden secret material");
    expect(existsSync(join(user, "session-a"))).toBe(true);
    expect(existsSync(join(user, "pi-resources"))).toBe(false);
  });

  it("rejects a malformed workspace-state envelope before deleting any session", () => {
    const root = fixture();
    const user = join(root, "user-a");
    mkdirSync(join(user, "session-a", "workspace"), { recursive: true });
    writeFileSync(
      join(user, "workspace-state.json"),
      JSON.stringify({ schemaVersion: 1, revision: -1, data: {} }),
    );

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("malformed atomic JSON envelope");
    expect(existsSync(join(user, "session-a"))).toBe(true);
  });

  it("requires a separate confirmation for an external data root", () => {
    const root = fixture();
    const result = run(root, { CONFIRM_EXTERNAL_PI_DATA_ROOT: undefined });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CONFIRM_EXTERNAL_PI_DATA_ROOT=1");
  });

  it("refuses an active runner before mutation", () => {
    const root = fixture();
    const user = join(root, "user-a");
    mkdirSync(join(user, "session-a", "workspace"), { recursive: true });
    const runnerLock = join(dirnameForFixture(root), "runner.lock");
    writeFileSync(
      runnerLock,
      JSON.stringify({ pid: process.pid, heartbeatAt: Date.now(), hostName: "test" }),
    );
    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("active Piwork runner lock");
    expect(existsSync(join(user, "session-a"))).toBe(true);
  });

  it("refuses an active runtime PID before mutation", () => {
    const root = fixture();
    const session = join(root, "user-a", "session-a");
    mkdirSync(join(session, "workspace"), { recursive: true });
    mkdirSync(join(root, ".runtime"), { recursive: true });
    writeFileSync(join(root, ".runtime", "server.pid"), `${process.pid}\n`);

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Active Piwork runtime process");
    expect(existsSync(session)).toBe(true);
  });

  it("refuses symbolic-link ancestors before migration or deletion", () => {
    const root = fixture();
    const user = join(root, "user-a");
    const victim = join(root, "user-b", "profile");
    const session = join(user, "session-a");
    mkdirSync(join(session, "workspace"), { recursive: true });
    mkdirSync(join(victim, "claude-config-source"), { recursive: true });
    writeFileSync(join(victim, "claude-config-source", "keep.txt"), "keep");
    mkdirSync(user, { recursive: true });
    symlinkSync(victim, join(user, "profile"));

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic link");
    expect(existsSync(session)).toBe(true);
    expect(readFileSync(join(victim, "claude-config-source", "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a symlinked managed Skills destination before mutation", () => {
    const root = fixture();
    const user = join(root, "user-a");
    const outside = join(root, "user-b", "managed-target");
    const session = join(user, "session-a");
    mkdirSync(join(session, "workspace"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(user, "pi-resources"), { recursive: true });
    writeSkill(user, "summarize");
    symlinkSync(outside, join(user, "pi-resources", "skills"));

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("symbolic");
    expect(existsSync(session)).toBe(true);
    expect(existsSync(join(outside, "summarize"))).toBe(false);
  });

  it("refuses an unsafe legacy session name before mutation", () => {
    const root = fixture();
    const unsafeSession = join(root, "user-a", ".legacy-session");
    mkdirSync(join(unsafeSession, "workspace"), { recursive: true });

    const result = run(root, { CONFIRM_PI_SESSION_RESET: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsafe legacy session directory name");
    expect(existsSync(unsafeSession)).toBe(true);
  });

  it("refuses a symbolic-link data root", () => {
    const parent = fixture();
    const target = join(parent, "target");
    const alias = join(parent, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);
    const result = run(alias, { CONFIRM_PI_SESSION_RESET: "1" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not traverse symbolic-link aliases");
  });

  it("refuses an absent data root below a symbolic-link ancestor", () => {
    const parent = fixture();
    const target = join(parent, "target");
    const alias = join(parent, "alias");
    mkdirSync(target);
    symlinkSync(target, alias);
    const result = run(join(alias, "new-data"), { CONFIRM_PI_SESSION_RESET: "1" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not traverse symbolic-link aliases");
    expect(existsSync(join(target, "new-data"))).toBe(false);
  });
});
