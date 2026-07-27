import { describe, expect, it } from "vitest";
import type { IndexedWorkspaceEntry } from "./user-space-index.js";
import { TsUserSpaceMetadataIndex } from "./user-space-ts-index.js";

const ENTRY_COUNT = 100_000;
const BATCH_SIZE = 128;
const PARENTS = [".git/objects", "node_modules/pkg", "dist", ".hidden", "src"] as const;

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] || 0;
}

describe("TsUserSpaceMetadataIndex scale baseline", () => {
  it("indexes 100,000 entries completely while keeping batch work bounded", () => {
    const index = new TsUserSpaceMetadataIndex(`scale-${Date.now()}`);
    const batchDurations: number[] = [];
    index.begin();

    for (let start = 0; start < ENTRY_COUNT; start += BATCH_SIZE) {
      const entries: IndexedWorkspaceEntry[] = [];
      for (let offset = 0; offset < BATCH_SIZE && start + offset < ENTRY_COUNT; offset++) {
        const sequence = start + offset;
        const parentPath = PARENTS[sequence % PARENTS.length];
        const name = `file-${String(sequence).padStart(6, "0")}.ts`;
        entries.push({
          name,
          path: `${parentPath}/${name}`,
          parentPath,
          kind: "file",
          ext: "ts",
          depth: parentPath.split("/").length + 1,
          previewKind: "text",
          hidden: parentPath.startsWith("."),
          contentIndexed: false,
        });
      }
      const startedAt = performance.now();
      index.addBatch(entries);
      batchDurations.push(performance.now() - startedAt);
    }

    expect(index.commit()).toEqual({ fileCount: ENTRY_COUNT, entryCount: ENTRY_COUNT });
    expect(index.stats()).toEqual({
      fileCount: ENTRY_COUNT,
      entryCount: ENTRY_COUNT,
      building: false,
    });
    expect(index.listChildren(".git/objects", 1, undefined, true).total).toBe(
      ENTRY_COUNT / PARENTS.length,
    );
    expect(index.listChildren(".git/objects", 10, undefined, false).entries).toHaveLength(0);
    expect(index.searchPaths("file-099999", 10, undefined, true).entries).toHaveLength(1);
    expect(percentile(batchDurations, 0.95)).toBeLessThan(50);

    index.clear();
  });
});
