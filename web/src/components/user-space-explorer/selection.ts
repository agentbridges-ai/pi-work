import type { CSSProperties } from "react";
import type { TreeNode } from "../../api.js";
import type {
  AgentEntrySelection,
  WorkspaceClipboard,
  WorkspaceClipboardEntry,
  WorkspaceEntry,
  WorkspaceEntrySelection,
} from "./model.js";
import { previewKindForWorkspacePath } from "./preview-builder.js";

export type SelectionSegment = {
  selectedAbove: boolean;
  selectedBelow: boolean;
};

export const WORKSPACE_TREE_SINGLE_ROW_RADIUS = "var(--piwork-control-radius)";
const WORKSPACE_TREE_GROUP_RADIUS = "min(var(--piwork-control-radius), 14px)";

export function selectionSegmentsForVisibleKeys(
  visibleKeys: string[],
  selectedKeys: Set<string>,
): Map<string, SelectionSegment> {
  const segments = new Map<string, SelectionSegment>();
  visibleKeys.forEach((key, index) => {
    if (!selectedKeys.has(key)) return;
    segments.set(key, {
      selectedAbove: index > 0 && selectedKeys.has(visibleKeys[index - 1]),
      selectedBelow: index < visibleKeys.length - 1 && selectedKeys.has(visibleKeys[index + 1]),
    });
  });
  return segments;
}

export function selectedRowBackgroundRadiusStyle(
  segment: SelectionSegment | undefined,
  trailingGapPx = 0,
): CSSProperties | undefined {
  if (!segment || (!segment.selectedAbove && !segment.selectedBelow)) {
    return { borderRadius: WORKSPACE_TREE_SINGLE_ROW_RADIUS };
  }
  return {
    bottom: segment.selectedBelow && trailingGapPx > 0 ? -trailingGapPx : undefined,
    borderTopLeftRadius: segment.selectedAbove ? 0 : WORKSPACE_TREE_GROUP_RADIUS,
    borderTopRightRadius: segment.selectedAbove ? 0 : WORKSPACE_TREE_GROUP_RADIUS,
    borderBottomLeftRadius: segment.selectedBelow ? 0 : WORKSPACE_TREE_GROUP_RADIUS,
    borderBottomRightRadius: segment.selectedBelow ? 0 : WORKSPACE_TREE_GROUP_RADIUS,
  };
}

export function selectionSegmentName(
  segment: SelectionSegment | undefined,
): "single" | "top" | "middle" | "bottom" {
  if (segment?.selectedAbove && segment.selectedBelow) return "middle";
  if (segment?.selectedAbove) return "bottom";
  if (segment?.selectedBelow) return "top";
  return "single";
}

export function workspaceSelectionRangeKeys(
  visibleEntryKeys: string[],
  anchorKey: string,
  targetKey: string,
): string[] {
  const targetIndex = visibleEntryKeys.indexOf(targetKey);
  if (targetIndex < 0) return targetKey ? [targetKey] : [];
  const anchorIndex = visibleEntryKeys.indexOf(anchorKey);
  if (anchorIndex < 0) return [targetKey];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleEntryKeys.slice(start, end + 1);
}

export function isWorkspaceEntryCoveredByDirectory(
  entry: WorkspaceEntrySelection,
  directory: WorkspaceEntrySelection,
): boolean {
  if (entry.mountId !== directory.mountId || directory.entry.kind !== "directory") return false;
  return (
    entry.entry.path !== directory.entry.path &&
    entry.entry.path.startsWith(`${directory.entry.path}/`)
  );
}

export function workspaceSelectionKeyCoversPath(
  key: string,
  mountId: string,
  path: string,
): boolean {
  const separatorIndex = key.indexOf("\u0000");
  if (separatorIndex < 0) return false;
  const selectedMountId = key.slice(0, separatorIndex);
  const selectedPath = key.slice(separatorIndex + 1);
  return (
    selectedMountId === mountId && (selectedPath === path || path.startsWith(`${selectedPath}/`))
  );
}

export function workspacePathDepth(path: string): number {
  if (!path) return 0;
  return path.split("/").filter(Boolean).length;
}

export function maximalWorkspaceEntrySelection(
  entries: WorkspaceEntrySelection[],
): WorkspaceEntrySelection[] {
  const sorted = [...entries].sort((a, b) => {
    const depthDelta = workspacePathDepth(a.entry.path) - workspacePathDepth(b.entry.path);
    if (depthDelta !== 0) return depthDelta;
    return a.entry.path.localeCompare(b.entry.path);
  });
  const maximal: WorkspaceEntrySelection[] = [];
  for (const item of sorted) {
    if (maximal.some((selected) => isWorkspaceEntryCoveredByDirectory(item, selected))) continue;
    maximal.push(item);
  }
  return maximal;
}

export function workspaceClipboardCanPaste(
  clipboard: WorkspaceClipboard | null,
  mountId: string,
): boolean {
  return Boolean(clipboard && clipboard.mountId === mountId && clipboard.entries.length > 0);
}

export function workspaceClipboardSelfPasteTarget(
  clipboard: WorkspaceClipboard,
  targetDirPath: string,
): WorkspaceClipboardEntry | null {
  return (
    clipboard.entries.find(
      (entry) =>
        entry.kind === "directory" &&
        (targetDirPath === entry.path || targetDirPath.startsWith(`${entry.path}/`)),
    ) || null
  );
}

export function workspaceClipboardCoversDeletedEntries(
  clipboard: WorkspaceClipboard | null,
  deleteEntries: WorkspaceEntrySelection[],
): boolean {
  if (!clipboard) return false;
  return deleteEntries.some(
    (deleted) =>
      deleted.mountId === clipboard.mountId &&
      clipboard.entries.some(
        (entry) =>
          entry.path === deleted.entry.path || entry.path.startsWith(`${deleted.entry.path}/`),
      ),
  );
}

export function agentNodePath(node: TreeNode): string {
  return node.path || node.name;
}

export function agentNodeToWorkspaceEntry(node: TreeNode): WorkspaceEntry {
  const path = agentNodePath(node);
  return {
    name: node.name,
    path,
    kind: node.type,
    size: node.size,
    lastModified: node.mtime,
    previewKind: node.type === "file" ? previewKindForWorkspacePath(path) : undefined,
  };
}

export function flattenVisibleAgentNodes(nodes: TreeNode[], openDirs: Set<string>): TreeNode[] {
  const visible: TreeNode[] = [];
  for (const node of nodes) {
    visible.push(node);
    if (node.type !== "directory" || !openDirs.has(agentNodePath(node))) continue;
    visible.push(...flattenVisibleAgentNodes(node.children || [], openDirs));
  }
  return visible;
}

export function isAgentNodeCoveredByDirectory(
  entry: AgentEntrySelection,
  directory: AgentEntrySelection,
): boolean {
  const entryPath = agentNodePath(entry.node);
  const directoryPath = agentNodePath(directory.node);
  return (
    directory.node.type === "directory" &&
    entryPath !== directoryPath &&
    entryPath.startsWith(`${directoryPath}/`)
  );
}

export function maximalAgentNodeSelection(entries: AgentEntrySelection[]): AgentEntrySelection[] {
  const sorted = [...entries].sort((a, b) => {
    const aPath = agentNodePath(a.node);
    const bPath = agentNodePath(b.node);
    const depthDelta = workspacePathDepth(aPath) - workspacePathDepth(bPath);
    if (depthDelta !== 0) return depthDelta;
    return aPath.localeCompare(bPath);
  });
  const maximal: AgentEntrySelection[] = [];
  for (const item of sorted) {
    if (maximal.some((selected) => isAgentNodeCoveredByDirectory(item, selected))) continue;
    maximal.push(item);
  }
  return maximal;
}
