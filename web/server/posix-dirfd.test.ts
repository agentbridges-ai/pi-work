import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PosixDirFdError,
  createDirectoryByDirFd,
  deleteEntryByDirFd,
  ensureDirectoryByDirFd,
  listDirectoryByDirFd,
  readFileByDirFd,
  renameEntryByDirFdNoReplace,
  statEntryByDirFd,
  withPinnedDirectoryByDirFd,
  writeFileByDirFd,
} from "./posix-dirfd.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const isSupportedHost = process.platform === "darwin" || process.platform === "linux";

describe("POSIX directory-descriptor boundary", () => {
  it("covers the instrumented descriptor API through the Node test backend", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-dirfd-unit-"));
    try {
      expect(ensureDirectoryByDirFd(join(root, "nested", "child"), [root])).toBe(
        join(root, "nested", "child"),
      );
      expect(createDirectoryByDirFd(join(root, "created"), [root]).kind).toBe("directory");

      const source = join(root, "nested", "child", "source.txt");
      const target = join(root, "created", "target.txt");
      writeFileByDirFd(source, "descriptor-safe", [root]);
      expect(new TextDecoder().decode(readFileByDirFd(source, [root]).bytes)).toBe(
        "descriptor-safe",
      );
      expect(statEntryByDirFd(source, [root])).toMatchObject({ kind: "file", size: 15 });
      expect(statEntryByDirFd(root, [root]).kind).toBe("directory");
      expect(listDirectoryByDirFd(root, [root], { depth: 3 }).map((entry) => entry.name)).toEqual([
        "created",
        "nested",
      ]);

      expect(() => writeFileByDirFd(source, "again", [root], { exclusive: true })).toThrow(
        expect.objectContaining({ code: "EEXIST", status: 400 }),
      );
      expect(() => readFileByDirFd(source, [root], { maxBytes: 2 })).toThrow(
        expect.objectContaining({ status: 400 }),
      );
      expect(() => listDirectoryByDirFd(root, [root], { depth: 0 })).toThrow(PosixDirFdError);
      expect(() => statEntryByDirFd(join(root, "%2fescape"), [root])).toThrow(
        expect.objectContaining({ status: 400 }),
      );

      renameEntryByDirFdNoReplace(source, target, [root]);
      expect(existsSync(source)).toBe(false);
      expect(existsSync(target)).toBe(true);
      deleteEntryByDirFd(target, [root]);
      deleteEntryByDirFd(join(root, "nested"), [root], { recursive: true });
      expect(existsSync(join(root, "nested"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps batch renames on a pinned directory after its pathname is replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-dirfd-pinned-"));
    try {
      const source = join(root, "source");
      const destination = join(root, "destination");
      const parked = join(root, "parked-destination");
      ensureDirectoryByDirFd(source, [root]);
      ensureDirectoryByDirFd(destination, [root]);
      writeFileByDirFd(join(source, "one.txt"), "one", [root]);
      writeFileByDirFd(join(source, "two.txt"), "two", [root]);

      await withPinnedDirectoryByDirFd(destination, [root], async (pinned) => {
        pinned.renameEntryFromPathNoReplace(join(source, "one.txt"), "one.txt");
        renameSync(destination, parked);
        mkdirSync(destination);
        pinned.renameEntryFromPathNoReplace(join(source, "two.txt"), "two.txt");

        expect(pinned.matchesPath(destination)).toBe(false);
        expect(pinned.statEntry("one.txt")).toMatchObject({ kind: "file", size: 3 });
        expect(pinned.statEntry("two.txt")).toMatchObject({ kind: "file", size: 3 });
      });

      expect(existsSync(join(parked, "one.txt"))).toBe(true);
      expect(existsSync(join(parked, "two.txt"))).toBe(true);
      expect(existsSync(join(destination, "one.txt"))).toBe(false);
      expect(existsSync(join(destination, "two.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("moves and rolls back through pinned source and destination identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-dirfd-pinned-pair-"));
    try {
      const source = join(root, "source");
      const parkedSource = join(root, "parked-source");
      const destination = join(root, "destination");
      ensureDirectoryByDirFd(source, [root]);
      ensureDirectoryByDirFd(destination, [root]);
      writeFileByDirFd(join(source, "item.txt"), "item", [root]);

      await withPinnedDirectoryByDirFd(source, [root], async (pinnedSource) => {
        await withPinnedDirectoryByDirFd(destination, [root], async (pinnedDestination) => {
          const inspection = pinnedSource.inspectEntry("item.txt");
          expect(inspection).not.toBeNull();

          renameSync(source, parkedSource);
          mkdirSync(source);
          const movedIdentity = pinnedSource.renameEntryToDirectoryNoReplace(
            "item.txt",
            pinnedDestination,
            "item.txt",
            inspection!.identity,
          );
          pinnedDestination.renameEntryToDirectoryNoReplace(
            "item.txt",
            pinnedSource,
            "item.txt",
            movedIdentity,
          );

          expect(pinnedSource.matchesPath(source)).toBe(false);
        });
      });

      expect(
        new TextDecoder().decode(readFileByDirFd(join(parkedSource, "item.txt"), [root]).bytes),
      ).toBe("item");
      expect(existsSync(join(source, "item.txt"))).toBe(false);
      expect(existsSync(join(destination, "item.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!isSupportedHost)(
    "uses the real Bun/libc backend for parent swaps, links, and no-replace rename",
    () => {
      const output = execFileSync(
        "bun",
        [
          "-e",
          String.raw`
            import assert from "node:assert/strict";
            import {
              existsSync,
              linkSync,
              mkdirSync,
              mkdtempSync,
              readFileSync,
              renameSync,
              rmSync,
              statSync,
              symlinkSync,
              writeFileSync,
            } from "node:fs";
            import { tmpdir } from "node:os";
            import { join } from "node:path";
            import {
              createDirectoryByDirFd,
              deleteEntryByDirFd,
              ensureDirectoryByDirFd,
              listDirectoryByDirFd,
              readFileByDirFd,
              renameEntryByDirFdNoReplace,
              withPinnedDirectoryByDirFd,
              writeFileByDirFd,
            } from "./server/posix-dirfd.ts";

            const root = mkdtempSync(join(tmpdir(), "piwork-real-dirfd-"));
            const outside = mkdtempSync(join(tmpdir(), "piwork-real-dirfd-outside-"));
            try {
              ensureDirectoryByDirFd(join(root, "nested", "child"), [root]);
              assert.equal(statSync(join(root, "nested", "child")).mode & 0o777, 0o700);
              writeFileByDirFd(join(root, "nested", "child", "safe.txt"), "safe", [root]);
              assert.equal(statSync(join(root, "nested", "child", "safe.txt")).mode & 0o777, 0o600);
              assert.equal(
                new TextDecoder().decode(
                  readFileByDirFd(join(root, "nested", "child", "safe.txt"), [root]).bytes,
                ),
                "safe",
              );
              assert.equal(listDirectoryByDirFd(root, [root], { depth: 3 })[0]?.name, "nested");

              writeFileSync(join(outside, "victim.txt"), "private");
              linkSync(join(outside, "victim.txt"), join(root, "hard.txt"));
              symlinkSync(join(outside, "victim.txt"), join(root, "link.txt"));
              for (const path of [join(root, "hard.txt"), join(root, "link.txt")]) {
                assert.throws(() => readFileByDirFd(path, [root]));
                assert.throws(() => writeFileByDirFd(path, "bad", [root]));
                assert.throws(() => deleteEntryByDirFd(path, [root]));
              }
              const unsafeNames = listDirectoryByDirFd(root, [root]).map((entry) => entry.name);
              assert.equal(unsafeNames.includes("hard.txt"), false);
              assert.equal(unsafeNames.includes("link.txt"), false);
              assert.equal(readFileSync(join(outside, "victim.txt"), "utf-8"), "private");

              mkdirSync(join(root, "swap-list"));
              writeFileSync(join(root, "swap-list", "own.txt"), "own");
              renameSync(join(root, "swap-list"), join(root, "parked-list"));
              symlinkSync(outside, join(root, "swap-list"));
              assert.throws(() => listDirectoryByDirFd(join(root, "swap-list"), [root]));
              assert.equal(
                listDirectoryByDirFd(join(root, "parked-list"), [root])[0]?.name,
                "own.txt",
              );

              mkdirSync(join(root, "swap-parent"));
              writeFileByDirFd(join(root, "swap-parent", "created.txt"), "pinned", [root], {
                hooks: {
                  afterParentOpened() {
                    renameSync(join(root, "swap-parent"), join(root, "parked-parent"));
                    symlinkSync(outside, join(root, "swap-parent"));
                  },
                },
              });
              assert.equal(readFileSync(join(root, "parked-parent", "created.txt"), "utf-8"), "pinned");
              assert.equal(existsSync(join(outside, "created.txt")), false);

              mkdirSync(join(root, "create-parent"));
              createDirectoryByDirFd(join(root, "create-parent", "child"), [root], {
                afterParentOpened() {
                  renameSync(join(root, "create-parent"), join(root, "parked-create-parent"));
                  symlinkSync(outside, join(root, "create-parent"));
                },
              });
              assert.equal(statSync(join(root, "parked-create-parent", "child")).isDirectory(), true);
              assert.equal(existsSync(join(outside, "child")), false);

              ensureDirectoryByDirFd(join(root, "source"), [root]);
              ensureDirectoryByDirFd(join(root, "destination"), [root]);
              writeFileByDirFd(join(root, "source", "file.txt"), "source", [root]);
              writeFileByDirFd(join(root, "destination", "file.txt"), "destination", [root]);
              assert.throws(
                () =>
                  renameEntryByDirFdNoReplace(
                    join(root, "source", "file.txt"),
                    join(root, "destination", "file.txt"),
                    [root],
                  ),
                (error) => error?.code === "EEXIST",
              );
              assert.equal(readFileSync(join(root, "source", "file.txt"), "utf-8"), "source");
              assert.equal(
                readFileSync(join(root, "destination", "file.txt"), "utf-8"),
                "destination",
              );

              ensureDirectoryByDirFd(join(root, "rename-source"), [root]);
              ensureDirectoryByDirFd(join(root, "rename-target"), [root]);
              writeFileByDirFd(join(root, "rename-source", "move.txt"), "move", [root]);
              renameEntryByDirFdNoReplace(
                join(root, "rename-source", "move.txt"),
                join(root, "rename-target", "moved.txt"),
                [root],
                {
                  afterParentOpened() {
                    renameSync(join(root, "rename-target"), join(root, "parked-rename-target"));
                    symlinkSync(outside, join(root, "rename-target"));
                  },
                },
              );
              assert.equal(readFileSync(join(root, "parked-rename-target", "moved.txt"), "utf-8"), "move");
              assert.equal(existsSync(join(outside, "moved.txt")), false);

              ensureDirectoryByDirFd(join(root, "pinned-source"), [root]);
              ensureDirectoryByDirFd(join(root, "pinned-target"), [root]);
              writeFileByDirFd(join(root, "pinned-source", "one.txt"), "one", [root]);
              writeFileByDirFd(join(root, "pinned-source", "two.txt"), "two", [root]);
              await withPinnedDirectoryByDirFd(join(root, "pinned-target"), [root], async (pinned) => {
                pinned.renameEntryFromPathNoReplace(
                  join(root, "pinned-source", "one.txt"),
                  "one.txt",
                );
                renameSync(join(root, "pinned-target"), join(root, "parked-pinned-target"));
                mkdirSync(join(root, "pinned-target"));
                pinned.renameEntryFromPathNoReplace(
                  join(root, "pinned-source", "two.txt"),
                  "two.txt",
                );
                assert.equal(pinned.matchesPath(join(root, "pinned-target")), false);
              });
              assert.equal(readFileSync(join(root, "parked-pinned-target", "one.txt"), "utf-8"), "one");
              assert.equal(readFileSync(join(root, "parked-pinned-target", "two.txt"), "utf-8"), "two");
              assert.equal(existsSync(join(root, "pinned-target", "one.txt")), false);

              ensureDirectoryByDirFd(join(root, "pinned-pair-source"), [root]);
              ensureDirectoryByDirFd(join(root, "pinned-pair-target"), [root]);
              writeFileByDirFd(join(root, "pinned-pair-source", "item.txt"), "item", [root]);
              await withPinnedDirectoryByDirFd(
                join(root, "pinned-pair-source"),
                [root],
                async (pinnedSource) => {
                  await withPinnedDirectoryByDirFd(
                    join(root, "pinned-pair-target"),
                    [root],
                    async (pinnedTarget) => {
                      const inspection = pinnedSource.inspectEntry("item.txt");
                      assert.ok(inspection);
                      renameSync(
                        join(root, "pinned-pair-source"),
                        join(root, "parked-pinned-pair-source"),
                      );
                      mkdirSync(join(root, "pinned-pair-source"));
                      const movedIdentity = pinnedSource.renameEntryToDirectoryNoReplace(
                        "item.txt",
                        pinnedTarget,
                        "item.txt",
                        inspection.identity,
                      );
                      pinnedTarget.renameEntryToDirectoryNoReplace(
                        "item.txt",
                        pinnedSource,
                        "item.txt",
                        movedIdentity,
                      );
                    },
                  );
                },
              );
              assert.equal(
                readFileSync(join(root, "parked-pinned-pair-source", "item.txt"), "utf-8"),
                "item",
              );
              assert.equal(existsSync(join(root, "pinned-pair-source", "item.txt")), false);
              assert.equal(existsSync(join(root, "pinned-pair-target", "item.txt")), false);

              ensureDirectoryByDirFd(join(root, "remove", "nested"), [root]);
              writeFileByDirFd(join(root, "remove", "nested", "file.txt"), "remove", [root]);
              deleteEntryByDirFd(join(root, "remove"), [root], { recursive: true });
              assert.equal(existsSync(join(root, "remove")), false);
              console.log("real-dirfd-ok");
            } finally {
              rmSync(root, { recursive: true, force: true });
              rmSync(outside, { recursive: true, force: true });
            }
          `,
        ],
        { cwd: webRoot, encoding: "utf-8" },
      );

      expect(output.trim()).toBe("real-dirfd-ok");
    },
  );
});
