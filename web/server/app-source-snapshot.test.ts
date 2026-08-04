import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppSourceSnapshot, restoreAppSourceSnapshot } from "./app-source-snapshot.js";

const roots: string[] = [];

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("App source snapshots", () => {
  it("creates immutable creator-only source snapshots and restores them", async () => {
    const creatorRoot = await root("piwork-app-owner-");
    const sourceRoot = await root("piwork-app-source-");
    const workspaceRoot = await root("piwork-app-restore-");
    await mkdir(join(sourceRoot, "src"));
    await writeFile(join(sourceRoot, "src/index.ts"), "export default 1;");
    await mkdir(join(sourceRoot, "node_modules"));
    await writeFile(join(sourceRoot, "node_modules/ignored.js"), "ignored");

    const snapshot = await createAppSourceSnapshot({
      creatorRoot,
      appId: "app-1",
      deploymentId: "deployment-1",
      sourceRoot,
    });
    expect(snapshot.fileCount).toBe(1);
    const repeated = await createAppSourceSnapshot({
      creatorRoot,
      appId: "app-1",
      deploymentId: "deployment-1",
      sourceRoot,
      expectedDigest: snapshot.digest,
    });
    expect(repeated).toEqual(snapshot);

    await restoreAppSourceSnapshot({
      creatorRoot,
      snapshotKey: snapshot.key,
      workspaceRoot,
      expectedDigest: snapshot.digest,
    });
    expect(await readFile(join(workspaceRoot, "src/index.ts"), "utf8")).toBe("export default 1;");
    await expect(
      readFile(join(workspaceRoot, "node_modules/ignored.js"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects symlinks and path traversal", async () => {
    const creatorRoot = await root("piwork-app-owner-");
    const sourceRoot = await root("piwork-app-source-");
    await symlink("/tmp", join(sourceRoot, "escape"));
    await expect(
      createAppSourceSnapshot({
        creatorRoot,
        appId: "app-1",
        deploymentId: "deployment-1",
        sourceRoot,
      }),
    ).rejects.toThrow("symbolic links");
    await expect(
      restoreAppSourceSnapshot({
        creatorRoot,
        snapshotKey: "../other",
        workspaceRoot: sourceRoot,
      }),
    ).rejects.toThrow("invalid");
  });
});
