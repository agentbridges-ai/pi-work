import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

describe("Office demo fixtures", () => {
  it("keeps the XLSX Normal cell style unfilled for legacy exports", () => {
    const fixturePath = fileURLToPath(
      new URL("../../demo-user-space/office/Example Title.xlsx", import.meta.url),
    );
    const entries = unzipSync(new Uint8Array(readFileSync(fixturePath)));
    const stylesEntry = entries["xl/styles.xml"];

    expect(stylesEntry).toBeDefined();
    const stylesXml = strFromU8(stylesEntry!);
    const styleXfs = stylesXml.match(/<cellStyleXfs\b[^>]*>([\s\S]*?)<\/cellStyleXfs>/)?.[1];
    const normalStyleXf = styleXfs?.match(/<xf\b[^>]*\/?>(?:<\/xf>)?/)?.[0];

    expect(normalStyleXf).toContain('fillId="0"');
  });
});
