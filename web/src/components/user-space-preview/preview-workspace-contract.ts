import { uiCopy } from "../../ui-copy.js";
import type { WorkspaceEntry } from "../user-space-explorer/model.js";

const WTERM_PREVIEW_TAB_ID_PREFIX = "__piwork_wterm__";
const AGENT_PREVIEW_TAB_ID_PREFIX = "__piwork_agent__";

export type PreviewTabInsertionEdge = "before" | "after";

export type OfficeFileMigration = {
  mountId: string;
  oldPath: string;
  newPath: string;
};

export type OfficeFileCreated = {
  mountId: string;
  path: string;
  previewKind?: WorkspaceEntry["previewKind"];
};

export type OfficeFileSaved = {
  mountId: string;
  path: string;
  file: File;
};

export function wtermPreviewTabId(mountId: string): string {
  return `${WTERM_PREVIEW_TAB_ID_PREFIX}:${mountId}`;
}

export function isWtermPreviewTabId(tabId: string): boolean {
  return tabId.startsWith(`${WTERM_PREVIEW_TAB_ID_PREFIX}:`);
}

export function agentPreviewTabId(path: string): string {
  return `${AGENT_PREVIEW_TAB_ID_PREFIX}:${path}`;
}

export function isAgentPreviewTabId(tabId: string): boolean {
  return tabId.startsWith(`${AGENT_PREVIEW_TAB_ID_PREFIX}:`);
}

export function previewTabId(mountId: string, path: string): string {
  return `${mountId}:${path}`;
}

export function previewTitleForPath(path: string): string {
  return path.split("/").pop() || path || uiCopy.userSpace.defaultFileName;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
