import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileSrtPolicy, deriveTaskSrtPolicy } from "./srt-policy.js";

function fixture() {
  const tenantsRoot = mkdtempSync(join(tmpdir(), "piwork-srt-"));
  const tenantRoot = join(tenantsRoot, "t1");
  const sessionRoot = join(tenantRoot, "users/u1/sessions/s1");
  const paths = {
    tenantsRoot,
    tenantRoot,
    sessionRoot,
    workspaceDir: join(sessionRoot, "workspace"),
    homeDir: join(sessionRoot, "home"),
    tmpDir: join(sessionRoot, "tmp"),
    piConfigDir: join(sessionRoot, "pi-config", "runtime"),
    piSessionsDir: join(sessionRoot, "pi-sessions"),
    managedReadPaths: [join(sessionRoot, "pi-config", "piwork-resources", "skills")],
    knowledgeDirs: [join(tenantRoot, "knowledge/k1")],
    deniedSessionDirs: [join(sessionRoot, "user-space-checkouts")],
  };
  for (const path of Object.values(paths).flat()) mkdirSync(path, { recursive: true });
  return paths;
}

describe("SRT policy compiler", () => {
  it("only writes session paths, reads approved knowledge and intersects domains", () => {
    const paths = fixture();
    const runtimeBinary = join(paths.tenantsRoot, "runtime-bin");
    const unixSocketPath = join(paths.tenantsRoot, "user-space.sock");
    writeFileSync(runtimeBinary, "runtime");
    const policy = compileSrtPolicy({
      ...paths,
      runtimeReadPaths: [runtimeBinary],
      unixSocketPaths: [unixSocketPath],
      requiredInternalDomains: ["127.0.0.1"],
      domainLayers: [
        { allowedDomains: ["api.example.com", "github.com"], deniedDomains: [] },
        { allowedDomains: ["api.example.com", "blocked.example"], deniedDomains: ["github.com"] },
      ],
    });
    const knowledge = realpathSync(paths.knowledgeDirs[0]);
    expect(policy.filesystem.allowRead).toContain(knowledge);
    expect(policy.filesystem.allowRead).not.toContain(realpathSync(paths.sessionRoot));
    expect(policy.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        realpathSync(paths.workspaceDir),
        realpathSync(paths.homeDir),
        realpathSync(paths.tmpDir),
        realpathSync(paths.piConfigDir),
        realpathSync(paths.piSessionsDir),
      ]),
    );
    expect(policy.filesystem.allowRead).toContain(realpathSync(paths.managedReadPaths[0]));
    expect(policy.filesystem.allowWrite).not.toContain(realpathSync(paths.managedReadPaths[0]));
    expect(policy.filesystem.allowWrite).not.toContain(knowledge);
    expect(policy.filesystem.allowRead).toContain(realpathSync(runtimeBinary));
    expect(policy.filesystem.denyWrite).toContain(knowledge);
    expect(policy.filesystem.denyRead).toContain(realpathSync(paths.deniedSessionDirs[0]));
    expect(policy.filesystem.denyWrite).toContain(realpathSync(paths.deniedSessionDirs[0]));
    expect(policy.filesystem.allowGitConfig).toBe(false);
    const fixtureTopLevel = `/${realpathSync(paths.tenantsRoot).split("/").filter(Boolean)[0]}`;
    expect(policy.filesystem.denyRead).toContain(fixtureTopLevel);
    expect(policy.filesystem.allowRead).not.toEqual(
      expect.arrayContaining(["/etc", "/opt", "/srv", "/var", "/usr/local", "/System"]),
    );
    if (existsSync("/usr/bin")) {
      expect(policy.filesystem.allowRead).toContain(realpathSync("/usr/bin"));
    }
    if (process.platform === "linux") {
      for (const systemAlias of ["/bin", "/sbin", "/lib", "/lib64"].filter(existsSync)) {
        // usr-merged systems need both the alias and its target restored no
        // matter which top-level deny SRT mounts first.
        expect(policy.filesystem.allowRead).toContain(systemAlias);
        expect(policy.filesystem.allowRead).toContain(realpathSync(systemAlias));
      }
    }
    if (process.platform === "darwin") expect(policy.filesystem.denyRead).toContain("/Users");
    if (process.platform === "linux") expect(policy.filesystem.denyRead).toContain("/home");
    expect(policy.network.allowedDomains).toEqual(["127.0.0.1", "api.example.com"]);
    expect(policy.network.deniedDomains).toEqual(["github.com"]);
    expect(policy.network.allowUnixSockets).toEqual([
      join(realpathSync(paths.tenantsRoot), "user-space.sock"),
    ]);
  });

  it("enables nested SRT only for the explicit Compose execution mode", () => {
    const paths = fixture();
    const native = compileSrtPolicy({
      ...paths,
      requiredInternalDomains: [],
      domainLayers: [],
    });
    const nested = compileSrtPolicy({
      ...paths,
      requiredInternalDomains: [],
      domainLayers: [],
      executionMode: "compose-nested",
    });
    expect(native.enableWeakerNestedSandbox).toBe(false);
    expect(nested.enableWeakerNestedSandbox).toBe(true);
  });

  it("rejects a knowledge path from another tenant", () => {
    const paths = fixture();
    const other = join(paths.tenantsRoot, "t2/knowledge/k2");
    mkdirSync(other, { recursive: true });
    expect(() =>
      compileSrtPolicy({
        ...paths,
        knowledgeDirs: [other],
        requiredInternalDomains: [],
        domainLayers: [],
      }),
    ).toThrow("escapes");
  });

  it("rejects a private path nested below an allowed read subtree", () => {
    const paths = fixture();
    const nestedPrivate = join(paths.workspaceDir, "private-staging");
    mkdirSync(nestedPrivate, { recursive: true });
    expect(() =>
      compileSrtPolicy({
        ...paths,
        deniedSessionDirs: [nestedPrivate],
        requiredInternalDomains: [],
        domainLayers: [],
      }),
    ).toThrow(/must not overlap/);
  });

  it("rejects managed resources that overlap writable Pi state", () => {
    const paths = fixture();
    const overlapping = join(paths.piConfigDir, "skills");
    mkdirSync(overlapping, { recursive: true });
    expect(() =>
      compileSrtPolicy({
        ...paths,
        managedReadPaths: [overlapping],
        requiredInternalDomains: [],
        domainLayers: [],
      }),
    ).toThrow(/managed read-only/);
  });

  it("rejects runtime directory grants that would reopen tenant data", () => {
    const paths = fixture();

    expect(() =>
      compileSrtPolicy({
        ...paths,
        runtimeReadPaths: [paths.tenantRoot],
        requiredInternalDomains: [],
        domainLayers: [],
      }),
    ).toThrow(/runtime read directory must not overlap tenant data/);
  });

  it("rejects a tenant-controlled Unix socket", () => {
    const paths = fixture();

    expect(() =>
      compileSrtPolicy({
        ...paths,
        unixSocketPaths: [join(paths.workspaceDir, "attacker.sock")],
        requiredInternalDomains: [],
        domainLayers: [],
      }),
    ).toThrow(/outside tenant-controlled data/);
  });

  it.skipIf(
    process.platform !== "darwin" ||
      !existsSync(fileURLToPath(new URL("../node_modules/.bin/srt", import.meta.url))),
  )(
    "forwards an anonymous stdin FD through the pinned SRT with exact bytes and EOF",
    () => {
      const root = mkdtempSync(join(tmpdir(), "piwork-srt-stdin-"));
      const settingsPath = join(root, "settings.json");
      const srtBinary = fileURLToPath(new URL("../node_modules/.bin/srt", import.meta.url));
      const token = "operator-oauth-canary";
      writeFileSync(
        settingsPath,
        JSON.stringify({
          network: {
            allowedDomains: [],
            deniedDomains: [],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
          },
          filesystem: {
            denyRead: [],
            allowRead: [],
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: false,
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
        }),
        { mode: 0o600 },
      );

      try {
        const canary = spawnSync(
          "bun",
          [
            "-e",
            `const [srt, settings, root] = process.argv.slice(1);
           const token = ${JSON.stringify(token)};
           const proc = Bun.spawn([srt, "--settings", settings, "/usr/bin/wc"], {
             cwd: root,
             env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C" },
             stdin: new Blob([token]), stdout: "pipe", stderr: "pipe"
           });
           const [stdout, stderr, exitCode] = await Promise.all([
             new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
           ]);
           console.log(JSON.stringify({ stdout, stderr, exitCode }));
           process.exit(exitCode);`,
            srtBinary,
            settingsPath,
            root,
          ],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
        );
        const result = JSON.parse(canary.stdout || "{}") as {
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };

        expect(canary.status, canary.stderr || result.stderr).toBe(0);
        expect(result.exitCode, result.stderr).toBe(0);
        const counts = String(result.stdout).trim().split(/\s+/).map(Number);
        expect(counts).toEqual([0, 1, Buffer.byteLength(token, "utf8")]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

describe("task SRT policy derivation", () => {
  function taskFixture(readOnlyWorkspace: boolean) {
    const paths = fixture();
    const browserControl = join(paths.sessionRoot, ".browser-control.json");
    const runtimeBinary = join(paths.tenantsRoot, "runtime-bin");
    const unixSocketPath = join(paths.tenantsRoot, "managed.sock");
    writeFileSync(browserControl, "{}\n");
    writeFileSync(runtimeBinary, "runtime");
    const parent = compileSrtPolicy({
      ...paths,
      managedReadPaths: [...paths.managedReadPaths, browserControl],
      runtimeReadPaths: [runtimeBinary],
      unixSocketPaths: [unixSocketPath],
      requiredInternalDomains: [],
      domainLayers: [
        {
          allowedDomains: ["models.example.test"],
          deniedDomains: ["blocked.example.test"],
        },
      ],
    });
    const childSessionRoot = join(paths.tmpDir, "pi-tasks", "task-1");
    const child = {
      childSessionRoot,
      childHomeDir: join(childSessionRoot, "home"),
      childTmpDir: join(childSessionRoot, "tmp"),
      childPiRuntimeConfigDir: join(childSessionRoot, "pi-config", "runtime"),
      childPiSessionsDir: join(childSessionRoot, "pi-sessions"),
      childDeniedSessionDirs: [
        join(childSessionRoot, "recordings"),
        join(childSessionRoot, "user-space-checkouts"),
      ],
    };
    for (const path of [
      child.childSessionRoot,
      join(child.childSessionRoot, "workspace"),
      child.childHomeDir,
      child.childTmpDir,
      child.childPiRuntimeConfigDir,
      child.childPiSessionsDir,
      ...child.childDeniedSessionDirs,
    ]) {
      mkdirSync(path, { recursive: true });
    }
    const policy = deriveTaskSrtPolicy({
      parent,
      rootSessionRoot: paths.sessionRoot,
      sharedWorkspaceDir: paths.workspaceDir,
      sharedReadOnlyPaths: [...paths.managedReadPaths, browserControl],
      ...child,
      readOnlyWorkspace,
    });
    return {
      paths,
      parent,
      policy,
      child,
      browserControl: realpathSync(browserControl),
      runtimeBinary: realpathSync(runtimeBinary),
    };
  }

  it("keeps only shared Agent Space, exact resources, and private child state", () => {
    const { paths, parent, policy, child, browserControl, runtimeBinary } = taskFixture(false);
    const filesystemPaths = [
      ...(policy.filesystem.allowRead || []),
      ...(policy.filesystem.allowWrite || []),
      ...(policy.filesystem.denyRead || []),
      ...(policy.filesystem.denyWrite || []),
    ];
    for (const parentPrivate of [
      paths.homeDir,
      paths.tmpDir,
      paths.piConfigDir,
      paths.piSessionsDir,
      ...paths.deniedSessionDirs,
    ]) {
      expect(filesystemPaths).not.toContain(realpathSync(parentPrivate));
    }
    expect(policy.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        realpathSync(paths.workspaceDir),
        realpathSync(paths.managedReadPaths[0]),
        browserControl,
        runtimeBinary,
        realpathSync(paths.knowledgeDirs[0]),
        realpathSync(child.childHomeDir),
        realpathSync(child.childTmpDir),
        realpathSync(child.childPiRuntimeConfigDir),
        realpathSync(child.childPiSessionsDir),
      ]),
    );
    expect(policy.filesystem.allowWrite).toEqual(
      expect.arrayContaining([
        realpathSync(paths.workspaceDir),
        realpathSync(child.childHomeDir),
        realpathSync(child.childTmpDir),
        realpathSync(child.childPiRuntimeConfigDir),
        realpathSync(child.childPiSessionsDir),
      ]),
    );
    expect(policy.filesystem.allowWrite).not.toContain(realpathSync(paths.managedReadPaths[0]));
    expect(policy.filesystem.allowRead).not.toContain(
      realpathSync(join(child.childSessionRoot, "workspace")),
    );
    expect(policy.filesystem.denyRead).toEqual(
      expect.arrayContaining(child.childDeniedSessionDirs.map((path) => realpathSync(path))),
    );
    expect(policy.network).toEqual(parent.network);
  });

  it("makes shared Agent Space read-only in Plan and rejects widened parent grants", () => {
    const { paths, parent, child, browserControl } = taskFixture(true);
    const policy = deriveTaskSrtPolicy({
      parent,
      rootSessionRoot: paths.sessionRoot,
      sharedWorkspaceDir: paths.workspaceDir,
      sharedReadOnlyPaths: [...paths.managedReadPaths, browserControl],
      ...child,
      readOnlyWorkspace: true,
    });
    expect(policy.filesystem.allowWrite).not.toContain(realpathSync(paths.workspaceDir));
    expect(policy.filesystem.denyWrite).toContain(realpathSync(paths.workspaceDir));

    const externalWrite = join(paths.tenantsRoot, "outside-write");
    mkdirSync(externalWrite);
    expect(() =>
      deriveTaskSrtPolicy({
        parent: {
          ...parent,
          filesystem: {
            ...parent.filesystem,
            allowWrite: [...parent.filesystem.allowWrite, externalWrite],
          },
        },
        rootSessionRoot: paths.sessionRoot,
        sharedWorkspaceDir: paths.workspaceDir,
        sharedReadOnlyPaths: paths.managedReadPaths,
        ...child,
        readOnlyWorkspace: true,
      }),
    ).toThrow(/write grant escapes/);

    expect(() =>
      deriveTaskSrtPolicy({
        parent: {
          ...parent,
          filesystem: {
            ...parent.filesystem,
            allowWrite: [...parent.filesystem.allowWrite, realpathSync(paths.managedReadPaths[0])],
          },
        },
        rootSessionRoot: paths.sessionRoot,
        sharedWorkspaceDir: paths.workspaceDir,
        sharedReadOnlyPaths: paths.managedReadPaths,
        ...child,
        readOnlyWorkspace: true,
      }),
    ).toThrow(/resource overlaps/);
  });
});
