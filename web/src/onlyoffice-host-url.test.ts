import { describe, expect, it } from "vitest";
import {
  resolveOnlyOfficeAssetBaseUrl,
  resolvePiworkOnlyOfficeAssetBaseUrl,
  resolvePiworkOnlyOfficeHostUrl,
} from "./onlyoffice-host-url.js";

describe("OnlyOffice host URL", () => {
  it("always isolates editor instances on Cloudflare wildcard origins", () => {
    expect(
      resolvePiworkOnlyOfficeHostUrl({
        sessionId: "Office Editor First",
        fileName: "first.docx",
        fileType: "docx",
        mode: "preview",
      }),
    ).toBe("https://first.onlyoffice.getpi.work/office-host.html");
    expect(
      resolvePiworkOnlyOfficeHostUrl({
        sessionId: "office-editor-b6eale6c-f44a-4866-9f4d-a728513ba815",
        fileName: "second.xlsx",
        fileType: "xlsx",
        mode: "edit",
      }),
    ).toBe("https://b6eale6c-f44a-4866-9f4d-a728513ba815.onlyoffice.getpi.work/office-host.html");
  });

  it("uses the canonical production origin for all managed Office assets", () => {
    expect(resolvePiworkOnlyOfficeAssetBaseUrl()).toBe("https://onlyoffice.getpi.work/");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://session-a.onlyoffice.getpi.work/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://onlyoffice.getpi.work/");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://unrelated.example.com/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://piwork.getpi.work");
  });
});
