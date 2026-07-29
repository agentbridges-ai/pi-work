import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("OnlyOffice font preparation script", () => {
  it("keeps the active development checkout and replaces fonts only after verification", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/prepare-onlyoffice-fonts.sh"), "utf8");

    expect(source).toContain(
      'FONT_ASSETS_DIR="$(mktemp -d "$FONT_ASSETS_PARENT_DIR/.onlyoffice-font-assets.staging.XXXXXX")"',
    );
    expect(source.match(/PIWORK_ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT=/g)).toHaveLength(2);
    expect(source).not.toContain('rm -rf "$FONT_ASSETS_TARGET_DIR"');
    expect(source.lastIndexOf("promote_font_assets")).toBeGreaterThan(
      source.lastIndexOf("verify-onlyoffice-font-assets.mjs"),
    );
  });
});
