import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const explorerSource = readFileSync(
  fileURLToPath(new URL("../UserSpaceExplorer.tsx", import.meta.url)),
  "utf8",
);
const workspacePreviewSource = readFileSync(
  fileURLToPath(new URL("./WorkspacePreviewPane.tsx", import.meta.url)),
  "utf8",
);
const textEditorSource = readFileSync(
  fileURLToPath(new URL("./TextEditorSurface.tsx", import.meta.url)),
  "utf8",
);
const markdownEditorSource = readFileSync(
  fileURLToPath(new URL("./MarkdownEditorSurface.tsx", import.meta.url)),
  "utf8",
);
describe("User Space preview loading boundaries", () => {
  it("keeps CodeMirror runtime imports out of the explorer entry module", () => {
    const runtimeImportLines = explorerSource
      .split("\n")
      .filter((line) =>
        /@uiw\/react-codemirror|@codemirror\/|@milkdown\/|@lezer\/highlight/.test(line),
      )
      .filter((line) => !line.trimStart().startsWith("import type "));

    expect(runtimeImportLines).toEqual([]);
  });

  it("loads text and Markdown runtimes through explicit preview chunks", () => {
    expect(explorerSource).toContain('from "./user-space-preview/WorkspacePreviewPane.js"');
    expect(workspacePreviewSource).toContain('import("./TextEditorSurface.js")');
    expect(workspacePreviewSource).toContain('import("./MarkdownEditorSurface.js")');
    expect(textEditorSource).toContain('from "@uiw/react-codemirror"');
    expect(markdownEditorSource).toContain('import("@milkdown/crepe")');
  });

  it("keeps Milkdown isolated to the lazy Markdown editor chunk", () => {
    expect(markdownEditorSource).toMatch(/@milkdown\/crepe/);
    expect(markdownEditorSource).toMatch(/@milkdown\/kit/);
    expect([explorerSource, workspacePreviewSource, textEditorSource].join("\n")).not.toMatch(
      /@milkdown\//,
    );
  });

  it("passes verified Office fonts at mount time and exposes resource recovery", () => {
    expect(workspacePreviewSource).toContain("ensureOfficeResources().catch(() => null)");
    expect(workspacePreviewSource).toContain("downloadedFonts: getVerifiedOfficeFontPaths()");
    expect(workspacePreviewSource).toContain("officeResourcesNeedAttention()");
    expect(workspacePreviewSource).toContain("onClick={requestOfficeResourceSettings}");
  });
});
