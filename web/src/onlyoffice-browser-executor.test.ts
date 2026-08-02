// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeEditorInstance } from "@agentbridges-ai/onlyoffice-browser";
import { ONLYOFFICE_PLUGIN_GUID } from "../shared/onlyoffice.js";
import { setUiCopyLanguage, uiCopy } from "./ui-copy.js";

const temporaryRuntime = vi.hoisted(() => ({
  executeUserSpaceOperation: vi.fn(),
  getUserSpaceFile: vi.fn(),
  saveUserSpaceFile: vi.fn(),
  mount: vi.fn(),
  planOfficeResourcesForFile: vi.fn(),
  applyOfficeResourcePlan: vi.fn(),
  officeResourcesReadyForRelease: vi.fn(),
}));

vi.mock("./user-space.js", () => ({
  executeUserSpaceOperation: temporaryRuntime.executeUserSpaceOperation,
  getUserSpaceFile: temporaryRuntime.getUserSpaceFile,
  saveUserSpaceFile: temporaryRuntime.saveUserSpaceFile,
}));

vi.mock("./office-host-adapter.js", () => ({
  officePreviewRuntimeManager: { mount: temporaryRuntime.mount },
}));

vi.mock("./office-runtime-resources.js", () => ({
  planOfficeResourcesForFile: temporaryRuntime.planOfficeResourcesForFile,
  applyOfficeResourcePlan: temporaryRuntime.applyOfficeResourcePlan,
  officeResourcesReadyForRelease: temporaryRuntime.officeResourcesReadyForRelease,
}));

vi.mock("./onlyoffice-host-url.js", () => ({
  resolvePiworkOnlyOfficeHostUrl: vi.fn(
    (context: { hostSlot: string }, releaseId?: string) =>
      `https://${context.hostSlot}.getpi.work${releaseId ? `/r/${releaseId}` : ""}/office-host.html`,
  ),
}));

import {
  attachOnlyOfficeTransport,
  handleOnlyOfficeBrowserRequest,
  registerOnlyOfficeEditor,
} from "./onlyoffice-browser-executor.js";
import { executeUserSpaceOperation } from "./user-space.js";

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  setUiCopyLanguage("zh-CN");
  temporaryRuntime.planOfficeResourcesForFile.mockResolvedValue({
    planId: "plan-test-release",
    releaseId: "test-release",
    scope: "document",
    profiles: ["base", "word"],
    totalBytes: 100,
    downloadBytes: 0,
    reusedBytes: 100,
  });
  temporaryRuntime.applyOfficeResourcePlan.mockResolvedValue(undefined);
  temporaryRuntime.officeResourcesReadyForRelease.mockReturnValue(true);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function editor(): OfficeEditorInstance {
  return {
    id: "editor-1",
    invokePlugin: vi.fn(async () => ({ text: "hello" })),
    save: vi.fn(async () => new File(["saved"], "Plan.docx")),
    confirmSaveToNewFormat: vi.fn(async () => true),
    setInterfaceTheme: vi.fn(),
    setReadonly: vi.fn(),
    destroy: vi.fn(async () => undefined),
    getState: () => ({
      id: "editor-1",
      fileName: "Plan.docx",
      fileType: "docx",
      mode: "edit",
      readonly: false,
      dirty: false,
      sourceKind: "local-file",
      status: "ready",
      destroyed: false,
    }),
    getHostIdentity: () => ({
      packageVersion: "0.3.30",
      hostBuildId: "office-host-0.3.30-r2",
      assetManifestDigest: "a".repeat(64),
    }),
  };
}

describe("ONLYOFFICE browser executor", () => {
  it("publishes an exact editor lease and rejects a mismatched assignment", async () => {
    const instance = editor();
    let status: Parameters<Parameters<typeof attachOnlyOfficeTransport>[1]>[0] | undefined;
    cleanups.push(attachOnlyOfficeTransport("session-1", (next) => (status = next)));
    const registration = registerOnlyOfficeEditor({
      sessionId: "session-1",
      instance,
      title: "Plan.docx",
      mountId: "mount-1",
      path: "Plan.docx",
      fileType: "docx",
      documentType: "word",
      writable: true,
      foreground: true,
    });
    cleanups.push(() => registration.dispose());
    expect(status?.document).toMatchObject({
      editorInstanceId: "editor-1",
      leaseId: expect.any(String),
    });

    registration.updateDocument({
      title: "Renamed.docx",
      mountId: "mount-1",
      path: "archive/Renamed.docx",
      fileType: "docx",
      documentType: "word",
      writable: false,
      foreground: true,
    });
    expect(status?.document).toMatchObject({
      title: "Renamed.docx",
      path: "archive/Renamed.docx",
      writable: false,
      editorInstanceId: "editor-1",
      leaseId: expect.any(String),
    });

    const responses: unknown[] = [];
    await handleOnlyOfficeBrowserRequest(
      "session-1",
      {
        type: "onlyoffice_request",
        request_id: "wrong-lease",
        lease_id: "not-the-lease",
        editor_instance_id: "editor-1",
        operation: { type: "get_document_text" },
      },
      (response) => responses.push(response),
    );
    expect(responses).toEqual([
      expect.objectContaining({ ok: false, error: expect.stringContaining("lease") }),
    ]);
    expect(instance.invokePlugin).not.toHaveBeenCalled();
  });

  it("executes duplicate request ids once and replays the cached result", async () => {
    const instance = editor();
    let leaseId = "";
    cleanups.push(
      attachOnlyOfficeTransport("session-2", (status) => {
        leaseId = status.document?.leaseId || leaseId;
      }),
    );
    const registration = registerOnlyOfficeEditor({
      sessionId: "session-2",
      instance,
      title: "Plan.docx",
      mountId: "mount-1",
      path: "Plan.docx",
      fileType: "docx",
      documentType: "word",
      writable: true,
      foreground: true,
    });
    cleanups.push(() => registration.dispose());
    const request = {
      type: "onlyoffice_request" as const,
      request_id: "same-id",
      lease_id: leaseId,
      editor_instance_id: "editor-1",
      operation: { type: "get_document_text" as const },
    };
    const responses: unknown[] = [];
    await handleOnlyOfficeBrowserRequest("session-2", request, (response) =>
      responses.push(response),
    );
    await handleOnlyOfficeBrowserRequest("session-2", request, (response) =>
      responses.push(response),
    );

    expect(instance.invokePlugin).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(2);
    expect(responses).toEqual([
      expect.objectContaining({ ok: true, result: { text: "hello" } }),
      expect.objectContaining({ ok: true, result: { text: "hello" } }),
    ]);
  });

  it("opens an unopened target in a temporary editor and always closes it after reading", async () => {
    const instance = editor();
    const dispose = vi.fn(async () => undefined);
    temporaryRuntime.getUserSpaceFile.mockResolvedValue(
      new File(["source"], "Unopened.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    temporaryRuntime.mount.mockImplementation(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        queueMicrotask(() => {
          const onPluginReady = options.onPluginReady as
            ((guid: string, editorType: string, editor: OfficeEditorInstance) => void) | undefined;
          onPluginReady?.(ONLYOFFICE_PLUGIN_GUID, "word", instance);
        });
        return { ready: Promise.resolve(instance), dispose };
      },
    );
    const responses: unknown[] = [];

    await handleOnlyOfficeBrowserRequest(
      "session-unopened",
      {
        type: "onlyoffice_request",
        request_id: "read-unopened",
        target: { mountId: "mount-1", path: "folder/Unopened.docx", closeAfter: true },
        operation: { type: "get_document_text" },
      },
      (response) => responses.push(response),
    );

    expect(temporaryRuntime.getUserSpaceFile).toHaveBeenCalledWith(
      "mount-1",
      "folder/Unopened.docx",
    );
    expect(temporaryRuntime.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        fileName: "Unopened.docx",
        mode: "readonly",
        readonly: true,
        plugins: {
          configUrls: ["/onlyoffice-plugin/config.json"],
          autostart: [ONLYOFFICE_PLUGIN_GUID],
        },
      }),
    );
    const hostUrl = temporaryRuntime.mount.mock.calls[0]?.[1]?.hostUrl as
      ((context: { hostSlot: string }) => string) | undefined;
    expect(hostUrl?.({ hostSlot: "aries" })).toBe(
      "https://aries.getpi.work/r/test-release/office-host.html",
    );
    expect(instance.invokePlugin).toHaveBeenCalledWith(ONLYOFFICE_PLUGIN_GUID, {
      type: "get_document_text",
    });
    expect(responses).toEqual([expect.objectContaining({ ok: true, result: { text: "hello" } })]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(document.querySelector('[style*="-100000px"]')).toBeNull();
  });

  it("activates a zero-download resource plan before mounting a temporary editor", async () => {
    const instance = editor();
    temporaryRuntime.getUserSpaceFile.mockResolvedValue(new File(["source"], "Ready.docx"));
    temporaryRuntime.officeResourcesReadyForRelease
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    temporaryRuntime.mount.mockImplementation(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        queueMicrotask(() => {
          const onPluginReady = options.onPluginReady as
            ((guid: string, editorType: string, editor: OfficeEditorInstance) => void) | undefined;
          onPluginReady?.(ONLYOFFICE_PLUGIN_GUID, "word", instance);
        });
        return { ready: Promise.resolve(instance), dispose: vi.fn(async () => undefined) };
      },
    );

    await handleOnlyOfficeBrowserRequest(
      "session-activation",
      {
        type: "onlyoffice_request",
        request_id: "activate-before-mount",
        target: { mountId: "mount-1", path: "Ready.docx" },
        operation: { type: "get_document_text" },
      },
      () => undefined,
    );

    expect(temporaryRuntime.applyOfficeResourcePlan).toHaveBeenCalledOnce();
    expect(temporaryRuntime.applyOfficeResourcePlan.mock.invocationCallOrder[0]).toBeLessThan(
      temporaryRuntime.mount.mock.invocationCallOrder[0]!,
    );
  });

  it("fails closed when resource activation does not make the release ready", async () => {
    setUiCopyLanguage("en-US");
    temporaryRuntime.getUserSpaceFile.mockResolvedValue(new File(["source"], "Blocked.docx"));
    temporaryRuntime.officeResourcesReadyForRelease.mockReturnValue(false);
    const responses: unknown[] = [];

    await handleOnlyOfficeBrowserRequest(
      "session-blocked",
      {
        type: "onlyoffice_request",
        request_id: "blocked-before-mount",
        target: { mountId: "mount-1", path: "Blocked.docx" },
        operation: { type: "get_document_text" },
      },
      (response) => responses.push(response),
    );

    expect(temporaryRuntime.applyOfficeResourcePlan).toHaveBeenCalledOnce();
    expect(temporaryRuntime.mount).not.toHaveBeenCalled();
    expect(responses).toEqual([
      expect.objectContaining({ ok: false, error: uiCopy.userSpace.office.resourcesNotReady }),
    ]);
  });

  it("migrates legacy temporary targets before deleting the source", async () => {
    const instance = editor();
    const savedFile = new File(["updated"], "legacy.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    let saveCallback: ((file: File) => Promise<boolean>) | undefined;
    instance.save = vi.fn(async () => {
      await saveCallback?.(savedFile);
      return savedFile;
    });
    temporaryRuntime.getUserSpaceFile.mockResolvedValue(
      new File(["source"], "legacy.xls", { type: "application/vnd.ms-excel" }),
    );
    temporaryRuntime.mount.mockImplementation(
      (_container: HTMLElement, options: Record<string, unknown>) => {
        saveCallback = options.onSave as (file: File) => Promise<boolean>;
        queueMicrotask(() => {
          const onPluginReady = options.onPluginReady as
            ((guid: string, editorType: string, editor: OfficeEditorInstance) => void) | undefined;
          onPluginReady?.(ONLYOFFICE_PLUGIN_GUID, "cell", instance);
        });
        return { ready: Promise.resolve(instance), dispose: vi.fn(async () => undefined) };
      },
    );

    await handleOnlyOfficeBrowserRequest(
      "session-legacy",
      {
        type: "onlyoffice_request",
        request_id: "write-legacy",
        target: { mountId: "mount-1", path: "legacy.xls" },
        operation: { type: "append_text", text: "updated", trackChanges: true },
      },
      () => undefined,
    );

    expect(temporaryRuntime.saveUserSpaceFile).toHaveBeenCalledWith(
      "mount-1",
      "legacy_xls.xlsx",
      savedFile,
      { create: true },
    );
    expect(temporaryRuntime.saveUserSpaceFile).not.toHaveBeenCalledWith(
      "mount-1",
      "legacy.xls",
      savedFile,
    );
    expect(executeUserSpaceOperation).toHaveBeenCalledWith("delete_entry", {
      mountId: "mount-1",
      path: "legacy.xls",
    });
  });
});
