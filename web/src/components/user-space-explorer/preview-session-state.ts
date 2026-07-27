import {
  agentPreviewTabId,
  isAgentPreviewTabId,
  isWtermPreviewTabId,
  previewTabId,
} from "../user-space-preview/preview-workspace-contract.js";
import type { PreviewTab, PreviewViewMode, WorkspaceEntry } from "./model.js";

const PREVIEW_SESSION_STORAGE_PREFIX = "piwork:open-file-previews:v1:";
const MAX_PERSISTED_PREVIEW_TABS = 100;

export type PersistedPreviewTab = {
  space: "user" | "agent";
  id: string;
  mountId: string;
  path: string;
  viewMode: PreviewViewMode;
  pinned?: boolean;
  previewKind?: WorkspaceEntry["previewKind"];
  size?: number;
};

export type PersistedPreviewSessionState = {
  activeTabId: string;
  tabs: PersistedPreviewTab[];
};

export function previewSessionStorageKey(ownerKey: string): string {
  return `${PREVIEW_SESSION_STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`;
}

export function readPreviewSessionState(ownerKey: string): PersistedPreviewSessionState | null {
  if (typeof window === "undefined" || !ownerKey) return null;
  try {
    const raw = window.sessionStorage?.getItem(previewSessionStorageKey(ownerKey));
    if (!raw) return null;
    return parsePreviewSessionState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writePreviewSessionState(
  ownerKey: string,
  tabs: PreviewTab[],
  activeTabId: string,
): void {
  if (typeof window === "undefined" || !ownerKey) return;
  try {
    const persistedTabs = tabs.flatMap<PersistedPreviewTab>((tab) => {
      if (isWtermPreviewTabId(tab.id) || !tab.path) return [];
      const space = isAgentPreviewTabId(tab.id) ? "agent" : "user";
      const size =
        tab.state.status === "ready" || tab.state.status === "error" ? tab.state.size : undefined;
      return [
        {
          space,
          id: space === "agent" ? agentPreviewTabId(tab.path) : previewTabId(tab.mountId, tab.path),
          mountId: tab.mountId,
          path: tab.path,
          viewMode: tab.viewMode,
          ...(tab.pinned ? { pinned: true } : {}),
          previewKind: persistedPreviewKind(tab),
          ...(typeof size === "number" ? { size } : {}),
        },
      ];
    });
    const key = previewSessionStorageKey(ownerKey);
    if (persistedTabs.length === 0) {
      window.sessionStorage?.removeItem(key);
      return;
    }
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const persistedActiveId = activeTab
      ? isAgentPreviewTabId(activeTab.id)
        ? agentPreviewTabId(activeTab.path)
        : isWtermPreviewTabId(activeTab.id)
          ? ""
          : previewTabId(activeTab.mountId, activeTab.path)
      : "";
    const state: PersistedPreviewSessionState = {
      activeTabId: persistedTabs.some((tab) => tab.id === persistedActiveId)
        ? persistedActiveId
        : "",
      tabs: persistedTabs,
    };
    window.sessionStorage?.setItem(key, JSON.stringify(state));
  } catch {
    // Refresh recovery is best-effort when browser storage is unavailable.
  }
}

function parsePreviewSessionState(value: unknown): PersistedPreviewSessionState | null {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return null;
  const tabs: PersistedPreviewTab[] = [];
  const ids = new Set<string>();
  for (const candidate of value.tabs) {
    if (tabs.length >= MAX_PERSISTED_PREVIEW_TABS) break;
    if (!isRecord(candidate)) continue;
    const { space, id, mountId, path, viewMode, pinned, previewKind, size } = candidate;
    if (
      (space !== "user" && space !== "agent") ||
      typeof id !== "string" ||
      !id ||
      typeof mountId !== "string" ||
      typeof path !== "string" ||
      !path ||
      (viewMode !== "preview" && viewMode !== "text") ||
      (pinned !== undefined && typeof pinned !== "boolean") ||
      ids.has(id)
    ) {
      continue;
    }
    if (previewKind !== undefined && !isPersistedPreviewKind(previewKind)) continue;
    if (size !== undefined && (typeof size !== "number" || !Number.isFinite(size) || size < 0))
      continue;
    if (space === "agent" && id !== agentPreviewTabId(path)) continue;
    if (
      space === "user" &&
      (!mountId || isWtermPreviewTabId(id) || id !== previewTabId(mountId, path))
    )
      continue;
    ids.add(id);
    tabs.push({
      space,
      id,
      mountId,
      path,
      viewMode,
      ...(pinned ? { pinned: true } : {}),
      ...(previewKind ? { previewKind } : {}),
      ...(typeof size === "number" ? { size } : {}),
    });
  }
  if (tabs.length === 0) return null;
  return {
    activeTabId:
      typeof value.activeTabId === "string" && ids.has(value.activeTabId) ? value.activeTabId : "",
    tabs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function persistedPreviewKind(tab: PreviewTab): WorkspaceEntry["previewKind"] | undefined {
  if (tab.state.status !== "ready") return undefined;
  if (tab.state.kind === "markdown" || tab.state.kind === "html") return "text";
  if (tab.state.kind === "wterm") return undefined;
  return tab.state.kind;
}

function isPersistedPreviewKind(value: unknown): value is WorkspaceEntry["previewKind"] {
  return (
    typeof value === "string" &&
    ["image", "audio", "video", "pdf", "office", "text", "binary"].includes(value)
  );
}
