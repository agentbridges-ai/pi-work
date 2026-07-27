// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const COMPONENTS_DIR = join(SRC_DIR, "components");

function productionComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionComponentFiles(path);
    if (extname(entry.name) !== ".tsx" || entry.name.endsWith(".test.tsx")) return [];
    return [path];
  });
}

describe("search autofocus contract", () => {
  it("routes every product search input through the shared autofocus constraint", () => {
    const violations: string[] = [];
    let searchInputCount = 0;

    for (const file of productionComponentFiles(COMPONENTS_DIR)) {
      const source = readFileSync(file, "utf8");
      const displayPath = relative(SRC_DIR, file);
      for (const match of source.matchAll(/<input\b[\s\S]*?\/>/g)) {
        const input = match[0];
        const isSearchInput = /type="search"/.test(input);
        const hasSearchNamedCopy = /(?:aria-label|placeholder)=\{[^}]*search[^}]*\}/i.test(input);
        if (!isSearchInput && !hasSearchNamedCopy) continue;

        searchInputCount += 1;
        if (!isSearchInput) violations.push(`${displayPath}: missing type="search"`);
        if (!/\bref=\{[^}]+\}/.test(input)) violations.push(`${displayPath}: missing focus ref`);
        if (!source.includes("useAutoFocusSearchInput")) {
          violations.push(`${displayPath}: missing useAutoFocusSearchInput`);
        }
      }
    }

    expect(searchInputCount).toBeGreaterThanOrEqual(6);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
