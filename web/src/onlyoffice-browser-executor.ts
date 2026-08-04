import type { OfficeEditorInstance } from "@agentbridges-ai/onlyoffice-browser";
import {
  ONLYOFFICE_PLUGIN_GUID,
  isOnlyOfficeWriteOperation,
  type OnlyOfficeBrowserRequest,
  type OnlyOfficeBrowserResponse,
  type OnlyOfficeBrowserStatus,
  type OnlyOfficeDocumentDescriptor,
  type OnlyOfficeDocumentType,
} from "../shared/onlyoffice.js";
import { uiCopy } from "./ui-copy.js";
import { executeUserSpaceOperation, getUserSpaceFile, saveUserSpaceFile } from "./user-space.js";

const COMPLETED_REQUEST_LIMIT = 512;
const PLUGIN_CONFIG_URL = "/onlyoffice-plugin/config.json";

type EditorRegistration = {
  sessionId: string;
  leaseId: string;
  instance: OfficeEditorInstance;
  document: Omit<OnlyOfficeDocumentDescriptor, "leaseId" | "editorInstanceId" | "pluginReady">;
  updatedAt: number;
};

export type OnlyOfficeEditorRegistration = {
  setForeground(foreground: boolean): void;
  updateDocument(
    document: Omit<OnlyOfficeDocumentDescriptor, "leaseId" | "editorInstanceId" | "pluginReady">,
  ): void;
  dispose(): void;
};

const editors = new Map<string, EditorRegistration>();
const transports = new Map<string, (message: OnlyOfficeBrowserStatus) => void>();
const completed = new Map<string, Promise<unknown>>();

function createId(): string {
  return globalThis.crypto.randomUUID();
}

function editorKey(sessionId: string, leaseId: string): string {
  return `${sessionId}\0${leaseId}`;
}

function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

function activeEditor(sessionId: string): EditorRegistration | null {
  return (
    [...editors.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort(
        (left, right) =>
          Number(right.document.foreground) - Number(left.document.foreground) ||
          right.updatedAt - left.updatedAt,
      )[0] ?? null
  );
}

function publishStatus(sessionId: string): void {
  const transport = transports.get(sessionId);
  if (!transport) return;
  const record = activeEditor(sessionId);
  transport({
    type: "onlyoffice_status",
    document: record
      ? {
          ...record.document,
          leaseId: record.leaseId,
          editorInstanceId: record.instance.id,
          pluginReady: true,
        }
      : null,
  });
}

export function attachOnlyOfficeTransport(
  sessionId: string,
  transport: (message: OnlyOfficeBrowserStatus) => void,
): () => void {
  transports.set(sessionId, transport);
  publishStatus(sessionId);
  return () => {
    if (transports.get(sessionId) === transport) transports.delete(sessionId);
  };
}

export function registerOnlyOfficeEditor(input: {
  sessionId: string;
  instance: OfficeEditorInstance;
  title: string;
  mountId: string;
  path: string;
  fileType: string;
  documentType: OnlyOfficeDocumentType;
  writable: boolean;
  foreground: boolean;
}): OnlyOfficeEditorRegistration {
  const leaseId = createId();
  const key = editorKey(input.sessionId, leaseId);
  const record: EditorRegistration = {
    sessionId: input.sessionId,
    leaseId,
    instance: input.instance,
    document: {
      title: input.title,
      mountId: input.mountId,
      path: input.path,
      fileType: input.fileType,
      documentType: input.documentType,
      writable: input.writable,
      foreground: input.foreground,
    },
    updatedAt: Date.now(),
  };
  editors.set(key, record);
  publishStatus(input.sessionId);
  return {
    setForeground(foreground) {
      if (editors.get(key) !== record) return;
      record.document.foreground = foreground;
      record.updatedAt = Date.now();
      publishStatus(input.sessionId);
    },
    updateDocument(document) {
      if (editors.get(key) !== record) return;
      record.document = document;
      record.updatedAt = Date.now();
      publishStatus(input.sessionId);
    },
    dispose() {
      if (editors.get(key) !== record) return;
      editors.delete(key);
      publishStatus(input.sessionId);
    },
  };
}

export async function handleOnlyOfficeBrowserRequest(
  sessionId: string,
  request: OnlyOfficeBrowserRequest,
  respond: (response: OnlyOfficeBrowserResponse) => void,
): Promise<void> {
  const key = requestKey(sessionId, request.request_id);
  let operation = completed.get(key);
  if (!operation) {
    operation = executeRequest(sessionId, request);
    completed.set(key, operation);
    while (completed.size > COMPLETED_REQUEST_LIMIT) {
      const oldest = completed.keys().next().value as string | undefined;
      if (!oldest) break;
      completed.delete(oldest);
    }
  }
  try {
    respond({
      type: "onlyoffice_response",
      request_id: request.request_id,
      ok: true,
      result: await operation,
    });
  } catch (error) {
    respond({
      type: "onlyoffice_response",
      request_id: request.request_id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeRequest(
  sessionId: string,
  request: OnlyOfficeBrowserRequest,
): Promise<unknown> {
  if (request.target) {
    const existing = [...editors.values()].find(
      (record) =>
        record.sessionId === sessionId &&
        record.document.mountId === request.target!.mountId &&
        record.document.path === request.target!.path,
    );
    if (existing) return invokeOnEditor(existing, request);
    return invokeOnTemporaryEditor(sessionId, request);
  }

  const record = [...editors.values()].find(
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.leaseId === request.lease_id &&
      candidate.instance.id === request.editor_instance_id,
  );
  if (!record) throw new Error("The assigned Office editor lease is no longer active.");
  return invokeOnEditor(record, request);
}

async function invokeOnEditor(
  record: EditorRegistration,
  request: OnlyOfficeBrowserRequest,
): Promise<unknown> {
  const writing = isOnlyOfficeWriteOperation(request.operation);
  if (writing && !record.document.writable) throw new Error("The Office file is read-only.");
  if (request.operation.type === "save_document") {
    const saved = await record.instance.save();
    return { saved: true, fileName: saved.name, size: saved.size };
  }
  const result = await record.instance.invokePlugin(ONLYOFFICE_PLUGIN_GUID, request.operation);
  if (writing) await record.instance.save();
  return result;
}

async function invokeOnTemporaryEditor(
  sessionId: string,
  request: OnlyOfficeBrowserRequest,
): Promise<unknown> {
  const [
    { officePreviewRuntimeManager },
    { resolvePiworkOnlyOfficeHostUrl },
    { applyOfficeResourcePlan, officeResourcesReadyForRelease, planOfficeResourcesForFile },
  ] = await Promise.all([
    import("./office-host-adapter.js"),
    import("./onlyoffice-host-url.js"),
    import("./office-runtime-resources.js"),
  ]);
  const target = request.target!;
  const file = await getUserSpaceFile(target.mountId, target.path);
  const fileType = target.path.split(".").pop()?.toLowerCase() || "";
  const documentType = documentTypeForFile(fileType);
  if (!documentType) throw new Error(`Unsupported Office file type: ${fileType || "unknown"}`);
  const resourcePlan = await planOfficeResourcesForFile(target.path);
  if (!officeResourcesReadyForRelease(resourcePlan.releaseId)) {
    await applyOfficeResourcePlan(resourcePlan);
  }
  if (!officeResourcesReadyForRelease(resourcePlan.releaseId)) {
    throw new Error(uiCopy.userSpace.office.resourcesNotReady);
  }
  const writing = isOnlyOfficeWriteOperation(request.operation);
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1280px;height:720px;opacity:0;pointer-events:none";
  document.body.appendChild(container);

  let resolvePlugin!: (instance: OfficeEditorInstance) => void;
  let rejectPlugin!: (error: Error) => void;
  const pluginReady = new Promise<OfficeEditorInstance>((resolve, reject) => {
    resolvePlugin = resolve;
    rejectPlugin = reject;
  });
  const resourceKey = `onlyoffice-ai:${sessionId}:${request.request_id}`;
  const lease = officePreviewRuntimeManager.mount(container, {
    resourceKey,
    foreground: false,
    hostUrl: (context) => resolvePiworkOnlyOfficeHostUrl(context, resourcePlan.releaseId),
    file,
    fileName: file.name || target.path.split("/").pop() || `document.${fileType}`,
    mode: writing ? "edit" : "readonly",
    readonly: !writing,
    saveBehavior: "callback",
    plugins: {
      configUrls: [PLUGIN_CONFIG_URL],
      autostart: [ONLYOFFICE_PLUGIN_GUID],
    },
    onPluginReady(pluginGuid, _editorType, instance) {
      if (pluginGuid === ONLYOFFICE_PLUGIN_GUID) resolvePlugin(instance);
    },
    onSave: async (savedFile) => {
      const savePath = officeSavedWorkspacePath(target.path, savedFile.name);
      const migrated = savePath !== target.path && isLegacyOfficePath(target.path);
      if (migrated) {
        await saveUserSpaceFile(target.mountId, savePath, savedFile, { create: true });
        await executeUserSpaceOperation("delete_entry", {
          mountId: target.mountId,
          path: target.path,
        });
      } else {
        await saveUserSpaceFile(target.mountId, target.path, savedFile);
      }
      return true;
    },
    onError(error) {
      rejectPlugin(error);
    },
  });

  try {
    const instance = await Promise.race([lease.ready.then(() => pluginReady), pluginReady]);
    if (writing && isLegacyOfficePath(target.path)) {
      if (typeof instance.confirmSaveToNewFormat !== "function") {
        throw new Error("OnlyOffice legacy format confirmation is unavailable.");
      }
      if (!(await instance.confirmSaveToNewFormat())) {
        throw new Error("Saving the legacy Office file in the new format was cancelled.");
      }
    }
    const record: EditorRegistration = {
      sessionId,
      leaseId: createId(),
      instance,
      document: {
        title: file.name,
        mountId: target.mountId,
        path: target.path,
        fileType,
        documentType,
        writable: writing,
        foreground: false,
      },
      updatedAt: Date.now(),
    };
    return await invokeOnEditor(record, request);
  } finally {
    await lease.dispose().catch(() => undefined);
    container.remove();
  }
}

const LEGACY_OFFICE_TARGET_EXTENSIONS: Record<string, string> = {
  doc: "docx",
  xls: "xlsx",
  ppt: "pptx",
};

function officeSavedWorkspacePath(currentPath: string, savedFileName: string): string {
  const currentExtension = fileExtension(currentPath);
  const legacyTargetExtension = LEGACY_OFFICE_TARGET_EXTENSIONS[currentExtension];
  if (legacyTargetExtension) {
    return workspacePathWithExtensionMarker(currentPath, currentExtension, legacyTargetExtension);
  }
  const savedExtension = fileExtension(savedFileName);
  if (!currentExtension || !savedExtension || currentExtension === savedExtension)
    return currentPath;
  return workspacePathWithExtension(currentPath, savedExtension);
}

function isLegacyOfficePath(path: string): boolean {
  return Boolean(LEGACY_OFFICE_TARGET_EXTENSIONS[fileExtension(path)]);
}

function fileExtension(path: string): string {
  const name = path.split("/").pop() || path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function workspacePathWithExtensionMarker(
  currentPath: string,
  sourceExtension: string,
  targetExtension: string,
): string {
  return workspacePathWithExtension(currentPath, targetExtension, `_${sourceExtension}`);
}

function workspacePathWithExtension(currentPath: string, extension: string, suffix = ""): string {
  const parts = currentPath.split("/");
  const name = parts.pop() || "document";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const nextName = `${stem}${suffix}.${extension}`;
  return parts.length ? `${parts.join("/")}/${nextName}` : nextName;
}

function documentTypeForFile(fileType: string): OnlyOfficeDocumentType | null {
  if (["doc", "docx", "odt", "rtf", "txt"].includes(fileType)) return "word";
  if (["xls", "xlsx", "xlsm", "ods", "csv"].includes(fileType)) return "cell";
  if (["ppt", "pptx", "odp"].includes(fileType)) return "slide";
  return null;
}
