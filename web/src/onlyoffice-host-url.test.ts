import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveDefaultPiworkOnlyOfficeHostUrl,
  resolveOnlyOfficeAssetBaseUrl,
} from "./onlyoffice-host-url.js";
import { setUiCopyLanguage } from "./ui-copy.js";

beforeEach(() => {
  setUiCopyLanguage("zh-CN");
});

afterEach(() => {
  setUiCopyLanguage("zh-CN");
});

describe("OnlyOffice host URL", () => {
  it("isolates successive editor instances on different host origins", () => {
    const location = new URL("https://workspace.internal.example/workspace");

    expect(resolveDefaultPiworkOnlyOfficeHostUrl(location, "office-editor-first")).toBe(
      "https://office-editor-first.office-host.workspace.internal.example/office-host.html",
    );
    expect(resolveDefaultPiworkOnlyOfficeHostUrl(location, "office-editor-second")).toBe(
      "https://office-editor-second.office-host.workspace.internal.example/office-host.html",
    );
  });

  it("requires an explicit reachable host for remote IPv4 and IPv6 deployments", () => {
    expect(() =>
      resolveDefaultPiworkOnlyOfficeHostUrl(
        new URL("http://10.120.120.6:5173"),
        "office-editor-ipv4",
      ),
    ).toThrow("通过远程 IP 打开 Office 文件需要配置 VITE_PIWORK_ONLYOFFICE_HOST_URL_TEMPLATE");

    setUiCopyLanguage("en-US");
    expect(() =>
      resolveDefaultPiworkOnlyOfficeHostUrl(
        new URL("http://[2001:db8::1]:5173"),
        "office-editor-ipv6",
      ),
    ).toThrow(
      "Opening Office files from a remote IP requires VITE_PIWORK_ONLYOFFICE_HOST_URL_TEMPLATE",
    );
  });

  it("keeps localhost development on a per-editor origin", () => {
    expect(
      resolveDefaultPiworkOnlyOfficeHostUrl(
        new URL("http://app.localhost:5173/workspace"),
        "office-editor-local",
      ),
    ).toBe("http://host-office-editor-local.office.localhost:5173/office-host.html");
  });

  it("maps isolated editor hosts to their shared static asset origin", () => {
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("http://host-office-editor-local.office.localhost:3458/office-host.html"),
        "http://127.0.0.1:3458",
      ),
    ).toBe("http://assets.office.localhost:3458/");
    expect(
      resolveOnlyOfficeAssetBaseUrl(
        new URL("https://office-session-a.getpi.work/office-host.html"),
        "https://piwork.getpi.work",
      ),
    ).toBe("https://onlyoffice.getpi.work/");
  });
});
