import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The production post-build entrypoint is intentionally native ESM.
import { finalizePwaShell } from "./finalize-pwa-shell.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(worker: string) {
  const root = await mkdtemp(join(tmpdir(), "piwork-pwa-shell-"));
  roots.push(root);
  await mkdir(join(root, ".vite"), { recursive: true });
  const manifest = Buffer.from('{"index.html":{"file":"assets/main.js"}}');
  const index = Buffer.from('<main id="root"></main>');
  await Promise.all([
    writeFile(join(root, "piwork-sw.js"), worker),
    writeFile(join(root, ".vite/manifest.json"), manifest),
    writeFile(join(root, "index.html"), index),
  ]);
  return { root, manifest, index };
}

describe("finalize PWA shell", () => {
  it("replaces every build token with the deterministic shell revision", async () => {
    const { root, manifest, index } = await fixture(
      "const first = '__PIWORK_SHELL_REVISION__'; const second = '__PIWORK_SHELL_REVISION__';",
    );
    const expected = createHash("sha256").update(manifest).update(index).digest("hex").slice(0, 16);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(finalizePwaShell(root)).resolves.toBe(expected);

    expect(await readFile(join(root, "piwork-sw.js"), "utf8")).toBe(
      `const first = '${expected}'; const second = '${expected}';`,
    );
    expect(log).toHaveBeenCalledWith(`Piwork shell revision: ${expected}`);
  });

  it("fails the build when the worker omits the revision token", async () => {
    const { root } = await fixture("const worker = 'already-finalized';");

    await expect(finalizePwaShell(root)).rejects.toThrow(
      "Piwork Service Worker is missing the __PIWORK_SHELL_REVISION__ build token",
    );
  });
});
