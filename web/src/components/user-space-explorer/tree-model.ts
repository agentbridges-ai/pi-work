import type { UserSpaceMount } from "../../types.js";
import { uiCopy } from "../../ui-copy.js";
import type { WorkspaceEntry } from "./model.js";

const ROOT_PATH = "";
export const TREE_ROOT_ITEM_ID = "__workspace-tree-root__";
export const TREE_ID_SEPARATOR = "\u0000";
const TREE_MOUNT_PREFIX = `mount${TREE_ID_SEPARATOR}`;
const TREE_ENTRY_PREFIX = `entry${TREE_ID_SEPARATOR}`;
const TREE_STATUS_PREFIX = `status${TREE_ID_SEPARATOR}`;

const workspaceCopy = uiCopy.userSpace;

export type WorkspaceTreeItemData =
  | { kind: "root"; name: string }
  | {
      kind: "mount";
      mount: UserSpaceMount;
      isActive: boolean;
      isExpanded: boolean;
      isMounted: boolean;
      isOffline: boolean;
      syncing: boolean;
      unmounting: boolean;
    }
  | { kind: "entry"; mountId: string; entry: WorkspaceEntry }
  | {
      kind: "status";
      mountId: string;
      dirPath: string;
      status: "loading" | "error" | "empty" | "load-more";
      message?: string;
    };

export type WorkspaceTreeModel = {
  itemDataById: Map<string, WorkspaceTreeItemData>;
  childIdsById: Map<string, string[]>;
  expandedItemIds: string[];
  focusedItemId: string | null;
};

export function treeDirKey(mountId: string, path: string): string {
  return `${mountId}\u0000${path}`;
}

export function mountTreeItemId(mountId: string): string {
  return `${TREE_MOUNT_PREFIX}${mountId}`;
}

export function entryTreeItemId(mountId: string, path: string): string {
  return `${TREE_ENTRY_PREFIX}${mountId}${TREE_ID_SEPARATOR}${path}`;
}

function statusTreeItemId(
  mountId: string,
  dirPath: string,
  status: Extract<WorkspaceTreeItemData, { kind: "status" }>["status"],
): string {
  return `${TREE_STATUS_PREFIX}${mountId}${TREE_ID_SEPARATOR}${dirPath}${TREE_ID_SEPARATOR}${status}`;
}

function entryTreeItemIdFromDirKey(key: string): string | null {
  const separatorIndex = key.indexOf(TREE_ID_SEPARATOR);
  if (separatorIndex < 0) return null;
  const mountId = key.slice(0, separatorIndex);
  const path = key.slice(separatorIndex + 1);
  if (!mountId || !path) return null;
  return entryTreeItemId(mountId, path);
}

function selectedTreeItemIdFromKey(key: string): string | null {
  if (!key) return null;
  return entryTreeItemIdFromDirKey(key);
}

export function workspaceTreeItemLabel(data: WorkspaceTreeItemData): string {
  switch (data.kind) {
    case "root":
      return data.name;
    case "mount":
      return data.mount.rootName;
    case "entry":
      return data.entry.name;
    case "status":
      if (data.status === "error") return data.message || workspaceCopy.directoryLoadFailed;
      if (data.status === "empty") return workspaceCopy.directoryEmpty;
      if (data.status === "load-more") return workspaceCopy.directoryLoadMore;
      return workspaceCopy.directoryLoading;
  }
}

export function buildWorkspaceTreeModel({
  visibleMounts,
  activeMountId,
  localMountById,
  expandedMountIds,
  entriesByDir,
  cursorsByDir,
  loadingDirs,
  dirErrors,
  openDirs,
  rootSettledMountIds,
  selectedEntryKey,
  workspaceRestoring,
  authorizationSettledOfflineMountIds,
  metadataSyncingMountId,
  unmountingMountId,
}: {
  visibleMounts: UserSpaceMount[];
  activeMountId: string;
  localMountById: Map<string, UserSpaceMount>;
  expandedMountIds: Set<string>;
  entriesByDir: Map<string, WorkspaceEntry[]>;
  cursorsByDir: Map<string, string | undefined>;
  loadingDirs: Set<string>;
  dirErrors: Map<string, string>;
  openDirs: Set<string>;
  rootSettledMountIds: Set<string>;
  selectedEntryKey: string;
  workspaceRestoring: boolean;
  authorizationSettledOfflineMountIds: Set<string>;
  metadataSyncingMountId: string;
  unmountingMountId: string;
}): WorkspaceTreeModel {
  const itemDataById = new Map<string, WorkspaceTreeItemData>();
  const childIdsById = new Map<string, string[]>();
  const expandedItemIds: string[] = [];
  const rootChildren: string[] = [];

  itemDataById.set(TREE_ROOT_ITEM_ID, { kind: "root", name: workspaceCopy.defaultRootName });

  const addStatusChild = (
    childIds: string[],
    mountId: string,
    dirPath: string,
    status: Extract<WorkspaceTreeItemData, { kind: "status" }>["status"],
    data: Omit<
      Extract<WorkspaceTreeItemData, { kind: "status" }>,
      "kind" | "mountId" | "dirPath" | "status"
    > = {},
  ) => {
    const id = statusTreeItemId(mountId, dirPath, status);
    itemDataById.set(id, { kind: "status", mountId, dirPath, status, ...data });
    childIds.push(id);
    childIdsById.set(id, []);
  };

  const addDirectoryChildren = (
    parentId: string,
    mountId: string,
    dirPath: string,
    depthGuard: Set<string>,
  ) => {
    const childIds: string[] = [];
    const dirKey = treeDirKey(mountId, dirPath);
    const entries = entriesByDir.get(dirKey) || [];
    const hasLoaded = entriesByDir.has(dirKey);
    const loading = loadingDirs.has(dirKey);
    const error = dirErrors.get(dirKey);

    if (error) {
      addStatusChild(childIds, mountId, dirPath, "error", { message: error });
    } else if (dirPath === ROOT_PATH && (loading || !hasLoaded) && entries.length === 0) {
      addStatusChild(childIds, mountId, dirPath, "loading");
    } else if (!loading && hasLoaded && entries.length === 0 && dirPath === ROOT_PATH) {
      addStatusChild(childIds, mountId, dirPath, "empty");
    }

    for (const entry of entries) {
      const entryId = entryTreeItemId(mountId, entry.path);
      itemDataById.set(entryId, { kind: "entry", mountId, entry });
      childIds.push(entryId);

      const entryKey = treeDirKey(mountId, entry.path);
      if (entry.kind === "directory" && openDirs.has(entryKey)) {
        expandedItemIds.push(entryId);
        if (!depthGuard.has(entryId)) {
          depthGuard.add(entryId);
          addDirectoryChildren(entryId, mountId, entry.path, depthGuard);
          depthGuard.delete(entryId);
        }
      } else {
        childIdsById.set(entryId, []);
      }
    }

    if (cursorsByDir.get(dirKey)) addStatusChild(childIds, mountId, dirPath, "load-more");
    childIdsById.set(parentId, childIds);
  };

  for (const mount of visibleMounts) {
    const mountId = mount.mountId;
    const mountItemId = mountTreeItemId(mountId);
    const isExpanded = expandedMountIds.has(mountId);
    const hasLocalMount = localMountById.has(mountId);
    const isMounted = mount.status === "mounted" && hasLocalMount;
    const missingLocalHandle = mount.status === "mounted" && !hasLocalMount;
    const needsPersistedAuthorization = mount.status === "offline" || missingLocalHandle;
    const authorizationSettledOffline = authorizationSettledOfflineMountIds.has(mountId);
    const isOffline = needsPersistedAuthorization && authorizationSettledOffline;
    const treeSettlingForMount =
      workspaceRestoring ||
      (needsPersistedAuthorization && !authorizationSettledOffline) ||
      (!isOffline && !isMounted) ||
      (isMounted && !rootSettledMountIds.has(mountId));

    rootChildren.push(mountItemId);
    itemDataById.set(mountItemId, {
      kind: "mount",
      mount,
      isActive: mountId === activeMountId,
      isExpanded,
      isMounted,
      isOffline,
      syncing: metadataSyncingMountId === mountId,
      unmounting: unmountingMountId === mountId,
    });

    if (isExpanded) {
      expandedItemIds.push(mountItemId);
      const childIds: string[] = [];
      if (treeSettlingForMount) {
        addStatusChild(childIds, mountId, ROOT_PATH, "loading");
        childIdsById.set(mountItemId, childIds);
      } else if (isOffline) {
        childIdsById.set(mountItemId, childIds);
      } else {
        addDirectoryChildren(mountItemId, mountId, ROOT_PATH, new Set([mountItemId]));
      }
    } else {
      childIdsById.set(mountItemId, []);
    }
  }

  childIdsById.set(TREE_ROOT_ITEM_ID, rootChildren);

  const focusedItemId =
    selectedTreeItemIdFromKey(selectedEntryKey) ||
    (activeMountId ? mountTreeItemId(activeMountId) : rootChildren[0] || null);

  return { itemDataById, childIdsById, expandedItemIds, focusedItemId };
}
