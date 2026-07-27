import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PiAgentSpace } from "./pi-agent-space.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-agent-space-"));
  roots.push(root);
  const writable = join(root, "workspace");
  const readonly = join(root, "knowledge");
  const outside = join(root, "private");
  await Promise.all([mkdir(writable), mkdir(readonly), mkdir(outside)]);
  const space = await PiAgentSpace.create([
    { path: writable, access: "write" },
    { path: readonly, access: "read" },
  ]);
  return { root, writable, readonly, outside, space };
}

describe("Pi Agent Space operations", () => {
  it("reads and writes only authorized ordinary files", async () => {
    const { writable, readonly, space } = await fixture();
    await writeFile(join(readonly, "reference.txt"), "reference");
    await expect(space.readOperations.readFile(join(readonly, "reference.txt"))).resolves.toEqual(
      Buffer.from("reference"),
    );
    await space.writeOperations.mkdir(join(writable, "nested"));
    await space.writeOperations.writeFile(join(writable, "nested", "result.txt"), "result\r\n");
    await expect(readFile(join(writable, "nested", "result.txt"), "utf8")).resolves.toBe(
      "result\r\n",
    );
  });

  it("rejects writes to read-only roots and all access outside authority", async () => {
    const { readonly, outside, space } = await fixture();
    await expect(
      space.writeOperations.writeFile(join(readonly, "no.txt"), "no"),
    ).rejects.toMatchObject({ code: "read_only" });
    await expect(space.readOperations.readFile(join(outside, "secret.txt"))).rejects.toMatchObject({
      code: "outside_authority",
    });
  });

  it("rejects symlink roots, parents, and leaf files", async () => {
    const { root, writable, outside, space } = await fixture();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(writable, "linked-dir"));
    await expect(
      space.readOperations.readFile(join(writable, "linked-dir", "secret.txt")),
    ).rejects.toMatchObject({ code: "symlink_forbidden" });
    await symlink(join(outside, "secret.txt"), join(writable, "linked-file"));
    await expect(
      space.writeOperations.writeFile(join(writable, "linked-file"), "replace"),
    ).rejects.toMatchObject({ code: "symlink_forbidden" });
    await symlink(writable, join(root, "root-link"));
    await expect(
      PiAgentSpace.create([{ path: join(root, "root-link"), access: "write" }]),
    ).rejects.toMatchObject({ code: "symlink_forbidden" });
  });

  it("provides the same operation object shape expected by native Pi factories", async () => {
    const { writable, space } = await fixture();
    const file = join(writable, "bom.txt");
    await space.writeOperations.writeFile(file, "\ufeffa\r\nb\r\n");
    await space.editOperations.access(file);
    const original = await space.editOperations.readFile(file);
    expect(original.toString("utf8")).toBe("\ufeffa\r\nb\r\n");
    await space.editOperations.writeFile(file, "\ufeffa\r\nchanged\r\n");
    expect(await readFile(file, "utf8")).toBe("\ufeffa\r\nchanged\r\n");
  });
});
