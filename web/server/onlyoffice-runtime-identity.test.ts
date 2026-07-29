import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOnlyOfficeRuntimeIdentity } from "./onlyoffice-runtime-identity.js";

describe("readOnlyOfficeRuntimeIdentity", () => {
  it("derives the development identity from an explicit OnlyOffice checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-onlyoffice-identity-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(
      join(root, "src/office-host.ts"),
      [
        "const OFFICE_BROWSER_PACKAGE_VERSION = '0.3.32';",
        "const OFFICE_HOST_BUILD_ID = 'office-host-0.3.32-r1';",
      ].join("\n"),
    );
    await writeFile(join(root, "dist/onlyoffice-runtime-assets.json"), "{}\n");

    await expect(readOnlyOfficeRuntimeIdentity(root)).resolves.toEqual({
      packageVersion: "0.3.32",
      hostBuildId: "office-host-0.3.32-r1",
      assetManifestDigest: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    });
  });
});
