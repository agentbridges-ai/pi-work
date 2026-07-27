import type { TreeNode } from "../../api.js";
import type { WorkspaceEntrySelection } from "./model.js";
import { agentNodePath } from "./selection.js";
import { dirnameWorkspacePath, normalizeWorkspacePath } from "./workspace-paths.js";

export const WORKSPACE_INTERNAL_DRAG_TYPE = "application/x-piwork-workspace-entries";
export const WORKSPACE_DRAG_AUTO_EXPAND_MS = 500;
export const WORKSPACE_DRAG_SCROLL_EDGE_PX = 35;
export const WORKSPACE_DRAG_SCROLL_MAX_PX = 14;

export type WorkspaceDragOperation = "move" | "copy";
export type WorkspaceDropValidationReason =
  "different-space" | "different-mount" | "same-parent" | "self" | "descendant";

export type WorkspaceDropValidation =
  { valid: true } | { valid: false; reason: WorkspaceDropValidationReason };

export function workspaceDragOperationFromModifiers(
  event: Pick<DragEvent, "altKey" | "ctrlKey">,
  isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform),
): WorkspaceDragOperation {
  return isMac ? (event.altKey ? "copy" : "move") : event.ctrlKey ? "copy" : "move";
}

export function validateWorkspaceEntryDrop(
  entries: WorkspaceEntrySelection[],
  targetMountId: string,
  targetDirPath: string,
  operation: WorkspaceDragOperation,
): WorkspaceDropValidation {
  const normalizedTarget = normalizeWorkspacePath(targetDirPath);
  for (const { mountId, entry } of entries) {
    if (mountId !== targetMountId) return { valid: false, reason: "different-mount" };
    const sourcePath = normalizeWorkspacePath(entry.path);
    if (sourcePath === normalizedTarget) return { valid: false, reason: "self" };
    if (entry.kind === "directory" && normalizedTarget.startsWith(`${sourcePath}/`)) {
      return { valid: false, reason: "descendant" };
    }
    if (operation === "move" && dirnameWorkspacePath(sourcePath) === normalizedTarget) {
      return { valid: false, reason: "same-parent" };
    }
  }
  return { valid: true };
}

export function validateAgentEntryDrop(
  entries: TreeNode[],
  targetDirPath: string,
): WorkspaceDropValidation {
  const normalizedTarget = normalizeWorkspacePath(targetDirPath);
  for (const entry of entries) {
    const sourcePath = normalizeWorkspacePath(agentNodePath(entry));
    if (sourcePath === normalizedTarget) return { valid: false, reason: "self" };
    if (entry.type === "directory" && normalizedTarget.startsWith(`${sourcePath}/`)) {
      return { valid: false, reason: "descendant" };
    }
    if (dirnameWorkspacePath(sourcePath) === normalizedTarget) {
      return { valid: false, reason: "same-parent" };
    }
  }
  return { valid: true };
}

export function workspaceDragScrollDelta(
  clientY: number,
  bounds: Pick<DOMRect, "top" | "bottom">,
): number {
  if (clientY < bounds.top + WORKSPACE_DRAG_SCROLL_EDGE_PX) {
    const intensity = Math.min(
      1,
      Math.max(
        0,
        (bounds.top + WORKSPACE_DRAG_SCROLL_EDGE_PX - clientY) / WORKSPACE_DRAG_SCROLL_EDGE_PX,
      ),
    );
    return -Math.max(1, Math.round(WORKSPACE_DRAG_SCROLL_MAX_PX * intensity));
  }
  if (clientY > bounds.bottom - WORKSPACE_DRAG_SCROLL_EDGE_PX) {
    const intensity = Math.min(
      1,
      Math.max(
        0,
        (clientY - (bounds.bottom - WORKSPACE_DRAG_SCROLL_EDGE_PX)) / WORKSPACE_DRAG_SCROLL_EDGE_PX,
      ),
    );
    return Math.max(1, Math.round(WORKSPACE_DRAG_SCROLL_MAX_PX * intensity));
  }
  return 0;
}
