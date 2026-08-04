import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("retired OnlyOffice font preparation", () => {
  it("fails closed instead of generating or copying fonts into Piwork", () => {
    expect(() =>
      execFileSync("bash", ["scripts/prepare-onlyoffice-fonts.sh"], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/retired/);
  });
});
