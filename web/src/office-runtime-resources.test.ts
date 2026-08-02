// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import releaseDescriptor from "../../release/onlyoffice-release-manifest.json";

const runtimeMock = vi.hoisted(() => {
  const resources = {
    packageVersion: "0.4.0",
    assetVersion: "assets-v1",
    readiness: "needs-download" as const,
    packs: [
      { id: "fonts" as const, ready: true, completedBytes: 4, totalBytes: 4 },
      { id: "core" as const, ready: true, completedBytes: 4, totalBytes: 4 },
      { id: "word" as const, ready: false, completedBytes: 0, totalBytes: 4 },
    ],
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
    installedRelease: "release-v3",
    targetRelease: "release-v3",
    availableRelease: "release-v3",
    phase: "idle" as const,
    operation: null,
    error: null,
  };
  const manager = {
    getSnapshot: vi.fn(() => resources),
    subscribe: vi.fn((_listener: (resources: unknown) => void) => () => undefined),
    getVerifiedFontPaths: vi.fn(() => [...resources.verifiedFontPaths]),
    remainingBytes: vi.fn(() => 4),
    loadAll: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => undefined),
    repair: vi.fn(async () => undefined),
    plan: vi.fn(async (request: { documentType: "word" | "cell" | "slide" }) => ({
      planId: `plan-${request.documentType}`,
      releaseId: "release-v3",
      scope: "document" as const,
      profiles: ["base", request.documentType],
      totalBytes: 4,
      downloadBytes: 4,
      reusedBytes: 0,
    })),
    apply: vi.fn(async () => undefined),
    prepareForDocumentType: vi.fn(async () => undefined),
    installFontPreset: vi.fn(async () => undefined),
    downloadFontFamily: vi.fn(async () => undefined),
    uninstallFontFamily: vi.fn(async () => undefined),
    pause: vi.fn(),
    resume: vi.fn(async () => undefined),
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
  applyOfficeResourcePlan,
  checkAndRepairOfficeResources,
  ensureOfficeResources,
  getOfficeResourceSnapshot,
  getTargetOfficeReleaseId,
  getVerifiedOfficeFontPaths,
  installOfficeFontPreset,
  loadAllOfficeResources,
  officeResourcesNeedAttention,
  officeResourcesReadyForRelease,
  pauseOfficeResources,
  planOfficeResourcesForFile,
  prepareOfficeResourcesForFile,
  requestOfficeResourceSettings,
  resetOfficeResourcesForTests,
  resumeOfficeResources,
  subscribeOfficeResources,
  subscribeOfficeResourceSettingsRequests,
  uninstallOfficeFontFamily,
} from "./office-runtime-resources.js";

describe("Piwork Office resource state", () => {
  beforeEach(() => {
    resetOfficeResourcesForTests();
    runtimeMock.create.mockClear();
    runtimeMock.manager.getSnapshot.mockClear();
    runtimeMock.manager.getSnapshot.mockImplementation(() => runtimeMock.resources);
    runtimeMock.manager.loadAll.mockClear();
    runtimeMock.manager.downloadFontFamily.mockClear();
    runtimeMock.manager.plan.mockClear();
    runtimeMock.manager.apply.mockClear();
    runtimeMock.manager.installFontPreset.mockClear();
    runtimeMock.manager.repair.mockClear();
    runtimeMock.manager.uninstallFontFamily.mockClear();
    runtimeMock.manager.pause.mockClear();
    runtimeMock.manager.resume.mockClear();
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persist: vi.fn(async () => true),
        estimate: vi.fn(async () => ({ quota: 100, usage: 10 })),
      },
    });
  });

  it("lazily coalesces initialization and exposes verified font paths", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOfficeResources(listener);
    const first = ensureOfficeResources();
    const second = ensureOfficeResources();

    await expect(first).resolves.toBe(runtimeMock.manager);
    await expect(second).resolves.toBe(runtimeMock.manager);
    expect(runtimeMock.create).toHaveBeenCalledTimes(1);
    expect(runtimeMock.create).toHaveBeenCalledWith({
      assetBaseUrl: "https://onlyoffice.getpi.work/",
      requiredReleaseIdentity: {
        releaseId: releaseDescriptor.releaseManifest.releaseId,
        manifestSha256: releaseDescriptor.releaseManifest.sha256,
        packageVersion: releaseDescriptor.runtimeIdentity.packageVersion,
        hostBuildId: releaseDescriptor.runtimeIdentity.hostBuildId,
      },
    });
    expect(getOfficeResourceSnapshot().status).toBe("ready");
    expect(getVerifiedOfficeFontPaths()).toEqual(["fonts/dengxian.ttf"]);
    expect(getTargetOfficeReleaseId()).toBe("release-v3");
    expect(officeResourcesReadyForRelease("release-v3")).toBe(false);
    unsubscribe();
  });

  it("publishes a structured error when manager initialization fails", async () => {
    runtimeMock.create.mockRejectedValueOnce(new Error("manifest unavailable"));

    await expect(ensureOfficeResources()).rejects.toThrow("manifest unavailable");
    expect(getOfficeResourceSnapshot()).toEqual({
      status: "error",
      resources: null,
      error: { code: "initialization-failed" },
    });
  });

  it("fails closed when a stale optimized dependency returns an incomplete snapshot", async () => {
    runtimeMock.manager.getSnapshot.mockReturnValueOnce({
      ...runtimeMock.resources,
      packs: undefined,
    } as unknown as typeof runtimeMock.resources);

    await ensureOfficeResources();

    expect(getOfficeResourceSnapshot()).toEqual({
      status: "error",
      resources: null,
      error: { code: "initialization-failed" },
    });
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

  it("prepares only the resource pack matching the opened document", async () => {
    await prepareOfficeResourcesForFile("budget.xlsx");
    await prepareOfficeResourcesForFile("brief.docx");
    await prepareOfficeResourcesForFile("deck.pptx");

    expect(runtimeMock.manager.plan).toHaveBeenNthCalledWith(1, {
      scope: "document",
      documentType: "cell",
    });
    expect(runtimeMock.manager.plan).toHaveBeenNthCalledWith(2, {
      scope: "document",
      documentType: "word",
    });
    expect(runtimeMock.manager.plan).toHaveBeenNthCalledWith(3, {
      scope: "document",
      documentType: "slide",
    });
    expect(runtimeMock.manager.apply).toHaveBeenCalledTimes(3);
  });

  it("plans and applies one document plan and exposes the target release", async () => {
    const plan = await planOfficeResourcesForFile("budget.ods");
    await applyOfficeResourcePlan(plan);

    expect(plan).toMatchObject({ releaseId: "release-v3", profiles: ["base", "cell"] });
    expect(runtimeMock.manager.apply).toHaveBeenCalledWith(plan);

    vi.mocked(runtimeMock.manager.getSnapshot).mockReturnValueOnce({
      ...runtimeMock.resources,
      targetRelease: "release-v3",
    } as never);
    expect(getTargetOfficeReleaseId()).toBe("release-v3");
  });

  it("routes resource actions to the manager and reports whether required packs need attention", async () => {
    await installOfficeFontPreset("office-compatibility");
    await checkAndRepairOfficeResources();
    await uninstallOfficeFontFamily("microsoft yahei");
    await pauseOfficeResources();
    await resumeOfficeResources();

    expect(runtimeMock.manager.installFontPreset).toHaveBeenCalledWith("office-compatibility");
    expect(runtimeMock.manager.repair).toHaveBeenCalledWith({ scope: "installed" });
    expect(runtimeMock.manager.uninstallFontFamily).toHaveBeenCalledWith("microsoft yahei");
    expect(runtimeMock.manager.pause).toHaveBeenCalledOnce();
    expect(runtimeMock.manager.resume).toHaveBeenCalledOnce();
    expect(officeResourcesNeedAttention()).toBe(false);

    const publishManagerSnapshot = runtimeMock.manager.subscribe.mock.calls.at(-1)?.[0] as (
      resources: typeof runtimeMock.resources,
    ) => void;
    publishManagerSnapshot({
      ...runtimeMock.resources,
      packs: runtimeMock.resources.packs.map((pack) =>
        pack.id === "core" ? { ...pack, ready: false } : pack,
      ),
    });
    expect(officeResourcesNeedAttention()).toBe(true);
  });

  it("surfaces manager failures with operation-specific structured codes", async () => {
    runtimeMock.manager.loadAll.mockRejectedValueOnce(new Error("download failed"));
    await expect(loadAllOfficeResources()).rejects.toThrow("download failed");
    expect(getOfficeResourceSnapshot().error).toEqual({ code: "network" });

    resetOfficeResourcesForTests();
    runtimeMock.manager.repair.mockRejectedValueOnce(new Error("repair failed"));
    vi.mocked(runtimeMock.manager.getSnapshot).mockReturnValue({
      ...runtimeMock.resources,
      error: null,
    });
    vi.mocked(runtimeMock.manager.getSnapshot)
      .mockReturnValueOnce(runtimeMock.resources)
      .mockReturnValueOnce({
        ...runtimeMock.resources,
        error: { code: "integrity" },
      } as never);
    await expect(checkAndRepairOfficeResources()).rejects.toThrow("repair failed");
    expect(getOfficeResourceSnapshot().error).toEqual({ code: "integrity" });

    resetOfficeResourcesForTests();
    runtimeMock.manager.uninstallFontFamily.mockRejectedValueOnce(new Error("remove failed"));
    await expect(uninstallOfficeFontFamily("microsoft yahei")).rejects.toThrow("remove failed");
    expect(getOfficeResourceSnapshot().error).toEqual({ code: "storage" });
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
