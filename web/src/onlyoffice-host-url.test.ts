import { describe, expect, it } from "vitest";
import {
  resolveOnlyOfficeAssetBaseUrl,
  resolvePiworkOnlyOfficeAssetBaseUrl,
  resolvePiworkOnlyOfficeHostUrl,
} from "./onlyoffice-host-url.js";

describe("OnlyOffice host URL", () => {
  it("maps editor instances onto the fixed constellation origin pool", () => {
    expect(
      resolvePiworkOnlyOfficeHostUrl({
        sessionId: "Office Editor First",
        hostSlot: "aries",
        fileName: "first.docx",
        fileType: "docx",
        mode: "preview",
      }),
    ).toBe("https://aries.getpi.work/office-host.html");
    expect(
      resolvePiworkOnlyOfficeHostUrl({
        sessionId: "office-editor-b6eale6c-f44a-4866-9f4d-a728513ba815",
        hostSlot: "gemini",
        fileName: "second.xlsx",
        fileType: "xlsx",
        mode: "edit",
      }),
    ).toBe("https://gemini.getpi.work/office-host.html");
  });

  it("uses the canonical production origin for all managed Office assets", () => {
    expect(resolvePiworkOnlyOfficeAssetBaseUrl()).toBe("https://onlyoffice.getpi.work/");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://libra.getpi.work/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://onlyoffice.getpi.work/");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://unrelated.example.com/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://piwork.getpi.work");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://office-editor-session.getpi.work/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://piwork.getpi.work");
  });

  it("pins new editor instances to the prepared immutable release", () => {
    expect(
      resolvePiworkOnlyOfficeHostUrl(
        {
          sessionId: "session-a",
          hostSlot: "pisces",
          fileName: "first.docx",
          fileType: "docx",
          mode: "edit",
        },
        "v0.4.0-release+1",
      ),
    ).toBe("https://pisces.getpi.work/r/v0.4.0-release%2B1/office-host.html");
  });

  it("rejects host slots outside the fixed constellation pool", () => {
    expect(() =>
      resolvePiworkOnlyOfficeHostUrl({
        sessionId: "session-a",
        hostSlot: "office-editor-session" as "aries",
        fileName: "first.docx",
        fileType: "docx",
        mode: "edit",
      }),
    ).toThrow("fixed constellation pool");
  });
});
