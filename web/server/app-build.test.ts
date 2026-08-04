import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_ASSET_FILE_LIMIT_BYTES,
  APP_BUILD_COMMAND,
  collectAppBuildArtifact,
  inspectAppSource,
  resolveAppSourceRoot,
} from "./app-build.js";

const roots: string[] = [];

async function fixture(): Promise<{ workspace: string; source: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "piwork-app-build-"));
  roots.push(workspace);
  const source = join(workspace, "demo");
  await mkdir(join(source, "build/server/assets"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ scripts: { build: "vite build" } }),
  );
  await writeFile(join(source, "bun.lock"), "lockfileVersion = 1\n");
  await writeFile(
    join(source, "piwork.app.json"),
    JSON.stringify({
      version: 1,
      runtime: "cloudflare-workers",
      exposure: { workersDev: true },
    }),
  );
  await writeFile(
    join(source, "build/server/wrangler.json"),
    JSON.stringify({
      main: "worker.js",
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js"] }],
      assets: { directory: "assets" },
    }),
  );
  await writeFile(
    join(source, "build/server/worker.js"),
    "export default { fetch() { return new Response('ok') } };",
  );
  await writeFile(join(source, "build/server/helper.js"), "export const value = 1;");
  await writeFile(join(source, "build/server/assets/index.html"), "<h1>ok</h1>");
  return { workspace, source };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("App build contract", () => {
  it("pins the SRT build command", () => {
    expect(APP_BUILD_COMMAND).toBe("bun install --frozen-lockfile && bun run build");
  });

  it("collects declared modules and assets with deterministic digests", async () => {
    const { workspace } = await fixture();
    const artifact = await collectAppBuildArtifact(workspace, "demo");
    expect(artifact.mainModule).toBe("worker.js");
    expect(artifact.modules.map((module) => module.name)).toEqual(["helper.js", "worker.js"]);
    expect(artifact.assets.map((asset) => asset.path)).toEqual(["/index.html"]);
    expect(artifact.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.artifactDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects paths and symbolic links that escape Agent Space", async () => {
    const { workspace, source } = await fixture();
    await expect(resolveAppSourceRoot(workspace, "../outside")).rejects.toThrow("escapes");
    await symlink("/tmp", join(source, "escape"));
    await expect(inspectAppSource(workspace, "demo")).rejects.toThrow("Symbolic links");
  });

  it("rejects platform-controlled bindings", async () => {
    const { workspace, source } = await fixture();
    await writeFile(
      join(source, "build/server/wrangler.json"),
      JSON.stringify({ main: "worker.js", vars: { SECRET: "leak" } }),
    );
    await expect(collectAppBuildArtifact(workspace, "demo")).rejects.toThrow("platform-controlled");
  });

  it("reports over-limit assets as structured warnings", async () => {
    const { workspace, source } = await fixture();
    await writeFile(
      join(source, "build/server/assets/large.bin"),
      new Uint8Array(APP_ASSET_FILE_LIMIT_BYTES + 1),
    );
    const artifact = await collectAppBuildArtifact(workspace, "demo");
    expect(artifact.warnings).toEqual([
      expect.objectContaining({ code: "asset_too_large", path: "/large.bin" }),
    ]);
    expect(artifact.assets.some((asset) => asset.path === "/large.bin")).toBe(false);
  });

  it("requires declared Durable Object classes to be exported", async () => {
    const { workspace, source } = await fixture();
    await writeFile(
      join(source, "piwork.app.json"),
      JSON.stringify({
        version: 1,
        runtime: "cloudflare-workers",
        resources: {
          durableObjects: [
            { binding: "COUNTER", className: "Counter", storage: "sqlite", state: "created" },
          ],
        },
        exposure: { workersDev: true },
      }),
    );
    await expect(collectAppBuildArtifact(workspace, "demo")).rejects.toThrow(
      "does not export Durable Object class",
    );
  });
});
