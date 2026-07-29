// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getUiCopyCatalog } from "./ui-copy.js";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const COMPONENTS_DIR = join(SRC_DIR, "components");
const SOURCE_EXEMPTIONS = new Set<string>();
const TECHNICAL_LITERAL_PATTERNS = [
  /^(?:&(?:uarr|darr|crarr|lArr|middot);)+$/,
  /^CLAUDE\.md$/,
  /^(?:ESC|esc|Ctrl|Tab|Paste|x|×)$/,
  /^\/path\/to\/project$/,
  /^my-mcp-server$/,
  /^npx -y @modelcontextprotocol\/server-memory$/,
  /^--port 3000$/,
  /^http:\/\/localhost:3000\/mcp$/,
];
const SHARED_COPY_PATHS = new Set([
  "chat.keyboardShortcuts.keys.control",
  "chat.keyboardShortcuts.keys.b",
  "chat.keyboardShortcuts.keys.enter",
  "chat.keyboardShortcuts.keys.f",
  "chat.keyboardShortcuts.keys.k",
  "chat.keyboardShortcuts.keys.p",
  "chat.keyboardShortcuts.keys.shift",
  "chat.keyboardShortcuts.keys.tab",
  "chat.keyboardShortcuts.keys.u",
  "chat.preferencesPanel.officeResources.categories.word",
  "agents.items.agent.name",
  "login.brand",
  "timeline.thinking",
  "toolBlock.diff",
  "topBar.languages.enUS.label",
  "userSpace.wterm.title",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (extname(entry.name) !== ".tsx" || entry.name.endsWith(".test.tsx")) return [];
    if (SOURCE_EXEMPTIONS.has(entry.name)) return [];
    return [path];
  });
}

function allowedTechnicalLiteral(value: string): boolean {
  return TECHNICAL_LITERAL_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function flattenStrings(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenStrings(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("frontend i18n harness", () => {
  it("rejects literal user-facing copy in production TSX", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(COMPONENTS_DIR)) {
      const source = readFileSync(file, "utf8");
      const displayPath = relative(SRC_DIR, file);
      const attributePattern =
        /\b(?:aria-label|title|placeholder)="([^"]*[A-Za-z\u3400-\u9fff][^"]*)"/g;
      // Restrict this to a literal that begins after an opening tag and ends
      // immediately before a closing tag. A looser cross-tag expression also
      // matches TypeScript comparisons and conditional JSX as if they were UI.
      const textPattern = />([^<>{}\n]*[A-Za-z\u3400-\u9fff][^<>{}\n]*)<\//g;
      for (const pattern of [attributePattern, textPattern]) {
        for (const match of source.matchAll(pattern)) {
          const literal = match[1].trim();
          if (!literal || allowedTechnicalLiteral(literal)) continue;
          violations.push(
            `${displayPath}:${lineNumber(source, match.index ?? 0)} ${JSON.stringify(literal)}`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("rejects component-scoped language catalogs", () => {
    const violations: string[] = [];
    const localeKeyPattern = /["'](?:zh-CN|en-US)["']\s*:/g;
    for (const file of sourceFiles(COMPONENTS_DIR)) {
      const source = readFileSync(file, "utf8");
      const displayPath = relative(SRC_DIR, file);
      for (const match of source.matchAll(localeKeyPattern)) {
        violations.push(`${displayPath}:${lineNumber(source, match.index ?? 0)}`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("requires English overrides for non-technical static Chinese catalog strings", () => {
    const zh = new Map(flattenStrings(getUiCopyCatalog("zh-CN")));
    const en = new Map(flattenStrings(getUiCopyCatalog("en-US")));
    const violations = [...zh.entries()]
      .filter(
        ([path, value]) =>
          /[A-Za-z]/.test(value) && value === en.get(path) && !SHARED_COPY_PATHS.has(path),
      )
      .map(([path, value]) => `${path}: ${JSON.stringify(value)}`);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
