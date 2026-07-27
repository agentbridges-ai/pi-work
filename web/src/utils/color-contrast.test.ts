import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contrastRatio, parseColor, relativeLuminance } from "./color-contrast.js";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(srcRoot, "index.css"), "utf8");

function extractBlock(selectorStart: string): string {
  const selectorIndex = css.indexOf(selectorStart);
  if (selectorIndex < 0) throw new Error(`Missing CSS block: ${selectorStart}`);
  const openIndex = css.indexOf("{", selectorIndex);
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS block: ${selectorStart}`);
}

function tokenValue(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing CSS token: --${name}`);
  return match[1].trim();
}

function oklchToRgb(value: string): string {
  const match = value.match(/^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!match) throw new Error(`Expected a concrete OKLCH value, received ${value}`);
  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const rgb = linear.map((channel) => {
    const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  });
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function tokenRgb(block: string, name: string): string {
  return oklchToRgb(tokenValue(block, name));
}

function expectRgbClose(actual: string, expected: string): void {
  const actualColor = parseColor(actual);
  const expectedColor = parseColor(expected);
  if (!actualColor || !expectedColor) throw new Error(`Unable to parse ${actual} or ${expected}`);
  for (const channel of ["r", "g", "b"] as const) {
    expect(actualColor[channel]).toBeGreaterThanOrEqual(expectedColor[channel] - 1);
    expect(actualColor[channel]).toBeLessThanOrEqual(expectedColor[channel] + 1);
  }
}

const light = extractBlock(":root {");
const dark = extractBlock(":root.dark,");

describe("color-contrast", () => {
  it("parses common color formats used by integration palettes", () => {
    expect(parseColor("#fef3c7")).toEqual({ r: 254, g: 243, b: 199, a: 1 });
    expect(parseColor("rgb(69, 26, 3)")).toEqual({ r: 69, g: 26, b: 3, a: 1 });
    expect(parseColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
  });

  it("computes luminance for alpha colors when background is provided", () => {
    const luminance = relativeLuminance("rgba(255, 255, 255, 0.5)", "#000000");
    expect(luminance).toBeGreaterThan(0);
    expect(luminance).toBeLessThan(1);
  });

  it("keeps the declared OKLCH palette aligned with its auditable sRGB contract", () => {
    for (const [block, values] of [
      [
        light,
        {
          background: "#F8F8F7",
          surface: "#FFFFFF",
          foreground: "#34322D",
          muted: "#72716F",
          "tertiary-foreground": "#72716F",
          "control-border": "#8F8F8D",
          accent: "#181818",
          "accent-foreground": "#FFFFFF",
        },
      ],
      [
        dark,
        {
          background: "#1A1A1A",
          surface: "#242424",
          foreground: "#DADADA",
          muted: "#8C8C8C",
          "tertiary-foreground": "#8C8C8C",
          "control-border": "#717171",
          accent: "#DADADA",
          "accent-foreground": "#1A1A1A",
        },
      ],
    ] as const) {
      for (const [name, expected] of Object.entries(values)) {
        expectRgbClose(tokenRgb(block, name), expected);
      }
    }
  });

  it("meets WCAG AA for actual light theme text, placeholder, action, control, and focus pairs", () => {
    const background = tokenRgb(light, "background");
    const surface = tokenRgb(light, "surface");
    const field = tokenRgb(light, "field-background");
    expect(contrastRatio(tokenRgb(light, "foreground"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(light, "muted"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(light, "tertiary-foreground"), surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(tokenRgb(light, "field-placeholder"), field)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(tokenRgb(light, "accent-foreground"), tokenRgb(light, "accent")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(light, "control-border"), field)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokenRgb(light, "accent"), background)).toBeGreaterThanOrEqual(3);
  });

  it("meets WCAG AA for actual dark theme text, placeholder, action, control, and focus pairs", () => {
    const background = tokenRgb(dark, "background");
    const surface = tokenRgb(dark, "surface");
    const field = tokenRgb(dark, "field-background");
    expect(contrastRatio(tokenRgb(dark, "foreground"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(dark, "muted"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(dark, "tertiary-foreground"), surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(tokenRgb(dark, "field-placeholder"), field)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(tokenRgb(dark, "accent-foreground"), tokenRgb(dark, "accent")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokenRgb(dark, "control-border"), field)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokenRgb(dark, "accent"), background)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the preview tab drop indicator visible in both themes", () => {
    expect(tokenValue(light, "preview-drop-indicator")).toBe("var(--foreground)");
    for (const block of [light, dark]) {
      const indicator = tokenRgb(block, "foreground");
      expect(contrastRatio(indicator, tokenRgb(block, "surface"))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(indicator, tokenRgb(block, "background"))).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps semantic status foregrounds readable on their filled backgrounds", () => {
    for (const [block, roles] of [
      [light, ["success", "warning", "danger"]],
      [dark, ["success", "warning", "danger"]],
    ] as const) {
      for (const role of roles) {
        expect(
          contrastRatio(tokenRgb(block, `${role}-foreground`), tokenRgb(block, role)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
