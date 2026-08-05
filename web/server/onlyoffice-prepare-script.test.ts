import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("retired OnlyOffice checkout preparation", () => {
  it("fails closed instead of cloning or building a browser runtime", () => {
    expect(() =>
      execFileSync("bash", ["scripts/ensure-onlyoffice-browser.sh"], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/retired/);
  });
});
