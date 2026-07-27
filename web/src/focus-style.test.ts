import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("global focus styles", () => {
  it("shows a consistent two-pixel focus-visible outline", () => {
    const css = readFileSync(join(currentDir, "index.css"), "utf8");

    expect(css).toContain('html[data-piwork-keyboard-navigation="true"] :focus-visible');
    expect(css).toContain("outline: 2px solid var(--focus) !important");
    expect(css).toContain("outline-offset: 2px !important");
    expect(css).toMatch(
      /html:not\(\[data-piwork-keyboard-navigation="true"\]\) :focus-visible\s*\{[^}]*outline:\s*none !important;[^}]*--tw-ring-shadow:\s*0 0 transparent !important;/s,
    );
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("outline-color: Highlight !important");
    expect(css).toMatch(
      /\.piwork-composer-card:has\(\.piwork-prosemirror-editor:focus\)\s*\{[^}]*border-color:\s*var\(--focus\);[^}]*outline:\s*1px solid var\(--focus\);[^}]*outline-offset:\s*-1px;/s,
    );
    expect(css).toMatch(
      /\.piwork-prosemirror-editor:focus-visible\s*\{[^}]*outline:\s*none !important;/s,
    );
    expect(css.match(/outline:\s*none !important/g)).toHaveLength(2);
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[^}]*html\[data-piwork-keyboard-navigation="true"\] :focus-visible\s*\{[^}]*outline-color:\s*Highlight !important;[^}]*\}[^}]*\.piwork-composer-card:has\(\.piwork-prosemirror-editor:focus\)\s*\{[^}]*outline:\s*2px solid Highlight;/s,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*\[data-piwork-workspace-drop-surface\]\[data-drop-target="true"\]\s*\{[^}]*outline:\s*2px solid Highlight;[^}]*outline-offset:\s*-2px;[^}]*box-shadow:\s*none !important;/,
    );
  });

  it("moves the skip link into the viewport when keyboard-focused", () => {
    const css = readFileSync(join(currentDir, "index.css"), "utf8");
    const app = readFileSync(join(currentDir, "App.tsx"), "utf8");

    expect(app).toContain("piwork-skip-link");
    expect(css).toMatch(/\.piwork-skip-link\s*\{[^}]*translate:\s*0 -4rem/s);
    expect(css).toMatch(/\.piwork-skip-link:focus-visible\s*\{[^}]*translate:\s*0 0/s);
  });

  it("keeps iframe previews from interrupting an active workspace drag", () => {
    const css = readFileSync(join(currentDir, "index.css"), "utf8");

    expect(css).toMatch(
      /html\[data-piwork-workspace-dragging="true"\] iframe\s*\{[^}]*pointer-events:\s*none !important;/s,
    );
  });

  it("outlines each contiguous region of an active context-menu multi-selection", () => {
    const css = readFileSync(join(currentDir, "index.css"), "utf8");

    expect(css).toMatch(
      /\[data-piwork-user-space-tree-pane\]:has\(\[data-selected="true"\]\[data-state="open"\]\)[\s\S]*?\[data-selected="true"\][\s\S]*?> \.piwork-selection-surface\s*\{[^}]*border-left-width:\s*1px;[^}]*border-right-width:\s*1px;/,
    );
    expect(css).toMatch(
      /\[data-selection-segment="top"\][\s\S]*?> \.piwork-selection-surface,[\s\S]*?\[data-selection-segment="single"\][\s\S]*?> \.piwork-selection-surface\s*\{[^}]*border-top-width:\s*1px;/,
    );
    expect(css).toMatch(
      /\[data-selection-segment="bottom"\][\s\S]*?> \.piwork-selection-surface,[\s\S]*?\[data-selection-segment="single"\][\s\S]*?> \.piwork-selection-surface\s*\{[^}]*border-bottom-width:\s*1px;/,
    );
  });
});
