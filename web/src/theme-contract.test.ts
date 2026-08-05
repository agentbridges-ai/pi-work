import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appCss = readFileSync(resolve(projectRoot, "src/index.css"), "utf8");
const themeCss = readFileSync(
  resolve(projectRoot, "../packages/design-tokens/src/theme.css"),
  "utf8",
);
const css = `${themeCss}\n${appCss}`;
const indexHtml = readFileSync(resolve(projectRoot, "index.html"), "utf8");
const imageEditorSource = readFileSync(
  resolve(projectRoot, "src/components/ImageEditorSurface.tsx"),
  "utf8",
);
const textEditorSource = readFileSync(
  resolve(projectRoot, "src/components/user-space-preview/TextEditorSurface.tsx"),
  "utf8",
);
const normalizedCss = css.replace(/\s+/g, " ").trim();

function extractBlock(selectorStart: string): string {
  const selectorIndex = css.indexOf(selectorStart);
  expect(selectorIndex, `${selectorStart} block should exist`).toBeGreaterThanOrEqual(0);
  const openIndex = css.indexOf("{", selectorIndex);
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Could not read CSS block for ${selectorStart}`);
}

const themeBlock = extractBlock("@theme");
const rootBlock = extractBlock(":root {");
const darkBlock = extractBlock(":root.dark,");

describe("Piwork theme token contract", () => {
  it("uses the independent Piwork palette without design preset selectors", () => {
    expect(appCss).toContain('@import "@piwork/design-tokens/theme.css";');
    expect(rootBlock).toContain("--background: oklch(0.9789 0.0013 106.42);");
    expect(rootBlock).toContain("--foreground: oklch(0.3174 0.0091 88.75);");
    expect(rootBlock).toContain("--accent: oklch(0.2103 0.0013 106.42);");
    expect(darkBlock).toContain("--background: oklch(0.2178 0 0);");
    expect(darkBlock).toContain("--foreground: oklch(0.8884 0 0);");
    expect(darkBlock).toContain("--accent: oklch(0.8884 0 0);");
    expect(css).not.toContain("Manus");
    expect(css).not.toContain("data-design-theme");
    expect(css).not.toContain("theme-demo-");
  });

  it("exposes semantic roles through Tailwind without migration aliases", () => {
    for (const token of [
      "background",
      "foreground",
      "card",
      "muted-foreground",
      "tertiary-foreground",
      "disabled-foreground",
      "border",
      "control-border",
      "focus",
      "surface",
      "surface-weak",
      "primary",
      "primary-foreground",
      "success",
      "warning",
      "danger",
      "info",
    ]) {
      expect(themeBlock).toContain(`--color-${token}:`);
    }
    expect(rootBlock).toContain("--card: var(--surface);");
    expect(rootBlock).toContain("--popover: var(--overlay);");
    expect(rootBlock).toContain("--muted-foreground: var(--muted);");
    expect(rootBlock).toContain("--primary-foreground: var(--accent-foreground);");
    expect(rootBlock).toContain("--field-border: var(--control-border);");
    expect(themeBlock).toContain("--color-preview-drop-indicator: var(--preview-drop-indicator);");
    expect(rootBlock).toContain("--preview-drop-indicator: var(--foreground);");
    expect(themeBlock).not.toContain("--color-piwork-");
  });

  it("keeps one fixed geometry, type, spacing, motion, and z-index scale", () => {
    expect(rootBlock).toContain("--piwork-control-radius: 6px;");
    expect(rootBlock).toContain("--piwork-panel-radius: 10px;");
    expect(rootBlock).toContain("--piwork-composer-radius: 12px;");
    expect(rootBlock).toContain("--piwork-composer-border-width: 1px;");
    expect(rootBlock).toContain("--piwork-composer-width: 736px;");
    expect(rootBlock).toContain("--piwork-composer-bottom-inset: 144px;");
    expect(rootBlock).toContain("--piwork-titlebar-height: 40px;");
    expect(rootBlock).not.toContain("--field-radius:");
    expect(rootBlock).toContain("--piwork-text-caption-size: 0.75rem;");
    expect(rootBlock).toContain("--piwork-duration-feedback: 120ms;");
    expect(rootBlock).toContain("--piwork-duration-overlay: 220ms;");
    expect(rootBlock).toContain("--piwork-duration-layout: 320ms;");
    expect(rootBlock).toContain("--piwork-z-modal: 50;");
    expect(rootBlock).toContain("--piwork-z-drag: 70;");
    expect(css).not.toContain("data-design-radius");
    expect(imageEditorSource).toContain("var(--piwork-panel-radius)");
    expect(imageEditorSource).not.toContain("var(--panel-radius)");
    expect(css).toContain(".piwork-prosemirror-editor:focus-visible");
    expect(css).toContain("outline: none !important;");
    expect(css).toContain(".piwork-composer-card:has(.piwork-prosemirror-editor:focus)");
  });

  it("uses the global Piwork font across application typography roles", () => {
    expect(rootBlock).toContain(
      '--piwork-font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    );
    expect(rootBlock.replace(/\s+/g, " ")).toContain(
      '--piwork-code-font-family: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    );
    expect(themeBlock).toContain("--font-sans: var(--piwork-font-family);");
    expect(themeBlock).toContain("--font-serif: var(--piwork-font-family);");
    expect(themeBlock).toContain("--font-mono: var(--piwork-font-family);");
    expect(css).toContain("--crepe-font-title: var(--piwork-font-family);");
    expect(css).toContain("--crepe-font-code: var(--piwork-code-font-family);");
    expect(normalizedCss).toContain(
      "body, #root, #root *, #root *::before, #root *::after { font-family: inherit !important; }",
    );
    expect(normalizedCss).toContain(
      "#root :is(pre, .diff-viewer, .cm-editor, .milkdown-code-block), #root :is(pre, .diff-viewer, .cm-editor, .milkdown-code-block) * { font-family: var(--piwork-code-font-family) !important; font-style: normal !important; }",
    );
    expect(css).not.toMatch(/font-family:\s*(?:ui-serif|["']SF Mono)/);
  });

  it("synchronizes light, dark, and system mode before first paint and clears radius legacy state", () => {
    expect(indexHtml).toContain(
      '<html lang="zh-CN" class="light bg-background" data-theme="light">',
    );
    expect(indexHtml).toContain('localStorage.getItem("piwork-theme-mode")');
    expect(indexHtml).toContain('localStorage.getItem("piwork-dark-mode")');
    expect(indexHtml).toContain('localStorage.removeItem("piwork-design-radius")');
    expect(indexHtml).toContain('root.removeAttribute("data-design-theme")');
    expect(indexHtml).toContain('root.removeAttribute("data-design-radius")');
    expect(indexHtml).toContain("root.classList.add(theme)");
    expect(indexHtml).toContain("root.dataset.theme = theme");
    expect(indexHtml).toContain("root.style.colorScheme = theme");
    expect(indexHtml).toContain('theme === "dark" ? "#242424" : "#FFFFFF"');
  });

  it("maps conversation surfaces and status roles to semantic tokens", () => {
    expect(rootBlock).toContain("--piwork-conversation-background: var(--background);");
    expect(rootBlock).toContain("--piwork-user-message-background: var(--surface);");
    expect(rootBlock).toContain("--piwork-composer-background: var(--surface);");
    expect(rootBlock).toContain("--piwork-tool-card-background: var(--surface);");
    expect(darkBlock).toContain("--piwork-user-message-background: var(--surface-tertiary);");
    expect(rootBlock).toContain("--success-soft: oklch(");
    expect(rootBlock).toContain("--warning-soft: oklch(");
    expect(rootBlock).toContain("--danger-soft: oklch(");
  });

  it("forbids muted background surfaces inside modal dialogs", () => {
    const modalSurfacePolicy = extractBlock(
      ':is([data-slot="modal-dialog"], [data-slot="alert-dialog-dialog"])',
    );
    expect(modalSurfacePolicy).toContain("--color-muted: var(--card);");
  });

  it("enforces flat surfaces across application and third-party components", () => {
    const flatnessPolicy = extractBlock("/* Flatness is a product-level visual contract.");
    expect(flatnessPolicy).toContain("box-shadow: none !important;");
    expect(flatnessPolicy).toContain("text-shadow: none !important;");
    expect(flatnessPolicy).toContain("backdrop-filter: none !important;");
    expect(css).not.toContain('@import "@heroui/styles/components/scroll-shadow.css"');
    expect(rootBlock).not.toContain("--shadow-");
  });

  it("keeps Markdown editor text and controls legible in both themes", () => {
    expect(rootBlock).toContain("--piwork-editor-foreground: var(--foreground);");
    expect(rootBlock).toContain("--piwork-markdown-foreground: var(--piwork-editor-foreground);");
    expect(darkBlock).toContain("--piwork-editor-foreground: oklch(0.95 0 0);");
    expect(css).toContain("--crepe-color-on-background: var(--piwork-markdown-foreground);");
    expect(css).toContain("color: var(--piwork-markdown-foreground);");
    expect(normalizedCss).toContain(
      '.piwork-markdown-style-picker-value[data-placeholder="true"] { color: var(--piwork-markdown-foreground); }',
    );
  });

  it("keeps wterm flush with the preview edge and adapts its palette to both themes", () => {
    const wtermShellBlock = extractBlock(".piwork-wterm-selection-shell {");
    const wtermTerminalBlock = extractBlock(
      ".piwork-wterm-selection-shell .piwork-wterm-terminal {",
    );
    const darkWtermBlock = extractBlock(
      ".dark .piwork-wterm-selection-shell .piwork-wterm-terminal {",
    );

    expect(wtermShellBlock).toContain("background: var(--piwork-wterm-background);");
    expect(wtermTerminalBlock).toContain("--term-bg: var(--piwork-wterm-background);");
    expect(wtermTerminalBlock).toContain("--term-fg: var(--piwork-wterm-foreground);");
    expect(wtermTerminalBlock).toContain("width: 100%;");
    expect(wtermTerminalBlock).toContain("margin: 0;");
    expect(wtermTerminalBlock).toContain("border-radius: 0;");
    expect(wtermTerminalBlock).toContain("background: var(--term-bg);");
    expect(wtermTerminalBlock).toContain("color: var(--term-fg);");
    expect(wtermTerminalBlock).toContain("--term-color-0: color(srgb 0.2196 0.2275 0.2588);");
    expect(darkWtermBlock).toContain("--term-color-0: color(srgb 0.1176 0.1176 0.1176);");
  });

  it("shares one text-selection background across Markdown and code previews and editors", () => {
    expect(rootBlock).toMatch(
      /--piwork-text-selection-background:\s*color-mix\(\s*in oklab,\s*var\(--foreground\) 18%,\s*var\(--background\)\s*\);/,
    );
    expect(css).toContain("--crepe-color-selected: var(--piwork-text-selection-background);");
    expect(textEditorSource.match(/var\(--piwork-text-selection-background\)/g)).toHaveLength(2);
    expect(textEditorSource).toContain('".cm-content ::selection"');
    expect(textEditorSource).toContain(".cm-selectionLayer .cm-selectionBackground");
  });

  it("uses the brighter editor foreground for image editing controls", () => {
    expect(imageEditorSource).toContain("text-[var(--piwork-editor-foreground)]");
    expect(imageEditorSource).not.toContain(
      '"text-muted-foreground hover:bg-accent hover:text-foreground"',
    );
  });

  it("uses tokenized Switch thumbs and keeps hover feedback immediate", () => {
    const checkedSwitchBlock = extractBlock(
      '.piwork-switch-contrast[aria-checked="true"] [data-slot="switch-thumb"],',
    );
    expect(checkedSwitchBlock).toContain("background-color: var(--accent-foreground);");
    expect(checkedSwitchBlock).toContain("color: var(--accent);");

    const colorTransitionBlock = extractBlock('[class*="hover:bg-"][class~="transition-colors"] {');
    expect(colorTransitionBlock).not.toContain("background-color");
    expect(colorTransitionBlock.replace(/\s+/g, " ")).toContain(
      "transition-property: color, border-color",
    );
  });

  it("keeps the User Space tree and preview visible at every container width", () => {
    expect(css).toContain("container-name: piwork-user-space;");
    expect(css).not.toContain("@container piwork-user-space (max-width: 720px)");
    expect(css).not.toContain('> [data-testid="user-space-tree-panel"],');
    expect(css).not.toContain("grid-template-columns: minmax(0, 1fr) !important;");
  });
});
