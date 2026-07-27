import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSupportedNodeVersion,
  buildPiRpcArgs,
  PINNED_PI_PACKAGE,
  PINNED_PI_VERSION,
  resolvePinnedPiRuntime,
} from "./pi-runtime-resolver.js";

const roots: string[] = [];
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function piFixture(version = PINNED_PI_VERSION) {
  const root = mkdtempSync(join(tmpdir(), "piwork-pi-runtime-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const entryPath = join(packageRoot, "dist", "rpc-entry.js");
  const nodePath = join(root, "node");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(entryPath, "export {};\n");
  writeFileSync(nodePath, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: PINNED_PI_PACKAGE,
      version,
      engines: { node: ">=22.19.0" },
      exports: { "./rpc-entry": { import: "./dist/rpc-entry.js" } },
    }),
  );
  return { root, packageRoot, entryPath, nodePath };
}

describe("Pi runtime resolution", () => {
  it("accepts the minimum Node release and rejects an older runtime", () => {
    expect(() => assertSupportedNodeVersion("22.19.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.14.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("22.18.9")).toThrow(/>=22.19.0/);
  });

  it("pins rpc-entry to the exact package identity, version, and export", () => {
    const fixture = piFixture();
    const runtime = resolvePinnedPiRuntime(
      () => pathToFileURL(fixture.entryPath).href,
      fixture.nodePath,
    );
    expect(runtime).toEqual({
      entryPath: realpathSync(fixture.entryPath),
      packageRoot: realpathSync(fixture.packageRoot),
      packageName: PINNED_PI_PACKAGE,
      version: PINNED_PI_VERSION,
      nodePath: realpathSync(fixture.nodePath),
    });
  });

  it("rejects a fork or wrong Pi version", () => {
    const wrongVersion = piFixture("0.82.2");
    expect(() =>
      resolvePinnedPiRuntime(
        () => pathToFileURL(wrongVersion.entryPath).href,
        wrongVersion.nodePath,
      ),
    ).toThrow(/0.82.1 is required/);

    const fork = piFixture();
    writeFileSync(
      join(fork.packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/pi-fork",
        version: PINNED_PI_VERSION,
        engines: { node: ">=22.19.0" },
        exports: { "./rpc-entry": "./dist/rpc-entry.js" },
      }),
    );
    expect(() =>
      resolvePinnedPiRuntime(() => pathToFileURL(fork.entryPath).href, fork.nodePath),
    ).toThrow(/not owned by/);
  });

  it("rejects a redirected package manifest", () => {
    const fixture = piFixture();
    const manifest = join(fixture.packageRoot, "package.json");
    const outside = join(fixture.root, "outside.json");
    writeFileSync(outside, "{}");
    rmSync(manifest);
    symlinkSync(outside, manifest);
    expect(() =>
      resolvePinnedPiRuntime(() => pathToFileURL(fixture.entryPath).href, fixture.nodePath),
    ).toThrow();
  });
});

describe("Pi rpc-entry arguments", () => {
  it("disables every discovery surface and explicitly loads only managed resources", () => {
    const args = buildPiRpcArgs({
      sessionId: SESSION_ID,
      generation: 7,
      sessionDir: "/session/pi-sessions",
      trustedExtensionPath: "/runtime/piwork-extension.ts",
      managedSkillPaths: ["/session/pi-resources/skills/user-space/SKILL.md"],
      bootstrapSocketPath: "/tmp/piwork-pi/bootstrap.sock",
      resumeSessionFile: "/session/pi-sessions/exact.jsonl",
      model: { provider: "openai", modelId: "gpt-5.6" },
      thinkingLevel: "xhigh",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--no-builtin-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-approve",
        "--no-context-files",
        "--extension",
        "/runtime/piwork-extension.ts",
        "--skill",
        "/session/pi-resources/skills/user-space/SKILL.md",
        "--session",
        "/session/pi-sessions/exact.jsonl",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/api[_-]?key|token|secret|password/i);
  });

  it("binds a new native Pi conversation to the product session id", () => {
    const args = buildPiRpcArgs({
      sessionId: SESSION_ID,
      generation: 1,
      sessionDir: "/session/pi-sessions",
      trustedExtensionPath: "/runtime/piwork-extension.ts",
      managedSkillPaths: [],
      bootstrapSocketPath: "/tmp/piwork-pi/bootstrap.sock",
    });
    expect(args).toEqual(expect.arrayContaining(["--session-id", SESSION_ID]));
    expect(args).not.toContain("--session");
  });

  it("rejects relative resources and malformed authority", () => {
    expect(() =>
      buildPiRpcArgs({
        sessionId: SESSION_ID,
        generation: 1,
        sessionDir: "relative",
        trustedExtensionPath: "/runtime/extension.ts",
        managedSkillPaths: [],
        bootstrapSocketPath: "/tmp/bootstrap.sock",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      buildPiRpcArgs({
        sessionId: "../other",
        generation: 1,
        sessionDir: "/sessions",
        trustedExtensionPath: "/runtime/extension.ts",
        managedSkillPaths: [],
        bootstrapSocketPath: "/tmp/bootstrap.sock",
      }),
    ).toThrow(/session id/);
  });
});
