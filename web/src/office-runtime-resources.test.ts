// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => {
  const resources = {
    progress: {
      phase: "ready" as const,
      completedFiles: 1,
      totalFiles: 2,
      completedBytes: 4,
      totalBytes: 8,
      failedFiles: 0,
      categories: [],
    },
    fonts: [
      {
        id: "dengxian",
        name: "DengXian",
        bytes: 4,
        paths: ["fonts/dengxian.ttf"],
        downloaded: true,
        removable: false,
      },
      {
        id: "microsoft yahei",
        name: "Microsoft YaHei",
        bytes: 4,
        paths: ["fonts/yahei.ttf"],
        downloaded: false,
        removable: true,
      },
    ],
    verifiedFontPaths: ["fonts/dengxian.ttf"],
    operation: null,
    error: null,
  };
  const manager = {
    getSnapshot: vi.fn(() => resources),
    subscribe: vi.fn(() => () => undefined),
    getVerifiedFontPaths: vi.fn(() => [...resources.verifiedFontPaths]),
    remainingBytes: vi.fn(() => 4),
    loadAll: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => undefined),
    downloadFontFamily: vi.fn(async () => undefined),
    uninstallFontFamily: vi.fn(async () => undefined),
  };
  return {
    resources,
    manager,
    create: vi.fn(async () => manager),
  };
});

vi.mock("@agentbridges-ai/onlyoffice-browser", () => ({
  createOfficeRuntimeResourceManager: runtimeMock.create,
}));

import {
  downloadOfficeFontFamily,
  ensureOfficeResources,
  getOfficeResourceSnapshot,
  getVerifiedOfficeFontPaths,
  loadAllOfficeResources,
  requestOfficeResourceSettings,
  resetOfficeResourcesForTests,
  subscribeOfficeResourceSettingsRequests,
} from "./office-runtime-resources.js";

describe("Piwork Office resource state", () => {
  beforeEach(() => {
    resetOfficeResourcesForTests();
    runtimeMock.create.mockClear();
    runtimeMock.manager.loadAll.mockClear();
    runtimeMock.manager.downloadFontFamily.mockClear();
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persist: vi.fn(async () => true),
        estimate: vi.fn(async () => ({ quota: 100, usage: 10 })),
      },
    });
  });

  it("lazily coalesces initialization and exposes verified font paths", async () => {
    const first = ensureOfficeResources();
    const second = ensureOfficeResources();

    await expect(first).resolves.toBe(runtimeMock.manager);
    await expect(second).resolves.toBe(runtimeMock.manager);
    expect(runtimeMock.create).toHaveBeenCalledTimes(1);
    expect(runtimeMock.create).toHaveBeenCalledWith({
      assetBaseUrl: expect.stringContaining("assets.office.localhost"),
    });
    expect(getOfficeResourceSnapshot().status).toBe("ready");
    expect(getVerifiedOfficeFontPaths()).toEqual(["fonts/dengxian.ttf"]);
  });

  it("checks available browser storage before downloading resources or fonts", async () => {
    await loadAllOfficeResources();
    await downloadOfficeFontFamily("microsoft yahei");

    expect(runtimeMock.manager.loadAll).toHaveBeenCalledTimes(1);
    expect(runtimeMock.manager.downloadFontFamily).toHaveBeenCalledWith("microsoft yahei");

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persist: vi.fn(async () => false),
        estimate: vi.fn(async () => ({ quota: 10, usage: 9 })),
      },
    });
    await expect(loadAllOfficeResources()).rejects.toThrow("Insufficient browser storage");
    expect(getOfficeResourceSnapshot().error).toMatchObject({
      code: "insufficient-storage",
      availableBytes: 1,
      requiredBytes: 4,
    });
  });

  it("opens the settings surface through the resource request channel", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfficeResourceSettingsRequests(listener);

    requestOfficeResourceSettings();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    requestOfficeResourceSettings();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
