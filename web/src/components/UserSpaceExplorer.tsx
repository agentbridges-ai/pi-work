import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ElementType,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertEngine as Alert,
  ButtonEngine as Button,
  CloseButtonEngine as CloseButton,
  ModalEngine as Modal,
} from "./ui/index.js";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ArrowRightLeft,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Clipboard,
  Copy,
  ExternalLink,
  File,
  FilePlus,
  FileText,
  Files,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDrive,
  Info,
  Lock,
  Pencil,
  Pin,
  RefreshCw,
  Scissors,
  Search,
  Settings2,
  SquareTerminal,
  Tags,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { syncDataLoaderFeature, type ItemInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";
import {
  api,
  type AgentSpaceTransferResult,
  type TreeNode,
  type UserSpaceCreateMetadata,
} from "../api.js";
import { useStore } from "../store.js";
import type { UserSpaceAccess, UserSpaceMount } from "../types.js";
import {
  attachUserSpaceMountsToSession,
  discardUnattachedUserSpaceMount,
  detachUserSpaceFromSession,
  executeUserSpaceOperation,
  getUserSpaceFile,
  getUserSpaceSnapshot,
  isUserSpacePickerAbort,
  mountUserSpace,
  remountUserSpace,
  renameUserSpaceMount,
  resendSessionUserSpaces,
  restorePersistedUserSpace,
  saveUserSpaceFile,
  subscribeUserSpace,
  syncUserSpaceMetadata,
  type UserSpaceMountNameConflict,
  type UserSpacePersistenceScope,
  updateUserSpaceAccess,
} from "../user-space.js";
import {
  addUserSpaceFileRef,
  getUserSpaceFilePreviewRequest,
  subscribeUserSpaceFileRefs,
} from "../user-space-file-refs.js";
import { isUserSpaceRuntimeDisposedError } from "../user-space-runtime.js";
import {
  captureUserSpaceConfigurationContext,
  configureUserSpaceLatest,
  type UserSpaceConfigurationResult,
} from "../user-space-configuration.js";
import { uiCopy } from "../ui-copy.js";
import type { UiLanguage } from "../store/ui-slice.js";
import { registerPwaUpdateGuard } from "../pwa/lifecycle.js";
import {
  DETACHED_PREVIEW_WINDOW_FEATURES,
  WorkspacePreviewPane,
  WorkspaceSearchPreviewBody,
  type DetachedPreviewWindowRequest,
} from "./user-space-preview/WorkspacePreviewPane.js";
import { iconForWorkspaceEntry } from "./user-space-preview/WorkspaceEntryIcon.js";
import {
  agentPreviewTabId,
  formatBytes,
  isAgentPreviewTabId,
  isWtermPreviewTabId,
  previewTabId,
  previewTitleForPath,
  wtermPreviewTabId,
  type OfficeFileCreated,
  type OfficeFileMigration,
  type OfficeFileSaved,
  type PreviewTabInsertionEdge,
} from "./user-space-preview/preview-workspace-contract.js";
import {
  MountNameConflictDialog,
  MountSwitchConfirmDialog,
  MountUnmountConfirmDialog,
  UnsavedPreviewCloseDialog,
  WorkspaceDeleteDialog,
  WorkspaceExtensionRenameConfirmDialog,
  WorkspaceNameDialog,
} from "./user-space-explorer/WorkspaceDialogs.js";
import { WorkspaceSearchModal } from "./user-space-explorer/WorkspaceSearchModal.js";
import type {
  AgentEntrySelection,
  PreviewState,
  PreviewTab,
  PreviewViewMode,
  WorkspaceActionDialog,
  WorkspaceClipboard,
  WorkspaceDetailsDialog,
  WorkspaceDetailsSummary,
  WorkspaceDetailsTypeCount,
  WorkspaceEntry,
  WorkspaceEntrySelection,
  WorkspaceMove,
  WorkspaceMoveResult,
  WorkspaceSearchResult,
  WorkspaceSpaceView,
} from "./user-space-explorer/model.js";
import {
  WORKSPACE_DRAG_AUTO_EXPAND_MS,
  WORKSPACE_INTERNAL_DRAG_TYPE,
  validateAgentEntryDrop,
  validateWorkspaceEntryDrop,
  workspaceDragOperationFromModifiers,
  workspaceDragScrollDelta,
  type WorkspaceDragOperation,
  type WorkspaceDropValidation,
} from "./user-space-explorer/drag-and-drop.js";
import {
  buildPreview,
  createHtmlObjectUrl,
  createImageObjectUrl,
  createPlainTextObjectUrl,
  isHiddenWorkspaceEntry,
  isHtmlPath,
  isMarkdownPath,
  isPreviewableAgentFile,
  isPreviewableFile,
  previewErrorMessage,
  previewLoadErrorState,
  previewKindForWorkspacePath,
  unsupportedPreviewState,
} from "./user-space-explorer/preview-builder.js";
import {
  disposePreviewTabResources,
  revokePreviewStateUrl,
  upsertPreviewTab,
} from "./user-space-explorer/preview-resources.js";
import {
  readPreviewSessionState,
  writePreviewSessionState,
  type PersistedPreviewTab,
  type PersistedPreviewSessionState,
} from "./user-space-explorer/preview-session-state.js";
import {
  dirnameWorkspacePath,
  getExtension,
  joinWorkspacePath,
  normalizeWorkspacePath,
  parentDirectoryPaths,
  splitWorkspaceFileNameForRename,
  validateWorkspaceEntryName,
} from "./user-space-explorer/workspace-paths.js";
import {
  WORKSPACE_TREE_SINGLE_ROW_RADIUS,
  agentNodePath,
  agentNodeToWorkspaceEntry,
  flattenVisibleAgentNodes,
  maximalAgentNodeSelection,
  maximalWorkspaceEntrySelection,
  selectedRowBackgroundRadiusStyle,
  selectionSegmentName,
  selectionSegmentsForVisibleKeys,
  workspaceClipboardCanPaste,
  workspaceClipboardCoversDeletedEntries,
  workspaceClipboardSelfPasteTarget,
  workspacePathDepth,
  workspaceSelectionKeyCoversPath,
  workspaceSelectionRangeKeys,
  type SelectionSegment,
} from "./user-space-explorer/selection.js";
import {
  TREE_ROOT_ITEM_ID,
  buildWorkspaceTreeModel,
  treeDirKey,
  workspaceTreeItemLabel,
  type WorkspaceTreeItemData,
} from "./user-space-explorer/tree-model.js";

type PendingPreviewClose =
  | { kind: "tab"; tabId: string }
  | { kind: "tabs"; tabIds: string[]; unsavedCount?: number }
  | { kind: "all" };
type PendingMountSwitch = {
  mountId: string;
  tabIds: string[];
};

type WorkspaceAlertState = {
  id: number;
  status: "success" | "danger" | "warning" | "accent" | "default";
  message: string;
};

const WORKSPACE_ALERT_SURFACE_CLASSES: Record<WorkspaceAlertState["status"], string> = {
  success: "border border-success/70 bg-success-muted",
  danger: "border border-danger/70 bg-danger-muted",
  warning: "border border-warning/70 bg-warning-muted",
  accent: "border border-info/70 bg-info-muted",
  default: "border border-border bg-default",
};

type WorkspaceClipboardAnnouncement = {
  id: number;
  kind: "user-cut" | "agent-cut" | "cancelled";
  count: number;
};

type WorkspaceContextMenuIcon = (props: {
  className?: string;
  "aria-hidden"?: boolean;
}) => ReactNode;
type WorkspaceNewFileKind = "word" | "ppt" | "excel" | "text";
type WorkspaceCreateEntryKind = "directory" | WorkspaceNewFileKind;
type WorkspaceEntryClickEvent = ReactMouseEvent<HTMLButtonElement>;
type WorkspaceDragEvent = ReactDragEvent<HTMLElement>;
type WorkspaceDragSource =
  | {
      space: "user";
      mountId: string;
      entries: WorkspaceEntrySelection[];
      primaryPath: string;
    }
  | {
      space: "agent";
      entries: TreeNode[];
      primaryPath: string;
    };
type WorkspaceDropTarget = {
  space: WorkspaceSpaceView;
  mountId: string;
  dirPath: string;
  label: string;
  surfaceKey: string;
  operation: WorkspaceDragOperation;
  validation: WorkspaceDropValidation;
};
type WorkspaceDragState = {
  source: WorkspaceDragSource;
  target: WorkspaceDropTarget | null;
};
type WorkspaceDragProxy = {
  x: number;
  y: number;
  label: string;
  count: number;
};
type WorkspaceMoveGuard = {
  ownerKey: string;
  epoch: number;
  viewKey: string;
};
type WorkspaceNewFileTemplate = {
  kind: WorkspaceNewFileKind;
  label: string;
  defaultName: string;
  content: string;
  icon: WorkspaceContextMenuIcon;
};
const WORKSPACE_PANEL_BG_CLASS = "bg-background";
const WORKSPACE_PANEL_HEADER_SURFACE_CLASS = "bg-card";
const WORKSPACE_PANEL_HEADER_BORDER_CLASS = "border-b border-border";
const WORKSPACE_PANEL_TOPBAR_HEIGHT_CLASS = "h-10";
const WORKSPACE_PANEL_HEADER_TEXT_CLASS = "text-sm font-semibold";
const WORKSPACE_PANEL_BODY_TEXT_CLASS = "text-xs text-foreground/75";
const WORKSPACE_SELECTABLE_TEXT_CLASS = "text-foreground";
const workspaceCopy = uiCopy.userSpace;
const WORKSPACE_CONTROL_RADIUS_CLASS = "rounded-[var(--piwork-control-radius)]";
const WORKSPACE_PANEL_RADIUS_CLASS = "rounded-[var(--piwork-panel-radius)]";
const WORKSPACE_CONTEXT_MENU_SURFACE_CLASS = `piwork-superellipse-panel z-[var(--piwork-z-popover)] min-w-[184px] ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card p-1 outline-none`;
const ACTIVE_USER_SPACE_MOUNT_STORAGE_PREFIX = "piwork:user-space-active-mount:";
const WTERM_PREVIEW_PATH = "__piwork_wterm__";
const WORKSPACE_ALERT_AUTO_DISMISS_MS = 4500;

function pathAfterWorkspaceMove(path: string, moves: WorkspaceMove[]): string | null {
  for (const move of moves) {
    if (path === move.sourcePath) return move.path;
    if (move.kind === "directory" && path.startsWith(`${move.sourcePath}/`)) {
      return `${move.path}${path.slice(move.sourcePath.length)}`;
    }
  }
  return null;
}

function pathAfterAgentMove(
  path: string,
  moves: Array<{ path: string; newPath: string }>,
): string | null {
  for (const move of moves) {
    if (path === move.path) return move.newPath;
    if (path.startsWith(`${move.path}/`)) return `${move.newPath}${path.slice(move.path.length)}`;
  }
  return null;
}

function agentNodeAfterMove(
  node: TreeNode,
  moves: Array<{ path: string; newPath: string }>,
): TreeNode {
  const nextPath = pathAfterAgentMove(agentNodePath(node), moves) || agentNodePath(node);
  return {
    ...node,
    path: nextPath,
    ...(node.children
      ? { children: node.children.map((child) => agentNodeAfterMove(child, moves)) }
      : {}),
  };
}

function previewStateAtPath(state: PreviewState, path: string): PreviewState {
  if (state.status === "empty") return state;
  if (state.status !== "ready") return { ...state, path };
  return { ...state, path, name: path.split("/").pop() || state.name };
}

function availablePreviewTabId(baseId: string, tabs: PreviewTab[]): string {
  if (!tabs.some((tab) => tab.id === baseId)) return baseId;
  let suffix = 2;
  while (tabs.some((tab) => tab.id === `${baseId}\u0000${suffix}`)) suffix += 1;
  return `${baseId}\u0000${suffix}`;
}

function workspaceClipboardCanPasteAt(
  clipboard: WorkspaceClipboard | null,
  mountId: string,
  targetDirPath: string,
): boolean {
  if (!workspaceClipboardCanPaste(clipboard, mountId)) return false;
  if (!clipboard || clipboard.operation !== "move") return true;
  return validateWorkspaceEntryDrop(
    clipboard.entries.map((entry) => ({ mountId, entry: { ...entry } })),
    mountId,
    targetDirPath,
    "move",
  ).valid;
}

function agentClipboardCanPasteAt(entries: TreeNode[] | null, targetDirPath: string): boolean {
  return Boolean(entries?.length && validateAgentEntryDrop(entries, targetDirPath).valid);
}

function agentSpaceMoveErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  switch (code) {
    case "agent_space_move_target_exists":
      return workspaceCopy.dragAndDrop.agentTargetExists;
    case "agent_space_move_invalid_destination":
      return workspaceCopy.dragAndDrop.agentInvalidDestination;
    case "agent_space_move_invalid_source":
      return workspaceCopy.dragAndDrop.agentInvalidSource;
    case "agent_space_move_rollback_failed":
      return workspaceCopy.dragAndDrop.agentRollbackFailed;
    default:
      return workspaceCopy.dragAndDrop.agentMoveFailed;
  }
}

function focusWorkspaceTreeRow(testId: string): void {
  if (typeof document === "undefined") return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === testId,
      );
      if (!row) return;
      row.scrollIntoView?.({ block: "nearest" });
      (row.querySelector<HTMLElement>("button") || row).focus();
    });
  });
}

function activeUserSpaceMountStorageKey(sessionId: string): string {
  return `${ACTIVE_USER_SPACE_MOUNT_STORAGE_PREFIX}${sessionId}`;
}

function readActiveUserSpaceMountId(sessionId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage?.getItem(activeUserSpaceMountStorageKey(sessionId)) || "";
  } catch {
    return "";
  }
}

function writeActiveUserSpaceMountId(sessionId: string, mountId: string): void {
  if (typeof window === "undefined" || !mountId) return;
  try {
    window.sessionStorage?.setItem(activeUserSpaceMountStorageKey(sessionId), mountId);
  } catch {
    // Ignore storage failures; this is only a refresh-time UI hint.
  }
}

function selectedEntryKeyForPreviewTab(tab: PreviewTab | null | undefined): string {
  if (!tab || isWtermPreviewTabId(tab.id) || isAgentPreviewTabId(tab.id)) return "";
  return treeDirKey(tab.mountId, tab.path);
}

interface UserSpaceExplorerProps {
  sessionId: string;
  agentId?: string;
  mounts?: UserSpaceMount[];
  persistenceScope?: UserSpacePersistenceScope;
  previewOpen?: boolean;
  onPreviewOpenChange?: (open: boolean, options?: { resetLayout?: boolean }) => void;
  onActiveOfficePreviewChange?: (active: boolean) => void;
  sessionPanelCollapsed?: boolean;
  onSessionPanelCollapsedChange?: (collapsed: boolean) => void;
  onMountsConfigured?: (mounts: UserSpaceMount[]) => void;
  openSearchRequest?: number;
  toggleSpacePanelRequest?: number;
  workspaceRestoring?: boolean;
  directoryLoadTimeoutMs?: number;
  directoryRetryDelayMs?: number;
  uiLanguage?: UiLanguage;
  className?: string;
}

const ROOT_PATH = "";
const DIRECTORY_PAGE_SIZE = 80;
const DIRECTORY_LOAD_TIMEOUT_MS = 6000;
const DIRECTORY_RETRY_DELAY_MS = 900;
const TREE_INDENT_PX = 18;
const TREE_CONTENT_GAP_PX = 2;
const TREE_ROW_CONTENT_SAFE_INSET_PX = 10;
const TREE_FILE_ICON_SLOT_WIDTH_PX = 24;
const TREE_TOGGLE_SLOT_WIDTH_PX = TREE_FILE_ICON_SLOT_WIDTH_PX;
const TREE_ROOT_TOGGLE_SLOT_WIDTH_PX = TREE_FILE_ICON_SLOT_WIDTH_PX;
const TREE_GUIDE_WIDTH_PX = 1;
const TREE_ROOT_GUIDE_LEFT_PX =
  TREE_CONTENT_GAP_PX + TREE_ROOT_TOGGLE_SLOT_WIDTH_PX / 2 - TREE_GUIDE_WIDTH_PX / 2;
const TREE_NESTED_GUIDE_LEFT_PX =
  TREE_CONTENT_GAP_PX + TREE_TOGGLE_SLOT_WIDTH_PX / 2 - TREE_GUIDE_WIDTH_PX / 2;
const TREE_ROOT_DIRECTORY_TEXT_ADJUST_PX = -4;
const TREE_FILE_TEXT_ADJUST_PX = TREE_ROOT_DIRECTORY_TEXT_ADJUST_PX;
const TREE_ROW_HEIGHT_PX = 32;
const TREE_ROW_GAP_PX = 2;
const TREE_ROW_PITCH_PX = TREE_ROW_HEIGHT_PX + TREE_ROW_GAP_PX;
const TREE_VIRTUAL_OVERSCAN = 14;
const TREE_VIRTUAL_UNMEASURED_FALLBACK_ROWS = 64;
const WORKSPACE_TREE_FEATURES = [syncDataLoaderFeature];
const emptyMounts: UserSpaceMount[] = [];
function workspaceEntryKeyForTreeItem(item: ItemInstance<WorkspaceTreeItemData>): string | null {
  const data = item.getItemData();
  if (data.kind !== "entry") return null;
  return treeDirKey(data.mountId, data.entry.path);
}

type WorkspaceDetailsAccumulator = {
  fileCount: number;
  totalSize: number;
  typeCounts: Map<string, number>;
};

function createWorkspaceDetailsAccumulator(): WorkspaceDetailsAccumulator {
  return {
    fileCount: 0,
    totalSize: 0,
    typeCounts: new Map(),
  };
}

function addWorkspaceFileToDetailsAccumulator(
  accumulator: WorkspaceDetailsAccumulator,
  entry: WorkspaceEntry,
) {
  accumulator.fileCount += 1;
  if (typeof entry.size === "number" && Number.isFinite(entry.size)) {
    accumulator.totalSize += entry.size;
  }
  const typeLabel = workspaceDetailsFileTypeLabel(entry);
  accumulator.typeCounts.set(typeLabel, (accumulator.typeCounts.get(typeLabel) || 0) + 1);
}

function workspaceDetailsSummaryFromAccumulator(
  accumulator: WorkspaceDetailsAccumulator,
): WorkspaceDetailsSummary {
  return {
    fileCount: accumulator.fileCount,
    totalSize: accumulator.totalSize,
    typeCounts: Array.from(accumulator.typeCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function summarizeAgentNodesForDetails(nodes: TreeNode[]): WorkspaceDetailsSummary {
  const accumulator = createWorkspaceDetailsAccumulator();
  const visitNode = (node: TreeNode) => {
    if (node.type === "file") {
      addWorkspaceFileToDetailsAccumulator(accumulator, agentNodeToWorkspaceEntry(node));
      return;
    }
    for (const child of node.children || []) visitNode(child);
  };
  for (const node of nodes) visitNode(node);
  return workspaceDetailsSummaryFromAccumulator(accumulator);
}

function workspaceNewFileTemplates(): WorkspaceNewFileTemplate[] {
  const labels = workspaceCopy.contextMenu.newFileTypes;
  const defaultNames = workspaceCopy.createDialog.defaultFileNames;
  return [
    {
      kind: "word",
      label: labels.word,
      defaultName: defaultNames.word,
      content: "",
      icon: workspaceNewFileTemplateIcon(defaultNames.word),
    },
    {
      kind: "ppt",
      label: labels.ppt,
      defaultName: defaultNames.ppt,
      content: "",
      icon: workspaceNewFileTemplateIcon(defaultNames.ppt),
    },
    {
      kind: "excel",
      label: labels.excel,
      defaultName: defaultNames.excel,
      content: "",
      icon: workspaceNewFileTemplateIcon(defaultNames.excel),
    },
    {
      kind: "text",
      label: labels.text,
      defaultName: defaultNames.text,
      content: "",
      icon: workspaceNewFileTemplateIcon(defaultNames.text),
    },
  ];
}

function workspaceNewFileTemplateForKind(kind: WorkspaceNewFileKind): WorkspaceNewFileTemplate {
  return (
    workspaceNewFileTemplates().find((template) => template.kind === kind) ||
    workspaceNewFileTemplates()[0]
  );
}

function workspaceNewFileTemplateIcon(path: string): WorkspaceContextMenuIcon {
  return iconForWorkspaceEntry({
    name: path.split("/").pop() || path,
    path,
    kind: "file",
    previewKind: previewKindForWorkspacePath(path),
  });
}

function toUserSpaceConfig(mounts: UserSpaceMount[]): UserSpaceCreateMetadata[] | null {
  if (mounts.length === 0) return null;
  return mounts.map((mount) => ({
    mountId: mount.mountId,
    name: mount.name,
    rootName: mount.rootName,
    access: mount.access,
    canRead: mount.canRead,
    canWrite: mount.canWrite,
    permissionState: mount.permissionState,
    lastPermissionCheckedAt: mount.lastPermissionCheckedAt,
    includeHidden: true as const,
    fileCount: mount.fileCount,
    lastIndexedAt: mount.lastIndexedAt,
  }));
}

function assertTransferResultOk(result: AgentSpaceTransferResult): void {
  if (result.ok) return;
  const failed = result.files.find((file) => file.status === "error");
  throw new Error(failed?.error || "Transfer failed.");
}

function transferAlertTitle(
  result: AgentSpaceTransferResult,
  copy: typeof uiCopy.userSpace,
): string {
  if (result.files.length > 0 && result.files.every((file) => file.status === "exists")) {
    return copy.alerts.transferAlreadyExistsTitle;
  }
  return copy.alerts.transferSuccessTitle;
}

function UserSpaceExplorerImpl({
  sessionId,
  agentId = "",
  mounts,
  persistenceScope,
  previewOpen: controlledPreviewOpen,
  onPreviewOpenChange,
  onActiveOfficePreviewChange,
  sessionPanelCollapsed = false,
  onSessionPanelCollapsedChange,
  onMountsConfigured,
  openSearchRequest = 0,
  toggleSpacePanelRequest = 0,
  workspaceRestoring = false,
  directoryLoadTimeoutMs = DIRECTORY_LOAD_TIMEOUT_MS,
  directoryRetryDelayMs = DIRECTORY_RETRY_DELAY_MS,
  uiLanguage = "zh-CN",
  className = "",
}: UserSpaceExplorerProps) {
  const sessionData = useStore((state) => state.sessions.get(sessionId));
  const runtimeSessions = useStore((state) => state.runtimeSessions);
  const showHiddenEntries = useStore((state) => state.preferences.userSpace.showHiddenEntries);
  const sessionMounts = mounts ?? sessionData?.userSpaces ?? emptyMounts;
  const snapshot = useSyncExternalStore(
    subscribeUserSpace,
    getUserSpaceSnapshot,
    getUserSpaceSnapshot,
  );
  const previewRequest = useSyncExternalStore(
    subscribeUserSpaceFileRefs,
    () => getUserSpaceFilePreviewRequest(sessionId),
    () => getUserSpaceFilePreviewRequest(sessionId),
  );
  const [activeMountId, setActiveMountId] = useState(
    () => readActiveUserSpaceMountId(sessionId) || sessionMounts[0]?.mountId || "",
  );
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const [entriesByDir, setEntriesByDir] = useState<Map<string, WorkspaceEntry[]>>(() => new Map());
  const [cursorsByDir, setCursorsByDir] = useState<Map<string, string | undefined>>(
    () => new Map(),
  );
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(() => new Map());
  const [rootSettledMountIds, setRootSettledMountIds] = useState<Set<string>>(() => new Set());
  const [selectedEntryKey, setSelectedEntryKey] = useState("");
  const [selectedEntryKeys, setSelectedEntryKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorEntryKey, setSelectionAnchorEntryKey] = useState("");
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [activePreviewTabId, setActivePreviewTabId] = useState("");
  const [detachedWindowRequests, setDetachedWindowRequests] = useState<
    DetachedPreviewWindowRequest[]
  >([]);
  const [blockedDetachedWindowEntries, setBlockedDetachedWindowEntries] = useState<
    WorkspaceEntrySelection[]
  >([]);
  const detachedWindowRequestIdRef = useRef(0);
  const [mounting, setMounting] = useState(false);
  const [autoAuthorizingMountId, setAutoAuthorizingMountId] = useState("");
  const [authorizationSettledOfflineMountIds, setAuthorizationSettledOfflineMountIds] = useState<
    Set<string>
  >(() => new Set());
  const [accessChanging, setAccessChanging] = useState(false);
  const [metadataSyncingMountId, setMetadataSyncingMountId] = useState("");
  const [unmountingMountId, setUnmountingMountId] = useState("");
  const [expandedMountIds, setExpandedMountIds] = useState<Set<string>>(
    () => new Set(sessionMounts[0]?.mountId ? [sessionMounts[0].mountId] : []),
  );
  const [error, setError] = useState("");
  const [uncontrolledPreviewOpen, setUncontrolledPreviewOpen] = useState(false);
  const [spacePanelCollapsed, setSpacePanelCollapsed] = useState(false);
  const handledToggleSpacePanelRequestRef = useRef(0);
  const onPreviewOpenChangeRef = useRef(onPreviewOpenChange);
  const [spaceView, setSpaceView] = useState<WorkspaceSpaceView>("user");

  useEffect(() => {
    if (toggleSpacePanelRequest <= handledToggleSpacePanelRequestRef.current) return;
    handledToggleSpacePanelRequestRef.current = toggleSpacePanelRequest;
    setSpacePanelCollapsed((collapsed) => !collapsed);
  }, [toggleSpacePanelRequest]);
  const [agentTree, setAgentTree] = useState<TreeNode[]>([]);
  const [agentTreeLoading, setAgentTreeLoading] = useState(false);
  const [agentTreeError, setAgentTreeError] = useState("");
  const [agentRootOpen, setAgentRootOpen] = useState(true);
  const [agentOpenDirs, setAgentOpenDirs] = useState<Set<string>>(() => new Set());
  const [selectedAgentEntryPath, setSelectedAgentEntryPath] = useState("");
  const [selectedAgentEntryPaths, setSelectedAgentEntryPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [agentSelectionAnchorPath, setAgentSelectionAnchorPath] = useState("");
  const [pendingPreviewClose, setPendingPreviewClose] = useState<PendingPreviewClose | null>(null);
  const [pendingMountSwitch, setPendingMountSwitch] = useState<PendingMountSwitch | null>(null);
  const [pendingMountNameConflict, setPendingMountNameConflict] =
    useState<UserSpaceMountNameConflict | null>(null);
  const pendingMountNameConflictResolverRef = useRef<((name: string | null) => void) | null>(null);
  const [workspaceClipboard, setWorkspaceClipboard] = useState<WorkspaceClipboard | null>(null);
  const [agentWorkspaceClipboard, setAgentWorkspaceClipboard] = useState<TreeNode[] | null>(null);
  const [workspaceClipboardAnnouncement, setWorkspaceClipboardAnnouncement] =
    useState<WorkspaceClipboardAnnouncement | null>(null);
  const [workspaceActionDialog, setWorkspaceActionDialog] = useState<WorkspaceActionDialog | null>(
    null,
  );
  const [workspaceActionSaving, setWorkspaceActionSaving] = useState(false);
  const [workspaceAlerts, setWorkspaceAlerts] = useState<WorkspaceAlertState[]>([]);
  const [workspaceAlertsExpanded, setWorkspaceAlertsExpanded] = useState(false);
  const [workspaceDetailsDialog, setWorkspaceDetailsDialog] =
    useState<WorkspaceDetailsDialog | null>(null);
  const [workspaceSearchMountId, setWorkspaceSearchMountId] = useState("");
  const handledOpenSearchRequestRef = useRef(0);
  const [pendingRenameEntryKey, setPendingRenameEntryKey] = useState("");
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null);
  const [workspaceDragProxy, setWorkspaceDragProxy] = useState<WorkspaceDragProxy | null>(null);
  const workspaceDragActive = workspaceDrag !== null;
  const [workspaceMovePending, setWorkspaceMovePending] = useState(false);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceDragRef = useRef<WorkspaceDragState | null>(null);
  const workspaceDragVisualReleasedRef = useRef(false);
  const workspaceDragImageCleanupRef = useRef<(() => void) | null>(null);
  const workspaceDragExpandTimerRef = useRef<number | null>(null);
  const workspaceDragExpandKeyRef = useRef("");
  const workspaceDragScrollFrameRef = useRef<number | null>(null);
  const workspaceDragScrollDeltaRef = useRef(0);
  const workspaceDragScrollLastFrameRef = useRef<number | null>(null);
  const workspaceMutationBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const previewTabsRef = useRef(previewTabs);
  const activePreviewTabIdRef = useRef(activePreviewTabId);
  activePreviewTabIdRef.current = activePreviewTabId;
  const pendingPreviewRestorationRef = useRef<{
    ownerKey: string;
    state: PersistedPreviewSessionState;
  } | null>(null);
  const previewPersistenceReadyOwnerRef = useRef("");
  const previewRestoreSeqRef = useRef(0);
  const cursorsByDirRef = useRef(cursorsByDir);
  const mountReconciliationKeyRef = useRef("");
  const directoryRetryTimersRef = useRef(new Map<string, number>());
  const loadDirectoryRef = useRef<
    ((mountId: string, dirPath: string, append?: boolean) => Promise<void>) | null
  >(null);
  const requestSeqRef = useRef(0);
  const directoryRequestSeqByPathRef = useRef(new Map<string, number>());
  const previewSeqByTabRef = useRef(new Map<string, number>());
  const previewRequestSeqRef = useRef(0);
  const handledPreviewRequestSeqRef = useRef(0);
  const handledWorkspaceOperationIdsRef = useRef(
    new Set(snapshot.recentOperations.map((operation) => operation.id)),
  );
  const handledWorkspaceFileChangeIdsRef = useRef(
    new Set((snapshot.recentFileChanges ?? []).map((change) => change.id)),
  );
  const lastShowHiddenEntriesRef = useRef(showHiddenEntries);
  const agentTreeRequestSeqRef = useRef(0);
  const workspaceAlertTimersRef = useRef<Map<number, number>>(new Map());
  const workspaceAlertIdRef = useRef(0);
  const workspaceClipboardAnnouncementIdRef = useRef(0);
  const activeMountSyncSeqRef = useRef(0);
  const configureSessionUserSpace = useCallback(
    (
      userSpace: UserSpaceCreateMetadata[] | null,
      activeMountId?: string,
      callbacks: {
        onSuccess?: (result: UserSpaceConfigurationResult) => void;
        onError?: (error: unknown) => void;
      } = {},
    ) => {
      const context = captureUserSpaceConfigurationContext(sessionId, agentId);
      if (!context) return null;
      return configureUserSpaceLatest({
        context,
        userSpace,
        activeMountId,
        ...callbacks,
      });
    },
    [agentId, sessionId],
  );
  const requestedPreviewOpen = controlledPreviewOpen ?? uncontrolledPreviewOpen;
  const previewOpen = requestedPreviewOpen && previewTabs.length > 0;
  const treeColumnWidth = spacePanelCollapsed
    ? "0px"
    : sessionPanelCollapsed
      ? "20%"
      : "28.571429%";
  const activePreviewTab =
    previewTabs.find((tab) => tab.id === activePreviewTabId) || previewTabs[0];
  const activePreviewIsOffice =
    activePreviewTab?.state.status === "ready" && activePreviewTab.state.kind === "office";
  const localMountById = useMemo(
    () => new Map(snapshot.mounts.map((mount) => [mount.mountId, mount])),
    [snapshot.mounts],
  );
  const visibleMounts = useMemo(() => {
    return sessionMounts.map((mount) => {
      const localMount = localMountById.get(mount.mountId);
      return localMount ? { ...mount, ...localMount, status: "mounted" as const } : mount;
    });
  }, [localMountById, sessionMounts]);
  const visibleMountById = useMemo(
    () => new Map(visibleMounts.map((mount) => [mount.mountId, mount])),
    [visibleMounts],
  );
  const activeMount =
    visibleMounts.find((mount) => mount.mountId === activeMountId) || visibleMounts[0];
  const activeMountIdForOps = activeMount?.mountId || "";
  const activeMountReadyForOps = Boolean(
    activeMount && activeMount.status === "mounted" && localMountById.has(activeMount.mountId),
  );
  const activeMountWritableForOps = Boolean(
    activeMountReadyForOps && activeMount?.access === "readwrite" && activeMount.canWrite !== false,
  );
  const previewOwnerKey = JSON.stringify([
    persistenceScope?.userId || "",
    persistenceScope?.tenantId || "",
    agentId,
    sessionId,
  ]);
  const workspaceMoveViewKey = JSON.stringify([activeMountIdForOps, spaceView]);
  const workspaceMoveOwnerRef = useRef(previewOwnerKey);
  const workspaceMoveViewRef = useRef(workspaceMoveViewKey);
  workspaceMoveViewRef.current = workspaceMoveViewKey;
  const workspaceMoveCleanupOwnerRef = useRef(previewOwnerKey);
  const workspaceMoveEpochRef = useRef(0);
  if (workspaceMoveOwnerRef.current !== previewOwnerKey) {
    workspaceMoveOwnerRef.current = previewOwnerKey;
    workspaceMoveEpochRef.current += 1;
  }
  const beginWorkspaceMutationBarrier = useCallback(() => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const barrier = workspaceMutationBarrierRef.current.catch(() => undefined).then(() => gate);
    workspaceMutationBarrierRef.current = barrier;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  }, []);
  const waitForWorkspaceMutation = useCallback(async () => workspaceMutationBarrierRef.current, []);
  const resolvePreviewTabPath = useCallback(
    (tabId: string) => previewTabsRef.current.find((tab) => tab.id === tabId)?.path,
    [],
  );
  const [previewStateOwnerKey, setPreviewStateOwnerKey] = useState(previewOwnerKey);
  const workspaceSearchMount = workspaceSearchMountId
    ? visibleMounts.find((mount) => mount.mountId === workspaceSearchMountId) || null
    : null;
  const treeVisibleMounts = useMemo(() => (activeMount ? [activeMount] : []), [activeMount]);

  useEffect(
    () =>
      registerPwaUpdateGuard(() => !previewTabsRef.current.some((tab) => tab.hasUnsavedChanges)),
    [],
  );

  useEffect(() => {
    if (!previewTabs.some((tab) => tab.hasUnsavedChanges)) return undefined;
    const preventUnsafeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnsafeUnload);
    return () => window.removeEventListener("beforeunload", preventUnsafeUnload);
  }, [previewTabs]);

  const selectSingleWorkspaceEntryKey = useCallback((key: string) => {
    setSelectedEntryKey(key);
    setSelectedEntryKeys(key ? new Set([key]) : new Set());
    setSelectionAnchorEntryKey(key);
  }, []);

  const clearWorkspaceEntrySelection = useCallback(() => {
    selectSingleWorkspaceEntryKey("");
  }, [selectSingleWorkspaceEntryKey]);

  const selectSingleAgentEntryPath = useCallback((path: string) => {
    setSelectedAgentEntryPath(path);
    setSelectedAgentEntryPaths(path ? new Set([path]) : new Set());
    setAgentSelectionAnchorPath(path);
  }, []);

  const clearAgentEntrySelection = useCallback(() => {
    selectSingleAgentEntryPath("");
  }, [selectSingleAgentEntryPath]);

  const clearAllTreeSelection = useCallback(() => {
    selectSingleWorkspaceEntryKey("");
    selectSingleAgentEntryPath("");
  }, [selectSingleAgentEntryPath, selectSingleWorkspaceEntryKey]);

  const clearWorkspaceAlertTimer = useCallback((id: number) => {
    const timer = workspaceAlertTimersRef.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    workspaceAlertTimersRef.current.delete(id);
  }, []);

  const clearWorkspaceAlertTimers = useCallback(() => {
    for (const timer of workspaceAlertTimersRef.current.values()) window.clearTimeout(timer);
    workspaceAlertTimersRef.current.clear();
  }, []);

  const showWorkspaceAlert = useCallback(
    (alert: Omit<WorkspaceAlertState, "id">, autoDismiss = alert.status === "success") => {
      const id = workspaceAlertIdRef.current + 1;
      workspaceAlertIdRef.current = id;
      setWorkspaceAlerts((current) => [...current, { ...alert, id }]);
      if (!autoDismiss) return;
      const timer = window.setTimeout(() => {
        setWorkspaceAlerts((current) => current.filter((item) => item.id !== id));
        workspaceAlertTimersRef.current.delete(id);
      }, WORKSPACE_ALERT_AUTO_DISMISS_MS);
      workspaceAlertTimersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    return () => clearWorkspaceAlertTimers();
  }, [clearWorkspaceAlertTimers]);

  const dismissWorkspaceAlert = useCallback(
    (id: number) => {
      if (id === 0) {
        setError("");
        return;
      }
      clearWorkspaceAlertTimer(id);
      setWorkspaceAlerts((current) => current.filter((item) => item.id !== id));
    },
    [clearWorkspaceAlertTimer],
  );

  const commitWorkspaceDragState = useCallback((next: WorkspaceDragState | null) => {
    workspaceDragRef.current = next;
    setWorkspaceDrag(next && !workspaceDragVisualReleasedRef.current ? next : null);
  }, []);

  const clearWorkspaceDragExpandTimer = useCallback(() => {
    if (workspaceDragExpandTimerRef.current !== null) {
      window.clearTimeout(workspaceDragExpandTimerRef.current);
      workspaceDragExpandTimerRef.current = null;
    }
    workspaceDragExpandKeyRef.current = "";
  }, []);

  const stopWorkspaceDragAutoScroll = useCallback(() => {
    workspaceDragScrollDeltaRef.current = 0;
    workspaceDragScrollLastFrameRef.current = null;
    if (workspaceDragScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(workspaceDragScrollFrameRef.current);
    workspaceDragScrollFrameRef.current = null;
  }, []);

  const finishWorkspaceDrag = useCallback(() => {
    clearWorkspaceDragExpandTimer();
    stopWorkspaceDragAutoScroll();
    workspaceDragImageCleanupRef.current?.();
    workspaceDragImageCleanupRef.current = null;
    workspaceDragVisualReleasedRef.current = false;
    setWorkspaceDragProxy(null);
    commitWorkspaceDragState(null);
  }, [clearWorkspaceDragExpandTimer, commitWorkspaceDragState, stopWorkspaceDragAutoScroll]);

  const isWorkspaceMoveCurrent = useCallback(
    (guard: WorkspaceMoveGuard) =>
      workspaceMoveOwnerRef.current === guard.ownerKey &&
      workspaceMoveEpochRef.current === guard.epoch,
    [],
  );

  const isWorkspaceMoveViewCurrent = useCallback(
    (guard: WorkspaceMoveGuard) =>
      isWorkspaceMoveCurrent(guard) && workspaceMoveViewRef.current === guard.viewKey,
    [isWorkspaceMoveCurrent],
  );

  const handleWorkspaceTreeDragOverCapture = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!workspaceDragRef.current || workspaceMovePending) {
        stopWorkspaceDragAutoScroll();
        return;
      }
      const scroller = treeScrollRef.current;
      if (!scroller) return;
      const delta = workspaceDragScrollDelta(event.clientY, scroller.getBoundingClientRect());
      workspaceDragScrollDeltaRef.current = delta;
      if (delta === 0) {
        stopWorkspaceDragAutoScroll();
        return;
      }
      if (workspaceDragScrollFrameRef.current !== null) return;
      const scroll = (timestamp: number) => {
        const currentScroller = treeScrollRef.current;
        const currentDelta = workspaceDragScrollDeltaRef.current;
        if (!currentScroller || currentDelta === 0 || !workspaceDragRef.current) {
          workspaceDragScrollFrameRef.current = null;
          return;
        }
        const previousScrollTop = currentScroller.scrollTop;
        const previousTimestamp = workspaceDragScrollLastFrameRef.current;
        workspaceDragScrollLastFrameRef.current = timestamp;
        const elapsed = previousTimestamp === null ? 1000 / 60 : timestamp - previousTimestamp;
        const frameScale = Math.min(2, Math.max(0.25, elapsed / (1000 / 60)));
        currentScroller.scrollTop += currentDelta * frameScale;
        if (currentScroller.scrollTop === previousScrollTop) {
          workspaceDragScrollDeltaRef.current = 0;
          workspaceDragScrollFrameRef.current = null;
          return;
        }
        workspaceDragScrollFrameRef.current = window.requestAnimationFrame(scroll);
      };
      workspaceDragScrollFrameRef.current = window.requestAnimationFrame(scroll);
    },
    [stopWorkspaceDragAutoScroll, workspaceMovePending],
  );

  useEffect(() => {
    const hideActiveDragProxy = () => {
      if (!workspaceDragRef.current) return;
      // Native dragend can be delayed by the browser's cancelled-drop return
      // animation. Clear the rendered drag state on release while retaining the
      // ref-backed source and target until drop/dragend finishes the operation.
      workspaceDragVisualReleasedRef.current = true;
      setWorkspaceDrag(null);
      setWorkspaceDragProxy(null);
    };
    const updateActiveDragPosition = (event: DragEvent) => {
      if (!workspaceDragRef.current) return;
      if (
        event.type === "drag" &&
        event.clientX === 0 &&
        event.clientY === 0 &&
        event.buttons === 0
      ) {
        hideActiveDragProxy();
        return;
      }
      setWorkspaceDragProxy((current) =>
        current && (current.x !== event.clientX || current.y !== event.clientY)
          ? { ...current, x: event.clientX, y: event.clientY }
          : current,
      );
    };
    const finishActiveDrag = () => {
      if (workspaceDragRef.current) finishWorkspaceDrag();
    };
    window.addEventListener("drag", updateActiveDragPosition, true);
    window.addEventListener("dragover", updateActiveDragPosition, true);
    window.addEventListener("pointerup", hideActiveDragProxy, true);
    window.addEventListener("mouseup", hideActiveDragProxy, true);
    window.addEventListener("dragend", finishActiveDrag, true);
    window.addEventListener("drop", finishActiveDrag);
    window.addEventListener("blur", finishActiveDrag);
    return () => {
      window.removeEventListener("drag", updateActiveDragPosition, true);
      window.removeEventListener("dragover", updateActiveDragPosition, true);
      window.removeEventListener("pointerup", hideActiveDragProxy, true);
      window.removeEventListener("mouseup", hideActiveDragProxy, true);
      window.removeEventListener("dragend", finishActiveDrag, true);
      window.removeEventListener("drop", finishActiveDrag);
      window.removeEventListener("blur", finishActiveDrag);
      finishWorkspaceDrag();
    };
  }, [finishWorkspaceDrag]);

  useLayoutEffect(() => {
    if (!workspaceDragActive) return undefined;
    document.documentElement.dataset.piworkWorkspaceDragging = "true";
    return () => {
      delete document.documentElement.dataset.piworkWorkspaceDragging;
    };
  }, [workspaceDragActive]);

  useEffect(() => {
    if (workspaceMoveCleanupOwnerRef.current === previewOwnerKey) return;
    workspaceMoveCleanupOwnerRef.current = previewOwnerKey;
    finishWorkspaceDrag();
    setWorkspaceClipboard(null);
    setAgentWorkspaceClipboard(null);
    setWorkspaceMovePending(false);
  }, [finishWorkspaceDrag, previewOwnerKey]);

  useEffect(() => {
    const nextMounts = sessionMounts.map((mount) => {
      const localMount = localMountById.get(mount.mountId);
      return localMount ? { ...mount, ...localMount, status: "mounted" as const } : mount;
    });
    const mountedIds = nextMounts
      .filter(
        (mount, index) => mount.status === "mounted" && sessionMounts[index]?.status !== "mounted",
      )
      .map((mount) => mount.mountId);
    if (mountedIds.length === 0) return;
    const reconcileKey = `${sessionId}:${nextMounts.map((mount) => `${mount.mountId}:${mount.status}:${mount.access}`).join("|")}`;
    if (mountReconciliationKeyRef.current === reconcileKey) return;
    mountReconciliationKeyRef.current = reconcileKey;
    attachUserSpaceMountsToSession(sessionId, mountedIds);
    resendSessionUserSpaces(sessionId);
    onMountsConfigured?.(nextMounts);
    configureSessionUserSpace(toUserSpaceConfig(nextMounts), undefined, {
      onSuccess: () => resendSessionUserSpaces(sessionId),
      onError: (err) => {
        setError(err instanceof Error ? err.message : String(err));
      },
    });
  }, [configureSessionUserSpace, localMountById, onMountsConfigured, sessionId, sessionMounts]);

  const runtimeSession = useMemo(
    () => runtimeSessions.find((session) => session.sessionId === sessionId),
    [runtimeSessions, sessionId],
  );
  const agentCwd = sessionData?.cwd || runtimeSession?.cwd || "";
  const disabledReason = !snapshot.supported ? workspaceCopy.mountRequiresSecureContext : "";
  const loadAgentTree = useCallback(async () => {
    const seq = agentTreeRequestSeqRef.current + 1;
    agentTreeRequestSeqRef.current = seq;
    setAgentTreeLoading(true);
    setAgentTreeError("");
    try {
      const result = await api.getAgentSpaceTree(sessionId);
      if (seq !== agentTreeRequestSeqRef.current) return;
      setAgentTree(result.tree || []);
    } catch (err) {
      if (seq !== agentTreeRequestSeqRef.current) return;
      setAgentTree([]);
      setAgentTreeError(err instanceof Error ? err.message : workspaceCopy.directoryLoadFailed);
    } finally {
      if (seq === agentTreeRequestSeqRef.current) setAgentTreeLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (spaceView !== "agent") return;
    void loadAgentTree();
  }, [loadAgentTree, spaceView]);

  useEffect(() => {
    agentTreeRequestSeqRef.current += 1;
    setAgentTree([]);
    setAgentTreeError("");
    setAgentTreeLoading(false);
    setAgentRootOpen(true);
    setAgentOpenDirs(new Set());
    clearAgentEntrySelection();
  }, [clearAgentEntrySelection, sessionId]);

  const toggleAgentDirectory = useCallback((path: string) => {
    setAgentOpenDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const treeModel = useMemo(
    () =>
      buildWorkspaceTreeModel({
        visibleMounts: treeVisibleMounts,
        activeMountId: activeMountIdForOps,
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
      }),
    [
      treeVisibleMounts,
      activeMountIdForOps,
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
    ],
  );
  const workspaceTree = useTree<WorkspaceTreeItemData>({
    rootItemId: TREE_ROOT_ITEM_ID,
    dataLoader: {
      getItem: (itemId) =>
        treeModel.itemDataById.get(itemId) || { kind: "root", name: workspaceCopy.defaultRootName },
      getChildren: (itemId) => treeModel.childIdsById.get(itemId) || [],
    },
    getItemName: (item) => workspaceTreeItemLabel(item.getItemData()),
    isItemFolder: (item) => {
      const data = item.getItemData();
      return data.kind === "mount" || (data.kind === "entry" && data.entry.kind === "directory");
    },
    state: {
      expandedItems: treeModel.expandedItemIds,
      focusedItem: treeModel.focusedItemId,
    },
    features: WORKSPACE_TREE_FEATURES,
  });
  const workspaceTreeItems =
    spaceView === "user"
      ? workspaceTree.getItems().filter((item) => item.getItemData().kind !== "mount")
      : [];
  const visibleWorkspaceEntryKeys = workspaceTreeItems
    .map(workspaceEntryKeyForTreeItem)
    .filter((key): key is string => Boolean(key));
  const workspaceSelectionSegments = selectionSegmentsForVisibleKeys(
    visibleWorkspaceEntryKeys,
    selectedEntryKeys,
  );
  const visibleWorkspaceEntryByKey = useMemo(() => {
    const entries = new Map<string, WorkspaceEntrySelection>();
    if (spaceView !== "user") return entries;
    for (const item of workspaceTree.getItems()) {
      const data = treeModel.itemDataById.get(item.getKey());
      if (data?.kind !== "entry") continue;
      entries.set(treeDirKey(data.mountId, data.entry.path), {
        mountId: data.mountId,
        entry: data.entry,
      });
    }
    return entries;
  }, [spaceView, treeModel, workspaceTree]);
  const resolveWorkspaceActionEntries = useCallback(
    (mountId: string, entry: WorkspaceEntry, maximal = true) => {
      const target = { mountId, entry };
      const selectedEntries = Array.from(selectedEntryKeys)
        .map((key) => visibleWorkspaceEntryByKey.get(key))
        .filter(
          (item): item is WorkspaceEntrySelection => item !== undefined && item.mountId === mountId,
        );
      const actionEntries = maximal
        ? maximalWorkspaceEntrySelection(selectedEntries)
        : selectedEntries;
      const targetKey = treeDirKey(mountId, entry.path);
      return selectedEntryKeys.has(targetKey) && actionEntries.length > 0
        ? actionEntries
        : [target];
    },
    [selectedEntryKeys, visibleWorkspaceEntryByKey],
  );
  const visibleAgentNodes = useMemo(
    () => (agentRootOpen ? flattenVisibleAgentNodes(agentTree, agentOpenDirs) : []),
    [agentOpenDirs, agentRootOpen, agentTree],
  );
  const visibleAgentEntryPaths = useMemo(
    () => visibleAgentNodes.map(agentNodePath),
    [visibleAgentNodes],
  );
  const agentSelectionSegments = selectionSegmentsForVisibleKeys(
    visibleAgentEntryPaths,
    selectedAgentEntryPaths,
  );
  const visibleAgentNodeByPath = useMemo(() => {
    const nodes = new Map<string, AgentEntrySelection>();
    for (const node of visibleAgentNodes) nodes.set(agentNodePath(node), { node });
    return nodes;
  }, [visibleAgentNodes]);
  const resolveAgentActionNodes = useCallback(
    (node: TreeNode, maximal = true) => {
      const selectedNodes = Array.from(selectedAgentEntryPaths)
        .map((path) => visibleAgentNodeByPath.get(path))
        .filter((item): item is AgentEntrySelection => item !== undefined);
      const actionNodes = maximal ? maximalAgentNodeSelection(selectedNodes) : selectedNodes;
      const targetPath = agentNodePath(node);
      return selectedAgentEntryPaths.has(targetPath) && actionNodes.length > 0
        ? actionNodes.map((item) => item.node)
        : [node];
    },
    [selectedAgentEntryPaths, visibleAgentNodeByPath],
  );
  const announceWorkspaceClipboard = useCallback(
    (kind: WorkspaceClipboardAnnouncement["kind"], count = 0) => {
      setWorkspaceClipboardAnnouncement({
        id: ++workspaceClipboardAnnouncementIdRef.current,
        kind,
        count,
      });
    },
    [],
  );
  const cutAgentWorkspaceEntry = useCallback(
    (node: TreeNode) => {
      const entries = resolveAgentActionNodes(node);
      setAgentWorkspaceClipboard(entries);
      announceWorkspaceClipboard("agent-cut", entries.length);
    },
    [announceWorkspaceClipboard, resolveAgentActionNodes],
  );

  const attachWorkspaceDragImage = useCallback(
    (event: WorkspaceDragEvent, label: string, count: number) => {
      if (!event.dataTransfer || typeof document === "undefined") return;
      workspaceDragImageCleanupRef.current?.();
      const dragImage = document.createElement("div");
      dragImage.className = "fixed -left-[10000px] -top-[10000px] h-px w-px opacity-0";
      dragImage.style.pointerEvents = "none";
      document.body.appendChild(dragImage);
      event.dataTransfer.setDragImage(dragImage, 0, 0);
      workspaceDragImageCleanupRef.current = () => dragImage.remove();
      workspaceDragVisualReleasedRef.current = false;
      setWorkspaceDragProxy({ x: event.clientX, y: event.clientY, label, count });
    },
    [],
  );

  const beginWorkspaceEntryDrag = useCallback(
    (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => {
      if (
        workspaceMovePending ||
        !activeMountReadyForOps ||
        activeMount?.access !== "readwrite" ||
        activeMount.canWrite === false
      ) {
        event.preventDefault();
        return;
      }
      const entries = resolveWorkspaceActionEntries(mountId, entry);
      if (entries.length === 0) {
        event.preventDefault();
        return;
      }
      clearAgentEntrySelection();
      if (!selectedEntryKeys.has(treeDirKey(mountId, entry.path))) {
        selectSingleWorkspaceEntryKey(treeDirKey(mountId, entry.path));
      }
      event.dataTransfer?.setData(
        WORKSPACE_INTERNAL_DRAG_TYPE,
        JSON.stringify({
          space: "user",
          mountId,
          rootName: activeMount?.rootName,
          paths: entries.map((item) => item.entry.path),
          entries: entries.map((item) => ({
            path: item.entry.path,
            name: item.entry.name,
            kind: item.entry.kind,
          })),
        }),
      );
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
      attachWorkspaceDragImage(event, entry.name, entries.length);
      commitWorkspaceDragState({
        source: { space: "user", mountId, entries, primaryPath: entry.path },
        target: null,
      });
    },
    [
      activeMount,
      activeMountReadyForOps,
      attachWorkspaceDragImage,
      clearAgentEntrySelection,
      commitWorkspaceDragState,
      resolveWorkspaceActionEntries,
      selectSingleWorkspaceEntryKey,
      selectedEntryKeys,
      workspaceMovePending,
    ],
  );

  const beginAgentEntryDrag = useCallback(
    (node: TreeNode, event: WorkspaceDragEvent) => {
      if (workspaceMovePending) {
        event.preventDefault();
        return;
      }
      const entries = resolveAgentActionNodes(node);
      if (entries.length === 0) {
        event.preventDefault();
        return;
      }
      const path = agentNodePath(node);
      clearWorkspaceEntrySelection();
      if (!selectedAgentEntryPaths.has(path)) selectSingleAgentEntryPath(path);
      event.dataTransfer?.setData(
        WORKSPACE_INTERNAL_DRAG_TYPE,
        JSON.stringify({ space: "agent", paths: entries.map(agentNodePath) }),
      );
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      attachWorkspaceDragImage(event, node.name, entries.length);
      commitWorkspaceDragState({
        source: { space: "agent", entries, primaryPath: path },
        target: null,
      });
    },
    [
      attachWorkspaceDragImage,
      clearWorkspaceEntrySelection,
      commitWorkspaceDragState,
      resolveAgentActionNodes,
      selectSingleAgentEntryPath,
      selectedAgentEntryPaths,
      workspaceMovePending,
    ],
  );

  const scheduleWorkspaceDragExpand = useCallback(
    (key: string, expand: (() => void) | undefined) => {
      if (!expand) {
        clearWorkspaceDragExpandTimer();
        return;
      }
      if (workspaceDragExpandKeyRef.current === key) return;
      clearWorkspaceDragExpandTimer();
      workspaceDragExpandKeyRef.current = key;
      workspaceDragExpandTimerRef.current = window.setTimeout(() => {
        workspaceDragExpandTimerRef.current = null;
        if (workspaceDragExpandKeyRef.current !== key || !workspaceDragRef.current) return;
        expand();
      }, WORKSPACE_DRAG_AUTO_EXPAND_MS);
    },
    [clearWorkspaceDragExpandTimer],
  );

  const updateWorkspaceDropTarget = useCallback(
    (
      event: WorkspaceDragEvent,
      target: Omit<WorkspaceDropTarget, "operation" | "validation">,
      expand?: () => void,
    ) => {
      const current = workspaceDragRef.current;
      if (!current || workspaceMovePending) return;
      const operation =
        current.source.space === "user" ? workspaceDragOperationFromModifiers(event) : "move";
      const validation: WorkspaceDropValidation =
        current.source.space !== target.space
          ? { valid: false, reason: "different-space" }
          : current.source.space === "user"
            ? validateWorkspaceEntryDrop(
                current.source.entries,
                target.mountId,
                target.dirPath,
                operation,
              )
            : validateAgentEntryDrop(current.source.entries, target.dirPath);
      if (event.dataTransfer) event.dataTransfer.dropEffect = validation.valid ? operation : "none";
      // Keep the native drop event enabled for our internal drag even while the
      // current modifier combination is invalid. The user can still press the
      // copy modifier between dragover and drop (for example, when copying into
      // the current folder), so drop must get a chance to re-evaluate it.
      event.preventDefault();
      event.stopPropagation();
      const nextTarget = { ...target, operation, validation };
      scheduleWorkspaceDragExpand(
        `${target.space}\u0000${target.mountId}\u0000${target.dirPath}`,
        validation.valid ? expand : undefined,
      );
      const previous = current.target;
      const previousValidationReason =
        previous && !previous.validation.valid ? previous.validation.reason : "";
      const nextValidationReason = validation.valid ? "" : validation.reason;
      const sameValidation =
        previous?.validation.valid === validation.valid &&
        previousValidationReason === nextValidationReason;
      if (
        previous?.surfaceKey === nextTarget.surfaceKey &&
        previous.operation === nextTarget.operation &&
        sameValidation
      ) {
        return;
      }
      commitWorkspaceDragState({ source: current.source, target: nextTarget });
    },
    [commitWorkspaceDragState, scheduleWorkspaceDragExpand, workspaceMovePending],
  );

  const clearWorkspaceDropTarget = useCallback(
    (event: WorkspaceDragEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      clearWorkspaceDragExpandTimer();
      const current = workspaceDragRef.current;
      if (current?.target) commitWorkspaceDragState({ source: current.source, target: null });
    },
    [clearWorkspaceDragExpandTimer, commitWorkspaceDragState],
  );

  const handleWorkspaceTreeDragLeave = useCallback(
    (event: WorkspaceDragEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      clearWorkspaceDropTarget(event);
      stopWorkspaceDragAutoScroll();
    },
    [clearWorkspaceDropTarget, stopWorkspaceDragAutoScroll],
  );

  const restartMovedPreviewTabLoad = useCallback(
    (space: WorkspaceSpaceView, tab: PreviewTab) => {
      const seq = ++previewRequestSeqRef.current;
      previewSeqByTabRef.current.set(tab.id, seq);

      void (async () => {
        try {
          const file =
            space === "agent"
              ? (await api.getAgentSpaceFile(sessionId, tab.path)).file
              : await getUserSpaceFile(tab.mountId, tab.path);
          const nextPreview = await buildPreview(file, tab.path);
          if (seq !== previewSeqByTabRef.current.get(tab.id)) {
            revokePreviewStateUrl(nextPreview);
            return;
          }
          const currentTab = previewTabsRef.current.find((item) => item.id === tab.id);
          if (!currentTab || currentTab.path !== tab.path) {
            revokePreviewStateUrl(nextPreview);
            return;
          }
          setPreviewTabs((current) => {
            const next = current.map((item) => {
              if (item.id !== tab.id) return item;
              disposePreviewTabResources(item);
              return {
                ...item,
                path: tab.path,
                title: nextPreview.name,
                state: nextPreview,
              };
            });
            previewTabsRef.current = next;
            return next;
          });
        } catch (err) {
          if (seq !== previewSeqByTabRef.current.get(tab.id)) return;
          const currentTab = previewTabsRef.current.find((item) => item.id === tab.id);
          if (!currentTab || currentTab.path !== tab.path) return;
          setPreviewTabs((current) => {
            const next = current.map((item) =>
              item.id === tab.id
                ? {
                    ...item,
                    path: tab.path,
                    state: previewLoadErrorState(tab.path, err),
                  }
                : item,
            );
            previewTabsRef.current = next;
            return next;
          });
        }
      })();
    },
    [sessionId],
  );

  const remapPreviewTabsAfterWorkspaceMove = useCallback(
    (
      space: WorkspaceSpaceView,
      mountId: string,
      userMoves: WorkspaceMove[],
      agentMoves: Array<{ path: string; newPath: string }>,
    ) => {
      const previous = previewTabsRef.current;
      let nextActiveId = activePreviewTabIdRef.current;
      const next: PreviewTab[] = [];
      const loadingTabsToRestart: PreviewTab[] = [];
      for (const tab of previous) {
        const belongsToMove =
          space === "user"
            ? !isAgentPreviewTabId(tab.id) &&
              !isWtermPreviewTabId(tab.id) &&
              tab.mountId === mountId
            : isAgentPreviewTabId(tab.id);
        const nextPath = belongsToMove
          ? space === "user"
            ? pathAfterWorkspaceMove(tab.path, userMoves)
            : pathAfterAgentMove(tab.path, agentMoves)
          : null;
        if (!nextPath) {
          next.push(tab);
          continue;
        }
        if (tab.state.status === "loading") {
          disposePreviewTabResources(tab);
          const nextTab = {
            ...tab,
            path: nextPath,
            title: previewTitleForPath(nextPath),
            state: { status: "loading" as const, path: nextPath },
          };
          next.push(nextTab);
          loadingTabsToRestart.push(nextTab);
          continue;
        }
        next.push({
          ...tab,
          path: nextPath,
          title: previewTitleForPath(nextPath),
          state: previewStateAtPath(tab.state, nextPath),
        });
      }
      if (!nextActiveId) nextActiveId = next[0]?.id || "";
      previewTabsRef.current = next;
      setPreviewTabs(next);
      activePreviewTabIdRef.current = nextActiveId;
      setActivePreviewTabId(nextActiveId);
      for (const tab of loadingTabsToRestart) restartMovedPreviewTabLoad(space, tab);
    },
    [restartMovedPreviewTabLoad],
  );

  const updateUserTreePathsAfterMove = useCallback(
    (mountId: string, moves: WorkspaceMove[], targetDirPath: string) => {
      const movedDirectories = moves.filter((move) => move.kind === "directory");
      const remapDirectoryPath = (path: string) => pathAfterWorkspaceMove(path, movedDirectories);
      setOpenDirs((current) => {
        const next = new Set<string>();
        for (const key of current) {
          const separatorIndex = key.indexOf("\u0000");
          if (separatorIndex < 0 || key.slice(0, separatorIndex) !== mountId) {
            next.add(key);
            continue;
          }
          const path = key.slice(separatorIndex + 1);
          next.add(treeDirKey(mountId, remapDirectoryPath(path) || path));
        }
        if (targetDirPath) next.add(treeDirKey(mountId, targetDirPath));
        return next;
      });
      const isMovedDirectoryPath = (path: string) =>
        movedDirectories.some(
          (move) => path === move.sourcePath || path.startsWith(`${move.sourcePath}/`),
        );
      for (const key of Array.from(directoryRequestSeqByPathRef.current.keys())) {
        const separatorIndex = key.indexOf("\u0000");
        if (
          separatorIndex >= 0 &&
          key.slice(0, separatorIndex) === mountId &&
          isMovedDirectoryPath(key.slice(separatorIndex + 1))
        ) {
          directoryRequestSeqByPathRef.current.set(
            key,
            (directoryRequestSeqByPathRef.current.get(key) || 0) + 1,
          );
        }
      }
      const pruneMovedDirectories = <T,>(current: Map<string, T>) => {
        const next = new Map(current);
        for (const key of next.keys()) {
          const separatorIndex = key.indexOf("\u0000");
          if (
            separatorIndex >= 0 &&
            key.slice(0, separatorIndex) === mountId &&
            isMovedDirectoryPath(key.slice(separatorIndex + 1))
          ) {
            next.delete(key);
          }
        }
        return next;
      };
      setEntriesByDir(pruneMovedDirectories);
      setCursorsByDir(pruneMovedDirectories);
      setDirErrors(pruneMovedDirectories);
      setLoadingDirs((current) => {
        const next = new Set(current);
        for (const key of next) {
          const separatorIndex = key.indexOf("\u0000");
          if (
            separatorIndex >= 0 &&
            key.slice(0, separatorIndex) === mountId &&
            isMovedDirectoryPath(key.slice(separatorIndex + 1))
          ) {
            next.delete(key);
          }
        }
        return next;
      });
    },
    [],
  );

  const treeVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: workspaceTreeItems.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => TREE_ROW_PITCH_PX,
    getItemKey: (index) => workspaceTreeItems[index]?.getKey() || index,
    overscan: TREE_VIRTUAL_OVERSCAN,
    initialRect: { width: 320, height: 640 },
    directDomUpdates: true,
    useFlushSync: false,
    enabled: spaceView === "user",
  });
  const workspaceTreeItemsRef = useRef(workspaceTreeItems);
  workspaceTreeItemsRef.current = workspaceTreeItems;
  const treeVirtualizerRef = useRef(treeVirtualizer);
  treeVirtualizerRef.current = treeVirtualizer;
  const focusWorkspaceEntryAfterMutation = useCallback((mountId: string, path: string) => {
    const key = treeDirKey(mountId, path);
    const reveal = (attempt: number) => {
      const index = workspaceTreeItemsRef.current.findIndex(
        (item) => workspaceEntryKeyForTreeItem(item) === key,
      );
      if (index < 0 && attempt < 6) {
        window.requestAnimationFrame(() => reveal(attempt + 1));
        return;
      }
      if (index >= 0) {
        treeVirtualizerRef.current.scrollToIndex(index, { align: "auto" });
      }
      focusWorkspaceTreeRow(`user-space-entry-row-${mountId}:${path}`);
    };
    window.requestAnimationFrame(() => reveal(0));
  }, []);
  const treeContainerProps = workspaceTree.getContainerProps(workspaceCopy.workspaceTreeLabel);
  const {
    ref: headlessTreeRef,
    onKeyDown: headlessTreeKeyDown,
    ...treeA11yProps
  } = treeContainerProps;

  useLayoutEffect(() => {
    onPreviewOpenChangeRef.current = onPreviewOpenChange;
  }, [onPreviewOpenChange]);

  const setPreviewOpen = useCallback(
    (open: boolean, allowOpeningWithPendingTab = false, resetLayout = false) => {
      if (open && previewTabsRef.current.length === 0 && !allowOpeningWithPendingTab) return;
      if (resetLayout) setSpacePanelCollapsed(false);
      const changePreviewOpen = onPreviewOpenChangeRef.current;
      if (changePreviewOpen) {
        if (resetLayout) changePreviewOpen(open, { resetLayout: true });
        else changePreviewOpen(open);
      } else {
        setUncontrolledPreviewOpen(open);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!requestedPreviewOpen || previewTabs.length > 0) return;
    setPreviewOpen(false);
  }, [previewTabs.length, requestedPreviewOpen, setPreviewOpen]);

  const closePreviewTabsByIds = useCallback(
    (tabIds: string[], options: { resetLayoutIfEmpty?: boolean } = {}) => {
      if (tabIds.length === 0) return;
      const tabIdSet = new Set(tabIds);
      const current = previewTabsRef.current;
      const next = current.filter((tab) => !tabIdSet.has(tab.id));
      if (next.length === current.length) return;
      for (const tab of current) {
        if (!tabIdSet.has(tab.id)) continue;
        disposePreviewTabResources(tab);
        previewSeqByTabRef.current.delete(tab.id);
      }
      setPreviewTabs(next);
      previewTabsRef.current = next;
      if (next.length === 0 && options.resetLayoutIfEmpty) {
        setPreviewOpen(false, false, true);
      }
      const nextActiveTab = next.find((tab) => tab.id === activePreviewTabId) || next[0] || null;
      setActivePreviewTabId(nextActiveTab?.id || "");
      if (nextActiveTab && isAgentPreviewTabId(nextActiveTab.id)) {
        clearWorkspaceEntrySelection();
        selectSingleAgentEntryPath(nextActiveTab.path);
      } else {
        clearAgentEntrySelection();
        selectSingleWorkspaceEntryKey(selectedEntryKeyForPreviewTab(nextActiveTab));
      }
    },
    [
      activePreviewTabId,
      clearAgentEntrySelection,
      clearWorkspaceEntrySelection,
      selectSingleAgentEntryPath,
      selectSingleWorkspaceEntryKey,
      setPreviewOpen,
    ],
  );

  const closePreviewTabsOutsideMount = useCallback(
    (mountId: string, options: { force?: boolean } = {}) => {
      const tabsToClose = previewTabsRef.current.filter(
        (tab) => tab.mountId && tab.mountId !== mountId,
      );
      if (tabsToClose.length === 0) return;
      const dirtyTabs = tabsToClose.filter((tab) => tab.hasUnsavedChanges);
      const cleanTabIds = tabsToClose.filter((tab) => !tab.hasUnsavedChanges).map((tab) => tab.id);
      if (options.force) {
        closePreviewTabsByIds(tabsToClose.map((tab) => tab.id));
        return;
      }
      if (dirtyTabs.length > 0) {
        setPendingPreviewClose({ kind: "tabs", tabIds: dirtyTabs.map((tab) => tab.id) });
      }
      closePreviewTabsByIds(cleanTabIds);
    },
    [closePreviewTabsByIds],
  );

  useLayoutEffect(() => {
    previewTabsRef.current = previewTabs;
  }, [previewTabs]);

  useEffect(() => {
    onActiveOfficePreviewChange?.(activePreviewIsOffice);
  }, [activePreviewIsOffice, onActiveOfficePreviewChange]);

  useEffect(() => {
    cursorsByDirRef.current = cursorsByDir;
  }, [cursorsByDir]);

  useEffect(() => {
    const directoryRetryTimers = directoryRetryTimersRef.current;
    return () => {
      for (const timer of directoryRetryTimers.values()) window.clearTimeout(timer);
      directoryRetryTimers.clear();
    };
  }, []);

  useEffect(() => {
    if (visibleMounts.length === 0) return;
    if (!visibleMounts.some((mount) => mount.mountId === activeMountId)) {
      const preferredMountId = readActiveUserSpaceMountId(sessionId);
      const nextMountId = visibleMounts.some((mount) => mount.mountId === preferredMountId)
        ? preferredMountId
        : visibleMounts[0]?.mountId || "";
      setActiveMountId(nextMountId);
      closePreviewTabsOutsideMount(nextMountId);
      if (nextMountId) writeActiveUserSpaceMountId(sessionId, nextMountId);
    }
  }, [activeMountId, closePreviewTabsOutsideMount, sessionId, visibleMounts]);

  useEffect(() => {
    const visibleIds = new Set(visibleMounts.map((mount) => mount.mountId));
    setExpandedMountIds((current) => {
      const next = new Set(Array.from(current).filter((mountId) => visibleIds.has(mountId)));
      if (activeMountIdForOps) next.add(activeMountIdForOps);
      if (sameStringSets(current, next)) return current;
      return next;
    });
    setAuthorizationSettledOfflineMountIds((current) => {
      const next = new Set(
        Array.from(current).filter(
          (mountId) => visibleIds.has(mountId) && !localMountById.has(mountId),
        ),
      );
      if (sameStringSets(current, next)) return current;
      return next;
    });
  }, [activeMountIdForOps, localMountById, visibleMounts]);

  const resetTree = useCallback(
    (options: { preservePreviewTabs?: boolean } = {}) => {
      requestSeqRef.current++;
      for (const timer of directoryRetryTimersRef.current.values()) window.clearTimeout(timer);
      directoryRetryTimersRef.current.clear();
      setOpenDirs(new Set([ROOT_PATH]));
      setEntriesByDir(new Map());
      setCursorsByDir(new Map());
      setLoadingDirs(new Set());
      setDirErrors(new Map());
      setRootSettledMountIds(new Set());
      if (!options.preservePreviewTabs) {
        clearWorkspaceEntrySelection();
        setPreviewTabs((current) => {
          for (const tab of current) disposePreviewTabResources(tab);
          return [];
        });
        previewTabsRef.current = [];
        setActivePreviewTabId("");
        previewSeqByTabRef.current.clear();
      }
      directoryRequestSeqByPathRef.current.clear();
    },
    [clearWorkspaceEntrySelection],
  );

  const loadDirectory = useCallback(
    async (mountId: string, dirPath: string, append = false) => {
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      const targetIsMounted = Boolean(
        target && target.status === "mounted" && localMountById.has(mountId),
      );
      if (!mountId || !targetIsMounted) return;
      const key = treeDirKey(mountId, dirPath);
      const treeSeq = requestSeqRef.current;
      const dirSeq = (directoryRequestSeqByPathRef.current.get(key) || 0) + 1;
      directoryRequestSeqByPathRef.current.set(key, dirSeq);
      setLoadingDirs((current) => new Set(current).add(key));
      setDirErrors((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });

      try {
        const cursor = append ? cursorsByDirRef.current.get(key) : undefined;
        const result = await withTimeout(
          executeUserSpaceOperation("list_dir", {
            mountId,
            path: dirPath,
            limit: DIRECTORY_PAGE_SIZE,
            cursor,
            includeHidden: showHiddenEntries,
          }) as Promise<{ entries?: WorkspaceEntry[]; nextCursor?: string }>,
          directoryLoadTimeoutMs,
          workspaceCopy.directoryLoadTimeout,
        );
        if (
          treeSeq !== requestSeqRef.current ||
          directoryRequestSeqByPathRef.current.get(key) !== dirSeq
        )
          return;
        const retryTimer = directoryRetryTimersRef.current.get(key);
        if (retryTimer) {
          window.clearTimeout(retryTimer);
          directoryRetryTimersRef.current.delete(key);
        }
        setEntriesByDir((current) => {
          const next = new Map(current);
          const previous = append ? current.get(key) || [] : [];
          next.set(key, [
            ...previous,
            ...(result.entries || []).filter(
              (entry) => showHiddenEntries || !isHiddenWorkspaceEntry(entry),
            ),
          ]);
          return next;
        });
        setCursorsByDir((current) => {
          const next = new Map(current);
          next.set(key, result.nextCursor);
          return next;
        });
        if (dirPath === ROOT_PATH && !append) {
          setRootSettledMountIds((current) => new Set(current).add(mountId));
        }
      } catch (err) {
        if (
          treeSeq !== requestSeqRef.current ||
          directoryRequestSeqByPathRef.current.get(key) !== dirSeq
        )
          return;
        const runtimeRestarting = isUserSpaceRuntimeDisposedError(err);
        const message = runtimeRestarting
          ? workspaceCopy.directoryRuntimeRestarting
          : err instanceof Error
            ? err.message
            : workspaceCopy.directoryLoadFailed;
        setDirErrors((current) => {
          const next = new Map(current);
          next.set(key, message);
          return next;
        });
        if (dirPath === ROOT_PATH && !append) {
          setRootSettledMountIds((current) => new Set(current).add(mountId));
        }
        const shouldRetryAutomatically =
          runtimeRestarting ||
          (dirPath === ROOT_PATH && !append && message === workspaceCopy.directoryLoadTimeout);
        if (shouldRetryAutomatically && !directoryRetryTimersRef.current.has(key)) {
          const timer = window.setTimeout(
            () => {
              directoryRetryTimersRef.current.delete(key);
              void loadDirectoryRef.current?.(mountId, dirPath, append);
            },
            runtimeRestarting ? 0 : directoryRetryDelayMs,
          );
          directoryRetryTimersRef.current.set(key, timer);
        }
      } finally {
        if (
          treeSeq === requestSeqRef.current &&
          directoryRequestSeqByPathRef.current.get(key) === dirSeq
        ) {
          setLoadingDirs((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [
      directoryLoadTimeoutMs,
      directoryRetryDelayMs,
      localMountById,
      showHiddenEntries,
      visibleMounts,
    ],
  );

  useEffect(() => {
    loadDirectoryRef.current = loadDirectory;
  }, [loadDirectory]);

  const loadDirectoryThroughPaths = useCallback(
    async (mountId: string, dirPath: string, requiredPaths: string[]) => {
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      const targetIsMounted = Boolean(
        target && target.status === "mounted" && localMountById.has(mountId),
      );
      if (!mountId || !targetIsMounted) return;

      const visibleRequiredPaths = new Set(
        requiredPaths
          .map(normalizeWorkspacePath)
          .filter(
            (path) => path && (showHiddenEntries || !(path.split("/").pop() || "").startsWith(".")),
          ),
      );
      if (visibleRequiredPaths.size === 0) {
        await loadDirectory(mountId, dirPath);
        return;
      }

      const key = treeDirKey(mountId, dirPath);
      const treeSeq = requestSeqRef.current;
      const dirSeq = (directoryRequestSeqByPathRef.current.get(key) || 0) + 1;
      directoryRequestSeqByPathRef.current.set(key, dirSeq);
      setLoadingDirs((current) => new Set(current).add(key));
      setDirErrors((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });

      const entriesByPath = new Map<string, WorkspaceEntry>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      try {
        while (true) {
          const result = await withTimeout(
            executeUserSpaceOperation("list_dir", {
              mountId,
              path: dirPath,
              limit: DIRECTORY_PAGE_SIZE,
              cursor,
              includeHidden: showHiddenEntries,
            }) as Promise<{ entries?: WorkspaceEntry[]; nextCursor?: string }>,
            directoryLoadTimeoutMs,
            workspaceCopy.directoryLoadTimeout,
          );
          if (
            treeSeq !== requestSeqRef.current ||
            directoryRequestSeqByPathRef.current.get(key) !== dirSeq
          ) {
            return;
          }

          for (const entry of result.entries || []) {
            visibleRequiredPaths.delete(normalizeWorkspacePath(entry.path));
            if (showHiddenEntries || !isHiddenWorkspaceEntry(entry)) {
              entriesByPath.set(entry.path, entry);
            }
          }
          const nextCursor = result.nextCursor;
          if (visibleRequiredPaths.size === 0 || !nextCursor || seenCursors.has(nextCursor)) {
            cursor = nextCursor;
            break;
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        const retryTimer = directoryRetryTimersRef.current.get(key);
        if (retryTimer) {
          window.clearTimeout(retryTimer);
          directoryRetryTimersRef.current.delete(key);
        }
        setEntriesByDir((current) => {
          const next = new Map(current);
          next.set(key, Array.from(entriesByPath.values()));
          return next;
        });
        setCursorsByDir((current) => {
          const next = new Map(current);
          next.set(key, cursor);
          cursorsByDirRef.current = next;
          return next;
        });
        if (dirPath === ROOT_PATH) {
          setRootSettledMountIds((current) => new Set(current).add(mountId));
        }
      } catch {
        if (
          treeSeq === requestSeqRef.current &&
          directoryRequestSeqByPathRef.current.get(key) === dirSeq
        ) {
          await loadDirectory(mountId, dirPath);
        }
      } finally {
        if (
          treeSeq === requestSeqRef.current &&
          directoryRequestSeqByPathRef.current.get(key) === dirSeq
        ) {
          setLoadingDirs((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [directoryLoadTimeoutMs, loadDirectory, localMountById, showHiddenEntries, visibleMounts],
  );

  useEffect(() => {
    if (lastShowHiddenEntriesRef.current === showHiddenEntries) {
      return;
    }
    lastShowHiddenEntriesRef.current = showHiddenEntries;
    resetTree();
    if (activeMount?.status === "mounted" && localMountById.has(activeMount.mountId)) {
      void loadDirectory(activeMount.mountId, ROOT_PATH);
    }
  }, [activeMount, loadDirectory, localMountById, resetTree, showHiddenEntries]);

  useEffect(() => {
    if (
      !activeMount ||
      activeMount.status !== "mounted" ||
      !localMountById.has(activeMount.mountId)
    )
      return;
    const key = treeDirKey(activeMount.mountId, ROOT_PATH);
    if (!entriesByDir.has(key) && !loadingDirs.has(key) && !dirErrors.has(key)) {
      void loadDirectory(activeMount.mountId, ROOT_PATH);
    }
  }, [activeMount, dirErrors, entriesByDir, loadDirectory, loadingDirs, localMountById]);

  const switchActiveMount = useCallback(
    (mountId: string) => {
      if (!mountId || mountId === activeMountIdForOps) return;
      const previousMountId = activeMountIdForOps;
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      if (!target) return;
      setActiveMountId(mountId);
      closePreviewTabsOutsideMount(mountId, { force: true });
      writeActiveUserSpaceMountId(sessionId, mountId);
      setExpandedMountIds((current) => new Set(current).add(mountId));
      const key = treeDirKey(mountId, ROOT_PATH);
      if (
        target?.status === "mounted" &&
        localMountById.has(mountId) &&
        !entriesByDir.has(key) &&
        !loadingDirs.has(key)
      ) {
        void loadDirectory(mountId, ROOT_PATH);
      }
      const nextMounts = [target, ...visibleMounts.filter((mount) => mount.mountId !== mountId)];
      const syncSeq = activeMountSyncSeqRef.current + 1;
      activeMountSyncSeqRef.current = syncSeq;
      configureSessionUserSpace(toUserSpaceConfig(nextMounts), mountId, {
        onSuccess: (configured) => {
          if (activeMountSyncSeqRef.current !== syncSeq) return;
          onMountsConfigured?.(configured.user_spaces);
          resendSessionUserSpaces(sessionId);
        },
        onError: (err) => {
          if (activeMountSyncSeqRef.current !== syncSeq) return;
          setActiveMountId(previousMountId);
          if (previousMountId) writeActiveUserSpaceMountId(sessionId, previousMountId);
          setError(err instanceof Error ? err.message : String(err));
        },
      });
    },
    [
      activeMountIdForOps,
      closePreviewTabsOutsideMount,
      configureSessionUserSpace,
      entriesByDir,
      loadDirectory,
      loadingDirs,
      localMountById,
      onMountsConfigured,
      sessionId,
      visibleMounts,
    ],
  );

  const selectActiveMount = useCallback(
    (mountId: string) => {
      if (!mountId || mountId === activeMountIdForOps) return;
      const tabsToClose = previewTabsRef.current.filter((tab) => tab.mountId !== mountId);
      setPendingMountSwitch({ mountId, tabIds: tabsToClose.map((tab) => tab.id) });
    },
    [activeMountIdForOps],
  );

  const confirmPendingMountSwitch = useCallback(() => {
    const pending = pendingMountSwitch;
    if (!pending) return;
    setPendingMountSwitch(null);
    switchActiveMount(pending.mountId);
  }, [pendingMountSwitch, switchActiveMount]);

  const revealWorkspaceEntry = useCallback(
    async (mountId: string, path: string, kind: WorkspaceEntry["kind"] = "file") => {
      if (!mountId) return;
      const normalizedPath = normalizeWorkspacePath(path);
      const parentDirs = parentDirectoryPaths(normalizedPath);
      const dirsToOpen =
        kind === "directory" && normalizedPath ? [...parentDirs, normalizedPath] : parentDirs;
      setSpaceView("user");
      setActiveMountId(mountId);
      clearAgentEntrySelection();
      setExpandedMountIds((current) => {
        if (current.has(mountId)) return current;
        const next = new Set(current);
        next.add(mountId);
        return next;
      });
      if (dirsToOpen.length > 0) {
        setOpenDirs((current) => {
          let changed = false;
          const next = new Set(current);
          for (const dirPath of dirsToOpen) {
            const key = treeDirKey(mountId, dirPath);
            if (next.has(key)) continue;
            next.add(key);
            changed = true;
          }
          return changed ? next : current;
        });
      }
      selectSingleWorkspaceEntryKey(treeDirKey(mountId, normalizedPath));
      await loadDirectory(mountId, ROOT_PATH);
      for (const dirPath of parentDirs) await loadDirectory(mountId, dirPath);
      if (kind === "directory" && normalizedPath) await loadDirectory(mountId, normalizedPath);
    },
    [clearAgentEntrySelection, loadDirectory, selectSingleWorkspaceEntryKey],
  );

  const toggleDirectory = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const key = treeDirKey(mountId, entry.path);
      const shouldLoad = !openDirs.has(key) && !entriesByDir.has(key);
      setActiveMountId(mountId);
      selectSingleWorkspaceEntryKey(key);
      setOpenDirs((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      if (shouldLoad) void loadDirectory(mountId, entry.path);
    },
    [entriesByDir, loadDirectory, openDirs, selectSingleWorkspaceEntryKey],
  );

  const openFilePreview = useCallback(
    async (
      mountId: string,
      path: string,
      previewKind?: WorkspaceEntry["previewKind"],
      requestedViewMode?: PreviewViewMode,
      prefetchedFile?: File,
      fileSize?: number,
      openPanel = true,
      pinTab = false,
    ) => {
      if (!mountId) return;
      const previewSupported = isPreviewableFile(path, previewKind);
      const existingTab = previewTabsRef.current.find(
        (tab) =>
          !isAgentPreviewTabId(tab.id) &&
          !isWtermPreviewTabId(tab.id) &&
          tab.mountId === mountId &&
          tab.path === path,
      );
      if (existingTab) {
        if (
          existingTab.state.status === "error" &&
          existingTab.state.messageKey === "unsupportedPreview" &&
          typeof fileSize === "number"
        ) {
          setPreviewTabs((current) =>
            current.map((tab) =>
              tab.id === existingTab.id ? { ...tab, state: { ...tab.state, size: fileSize } } : tab,
            ),
          );
        }
        setActiveMountId(existingTab.mountId);
        clearAgentEntrySelection();
        selectSingleWorkspaceEntryKey(treeDirKey(existingTab.mountId, existingTab.path));
        setExpandedMountIds((current) => {
          if (current.has(existingTab.mountId)) return current;
          const next = new Set(current);
          next.add(existingTab.mountId);
          return next;
        });
        const parentDirs = parentDirectoryPaths(existingTab.path);
        if (parentDirs.length > 0) {
          setOpenDirs((current) => {
            let changed = false;
            const next = new Set(current);
            for (const parentDir of parentDirs) {
              const key = treeDirKey(existingTab.mountId, parentDir);
              if (next.has(key)) continue;
              next.add(key);
              changed = true;
            }
            return changed ? next : current;
          });
        }
        if (openPanel) setPreviewOpen(true);
        setActivePreviewTabId(existingTab.id);
        if (requestedViewMode || (pinTab && !existingTab.pinned)) {
          setPreviewTabs((current) => {
            const updated = current.map((tab) =>
              tab.id === existingTab.id
                ? {
                    ...tab,
                    ...(requestedViewMode ? { viewMode: requestedViewMode } : {}),
                    ...(pinTab ? { pinned: true } : {}),
                  }
                : tab,
            );
            const next = pinTab
              ? [...updated.filter((tab) => tab.pinned), ...updated.filter((tab) => !tab.pinned)]
              : updated;
            previewTabsRef.current = next;
            return next;
          });
        }
        return;
      }
      const tabId = availablePreviewTabId(previewTabId(mountId, path), previewTabsRef.current);
      const seq = ++previewRequestSeqRef.current;
      previewSeqByTabRef.current.set(tabId, seq);
      const loadingState: PreviewState = previewSupported
        ? { status: "loading", path }
        : unsupportedPreviewState(path, fileSize);
      setActiveMountId(mountId);
      clearAgentEntrySelection();
      selectSingleWorkspaceEntryKey(treeDirKey(mountId, path));
      if (openPanel) setPreviewOpen(true, true);
      setActivePreviewTabId(tabId);
      setPreviewTabs((current) => {
        const existing = current.find((tab) => tab.id === tabId);
        const nextTab: PreviewTab = {
          id: tabId,
          mountId,
          path,
          title: previewTitleForPath(path),
          viewMode: requestedViewMode || existing?.viewMode || defaultPreviewViewModeForPath(path),
          state: loadingState,
          ...(pinTab || existing?.pinned ? { pinned: true } : {}),
        };
        if (existing) disposePreviewTabResources(existing);
        const { tabs, closedTabs } = upsertPreviewTab(current, nextTab);
        for (const closedTab of closedTabs) {
          disposePreviewTabResources(closedTab);
          previewSeqByTabRef.current.delete(closedTab.id);
        }
        previewTabsRef.current = tabs;
        return tabs;
      });

      if (!previewSupported) return;

      try {
        const file = prefetchedFile ?? (await getUserSpaceFile(mountId, path));
        const nextPreview = await buildPreview(file, path);
        if (seq !== previewSeqByTabRef.current.get(tabId)) {
          revokePreviewStateUrl(nextPreview);
          return;
        }
        setPreviewTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            disposePreviewTabResources(tab);
            return {
              ...tab,
              title: nextPreview.name,
              viewMode: requestedViewMode || defaultPreviewViewMode(nextPreview),
              state: nextPreview,
            };
          }),
        );
      } catch (err) {
        if (seq !== previewSeqByTabRef.current.get(tabId)) return;
        setPreviewTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            disposePreviewTabResources(tab);
            return {
              ...tab,
              state: previewLoadErrorState(path, err),
            };
          }),
        );
      }
    },
    [clearAgentEntrySelection, selectSingleWorkspaceEntryKey, setPreviewOpen],
  );

  const openWorkspaceFiles = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      for (const item of resolveWorkspaceActionEntries(mountId, entry, false)) {
        if (item.entry.kind !== "file") continue;
        void openFilePreview(
          item.mountId,
          item.entry.path,
          item.entry.previewKind,
          undefined,
          undefined,
          item.entry.size,
        );
      }
    },
    [openFilePreview, resolveWorkspaceActionEntries],
  );

  const openAndPinWorkspaceFiles = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      for (const item of resolveWorkspaceActionEntries(mountId, entry, false)) {
        if (item.entry.kind !== "file") continue;
        void openFilePreview(
          item.mountId,
          item.entry.path,
          item.entry.previewKind,
          undefined,
          undefined,
          item.entry.size,
          true,
          true,
        );
      }
    },
    [openFilePreview, resolveWorkspaceActionEntries],
  );

  const openWorkspaceFileInNewWindow = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      if (typeof window === "undefined" || entry.kind !== "file") return false;
      const existingTab = previewTabsRef.current.find(
        (tab) =>
          !isAgentPreviewTabId(tab.id) &&
          !isWtermPreviewTabId(tab.id) &&
          tab.mountId === mountId &&
          tab.path === entry.path,
      );
      const tabId =
        existingTab?.id ||
        availablePreviewTabId(previewTabId(mountId, entry.path), previewTabsRef.current);
      const popout = window.open("", "_blank", DETACHED_PREVIEW_WINDOW_FEATURES);
      if (!popout) return false;
      popout.document.title = entry.name;
      const request: DetachedPreviewWindowRequest = {
        id: ++detachedWindowRequestIdRef.current,
        tabId,
        win: popout,
      };
      setDetachedWindowRequests((current) => [...current, request]);
      void openFilePreview(
        mountId,
        entry.path,
        entry.previewKind,
        undefined,
        undefined,
        entry.size,
        false,
      );
      return true;
    },
    [openFilePreview],
  );

  const openWorkspaceFilesInNewWindows = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const files = resolveWorkspaceActionEntries(mountId, entry, false).filter(
        (item) => item.entry.kind === "file",
      );
      if (files.length === 0) return;
      const blocked = files.filter(
        (item) => !openWorkspaceFileInNewWindow(item.mountId, item.entry),
      );
      setBlockedDetachedWindowEntries(blocked);
    },
    [openWorkspaceFileInNewWindow, resolveWorkspaceActionEntries],
  );

  const retryBlockedDetachedWindows = useCallback(() => {
    const stillBlocked = blockedDetachedWindowEntries.filter(
      (item) => !openWorkspaceFileInNewWindow(item.mountId, item.entry),
    );
    setBlockedDetachedWindowEntries(stillBlocked);
  }, [blockedDetachedWindowEntries, openWorkspaceFileInNewWindow]);

  const openWorkspaceSearch = useCallback((mountId: string) => {
    if (!mountId) return;
    setWorkspaceSearchMountId(mountId);
  }, []);

  useEffect(() => {
    if (openSearchRequest <= handledOpenSearchRequestRef.current) return;
    handledOpenSearchRequestRef.current = openSearchRequest;
    if (workspaceSearchMountId) return;
    const targetMount =
      visibleMounts.find(
        (mount) => mount.mountId === activeMountId && mount.status === "mounted",
      ) || visibleMounts.find((mount) => mount.status === "mounted");
    if (targetMount) openWorkspaceSearch(targetMount.mountId);
  }, [
    activeMountId,
    openSearchRequest,
    openWorkspaceSearch,
    visibleMounts,
    workspaceSearchMountId,
  ]);

  const openWorkspaceSearchResult = useCallback(
    async (mountId: string, result: WorkspaceSearchResult) => {
      if (!mountId) return;
      if (result.kind === "path") {
        await revealWorkspaceEntry(mountId, result.entry.path, result.entry.kind);
        if (result.entry.kind === "file") {
          await openFilePreview(
            mountId,
            result.entry.path,
            result.entry.previewKind,
            undefined,
            undefined,
            result.entry.size,
          );
        }
      } else {
        await revealWorkspaceEntry(mountId, result.path, "file");
        await openFilePreview(mountId, result.path);
      }
      setWorkspaceSearchMountId("");
    },
    [openFilePreview, revealWorkspaceEntry],
  );

  const openAgentFilePreview = useCallback(
    async (
      path: string,
      previewKind?: WorkspaceEntry["previewKind"],
      requestedViewMode?: PreviewViewMode,
      fileSize?: number,
    ) => {
      if (!path) return;
      const previewSupported = isPreviewableAgentFile(path, previewKind);
      const existingTab = previewTabsRef.current.find(
        (tab) => isAgentPreviewTabId(tab.id) && tab.path === path,
      );
      if (existingTab) {
        if (
          existingTab.state.status === "error" &&
          existingTab.state.messageKey === "unsupportedPreview" &&
          typeof fileSize === "number"
        ) {
          setPreviewTabs((current) =>
            current.map((tab) =>
              tab.id === existingTab.id ? { ...tab, state: { ...tab.state, size: fileSize } } : tab,
            ),
          );
        }
        setSpaceView("agent");
        clearWorkspaceEntrySelection();
        selectSingleAgentEntryPath(path);
        setPreviewOpen(true);
        setActivePreviewTabId(existingTab.id);
        if (requestedViewMode) {
          setPreviewTabs((current) =>
            current.map((tab) =>
              tab.id === existingTab.id ? { ...tab, viewMode: requestedViewMode } : tab,
            ),
          );
        }
        return;
      }
      const tabId = availablePreviewTabId(agentPreviewTabId(path), previewTabsRef.current);
      const seq = ++previewRequestSeqRef.current;
      previewSeqByTabRef.current.set(tabId, seq);
      const loadingState: PreviewState = previewSupported
        ? { status: "loading", path }
        : unsupportedPreviewState(path, fileSize);
      setSpaceView("agent");
      clearWorkspaceEntrySelection();
      selectSingleAgentEntryPath(path);
      setPreviewOpen(true, true);
      setActivePreviewTabId(tabId);
      setPreviewTabs((current) => {
        const existing = current.find((tab) => tab.id === tabId);
        const nextTab: PreviewTab = {
          id: tabId,
          mountId: "",
          path,
          title: previewTitleForPath(path),
          viewMode: requestedViewMode || existing?.viewMode || defaultPreviewViewModeForPath(path),
          state: loadingState,
        };
        if (existing) disposePreviewTabResources(existing);
        const { tabs, closedTabs } = upsertPreviewTab(current, nextTab);
        for (const closedTab of closedTabs) {
          disposePreviewTabResources(closedTab);
          previewSeqByTabRef.current.delete(closedTab.id);
        }
        return tabs;
      });

      if (!previewSupported) return;

      try {
        const { file } = await api.getAgentSpaceFile(sessionId, path);
        const nextPreview = await buildPreview(file, path);
        if (seq !== previewSeqByTabRef.current.get(tabId)) {
          revokePreviewStateUrl(nextPreview);
          return;
        }
        setPreviewTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            disposePreviewTabResources(tab);
            return {
              ...tab,
              title: nextPreview.name,
              viewMode: requestedViewMode || defaultPreviewViewMode(nextPreview),
              state: nextPreview,
            };
          }),
        );
      } catch (err) {
        if (seq !== previewSeqByTabRef.current.get(tabId)) return;
        setPreviewTabs((current) =>
          current.map((tab) => {
            if (tab.id !== tabId) return tab;
            disposePreviewTabResources(tab);
            return {
              ...tab,
              state: previewLoadErrorState(path, err),
            };
          }),
        );
      }
    },
    [clearWorkspaceEntrySelection, selectSingleAgentEntryPath, sessionId, setPreviewOpen],
  );

  const syncPreviewTabFocus = useCallback(
    (tab: PreviewTab | null | undefined) => {
      if (!tab) {
        clearAllTreeSelection();
        return;
      }
      if (isWtermPreviewTabId(tab.id)) {
        if (tab.mountId) {
          setActiveMountId(tab.mountId);
          writeActiveUserSpaceMountId(sessionId, tab.mountId);
        }
        clearAllTreeSelection();
        return;
      }
      if (isAgentPreviewTabId(tab.id)) {
        setSpaceView("agent");
        selectSingleAgentEntryPath(tab.path);
        clearWorkspaceEntrySelection();
        return;
      }
      clearAgentEntrySelection();
      setActiveMountId(tab.mountId);
      selectSingleWorkspaceEntryKey(treeDirKey(tab.mountId, tab.path));
      setExpandedMountIds((current) => {
        if (current.has(tab.mountId)) return current;
        const next = new Set(current);
        next.add(tab.mountId);
        return next;
      });
      const parentDirs = parentDirectoryPaths(tab.path);
      if (parentDirs.length === 0) return;
      setOpenDirs((current) => {
        let changed = false;
        const next = new Set(current);
        for (const parentDir of parentDirs) {
          const key = treeDirKey(tab.mountId, parentDir);
          if (next.has(key)) continue;
          next.add(key);
          changed = true;
        }
        return changed ? next : current;
      });
    },
    [
      clearAgentEntrySelection,
      clearAllTreeSelection,
      clearWorkspaceEntrySelection,
      selectSingleAgentEntryPath,
      selectSingleWorkspaceEntryKey,
      sessionId,
    ],
  );

  const selectPreviewTab = useCallback(
    (tabId: string) => {
      const tab = previewTabsRef.current.find((item) => item.id === tabId);
      if (!tab) return;
      setActivePreviewTabId(tabId);
      syncPreviewTabFocus(tab);
    },
    [syncPreviewTabFocus],
  );

  const hydrateRestoredPreviewTab = useCallback(
    async (persistedTab: PersistedPreviewTab, restoreSeq: number) => {
      const previewSupported =
        persistedTab.space === "agent"
          ? isPreviewableAgentFile(persistedTab.path, persistedTab.previewKind)
          : isPreviewableFile(persistedTab.path, persistedTab.previewKind);
      if (!previewSupported) return;
      const tabSeq = previewSeqByTabRef.current.get(persistedTab.id);
      if (tabSeq === undefined) return;

      try {
        const file =
          persistedTab.space === "agent"
            ? (await api.getAgentSpaceFile(sessionId, persistedTab.path)).file
            : await getUserSpaceFile(persistedTab.mountId, persistedTab.path);
        const nextPreview = await buildPreview(file, persistedTab.path);
        if (
          restoreSeq !== previewRestoreSeqRef.current ||
          tabSeq !== previewSeqByTabRef.current.get(persistedTab.id)
        ) {
          revokePreviewStateUrl(nextPreview);
          return;
        }
        setPreviewTabs((current) => {
          const next = current.map((tab) => {
            if (tab.id !== persistedTab.id) return tab;
            disposePreviewTabResources(tab);
            return { ...tab, title: nextPreview.name, state: nextPreview };
          });
          previewTabsRef.current = next;
          return next;
        });
      } catch (err) {
        if (
          restoreSeq !== previewRestoreSeqRef.current ||
          tabSeq !== previewSeqByTabRef.current.get(persistedTab.id)
        )
          return;
        setPreviewTabs((current) => {
          const next = current.map((tab) => {
            if (tab.id !== persistedTab.id) return tab;
            disposePreviewTabResources(tab);
            return {
              ...tab,
              state: previewLoadErrorState(persistedTab.path, err),
            };
          });
          previewTabsRef.current = next;
          return next;
        });
      }
    },
    [sessionId],
  );

  const createRestoredPreviewTabShells = useCallback((tabs: PersistedPreviewTab[]) => {
    return tabs.map<PreviewTab>((tab) => {
      const previewSupported =
        tab.space === "agent"
          ? isPreviewableAgentFile(tab.path, tab.previewKind)
          : isPreviewableFile(tab.path, tab.previewKind);
      const seq = ++previewRequestSeqRef.current;
      previewSeqByTabRef.current.set(tab.id, seq);
      return {
        id: tab.id,
        mountId: tab.mountId,
        path: tab.path,
        title: previewTitleForPath(tab.path),
        viewMode: tab.viewMode,
        ...(tab.pinned ? { pinned: true } : {}),
        state: previewSupported
          ? { status: "loading", path: tab.path }
          : unsupportedPreviewState(tab.path, tab.size),
      };
    });
  }, []);

  useLayoutEffect(() => {
    const previewSequences = previewSeqByTabRef.current;
    previewRestoreSeqRef.current += 1;
    previewPersistenceReadyOwnerRef.current = "";
    pendingPreviewRestorationRef.current = null;
    setPreviewTabs([]);
    previewTabsRef.current = [];
    setActivePreviewTabId("");
    setPreviewStateOwnerKey(previewOwnerKey);
    previewSequences.clear();

    const persisted = readPreviewSessionState(previewOwnerKey);
    if (persisted) {
      pendingPreviewRestorationRef.current = { ownerKey: previewOwnerKey, state: persisted };
      const restoredTabs = createRestoredPreviewTabShells(persisted.tabs);
      previewTabsRef.current = restoredTabs;
      setPreviewTabs(restoredTabs);
      const activeTab =
        restoredTabs.find((tab) => tab.id === persisted.activeTabId) || restoredTabs[0];
      if (activeTab) {
        setPreviewOpen(true);
        setActivePreviewTabId(activeTab.id);
      }
    } else {
      previewPersistenceReadyOwnerRef.current = previewOwnerKey;
    }

    return () => {
      previewRestoreSeqRef.current += 1;
      previewPersistenceReadyOwnerRef.current = "";
      pendingPreviewRestorationRef.current = null;
      previewSequences.clear();
      for (const tab of previewTabsRef.current) disposePreviewTabResources(tab);
      previewTabsRef.current = [];
    };
  }, [createRestoredPreviewTabShells, previewOwnerKey, setPreviewOpen]);

  useEffect(() => {
    const pending = pendingPreviewRestorationRef.current;
    if (!pending || pending.ownerKey !== previewOwnerKey) return;
    const userTabAwaitingHandle = pending.state.tabs.find(
      (tab) =>
        tab.space === "user" &&
        visibleMountById.has(tab.mountId) &&
        !localMountById.has(tab.mountId),
    );
    if (userTabAwaitingHandle) return;

    pendingPreviewRestorationRef.current = null;
    const restoreSeq = previewRestoreSeqRef.current;
    const restorableTabs = pending.state.tabs.filter(
      (tab) => tab.space === "agent" || localMountById.has(tab.mountId),
    );
    const restoredTabs = createRestoredPreviewTabShells(restorableTabs);
    previewTabsRef.current = restoredTabs;
    setPreviewTabs(restoredTabs);
    const activeTab =
      restoredTabs.find((tab) => tab.id === pending.state.activeTabId) || restoredTabs[0];
    if (activeTab) {
      setPreviewOpen(true);
      setActivePreviewTabId(activeTab.id);
      syncPreviewTabFocus(activeTab);
    }

    previewPersistenceReadyOwnerRef.current = previewOwnerKey;
    writePreviewSessionState(previewOwnerKey, restoredTabs, activeTab?.id || "");

    void Promise.all(restorableTabs.map((tab) => hydrateRestoredPreviewTab(tab, restoreSeq)));
  }, [
    createRestoredPreviewTabShells,
    hydrateRestoredPreviewTab,
    localMountById,
    previewOwnerKey,
    setPreviewOpen,
    syncPreviewTabFocus,
    visibleMountById,
  ]);

  useEffect(() => {
    if (
      previewStateOwnerKey !== previewOwnerKey ||
      previewPersistenceReadyOwnerRef.current !== previewOwnerKey
    )
      return;
    writePreviewSessionState(previewOwnerKey, previewTabs, activePreviewTabId);
  }, [activePreviewTabId, previewOwnerKey, previewStateOwnerKey, previewTabs]);

  const closePreviewTabNow = useCallback(
    (tabId: string, options: { resetLayoutIfEmpty?: boolean } = {}) => {
      const current = previewTabsRef.current;
      const closingIndex = current.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) return;
      const closingTab = current[closingIndex];
      disposePreviewTabResources(closingTab);
      const next = current.filter((tab) => tab.id !== tabId);
      setPreviewTabs(next);
      previewTabsRef.current = next;
      if (next.length === 0 && options.resetLayoutIfEmpty) {
        setPreviewOpen(false, false, true);
      }
      if (activePreviewTabId === tabId) {
        const fallback = next[Math.max(0, closingIndex - 1)] || next[0];
        setActivePreviewTabId(fallback?.id || "");
        syncPreviewTabFocus(fallback);
      } else if (selectedEntryKey === treeDirKey(closingTab.mountId, closingTab.path)) {
        syncPreviewTabFocus(next.find((tab) => tab.id === activePreviewTabId) || null);
      }
      previewSeqByTabRef.current.delete(tabId);
    },
    [activePreviewTabId, selectedEntryKey, setPreviewOpen, syncPreviewTabFocus],
  );

  const handleOfficeFileMigration = useCallback(
    (migration: OfficeFileMigration) => {
      const { mountId, oldPath, newPath } = migration;
      const oldTabId =
        previewTabsRef.current.find(
          (tab) =>
            tab.mountId === mountId &&
            tab.path === oldPath &&
            tab.state.status === "ready" &&
            tab.state.kind === "office",
        )?.id || previewTabId(mountId, oldPath);
      const parentDirs = parentDirectoryPaths(newPath);
      setExpandedMountIds((current) => {
        if (current.has(mountId)) return current;
        const next = new Set(current);
        next.add(mountId);
        return next;
      });
      if (parentDirs.length > 0) {
        setOpenDirs((current) => {
          let changed = false;
          const next = new Set(current);
          for (const parentDir of parentDirs) {
            const key = treeDirKey(mountId, parentDir);
            if (next.has(key)) continue;
            next.add(key);
            changed = true;
          }
          return changed ? next : current;
        });
      }

      void (async () => {
        const refreshDirs = Array.from(
          new Set([dirnameWorkspacePath(oldPath), dirnameWorkspacePath(newPath)]),
        );
        for (const dirPath of refreshDirs) {
          await loadDirectory(mountId, dirPath);
        }
        closePreviewTabNow(oldTabId);
        await openFilePreview(mountId, newPath, "office");
      })().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [closePreviewTabNow, loadDirectory, openFilePreview],
  );

  const handleOfficeFileCreated = useCallback(
    (created: OfficeFileCreated) => {
      const { mountId, path, previewKind } = created;
      const parentDirs = parentDirectoryPaths(path);
      setExpandedMountIds((current) => {
        if (current.has(mountId)) return current;
        const next = new Set(current);
        next.add(mountId);
        return next;
      });
      if (parentDirs.length > 0) {
        setOpenDirs((current) => {
          let changed = false;
          const next = new Set(current);
          for (const parentDir of parentDirs) {
            const key = treeDirKey(mountId, parentDir);
            if (next.has(key)) continue;
            next.add(key);
            changed = true;
          }
          return changed ? next : current;
        });
      }

      void (async () => {
        await loadDirectory(mountId, dirnameWorkspacePath(path));
        await openFilePreview(mountId, path, previewKind);
      })().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [loadDirectory, openFilePreview],
  );

  const handleOfficeFileSaved = useCallback((saved: OfficeFileSaved) => {
    const current = previewTabsRef.current;
    let changed = false;
    const next = current.map((tab) => {
      if (
        tab.mountId !== saved.mountId ||
        tab.path !== saved.path ||
        tab.state.status !== "ready" ||
        tab.state.kind !== "office"
      ) {
        return tab;
      }
      changed = true;
      return {
        ...tab,
        hasUnsavedChanges: false,
        state: {
          ...tab.state,
          officeFile: saved.file,
          size: saved.file.size,
        },
      };
    });
    if (!changed) return;
    previewTabsRef.current = next;
    setPreviewTabs(next);
  }, []);

  const closePreviewTab = useCallback(
    (tabId: string) => {
      const tab = previewTabsRef.current.find((item) => item.id === tabId);
      if (tab?.pinned) return;
      if (tab?.hasUnsavedChanges) {
        setPendingPreviewClose({ kind: "tab", tabId });
        return;
      }
      closePreviewTabNow(tabId, { resetLayoutIfEmpty: true });
    },
    [closePreviewTabNow],
  );

  const closePreviewTabs = useCallback(
    (tabIds: string[]) => {
      const requestedIds = new Set(tabIds);
      const tabsToClose = previewTabsRef.current.filter(
        (tab) => requestedIds.has(tab.id) && !tab.pinned,
      );
      if (tabsToClose.length === 0) return;
      const dirtyTabIds = tabsToClose.filter((tab) => tab.hasUnsavedChanges).map((tab) => tab.id);
      const cleanTabIds = tabsToClose.filter((tab) => !tab.hasUnsavedChanges).map((tab) => tab.id);
      if (dirtyTabIds.length > 0) {
        setPendingPreviewClose({
          kind: "tabs",
          tabIds: tabsToClose.map((tab) => tab.id),
          unsavedCount: dirtyTabIds.length,
        });
        return;
      }
      closePreviewTabsByIds(cleanTabIds, { resetLayoutIfEmpty: true });
    },
    [closePreviewTabsByIds],
  );

  const closeAllPreviewTabs = useCallback(
    (options?: { force?: boolean }) => {
      const tabsToClose = previewTabsRef.current.filter((tab) => !tab.pinned);
      if (tabsToClose.length === 0) return;
      const dirtyTabs = tabsToClose.filter((tab) => tab.hasUnsavedChanges);
      if (!options?.force && dirtyTabs.length > 0) {
        setPendingPreviewClose({
          kind: "tabs",
          tabIds: tabsToClose.map((tab) => tab.id),
          unsavedCount: dirtyTabs.length,
        });
        return;
      }
      closePreviewTabsByIds(
        tabsToClose.map((tab) => tab.id),
        { resetLayoutIfEmpty: true },
      );
    },
    [closePreviewTabsByIds],
  );

  const setPreviewTabPinned = useCallback((tabId: string, pinned: boolean) => {
    setPreviewTabs((current) => {
      const target = current.find((tab) => tab.id === tabId);
      if (!target || Boolean(target.pinned) === pinned) return current;
      const updated = current.map((tab) => (tab.id === tabId ? { ...tab, pinned } : tab));
      const next = [
        ...updated.filter((tab) => tab.pinned),
        ...updated.filter((tab) => !tab.pinned),
      ];
      previewTabsRef.current = next;
      return next;
    });
  }, []);

  const unpinAllPreviewTabs = useCallback(() => {
    setPreviewTabs((current) => {
      if (!current.some((tab) => tab.pinned)) return current;
      const next = current.map((tab) => (tab.pinned ? { ...tab, pinned: false } : tab));
      previewTabsRef.current = next;
      return next;
    });
  }, []);

  const closeAllPinnedPreviewTabs = useCallback(() => {
    const tabsToClose = previewTabsRef.current.filter((tab) => tab.pinned);
    if (tabsToClose.length === 0) return;
    const dirtyTabs = tabsToClose.filter((tab) => tab.hasUnsavedChanges);
    if (dirtyTabs.length > 0) {
      setPendingPreviewClose({
        kind: "tabs",
        tabIds: tabsToClose.map((tab) => tab.id),
        unsavedCount: dirtyTabs.length,
      });
      return;
    }
    closePreviewTabsByIds(
      tabsToClose.map((tab) => tab.id),
      { resetLayoutIfEmpty: true },
    );
  }, [closePreviewTabsByIds]);

  const addPreviewTabToConversation = useCallback(
    (tabId: string) => {
      const tab = previewTabsRef.current.find((item) => item.id === tabId);
      if (!tab?.mountId || isAgentPreviewTabId(tab.id) || isWtermPreviewTabId(tab.id)) return;
      const mount = visibleMounts.find((item) => item.mountId === tab.mountId);
      if (!mount) return;
      addUserSpaceFileRef(sessionId, {
        rootName: mount.rootName,
        path: tab.path,
        name: tab.title,
      });
    },
    [sessionId, visibleMounts],
  );

  const movePreviewTab = useCallback(
    (fromTabId: string, toTabId: string, edge?: PreviewTabInsertionEdge) => {
      if (!fromTabId || !toTabId || fromTabId === toTabId) return;
      setPreviewTabs((current) => {
        const fromIndex = current.findIndex((tab) => tab.id === fromTabId);
        const toIndex = current.findIndex((tab) => tab.id === toTabId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
        if (current[fromIndex]?.pinned || current[toIndex]?.pinned) return current;
        const next = [...current];
        const [moved] = next.splice(fromIndex, 1);
        const targetIndex = next.findIndex((tab) => tab.id === toTabId);
        const insertionIndex =
          targetIndex < 0
            ? next.length
            : edge
              ? targetIndex + (edge === "after" ? 1 : 0)
              : targetIndex + (fromIndex < toIndex ? 1 : 0);
        next.splice(insertionIndex, 0, moved);
        if (
          next.length === current.length &&
          next.every((tab, index) => tab.id === current[index]?.id)
        )
          return current;
        previewTabsRef.current = next;
        return next;
      });
    },
    [],
  );

  const updatePreviewTabUnsavedState = useCallback((tabId: string, hasUnsavedChanges: boolean) => {
    setPreviewTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== tabId || Boolean(tab.hasUnsavedChanges) === hasUnsavedChanges) return tab;
        changed = true;
        return { ...tab, hasUnsavedChanges };
      });
      if (changed) previewTabsRef.current = next;
      return changed ? next : current;
    });
  }, []);

  const updatePreviewTabEditingState = useCallback((tabId: string, isEditing: boolean) => {
    setPreviewTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== tabId || Boolean(tab.isEditing) === isEditing) return tab;
        changed = true;
        return { ...tab, isEditing };
      });
      if (changed) previewTabsRef.current = next;
      return changed ? next : current;
    });
  }, []);

  const confirmPendingPreviewClose = useCallback(() => {
    const pending = pendingPreviewClose;
    if (!pending) return;
    setPendingPreviewClose(null);
    if (pending.kind === "all") {
      closeAllPreviewTabs({ force: true });
      return;
    }
    if (pending.kind === "tabs") {
      closePreviewTabsByIds(pending.tabIds, { resetLayoutIfEmpty: true });
      return;
    }
    closePreviewTabNow(pending.tabId, { resetLayoutIfEmpty: true });
  }, [closeAllPreviewTabs, closePreviewTabNow, closePreviewTabsByIds, pendingPreviewClose]);

  const updatePreviewTabViewMode = useCallback((tabId: string, viewMode: PreviewViewMode) => {
    setPreviewTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, viewMode } : tab)),
    );
  }, []);

  const savePreviewTextContent = useCallback(
    async (tabId: string, content: string) => {
      await waitForWorkspaceMutation();
      const tab = previewTabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.state.status !== "ready")
        throw new Error(workspaceCopy.textSaveErrors.tabMissing);
      if (!["html", "markdown", "text"].includes(tab.state.kind))
        throw new Error(workspaceCopy.textSaveErrors.unsupportedType);
      if (tab.state.truncated) throw new Error(workspaceCopy.textSaveErrors.fileTooLarge);
      await executeUserSpaceOperation("write_file", {
        mountId: tab.mountId,
        path: tab.path,
        content,
        createParents: false,
      });
      setPreviewTabs((current) => {
        const next = current.map((item) => {
          if (item.id !== tabId || item.state.status !== "ready") return item;
          if (!["html", "markdown", "text"].includes(item.state.kind)) return item;
          const nextObjectUrl =
            item.state.kind === "html"
              ? createHtmlObjectUrl(content)
              : createPlainTextObjectUrl(content);
          revokePreviewStateUrl(item.state);
          return {
            ...item,
            hasUnsavedChanges: false,
            state: {
              ...item.state,
              objectUrl: nextObjectUrl,
              sourceObjectUrl: undefined,
              textContent: content,
              size: new TextEncoder().encode(content).byteLength,
              truncated: false,
            },
          };
        });
        previewTabsRef.current = next;
        return next;
      });
    },
    [waitForWorkspaceMutation],
  );

  const savePreviewImageFile = useCallback(
    async (tabId: string, file: File) => {
      await waitForWorkspaceMutation();
      const tab = previewTabsRef.current.find((item) => item.id === tabId);
      if (!tab || tab.state.status !== "ready" || tab.state.kind !== "image") {
        throw new Error(workspaceCopy.imagePreview.saveFailed);
      }
      await saveUserSpaceFile(tab.mountId, tab.path, file);
      setPreviewTabs((current) => {
        const next = current.map((item) => {
          if (item.id !== tabId || item.state.status !== "ready" || item.state.kind !== "image")
            return item;
          const nextObjectUrl = createImageObjectUrl(file, item.path);
          revokePreviewStateUrl(item.state);
          return {
            ...item,
            hasUnsavedChanges: false,
            state: { ...item.state, objectUrl: nextObjectUrl, size: file.size },
          };
        });
        previewTabsRef.current = next;
        return next;
      });
    },
    [waitForWorkspaceMutation],
  );

  const openWtermPreview = useCallback(() => {
    if (!activeMountIdForOps) return;
    const tabId = wtermPreviewTabId(activeMountIdForOps);
    const wtermTab: PreviewTab = {
      id: tabId,
      mountId: activeMountIdForOps,
      path: WTERM_PREVIEW_PATH,
      title: workspaceCopy.wterm.title,
      viewMode: "preview",
      state: {
        status: "ready",
        path: WTERM_PREVIEW_PATH,
        name: workspaceCopy.wterm.title,
        kind: "wterm",
        size: 0,
        objectUrl: "",
      },
    };
    setPreviewOpen(true, true);
    setActivePreviewTabId(tabId);
    setPreviewTabs((current) => {
      if (current.some((tab) => tab.id === tabId)) return current;
      const { tabs, closedTabs } = upsertPreviewTab(current, wtermTab);
      for (const closedTab of closedTabs) {
        disposePreviewTabResources(closedTab);
        previewSeqByTabRef.current.delete(closedTab.id);
      }
      previewTabsRef.current = tabs;
      return tabs;
    });
  }, [activeMountIdForOps, setPreviewOpen]);

  const togglePreviewFold = useCallback(() => {
    setPreviewOpen(!previewOpen);
  }, [previewOpen, setPreviewOpen]);

  const selectFile = useCallback(
    async (mountId: string, entry: WorkspaceEntry) => {
      if (!mountId || entry.kind !== "file") return;
      await openFilePreview(
        mountId,
        entry.path,
        entry.previewKind,
        undefined,
        undefined,
        entry.size,
      );
    },
    [openFilePreview],
  );

  const selectWorkspaceEntryRange = useCallback(
    (targetKey: string) => {
      const rangeKeys = workspaceSelectionRangeKeys(
        visibleWorkspaceEntryKeys,
        selectionAnchorEntryKey,
        targetKey,
      );
      setSelectedEntryKey(targetKey);
      setSelectedEntryKeys(new Set(rangeKeys));
      if (
        !selectionAnchorEntryKey ||
        !visibleWorkspaceEntryKeys.includes(selectionAnchorEntryKey)
      ) {
        setSelectionAnchorEntryKey(targetKey);
      }
    },
    [selectionAnchorEntryKey, visibleWorkspaceEntryKeys],
  );

  const handleWorkspaceEntryClick = useCallback(
    (mountId: string, entry: WorkspaceEntry, event: WorkspaceEntryClickEvent) => {
      const key = treeDirKey(mountId, entry.path);
      clearAgentEntrySelection();
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setActiveMountId(mountId);
        selectWorkspaceEntryRange(key);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        setActiveMountId(mountId);
        setSelectedEntryKey(key);
        setSelectedEntryKeys((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setSelectionAnchorEntryKey(key);
        return;
      }
      if (entry.kind === "directory") {
        toggleDirectory(mountId, entry);
        return;
      }
      void selectFile(mountId, entry);
    },
    [clearAgentEntrySelection, selectFile, selectWorkspaceEntryRange, toggleDirectory],
  );

  const selectAgentEntryRange = useCallback(
    (targetPath: string) => {
      const rangePaths = workspaceSelectionRangeKeys(
        visibleAgentEntryPaths,
        agentSelectionAnchorPath,
        targetPath,
      );
      setSelectedAgentEntryPath(targetPath);
      setSelectedAgentEntryPaths(new Set(rangePaths));
      if (!agentSelectionAnchorPath || !visibleAgentEntryPaths.includes(agentSelectionAnchorPath)) {
        setAgentSelectionAnchorPath(targetPath);
      }
    },
    [agentSelectionAnchorPath, visibleAgentEntryPaths],
  );

  const handleAgentEntryClick = useCallback(
    (node: TreeNode, event: WorkspaceEntryClickEvent) => {
      const path = agentNodePath(node);
      clearWorkspaceEntrySelection();
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        selectAgentEntryRange(path);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        setSelectedAgentEntryPath(path);
        setSelectedAgentEntryPaths((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        setAgentSelectionAnchorPath(path);
        return;
      }
      selectSingleAgentEntryPath(path);
      if (node.type === "directory") {
        toggleAgentDirectory(path);
        return;
      }
      void openAgentFilePreview(path, previewKindForWorkspacePath(path), undefined, node.size);
    },
    [
      clearWorkspaceEntrySelection,
      openAgentFilePreview,
      selectAgentEntryRange,
      selectSingleAgentEntryPath,
      toggleAgentDirectory,
    ],
  );

  const addFileReference = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const mount = visibleMounts.find((item) => item.mountId === mountId);
      if (!mount) return;
      const actionEntries = resolveWorkspaceActionEntries(mountId, entry, false);
      const fileEntries = actionEntries.filter((item) => item.entry.kind === "file");
      const referenceEntries =
        fileEntries.length > 0 ? fileEntries : entry.kind === "file" ? [{ mountId, entry }] : [];
      for (const item of referenceEntries) {
        addUserSpaceFileRef(sessionId, {
          rootName: mount.rootName,
          path: item.entry.path,
          name: item.entry.name,
        });
      }
    },
    [resolveWorkspaceActionEntries, sessionId, visibleMounts],
  );

  const refreshWorkspaceDirectories = useCallback(
    async (mountId: string, dirPaths: string[]) => {
      const uniquePaths = Array.from(new Set(dirPaths.map((path) => normalizeWorkspacePath(path))));
      for (const dirPath of uniquePaths) await loadDirectory(mountId, dirPath);
    },
    [loadDirectory],
  );

  const refreshFailedUserWorkspaceMutation = useCallback(
    async (mountId: string, sourcePaths: string[], targetDirPath: string) => {
      const dirPaths = [targetDirPath, ...sourcePaths.map(dirnameWorkspacePath)];
      await refreshWorkspaceDirectories(mountId, dirPaths).catch(() => undefined);
    },
    [refreshWorkspaceDirectories],
  );

  const performUserWorkspaceDrop = useCallback(
    async (
      source: Extract<WorkspaceDragSource, { space: "user" }>,
      target: WorkspaceDropTarget,
      guard: WorkspaceMoveGuard,
    ) => {
      const moves: WorkspaceMove[] = [];
      if (target.operation === "copy") {
        const result = (await executeUserSpaceOperation("copy_entries", {
          mountId: source.mountId,
          paths: source.entries.map((item) => item.entry.path),
          targetDirPath: target.dirPath,
        })) as WorkspaceMoveResult;
        if (!isWorkspaceMoveCurrent(guard)) return;
        moves.push(...(result.moves || []));
      } else {
        const result = (await executeUserSpaceOperation("move_entries", {
          mountId: source.mountId,
          paths: source.entries.map((item) => item.entry.path),
          targetDirPath: target.dirPath,
        })) as WorkspaceMoveResult;
        if (!isWorkspaceMoveCurrent(guard)) return;
        moves.push(...(result.moves || []));
      }
      if (moves.length === 0) return;
      const viewCurrent = isWorkspaceMoveViewCurrent(guard);

      const expandedMovedPaths =
        target.operation === "move"
          ? Array.from(openDirs)
              .flatMap((key) => {
                const separatorIndex = key.indexOf("\u0000");
                if (separatorIndex < 0 || key.slice(0, separatorIndex) !== source.mountId)
                  return [];
                const nextPath = pathAfterWorkspaceMove(key.slice(separatorIndex + 1), moves);
                return nextPath ? [nextPath] : [];
              })
              .sort((left, right) => workspacePathDepth(left) - workspacePathDepth(right))
          : [];
      if (target.operation === "move") {
        remapPreviewTabsAfterWorkspaceMove("user", source.mountId, moves, []);
        updateUserTreePathsAfterMove(source.mountId, moves, target.dirPath);
        setWorkspaceClipboard((current) => {
          if (!current || current.mountId !== source.mountId) return current;
          let changed = false;
          const entries = current.entries.map((entry) => {
            const nextPath = pathAfterWorkspaceMove(entry.path, moves);
            if (!nextPath) return entry;
            changed = true;
            return { ...entry, path: nextPath, name: nextPath.split("/").pop() || entry.name };
          });
          return changed ? { ...current, entries } : current;
        });
      } else if (target.dirPath && viewCurrent) {
        setOpenDirs((current) => new Set(current).add(treeDirKey(source.mountId, target.dirPath)));
      }
      if (viewCurrent) {
        const nextKeys = moves.map((move) => treeDirKey(source.mountId, move.path));
        const primaryPath = pathAfterWorkspaceMove(source.primaryPath, moves);
        const primaryKey = primaryPath ? treeDirKey(source.mountId, primaryPath) : "";
        const focusedKey = nextKeys.includes(primaryKey) ? primaryKey : nextKeys[0] || "";
        setSelectedEntryKey(focusedKey);
        setSelectedEntryKeys(new Set(nextKeys));
        setSelectionAnchorEntryKey(focusedKey);
      }

      const refreshDirs = new Set<string>();
      if (target.operation === "move") {
        for (const move of moves) refreshDirs.add(dirnameWorkspacePath(move.sourcePath));
      }
      refreshDirs.delete(target.dirPath);
      await Promise.all([
        refreshWorkspaceDirectories(source.mountId, Array.from(refreshDirs)),
        loadDirectoryThroughPaths(
          source.mountId,
          target.dirPath,
          moves.map((move) => move.path),
        ),
      ]);
      if (!isWorkspaceMoveCurrent(guard)) return;
      for (const path of expandedMovedPaths) {
        await loadDirectory(source.mountId, path);
        if (!isWorkspaceMoveCurrent(guard)) return;
      }
      if (!isWorkspaceMoveViewCurrent(guard)) return;
      const primaryPath = pathAfterWorkspaceMove(source.primaryPath, moves);
      const focusedPath =
        primaryPath && moves.some((move) => move.path === primaryPath)
          ? primaryPath
          : moves[0].path;
      focusWorkspaceEntryAfterMutation(source.mountId, focusedPath);
      showWorkspaceAlert({
        status: "success",
        message:
          target.operation === "copy"
            ? workspaceCopy.dragAndDrop.copySuccess(moves.length, target.label)
            : workspaceCopy.dragAndDrop.moveSuccess(moves.length, target.label),
      });
    },
    [
      loadDirectory,
      loadDirectoryThroughPaths,
      focusWorkspaceEntryAfterMutation,
      isWorkspaceMoveCurrent,
      isWorkspaceMoveViewCurrent,
      openDirs,
      refreshWorkspaceDirectories,
      remapPreviewTabsAfterWorkspaceMove,
      showWorkspaceAlert,
      updateUserTreePathsAfterMove,
    ],
  );

  const performAgentWorkspaceDrop = useCallback(
    async (
      source: Extract<WorkspaceDragSource, { space: "agent" }>,
      target: WorkspaceDropTarget,
      guard: WorkspaceMoveGuard,
    ) => {
      const result = await api.moveAgentSpaceEntries(
        sessionId,
        source.entries.map(agentNodePath),
        target.dirPath,
      );
      if (!isWorkspaceMoveCurrent(guard)) return;
      const moves = result.moves || [];
      if (moves.length === 0) return;
      const viewCurrent = isWorkspaceMoveViewCurrent(guard);
      remapPreviewTabsAfterWorkspaceMove("agent", "", [], moves);
      setAgentOpenDirs((current) => {
        const next = new Set<string>();
        for (const path of current) next.add(pathAfterAgentMove(path, moves) || path);
        if (target.dirPath) next.add(target.dirPath);
        return next;
      });
      if (viewCurrent) {
        const nextPaths = moves.map((move) => move.newPath);
        const primaryPath = pathAfterAgentMove(source.primaryPath, moves);
        const focusedPath =
          primaryPath && nextPaths.includes(primaryPath) ? primaryPath : nextPaths[0] || "";
        setSelectedAgentEntryPath(focusedPath);
        setSelectedAgentEntryPaths(new Set(nextPaths));
        setAgentSelectionAnchorPath(focusedPath);
      }
      setAgentWorkspaceClipboard((current) =>
        current ? current.map((entry) => agentNodeAfterMove(entry, moves)) : current,
      );
      await loadAgentTree();
      if (!isWorkspaceMoveCurrent(guard)) return;
      if (!isWorkspaceMoveViewCurrent(guard)) return;
      const primaryPath = pathAfterAgentMove(source.primaryPath, moves);
      const focusedPath =
        primaryPath && moves.some((move) => move.newPath === primaryPath)
          ? primaryPath
          : moves[0].newPath;
      focusWorkspaceTreeRow(`agent-space-entry-${focusedPath}`);
      showWorkspaceAlert({
        status: "success",
        message: workspaceCopy.dragAndDrop.moveSuccess(moves.length, target.label),
      });
    },
    [
      isWorkspaceMoveCurrent,
      isWorkspaceMoveViewCurrent,
      loadAgentTree,
      remapPreviewTabsAfterWorkspaceMove,
      sessionId,
      showWorkspaceAlert,
    ],
  );

  const pasteAgentWorkspaceClipboard = useCallback(
    async (targetDirPath: string) => {
      const entries = agentWorkspaceClipboard;
      if (!entries?.length || workspaceMovePending) return;
      const validation = validateAgentEntryDrop(entries, targetDirPath);
      if (!validation.valid) return;
      const guard = {
        ownerKey: workspaceMoveOwnerRef.current,
        epoch: ++workspaceMoveEpochRef.current,
        viewKey: workspaceMoveViewRef.current,
      };
      const releaseWorkspaceMutation = beginWorkspaceMutationBarrier();
      setWorkspaceMovePending(true);
      setError("");
      try {
        await performAgentWorkspaceDrop(
          { space: "agent", entries, primaryPath: agentNodePath(entries[0]) },
          {
            space: "agent",
            mountId: "",
            dirPath: targetDirPath,
            label: targetDirPath.split("/").pop() || "workspace",
            surfaceKey: `clipboard:agent:${targetDirPath}`,
            operation: "move",
            validation,
          },
          guard,
        );
        if (isWorkspaceMoveCurrent(guard)) setAgentWorkspaceClipboard(null);
      } catch (err) {
        if (isWorkspaceMoveCurrent(guard)) await loadAgentTree();
        if (isWorkspaceMoveViewCurrent(guard)) {
          setError(agentSpaceMoveErrorMessage(err));
        }
      } finally {
        if (isWorkspaceMoveCurrent(guard)) setWorkspaceMovePending(false);
        releaseWorkspaceMutation();
      }
    },
    [
      agentWorkspaceClipboard,
      beginWorkspaceMutationBarrier,
      isWorkspaceMoveCurrent,
      isWorkspaceMoveViewCurrent,
      loadAgentTree,
      performAgentWorkspaceDrop,
      workspaceMovePending,
    ],
  );

  const dropWorkspaceEntries = useCallback(
    async (event: WorkspaceDragEvent) => {
      const current = workspaceDragRef.current;
      if (!current?.target || workspaceMovePending) return;
      const source = current.source;
      const operation =
        source.space === "user" ? workspaceDragOperationFromModifiers(event) : "move";
      const validation =
        source.space !== current.target.space
          ? { valid: false as const, reason: "different-space" as const }
          : source.space === "user"
            ? validateWorkspaceEntryDrop(
                source.entries,
                current.target.mountId,
                current.target.dirPath,
                operation,
              )
            : validateAgentEntryDrop(source.entries, current.target.dirPath);
      if (!validation.valid) return;
      event.preventDefault();
      event.stopPropagation();
      const target: WorkspaceDropTarget = {
        ...current.target,
        operation,
        validation,
      };
      const guard = {
        ownerKey: workspaceMoveOwnerRef.current,
        epoch: ++workspaceMoveEpochRef.current,
        viewKey: workspaceMoveViewRef.current,
      };
      finishWorkspaceDrag();
      const releaseWorkspaceMutation = beginWorkspaceMutationBarrier();
      setWorkspaceMovePending(true);
      setError("");
      try {
        if (source.space === "user") await performUserWorkspaceDrop(source, target, guard);
        else await performAgentWorkspaceDrop(source, target, guard);
      } catch (err) {
        if (isWorkspaceMoveCurrent(guard)) {
          if (source.space === "user") {
            await refreshFailedUserWorkspaceMutation(
              source.mountId,
              source.entries.map((item) => item.entry.path),
              target.dirPath,
            );
          } else {
            await loadAgentTree();
          }
        }
        if (isWorkspaceMoveViewCurrent(guard)) {
          setError(
            source.space === "agent"
              ? agentSpaceMoveErrorMessage(err)
              : err instanceof Error
                ? err.message
                : String(err),
          );
        }
      } finally {
        if (isWorkspaceMoveCurrent(guard)) setWorkspaceMovePending(false);
        releaseWorkspaceMutation();
      }
    },
    [
      beginWorkspaceMutationBarrier,
      finishWorkspaceDrag,
      isWorkspaceMoveCurrent,
      isWorkspaceMoveViewCurrent,
      loadAgentTree,
      performAgentWorkspaceDrop,
      performUserWorkspaceDrop,
      refreshFailedUserWorkspaceMutation,
      workspaceMovePending,
    ],
  );

  const expandWorkspaceDropDirectory = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const key = treeDirKey(mountId, entry.path);
      if (openDirs.has(key)) return;
      setOpenDirs((current) => new Set(current).add(key));
      if (!entriesByDir.has(key)) void loadDirectory(mountId, entry.path);
    },
    [entriesByDir, loadDirectory, openDirs],
  );

  const expandAgentDropDirectory = useCallback((path: string) => {
    setAgentOpenDirs((current) => new Set(current).add(path));
  }, []);

  const handleWorkspaceEntryDragOver = useCallback(
    (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => {
      const dirPath = entry.kind === "directory" ? entry.path : dirnameWorkspacePath(entry.path);
      const label = dirPath.split("/").pop() || "";
      const entryKey = treeDirKey(mountId, entry.path);
      const surfaceKey = dirPath ? `user:${treeDirKey(mountId, dirPath)}` : `user-root:${mountId}`;
      updateWorkspaceDropTarget(
        event,
        {
          space: "user",
          mountId,
          dirPath,
          label,
          surfaceKey,
        },
        entry.kind === "directory" && !openDirs.has(entryKey)
          ? () => expandWorkspaceDropDirectory(mountId, entry)
          : undefined,
      );
    },
    [expandWorkspaceDropDirectory, openDirs, updateWorkspaceDropTarget],
  );

  const handleWorkspaceRootDragOver = useCallback(
    (event: WorkspaceDragEvent, mountId = activeMountIdForOps) => {
      updateWorkspaceDropTarget(event, {
        space: "user",
        mountId,
        dirPath: ROOT_PATH,
        label: "",
        surfaceKey: `user-root:${mountId}`,
      });
    },
    [activeMountIdForOps, updateWorkspaceDropTarget],
  );

  const handleAgentEntryDragOver = useCallback(
    (node: TreeNode, event: WorkspaceDragEvent) => {
      const path = agentNodePath(node);
      const dirPath = node.type === "directory" ? path : dirnameWorkspacePath(path);
      const label = dirPath.split("/").pop() || "workspace";
      updateWorkspaceDropTarget(
        event,
        {
          space: "agent",
          mountId: "",
          dirPath,
          label,
          surfaceKey: dirPath ? `agent:${dirPath}` : "agent-root",
        },
        node.type === "directory" && !agentOpenDirs.has(path)
          ? () => expandAgentDropDirectory(path)
          : undefined,
      );
    },
    [agentOpenDirs, expandAgentDropDirectory, updateWorkspaceDropTarget],
  );

  const handleAgentRootDragOver = useCallback(
    (event: WorkspaceDragEvent) => {
      updateWorkspaceDropTarget(
        event,
        {
          space: "agent",
          mountId: "",
          dirPath: ROOT_PATH,
          label: "workspace",
          surfaceKey: "agent-root",
        },
        agentRootOpen ? undefined : () => setAgentRootOpen(true),
      );
    },
    [agentRootOpen, updateWorkspaceDropTarget],
  );

  const transferUserSpaceEntryToAgent = useCallback(
    async (mountId: string, entry: WorkspaceEntry) => {
      setError("");
      try {
        const results: AgentSpaceTransferResult[] = [];
        const actionEntries = resolveWorkspaceActionEntries(mountId, entry);
        for (const item of actionEntries) {
          const result = await api.transferUserToAgent(sessionId, item.entry.path);
          assertTransferResultOk(result);
          results.push(result);
        }
        const mergedResult: AgentSpaceTransferResult = {
          ok: true,
          files: results.flatMap((result) => result.files),
        };
        setAgentRootOpen(true);
        await loadAgentTree();
        showWorkspaceAlert({
          status: "success",
          message: transferAlertTitle(mergedResult, workspaceCopy),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [loadAgentTree, resolveWorkspaceActionEntries, sessionId, showWorkspaceAlert],
  );

  const refreshUserSpaceAfterAgentTransfer = useCallback(async () => {
    if (!activeMountIdForOps) return;
    const dirs = new Set<string>([ROOT_PATH, "shared"]);
    for (const key of entriesByDir.keys()) {
      const separatorIndex = key.indexOf("\u0000");
      if (separatorIndex < 0 || key.slice(0, separatorIndex) !== activeMountIdForOps) continue;
      dirs.add(key.slice(separatorIndex + 1));
    }
    await refreshWorkspaceDirectories(activeMountIdForOps, Array.from(dirs));
  }, [activeMountIdForOps, entriesByDir, refreshWorkspaceDirectories]);

  const transferAgentSpaceEntryToUser = useCallback(
    async (node: TreeNode) => {
      setError("");
      try {
        const results: AgentSpaceTransferResult[] = [];
        const actionNodes = resolveAgentActionNodes(node);
        for (const item of actionNodes) {
          const result = await api.transferAgentToUser(sessionId, agentNodePath(item));
          assertTransferResultOk(result);
          results.push(result);
        }
        const mergedResult: AgentSpaceTransferResult = {
          ok: true,
          files: results.flatMap((result) => result.files),
        };
        await refreshUserSpaceAfterAgentTransfer();
        showWorkspaceAlert({
          status: "success",
          message: transferAlertTitle(mergedResult, workspaceCopy),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshUserSpaceAfterAgentTransfer, resolveAgentActionNodes, sessionId, showWorkspaceAlert],
  );

  useEffect(() => {
    const currentOperationIds = new Set(snapshot.recentOperations.map((operation) => operation.id));
    const recentFileChanges = snapshot.recentFileChanges ?? [];
    const currentFileChangeIds = new Set(recentFileChanges.map((change) => change.id));

    const loadedDirsByMount = new Map<string, Set<string>>();
    for (const key of entriesByDir.keys()) {
      const separatorIndex = key.indexOf("\u0000");
      if (separatorIndex < 0) continue;
      const mountId = key.slice(0, separatorIndex);
      const dirPath = key.slice(separatorIndex + 1);
      if (!loadedDirsByMount.has(mountId)) loadedDirsByMount.set(mountId, new Set());
      loadedDirsByMount.get(mountId)!.add(dirPath);
    }

    const refreshDirsByMount = new Map<string, Set<string>>();
    const queueRefreshDirs = (
      mountId: string,
      changedDirs: string[] | undefined,
      refreshAllLoadedDirs = false,
    ) => {
      const loadedDirs = loadedDirsByMount.get(mountId);
      if (!loadedDirs) return;
      const dirs = changedDirs?.length
        ? changedDirs.map((path) => normalizeWorkspacePath(path))
        : [];
      const dirsToRefresh =
        dirs.length > 0
          ? dirs.filter((dirPath) => loadedDirs.has(dirPath))
          : refreshAllLoadedDirs
            ? Array.from(loadedDirs)
            : [];
      for (const dirPath of dirsToRefresh) {
        if (!refreshDirsByMount.has(mountId)) refreshDirsByMount.set(mountId, new Set());
        refreshDirsByMount.get(mountId)!.add(dirPath);
      }
    };

    for (const change of recentFileChanges) {
      if (handledWorkspaceFileChangeIdsRef.current.has(change.id)) continue;
      queueRefreshDirs(change.mountId, change.changedDirs);
    }

    for (const operation of snapshot.recentOperations) {
      if (handledWorkspaceOperationIdsRef.current.has(operation.id)) continue;
      if (operation.status !== "ok" || !operation.mountId) continue;
      queueRefreshDirs(
        operation.mountId,
        operation.changedDirs,
        operation.operation === "shell_exec",
      );
    }

    handledWorkspaceOperationIdsRef.current = currentOperationIds;
    handledWorkspaceFileChangeIdsRef.current = currentFileChangeIds;
    for (const [mountId, dirPaths] of refreshDirsByMount) {
      void refreshWorkspaceDirectories(mountId, Array.from(dirPaths));
    }
  }, [
    entriesByDir,
    refreshWorkspaceDirectories,
    snapshot.recentFileChanges,
    snapshot.recentOperations,
  ]);

  const upsertCreatedWorkspaceFile = useCallback(
    (mountId: string, parentPath: string, entry: WorkspaceEntry) => {
      const dirKey = treeDirKey(mountId, parentPath);
      setEntriesByDir((current) => {
        const next = new Map(current);
        const entries = next.get(dirKey) || [];
        const existingIndex = entries.findIndex((item) => item.path === entry.path);
        const nextEntries =
          existingIndex >= 0
            ? entries.map((item, index) => (index === existingIndex ? entry : item))
            : [...entries, entry];
        next.set(dirKey, nextEntries);
        return next;
      });
    },
    [],
  );

  const createWorkspaceFileFromTemplate = useCallback(
    async (mountId: string, parentPath: string, kind: WorkspaceNewFileKind) => {
      const template = workspaceNewFileTemplateForKind(kind);
      const validation = validateWorkspaceEntryName(template.defaultName);
      if (validation) {
        setError(validation);
        return;
      }
      setError("");
      try {
        const result = (await executeUserSpaceOperation("create_entry", {
          mountId,
          parentPath,
          name: template.defaultName,
          kind: "file",
          content: template.content,
        })) as { path?: string; kind?: WorkspaceEntry["kind"] };
        const createdPath = result.path || joinWorkspacePath(parentPath, template.defaultName);
        const createdEntry: WorkspaceEntry = {
          name: template.defaultName,
          path: createdPath,
          kind: "file",
          size: new TextEncoder().encode(template.content).byteLength,
          previewKind: previewKindForWorkspacePath(createdPath),
        };
        if (parentPath) {
          setOpenDirs((current) => new Set(current).add(treeDirKey(mountId, parentPath)));
        }
        setExpandedMountIds((current) => new Set(current).add(mountId));
        upsertCreatedWorkspaceFile(mountId, parentPath, createdEntry);
        const entryKey = treeDirKey(mountId, createdPath);
        selectSingleWorkspaceEntryKey(entryKey);
        setPendingRenameEntryKey(entryKey);
        void refreshWorkspaceDirectories(mountId, [parentPath]).catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshWorkspaceDirectories, selectSingleWorkspaceEntryKey, upsertCreatedWorkspaceFile],
  );

  const startCreateWorkspaceEntry = useCallback(
    (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => {
      if (kind !== "directory") {
        void createWorkspaceFileFromTemplate(mountId, parentPath, kind);
        return;
      }
      setWorkspaceActionDialog({
        kind: "create-folder",
        mountId,
        parentPath,
        initialName: workspaceCopy.createDialog.folderTitle,
      });
    },
    [createWorkspaceFileFromTemplate],
  );

  const renameWorkspaceEntry = useCallback(
    async (mountId: string, entry: WorkspaceEntry, name: string): Promise<boolean> => {
      if (entry.kind !== "file") {
        setError(workspaceCopy.unsupportedActions.renameFolderPending);
        return false;
      }
      const trimmedName = name.trim();
      const validation = validateWorkspaceEntryName(trimmedName);
      if (validation) {
        setError(validation);
        return false;
      }
      if (trimmedName === entry.name) return true;
      setError("");
      try {
        const parentPath = dirnameWorkspacePath(entry.path);
        const result = (await executeUserSpaceOperation("rename_entry", {
          mountId,
          path: entry.path,
          name: trimmedName,
        })) as { newPath?: string };
        const nextPath = result.newPath || joinWorkspacePath(parentPath, trimmedName);
        await refreshWorkspaceDirectories(mountId, [parentPath]);
        const openTab = previewTabsRef.current.find(
          (tab) =>
            !isAgentPreviewTabId(tab.id) &&
            !isWtermPreviewTabId(tab.id) &&
            tab.mountId === mountId &&
            tab.path === entry.path,
        );
        if (openTab) {
          closePreviewTabNow(openTab.id);
          await openFilePreview(mountId, nextPath, entry.previewKind);
        } else {
          selectSingleWorkspaceEntryKey(treeDirKey(mountId, nextPath));
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [
      closePreviewTabNow,
      openFilePreview,
      refreshWorkspaceDirectories,
      selectSingleWorkspaceEntryKey,
    ],
  );

  const startDeleteWorkspaceEntry = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const deleteEntries = resolveWorkspaceActionEntries(mountId, entry);
      setWorkspaceActionDialog({
        kind: "delete",
        space: "user",
        mountId,
        entry: deleteEntries[0].entry,
        entries: deleteEntries,
      });
    },
    [resolveWorkspaceActionEntries],
  );

  const buildWorkspaceDetailsSummary = useCallback(
    async (mountId: string, entries: WorkspaceEntry[]) => {
      const accumulator = createWorkspaceDetailsAccumulator();
      const visitEntry = async (entry: WorkspaceEntry): Promise<void> => {
        if (entry.kind === "file") {
          addWorkspaceFileToDetailsAccumulator(accumulator, entry);
          return;
        }

        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const result = await withTimeout(
            executeUserSpaceOperation("list_dir", {
              mountId,
              path: entry.path,
              limit: DIRECTORY_PAGE_SIZE,
              cursor,
              includeHidden: showHiddenEntries,
            }) as Promise<{ entries?: WorkspaceEntry[]; nextCursor?: string }>,
            directoryLoadTimeoutMs,
            workspaceCopy.directoryLoadTimeout,
          );
          for (const child of (result.entries || []).filter(
            (item) => showHiddenEntries || !isHiddenWorkspaceEntry(item),
          )) {
            await visitEntry(child);
          }
          cursor = result.nextCursor;
          if (cursor && seenCursors.has(cursor)) break;
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
      };

      for (const detailEntry of entries) await visitEntry(detailEntry);
      return workspaceDetailsSummaryFromAccumulator(accumulator);
    },
    [directoryLoadTimeoutMs, showHiddenEntries],
  );

  const showWorkspaceEntryDetails = useCallback(
    async (mountId: string, entry: WorkspaceEntry) => {
      const mount = visibleMounts.find((item) => item.mountId === mountId);
      const rootName = mount?.rootName || workspaceCopy.defaultRootName;
      const detailEntries = resolveWorkspaceActionEntries(mountId, entry).map((item) => item.entry);
      if (detailEntries.length === 1 && detailEntries[0].kind === "file") {
        setWorkspaceDetailsDialog({
          kind: "file",
          entry: detailEntries[0],
          directoryPath: workspaceDetailsDirectoryPath(rootName, detailEntries[0].path),
        });
        return;
      }

      try {
        setWorkspaceDetailsDialog({
          kind: "summary",
          summary: await buildWorkspaceDetailsSummary(mountId, detailEntries),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [buildWorkspaceDetailsSummary, resolveWorkspaceActionEntries, visibleMounts],
  );

  const startDeleteAgentSpaceEntry = useCallback(
    (node: TreeNode) => {
      const deleteEntries = resolveAgentActionNodes(node).map((item) => ({
        mountId: "",
        entry: agentNodeToWorkspaceEntry(item),
      }));
      setWorkspaceActionDialog({
        kind: "delete",
        space: "agent",
        mountId: "",
        entry: deleteEntries[0].entry,
        entries: deleteEntries,
      });
    },
    [resolveAgentActionNodes],
  );

  const showAgentEntryDetails = useCallback(
    (node: TreeNode) => {
      const detailNodes = resolveAgentActionNodes(node);
      if (detailNodes.length === 1 && detailNodes[0].type === "file") {
        const detailEntry = agentNodeToWorkspaceEntry(detailNodes[0]);
        setWorkspaceDetailsDialog({
          kind: "file",
          entry: detailEntry,
          directoryPath: workspaceDetailsDirectoryPath(workspaceCopy.agentSpace, detailEntry.path),
        });
        return;
      }

      setWorkspaceDetailsDialog({
        kind: "summary",
        summary: summarizeAgentNodesForDetails(detailNodes),
      });
    },
    [resolveAgentActionNodes],
  );

  const placeWorkspaceEntriesOnClipboard = useCallback(
    (mountId: string, entry: WorkspaceEntry, operation: "copy" | "move") => {
      const copyEntries = resolveWorkspaceActionEntries(mountId, entry).map((item) => ({
        path: item.entry.path,
        name: item.entry.name,
        kind: item.entry.kind,
      }));
      setWorkspaceClipboard({ mountId, entries: copyEntries, operation });
      return copyEntries.length;
    },
    [resolveWorkspaceActionEntries],
  );

  const copyWorkspaceEntry = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      placeWorkspaceEntriesOnClipboard(mountId, entry, "copy");
    },
    [placeWorkspaceEntriesOnClipboard],
  );

  const cutWorkspaceEntry = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const count = placeWorkspaceEntriesOnClipboard(mountId, entry, "move");
      announceWorkspaceClipboard("user-cut", count);
    },
    [announceWorkspaceClipboard, placeWorkspaceEntriesOnClipboard],
  );

  const pasteWorkspaceClipboard = useCallback(
    async (mountId: string, targetDirPath: string) => {
      const clipboard = workspaceClipboard;
      if (!clipboard || workspaceMovePending) return;
      if (clipboard.mountId !== mountId) {
        setError(workspaceCopy.unsupportedActions.pasteSameMountOnly);
        return;
      }
      const selfPasteTarget = workspaceClipboardSelfPasteTarget(clipboard, targetDirPath);
      if (selfPasteTarget) {
        setError(workspaceCopy.unsupportedActions.pasteFolderInsideSelf(selfPasteTarget.name));
        return;
      }
      const guard = {
        ownerKey: workspaceMoveOwnerRef.current,
        epoch: ++workspaceMoveEpochRef.current,
        viewKey: workspaceMoveViewRef.current,
      };
      setError("");
      const releaseWorkspaceMutation = beginWorkspaceMutationBarrier();
      setWorkspaceMovePending(true);
      try {
        if (clipboard.operation === "move") {
          const entries: WorkspaceEntrySelection[] = clipboard.entries.map((entry) => ({
            mountId,
            entry: { ...entry },
          }));
          const validation = validateWorkspaceEntryDrop(entries, mountId, targetDirPath, "move");
          if (!validation.valid) {
            if (validation.reason === "same-parent") {
              throw new Error(workspaceCopy.runtimeErrors.moveSameParent);
            }
            const folder = entries.find((item) => item.entry.kind === "directory");
            throw new Error(
              workspaceCopy.runtimeErrors.moveFolderIntoSelf(
                folder?.entry.name || entries[0]?.entry.name || workspaceCopy.defaultFileName,
              ),
            );
          }
          await performUserWorkspaceDrop(
            { space: "user", mountId, entries, primaryPath: entries[0]?.entry.path || "" },
            {
              space: "user",
              mountId,
              dirPath: targetDirPath,
              label: targetDirPath.split("/").pop() || "",
              surfaceKey: `clipboard:${mountId}:${targetDirPath}`,
              operation: "move",
              validation,
            },
            guard,
          );
          if (isWorkspaceMoveCurrent(guard)) setWorkspaceClipboard(null);
          return;
        }
        const result = (await executeUserSpaceOperation("copy_entries", {
          mountId,
          paths: clipboard.entries.map((entry) => entry.path),
          targetDirPath,
        })) as WorkspaceMoveResult;
        if (!isWorkspaceMoveCurrent(guard)) return;
        await refreshWorkspaceDirectories(mountId, [targetDirPath]);
        if (!isWorkspaceMoveCurrent(guard)) return;
        setWorkspaceClipboard(null);
        const copied = result.moves || [];
        if (copied.length > 0 && isWorkspaceMoveViewCurrent(guard)) {
          showWorkspaceAlert({
            status: "success",
            message: workspaceCopy.dragAndDrop.copySuccess(
              copied.length,
              targetDirPath.split("/").pop() || "",
            ),
          });
        }
      } catch (err) {
        if (isWorkspaceMoveCurrent(guard)) {
          await refreshFailedUserWorkspaceMutation(
            mountId,
            clipboard.entries.map((entry) => entry.path),
            targetDirPath,
          );
        }
        if (isWorkspaceMoveViewCurrent(guard)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isWorkspaceMoveCurrent(guard)) setWorkspaceMovePending(false);
        releaseWorkspaceMutation();
      }
    },
    [
      beginWorkspaceMutationBarrier,
      isWorkspaceMoveCurrent,
      isWorkspaceMoveViewCurrent,
      performUserWorkspaceDrop,
      refreshFailedUserWorkspaceMutation,
      refreshWorkspaceDirectories,
      showWorkspaceAlert,
      workspaceClipboard,
      workspaceMovePending,
    ],
  );

  const handleWorkspaceTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const element = event.target as HTMLElement;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element.isContentEditable
      ) {
        return;
      }
      const commandKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const focusedAgentRow = element.closest<HTMLElement>("[data-agent-path]");
      const focusedAgentPath = focusedAgentRow?.dataset.agentPath ?? "";
      const focusedAgentKind = focusedAgentRow?.dataset.agentKind;
      if (commandKey && key === "x") {
        if (spaceView === "user") {
          const selected = visibleWorkspaceEntryByKey.get(selectedEntryKey);
          if (selected && activeMountWritableForOps) {
            event.preventDefault();
            cutWorkspaceEntry(selected.mountId, selected.entry);
          }
        } else {
          const actionPath = focusedAgentRow ? focusedAgentPath : selectedAgentEntryPath;
          const selected = visibleAgentNodeByPath.get(actionPath)?.node;
          if (selected) {
            event.preventDefault();
            cutAgentWorkspaceEntry(selected);
          }
        }
        return;
      }
      if (commandKey && key === "v") {
        if (spaceView === "user" && workspaceClipboard) {
          const selected = visibleWorkspaceEntryByKey.get(selectedEntryKey);
          const targetDirPath = selected
            ? selected.entry.kind === "directory"
              ? selected.entry.path
              : dirnameWorkspacePath(selected.entry.path)
            : ROOT_PATH;
          event.preventDefault();
          if (
            activeMountWritableForOps &&
            workspaceClipboardCanPasteAt(workspaceClipboard, activeMountIdForOps, targetDirPath)
          ) {
            void pasteWorkspaceClipboard(activeMountIdForOps, targetDirPath);
          }
        } else if (spaceView === "agent" && agentWorkspaceClipboard) {
          const selected = focusedAgentRow
            ? undefined
            : visibleAgentNodeByPath.get(selectedAgentEntryPath)?.node;
          const targetDirPath = focusedAgentRow
            ? focusedAgentKind === "directory"
              ? focusedAgentPath
              : dirnameWorkspacePath(focusedAgentPath)
            : selected
              ? selected.type === "directory"
                ? agentNodePath(selected)
                : dirnameWorkspacePath(agentNodePath(selected))
              : ROOT_PATH;
          event.preventDefault();
          if (agentClipboardCanPasteAt(agentWorkspaceClipboard, targetDirPath)) {
            void pasteAgentWorkspaceClipboard(targetDirPath);
          }
        }
        return;
      }
      if (event.key === "Escape" && (workspaceClipboard || agentWorkspaceClipboard)) {
        event.preventDefault();
        const cutWasPending =
          workspaceClipboard?.operation === "move" || Boolean(agentWorkspaceClipboard);
        setWorkspaceClipboard(null);
        setAgentWorkspaceClipboard(null);
        if (cutWasPending) announceWorkspaceClipboard("cancelled");
      }
    },
    [
      activeMountIdForOps,
      activeMountWritableForOps,
      agentWorkspaceClipboard,
      announceWorkspaceClipboard,
      cutAgentWorkspaceEntry,
      cutWorkspaceEntry,
      pasteAgentWorkspaceClipboard,
      pasteWorkspaceClipboard,
      selectedAgentEntryPath,
      selectedEntryKey,
      spaceView,
      visibleAgentNodeByPath,
      visibleWorkspaceEntryByKey,
      workspaceClipboard,
    ],
  );

  const duplicateWorkspaceEntry = useCallback(
    async (mountId: string, entry: WorkspaceEntry) => {
      if (entry.kind !== "file") {
        setError(workspaceCopy.unsupportedActions.duplicateFolderPending);
        return;
      }
      setError("");
      try {
        await executeUserSpaceOperation("duplicate_entry", {
          mountId,
          path: entry.path,
        });
        await refreshWorkspaceDirectories(mountId, [dirnameWorkspacePath(entry.path)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshWorkspaceDirectories],
  );

  const closePreviewTabsForWorkspaceEntry = useCallback(
    (mountId: string, entry: WorkspaceEntry) => {
      const prefix = `${entry.path}/`;
      const matchingTabs = previewTabsRef.current.filter(
        (tab) =>
          tab.mountId === mountId &&
          (tab.path === entry.path || (entry.kind === "directory" && tab.path.startsWith(prefix))),
      );
      for (const tab of matchingTabs) closePreviewTabNow(tab.id);
    },
    [closePreviewTabNow],
  );

  const closePreviewTabsForAgentEntry = useCallback(
    (entry: WorkspaceEntry) => {
      const prefix = `${entry.path}/`;
      const matchingTabs = previewTabsRef.current.filter(
        (tab) =>
          isAgentPreviewTabId(tab.id) &&
          (tab.path === entry.path || (entry.kind === "directory" && tab.path.startsWith(prefix))),
      );
      for (const tab of matchingTabs) closePreviewTabNow(tab.id);
    },
    [closePreviewTabNow],
  );

  const confirmWorkspaceNameAction = useCallback(
    async (name: string) => {
      const dialog = workspaceActionDialog;
      if (!dialog || dialog.kind === "delete") return;
      const trimmedName = name.trim();
      if (!trimmedName) return;
      setWorkspaceActionSaving(true);
      setError("");
      try {
        const result = (await executeUserSpaceOperation("create_entry", {
          mountId: dialog.mountId,
          parentPath: dialog.parentPath,
          name: trimmedName,
          kind: dialog.kind === "create-folder" ? "directory" : "file",
        })) as { path?: string; kind?: WorkspaceEntry["kind"] };
        await refreshWorkspaceDirectories(dialog.mountId, [dialog.parentPath]);
        if (result.path) {
          selectSingleWorkspaceEntryKey(treeDirKey(dialog.mountId, result.path));
          if (result.kind === "directory") {
            setOpenDirs((current) =>
              new Set(current).add(treeDirKey(dialog.mountId, result.path || "")),
            );
          }
        }
        setWorkspaceActionDialog(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setWorkspaceActionSaving(false);
      }
    },
    [refreshWorkspaceDirectories, selectSingleWorkspaceEntryKey, workspaceActionDialog],
  );

  const confirmWorkspaceDeleteAction = useCallback(async () => {
    const dialog = workspaceActionDialog;
    if (!dialog || dialog.kind !== "delete") return;
    setWorkspaceActionSaving(true);
    setError("");
    try {
      if (dialog.space === "agent") {
        const deleteEntries = dialog.entries?.length
          ? dialog.entries
          : [{ mountId: dialog.mountId, entry: dialog.entry }];
        for (const item of deleteEntries) {
          await api.deleteAgentSpaceEntry(
            sessionId,
            item.entry.path,
            item.entry.kind === "directory",
          );
          closePreviewTabsForAgentEntry(item.entry);
        }
        await loadAgentTree();
        setAgentOpenDirs((current) => {
          const next = new Set<string>();
          for (const path of current) {
            if (
              deleteEntries.some(
                (item) => path === item.entry.path || path.startsWith(`${item.entry.path}/`),
              )
            )
              continue;
            next.add(path);
          }
          return next;
        });
        setAgentWorkspaceClipboard((current) => {
          if (!current) return current;
          const deletedPaths = deleteEntries.map((item) => item.entry.path);
          return current.some((entry) => {
            const path = agentNodePath(entry);
            return deletedPaths.some(
              (deletedPath) => path === deletedPath || path.startsWith(`${deletedPath}/`),
            );
          })
            ? null
            : current;
        });
        clearAgentEntrySelection();
        setWorkspaceActionDialog(null);
        return;
      }
      const deleteEntries = dialog.entries?.length
        ? dialog.entries
        : [{ mountId: dialog.mountId, entry: dialog.entry }];
      const refreshDirs = new Set<string>();
      for (const item of deleteEntries) {
        await executeUserSpaceOperation("delete_entry", {
          mountId: item.mountId,
          path: item.entry.path,
          recursive: item.entry.kind === "directory",
        });
        closePreviewTabsForWorkspaceEntry(item.mountId, item.entry);
        refreshDirs.add(dirnameWorkspacePath(item.entry.path));
      }
      await refreshWorkspaceDirectories(dialog.mountId, Array.from(refreshDirs));
      clearWorkspaceEntrySelection();
      if (workspaceClipboardCoversDeletedEntries(workspaceClipboard, deleteEntries)) {
        setWorkspaceClipboard(null);
      }
      setWorkspaceActionDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkspaceActionSaving(false);
    }
  }, [
    clearAgentEntrySelection,
    clearWorkspaceEntrySelection,
    closePreviewTabsForAgentEntry,
    closePreviewTabsForWorkspaceEntry,
    loadAgentTree,
    refreshWorkspaceDirectories,
    sessionId,
    workspaceActionDialog,
    workspaceClipboard,
  ]);

  useEffect(() => {
    if (!previewRequest || previewRequest.seq === handledPreviewRequestSeqRef.current) return;
    handledPreviewRequestSeqRef.current = previewRequest.seq;
    const requestSeq = previewRequest.seq;
    const ref = previewRequest.ref;
    const targetMountId = activeMountIdForOps || visibleMounts[0]?.mountId || "";
    if (!targetMountId) return;
    void (async () => {
      try {
        const file = await getUserSpaceFile(targetMountId, ref.path);
        if (handledPreviewRequestSeqRef.current !== requestSeq) return;
        await openFilePreview(targetMountId, ref.path, undefined, undefined, file);
      } catch (err) {
        if (handledPreviewRequestSeqRef.current !== requestSeq) return;
        showWorkspaceAlert(
          {
            status: "danger",
            message: previewErrorMessage(previewLoadErrorState(ref.path, err)),
          },
          true,
        );
      }
    })();
  }, [activeMountIdForOps, openFilePreview, previewRequest, showWorkspaceAlert, visibleMounts]);

  const handleMount = useCallback(async (): Promise<UserSpaceMount | null> => {
    if (disabledReason || mounting) return null;
    setMounting(true);
    setError("");
    try {
      const mount = await mountUserSpace("readwrite", {
        onProgress: () => {},
        existingRootNames: sessionMounts.map((item) => item.rootName),
        onNameConflict: (conflict) =>
          new Promise<string | null>((resolve) => {
            pendingMountNameConflictResolverRef.current?.(null);
            pendingMountNameConflictResolverRef.current = resolve;
            setPendingMountNameConflict(conflict);
          }),
        persistenceScope,
      });
      if (sessionMounts.some((item) => item.mountId === mount.mountId)) {
        setError(workspaceCopy.alreadyMounted(mount.rootName));
        setMounting(false);
        return null;
      }
      setMounting(false);
      return mount;
    } catch (err) {
      if (!isUserSpacePickerAbort(err)) setError(err instanceof Error ? err.message : String(err));
      setMounting(false);
      return null;
    }
  }, [disabledReason, mounting, persistenceScope, sessionMounts]);

  const saveMountConfiguration = useCallback(
    async (draftMounts: UserSpaceMount[], draftActiveMountId: string) => {
      setError("");
      try {
        const committedMounts: UserSpaceMount[] = [];
        for (const draft of draftMounts) {
          const current = sessionMounts.find((mount) => mount.mountId === draft.mountId);
          committedMounts.push(
            !current || current.rootName !== draft.rootName
              ? await renameUserSpaceMount(draft.mountId, draft.rootName)
              : draft,
          );
        }
        const committedIds = new Set(committedMounts.map((mount) => mount.mountId));
        for (const mount of sessionMounts) {
          if (!committedIds.has(mount.mountId))
            detachUserSpaceFromSession(sessionId, mount.mountId);
        }
        if (committedMounts.length > 0) {
          attachUserSpaceMountsToSession(
            sessionId,
            committedMounts.map((mount) => mount.mountId),
          );
        }
        const nextActiveId = committedIds.has(draftActiveMountId)
          ? draftActiveMountId
          : committedMounts[0]?.mountId || "";
        setActiveMountId(nextActiveId);
        writeActiveUserSpaceMountId(sessionId, nextActiveId);
        if (nextActiveId && nextActiveId !== activeMountIdForOps) {
          closePreviewTabsOutsideMount(nextActiveId);
        }
        onMountsConfigured?.(committedMounts);
        const removedIds = new Set(
          sessionMounts
            .filter((mount) => !committedIds.has(mount.mountId))
            .map((mount) => mount.mountId),
        );
        if (removedIds.size > 0) {
          const nextTabs = previewTabsRef.current.filter((tab) => !removedIds.has(tab.mountId));
          for (const tab of previewTabsRef.current) {
            if (removedIds.has(tab.mountId)) disposePreviewTabResources(tab);
          }
          previewTabsRef.current = nextTabs;
          setPreviewTabs(nextTabs);
        }
        configureSessionUserSpace(toUserSpaceConfig(committedMounts), nextActiveId || undefined, {
          onError: (err) => setError(err instanceof Error ? err.message : String(err)),
        });
        showWorkspaceAlert({
          status: "success",
          message: workspaceCopy.mountSwitcherDialog.saved,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [
      activeMountIdForOps,
      configureSessionUserSpace,
      closePreviewTabsOutsideMount,
      onMountsConfigured,
      sessionId,
      sessionMounts,
      showWorkspaceAlert,
    ],
  );

  const resolvePendingMountNameConflict = useCallback((name: string | null) => {
    const resolve = pendingMountNameConflictResolverRef.current;
    pendingMountNameConflictResolverRef.current = null;
    setPendingMountNameConflict(null);
    resolve?.(name);
  }, []);

  useEffect(
    () => () => {
      pendingMountNameConflictResolverRef.current?.(null);
      pendingMountNameConflictResolverRef.current = null;
    },
    [],
  );

  const applyAuthorizedMount = useCallback(
    (restored: UserSpaceMount) => {
      const nextMounts = sessionMounts.map((mount) =>
        mount.mountId === restored.mountId ? restored : mount,
      );
      setAuthorizationSettledOfflineMountIds((current) => {
        if (!current.has(restored.mountId)) return current;
        const next = new Set(current);
        next.delete(restored.mountId);
        return next;
      });
      attachUserSpaceMountsToSession(
        sessionId,
        nextMounts.map((mount) => mount.mountId),
      );
      setExpandedMountIds((current) => new Set(current).add(restored.mountId));
      onMountsConfigured?.(nextMounts);
      configureSessionUserSpace(toUserSpaceConfig(nextMounts), undefined, {
        onError: (err) => {
          setError(err instanceof Error ? err.message : String(err));
        },
      });
    },
    [configureSessionUserSpace, onMountsConfigured, sessionId, sessionMounts],
  );

  const attemptRestoreMountAuthorization = useCallback(
    async (mount: UserSpaceMount, options: { allowPickerFallback?: boolean } = {}) => {
      if (disabledReason || autoAuthorizingMountId) return;
      setAutoAuthorizingMountId(mount.mountId);
      setAuthorizationSettledOfflineMountIds((current) => {
        if (!current.has(mount.mountId)) return current;
        const next = new Set(current);
        next.delete(mount.mountId);
        return next;
      });
      setError("");
      try {
        let restored = persistenceScope
          ? await restorePersistedUserSpace(persistenceScope, mount, { requestPermission: true })
          : null;
        const canUsePickerFallback =
          !restored || (restored.status !== "mounted" && restored.permissionState !== "denied");
        if (canUsePickerFallback && options.allowPickerFallback) {
          restored = await remountUserSpace(mount, {
            onProgress: () => {},
            persistenceScope,
          });
        }
        if (!restored || restored.status !== "mounted") {
          setAuthorizationSettledOfflineMountIds((current) => new Set(current).add(mount.mountId));
          return;
        }
        applyAuthorizedMount(restored);
      } catch (err) {
        if (!isUserSpacePickerAbort(err)) {
          setAuthorizationSettledOfflineMountIds((current) => new Set(current).add(mount.mountId));
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setAutoAuthorizingMountId("");
      }
    },
    [applyAuthorizedMount, autoAuthorizingMountId, disabledReason, persistenceScope],
  );

  useEffect(() => {
    if (workspaceRestoring) return;
    setAuthorizationSettledOfflineMountIds((current) => {
      const next = new Set(current);
      for (const mount of visibleMounts) {
        const needsAuthorization =
          !localMountById.has(mount.mountId) &&
          (mount.status === "offline" || mount.status === "mounted");
        if (needsAuthorization) next.add(mount.mountId);
        else next.delete(mount.mountId);
      }
      if (next.size === current.size && Array.from(next).every((mountId) => current.has(mountId)))
        return current;
      return next;
    });
  }, [localMountById, visibleMounts, workspaceRestoring]);

  const handleAccessChange = useCallback(
    async (mountId: string, access: UserSpaceAccess) => {
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      const targetIsMounted = Boolean(
        target && target.status === "mounted" && localMountById.has(mountId),
      );
      if (
        !target ||
        target.access === access ||
        disabledReason ||
        accessChanging ||
        !targetIsMounted
      )
        return;
      setAccessChanging(true);
      setError("");
      try {
        const updated = await updateUserSpaceAccess(mountId, access);
        const nextMounts = sessionMounts.map((mount) =>
          mount.mountId === updated.mountId ? { ...mount, ...updated } : mount,
        );
        attachUserSpaceMountsToSession(
          sessionId,
          nextMounts.map((mount) => mount.mountId),
        );
        setActiveMountId(updated.mountId);
        onMountsConfigured?.(nextMounts);
        setAccessChanging(false);
        configureSessionUserSpace(toUserSpaceConfig(nextMounts), updated.mountId, {
          onError: (err) => {
            setError(err instanceof Error ? err.message : String(err));
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setAccessChanging(false);
      }
    },
    [
      accessChanging,
      configureSessionUserSpace,
      disabledReason,
      localMountById,
      onMountsConfigured,
      sessionId,
      sessionMounts,
      visibleMounts,
    ],
  );

  const toggleMountedRoot = useCallback(
    async (mountId: string) => {
      const key = treeDirKey(mountId, ROOT_PATH);
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      const targetIsMounted = Boolean(
        target && target.status === "mounted" && localMountById.has(mountId),
      );
      if (target && !targetIsMounted) {
        setActiveMountId(mountId);
        setExpandedMountIds((current) => new Set(current).add(mountId));
        await attemptRestoreMountAuthorization(target, { allowPickerFallback: true });
        return;
      }
      const shouldLoad = targetIsMounted && !entriesByDir.has(key) && !loadingDirs.has(key);
      setActiveMountId(mountId);
      setExpandedMountIds((current) => {
        const next = new Set(current);
        if (next.has(mountId) && activeMountIdForOps === mountId) next.delete(mountId);
        else next.add(mountId);
        return next;
      });
      if (shouldLoad) void loadDirectory(mountId, ROOT_PATH);
    },
    [
      activeMountIdForOps,
      attemptRestoreMountAuthorization,
      entriesByDir,
      loadDirectory,
      loadingDirs,
      localMountById,
      visibleMounts,
    ],
  );

  const handleMetadataSync = useCallback(
    async (mountId: string) => {
      const target = visibleMounts.find((mount) => mount.mountId === mountId);
      const targetIsMounted = Boolean(
        target && target.status === "mounted" && localMountById.has(mountId),
      );
      if (!target || !targetIsMounted || metadataSyncingMountId) return;
      setMetadataSyncingMountId(mountId);
      setError("");
      try {
        const updated = await syncUserSpaceMetadata(mountId);
        const nextMounts = sessionMounts.map((mount) =>
          mount.mountId === updated.mountId ? { ...mount, ...updated } : mount,
        );
        onMountsConfigured?.(nextMounts);
        configureSessionUserSpace(toUserSpaceConfig(nextMounts), undefined, {
          onError: (err) => {
            setError(err instanceof Error ? err.message : String(err));
          },
        });
        resetTree({ preservePreviewTabs: true });
        void loadDirectory(mountId, ROOT_PATH);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setMetadataSyncingMountId("");
      }
    },
    [
      configureSessionUserSpace,
      loadDirectory,
      localMountById,
      metadataSyncingMountId,
      onMountsConfigured,
      resetTree,
      sessionMounts,
      visibleMounts,
    ],
  );

  const handleUnmount = useCallback(
    async (mountId: string) => {
      if (!mountId || unmountingMountId) return;
      setUnmountingMountId(mountId);
      setError("");
      const nextMounts = sessionMounts.filter((mount) => mount.mountId !== mountId);
      try {
        detachUserSpaceFromSession(sessionId, mountId);
        onMountsConfigured?.(nextMounts);
        if (activeMountIdForOps === mountId) {
          setActiveMountId(nextMounts[0]?.mountId || "");
        }
        const nextTabs = previewTabsRef.current.filter((tab) => tab.mountId !== mountId);
        for (const tab of previewTabsRef.current) {
          if (tab.mountId === mountId) disposePreviewTabResources(tab);
        }
        setPreviewTabs(nextTabs);
        previewTabsRef.current = nextTabs;
        const nextActiveTab =
          nextTabs.find((tab) => tab.id === activePreviewTabId) || nextTabs[0] || null;
        if (nextActiveTab?.id !== activePreviewTabId) {
          setActivePreviewTabId(nextActiveTab?.id || "");
        }
        if (
          !nextActiveTab ||
          selectedEntryKey.startsWith(`${mountId}\u0000`) ||
          !nextTabs.some((tab) => treeDirKey(tab.mountId, tab.path) === selectedEntryKey)
        ) {
          syncPreviewTabFocus(nextActiveTab);
        }
        configureSessionUserSpace(toUserSpaceConfig(nextMounts), undefined, {
          onError: (err) => {
            setError(err instanceof Error ? err.message : String(err));
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUnmountingMountId("");
      }
    },
    [
      activeMountIdForOps,
      activePreviewTabId,
      configureSessionUserSpace,
      onMountsConfigured,
      selectedEntryKey,
      sessionId,
      sessionMounts,
      syncPreviewTabFocus,
      unmountingMountId,
    ],
  );

  const activeWorkspaceAlerts: WorkspaceAlertState[] = error
    ? [
        ...workspaceAlerts,
        {
          id: 0,
          status: "danger",
          message: error,
        },
      ]
    : workspaceAlerts;
  const stackedWorkspaceAlerts = [...activeWorkspaceAlerts].reverse();

  return (
    <aside
      aria-label={workspaceCopy.workspaceSidebar}
      data-piwork-user-space-explorer
      data-preview-open={previewOpen ? "true" : "false"}
      className={`relative grid h-full min-h-0 w-full overflow-visible bg-card ${className}`}
      style={{
        gridTemplateColumns: previewOpen
          ? `${treeColumnWidth} minmax(0, 1fr)`
          : "minmax(0, 1fr) 0px",
      }}
    >
      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        data-testid="workspace-clipboard-announcement"
      >
        {workspaceClipboardAnnouncement && (
          <span key={workspaceClipboardAnnouncement.id}>
            {workspaceClipboardAnnouncement.kind === "user-cut"
              ? workspaceCopy.clipboardAnnouncements.userCut(workspaceClipboardAnnouncement.count)
              : workspaceClipboardAnnouncement.kind === "agent-cut"
                ? workspaceCopy.clipboardAnnouncements.agentCut(
                    workspaceClipboardAnnouncement.count,
                  )
                : workspaceCopy.clipboardAnnouncements.cancelled}
          </span>
        )}
      </span>
      {workspaceDragProxy && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[var(--piwork-z-drag)] flex h-8 max-w-[260px] -translate-x-3.5 -translate-y-4 items-center truncate rounded-[var(--piwork-control-radius)] border border-primary/60 bg-card px-2.5 text-xs font-medium text-foreground transition-none"
              data-testid="workspace-drag-proxy"
              style={{ left: workspaceDragProxy.x, top: workspaceDragProxy.y }}
            >
              <Files className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {workspaceDragProxy.count === 1
                  ? workspaceDragProxy.label
                  : workspaceCopy.dragAndDrop.items(workspaceDragProxy.count)}
              </span>
            </div>,
            document.body,
          )
        : null}
      {stackedWorkspaceAlerts.length > 0 && (
        <div
          data-expanded={workspaceAlertsExpanded ? "true" : "false"}
          data-testid="workspace-alert-stack"
          onMouseEnter={() => setWorkspaceAlertsExpanded(true)}
          onMouseLeave={(event) => {
            if (!event.currentTarget.contains(document.activeElement)) {
              setWorkspaceAlertsExpanded(false);
            }
          }}
          onFocusCapture={() => setWorkspaceAlertsExpanded(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setWorkspaceAlertsExpanded(false);
            }
          }}
          className={`fixed left-1/2 top-3 z-[var(--piwork-z-toast)] grid w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 ${
            workspaceAlertsExpanded ? "pointer-events-auto gap-2" : "pointer-events-none"
          }`}
        >
          {stackedWorkspaceAlerts.map((alert, index) => (
            <Alert
              key={alert.id}
              status={alert.status}
              role="alert"
              aria-live="polite"
              className={`pointer-events-auto origin-top transition-[transform,opacity] duration-[var(--piwork-duration-feedback)] ease-[var(--piwork-ease-out)] ${
                workspaceAlertsExpanded ? "" : "col-start-1 row-start-1"
              } ${WORKSPACE_ALERT_SURFACE_CLASSES[alert.status]}`}
              style={
                workspaceAlertsExpanded
                  ? undefined
                  : {
                      zIndex: stackedWorkspaceAlerts.length - index,
                      opacity: index < 3 ? 1 : 0,
                      transform: `translateY(${Math.min(index, 2) * 10}px) scale(${1 - Math.min(index, 2) * 0.015})`,
                    }
              }
            >
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>{alert.message}</Alert.Title>
              </Alert.Content>
              <CloseButton
                onClick={() => dismissWorkspaceAlert(alert.id)}
                aria-label={uiCopy.common.close}
                className="bg-transparent! text-foreground hover:bg-transparent! data-[hovered]:bg-transparent!"
              />
            </Alert>
          ))}
        </div>
      )}
      <div
        data-testid="user-space-tree-panel"
        data-piwork-user-space-tree-panel
        aria-hidden={previewOpen && spacePanelCollapsed ? true : undefined}
        inert={previewOpen && spacePanelCollapsed ? true : undefined}
        className={`relative col-span-1 flex h-full min-h-0 flex-col ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS} ${
          previewOpen && spacePanelCollapsed ? "pointer-events-none invisible overflow-hidden" : ""
        }`}
      >
        {previewOpen && (
          <span
            aria-hidden="true"
            data-testid="user-space-inner-divider"
            className="pointer-events-none absolute inset-y-0 right-0 z-20 w-px bg-border"
          />
        )}
        <div
          className={`flex ${WORKSPACE_PANEL_TOPBAR_HEIGHT_CLASS} shrink-0 items-stretch ${WORKSPACE_PANEL_HEADER_BORDER_CLASS} ${WORKSPACE_PANEL_HEADER_SURFACE_CLASS}`}
        >
          <div
            className="flex min-w-0 flex-1 items-stretch gap-1 p-1"
            role="tablist"
            aria-label={workspaceCopy.selectSpace}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const tabList = event.currentTarget;
              setSpaceView(event.key === "ArrowLeft" || event.key === "Home" ? "user" : "agent");
              requestAnimationFrame(() =>
                tabList.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
              );
            }}
          >
            <SpaceSwitchButton active={spaceView === "user"} onClick={() => setSpaceView("user")}>
              {workspaceCopy.userSpace}
            </SpaceSwitchButton>
            <SpaceSwitchButton active={spaceView === "agent"} onClick={() => setSpaceView("agent")}>
              {workspaceCopy.agentSpace}
            </SpaceSwitchButton>
          </div>
        </div>

        {workspaceMovePending && (
          <div
            role="status"
            aria-live="polite"
            data-testid="workspace-move-status"
            className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-accent/45 px-3 text-xs font-medium text-foreground/75"
          >
            <RefreshCw aria-hidden="true" className="h-3 w-3 animate-spin" />
            <span>{workspaceCopy.dragAndDrop.processing}</span>
          </div>
        )}

        {spaceView === "user" && (
          <UserSpaceMountSwitcher
            mounts={visibleMounts}
            activeMountId={activeMountIdForOps}
            isMounted={Boolean(
              activeMount &&
              activeMount.status === "mounted" &&
              localMountById.has(activeMount.mountId),
            )}
            authorizing={autoAuthorizingMountId === activeMountIdForOps}
            showRestoreAccess={!workspaceRestoring}
            accessChanging={accessChanging}
            metadataSyncingMountId={metadataSyncingMountId}
            unmountingMountId={unmountingMountId}
            mounting={mounting}
            mountDisabledReason={disabledReason}
            onSelect={selectActiveMount}
            onActivateRoot={toggleMountedRoot}
            onSearch={openWorkspaceSearch}
            onAccessChange={handleAccessChange}
            onMetadataSync={handleMetadataSync}
            onUnmount={handleUnmount}
            onMount={handleMount}
            onSave={saveMountConfiguration}
            onDiscardMount={discardUnattachedUserSpaceMount}
            showPasteRoot={Boolean(workspaceClipboard)}
            canPasteRoot={
              activeMountWritableForOps &&
              workspaceClipboardCanPasteAt(workspaceClipboard, activeMountIdForOps, ROOT_PATH)
            }
            movePending={workspaceMovePending}
            onPasteRoot={() => void pasteWorkspaceClipboard(activeMountIdForOps, ROOT_PATH)}
            workspaceDrag={workspaceDrag}
            onRootDragOver={handleWorkspaceRootDragOver}
            onDragLeave={clearWorkspaceDropTarget}
            onDrop={dropWorkspaceEntries}
            onDragEnd={finishWorkspaceDrag}
            previewOpen={previewOpen}
            previewAvailable={previewTabs.length > 0}
            onTogglePreview={togglePreviewFold}
          />
        )}

        <div
          {...(spaceView === "user" ? treeA11yProps : {})}
          ref={(node) => {
            treeScrollRef.current = node;
            if (spaceView === "user" && typeof headlessTreeRef === "function")
              headlessTreeRef(node);
          }}
          className="piwork-scrollbar-hidden min-h-0 flex-1 overflow-auto pb-1 pt-1"
          aria-label={workspaceCopy.workspaceTree}
          aria-multiselectable={spaceView === "user" ? "true" : undefined}
          aria-busy={workspaceMovePending ? true : undefined}
          data-piwork-user-space-tree-pane
          data-testid="user-space-tree-pane"
          onKeyDown={(event) => {
            handleWorkspaceTreeKeyDown(event);
            if (!event.defaultPrevented && spaceView === "user") {
              headlessTreeKeyDown?.(event);
            }
          }}
          onDragOverCapture={handleWorkspaceTreeDragOverCapture}
          onDragLeave={handleWorkspaceTreeDragLeave}
        >
          {spaceView === "agent" && (
            <div className="flex min-h-full flex-col">
              <AgentSpaceTree
                cwd={agentCwd}
                tree={agentTree}
                loading={agentTreeLoading}
                error={agentTreeError}
                rootOpen={agentRootOpen}
                openDirs={agentOpenDirs}
                selectedEntryPath={selectedAgentEntryPath}
                selectedEntryPaths={selectedAgentEntryPaths}
                selectionSegments={agentSelectionSegments}
                workspaceDrag={workspaceDrag}
                movePending={workspaceMovePending}
                workspaceClipboard={agentWorkspaceClipboard}
                canTransferToUser={activeMountWritableForOps}
                onToggleRoot={() => setAgentRootOpen((current) => !current)}
                onEntryClick={handleAgentEntryClick}
                onOpenAsText={(node) =>
                  void openAgentFilePreview(
                    agentNodePath(node),
                    previewKindForWorkspacePath(agentNodePath(node)),
                    "text",
                    node.size,
                  )
                }
                onShowDetails={showAgentEntryDetails}
                onTransferToUser={transferAgentSpaceEntryToUser}
                onDeleteEntry={startDeleteAgentSpaceEntry}
                onCutEntry={cutAgentWorkspaceEntry}
                onPasteEntry={pasteAgentWorkspaceClipboard}
                onRootDragOver={handleAgentRootDragOver}
                onEntryDragStart={beginAgentEntryDrag}
                onEntryDragOver={handleAgentEntryDragOver}
                onDragLeave={clearWorkspaceDropTarget}
                onDrop={dropWorkspaceEntries}
                onDragEnd={finishWorkspaceDrag}
                onRetry={() => void loadAgentTree()}
              />
              <div
                className={`relative min-h-10 flex-1 transition-colors duration-150 ${
                  workspaceDrag?.target?.surfaceKey === "agent-root" &&
                  workspaceDrag.target.validation.valid
                    ? "bg-primary/8 outline outline-1 -outline-offset-1 outline-primary"
                    : ""
                }`}
                data-testid="agent-space-tree-blank-area"
                data-piwork-workspace-drop-surface
                data-drop-target={
                  workspaceDrag?.target?.surfaceKey === "agent-root" &&
                  workspaceDrag.target.validation.valid
                    ? "true"
                    : undefined
                }
                role="presentation"
                onClick={clearAllTreeSelection}
                onDragOver={handleAgentRootDragOver}
                onDrop={dropWorkspaceEntries}
                onDragEnd={finishWorkspaceDrag}
              />
            </div>
          )}

          {spaceView === "user" && (
            <div className="flex min-h-full flex-col">
              <VirtualWorkspaceTree
                treeItems={workspaceTreeItems}
                virtualizer={treeVirtualizer}
                activeMountIdForOps={activeMountIdForOps}
                accessChanging={accessChanging}
                metadataSyncingMountId={metadataSyncingMountId}
                unmountingMountId={unmountingMountId}
                selectedEntryKey={selectedEntryKey}
                selectedEntryKeys={selectedEntryKeys}
                selectionSegments={workspaceSelectionSegments}
                pendingRenameEntryKey={pendingRenameEntryKey}
                openDirs={openDirs}
                workspaceDrag={workspaceDrag}
                canMoveEntries={activeMountWritableForOps}
                movePending={workspaceMovePending}
                onToggleRoot={toggleMountedRoot}
                onSearch={openWorkspaceSearch}
                onAccessChange={handleAccessChange}
                onMetadataSync={handleMetadataSync}
                onUnmount={handleUnmount}
                onEntryClick={handleWorkspaceEntryClick}
                onOpenAsText={(mountId, entry) =>
                  void openFilePreview(
                    mountId,
                    entry.path,
                    entry.previewKind,
                    "text",
                    undefined,
                    entry.size,
                  )
                }
                onOpen={openWorkspaceFiles}
                onOpenAndPin={openAndPinWorkspaceFiles}
                onOpenInNewWindow={openWorkspaceFilesInNewWindows}
                onAddFileReference={addFileReference}
                workspaceClipboard={workspaceClipboard}
                onCreateEntry={startCreateWorkspaceEntry}
                onRenameEntry={renameWorkspaceEntry}
                onPendingRenameConsumed={() => setPendingRenameEntryKey("")}
                onShowDetails={showWorkspaceEntryDetails}
                onCopyEntry={copyWorkspaceEntry}
                onCutEntry={cutWorkspaceEntry}
                onPasteEntry={pasteWorkspaceClipboard}
                onDuplicateEntry={duplicateWorkspaceEntry}
                onDeleteEntry={startDeleteWorkspaceEntry}
                onTransferToAgent={transferUserSpaceEntryToAgent}
                onEntryDragStart={beginWorkspaceEntryDrag}
                onEntryDragOver={handleWorkspaceEntryDragOver}
                onDragLeave={clearWorkspaceDropTarget}
                onDrop={dropWorkspaceEntries}
                onDragEnd={finishWorkspaceDrag}
                onLoadMore={(mountId, path) => void loadDirectory(mountId, path, true)}
                onRetry={(mountId, path) => void loadDirectory(mountId, path)}
              />
              <WorkspaceBlankAreaContextMenu
                mountId={activeMountIdForOps}
                canUseMenu={activeMountReadyForOps}
                canPaste={
                  activeMountWritableForOps &&
                  !workspaceMovePending &&
                  workspaceClipboardCanPasteAt(workspaceClipboard, activeMountIdForOps, ROOT_PATH)
                }
                onClearSelection={clearAllTreeSelection}
                onOpenWterm={openWtermPreview}
                onCreateEntry={startCreateWorkspaceEntry}
                onPasteEntry={pasteWorkspaceClipboard}
                workspaceDrag={workspaceDrag}
                onRootDragOver={handleWorkspaceRootDragOver}
                onDragLeave={clearWorkspaceDropTarget}
                onDrop={dropWorkspaceEntries}
                onDragEnd={finishWorkspaceDrag}
              />
            </div>
          )}
        </div>
      </div>
      {!previewOpen && (
        <div
          aria-hidden="true"
          data-testid="user-space-folded-tree-divider"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-px bg-border"
        />
      )}

      <div
        data-piwork-user-space-preview-panel
        className={`flex h-full min-w-0 flex-col overflow-hidden ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS} ${
          previewOpen ? "" : "pointer-events-none invisible"
        }`}
        data-testid="user-space-preview-pane"
        aria-hidden={previewOpen ? undefined : true}
        inert={previewOpen ? undefined : true}
      >
        <WorkspacePreviewPane
          uiLanguage={uiLanguage}
          tabs={previewTabs}
          activeTabId={activePreviewTab?.id || ""}
          previewVisible={previewOpen}
          onSelectTab={selectPreviewTab}
          onCloseTab={closePreviewTab}
          onCloseTabs={closePreviewTabs}
          onCloseAllTabs={closeAllPreviewTabs}
          onAddToConversation={addPreviewTabToConversation}
          onPinnedChange={setPreviewTabPinned}
          onUnpinAll={unpinAllPreviewTabs}
          onCloseAllPinned={closeAllPinnedPreviewTabs}
          onMoveTab={movePreviewTab}
          onViewModeChange={updatePreviewTabViewMode}
          mountsById={visibleMountById}
          onSaveTextContent={savePreviewTextContent}
          onSaveImageFile={savePreviewImageFile}
          waitForWorkspaceMutation={waitForWorkspaceMutation}
          resolvePreviewTabPath={resolvePreviewTabPath}
          onUnsavedChange={updatePreviewTabUnsavedState}
          onEditingChange={updatePreviewTabEditingState}
          onOfficeFileMigration={handleOfficeFileMigration}
          onOfficeFileCreated={handleOfficeFileCreated}
          onOfficeFileSaved={handleOfficeFileSaved}
          spacePanelCollapsed={spacePanelCollapsed}
          onSpacePanelCollapsedChange={setSpacePanelCollapsed}
          sessionPanelCollapsed={sessionPanelCollapsed}
          onSessionPanelCollapsedChange={(collapsed) => onSessionPanelCollapsedChange?.(collapsed)}
          detachedWindowRequests={detachedWindowRequests}
          onDetachedWindowRequestHandled={(requestId) =>
            setDetachedWindowRequests((current) =>
              current.filter((request) => request.id !== requestId),
            )
          }
          onRequestPreviewOpen={() => setPreviewOpen(true)}
        />
      </div>

      {previewOpen && (
        <div
          aria-hidden="true"
          data-testid="user-space-outer-divider"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-px bg-border"
        />
      )}

      {blockedDetachedWindowEntries.length > 0 && (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) setBlockedDetachedWindowEntries([]);
          }}
        >
          <Modal.Backdrop variant="opaque" isDismissable>
            <Modal.Container placement="center" size="sm">
              <Modal.Dialog
                aria-label={workspaceCopy.allowPreviewPopups}
                className={`piwork-superellipse-panel w-full max-w-md overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
              >
                <Modal.Header className="border-b border-border px-5 py-4">
                  <Modal.Heading className="text-base font-semibold">
                    {workspaceCopy.allowPreviewPopups}
                  </Modal.Heading>
                </Modal.Header>
                <Modal.Body className="px-5 py-4">
                  <p className="text-sm text-muted-foreground">
                    {workspaceCopy.previewPopupsBlocked(blockedDetachedWindowEntries.length)}
                  </p>
                </Modal.Body>
                <Modal.Footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
                  <Button variant="secondary" onPress={() => setBlockedDetachedWindowEntries([])}>
                    {uiCopy.common.cancel}
                  </Button>
                  <Button
                    variant="primary"
                    onPress={retryBlockedDetachedWindows}
                    data-testid="retry-blocked-detached-preview-windows"
                  >
                    {workspaceCopy.retryOpeningPreviewWindows}
                  </Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}

      {pendingPreviewClose && (
        <UnsavedPreviewCloseDialog
          count={
            pendingPreviewClose.kind === "all"
              ? previewTabs.filter((tab) => tab.hasUnsavedChanges).length
              : pendingPreviewClose.kind === "tabs"
                ? (pendingPreviewClose.unsavedCount ?? pendingPreviewClose.tabIds.length)
                : 1
          }
          fileName={
            pendingPreviewClose.kind === "tab"
              ? previewTabs.find((tab) => tab.id === pendingPreviewClose.tabId)?.title
              : undefined
          }
          onCancel={() => setPendingPreviewClose(null)}
          onConfirm={confirmPendingPreviewClose}
        />
      )}

      {pendingMountSwitch && (
        <MountSwitchConfirmDialog
          targetName={
            visibleMountById.get(pendingMountSwitch.mountId)?.rootName ||
            workspaceCopy.defaultRootName
          }
          count={pendingMountSwitch.tabIds.length}
          onCancel={() => setPendingMountSwitch(null)}
          onConfirm={confirmPendingMountSwitch}
        />
      )}

      {pendingMountNameConflict && (
        <MountNameConflictDialog
          name={pendingMountNameConflict.name}
          existingNames={pendingMountNameConflict.existingNames}
          onCancel={() => resolvePendingMountNameConflict(null)}
          onConfirm={(name) => resolvePendingMountNameConflict(name)}
        />
      )}

      {workspaceActionDialog && workspaceActionDialog.kind !== "delete" && (
        <WorkspaceNameDialog
          dialog={workspaceActionDialog}
          saving={workspaceActionSaving}
          onCancel={() => setWorkspaceActionDialog(null)}
          onConfirm={confirmWorkspaceNameAction}
        />
      )}

      {workspaceActionDialog?.kind === "delete" && (
        <WorkspaceDeleteDialog
          dialog={workspaceActionDialog}
          saving={workspaceActionSaving}
          onCancel={() => setWorkspaceActionDialog(null)}
          onConfirm={confirmWorkspaceDeleteAction}
        />
      )}

      {workspaceDetailsDialog && (
        <WorkspaceDetailsModal
          dialog={workspaceDetailsDialog}
          onClose={() => setWorkspaceDetailsDialog(null)}
        />
      )}

      {workspaceSearchMount && (
        <WorkspaceSearchModal
          mount={workspaceSearchMount}
          includeHidden
          uiLanguage={uiLanguage}
          onClose={() => setWorkspaceSearchMountId("")}
          onOpenResult={(result) =>
            void openWorkspaceSearchResult(workspaceSearchMount.mountId, result)
          }
          renderPreview={(args) => <WorkspaceSearchPreviewBody {...args} />}
        />
      )}
    </aside>
  );
}

export const UserSpaceExplorer = memo(UserSpaceExplorerImpl);

function SpaceSwitchButton({
  active,
  onClick,
  children,
  compact = false,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`flex h-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[var(--piwork-control-radius)] border-0 text-center ${
        compact ? "px-2 text-xs font-semibold" : `px-1 ${WORKSPACE_PANEL_HEADER_TEXT_CLASS}`
      } ${
        compact
          ? active
            ? "bg-accent text-foreground"
            : `bg-transparent ${WORKSPACE_SELECTABLE_TEXT_CLASS} hover:bg-accent`
          : active
            ? "bg-accent text-foreground"
            : `bg-transparent ${WORKSPACE_SELECTABLE_TEXT_CLASS} hover:bg-accent`
      }`}
    >
      <span className="min-w-0 max-w-full truncate leading-none overflow-visible">{children}</span>
    </button>
  );
}

function UserSpaceMountSwitcher({
  mounts,
  activeMountId,
  isMounted,
  authorizing,
  showRestoreAccess,
  accessChanging,
  metadataSyncingMountId,
  unmountingMountId,
  mounting,
  mountDisabledReason,
  onActivateRoot,
  onSearch,
  onAccessChange,
  onMetadataSync,
  onUnmount,
  onMount,
  onSave,
  onDiscardMount,
  showPasteRoot,
  canPasteRoot,
  movePending,
  onPasteRoot,
  workspaceDrag,
  onRootDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  previewOpen,
  previewAvailable,
  onTogglePreview,
}: {
  mounts: UserSpaceMount[];
  activeMountId: string;
  isMounted: boolean;
  authorizing: boolean;
  showRestoreAccess: boolean;
  accessChanging: boolean;
  metadataSyncingMountId: string;
  unmountingMountId: string;
  mounting: boolean;
  mountDisabledReason: string;
  onSelect: (mountId: string) => void;
  onActivateRoot: (mountId: string) => void | Promise<void>;
  onSearch: (mountId: string) => void;
  onAccessChange: (mountId: string, access: UserSpaceAccess) => void | Promise<void>;
  onMetadataSync: (mountId: string) => void | Promise<void>;
  onUnmount: (mountId: string) => void | Promise<void>;
  onMount: () => Promise<UserSpaceMount | null>;
  onSave: (mounts: UserSpaceMount[], activeMountId: string) => Promise<void>;
  onDiscardMount: (mountId: string) => Promise<void>;
  showPasteRoot: boolean;
  canPasteRoot: boolean;
  movePending: boolean;
  onPasteRoot: () => void;
  workspaceDrag: WorkspaceDragState | null;
  onRootDragOver: (event: WorkspaceDragEvent, mountId?: string) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
  previewOpen: boolean;
  previewAvailable: boolean;
  onTogglePreview: () => void;
}) {
  const activeMount = mounts.find((mount) => mount.mountId === activeMountId) || mounts[0];
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pendingUnmount, setPendingUnmount] = useState<UserSpaceMount | null>(null);
  const [draftMounts, setDraftMounts] = useState<UserSpaceMount[]>(mounts);
  const [draftActiveMountId, setDraftActiveMountId] = useState(activeMountId);
  const [draftAddedMountIds, setDraftAddedMountIds] = useState<Set<string>>(() => new Set());
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [editingMountId, setEditingMountId] = useState("");
  const nextAccess = activeMount?.access === "readonly" ? "readwrite" : "readonly";
  const AccessIcon = activeMount?.access === "readonly" ? Lock : Unlock;
  const syncing = Boolean(activeMount && metadataSyncingMountId === activeMount.mountId);
  const draftNamesValid =
    draftMounts.every((mount) => mount.rootName.trim().length > 0) &&
    new Set(draftMounts.map((mount) => mount.rootName.trim().toLocaleLowerCase())).size ===
      draftMounts.length;
  const rootDropTarget =
    Boolean(activeMount) &&
    workspaceDrag?.target?.surfaceKey === `user-root:${activeMount?.mountId}` &&
    workspaceDrag.target.validation.valid;
  const chooseMount = useCallback((mountId: string) => {
    setDraftActiveMountId(mountId);
  }, []);
  const openMountSwitcher = useCallback(() => {
    setDraftMounts(mounts);
    setDraftActiveMountId(activeMountId);
    setDraftAddedMountIds(new Set());
    setEditingMountId("");
    setSwitcherOpen(true);
  }, [activeMountId, mounts]);
  const discardDraft = useCallback(() => {
    for (const mountId of draftAddedMountIds) void onDiscardMount(mountId);
    setDraftAddedMountIds(new Set());
    setDraftMounts(mounts);
    setDraftActiveMountId(activeMountId);
    setEditingMountId("");
  }, [activeMountId, draftAddedMountIds, mounts, onDiscardMount]);
  return (
    <div
      className={`h-10 shrink-0 border-b border-border transition-colors duration-150 ${WORKSPACE_PANEL_HEADER_SURFACE_CLASS} ${
        rootDropTarget ? "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary" : ""
      }`}
      data-testid="user-space-mount-switcher"
      data-piwork-workspace-drop-surface
      data-drop-target={rootDropTarget ? "true" : undefined}
      data-drop-operation={rootDropTarget ? workspaceDrag?.target?.operation : undefined}
      onDragOver={(event) => {
        if (activeMount) onRootDragOver(event, activeMount.mountId);
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
      onDragEnd={onDragEnd}
    >
      <div
        data-testid="user-space-mount-switcher-anchor"
        className="relative flex h-full min-w-0 items-center"
      >
        <div
          data-testid="user-space-current-mount"
          className="flex h-[var(--piwork-titlebar-control-size)] min-w-0 flex-1 items-center pl-4 text-sm font-semibold text-foreground"
        >
          <span className="min-w-0 truncate overflow-visible">
            {activeMount?.rootName || workspaceCopy.noSelection}
          </span>
        </div>
        <div
          data-testid="user-space-mount-controls"
          className="ml-auto flex shrink-0 items-center gap-1 pr-1"
        >
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            aria-label={workspaceCopy.mountSwitcherDialog.title}
            title={workspaceCopy.mountSwitcherDialog.title}
            data-testid="user-space-mount-switcher-button"
            onClick={openMountSwitcher}
            onKeyDown={(event) => {
              if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "v") return;
              event.preventDefault();
              event.stopPropagation();
              if (canPasteRoot && !movePending) onPasteRoot();
            }}
            className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent ${switcherOpen ? "bg-accent" : ""}`}
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </button>
          {activeMount && (
            <>
              {!isMounted && showRestoreAccess && (
                <button
                  type="button"
                  disabled={authorizing}
                  aria-label={workspaceCopy.restoreAccessFor(activeMount.rootName)}
                  onClick={() => void onActivateRoot(activeMount.mountId)}
                  className={`${WORKSPACE_CONTROL_RADIUS_CLASS} mr-1 h-6 shrink-0 bg-accent px-2 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/80 disabled:cursor-wait disabled:opacity-60`}
                >
                  {workspaceCopy.restoreAccess}
                </button>
              )}
              {showPasteRoot && (
                <button
                  type="button"
                  onClick={onPasteRoot}
                  disabled={!canPasteRoot || movePending}
                  title={workspaceCopy.contextMenu.pasteToRoot(activeMount.rootName)}
                  aria-label={workspaceCopy.contextMenu.pasteToRoot(activeMount.rootName)}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <Clipboard className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onSearch(activeMount.mountId)}
                disabled={!isMounted}
                title={workspaceCopy.searchDialog.buttonTitle}
                className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
                aria-label={workspaceCopy.searchDialog.openFor(activeMount.rootName)}
              >
                <Search className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void onAccessChange(activeMount.mountId, nextAccess)}
                disabled={accessChanging || !isMounted}
                title={workspaceCopy.accessToggleTitle(activeMount.access)}
                className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
                aria-label={workspaceCopy.setAccess(activeMount.rootName, nextAccess)}
              >
                <AccessIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void onMetadataSync(activeMount.mountId)}
                disabled={!isMounted || Boolean(metadataSyncingMountId)}
                title={workspaceCopy.syncIndex}
                className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
                aria-label={workspaceCopy.syncIndexFor(activeMount.rootName)}
              >
                <RefreshCw
                  className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onTogglePreview}
            disabled={!previewAvailable}
            aria-label={previewOpen ? workspaceCopy.foldPreview : workspaceCopy.expandPreview}
            title={previewOpen ? workspaceCopy.foldPreview : workspaceCopy.expandPreview}
            aria-pressed={!previewOpen}
            data-piwork-user-space-preview-toggle
            className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45`}
          >
            <File className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <Modal
        isOpen={switcherOpen}
        onOpenChange={(open) => {
          if (!open) discardDraft();
          setSwitcherOpen(open);
        }}
      >
        <Modal.Backdrop variant="opaque" isDismissable>
          <Modal.Container placement="center" size="sm">
            <Modal.Dialog
              aria-label={workspaceCopy.mountSwitcherDialog.title}
              className={`piwork-superellipse-panel w-full max-w-md overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
            >
              <Modal.Header className="relative block border-b border-border px-5 py-4 pr-12">
                <div className="min-w-0 flex-1">
                  <Modal.Heading className="text-base font-semibold">
                    {workspaceCopy.mountSwitcherDialog.title}
                  </Modal.Heading>
                </div>
                <Modal.CloseTrigger
                  aria-label={uiCopy.common.close}
                  className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center bg-transparent text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Modal.CloseTrigger>
              </Modal.Header>
              <Modal.Body className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
                {draftMounts.length > 0 ? (
                  <div role="list" aria-label={workspaceCopy.mountMenuLabel} className="space-y-1">
                    {draftMounts.map((mount) => {
                      const current = mount.mountId === draftActiveMountId;
                      const removing = unmountingMountId === mount.mountId;
                      const aliasCandidate = mount.rootName.trim();
                      const aliasDuplicate =
                        Boolean(aliasCandidate) &&
                        draftMounts.some(
                          (item) =>
                            item.mountId !== mount.mountId &&
                            item.rootName.trim().toLocaleLowerCase() ===
                              aliasCandidate.toLocaleLowerCase(),
                        );
                      const aliasInvalid = !aliasCandidate || aliasDuplicate;
                      return (
                        <div
                          key={mount.mountId}
                          role="listitem"
                          data-testid={`user-space-mount-option-${mount.mountId}`}
                          className={`group flex min-h-12 w-full items-center gap-1 border border-transparent ${WORKSPACE_CONTROL_RADIUS_CLASS} p-1.5 text-foreground transition-colors ${
                            current ? "bg-accent" : "bg-transparent hover:bg-accent"
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">
                            {editingMountId === mount.mountId ? (
                              <>
                                {current ? (
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center text-foreground">
                                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                                  </span>
                                ) : (
                                  <span className="h-8 w-8 shrink-0" aria-hidden="true" />
                                )}
                                <input
                                  autoFocus
                                  value={mount.rootName}
                                  aria-label={workspaceCopy.mountSwitcherDialog.aliasLabel(
                                    mount.rootName,
                                  )}
                                  aria-invalid={aliasInvalid ? true : undefined}
                                  data-name-availability={aliasInvalid ? "invalid" : "available"}
                                  onChange={(event) => {
                                    const rootName = event.target.value;
                                    setDraftMounts((currentMounts) =>
                                      currentMounts.map((item) =>
                                        item.mountId === mount.mountId
                                          ? { ...item, name: rootName, rootName }
                                          : item,
                                      ),
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && !aliasInvalid) {
                                      setEditingMountId("");
                                    }
                                  }}
                                  className={`h-9 min-w-0 flex-1 rounded-[var(--piwork-control-radius)] border bg-background px-3 text-sm font-semibold text-foreground outline-none transition-colors focus:ring-2 ${
                                    aliasInvalid
                                      ? "border-danger focus:border-danger focus:ring-danger/25"
                                      : "border-success focus:border-success focus:ring-success/25"
                                  }`}
                                />
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={current || Boolean(unmountingMountId)}
                                aria-label={
                                  current
                                    ? workspaceCopy.mountSwitcherDialog.currentAria(mount.rootName)
                                    : workspaceCopy.mountSwitcherDialog.choose(mount.rootName)
                                }
                                onClick={() => chooseMount(mount.mountId)}
                                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-100"
                              >
                                {current ? (
                                  <span className="flex h-8 w-8 shrink-0 items-center justify-center text-foreground">
                                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                                  </span>
                                ) : (
                                  <span className="h-8 w-8 shrink-0" aria-hidden="true" />
                                )}
                                <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-foreground">
                                  {mount.rootName}
                                </span>
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={editingMountId === mount.mountId && aliasInvalid}
                              onClick={() =>
                                setEditingMountId((currentId) =>
                                  currentId === mount.mountId ? "" : mount.mountId,
                                )
                              }
                              aria-label={
                                editingMountId === mount.mountId
                                  ? workspaceCopy.mountSwitcherDialog.finishRename(mount.rootName)
                                  : workspaceCopy.mountSwitcherDialog.renameAlias(mount.rootName)
                              }
                              className={`flex h-8 w-8 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45`}
                            >
                              {editingMountId === mount.mountId ? (
                                <Check className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <Pencil className="h-4 w-4" aria-hidden="true" />
                              )}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setDraftMounts((currentMounts) => {
                                const nextMounts = currentMounts.filter(
                                  (item) => item.mountId !== mount.mountId,
                                );
                                if (draftActiveMountId === mount.mountId) {
                                  setDraftActiveMountId(nextMounts[0]?.mountId || "");
                                }
                                return nextMounts;
                              })
                            }
                            disabled={Boolean(unmountingMountId)}
                            title={workspaceCopy.unmount}
                            aria-label={workspaceCopy.unmountFor(mount.rootName)}
                            className={`flex h-9 w-9 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-muted-foreground transition-colors hover:bg-danger-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-45`}
                          >
                            <Trash2
                              className={`h-4 w-4 ${removing ? "opacity-50" : ""}`}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {workspaceCopy.mountSwitcherDialog.empty}
                  </div>
                )}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
                <button
                  type="button"
                  onClick={() =>
                    void onMount().then((mount) => {
                      if (!mount) return;
                      setDraftMounts((current) => [...current, mount]);
                      setDraftAddedMountIds((current) => new Set(current).add(mount.mountId));
                      setDraftActiveMountId(mount.mountId);
                    })
                  }
                  disabled={Boolean(mountDisabledReason) || mounting || savingConfiguration}
                  title={mountDisabledReason || workspaceCopy.mountSwitcherDialog.addDirectory}
                  className={`inline-flex h-9 items-center ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-border bg-secondary px-3 text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  {workspaceCopy.mountSwitcherDialog.addDirectory}
                </button>
                <button
                  type="button"
                  disabled={!draftNamesValid || mounting || savingConfiguration}
                  onClick={() => {
                    setSavingConfiguration(true);
                    void onSave(draftMounts, draftActiveMountId)
                      .then(() => {
                        setDraftAddedMountIds(new Set());
                        setSwitcherOpen(false);
                      })
                      .catch(() => undefined)
                      .finally(() => setSavingConfiguration(false));
                  }}
                  className={`inline-flex h-9 items-center ${WORKSPACE_CONTROL_RADIUS_CLASS} bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  {savingConfiguration
                    ? workspaceCopy.mountSwitcherDialog.saving
                    : workspaceCopy.mountSwitcherDialog.save}
                </button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      {pendingUnmount && (
        <MountUnmountConfirmDialog
          targetName={pendingUnmount.rootName}
          onCancel={() => setPendingUnmount(null)}
          onConfirm={() => {
            const mountId = pendingUnmount.mountId;
            setPendingUnmount(null);
            void onUnmount(mountId);
          }}
        />
      )}
    </div>
  );
}

function AgentSpaceTree({
  cwd,
  tree,
  loading,
  error,
  rootOpen,
  openDirs,
  selectedEntryPath,
  selectedEntryPaths,
  selectionSegments,
  workspaceDrag,
  movePending,
  workspaceClipboard,
  canTransferToUser,
  onToggleRoot,
  onEntryClick,
  onOpenAsText,
  onShowDetails,
  onTransferToUser,
  onDeleteEntry,
  onCutEntry,
  onPasteEntry,
  onRootDragOver,
  onEntryDragStart,
  onEntryDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onRetry,
}: {
  cwd: string;
  tree: TreeNode[];
  loading: boolean;
  error: string;
  rootOpen: boolean;
  openDirs: Set<string>;
  selectedEntryPath: string;
  selectedEntryPaths: Set<string>;
  selectionSegments: Map<string, SelectionSegment>;
  workspaceDrag: WorkspaceDragState | null;
  movePending: boolean;
  workspaceClipboard: TreeNode[] | null;
  canTransferToUser: boolean;
  onToggleRoot: () => void;
  onEntryClick: (node: TreeNode, event: WorkspaceEntryClickEvent) => void;
  onOpenAsText: (node: TreeNode) => void;
  onShowDetails: (node: TreeNode) => void | Promise<void>;
  onTransferToUser: (node: TreeNode) => void | Promise<void>;
  onDeleteEntry: (node: TreeNode) => void;
  onCutEntry: (node: TreeNode) => void;
  onPasteEntry: (targetDirPath: string) => void | Promise<void>;
  onRootDragOver: (event: WorkspaceDragEvent) => void;
  onEntryDragStart: (node: TreeNode, event: WorkspaceDragEvent) => void;
  onEntryDragOver: (node: TreeNode, event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
  onRetry: () => void;
}) {
  const rootName = "workspace";
  const rootDropTarget = workspaceDrag?.target?.surfaceKey === "agent-root";
  const canPasteRoot = agentClipboardCanPasteAt(workspaceClipboard, ROOT_PATH);
  const rootRow = (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={rootOpen}
      data-testid="agent-space-root"
      data-agent-path=""
      data-agent-kind="directory"
      data-piwork-workspace-drop-surface
      data-drop-target={
        rootDropTarget && workspaceDrag?.target?.validation.valid ? "true" : undefined
      }
      className={`group/workspace mx-1 flex h-8 items-center gap-1 rounded-[var(--piwork-control-radius)] pl-0.5 pr-1 text-xs text-foreground transition-colors duration-150 ${
        rootDropTarget && workspaceDrag?.target?.validation.valid
          ? "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary"
          : workspaceDrag
            ? ""
            : "hover:bg-accent"
      }`}
      onDragOver={onRootDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        onClick={onToggleRoot}
        onKeyDown={(event) => {
          if (event.key.toLowerCase() !== "v" || (!event.metaKey && !event.ctrlKey)) return;
          event.preventDefault();
          event.stopPropagation();
          if (canPasteRoot && !movePending) void onPasteEntry(ROOT_PATH);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2 pr-8 text-left"
        aria-label={workspaceCopy.toggleDirectory(rootOpen, rootName)}
        aria-expanded={rootOpen}
        title={cwd || rootName}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-disabled-foreground">
          {rootOpen ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">{rootName}</span>
      </button>
    </div>
  );
  return (
    <div
      className="pb-1"
      role="tree"
      aria-multiselectable="true"
      aria-label={workspaceCopy.workspaceTree}
      data-testid="agent-space-tree"
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{rootRow}</ContextMenu.Trigger>
        <WorkspaceContextMenuContent>
          <WorkspaceContextMenuItem
            icon={Clipboard}
            disabled={!canPasteRoot || movePending}
            onSelect={() => void onPasteEntry(ROOT_PATH)}
          >
            {workspaceCopy.contextMenu.pasteHere}
          </WorkspaceContextMenuItem>
        </WorkspaceContextMenuContent>
      </ContextMenu.Root>
      {rootOpen && (
        <div role="group">
          {loading ? (
            <AgentSpaceStatusRow depth={1} status="loading" />
          ) : error ? (
            <AgentSpaceStatusRow depth={1} status="error" error={error} onRetry={onRetry} />
          ) : (
            tree.map((node) => (
              <AgentSpaceTreeNode
                key={node.path || node.name}
                node={node}
                depth={1}
                openDirs={openDirs}
                selectedEntryPath={selectedEntryPath}
                selectedEntryPaths={selectedEntryPaths}
                selectionSegments={selectionSegments}
                workspaceDrag={workspaceDrag}
                movePending={movePending}
                workspaceClipboard={workspaceClipboard}
                canTransferToUser={canTransferToUser}
                onEntryClick={onEntryClick}
                onOpenAsText={onOpenAsText}
                onShowDetails={onShowDetails}
                onTransferToUser={onTransferToUser}
                onDeleteEntry={onDeleteEntry}
                onCutEntry={onCutEntry}
                onPasteEntry={onPasteEntry}
                onEntryDragStart={onEntryDragStart}
                onEntryDragOver={onEntryDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AgentSpaceTreeNode({
  node,
  depth,
  openDirs,
  selectedEntryPath,
  selectedEntryPaths,
  selectionSegments,
  workspaceDrag,
  movePending,
  workspaceClipboard,
  canTransferToUser,
  onEntryClick,
  onOpenAsText,
  onShowDetails,
  onTransferToUser,
  onDeleteEntry,
  onCutEntry,
  onPasteEntry,
  onEntryDragStart,
  onEntryDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  node: TreeNode;
  depth: number;
  openDirs: Set<string>;
  selectedEntryPath: string;
  selectedEntryPaths: Set<string>;
  selectionSegments: Map<string, SelectionSegment>;
  workspaceDrag: WorkspaceDragState | null;
  movePending: boolean;
  workspaceClipboard: TreeNode[] | null;
  canTransferToUser: boolean;
  onEntryClick: (node: TreeNode, event: WorkspaceEntryClickEvent) => void;
  onOpenAsText: (node: TreeNode) => void;
  onShowDetails: (node: TreeNode) => void | Promise<void>;
  onTransferToUser: (node: TreeNode) => void | Promise<void>;
  onDeleteEntry: (node: TreeNode) => void;
  onCutEntry: (node: TreeNode) => void;
  onPasteEntry: (targetDirPath: string) => void | Promise<void>;
  onEntryDragStart: (node: TreeNode, event: WorkspaceDragEvent) => void;
  onEntryDragOver: (node: TreeNode, event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
}) {
  const isDirectory = node.type === "directory";
  const nodePath = agentNodePath(node);
  const isOpen = isDirectory && openDirs.has(nodePath);
  const focused = selectedEntryPath === nodePath;
  const selected = selectedEntryPaths.has(nodePath);
  const dropTarget = workspaceDrag?.target?.surfaceKey === `agent:${nodePath}`;
  const dragged =
    workspaceDrag?.source.space === "agent" &&
    workspaceDrag.source.entries.some((entry) => {
      const sourcePath = agentNodePath(entry);
      return (
        sourcePath === nodePath ||
        (entry.type === "directory" && nodePath.startsWith(`${sourcePath}/`))
      );
    });
  const cut =
    workspaceClipboard?.some((entry) => {
      const sourcePath = agentNodePath(entry);
      return (
        sourcePath === nodePath ||
        (entry.type === "directory" && nodePath.startsWith(`${sourcePath}/`))
      );
    }) ?? false;
  const canPaste = isDirectory && agentClipboardCanPasteAt(workspaceClipboard, nodePath);
  const selectionSegment = selectionSegments.get(nodePath);
  const leftOffset = depth * TREE_INDENT_PX;
  const contentInset = leftOffset + TREE_CONTENT_GAP_PX + TREE_ROW_CONTENT_SAFE_INSET_PX;
  const Icon = isDirectory
    ? isOpen
      ? FolderOpen
      : Folder
    : iconForWorkspaceEntry({
        name: node.name,
        path: nodePath,
        kind: "file",
        size: node.size,
        previewKind: previewKindForWorkspacePath(nodePath),
      });
  const children = node.children || [];
  const row = (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDirectory ? isOpen : undefined}
      aria-selected={selected}
      data-focused={focused ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-piwork-workspace-drop-surface
      data-dragging={dragged ? "true" : undefined}
      data-drop-target={dropTarget && workspaceDrag?.target?.validation.valid ? "true" : undefined}
      data-drop-operation={dropTarget ? workspaceDrag?.target?.operation : undefined}
      data-selection-segment={selected ? selectionSegmentName(selectionSegment) : undefined}
      data-testid={`agent-space-entry-${nodePath}`}
      data-agent-path={nodePath}
      data-agent-kind={node.type}
      draggable={!movePending}
      onDragStart={(event) => onEntryDragStart(node, event)}
      onDragOver={(event) => onEntryDragOver(node, event)}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
      onDragEnd={onDragEnd}
      className={`group/row relative h-8 rounded-[var(--piwork-control-radius)] transition-[opacity,color] duration-150 ${
        selected ? "text-foreground" : WORKSPACE_SELECTABLE_TEXT_CLASS
      } ${dragged || cut ? "opacity-55" : "opacity-100"}`}
    >
      <div
        className={`piwork-selection-surface pointer-events-none absolute inset-y-0 left-1 right-1 rounded-[var(--piwork-control-radius)] ${
          dropTarget && workspaceDrag?.target?.validation.valid
            ? "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary"
            : selected
              ? "bg-[var(--piwork-list-selected)]"
              : workspaceDrag
                ? ""
                : "group-hover/row:bg-[var(--piwork-list-hover)]"
        }`}
        style={
          selected && !(dropTarget && workspaceDrag?.target?.validation.valid)
            ? selectedRowBackgroundRadiusStyle(selectionSegment)
            : { borderRadius: WORKSPACE_TREE_SINGLE_ROW_RADIUS }
        }
        aria-hidden="true"
      />
      <TreeIndentGuides depth={depth} />
      <div
        className="relative z-10 flex h-8 items-center gap-1.5 px-2 text-left text-xs"
        style={{ paddingLeft: `${contentInset}px` }}
      >
        {isDirectory ? (
          <button
            type="button"
            onClick={(event) => onEntryClick(node, event)}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-8 text-left"
            title={nodePath}
            aria-label={workspaceCopy.toggleDirectory(isOpen, node.name)}
          >
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-disabled-foreground">
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </span>
            <Icon className="h-4 w-4 shrink-0 text-disabled-foreground" aria-hidden={true} />
            <span className="min-w-0 flex-1 truncate text-sm leading-5">{node.name}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={(event) => onEntryClick(node, event)}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-8 text-left"
            title={nodePath}
            aria-label={workspaceCopy.previewEntry(node.name)}
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center">
              <Icon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm leading-5"
              style={{ marginLeft: `${TREE_FILE_TEXT_ADJUST_PX}px` }}
            >
              {node.name}
            </span>
          </button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
        <WorkspaceContextMenuContent>
          <WorkspaceContextMenuItem icon={Info} onSelect={() => void onShowDetails(node)}>
            {workspaceCopy.contextMenu.details}
          </WorkspaceContextMenuItem>
          {!isDirectory && isHtmlPath(nodePath) && (
            <WorkspaceContextMenuItem icon={FileText} onSelect={() => onOpenAsText(node)}>
              {workspaceCopy.contextMenu.openAsText}
            </WorkspaceContextMenuItem>
          )}
          <WorkspaceContextMenuItem
            icon={ArrowRightLeft}
            disabled={!canTransferToUser || movePending}
            onSelect={() => void onTransferToUser(node)}
          >
            {workspaceCopy.contextMenu.transferToUser}
          </WorkspaceContextMenuItem>
          {isDirectory && (
            <WorkspaceContextMenuItem
              icon={Clipboard}
              disabled={!canPaste || movePending}
              onSelect={() => void onPasteEntry(nodePath)}
            >
              {workspaceCopy.contextMenu.pasteHere}
            </WorkspaceContextMenuItem>
          )}
          <WorkspaceContextMenuItem
            icon={Scissors}
            disabled={movePending}
            onSelect={() => onCutEntry(node)}
          >
            {workspaceCopy.contextMenu.cut}
          </WorkspaceContextMenuItem>
          <WorkspaceContextMenuSeparator />
          <WorkspaceContextMenuItem
            icon={Trash2}
            variant="danger"
            disabled={movePending}
            onSelect={() => onDeleteEntry(node)}
          >
            {node.type === "directory"
              ? workspaceCopy.contextMenu.deleteFolder
              : workspaceCopy.contextMenu.delete}
          </WorkspaceContextMenuItem>
        </WorkspaceContextMenuContent>
      </ContextMenu.Root>
      {isDirectory && isOpen && (
        <div role="group">
          {children.map((child) => (
            <AgentSpaceTreeNode
              key={child.path || `${node.path}/${child.name}`}
              node={child}
              depth={depth + 1}
              openDirs={openDirs}
              selectedEntryPath={selectedEntryPath}
              selectedEntryPaths={selectedEntryPaths}
              selectionSegments={selectionSegments}
              workspaceDrag={workspaceDrag}
              movePending={movePending}
              workspaceClipboard={workspaceClipboard}
              canTransferToUser={canTransferToUser}
              onEntryClick={onEntryClick}
              onOpenAsText={onOpenAsText}
              onShowDetails={onShowDetails}
              onTransferToUser={onTransferToUser}
              onDeleteEntry={onDeleteEntry}
              onCutEntry={onCutEntry}
              onPasteEntry={onPasteEntry}
              onEntryDragStart={onEntryDragStart}
              onEntryDragOver={onEntryDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </>
  );
}

function AgentSpaceStatusRow({
  depth,
  status,
  error,
  onRetry,
}: {
  depth: number;
  status: "loading" | "empty" | "error";
  error?: string;
  onRetry?: () => void;
}) {
  const leftOffset = depth * TREE_INDENT_PX;
  if (status === "loading") {
    return (
      <div
        role="treeitem"
        aria-level={depth + 1}
        className="flex h-8 items-center px-2 text-xs text-disabled-foreground"
        style={{ marginLeft: `${leftOffset}px` }}
      >
        {workspaceCopy.directoryLoading}
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div
        role="treeitem"
        aria-level={depth + 1}
        className="flex h-8 items-center px-2 text-xs text-disabled-foreground"
        style={{ marginLeft: `${leftOffset}px` }}
      >
        {workspaceCopy.directoryEmpty}
      </div>
    );
  }
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      className={`flex h-8 min-w-0 items-center gap-2 ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-danger/35 bg-danger-muted px-2 text-xs text-danger`}
      style={{ marginLeft: `${leftOffset}px`, width: `calc(100% - ${leftOffset + 4}px)` }}
    >
      <span className="min-w-0 flex-1 truncate">{error || workspaceCopy.directoryLoadFailed}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 text-danger underline">
          {uiCopy.common.retry}
        </button>
      )}
    </div>
  );
}

function WorkspaceBlankAreaContextMenu({
  mountId,
  canUseMenu,
  canPaste,
  workspaceDrag,
  onClearSelection,
  onOpenWterm,
  onCreateEntry,
  onPasteEntry,
  onRootDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  mountId: string;
  canUseMenu: boolean;
  canPaste: boolean;
  workspaceDrag: WorkspaceDragState | null;
  onClearSelection: () => void;
  onOpenWterm: () => void;
  onCreateEntry: (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => void;
  onPasteEntry: (mountId: string, targetDirPath: string) => void | Promise<void>;
  onRootDragOver: (event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
}) {
  const rootDropTarget = workspaceDrag?.target?.surfaceKey === `user-root:${mountId}`;
  const blankArea = (
    <div
      className={`relative min-h-10 flex-1 transition-colors duration-150 ${
        rootDropTarget && workspaceDrag?.target?.validation.valid
          ? "bg-primary/8 outline outline-1 -outline-offset-1 outline-primary"
          : ""
      }`}
      data-testid="user-space-tree-blank-area"
      data-piwork-workspace-drop-surface
      data-drop-target={
        rootDropTarget && workspaceDrag?.target?.validation.valid ? "true" : undefined
      }
      role="presentation"
      onClick={onClearSelection}
      onContextMenu={onClearSelection}
      onDragOver={onRootDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
      onDragEnd={onDragEnd}
    />
  );
  if (!mountId || !canUseMenu) return blankArea;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{blankArea}</ContextMenu.Trigger>
      <WorkspaceContextMenuContent>
        <WorkspaceNewFileSubmenu onCreateFile={(kind) => onCreateEntry(mountId, ROOT_PATH, kind)} />
        <WorkspaceContextMenuItem
          icon={FolderPlus}
          onSelect={() => onCreateEntry(mountId, ROOT_PATH, "directory")}
        >
          {workspaceCopy.contextMenu.newFolder}
        </WorkspaceContextMenuItem>
        <WorkspaceContextMenuItem
          icon={Clipboard}
          disabled={!canPaste}
          onSelect={() => void onPasteEntry(mountId, ROOT_PATH)}
        >
          {workspaceCopy.contextMenu.pasteHere}
        </WorkspaceContextMenuItem>
        <WorkspaceContextMenuSeparator />
        <WorkspaceContextMenuItem icon={SquareTerminal} onSelect={onOpenWterm}>
          {workspaceCopy.wterm.open}
        </WorkspaceContextMenuItem>
      </WorkspaceContextMenuContent>
    </ContextMenu.Root>
  );
}

function VirtualWorkspaceTree({
  treeItems,
  virtualizer,
  activeMountIdForOps,
  accessChanging,
  metadataSyncingMountId,
  unmountingMountId,
  selectedEntryKey,
  selectedEntryKeys,
  selectionSegments,
  pendingRenameEntryKey,
  openDirs,
  workspaceDrag,
  canMoveEntries,
  movePending,
  onToggleRoot,
  onSearch,
  onAccessChange,
  onMetadataSync,
  onUnmount,
  onEntryClick,
  onOpenAsText,
  onOpen,
  onOpenAndPin,
  onOpenInNewWindow,
  onAddFileReference,
  workspaceClipboard,
  onCreateEntry,
  onRenameEntry,
  onPendingRenameConsumed,
  onShowDetails,
  onCopyEntry,
  onCutEntry,
  onPasteEntry,
  onDuplicateEntry,
  onDeleteEntry,
  onTransferToAgent,
  onEntryDragStart,
  onEntryDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onLoadMore,
  onRetry,
}: {
  treeItems: ItemInstance<WorkspaceTreeItemData>[];
  virtualizer: ReactVirtualizer<HTMLDivElement, HTMLDivElement>;
  activeMountIdForOps: string;
  accessChanging: boolean;
  metadataSyncingMountId: string;
  unmountingMountId: string;
  selectedEntryKey: string;
  selectedEntryKeys: Set<string>;
  selectionSegments: Map<string, SelectionSegment>;
  pendingRenameEntryKey: string;
  openDirs: Set<string>;
  workspaceDrag: WorkspaceDragState | null;
  canMoveEntries: boolean;
  movePending: boolean;
  onToggleRoot: (mountId: string) => void | Promise<void>;
  onSearch: (mountId: string) => void;
  onAccessChange: (mountId: string, access: UserSpaceAccess) => void | Promise<void>;
  onMetadataSync: (mountId: string) => void | Promise<void>;
  onUnmount: (mountId: string) => void | Promise<void>;
  onEntryClick: (mountId: string, entry: WorkspaceEntry, event: WorkspaceEntryClickEvent) => void;
  onOpenAsText: (mountId: string, entry: WorkspaceEntry) => void;
  onOpen: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenAndPin: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenInNewWindow: (mountId: string, entry: WorkspaceEntry) => void;
  onAddFileReference: (mountId: string, entry: WorkspaceEntry) => void;
  workspaceClipboard: WorkspaceClipboard | null;
  onCreateEntry: (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => void;
  onRenameEntry: (mountId: string, entry: WorkspaceEntry, name: string) => Promise<boolean>;
  onPendingRenameConsumed: () => void;
  onShowDetails: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onCopyEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onCutEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onPasteEntry: (mountId: string, targetDirPath: string) => void | Promise<void>;
  onDuplicateEntry: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onDeleteEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onTransferToAgent: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onEntryDragStart: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onEntryDragOver: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
  onLoadMore: (mountId: string, path: string) => void;
  onRetry: (mountId: string, path: string) => void;
}) {
  const virtualItems = virtualizer.getVirtualItems();
  const rows =
    virtualItems.length > 0
      ? virtualItems.map((virtualItem) => ({
          index: virtualItem.index,
          key: virtualItem.key,
          start: virtualItem.start,
        }))
      : treeItems.slice(0, TREE_VIRTUAL_UNMEASURED_FALLBACK_ROWS).map((item, index) => ({
          index,
          key: item.getKey(),
          start: index * TREE_ROW_PITCH_PX,
        }));
  const measuredTotalSize = virtualizer.getTotalSize();
  const totalSize =
    measuredTotalSize > 0 ? measuredTotalSize : treeItems.length * TREE_ROW_PITCH_PX;

  return (
    <div
      ref={virtualizer.containerRef}
      className="relative w-full pb-1"
      style={{ height: `${Math.max(0, totalSize)}px` }}
    >
      {rows.map((row) => {
        const item = treeItems[row.index];
        if (!item) return null;
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            data-testid="user-space-virtual-tree-row"
            className="absolute left-0 top-0 w-full"
            style={{
              contain: "layout style paint",
              height: `${TREE_ROW_PITCH_PX}px`,
              transform: `translate3d(0, ${row.start}px, 0)`,
            }}
          >
            <VirtualWorkspaceTreeRow
              item={item}
              activeMountIdForOps={activeMountIdForOps}
              accessChanging={accessChanging}
              metadataSyncingMountId={metadataSyncingMountId}
              unmountingMountId={unmountingMountId}
              selectedEntryKey={selectedEntryKey}
              selectedEntryKeys={selectedEntryKeys}
              selectionSegments={selectionSegments}
              pendingRenameEntryKey={pendingRenameEntryKey}
              openDirs={openDirs}
              workspaceDrag={workspaceDrag}
              canMoveEntries={canMoveEntries}
              movePending={movePending}
              onToggleRoot={onToggleRoot}
              onSearch={onSearch}
              onAccessChange={onAccessChange}
              onMetadataSync={onMetadataSync}
              onUnmount={onUnmount}
              onEntryClick={onEntryClick}
              onOpenAsText={onOpenAsText}
              onOpen={onOpen}
              onOpenAndPin={onOpenAndPin}
              onOpenInNewWindow={onOpenInNewWindow}
              onAddFileReference={onAddFileReference}
              workspaceClipboard={workspaceClipboard}
              onCreateEntry={onCreateEntry}
              onRenameEntry={onRenameEntry}
              onPendingRenameConsumed={onPendingRenameConsumed}
              onShowDetails={onShowDetails}
              onCopyEntry={onCopyEntry}
              onCutEntry={onCutEntry}
              onPasteEntry={onPasteEntry}
              onDuplicateEntry={onDuplicateEntry}
              onDeleteEntry={onDeleteEntry}
              onTransferToAgent={onTransferToAgent}
              onEntryDragStart={onEntryDragStart}
              onEntryDragOver={onEntryDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
              onLoadMore={onLoadMore}
              onRetry={onRetry}
            />
          </div>
        );
      })}
    </div>
  );
}

function VirtualWorkspaceTreeRow({
  item,
  activeMountIdForOps,
  accessChanging,
  metadataSyncingMountId,
  unmountingMountId,
  selectedEntryKey,
  selectedEntryKeys,
  selectionSegments,
  pendingRenameEntryKey,
  openDirs,
  workspaceDrag,
  canMoveEntries,
  movePending,
  onToggleRoot,
  onSearch,
  onAccessChange,
  onMetadataSync,
  onUnmount,
  onEntryClick,
  onOpenAsText,
  onOpen,
  onOpenAndPin,
  onOpenInNewWindow,
  onAddFileReference,
  workspaceClipboard,
  onCreateEntry,
  onRenameEntry,
  onPendingRenameConsumed,
  onShowDetails,
  onCopyEntry,
  onCutEntry,
  onPasteEntry,
  onDuplicateEntry,
  onDeleteEntry,
  onTransferToAgent,
  onEntryDragStart,
  onEntryDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onLoadMore,
  onRetry,
}: {
  item: ItemInstance<WorkspaceTreeItemData>;
  activeMountIdForOps: string;
  accessChanging: boolean;
  metadataSyncingMountId: string;
  unmountingMountId: string;
  selectedEntryKey: string;
  selectedEntryKeys: Set<string>;
  selectionSegments: Map<string, SelectionSegment>;
  pendingRenameEntryKey: string;
  openDirs: Set<string>;
  workspaceDrag: WorkspaceDragState | null;
  canMoveEntries: boolean;
  movePending: boolean;
  onToggleRoot: (mountId: string) => void | Promise<void>;
  onSearch: (mountId: string) => void;
  onAccessChange: (mountId: string, access: UserSpaceAccess) => void | Promise<void>;
  onMetadataSync: (mountId: string) => void | Promise<void>;
  onUnmount: (mountId: string) => void | Promise<void>;
  onEntryClick: (mountId: string, entry: WorkspaceEntry, event: WorkspaceEntryClickEvent) => void;
  onOpenAsText: (mountId: string, entry: WorkspaceEntry) => void;
  onOpen: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenAndPin: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenInNewWindow: (mountId: string, entry: WorkspaceEntry) => void;
  onAddFileReference: (mountId: string, entry: WorkspaceEntry) => void;
  workspaceClipboard: WorkspaceClipboard | null;
  onCreateEntry: (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => void;
  onRenameEntry: (mountId: string, entry: WorkspaceEntry, name: string) => Promise<boolean>;
  onPendingRenameConsumed: () => void;
  onShowDetails: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onCopyEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onCutEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onPasteEntry: (mountId: string, targetDirPath: string) => void | Promise<void>;
  onDuplicateEntry: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onDeleteEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onTransferToAgent: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onEntryDragStart: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onEntryDragOver: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
  onLoadMore: (mountId: string, path: string) => void;
  onRetry: (mountId: string, path: string) => void;
}) {
  const data = item.getItemData();
  if (data.kind === "mount") {
    return (
      <VirtualWorkspaceMountRow
        item={item}
        data={data}
        activeMountIdForOps={activeMountIdForOps}
        accessChanging={accessChanging}
        metadataSyncingMountId={metadataSyncingMountId}
        unmountingMountId={unmountingMountId}
        canMoveEntries={canMoveEntries}
        movePending={movePending}
        onToggleRoot={onToggleRoot}
        onSearch={onSearch}
        onAccessChange={onAccessChange}
        onMetadataSync={onMetadataSync}
        onUnmount={onUnmount}
        workspaceClipboard={workspaceClipboard}
        onCreateEntry={onCreateEntry}
        onPasteEntry={onPasteEntry}
      />
    );
  }
  if (data.kind === "entry") {
    return (
      <VirtualWorkspaceEntryRow
        item={item}
        data={data}
        selectedEntryKey={selectedEntryKey}
        selectedEntryKeys={selectedEntryKeys}
        selectionSegments={selectionSegments}
        pendingRenameEntryKey={pendingRenameEntryKey}
        openDirs={openDirs}
        workspaceDrag={workspaceDrag}
        canMoveEntries={canMoveEntries}
        movePending={movePending}
        onEntryClick={onEntryClick}
        onOpenAsText={onOpenAsText}
        onOpen={onOpen}
        onOpenAndPin={onOpenAndPin}
        onOpenInNewWindow={onOpenInNewWindow}
        onAddFileReference={onAddFileReference}
        workspaceClipboard={workspaceClipboard}
        onCreateEntry={onCreateEntry}
        onRenameEntry={onRenameEntry}
        onPendingRenameConsumed={onPendingRenameConsumed}
        onShowDetails={onShowDetails}
        onCopyEntry={onCopyEntry}
        onCutEntry={onCutEntry}
        onPasteEntry={onPasteEntry}
        onDuplicateEntry={onDuplicateEntry}
        onDeleteEntry={onDeleteEntry}
        onTransferToAgent={onTransferToAgent}
        onEntryDragStart={onEntryDragStart}
        onEntryDragOver={onEntryDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      />
    );
  }
  if (data.kind === "status") {
    return (
      <VirtualWorkspaceStatusRow
        item={item}
        data={data}
        onLoadMore={onLoadMore}
        onRetry={onRetry}
      />
    );
  }
  return null;
}

function VirtualWorkspaceMountRow({
  item,
  data,
  activeMountIdForOps,
  accessChanging,
  metadataSyncingMountId,
  unmountingMountId,
  canMoveEntries,
  movePending,
  onToggleRoot,
  onSearch,
  onAccessChange,
  onMetadataSync,
  onUnmount,
  workspaceClipboard,
  onCreateEntry,
  onPasteEntry,
}: {
  item: ItemInstance<WorkspaceTreeItemData>;
  data: Extract<WorkspaceTreeItemData, { kind: "mount" }>;
  activeMountIdForOps: string;
  accessChanging: boolean;
  metadataSyncingMountId: string;
  unmountingMountId: string;
  canMoveEntries: boolean;
  movePending: boolean;
  onToggleRoot: (mountId: string) => void | Promise<void>;
  onSearch: (mountId: string) => void;
  onAccessChange: (mountId: string, access: UserSpaceAccess) => void | Promise<void>;
  onMetadataSync: (mountId: string) => void | Promise<void>;
  onUnmount: (mountId: string) => void | Promise<void>;
  workspaceClipboard: WorkspaceClipboard | null;
  onCreateEntry: (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => void;
  onPasteEntry: (mountId: string, targetDirPath: string) => void | Promise<void>;
}) {
  const mount = data.mount;
  const itemProps = treeItemA11yProps(item, data.isActive);
  const nextAccess = mount.access === "readonly" ? "readwrite" : "readonly";
  const AccessIcon = mount.access === "readonly" ? Lock : Unlock;
  const syncing = metadataSyncingMountId === mount.mountId;
  const unmounting = unmountingMountId === mount.mountId;
  const canPaste =
    canMoveEntries &&
    !movePending &&
    workspaceClipboardCanPasteAt(workspaceClipboard, mount.mountId, ROOT_PATH);
  const row = (
    <div
      {...itemProps.props}
      ref={itemProps.ref}
      data-testid={`user-space-root-${mount.mountId}`}
      className="group/workspace mx-1 flex h-8 items-center gap-1 rounded-[var(--piwork-control-radius)] pl-0.5 pr-1 text-xs text-foreground transition-colors hover:bg-accent"
    >
      <button
        type="button"
        onClick={() => void onToggleRoot(mount.mountId)}
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2 pr-8 text-left"
        aria-label={workspaceCopy.toggleMount(data.isExpanded, mount.rootName)}
        aria-expanded={data.isExpanded}
        aria-pressed={mount.mountId === activeMountIdForOps}
        title={mount.rootName}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-disabled-foreground">
          {data.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5">
          {mount.rootName}
        </span>
      </button>
      <div className="hidden shrink-0 items-center gap-1 group-focus-within/workspace:flex group-hover/workspace:flex">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSearch(mount.mountId);
          }}
          disabled={!data.isMounted}
          title={workspaceCopy.searchDialog.buttonTitle}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
          aria-label={workspaceCopy.searchDialog.openFor(mount.rootName)}
        >
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onAccessChange(mount.mountId, nextAccess);
          }}
          disabled={accessChanging || !data.isMounted}
          title={workspaceCopy.accessToggleTitle(mount.access)}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
          aria-label={workspaceCopy.setAccess(mount.rootName, nextAccess)}
        >
          <AccessIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onMetadataSync(mount.mountId);
          }}
          disabled={!data.isMounted || Boolean(metadataSyncingMountId)}
          title={workspaceCopy.syncIndex}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45`}
          aria-label={workspaceCopy.syncIndexFor(mount.rootName)}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onUnmount(mount.mountId);
          }}
          disabled={Boolean(unmountingMountId)}
          title={workspaceCopy.unmount}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent hover:text-danger disabled:cursor-not-allowed disabled:opacity-45`}
          aria-label={workspaceCopy.unmountFor(mount.rootName)}
        >
          <X className={`h-3.5 w-3.5 ${unmounting ? "opacity-50" : ""}`} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <WorkspaceContextMenuContent>
        <WorkspaceNewFileSubmenu
          onCreateFile={(kind) => onCreateEntry(mount.mountId, ROOT_PATH, kind)}
        />
        <WorkspaceContextMenuItem
          icon={FolderPlus}
          onSelect={() => onCreateEntry(mount.mountId, ROOT_PATH, "directory")}
        >
          {workspaceCopy.contextMenu.newFolder}
        </WorkspaceContextMenuItem>
        <WorkspaceContextMenuItem
          icon={Clipboard}
          disabled={!canPaste}
          onSelect={() => void onPasteEntry(mount.mountId, ROOT_PATH)}
        >
          {workspaceCopy.contextMenu.pasteHere}
        </WorkspaceContextMenuItem>
      </WorkspaceContextMenuContent>
    </ContextMenu.Root>
  );
}

function VirtualWorkspaceEntryRow({
  item,
  data,
  selectedEntryKey,
  selectedEntryKeys,
  selectionSegments,
  pendingRenameEntryKey,
  openDirs,
  onEntryClick,
  onOpenAsText,
  onOpen,
  onOpenAndPin,
  onOpenInNewWindow,
  onAddFileReference,
  workspaceClipboard,
  onCreateEntry,
  onRenameEntry,
  onPendingRenameConsumed,
  onShowDetails,
  onCopyEntry,
  onPasteEntry,
  onDuplicateEntry,
  onDeleteEntry,
  onTransferToAgent,
  workspaceDrag,
  canMoveEntries,
  movePending,
  onCutEntry,
  onEntryDragStart,
  onEntryDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  item: ItemInstance<WorkspaceTreeItemData>;
  data: Extract<WorkspaceTreeItemData, { kind: "entry" }>;
  selectedEntryKey: string;
  selectedEntryKeys: Set<string>;
  selectionSegments: Map<string, SelectionSegment>;
  pendingRenameEntryKey: string;
  openDirs: Set<string>;
  workspaceDrag: WorkspaceDragState | null;
  canMoveEntries: boolean;
  movePending: boolean;
  onEntryClick: (mountId: string, entry: WorkspaceEntry, event: WorkspaceEntryClickEvent) => void;
  onOpenAsText: (mountId: string, entry: WorkspaceEntry) => void;
  onOpen: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenAndPin: (mountId: string, entry: WorkspaceEntry) => void;
  onOpenInNewWindow: (mountId: string, entry: WorkspaceEntry) => void;
  onAddFileReference: (mountId: string, entry: WorkspaceEntry) => void;
  workspaceClipboard: WorkspaceClipboard | null;
  onCreateEntry: (mountId: string, parentPath: string, kind: WorkspaceCreateEntryKind) => void;
  onRenameEntry: (mountId: string, entry: WorkspaceEntry, name: string) => Promise<boolean>;
  onPendingRenameConsumed: () => void;
  onShowDetails: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onCopyEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onCutEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onPasteEntry: (mountId: string, targetDirPath: string) => void | Promise<void>;
  onDuplicateEntry: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onDeleteEntry: (mountId: string, entry: WorkspaceEntry) => void;
  onTransferToAgent: (mountId: string, entry: WorkspaceEntry) => void | Promise<void>;
  onEntryDragStart: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onEntryDragOver: (mountId: string, entry: WorkspaceEntry, event: WorkspaceDragEvent) => void;
  onDragLeave: (event: WorkspaceDragEvent) => void;
  onDrop: (event: WorkspaceDragEvent) => void | Promise<void>;
  onDragEnd: () => void;
}) {
  const entry = data.entry;
  const isDirectory = entry.kind === "directory";
  const canOpen = isDirectory || entry.kind === "file";
  const entryKey = treeDirKey(data.mountId, entry.path);
  const isOpen = openDirs.has(entryKey);
  const focused = selectedEntryKey === entryKey;
  const selected = selectedEntryKeys.has(entryKey);
  const dropTarget =
    workspaceDrag?.target?.surfaceKey === `user:${entryKey}` &&
    workspaceDrag.target.validation.valid;
  const dragged =
    workspaceDrag?.source.space === "user" &&
    workspaceDrag.source.entries.some(
      (item) =>
        item.mountId === data.mountId &&
        (item.entry.path === entry.path ||
          (item.entry.kind === "directory" && entry.path.startsWith(`${item.entry.path}/`))),
    );
  const cut =
    workspaceClipboard?.operation === "move" &&
    workspaceClipboard.mountId === data.mountId &&
    workspaceClipboard.entries.some(
      (item) =>
        item.path === entry.path ||
        (item.kind === "directory" && entry.path.startsWith(`${item.path}/`)),
    );
  const selectionSegment = selectionSegments.get(entryKey);
  const guideDepth = Math.max(0, workspacePathDepth(entry.path) - 1);
  const leftOffset = guideDepth * TREE_INDENT_PX;
  const contentInset = leftOffset + TREE_CONTENT_GAP_PX + TREE_ROW_CONTENT_SAFE_INSET_PX;
  const fileTextAdjustStyle = { marginLeft: `${TREE_FILE_TEXT_ADJUST_PX}px` };
  const Icon = isDirectory ? (isOpen ? FolderOpen : Folder) : iconForWorkspaceEntry(entry);
  const itemProps = treeItemA11yProps(item, selected);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const contextMenuUsesMultiSelection =
    selectedEntryKeys.size > 1 &&
    Array.from(selectedEntryKeys).some((key) =>
      workspaceSelectionKeyCoversPath(key, data.mountId, entry.path),
    );
  const showContextTargetOutline = contextMenuOpen && !contextMenuUsesMultiSelection;
  const canPaste =
    isDirectory &&
    canMoveEntries &&
    !movePending &&
    workspaceClipboardCanPasteAt(workspaceClipboard, data.mountId, entry.path);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(entry.name);
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [pendingExtensionRename, setPendingExtensionRename] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameCommittingRef = useRef(false);
  const renameCancelledRef = useRef(false);
  const renameConfirmationPendingRef = useRef(false);
  const renameNameParts = splitWorkspaceFileNameForRename(entry.name);
  const renameCandidate = renameDraft.trim();
  const renameValidation = validateWorkspaceEntryName(renameCandidate);
  const renameInputInvalid = Boolean(renameError || renameValidation);
  const renameInputAvailable = Boolean(renameCandidate) && !renameInputInvalid;

  useEffect(() => {
    if (!renaming) return;
    renameCancelledRef.current = false;
    const timer = window.setTimeout(() => {
      const input = renameInputRef.current;
      input?.focus();
      input?.setSelectionRange(0, renameNameParts.stem.length);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [renameNameParts.stem, renaming]);

  useEffect(() => {
    if (isDirectory || pendingRenameEntryKey !== entryKey) return;
    setRenameDraft(entry.name);
    setRenameError("");
    setRenaming(true);
    onPendingRenameConsumed();
  }, [entry.name, entryKey, isDirectory, onPendingRenameConsumed, pendingRenameEntryKey]);

  const cancelInlineRename = useCallback(() => {
    renameCancelledRef.current = true;
    renameConfirmationPendingRef.current = false;
    setPendingExtensionRename(null);
    setRenameDraft(entry.name);
    setRenameError("");
    setRenaming(false);
  }, [entry.name]);

  const performInlineRename = useCallback(
    async (nextName: string) => {
      if (renameCommittingRef.current) return;
      renameConfirmationPendingRef.current = false;
      setPendingExtensionRename(null);
      renameCommittingRef.current = true;
      setRenameSaving(true);
      setRenameError("");
      try {
        const ok = await onRenameEntry(data.mountId, entry, nextName);
        if (ok) {
          renameCancelledRef.current = true;
          setRenaming(false);
        }
      } finally {
        renameCommittingRef.current = false;
        setRenameSaving(false);
      }
    },
    [data.mountId, entry, onRenameEntry],
  );

  const commitInlineRename = useCallback(async () => {
    if (!renaming || renameCommittingRef.current || renameConfirmationPendingRef.current) return;
    const nextName = renameDraft.trim();
    const validation = validateWorkspaceEntryName(nextName);
    if (validation) {
      setRenameError(validation);
      return;
    }
    if (nextName === entry.name) {
      renameCancelledRef.current = true;
      setRenaming(false);
      return;
    }
    if (splitWorkspaceFileNameForRename(nextName).extension !== renameNameParts.extension) {
      renameConfirmationPendingRef.current = true;
      setPendingExtensionRename(nextName);
      return;
    }
    await performInlineRename(nextName);
  }, [entry.name, performInlineRename, renameDraft, renameNameParts.extension, renaming]);

  const cancelExtensionRename = useCallback(() => {
    renameConfirmationPendingRef.current = false;
    setPendingExtensionRename(null);
    const draftParts = splitWorkspaceFileNameForRename(renameDraft.trim());
    setRenameDraft(`${draftParts.stem}${renameNameParts.extension}`);
    window.setTimeout(() => {
      const input = renameInputRef.current;
      input?.focus();
      input?.setSelectionRange(0, input.value.length);
    }, 0);
  }, [renameDraft, renameNameParts.extension]);

  const startInlineRename = useCallback(() => {
    if (isDirectory) return;
    setRenameDraft(entry.name);
    setRenameError("");
    setRenaming(true);
  }, [entry.name, isDirectory]);

  const row = (
    <div
      {...itemProps.props}
      ref={itemProps.ref}
      draggable={canMoveEntries && !movePending && !renaming}
      onDragStart={(event) => onEntryDragStart(data.mountId, entry, event)}
      onDragOver={(event) => onEntryDragOver(data.mountId, entry, event)}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
      onDragEnd={onDragEnd}
      className={`group/row relative h-8 rounded-[var(--piwork-control-radius)] transition-[color,opacity] duration-150 ${
        selected ? "text-foreground" : WORKSPACE_SELECTABLE_TEXT_CLASS
      } ${dragged || cut ? "opacity-45" : ""}`}
      aria-selected={selected}
      data-focused={focused ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-selection-segment={selected ? selectionSegmentName(selectionSegment) : undefined}
      data-piwork-workspace-drop-surface
      data-dragging={dragged ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      data-drop-operation={dropTarget ? workspaceDrag?.target?.operation : undefined}
      data-testid={`user-space-entry-row-${data.mountId}:${entry.path}`}
    >
      <div
        className={`piwork-selection-surface pointer-events-none absolute inset-y-0 left-1 right-1 rounded-[var(--piwork-control-radius)] ${
          dropTarget
            ? "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary"
            : selected
              ? "bg-[var(--piwork-list-selected)]"
              : workspaceDrag
                ? ""
                : "group-hover/row:bg-[var(--piwork-list-hover)]"
        }`}
        style={
          selected && !dropTarget
            ? selectedRowBackgroundRadiusStyle(selectionSegment, TREE_ROW_GAP_PX)
            : { borderRadius: WORKSPACE_TREE_SINGLE_ROW_RADIUS }
        }
        aria-hidden="true"
      />
      {showContextTargetOutline && (
        <div
          className="piwork-context-target-border pointer-events-none absolute inset-y-0 left-1 right-1 z-10 rounded-[var(--piwork-control-radius)] border bg-[var(--piwork-list-selected)]"
          aria-hidden="true"
          data-testid="user-space-context-target-outline"
        />
      )}
      <TreeIndentGuides depth={guideDepth} />
      <div
        className="relative z-10 flex h-8 items-center gap-1.5 px-2 text-left text-xs"
        style={{ paddingLeft: `${contentInset}px` }}
      >
        {renaming ? (
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-left">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center"
              style={{ width: `${TREE_FILE_ICON_SLOT_WIDTH_PX}px` }}
              data-testid={`user-space-entry-icon-slot-${data.mountId}:${entry.path}`}
            >
              <Icon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
            </span>
            <div
              className={`flex h-6 min-w-0 flex-1 items-center rounded border bg-background text-sm font-medium leading-5 text-foreground outline-none ${
                renameInputInvalid
                  ? "border-danger ring-2 ring-danger/20"
                  : renameInputAvailable
                    ? "border-success ring-2 ring-success/20"
                    : "border-border ring-2 ring-primary/20"
              }`}
              data-name-availability={
                renameInputInvalid ? "invalid" : renameInputAvailable ? "available" : "empty"
              }
              style={fileTextAdjustStyle}
            >
              <input
                ref={renameInputRef}
                value={renameDraft}
                disabled={renameSaving}
                aria-label={workspaceCopy.rename.aria(entry.name)}
                aria-invalid={renameInputInvalid ? true : undefined}
                title={renameError || renameValidation || entry.path || entry.name}
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  if (renameError) setRenameError("");
                }}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onBlur={() => {
                  if (renameCancelledRef.current) {
                    renameCancelledRef.current = false;
                    return;
                  }
                  if (renameConfirmationPendingRef.current) return;
                  void commitInlineRename();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelInlineRename();
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitInlineRename();
                  }
                }}
                className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-sm font-medium leading-5 text-foreground outline-none disabled:opacity-60"
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={(event) => onEntryClick(data.mountId, entry, event)}
            disabled={!canOpen}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 overflow-hidden pr-8 text-left disabled:cursor-default"
            title={entry.path || entry.name}
            aria-label={
              isDirectory
                ? workspaceCopy.toggleDirectory(isOpen, entry.name)
                : workspaceCopy.previewEntry(entry.name)
            }
          >
            {isDirectory && (
              <span
                className="flex h-5 w-4 shrink-0 items-center justify-center text-disabled-foreground"
                style={{ width: `${TREE_TOGGLE_SLOT_WIDTH_PX}px` }}
                data-testid={`user-space-entry-toggle-slot-${data.mountId}:${entry.path}`}
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </span>
            )}
            {isDirectory ? (
              <span data-folder-state={isOpen ? "open" : "closed"} className="sr-only" />
            ) : (
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center"
                style={{ width: `${TREE_FILE_ICON_SLOT_WIDTH_PX}px` }}
                data-testid={`user-space-entry-icon-slot-${data.mountId}:${entry.path}`}
              >
                <Icon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate text-sm leading-5"
              style={
                isDirectory
                  ? { marginLeft: `${TREE_ROOT_DIRECTORY_TEXT_ADJUST_PX}px` }
                  : !isDirectory
                    ? fileTextAdjustStyle
                    : undefined
              }
            >
              {entry.name}
            </span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <ContextMenu.Root onOpenChange={setContextMenuOpen}>
        <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
        <WorkspaceContextMenuContent>
          {isDirectory ? (
            <>
              <WorkspaceContextMenuItem
                icon={Info}
                onSelect={() => void onShowDetails(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.details}
              </WorkspaceContextMenuItem>
              <WorkspaceNewFileSubmenu
                onCreateFile={(kind) => onCreateEntry(data.mountId, entry.path, kind)}
              />
              <WorkspaceContextMenuItem
                icon={FolderPlus}
                onSelect={() => onCreateEntry(data.mountId, entry.path, "directory")}
              >
                {workspaceCopy.contextMenu.newFolder}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Clipboard}
                disabled={!canPaste}
                onSelect={() => void onPasteEntry(data.mountId, entry.path)}
              >
                {workspaceCopy.contextMenu.pasteHere}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={ArrowRightLeft}
                onSelect={() => void onTransferToAgent(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.transferToAgent}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Clipboard}
                onSelect={() => onCopyEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.copy}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Scissors}
                disabled={!canMoveEntries || movePending}
                onSelect={() => onCutEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.cut}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuSeparator />
              <WorkspaceContextMenuItem
                icon={Trash2}
                variant="danger"
                onSelect={() => onDeleteEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.deleteFolder}
              </WorkspaceContextMenuItem>
            </>
          ) : (
            <>
              <WorkspaceContextMenuItem
                icon={Info}
                onSelect={() => void onShowDetails(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.details}
              </WorkspaceContextMenuItem>
              {isHtmlPath(entry.path) && (
                <WorkspaceContextMenuItem
                  icon={FileText}
                  onSelect={() => onOpenAsText(data.mountId, entry)}
                >
                  {workspaceCopy.contextMenu.openAsText}
                </WorkspaceContextMenuItem>
              )}
              <WorkspaceContextMenuSeparator />
              <WorkspaceContextMenuItem icon={File} onSelect={() => onOpen(data.mountId, entry)}>
                {workspaceCopy.contextMenu.open}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={ExternalLink}
                onSelect={() => onOpenInNewWindow(data.mountId, entry)}
              >
                {workspaceCopy.openPreviewInNewWindow}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Pin}
                onSelect={() => onOpenAndPin(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.openAndPin}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuSeparator />
              <WorkspaceContextMenuItem
                icon={AtSign}
                onSelect={() => onAddFileReference(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.addToConversation}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={ArrowRightLeft}
                onSelect={() => void onTransferToAgent(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.transferToAgent}
              </WorkspaceContextMenuItem>
              {!contextMenuUsesMultiSelection && (
                <WorkspaceContextMenuItem icon={Pencil} onSelect={startInlineRename}>
                  {workspaceCopy.contextMenu.rename}
                </WorkspaceContextMenuItem>
              )}
              <WorkspaceContextMenuItem
                icon={Copy}
                onSelect={() => void onDuplicateEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.createCopy}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Clipboard}
                onSelect={() => onCopyEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.copy}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuItem
                icon={Scissors}
                disabled={!canMoveEntries || movePending}
                onSelect={() => onCutEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.cut}
              </WorkspaceContextMenuItem>
              <WorkspaceContextMenuSeparator />
              <WorkspaceContextMenuItem
                icon={Trash2}
                variant="danger"
                onSelect={() => onDeleteEntry(data.mountId, entry)}
              >
                {workspaceCopy.contextMenu.delete}
              </WorkspaceContextMenuItem>
            </>
          )}
        </WorkspaceContextMenuContent>
      </ContextMenu.Root>
      {pendingExtensionRename && (
        <WorkspaceExtensionRenameConfirmDialog
          currentName={entry.name}
          nextName={pendingExtensionRename}
          onCancel={cancelExtensionRename}
          onConfirm={() => void performInlineRename(pendingExtensionRename)}
        />
      )}
    </>
  );
}

function WorkspaceDetailsModal({
  dialog,
  onClose,
}: {
  dialog: WorkspaceDetailsDialog;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop isDismissable>
        <Modal.Container>
          <Modal.Dialog
            aria-label={workspaceCopy.detailsDialog.title}
            className={`piwork-superellipse-panel ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card text-foreground sm:max-w-[480px]`}
          >
            <Modal.Body>
              {dialog.kind === "file" ? (
                <WorkspaceFileDetails entry={dialog.entry} directoryPath={dialog.directoryPath} />
              ) : (
                <WorkspaceSummaryDetails summary={dialog.summary} />
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button className={`w-full ${WORKSPACE_CONTROL_RADIUS_CLASS}`} slot="close">
                {uiCopy.common.close}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

type WorkspaceDetailsTone = "primary" | "success" | "warning" | "muted" | "danger";
type WorkspaceDetailsIcon = ElementType<{ className?: string; "aria-hidden"?: boolean }>;

function WorkspaceFileDetails({
  entry,
  directoryPath,
}: {
  entry: WorkspaceEntry;
  directoryPath: string;
}) {
  const EntryIcon = iconForWorkspaceEntry(entry);
  return (
    <dl className="space-y-2">
      <WorkspaceDetailsItem
        icon={EntryIcon}
        label={workspaceCopy.detailsDialog.labels.name}
        value={entry.name}
      />
      <WorkspaceDetailsItem
        icon={FolderTree}
        tone="primary"
        label={workspaceCopy.detailsDialog.labels.path}
        value={directoryPath}
        valueClassName="break-all"
      />
      <WorkspaceDetailsItem
        icon={Tags}
        tone="warning"
        label={workspaceCopy.detailsDialog.labels.type}
        value={workspaceDetailsTypeLabel(entry)}
      />
      <WorkspaceDetailsItem
        icon={HardDrive}
        tone="success"
        label={workspaceCopy.detailsDialog.labels.size}
        value={workspaceDetailsSizeLabel(entry)}
      />
      <WorkspaceDetailsItem
        icon={Clock}
        tone="muted"
        label={workspaceCopy.detailsDialog.labels.modifiedAt}
        value={workspaceDetailsModifiedLabel(entry)}
      />
    </dl>
  );
}

function WorkspaceSummaryDetails({ summary }: { summary: WorkspaceDetailsSummary }) {
  return (
    <dl className="space-y-2">
      <WorkspaceDetailsItem
        icon={Files}
        tone="primary"
        label={workspaceCopy.detailsDialog.labels.fileCount}
        value={String(summary.fileCount)}
      />
      <WorkspaceDetailsItem
        icon={Tags}
        tone="warning"
        label={workspaceCopy.detailsDialog.labels.typeCounts}
        value={<WorkspaceDetailsTypeCounts typeCounts={summary.typeCounts} />}
      />
      <WorkspaceDetailsItem
        icon={HardDrive}
        tone="success"
        label={workspaceCopy.detailsDialog.labels.totalSize}
        value={formatBytes(summary.totalSize)}
      />
    </dl>
  );
}

function WorkspaceDetailsItem({
  icon: Icon,
  tone = "muted",
  label,
  value,
  valueClassName = "",
}: {
  icon: WorkspaceDetailsIcon;
  tone?: WorkspaceDetailsTone;
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  const toneClass = workspaceDetailsToneClass(tone);
  return (
    <div
      className={`flex items-center gap-3 ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border/70 bg-default/40 px-3 py-2.5`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] ${toneClass.iconBackground}`}
      >
        <Icon className={`h-4 w-4 ${toneClass.icon}`} aria-hidden={true} />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-medium leading-4 text-muted-foreground">{label}</dt>
        <dd
          className={`mt-0.5 min-w-0 text-sm font-medium leading-5 text-foreground ${valueClassName}`}
        >
          {value}
        </dd>
      </div>
    </div>
  );
}

function WorkspaceDetailsTypeCounts({ typeCounts }: { typeCounts: WorkspaceDetailsTypeCount[] }) {
  if (typeCounts.length === 0) return <span>{workspaceCopy.detailsDialog.noFiles}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {typeCounts.map((item) => (
        <span
          key={item.label}
          className="rounded-[var(--piwork-control-radius)] bg-warning/10 px-2 py-0.5 text-xs font-semibold leading-5 text-warning"
        >
          {workspaceCopy.detailsDialog.typeCount(item.label, item.count)}
        </span>
      ))}
    </div>
  );
}

function workspaceDetailsToneClass(tone: WorkspaceDetailsTone): {
  iconBackground: string;
  icon: string;
} {
  switch (tone) {
    case "primary":
      return { iconBackground: "bg-primary/10", icon: "text-primary" };
    case "success":
      return { iconBackground: "bg-success/10", icon: "text-success" };
    case "warning":
      return { iconBackground: "bg-warning/10", icon: "text-warning" };
    case "danger":
      return { iconBackground: "bg-danger/10", icon: "text-danger" };
    case "muted":
    default:
      return { iconBackground: "bg-muted", icon: "text-muted-foreground" };
  }
}

function workspaceDetailsTypeLabel(entry: WorkspaceEntry): string {
  if (entry.kind === "directory") return workspaceCopy.detailsDialog.typeFolder;
  return workspaceDetailsFileTypeLabel(entry);
}

function workspaceDetailsFileTypeLabel(entry: WorkspaceEntry): string {
  const extension = getExtension(entry.path || entry.name);
  if (!extension) return workspaceCopy.detailsDialog.typeFile;
  const fileTypes = workspaceCopy.detailsDialog.fileTypes as Record<string, string>;
  return fileTypes[extension] || workspaceCopy.detailsDialog.typeFile;
}

function workspaceDetailsDirectoryPath(rootName: string, path: string): string {
  const directoryPath = dirnameWorkspacePath(path);
  return directoryPath ? `${rootName}/${directoryPath}` : rootName;
}

function workspaceDetailsSizeLabel(entry: WorkspaceEntry): string {
  return typeof entry.size === "number"
    ? formatBytes(entry.size)
    : workspaceCopy.detailsDialog.unknownSize;
}

function workspaceDetailsModifiedLabel(entry: WorkspaceEntry): string {
  if (typeof entry.lastModified !== "number" || entry.lastModified <= 0)
    return workspaceCopy.detailsDialog.unknownSize;
  return new Date(entry.lastModified).toLocaleString();
}

function WorkspaceContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className={`piwork-dropdown-motion ${WORKSPACE_CONTEXT_MENU_SURFACE_CLASS}`}
        collisionPadding={8}
      >
        {children}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function WorkspaceNewFileSubmenu({
  onCreateFile,
}: {
  onCreateFile: (kind: WorkspaceNewFileKind) => void;
}) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger
        className={`flex min-h-8 cursor-pointer select-none items-center gap-2 ${WORKSPACE_CONTROL_RADIUS_CLASS} px-2.5 text-[13px] font-medium ${WORKSPACE_SELECTABLE_TEXT_CLASS} outline-none transition-colors hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent`}
      >
        <FilePlus className="h-3.5 w-3.5 shrink-0" aria-hidden={true} />
        <span className="min-w-0 flex-1 truncate">{workspaceCopy.contextMenu.newFile}</span>
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-disabled-foreground"
          aria-hidden={true}
        />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          className={`piwork-dropdown-motion ${WORKSPACE_CONTEXT_MENU_SURFACE_CLASS}`}
          collisionPadding={8}
          sideOffset={6}
          alignOffset={-4}
        >
          {workspaceNewFileTemplates().map((template) => (
            <WorkspaceContextMenuItem
              key={template.kind}
              icon={template.icon}
              onSelect={() => onCreateFile(template.kind)}
            >
              {template.label}
            </WorkspaceContextMenuItem>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function WorkspaceContextMenuItem({
  icon: Icon,
  children,
  disabled = false,
  variant = "default",
  onSelect,
}: {
  icon: WorkspaceContextMenuIcon;
  children: ReactNode;
  disabled?: boolean;
  variant?: "default" | "danger";
  onSelect: () => void;
}) {
  if (disabled) return null;
  const danger = variant === "danger";
  return (
    <ContextMenu.Item
      className={`flex min-h-8 cursor-pointer select-none items-center gap-2 ${WORKSPACE_CONTROL_RADIUS_CLASS} px-2.5 text-[13px] font-medium outline-none transition-colors ${
        danger
          ? "text-danger hover:bg-danger-muted focus:bg-danger-muted data-[highlighted]:bg-danger-muted"
          : `${WORKSPACE_SELECTABLE_TEXT_CLASS} hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent`
      }`}
      onSelect={onSelect}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden={true} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenu.Item>
  );
}

function WorkspaceContextMenuSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border/80" />;
}

function VirtualWorkspaceStatusRow({
  item,
  data,
  onLoadMore,
  onRetry,
}: {
  item: ItemInstance<WorkspaceTreeItemData>;
  data: Extract<WorkspaceTreeItemData, { kind: "status" }>;
  onLoadMore: (mountId: string, path: string) => void;
  onRetry: (mountId: string, path: string) => void;
}) {
  const itemProps = treeItemA11yProps(item, false);
  const leftOffset = workspacePathDepth(data.dirPath) * TREE_INDENT_PX;
  if (data.status === "loading") {
    return (
      <div
        {...itemProps.props}
        ref={itemProps.ref}
        className="h-8"
        aria-hidden="true"
        data-testid="user-space-directory-loading-spacer"
      />
    );
  }
  if (data.status === "empty") {
    return (
      <div
        {...itemProps.props}
        ref={itemProps.ref}
        className="flex h-8 items-center px-2 text-xs text-disabled-foreground"
        style={{ marginLeft: `${leftOffset}px` }}
      >
        {workspaceCopy.directoryEmpty}
      </div>
    );
  }
  if (data.status === "load-more") {
    return (
      <div
        {...itemProps.props}
        ref={itemProps.ref}
        className="flex h-8 items-center"
        style={{ marginLeft: `${leftOffset + 4}px` }}
      >
        <button
          type="button"
          onClick={() => onLoadMore(data.mountId, data.dirPath)}
          className={`${WORKSPACE_CONTROL_RADIUS_CLASS} px-2 py-1 text-xs font-medium text-foreground hover:bg-accent`}
        >
          {workspaceCopy.directoryLoadMore}
        </button>
      </div>
    );
  }
  return (
    <div
      {...itemProps.props}
      ref={itemProps.ref}
      className={`flex h-8 min-w-0 items-center gap-2 ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-danger/35 bg-danger-muted px-2 text-xs text-danger`}
      style={{ marginLeft: `${leftOffset}px`, width: `calc(100% - ${leftOffset + 4}px)` }}
    >
      <span className="min-w-0 flex-1 truncate">
        {data.message || workspaceCopy.directoryLoadFailed}
      </span>
      <button
        type="button"
        onClick={() => onRetry(data.mountId, data.dirPath)}
        className="shrink-0 text-danger underline"
      >
        {uiCopy.common.retry}
      </button>
    </div>
  );
}

function treeItemA11yProps(item: ItemInstance<WorkspaceTreeItemData>, selected: boolean) {
  const { ref, onClick: _ignoredOnClick, ...props } = item.getProps();
  return {
    props: {
      ...props,
      "aria-selected": selected,
    },
    ref,
  };
}

function sameStringSets(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function TreeIndentGuides({ depth, offset = 0 }: { depth: number; offset?: number }) {
  if (depth <= 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-0"
      aria-hidden="true"
      data-testid="user-space-tree-guides"
    >
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          className="absolute inset-y-0 w-px bg-border"
          style={{
            left: `${offset + (index === 0 ? TREE_ROOT_GUIDE_LEFT_PX : TREE_NESTED_GUIDE_LEFT_PX + index * TREE_INDENT_PX)}px`,
          }}
        />
      ))}
    </div>
  );
}

function defaultPreviewViewModeForPath(path: string): PreviewViewMode {
  if (isHtmlPath(path) || isMarkdownPath(path)) return "preview";
  return "preview";
}

function defaultPreviewViewMode(preview: PreviewState): PreviewViewMode {
  if (preview.status !== "ready") return "preview";
  if (preview.kind === "html" || preview.kind === "markdown") return "preview";
  return preview.kind === "text" ? "text" : "preview";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}
