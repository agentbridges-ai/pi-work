import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOnlyOfficeSharedAssetCorsHeaders,
  applyOnlyOfficeHostResponseHeaders,
  contentTypeForOnlyOfficeAsset,
  isOnlyOfficeBrowserAssetPath,
  isOnlyOfficeHostRequestHost,
  isOnlyOfficePrintPdfPath,
} from "./onlyoffice-runtime-assets";

describe("OnlyOffice runtime asset routing", () => {
  it("opts the isolated host document into an origin-keyed agent cluster", () => {
    const hostHeaders = applyOnlyOfficeHostResponseHeaders("/office-host.html", new Headers());
    const assetHeaders = applyOnlyOfficeHostResponseHeaders(
      "/assets/officeHost-test.js",
      new Headers(),
    );

    expect(hostHeaders.get("Origin-Agent-Cluster")).toBe("?1");
    expect(assetHeaders.has("Origin-Agent-Cluster")).toBe(false);
  });

  it("recognizes static runtime and font asset paths", () => {
    expect(isOnlyOfficeBrowserAssetPath("/office-host.html")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/web-apps/apps/api/documents/api.js")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/onlyoffice-browser-font-assets.json")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/onlyoffice-browser-font-source-map.json")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/onlyoffice-runtime-assets.json")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/onlyoffice-plugin/config.json")).toBe(true);
    expect(isOnlyOfficeBrowserAssetPath("/fonts/MesloLGS-Regular.woff2")).toBe(false);
    expect(isOnlyOfficeBrowserAssetPath("/__onlyoffice-browser-print__/print-1.pdf")).toBe(false);
    expect(isOnlyOfficePrintPdfPath("/__onlyoffice-browser-print__/print-1.pdf")).toBe(true);
  });

  it("allows isolated editor hosts to read shared static resources without opening host pages", () => {
    const fontHeaders = applyOnlyOfficeSharedAssetCorsHeaders("/fonts/019.ttf", new Headers());
    const runtimeHeaders = applyOnlyOfficeSharedAssetCorsHeaders(
      "/onlyoffice-runtime-assets.json",
      new Headers(),
    );
    const hostHeaders = applyOnlyOfficeSharedAssetCorsHeaders("/office-host.html", new Headers());

    expect(fontHeaders.get("Access-Control-Allow-Origin")).toBe("*");
    expect(runtimeHeaders.get("Access-Control-Allow-Origin")).toBe("*");
    expect(hostHeaders.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("routes generated OnlyOffice host chunks only when they exist locally", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-onlyoffice-assets-"));
    try {
      mkdirSync(join(root, "assets"));
      writeFileSync(join(root, "assets", "converter-test.js"), "export {};", { flag: "wx" });
    } catch {
      rmSync(root, { force: true, recursive: true });
      throw new Error("Failed to prepare test fixture");
    }

    try {
      expect(
        isOnlyOfficeBrowserAssetPath("/assets/converter-test.js", { localAssetRoots: [root] }),
      ).toBe(true);
      expect(
        isOnlyOfficeBrowserAssetPath("/assets/officeHost-test.js", { localAssetRoots: [root] }),
      ).toBe(false);
      expect(
        isOnlyOfficeBrowserAssetPath("/assets/index-test.js", { localAssetRoots: [root] }),
      ).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("allows known OnlyOffice host chunks from a configured remote asset base", () => {
    expect(
      isOnlyOfficeBrowserAssetPath("/assets/converter-test.js", { assetBaseConfigured: true }),
    ).toBe(true);
    expect(
      isOnlyOfficeBrowserAssetPath("/assets/office-host-protocol-test.js", {
        assetBaseConfigured: true,
      }),
    ).toBe(true);
    expect(
      isOnlyOfficeBrowserAssetPath("/assets/index-test.js", { assetBaseConfigured: true }),
    ).toBe(false);
  });

  it("returns JavaScript content type for host chunks", () => {
    expect(contentTypeForOnlyOfficeAsset("/assets/converter-test.js")).toBe(
      "text/javascript; charset=utf-8",
    );
  });

  it("recognizes isolated OnlyOffice host request hosts", () => {
    expect(isOnlyOfficeHostRequestHost("host-office-editor-1-abc.office.localhost:3458")).toBe(
      true,
    );
    expect(isOnlyOfficeHostRequestHost("host-office-editor-1-abc.localhost:3458")).toBe(true);
    expect(isOnlyOfficeHostRequestHost("host.localhost:4173")).toBe(true);
    expect(isOnlyOfficeHostRequestHost("office-editor-1.office-host.example.com")).toBe(true);
    expect(isOnlyOfficeHostRequestHost("localhost:3458")).toBe(false);
    expect(isOnlyOfficeHostRequestHost("agent.office.example.com")).toBe(false);
  });
});
