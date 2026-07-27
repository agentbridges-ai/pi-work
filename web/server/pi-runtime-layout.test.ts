import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensurePiRuntimeLayout,
  inspectPiRuntimeLayout,
  PI_RUNTIME_LAYOUT_FORMAT,
  PI_RUNTIME_LAYOUT_VERSION,
  requirePiRuntimeLayout,
} from "./pi-runtime-layout.js";

const roots: string[] = [];

function fixture(name = "data"): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-layout-")));
  roots.push(parent);
  return join(parent, name);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi runtime layout marker", () => {
  it("initializes an absent data root with restrictive modes", () => {
    const root = fixture();
    const marker = ensurePiRuntimeLayout(root);
    const markerPath = join(root, ".runtime", "runtime-layout.json");

    expect(marker).toMatchObject({
      format: PI_RUNTIME_LAYOUT_FORMAT,
      version: PI_RUNTIME_LAYOUT_VERSION,
      backend: "pi",
    });
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual(marker);
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(dirname(markerPath)).mode & 0o777).toBe(0o700);
    expect(lstatSync(markerPath).mode & 0o777).toBe(0o600);
  });

  it("is idempotent and never rewrites an existing valid marker", () => {
    const root = fixture();
    const first = ensurePiRuntimeLayout(root);
    const markerPath = join(root, ".runtime", "runtime-layout.json");
    chmodSync(markerPath, 0o640);
    const before = readFileSync(markerPath, "utf8");
    const second = ensurePiRuntimeLayout(root);

    expect(second).toEqual(first);
    expect(readFileSync(markerPath, "utf8")).toBe(before);
    expect(lstatSync(markerPath).mode & 0o777).toBe(0o640);
  });

  it("initializes a root containing only an empty .runtime directory", () => {
    const root = fixture();
    mkdirSync(join(root, ".runtime"), { recursive: true });
    expect(inspectPiRuntimeLayout(root).state).toBe("initializable");
    ensurePiRuntimeLayout(root);
    expect(inspectPiRuntimeLayout(root).state).toBe("ready");
  });

  it("refuses a non-empty unmarked legacy root", () => {
    const root = fixture();
    mkdirSync(join(root, "user-a", "session-a", "workspace"), { recursive: true });
    expect(inspectPiRuntimeLayout(root)).toMatchObject({
      state: "migration-required",
      entries: ["user-a"],
    });
    expect(() => ensurePiRuntimeLayout(root)).toThrow(/pi-reset-legacy-sessions/);
    expect(existsSync(join(root, ".runtime", "runtime-layout.json"))).toBe(false);
  });

  it("refuses malformed, wrong-version, and extra-field markers", () => {
    for (const value of [
      "{",
      JSON.stringify({
        format: PI_RUNTIME_LAYOUT_FORMAT,
        version: 2,
        backend: "pi",
        createdAt: new Date().toISOString(),
      }),
      JSON.stringify({
        format: PI_RUNTIME_LAYOUT_FORMAT,
        version: 1,
        backend: "pi",
        createdAt: new Date().toISOString(),
        legacy: true,
      }),
      JSON.stringify({
        format: PI_RUNTIME_LAYOUT_FORMAT,
        version: 1,
        backend: "pi",
        createdAt: "2026-01-01",
      }),
    ]) {
      const root = fixture();
      mkdirSync(join(root, ".runtime"), { recursive: true });
      writeFileSync(join(root, ".runtime", "runtime-layout.json"), value);
      expect(inspectPiRuntimeLayout(root).state).toBe("invalid");
      expect(() => requirePiRuntimeLayout(root)).toThrow(/Invalid Pi runtime layout/);
    }
  });

  it("refuses symlinked roots, runtime directories, and marker files", () => {
    const parent = fixture("parent");
    mkdirSync(parent, { recursive: true });
    const target = join(parent, "target");
    mkdirSync(target);
    const alias = join(parent, "alias");
    symlinkSync(target, alias);
    expect(inspectPiRuntimeLayout(alias).state).toBe("invalid");

    const rootWithRuntimeAlias = join(parent, "runtime-alias-root");
    mkdirSync(rootWithRuntimeAlias);
    symlinkSync(target, join(rootWithRuntimeAlias, ".runtime"));
    expect(inspectPiRuntimeLayout(rootWithRuntimeAlias).state).toBe("invalid");

    const rootWithMarkerAlias = join(parent, "marker-alias-root");
    mkdirSync(join(rootWithMarkerAlias, ".runtime"), { recursive: true });
    const markerTarget = join(parent, "marker.json");
    writeFileSync(markerTarget, "{}");
    symlinkSync(markerTarget, join(rootWithMarkerAlias, ".runtime", "runtime-layout.json"));
    expect(inspectPiRuntimeLayout(rootWithMarkerAlias).state).toBe("invalid");
  });

  it("refuses a hard-linked runtime marker", () => {
    const root = fixture();
    ensurePiRuntimeLayout(root);
    const markerPath = join(root, ".runtime", "runtime-layout.json");
    linkSync(markerPath, join(dirname(root), "runtime-layout-copy.json"));

    expect(inspectPiRuntimeLayout(root)).toMatchObject({
      state: "invalid",
      reason: expect.stringContaining("singly-linked"),
    });
    expect(() => requirePiRuntimeLayout(root)).toThrow(/Invalid Pi runtime layout/);
  });

  it("refuses an absent root beneath a symbolic-link ancestor without creating it", () => {
    const parent = fixture("parent");
    mkdirSync(parent, { recursive: true });
    const target = join(parent, "target");
    mkdirSync(target);
    const alias = join(parent, "alias");
    symlinkSync(target, alias);
    const root = join(alias, "new-data");

    expect(inspectPiRuntimeLayout(root).state).toBe("invalid");
    expect(() => ensurePiRuntimeLayout(root)).toThrow(/symbolic-link/);
    expect(existsSync(join(target, "new-data"))).toBe(false);
  });

  it("requires explicit initialization even for an empty data root", () => {
    const root = fixture();
    expect(() => requirePiRuntimeLayout(root)).toThrow(/not initialized/);
    expect(existsSync(root)).toBe(false);
  });
});
