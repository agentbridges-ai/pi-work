import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scannedRoots = [
  resolve(projectRoot, "src/components"),
  resolve(projectRoot, "src/App.tsx"),
  resolve(projectRoot, "src/index.css"),
  resolve(projectRoot, "index.html"),
];

const ignoredFiles = new Set(["src/components/iconify-material-file-icons.ts"]);

const CONTENT_PALETTE_FILE = "src/components/ImageEditorSurface.tsx";
const CONTENT_PALETTE_START = "theme-guard: allow-content-palette-start";
const CONTENT_PALETTE_END = "theme-guard: allow-content-palette-end";
const allowedInlineHexColors = new Map<string, Set<string>>([
  // Browser chrome metadata cannot consume CSS custom properties before the app stylesheet loads.
  ["index.html", new Set(["#FFFFFF", "#242424"])],
]);

const forbiddenPatterns: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "fixed neutral utility color",
    pattern:
      /\b(?:bg|text|border|ring|outline|divide|placeholder)-(?:slate|gray|zinc|neutral)-\d{2,3}\b/,
  },
  {
    name: "fixed status or hue utility color",
    pattern:
      /\b(?:bg|text|border|ring|outline|divide|decoration|accent|border-t|hover:bg|hover:text|focus-visible:ring|focus-visible:outline)-(?:red|amber|yellow|emerald|green|blue|cyan|fuchsia|indigo|orange|sky)-\d{2,3}(?:\/\d+)?\b/,
  },
  {
    name: "fixed black or white utility",
    pattern: /\b(?:bg|text|border|from|via|to|shadow)-(?:black|white)(?:\/\d+)?\b/,
  },
  {
    name: "fixed rgb color",
    pattern: /rgba?\(/,
  },
  {
    name: "hex color utility",
    pattern:
      /\b(?:bg|text|border|ring|outline|shadow|hover:bg|hover:text|focus-visible:ring|focus-visible:outline)-\[#/u,
  },
  {
    name: "dark utility color patch",
    pattern: /[\s"'`{]dark:(?:bg|text|border|ring|outline|from|via|to)-/,
  },
  {
    name: "legacy Piwork color utility",
    pattern:
      /\b(?:bg|text|border|ring|accent|decoration|divide|border-t)-piwork-[a-z-]+(?:\/\d+)?\b/,
  },
  {
    name: "legacy cc storage namespace",
    pattern: /["'`]cc-/,
  },
  {
    name: "arbitrary visible font size outside the type scale",
    pattern: /\btext-\[(?!(?:13|28)px\])(?:\d+(?:\.\d+)?)px\]/,
  },
  {
    name: "arbitrary radius outside semantic geometry tokens",
    pattern:
      /\brounded-\[(?!var\(--piwork-(?:control|panel|composer|message-bubble)-radius\)\])[^\]]+\]/,
  },
  {
    name: "arbitrary numeric z-index",
    pattern: /\bz-\[-?\d+\]/,
  },
  {
    name: "one-pixel keyboard focus ring",
    pattern: /\b(?:focus-visible|focus-within):ring-1\b/,
  },
  {
    name: "elevation shadow utility",
    pattern:
      /(?:^|[\s"'`])(?:[a-z-]+:)*shadow(?:-(?:sm|md|lg|xl|2xl|inner|\[[^\]]+\]))?(?=$|[\s"'`])/m,
  },
  {
    name: "rendered CSS shadow",
    pattern: /(?:box-shadow|text-shadow)\s*:(?!\s*none\b)/,
  },
  {
    name: "rendered JavaScript shadow",
    pattern: /boxShadow\s*:(?!\s*["']none["'])/,
  },
  {
    name: "glass blur effect",
    pattern: /\bbackdrop-blur(?:-[a-z0-9]+)?\b/,
  },
  {
    name: "hover elevation transform",
    pattern: /\b(?:hover|active):(?:-?translate-y|scale)-/,
  },
  {
    name: "3D transform",
    pattern: /(?:\bperspective\s*:|\btranslateZ\(|\brotate[XY]\()/,
  },
];

function collectFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => collectFiles(join(path, entry)));
}

function isScannedSource(path: string): boolean {
  if (!/\.(?:ts|tsx|css|html)$/.test(path)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(path)) return false;
  const relativePath = relative(projectRoot, path);
  return !ignoredFiles.has(relativePath);
}

function findInlineHexColors(source: string): string[] {
  const matches: string[] = [];
  for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}/g)) {
    if (source[match.index - 1] === "&") continue;
    matches.push(match[0]);
  }
  return matches;
}

function stripApprovedContentPalette(
  relativePath: string,
  source: string,
): { source: string; violation?: string } {
  const startIndex = source.indexOf(CONTENT_PALETTE_START);
  const endIndex = source.indexOf(CONTENT_PALETTE_END);
  if (relativePath !== CONTENT_PALETTE_FILE) {
    if (startIndex >= 0 || endIndex >= 0)
      return { source, violation: "unapproved content palette marker" };
    return { source };
  }
  if (startIndex < 0 || endIndex <= startIndex) {
    return { source, violation: "missing bounded content palette markers" };
  }
  const secondStart = source.indexOf(
    CONTENT_PALETTE_START,
    startIndex + CONTENT_PALETTE_START.length,
  );
  const secondEnd = source.indexOf(CONTENT_PALETTE_END, endIndex + CONTENT_PALETTE_END.length);
  if (secondStart >= 0 || secondEnd >= 0) {
    return { source, violation: "content palette must use one bounded block" };
  }
  return {
    source: `${source.slice(0, startIndex)}${source.slice(endIndex + CONTENT_PALETTE_END.length)}`,
  };
}

describe("theme source guard", () => {
  const files = scannedRoots.flatMap(collectFiles).filter(isScannedSource);

  it("scans the intended app and component sources", () => {
    expect(files.map((file) => relative(projectRoot, file))).toEqual(
      expect.arrayContaining([
        "index.html",
        "src/App.tsx",
        "src/index.css",
        "src/components/ChatView.tsx",
        "src/components/Composer.tsx",
        "src/components/UserSpaceExplorer.tsx",
        "src/components/RbacAdminPage.tsx",
        "src/components/LoginPage.tsx",
      ]),
    );
  });

  it("keeps business UI on semantic color tokens", () => {
    const violations: string[] = [];

    for (const file of files) {
      const rawSource = readFileSync(file, "utf8");
      const relativePath = relative(projectRoot, file);
      const stripped = stripApprovedContentPalette(relativePath, rawSource);
      if (stripped.violation) violations.push(`${relativePath}: ${stripped.violation}`);
      const source = stripped.source;
      for (const { name, pattern } of forbiddenPatterns) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${name}`);
      }
      const allowedHex = allowedInlineHexColors.get(relativePath) ?? new Set<string>();
      const inlineHexColors = findInlineHexColors(source).filter((color) => !allowedHex.has(color));
      if (inlineHexColors.length > 0) {
        violations.push(`${relativePath}: inline hex colors ${inlineHexColors.join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps HeroUI behind the shared UI boundary", () => {
    const violations = files
      .map((file) => ({
        path: relative(projectRoot, file),
        source: readFileSync(file, "utf8"),
      }))
      .filter(
        ({ path, source }) =>
          !path.startsWith("src/components/ui/") && /["']@heroui\/react["']/.test(source),
      )
      .map(({ path }) => path);

    expect(violations).toEqual([]);
  });

  it("does not reference undefined CSS custom properties", () => {
    const sources = files.map((file) => readFileSync(file, "utf8"));
    const references = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((match) => match[1]),
      ),
    );
    const definitions = new Set(
      sources.flatMap((source) => [
        ...[...source.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/gm)].map((match) => match[2]),
        ...[...source.matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*:/g)].map((match) => match[1]),
      ]),
    );

    expect([...references].filter((name) => !definitions.has(name))).toEqual([]);
  });
});
