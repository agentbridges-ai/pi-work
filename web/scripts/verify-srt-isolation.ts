import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveBinary } from "../server/path-resolver.js";
import { compileSrtPolicy } from "../server/srt-policy.js";

interface CanaryPaths {
  settings: string;
  writable: string;
  knowledge: string;
  forbidden: string;
}

function value(args: readonly string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const result = index >= 0 ? args[index + 1] : "";
  if (!result) throw new Error(`--${name} is required`);
  return resolve(result);
}

function explicitCanaryPaths(args: readonly string[]): CanaryPaths {
  return {
    settings: value(args, "settings"),
    writable: value(args, "writable"),
    knowledge: value(args, "knowledge"),
    forbidden: value(args, "forbidden"),
  };
}

function selfTestFixture(): { paths: CanaryPaths; dispose(): void } {
  // macOS exposes its temporary directory through /var, which resolves to
  // /private/var. Sandbox rules match physical paths, so build the fixture and
  // settings from the canonical root instead of the symlinked spelling.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-srt-isolation-")));
  const tenantsRoot = join(root, "tenants");
  const tenantRoot = join(tenantsRoot, "tenant");
  const sessionRoot = join(tenantRoot, "sessions", "current");
  const writable = join(sessionRoot, "workspace");
  const homeDir = join(sessionRoot, "home");
  const tmpDir = join(sessionRoot, "tmp");
  const piConfigDir = join(sessionRoot, "pi-config");
  const piSessionsDir = join(sessionRoot, "pi-sessions");
  const privateDir = join(sessionRoot, "user-space-checkouts");
  const knowledge = join(tenantRoot, "knowledge", "shared");
  const forbidden = join(tenantRoot, "sessions", "neighbor", "workspace");
  const settings = join(tmpDir, "srt-settings.json");
  for (const path of [
    writable,
    homeDir,
    tmpDir,
    piConfigDir,
    piSessionsDir,
    privateDir,
    knowledge,
    forbidden,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(knowledge, "readable.txt"), "knowledge\n", { mode: 0o600 });
  writeFileSync(join(forbidden, "private.txt"), "private\n", { mode: 0o600 });
  const srtBinary = resolveBinary("srt");
  if (!srtBinary) throw new Error("Pinned repo-local SRT executable was not found.");
  const srtPackageRoot = dirname(dirname(realpathSync(srtBinary)));
  writeFileSync(
    settings,
    JSON.stringify(
      compileSrtPolicy({
        tenantsRoot,
        tenantRoot,
        sessionRoot,
        workspaceDir: writable,
        homeDir,
        tmpDir,
        piConfigDir,
        piSessionsDir,
        deniedSessionDirs: [privateDir],
        knowledgeDirs: [knowledge],
        runtimeReadPaths: [srtPackageRoot],
        requiredInternalDomains: [],
        domainLayers: [],
      } as unknown as Parameters<typeof compileSrtPolicy>[0]),
    ),
    { mode: 0o600 },
  );
  return {
    paths: { settings, writable, knowledge, forbidden },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function systemCanaryBinary(name: "test" | "touch"): string {
  const path = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
  if (!path) throw new Error(`Required system canary executable was not found: ${name}`);
  return path;
}

export function runSrtIsolationCanary(paths: CanaryPaths): void {
  const { settings, writable, knowledge, forbidden } = paths;
  if (![settings, writable, knowledge, forbidden].every(existsSync)) {
    throw new Error("Canary paths must already exist.");
  }
  const srtBinary = resolveBinary("srt");
  if (!srtBinary) throw new Error("Pinned repo-local SRT executable was not found.");
  const executable = srtBinary;
  const testBinary = systemCanaryBinary("test");
  const touchBinary = systemCanaryBinary("touch");

  function srt(command: string, args: string[]): { ok: boolean; output: string } {
    try {
      return {
        ok: true,
        output: execFileSync(executable, ["--settings", settings, command, ...args], {
          cwd: writable,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            TERM: "dumb",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  const writableProbe = resolve(writable, `.piwork-srt-write-canary-${randomUUID()}`);
  const knowledgeProbe = resolve(knowledge, `.piwork-srt-write-canary-${randomUUID()}`);
  try {
    const workspaceRead = srt(testBinary, ["-r", writable]);
    const workspaceWrite = srt(touchBinary, [writableProbe]);
    const knowledgeRead = srt(testBinary, ["-r", knowledge]);
    const knowledgeWrite = srt(touchBinary, [knowledgeProbe]);
    const forbiddenRead = srt(testBinary, ["-r", forbidden]);
    const checks = [
      ["workspace read", workspaceRead.ok, workspaceRead.output],
      ["workspace write", workspaceWrite.ok && existsSync(writableProbe), workspaceWrite.output],
      ["knowledge read", knowledgeRead.ok, knowledgeRead.output],
      ["knowledge write denied", !knowledgeWrite.ok, knowledgeWrite.output],
      ["neighbor read denied", !forbiddenRead.ok, forbiddenRead.output],
    ] as const;
    const failed = checks.filter(([, ok]) => !ok).map(([name, , output]) => `${name}: ${output}`);
    if (failed.length) throw new Error(`SRT canary failed:\n${failed.join("\n")}`);
  } finally {
    rmSync(writableProbe, { force: true });
    rmSync(knowledgeProbe, { force: true });
  }
  console.log(
    "[srt-canary] workspace write, knowledge readonly, and cross-session deny checks passed",
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fixture = args.includes("--self-test") ? selfTestFixture() : null;
  try {
    runSrtIsolationCanary(fixture?.paths || explicitCanaryPaths(args));
  } finally {
    fixture?.dispose();
  }
}
