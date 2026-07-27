import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface OnlyOfficeRuntimeIdentity {
  packageVersion: string;
  hostBuildId: string;
  assetManifestDigest: string;
}

function readStringConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match?.[1]) {
    throw new Error(`OnlyOffice host source is missing ${name}`);
  }
  return match[1];
}

export async function readOnlyOfficeRuntimeIdentity(
  onlyOfficeBrowserDir: string,
): Promise<OnlyOfficeRuntimeIdentity> {
  const hostSource = await readFile(resolve(onlyOfficeBrowserDir, "src/office-host.ts"), "utf8");
  const assetManifest = await readFile(
    resolve(onlyOfficeBrowserDir, "dist/onlyoffice-runtime-assets.json"),
  );
  return {
    packageVersion: readStringConstant(hostSource, "OFFICE_BROWSER_PACKAGE_VERSION"),
    hostBuildId: readStringConstant(hostSource, "OFFICE_HOST_BUILD_ID"),
    assetManifestDigest: createHash("sha256").update(assetManifest).digest("hex"),
  };
}
