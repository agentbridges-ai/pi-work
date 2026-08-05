import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  AtSign,
  ChevronDown,
  ChevronUp,
  CircleX,
  ExternalLink,
  ListX,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopOpen,
  Pencil,
  Pin,
  PinOff,
  Save,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CreateOfficeEditorOptions,
  type OfficeEditorInstance,
  type ResourcePlan,
} from "@agentbridges-ai/onlyoffice-browser";
import { Button, Dialog, ProgressCircleEngine as ProgressCircle } from "../ui/index.js";
import { useStore } from "../../store.js";
import type { UserSpaceMount } from "../../types.js";
import {
  executeUserSpaceOperation,
  getUserSpaceFile,
  saveUserSpaceFile,
} from "../../user-space.js";
import { ONLYOFFICE_PLUGIN_GUID, type OnlyOfficeDocumentType } from "../../../shared/onlyoffice.js";
import { uiCopy } from "../../ui-copy.js";
import {
  registerOnlyOfficeEditor,
  type OnlyOfficeEditorRegistration,
} from "../../onlyoffice-browser-executor.js";
import { resolvePiworkOnlyOfficeHostUrl } from "../../onlyoffice-host-url.js";
import {
  applyOfficeResourcePlan,
  ensureOfficeResources,
  getTargetOfficeReleaseId,
  getVerifiedOfficeFontPaths,
  officeResourcesReadyForRelease,
  officeResourcesNeedAttention,
  planOfficeResourcesForFile,
  requestOfficeResourceSettings,
} from "../../office-runtime-resources.js";
import { runtimeContextCoordinator } from "../../runtime-context.js";
import type { OfficePreviewLease, OfficePreviewRuntimeManager } from "../../office-host-adapter.js";
import type { UiLanguage } from "../../store/ui-slice.js";
import type { ImageEditorSurfaceHandle } from "../ImageEditorSurface.js";
import { previewResourceRegistry } from "../preview-resource-registry.js";
import { isImageFile } from "../file-type-utils.js";
import type { MarkdownEditorToolbarCopy } from "./MarkdownEditorSurface.js";
import { ImageViewer, MediaPreview } from "./MediaPreviewSurfaces.js";
import { WtermPreview } from "./WtermPreview.js";
import type {
  MarkdownPreviewState,
  OfficePreviewState,
  PreviewState,
  PreviewTab,
  PreviewViewMode,
  ReadyPreviewState,
  WorkspaceEntry,
} from "../user-space-explorer/model.js";
import type { WorkspaceSearchPreviewRenderArgs } from "../user-space-explorer/WorkspaceSearchModal.js";
import {
  MAX_TEXT_PREVIEW_BYTES,
  OFFICE_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  createImageObjectUrl,
  emptyOfficeTypeForWorkspacePath,
  previewErrorMessage,
  previewKindForWorkspacePath,
} from "../user-space-explorer/preview-builder.js";
import {
  disposeOfficePreview,
  handoffOfficePreview,
  hideOfficePreviewHostForTeardown,
  registerOfficePreviewDisposer,
  resetOfficePreviewHostForMount,
} from "../user-space-explorer/preview-resources.js";
import {
  dirnameWorkspacePath,
  getExtension,
  normalizeWorkspacePath,
} from "../user-space-explorer/workspace-paths.js";
import { iconForWorkspaceEntry } from "./WorkspaceEntryIcon.js";
import {
  formatBytes,
  isAgentPreviewTabId,
  isWtermPreviewTabId,
  previewTitleForPath,
  type OfficeFileCreated,
  type OfficeFileMigration,
  type OfficeFileSaved,
  type PreviewTabInsertionEdge,
} from "./preview-workspace-contract.js";

export const DETACHED_PREVIEW_WINDOW_FEATURES =
  "popup,width=1180,height=820,left=96,top=72,resizable=yes,scrollbars=no";

export type DetachedPreviewWindowRequest = {
  id: number;
  tabId: string;
  win: Window;
};

const ImageEditorSurface = lazy(async () => {
  const module = await import("../ImageEditorSurface.js");
  return { default: module.ImageEditorSurface };
});

const TextEditorSurface = lazy(async () => {
  const module = await import("./TextEditorSurface.js");
  return { default: module.TextEditorSurface };
});

const MarkdownEditorSurface = lazy(async () => {
  const module = await import("./MarkdownEditorSurface.js");
  return { default: module.MarkdownEditorSurface };
});

const officePreviewRuntimeManagerPromise: Promise<OfficePreviewRuntimeManager> =
  import("../../office-host-adapter.js").then((module) => module.officePreviewRuntimeManager);

type OfficeInterfaceTheme = "system" | "light" | "dark";
type ThemeAwareOfficeEditorInstance = OfficeEditorInstance & {
  setInterfaceTheme?: (theme: OfficeInterfaceTheme) => void;
};

type DetachedPreviewWindowRecord = {
  id: string;
  tabId: string;
  win: Window;
  closeIntent?: "restore" | "tab-close" | "dispose";
};

type PreviewTabDragProxy = {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PreviewTabInsertionTarget = {
  tabId: string;
  edge: PreviewTabInsertionEdge;
};

type PreviewTabPointerDrag = {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  width: number;
  height: number;
  started: boolean;
  captured: boolean;
  captureElement: HTMLElement;
};

type TextEditorToolbarState = {
  canEdit: boolean;
  editing: boolean;
  editActionTitle: string;
  message: string;
  saving: boolean;
  onStartEditing: () => void;
  onFinishEditing: () => void;
};

const WORKSPACE_PANEL_BG_CLASS = "bg-background";
const WORKSPACE_PANEL_HEADER_SURFACE_CLASS = "bg-card";
const WORKSPACE_PANEL_HEADER_BORDER_CLASS = "border-b border-border";
const WORKSPACE_PANEL_TOPBAR_HEIGHT_CLASS = "h-10";
const WORKSPACE_PANEL_BODY_TEXT_CLASS = "text-xs text-foreground/75";
const WORKSPACE_SELECTABLE_TEXT_CLASS = "text-foreground";
const PREVIEW_BLUR_MASK_CLASS = "absolute inset-0 bg-background/90";
const WORKSPACE_CONTROL_RADIUS_CLASS = "rounded-[var(--piwork-control-radius)]";
const PREVIEW_TOOLBAR_ACTION_TEXT_CLASS = "text-sm font-semibold leading-5";
const PREVIEW_TOOLBAR_BUTTON_CLASS = `flex size-[var(--piwork-titlebar-control-size)] items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} bg-transparent text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-muted-foreground/45`;
const editorToolbarPortalId = (tabId: string) => `workspace-preview-editor-toolbar-${tabId}`;
const LEGACY_OFFICE_TARGET_EXTENSIONS: Record<string, string> = {
  doc: "docx",
  xls: "xlsx",
  ppt: "pptx",
};
const CODEMIRROR_LANGUAGE_MAX_BYTES = 256 * 1024;
const OFFICE_LEGACY_MIGRATION_CANCELLED_ERROR = "OfficeLegacyMigrationCancelled";
const workspaceCopy = uiCopy.userSpace;

function officeDocumentType(fileName: string): OnlyOfficeDocumentType {
  const extension = getExtension(fileName);
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "cell";
  if (PRESENTATION_EXTENSIONS.has(extension)) return "slide";
  return "word";
}

function revealPreviewTab(scroller: HTMLElement, tab: HTMLElement, alignEnd: boolean): void {
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (alignEnd) {
    scroller.scrollLeft = maxScrollLeft;
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.right > scrollerRect.right) {
    scroller.scrollLeft = Math.min(
      maxScrollLeft,
      scroller.scrollLeft + tabRect.right - scrollerRect.right,
    );
  } else if (tabRect.left < scrollerRect.left) {
    scroller.scrollLeft = Math.max(0, scroller.scrollLeft - (scrollerRect.left - tabRect.left));
  }
}

export const WorkspacePreviewPane = memo(function WorkspacePreviewPane({
  uiLanguage,
  tabs,
  activeTabId,
  previewVisible,
  onSelectTab,
  onCloseTab,
  onCloseTabs,
  onCloseAllTabs,
  onAddToConversation,
  onPinnedChange,
  onUnpinAll,
  onCloseAllPinned,
  onMoveTab,
  onViewModeChange,
  mountsById,
  onSaveTextContent,
  onSaveImageFile,
  waitForWorkspaceMutation,
  resolvePreviewTabPath,
  onUnsavedChange,
  onEditingChange,
  onOfficeFileMigration,
  onOfficeFileCreated,
  onOfficeFileSaved,
  spacePanelCollapsed,
  onSpacePanelCollapsedChange,
  sessionPanelCollapsed,
  onSessionPanelCollapsedChange,
  detachedWindowRequests,
  onDetachedWindowRequestHandled,
  onRequestPreviewOpen,
}: {
  uiLanguage: UiLanguage;
  tabs: PreviewTab[];
  activeTabId: string;
  previewVisible: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseTabs: (tabIds: string[]) => void;
  onCloseAllTabs: () => void;
  onAddToConversation: (tabId: string) => void;
  onPinnedChange: (tabId: string, pinned: boolean) => void;
  onUnpinAll: () => void;
  onCloseAllPinned: () => void;
  onMoveTab: (fromTabId: string, toTabId: string, edge?: PreviewTabInsertionTarget["edge"]) => void;
  onViewModeChange: (tabId: string, viewMode: PreviewViewMode) => void;
  mountsById: Map<string, UserSpaceMount>;
  onSaveTextContent: (tabId: string, content: string) => Promise<void>;
  onSaveImageFile: (tabId: string, file: File) => Promise<void>;
  waitForWorkspaceMutation?: () => Promise<void>;
  resolvePreviewTabPath?: (tabId: string) => string | undefined;
  onUnsavedChange: (tabId: string, hasUnsavedChanges: boolean) => void;
  onEditingChange: (tabId: string, isEditing: boolean) => void;
  onOfficeFileMigration: (migration: OfficeFileMigration) => void;
  onOfficeFileCreated: (created: OfficeFileCreated) => void;
  onOfficeFileSaved: (saved: OfficeFileSaved) => void;
  spacePanelCollapsed: boolean;
  onSpacePanelCollapsedChange: (collapsed: boolean) => void;
  sessionPanelCollapsed: boolean;
  onSessionPanelCollapsedChange: (collapsed: boolean) => void;
  detachedWindowRequests?: DetachedPreviewWindowRequest[];
  onDetachedWindowRequestHandled?: (requestId: number) => void;
  onRequestPreviewOpen?: () => void;
}) {
  const [detachedPreviewWindows, setDetachedPreviewWindows] = useState<
    DetachedPreviewWindowRecord[]
  >([]);
  const detachedPreviewByTabId = useMemo(
    () => new Map(detachedPreviewWindows.map((record) => [record.tabId, record])),
    [detachedPreviewWindows],
  );
  const dockedTabs = useMemo(
    () => tabs.filter((tab) => !detachedPreviewByTabId.has(tab.id)),
    [detachedPreviewByTabId, tabs],
  );
  const pinnedDockedTabs = useMemo(() => dockedTabs.filter((tab) => tab.pinned), [dockedTabs]);
  const unpinnedDockedTabs = useMemo(() => dockedTabs.filter((tab) => !tab.pinned), [dockedTabs]);
  const activeTab = dockedTabs.find((tab) => tab.id === activeTabId) || dockedTabs[0];
  const canSwitchView = false;
  const [draggingTabId, setDraggingTabId] = useState("");
  const [previewBodyDragActive, setPreviewBodyDragActive] = useState(false);
  const [previewTabDragProxy, setPreviewTabDragProxy] = useState<PreviewTabDragProxy | null>(null);
  const [previewTabInsertionTarget, setPreviewTabInsertionTarget] =
    useState<PreviewTabInsertionTarget | null>(null);
  const [previewTabHoverSuppressed, setPreviewTabHoverSuppressed] = useState(false);
  const [pinnedGroupHovered, setPinnedGroupHovered] = useState(false);
  const [pinnedGroupContextMenuOpen, setPinnedGroupContextMenuOpen] = useState(false);
  const pinnedGroupOpen = pinnedGroupHovered || pinnedGroupContextMenuOpen;
  const pinnedGroupRef = useRef<HTMLDivElement | null>(null);
  const [textToolbarByTabId, setTextToolbarByTabId] = useState<Map<string, TextEditorToolbarState>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!pinnedGroupOpen) return;

    const resetPinnedGroup = () => {
      setPinnedGroupHovered(false);
      setPinnedGroupContextMenuOpen(false);
    };
    const verifyPointerTarget = (event: PointerEvent) => {
      const group = pinnedGroupRef.current;
      if (group && event.target instanceof Node && group.contains(event.target)) return;
      setPinnedGroupHovered(false);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetPinnedGroup();
    };

    window.addEventListener("blur", resetPinnedGroup);
    window.addEventListener("pointercancel", resetPinnedGroup);
    window.addEventListener("pointermove", verifyPointerTarget, true);
    document.addEventListener("pointermove", verifyPointerTarget, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", resetPinnedGroup);
      window.removeEventListener("pointercancel", resetPinnedGroup);
      window.removeEventListener("pointermove", verifyPointerTarget, true);
      document.removeEventListener("pointermove", verifyPointerTarget, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [pinnedGroupOpen]);
  const [previewBodyOrder, setPreviewBodyOrder] = useState<string[]>([]);
  const previewTabbarRef = useRef<HTMLDivElement | null>(null);
  const previewTabScrollRef = useRef<HTMLDivElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const previewSurfaceByTabIdRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const previewTabPointerDragRef = useRef<PreviewTabPointerDrag | null>(null);
  const previewTabPointerDragCleanupRef = useRef<(() => void) | null>(null);
  const previewTabAutoScrollFrameRef = useRef<number | null>(null);
  const previewTabIdsRef = useRef<string[]>([]);
  const dockedPreviewTabIdsRef = useRef<string[]>([]);
  const detachedPreviewSeqRef = useRef(0);
  const detachedPreviewWindowsRef = useRef<DetachedPreviewWindowRecord[]>([]);
  const suppressPreviewTabClickUntilRef = useRef(0);
  const suppressPreviewTabClickTabIdRef = useRef("");
  const suppressPreviewTabClickTimerRef = useRef<number | null>(null);
  const dragStateActive = Boolean(draggingTabId || previewBodyDragActive || previewTabDragProxy);
  const previewBodyTabs = useMemo(() => {
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const orderedTabs: PreviewTab[] = [];
    const renderedIds = new Set<string>();
    for (const tabId of previewBodyOrder) {
      const tab = tabsById.get(tabId);
      if (!tab) continue;
      orderedTabs.push(tab);
      renderedIds.add(tabId);
    }
    for (const tab of tabs) {
      if (renderedIds.has(tab.id)) continue;
      orderedTabs.push(tab);
    }
    return orderedTabs;
  }, [previewBodyOrder, tabs]);
  const handleTextToolbarChange = useCallback(
    (tabId: string, state: TextEditorToolbarState | null) => {
      setTextToolbarByTabId((current) => {
        const next = new Map(current);
        if (state) next.set(tabId, state);
        else next.delete(tabId);
        return next;
      });
    },
    [],
  );
  const movePreviewSurfaceToMain = useCallback((tabId: string) => {
    const surface = previewSurfaceByTabIdRef.current.get(tabId);
    const mainBody = previewBodyRef.current;
    if (surface && mainBody && surface.parentNode !== mainBody) mainBody.appendChild(surface);
  }, []);
  const restoreDetachedPreviewWindow = useCallback(
    async (windowId: string) => {
      const record = detachedPreviewWindowsRef.current.find((item) => item.id === windowId);
      if (!record) return;
      const tab = tabs.find((item) => item.id === record.tabId);
      if (tab && isOfficePreviewState(tab.state)) {
        try {
          await handoffOfficePreview(record.tabId);
        } catch {
          return;
        }
      }
      record.closeIntent = "restore";
      movePreviewSurfaceToMain(record.tabId);
      setDetachedPreviewWindows((current) => current.filter((item) => item.id !== windowId));
      onSelectTab(record.tabId);
      onRequestPreviewOpen?.();
      if (!record.win.closed) record.win.close();
    },
    [movePreviewSurfaceToMain, onRequestPreviewOpen, onSelectTab, tabs],
  );
  const closeDetachedPreviewWindow = useCallback(
    (windowId: string) => {
      const record = detachedPreviewWindowsRef.current.find((item) => item.id === windowId);
      if (!record || record.closeIntent) return;
      const tab = tabs.find((item) => item.id === record.tabId);
      movePreviewSurfaceToMain(record.tabId);
      setDetachedPreviewWindows((current) => current.filter((item) => item.id !== windowId));
      if (tab?.hasUnsavedChanges) onSelectTab(record.tabId);
      onCloseTab(record.tabId);
    },
    [movePreviewSurfaceToMain, onCloseTab, onSelectTab, tabs],
  );
  const blurPreviewTabFocus = useCallback(() => {
    if (typeof document === "undefined") return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return;
    if (!previewTabbarRef.current?.contains(activeElement)) return;
    activeElement.blur();
  }, []);
  const stopPreviewTabAutoScroll = useCallback(() => {
    if (typeof window !== "undefined" && previewTabAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(previewTabAutoScrollFrameRef.current);
    }
    previewTabAutoScrollFrameRef.current = null;
  }, []);
  const clearPreviewTabDragState = useCallback(() => {
    stopPreviewTabAutoScroll();
    setDraggingTabId("");
    setPreviewBodyDragActive(false);
    setPreviewTabDragProxy(null);
    setPreviewTabInsertionTarget(null);
    setPreviewTabHoverSuppressed(false);
    blurPreviewTabFocus();
  }, [blurPreviewTabFocus, stopPreviewTabAutoScroll]);
  const markPreviewTabDragClickSuppressed = useCallback((tabId: string) => {
    if (typeof window === "undefined") return;
    suppressPreviewTabClickUntilRef.current = Date.now() + 120;
    suppressPreviewTabClickTabIdRef.current = tabId;
    if (suppressPreviewTabClickTimerRef.current !== null) {
      window.clearTimeout(suppressPreviewTabClickTimerRef.current);
    }
    suppressPreviewTabClickTimerRef.current = window.setTimeout(() => {
      suppressPreviewTabClickUntilRef.current = 0;
      suppressPreviewTabClickTabIdRef.current = "";
      suppressPreviewTabClickTimerRef.current = null;
    }, 120);
  }, []);
  const clearPreviewTabClickSuppression = useCallback(() => {
    suppressPreviewTabClickUntilRef.current = 0;
    suppressPreviewTabClickTabIdRef.current = "";
    if (typeof window === "undefined" || suppressPreviewTabClickTimerRef.current === null) return;
    window.clearTimeout(suppressPreviewTabClickTimerRef.current);
    suppressPreviewTabClickTimerRef.current = null;
  }, []);
  const isPreviewTabReleaseSuppressed = useCallback((target: EventTarget | null) => {
    if (suppressPreviewTabClickUntilRef.current < Date.now()) return false;
    if (target instanceof Element && target.closest("[data-preview-tab-close]")) return false;
    const suppressedTabId = suppressPreviewTabClickTabIdRef.current;
    if (!suppressedTabId || !(target instanceof Element)) return true;
    const targetTab = target.closest("[data-preview-tab-id]") as HTMLElement | null;
    return !targetTab || targetTab.dataset.previewTabId === suppressedTabId;
  }, []);
  const suppressPreviewTabReleaseEvent = useCallback(
    (event: ReactSyntheticEvent<HTMLElement>) => {
      if (!isPreviewTabReleaseSuppressed(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.target;
      if (target instanceof HTMLElement) target.blur();
      blurPreviewTabFocus();
    },
    [blurPreviewTabFocus, isPreviewTabReleaseSuppressed],
  );
  const shouldSuppressPreviewTabClick = useCallback((tabId: string) => {
    if (suppressPreviewTabClickUntilRef.current < Date.now()) return false;
    const suppressedTabId = suppressPreviewTabClickTabIdRef.current;
    if (suppressedTabId && suppressedTabId !== tabId) return false;
    suppressPreviewTabClickUntilRef.current = 0;
    suppressPreviewTabClickTabIdRef.current = "";
    if (typeof window !== "undefined" && suppressPreviewTabClickTimerRef.current !== null) {
      window.clearTimeout(suppressPreviewTabClickTimerRef.current);
    }
    suppressPreviewTabClickTimerRef.current = null;
    return true;
  }, []);
  const openDetachedPreviewWindow = useCallback(
    async (tabId: string, requestedWindow?: Window) => {
      const tab = tabs.find((item) => item.id === tabId);
      const existingDetached = detachedPreviewByTabId.get(tabId);
      if (!tab || typeof window === "undefined") {
        requestedWindow?.close();
        return;
      }
      if (existingDetached) {
        requestedWindow?.close();
        existingDetached.win.focus();
        return;
      }
      const popout = requestedWindow || window.open("", "_blank", DETACHED_PREVIEW_WINDOW_FEATURES);
      if (!popout) return;
      const detachedRoot = prepareDetachedPreviewWindow(popout, tab.title);
      const surface = previewSurfaceByTabIdRef.current.get(tabId);
      if (!detachedRoot || !surface) {
        popout.close();
        return;
      }
      if (isOfficePreviewState(tab.state)) {
        try {
          await handoffOfficePreview(tabId);
        } catch {
          popout.close();
          return;
        }
      }
      detachedRoot.appendChild(surface);
      const id = `${tabId}:${Date.now()}:${detachedPreviewSeqRef.current++}`;
      setDetachedPreviewWindows((current) => [
        ...current,
        {
          id,
          tabId,
          win: popout,
        },
      ]);
      const remainingDockedTabs = dockedTabs.filter((item) => item.id !== tabId);
      const tabIndex = dockedTabs.findIndex((item) => item.id === tabId);
      const fallback =
        remainingDockedTabs[Math.min(tabIndex, remainingDockedTabs.length - 1)] ||
        remainingDockedTabs[remainingDockedTabs.length - 1];
      if (fallback) onSelectTab(fallback.id);
    },
    [detachedPreviewByTabId, dockedTabs, onSelectTab, tabs],
  );
  const handledDetachedWindowRequestIdsRef = useRef(new Set<number>());
  useLayoutEffect(() => {
    for (const request of detachedWindowRequests || []) {
      if (
        handledDetachedWindowRequestIdsRef.current.has(request.id) ||
        !tabs.some((tab) => tab.id === request.tabId)
      ) {
        continue;
      }
      handledDetachedWindowRequestIdsRef.current.add(request.id);
      void openDetachedPreviewWindow(request.tabId, request.win).finally(() =>
        onDetachedWindowRequestHandled?.(request.id),
      );
    }
  }, [detachedWindowRequests, onDetachedWindowRequestHandled, openDetachedPreviewWindow, tabs]);
  const updatePreviewTabDragProxyAt = useCallback(
    (tabId: string, x: number, y: number, size?: { width: number; height: number }) => {
      if (!tabId || !tabs.some((tab) => tab.id === tabId)) return;
      setPreviewTabDragProxy((current) => {
        const width = size?.width ?? (current?.tabId === tabId ? current.width : 1);
        const height = size?.height ?? (current?.tabId === tabId ? current.height : 1);
        if (
          current?.tabId === tabId &&
          current.x === x &&
          current.y === y &&
          current.width === width &&
          current.height === height
        )
          return current;
        return { tabId, x, y, width, height };
      });
    },
    [tabs],
  );
  const updatePreviewTabDragProxy = useCallback(
    (
      event: ReactDragEvent<HTMLElement>,
      tabId: string,
      options: { preserveSize?: boolean } = {},
    ) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const hasPointerPosition = event.clientX !== 0 || event.clientY !== 0;
      const fallbackX = rect.left + Math.min(Math.max(rect.width / 2, 32), 110);
      const fallbackY = rect.top + (rect.height || 36) / 2;
      const x = hasPointerPosition ? event.clientX : fallbackX;
      const y = hasPointerPosition ? event.clientY : fallbackY;
      updatePreviewTabDragProxyAt(
        tabId,
        x,
        y,
        options.preserveSize
          ? undefined
          : {
              width: Math.max(1, Math.round(rect.width)),
              height: Math.max(1, Math.round(rect.height)),
            },
      );
    },
    [updatePreviewTabDragProxyAt],
  );
  const isPointInPreviewBody = useCallback((x: number, y: number) => {
    const rect = previewBodyRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);
  const previewTabMoveWouldChangeOrder = useCallback(
    (fromTabId: string, toTabId: string, edge: PreviewTabInsertionTarget["edge"]) => {
      if (!fromTabId || !toTabId || fromTabId === toTabId) return false;
      const fromIndex = tabs.findIndex((tab) => tab.id === fromTabId);
      const toIndex = tabs.findIndex((tab) => tab.id === toTabId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false;
      const next = [...tabs];
      const [moved] = next.splice(fromIndex, 1);
      const targetIndex = next.findIndex((tab) => tab.id === toTabId);
      if (targetIndex < 0) return false;
      next.splice(targetIndex + (edge === "after" ? 1 : 0), 0, moved);
      return next.some((tab, index) => tab.id !== tabs[index]?.id);
    },
    [tabs],
  );
  const previewTabInsertionTargetAt = useCallback(
    (x: number, y: number, drag: PreviewTabPointerDrag): PreviewTabInsertionTarget | null => {
      if (dockedTabs.find((tab) => tab.id === drag.tabId)?.pinned) return null;
      const movedLeft = x < drag.startX;
      const movedRight = x > drag.startX;
      const probeX = movedLeft ? x - drag.width / 2 : movedRight ? x + drag.width / 2 : x;
      const tabbar = previewTabbarRef.current;
      const tabElements = tabbar
        ? Array.from(tabbar.querySelectorAll<HTMLElement>("[data-preview-tab-id]"))
        : [];
      const targetTab =
        tabElements.find((item) => {
          if (item.dataset.previewTabId === drag.tabId) return false;
          const rect = item.getBoundingClientRect();
          return probeX >= rect.left && probeX <= rect.right && y >= rect.top && y <= rect.bottom;
        }) ||
        (() => {
          const target =
            typeof document.elementFromPoint === "function"
              ? document.elementFromPoint(x, y)
              : null;
          return target instanceof Element
            ? (target.closest("[data-preview-tab-id]") as HTMLElement | null)
            : null;
        })();
      const targetTabId = targetTab?.dataset.previewTabId;
      if (!targetTab || !targetTabId || targetTabId === drag.tabId) return null;
      if (dockedTabs.find((tab) => tab.id === targetTabId)?.pinned) return null;
      const rect = targetTab.getBoundingClientRect();
      const tabWidth = Math.max(1, rect.width);
      const relativeX = Math.min(Math.max(0, probeX - rect.left), tabWidth);
      const edge = relativeX < tabWidth / 2 ? "before" : "after";
      const remainingTabs = dockedTabs.filter((tab) => tab.id !== drag.tabId);
      const targetIndex = remainingTabs.findIndex((tab) => tab.id === targetTabId);
      if (targetIndex < 0) return null;
      const insertionIndex = targetIndex + (edge === "after" ? 1 : 0);
      const canonicalTarget =
        insertionIndex < remainingTabs.length
          ? { tabId: remainingTabs[insertionIndex].id, edge: "before" as const }
          : { tabId: remainingTabs[remainingTabs.length - 1]?.id || "", edge: "after" as const };
      if (
        !canonicalTarget.tabId ||
        !previewTabMoveWouldChangeOrder(drag.tabId, canonicalTarget.tabId, canonicalTarget.edge)
      )
        return null;
      return canonicalTarget;
    },
    [dockedTabs, previewTabMoveWouldChangeOrder],
  );
  const updatePreviewTabInsertionTarget = useCallback(
    (target: PreviewTabInsertionTarget | null) => {
      setPreviewTabInsertionTarget((current) => {
        if (!current && !target) return current;
        if (current && target && current.tabId === target.tabId && current.edge === target.edge)
          return current;
        return target;
      });
    },
    [],
  );
  const startPreviewTabAutoScroll = useCallback(() => {
    if (typeof window === "undefined" || previewTabAutoScrollFrameRef.current !== null) return;
    const tick = () => {
      previewTabAutoScrollFrameRef.current = null;
      const drag = previewTabPointerDragRef.current;
      const scroller = previewTabScrollRef.current;
      if (!drag?.started || !scroller) return;

      const rect = scroller.getBoundingClientRect();
      if (drag.currentY < rect.top || drag.currentY > rect.bottom) return;
      const edgeSize = Math.min(48, rect.width / 4);
      let intensity = 0;
      if (drag.currentX < rect.left + edgeSize) {
        intensity = -Math.min(1, (rect.left + edgeSize - drag.currentX) / edgeSize);
      } else if (drag.currentX > rect.right - edgeSize) {
        intensity = Math.min(1, (drag.currentX - (rect.right - edgeSize)) / edgeSize);
      }
      if (intensity === 0) return;

      const previousScrollLeft = scroller.scrollLeft;
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const scrollDelta = Math.sign(intensity) * Math.ceil(20 * Math.abs(intensity));
      scroller.scrollLeft = Math.min(maxScrollLeft, Math.max(0, previousScrollLeft + scrollDelta));
      if (scroller.scrollLeft === previousScrollLeft) return;

      updatePreviewTabInsertionTarget(
        previewTabInsertionTargetAt(drag.currentX, drag.currentY, drag),
      );
      previewTabAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    previewTabAutoScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, [previewTabInsertionTargetAt, updatePreviewTabInsertionTarget]);
  const finishPreviewTabPointerDrag = useCallback(
    (x: number, y: number, drag: PreviewTabPointerDrag) => {
      const target =
        typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
      if (isPointInPreviewBody(x, y) || (target && previewBodyRef.current?.contains(target))) {
        void openDetachedPreviewWindow(drag.tabId);
        return;
      }
      const insertionTarget = previewTabInsertionTargetAt(x, y, drag);
      if (insertionTarget) {
        onMoveTab(drag.tabId, insertionTarget.tabId, insertionTarget.edge);
      }
    },
    [isPointInPreviewBody, onMoveTab, openDetachedPreviewWindow, previewTabInsertionTargetAt],
  );
  const clearPreviewTabPointerDragListeners = useCallback(() => {
    const current = previewTabPointerDragRef.current;
    if (current) {
      try {
        if (current.captured && current.captureElement.hasPointerCapture(current.pointerId)) {
          current.captureElement.releasePointerCapture(current.pointerId);
        }
      } catch {
        // Pointer capture can already be released by the browser after cancel/up.
      }
    }
    previewTabPointerDragCleanupRef.current?.();
    previewTabPointerDragCleanupRef.current = null;
    previewTabPointerDragRef.current = null;
  }, []);
  const startPreviewTabPointerDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, tabId: string) => {
      if ((typeof event.button === "number" && event.button !== 0) || event.isPrimary === false)
        return;
      if (tabs.find((tab) => tab.id === tabId)?.pinned) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-preview-tab-close]")) return;
      if (typeof window === "undefined") return;

      clearPreviewTabPointerDragListeners();
      setDraggingTabId(tabId);
      setPreviewBodyDragActive(false);
      setPreviewTabInsertionTarget(null);

      const captureElement = event.currentTarget;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      const rect = captureElement.getBoundingClientRect();
      const drag: PreviewTabPointerDrag = {
        tabId,
        pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        started: false,
        captured: false,
        captureElement,
      };
      previewTabPointerDragRef.current = drag;

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const current = previewTabPointerDragRef.current;
        const pointerId = typeof pointerEvent.pointerId === "number" ? pointerEvent.pointerId : 1;
        if (!current || current.pointerId !== pointerId) return;
        const deltaX = pointerEvent.clientX - current.startX;
        const deltaY = pointerEvent.clientY - current.startY;
        if (!current.started && Math.hypot(deltaX, deltaY) < 4) return;
        pointerEvent.preventDefault();
        current.currentX = pointerEvent.clientX;
        current.currentY = pointerEvent.clientY;

        if (!current.started) {
          current.started = true;
          try {
            current.captureElement.setPointerCapture(current.pointerId);
            current.captured = true;
          } catch {
            current.captured = false;
          }
          markPreviewTabDragClickSuppressed(current.tabId);
          setPreviewTabHoverSuppressed(true);
          setDraggingTabId(current.tabId);
          blurPreviewTabFocus();
        }

        updatePreviewTabDragProxyAt(current.tabId, pointerEvent.clientX, pointerEvent.clientY, {
          width: current.width,
          height: current.height,
        });
        const pointerTarget =
          typeof document.elementFromPoint === "function"
            ? document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
            : null;
        const overPreviewBody = Boolean(
          isPointInPreviewBody(pointerEvent.clientX, pointerEvent.clientY) ||
          (pointerTarget && previewBodyRef.current?.contains(pointerTarget)),
        );
        setPreviewBodyDragActive(overPreviewBody);
        updatePreviewTabInsertionTarget(
          overPreviewBody
            ? null
            : previewTabInsertionTargetAt(pointerEvent.clientX, pointerEvent.clientY, current),
        );
        if (overPreviewBody) stopPreviewTabAutoScroll();
        else startPreviewTabAutoScroll();
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        const current = previewTabPointerDragRef.current;
        const pointerId = typeof pointerEvent.pointerId === "number" ? pointerEvent.pointerId : 1;
        if (!current || current.pointerId !== pointerId) return;
        clearPreviewTabPointerDragListeners();
        if (!current.started) {
          clearPreviewTabDragState();
          return;
        }
        markPreviewTabDragClickSuppressed(current.tabId);
        const releaseX = pointerEvent.clientX || current.currentX;
        const releaseY = pointerEvent.clientY || current.currentY;
        finishPreviewTabPointerDrag(releaseX, releaseY, current);
        pointerEvent.preventDefault();
        pointerEvent.stopPropagation();
        clearPreviewTabDragState();
      };

      const handlePointerCancel = (pointerEvent: PointerEvent) => {
        const current = previewTabPointerDragRef.current;
        const pointerId = typeof pointerEvent.pointerId === "number" ? pointerEvent.pointerId : 1;
        if (!current || current.pointerId !== pointerId) return;
        clearPreviewTabPointerDragListeners();
        clearPreviewTabDragState();
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove, true);
        window.removeEventListener("pointerup", handlePointerUp, true);
        window.removeEventListener("pointercancel", handlePointerCancel, true);
      };
      previewTabPointerDragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove, true);
      window.addEventListener("pointerup", handlePointerUp, true);
      window.addEventListener("pointercancel", handlePointerCancel, true);
    },
    [
      blurPreviewTabFocus,
      clearPreviewTabDragState,
      clearPreviewTabPointerDragListeners,
      finishPreviewTabPointerDrag,
      isPointInPreviewBody,
      markPreviewTabDragClickSuppressed,
      previewTabInsertionTargetAt,
      startPreviewTabAutoScroll,
      stopPreviewTabAutoScroll,
      tabs,
      updatePreviewTabDragProxyAt,
      updatePreviewTabInsertionTarget,
    ],
  );
  const handlePreviewBodyDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const tabId = draggingTabId || event.dataTransfer.getData("text/plain");
      if (!tabId || !tabs.some((tab) => tab.id === tabId)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      updatePreviewTabDragProxy(event, tabId, { preserveSize: true });
      setPreviewBodyDragActive(true);
    },
    [draggingTabId, tabs, updatePreviewTabDragProxy],
  );
  const handlePreviewBodyDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setPreviewBodyDragActive(false);
  }, []);
  const handlePreviewBodyDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const tabId = event.dataTransfer.getData("text/plain") || draggingTabId;
      if (!tabId || !tabs.some((tab) => tab.id === tabId)) return;
      event.preventDefault();
      event.stopPropagation();
      clearPreviewTabDragState();
      void openDetachedPreviewWindow(tabId);
    },
    [clearPreviewTabDragState, draggingTabId, openDetachedPreviewWindow, tabs],
  );
  useEffect(() => {
    detachedPreviewWindowsRef.current = detachedPreviewWindows;
  }, [detachedPreviewWindows]);
  useLayoutEffect(() => {
    const mainBody = previewBodyRef.current;
    if (!mainBody) return;
    for (const tab of previewBodyTabs) {
      const surface = previewSurfaceByTabIdRef.current.get(tab.id);
      if (!surface) continue;
      const detachedRecord = detachedPreviewByTabId.get(tab.id);
      if (detachedRecord && !detachedRecord.win.closed) {
        const detachedRoot = prepareDetachedPreviewWindow(detachedRecord.win, tab.title);
        if (detachedRoot && surface.parentNode !== detachedRoot) detachedRoot.appendChild(surface);
      } else if (surface.parentNode !== mainBody) {
        mainBody.appendChild(surface);
      }
    }
  }, [detachedPreviewByTabId, previewBodyTabs]);
  useLayoutEffect(() => {
    const previousTabIds = new Set(dockedPreviewTabIdsRef.current);
    const nextTabIds = unpinnedDockedTabs.map((tab) => tab.id);
    dockedPreviewTabIdsRef.current = nextTabIds;
    let addedTabId = "";
    for (const tabId of nextTabIds) {
      if (!previousTabIds.has(tabId)) addedTabId = tabId;
    }
    if (!addedTabId) return;
    const scroller = previewTabScrollRef.current;
    if (!scroller) return;
    const addedTab = Array.from(
      scroller.querySelectorAll<HTMLElement>("[data-preview-tab-id]"),
    ).find((tab) => tab.dataset.previewTabId === addedTabId);
    if (!addedTab) return;
    const addedAtEnd = nextTabIds[nextTabIds.length - 1] === addedTabId;
    revealPreviewTab(scroller, addedTab, addedAtEnd);
  }, [unpinnedDockedTabs]);
  useEffect(() => {
    if (!dragStateActive || typeof window === "undefined") return undefined;
    const handleNativeDragEnd = () => clearPreviewTabDragState();
    window.addEventListener("dragend", handleNativeDragEnd, true);
    return () => {
      window.removeEventListener("dragend", handleNativeDragEnd, true);
    };
  }, [clearPreviewTabDragState, dragStateActive]);
  useEffect(
    () => () => {
      previewTabPointerDragCleanupRef.current?.();
      previewTabPointerDragCleanupRef.current = null;
      previewTabPointerDragRef.current = null;
      clearPreviewTabClickSuppression();
      for (const record of detachedPreviewWindowsRef.current) {
        record.closeIntent = "dispose";
        if (!record.win.closed) record.win.close();
      }
    },
    [clearPreviewTabClickSuppression],
  );
  useEffect(() => {
    setPreviewBodyOrder((current) => {
      const tabIds = tabs.map((tab) => tab.id);
      const openTabIds = new Set(tabIds);
      const next = current.filter((tabId) => openTabIds.has(tabId));
      for (const tabId of tabIds) {
        if (!next.includes(tabId)) next.push(tabId);
      }
      if (next.length === current.length && next.every((tabId, index) => tabId === current[index]))
        return current;
      return next;
    });
  }, [tabs]);
  useEffect(() => {
    const openTabIds = new Set(tabs.map((tab) => tab.id));
    const staleRecords = detachedPreviewWindows.filter(
      (record) => !openTabIds.has(record.tabId) || record.win.closed,
    );
    if (staleRecords.length === 0) return;
    const staleIds = new Set(staleRecords.map((record) => record.id));
    setDetachedPreviewWindows((current) => current.filter((record) => !staleIds.has(record.id)));
    if (typeof window === "undefined") return;
    window.setTimeout(() => {
      for (const record of staleRecords) {
        record.closeIntent = "tab-close";
        if (!record.win.closed) record.win.close();
      }
    }, 0);
  }, [detachedPreviewWindows, tabs]);
  useEffect(() => {
    const openTabIds = new Set(tabs.map((tab) => tab.id));
    const tabWasRemoved = previewTabIdsRef.current.some((tabId) => !openTabIds.has(tabId));
    previewTabIdsRef.current = tabs.map((tab) => tab.id);
    if (!tabWasRemoved) return;

    clearPreviewTabClickSuppression();
    if (draggingTabId && !openTabIds.has(draggingTabId)) clearPreviewTabDragState();
  }, [clearPreviewTabClickSuppression, clearPreviewTabDragState, draggingTabId, tabs]);
  const renderPreviewTab = (
    tab: PreviewTab,
    options?: {
      vertical?: boolean;
      onContextMenuOpenChange?: (open: boolean) => void;
    },
  ) => {
    const TabIcon = previewTabIcon(tab);
    const closableTabs = tabs.filter((item) => !item.pinned);
    const otherClosableTabs = closableTabs.filter((item) => item.id !== tab.id);
    return (
      <ContextMenu.Root key={tab.id} onOpenChange={options?.onContextMenuOpenChange}>
        <ContextMenu.Trigger asChild>
          <div
            data-testid={`preview-tab-${tab.id}`}
            data-preview-tab-id={tab.id}
            draggable={false}
            onPointerDown={(event) => startPreviewTabPointerDrag(event, tab.id)}
            className={`piwork-context-target-trigger group/tab relative flex shrink-0 items-center rounded-[var(--piwork-control-radius)] border border-border text-sm transition-none ${
              options?.vertical ? "h-9 w-full max-w-none" : "h-full max-w-[190px]"
            } ${
              tab.id === activeTab?.id
                ? "bg-accent text-foreground"
                : `bg-transparent ${WORKSPACE_SELECTABLE_TEXT_CLASS} ${previewTabHoverSuppressed ? "" : "hover:bg-accent"}`
            } data-[state=open]:bg-accent data-[state=open]:text-foreground`}
          >
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                if (shouldSuppressPreviewTabClick(tab.id)) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.blur();
                  blurPreviewTabFocus();
                  return;
                }
                onSelectTab(tab.id);
              }}
              className="absolute inset-0 z-0 cursor-default border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
              title={tab.title}
              aria-label={workspaceCopy.previewTab(tab.title)}
            />
            <span
              className="pointer-events-none relative z-10 ml-1.5 flex h-6 w-6 shrink-0 items-center justify-center"
              data-testid={`preview-tab-icon-${tab.id}`}
              aria-hidden="true"
            >
              <TabIcon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
            </span>
            <span
              className="pointer-events-none relative z-10 min-w-0 flex-1 truncate px-1 text-left font-medium"
              title={tab.title}
            >
              {tab.title}
            </span>
            {!tab.pinned && (
              <button
                type="button"
                data-preview-tab-close=""
                onPointerUp={(event) => {
                  if (event.button !== 0 || tab.hasUnsavedChanges) return;
                  disposeOfficePreview(tab.id);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className={`relative z-20 mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  previewTabHoverSuppressed ? "" : "group-hover/tab:opacity-100"
                }`}
                aria-label={workspaceCopy.closePreview(tab.title)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {tab.hasUnsavedChanges && (
              <span
                className={`pointer-events-none absolute right-2.5 top-1/2 z-10 h-2 w-2 -translate-y-1/2 rounded-full bg-muted-foreground ${
                  !tab.pinned && !previewTabHoverSuppressed ? "group-hover/tab:opacity-0" : ""
                }`}
                data-testid={`preview-tab-dirty-${tab.id}`}
                aria-hidden="true"
              />
            )}
            {previewTabInsertionTarget?.tabId === tab.id && draggingTabId !== tab.id && (
              <span
                className={`pointer-events-none absolute bottom-1 top-1 z-30 w-0.5 rounded-full bg-preview-drop-indicator ${
                  previewTabInsertionTarget.edge === "before"
                    ? "left-0 -translate-x-1/2"
                    : "right-0 translate-x-1/2"
                }`}
                data-testid="preview-tab-drop-indicator"
                data-drop-edge={previewTabInsertionTarget.edge}
                aria-hidden="true"
              />
            )}
          </div>
        </ContextMenu.Trigger>
        <PreviewTabContextMenu
          showAddToConversation={Boolean(
            tab.mountId && !isAgentPreviewTabId(tab.id) && !isWtermPreviewTabId(tab.id),
          )}
          pinned={Boolean(tab.pinned)}
          showCloseCurrent={!tab.pinned}
          showCloseOthers={otherClosableTabs.length > 0}
          showCloseAll={closableTabs.length > 1}
          onOpenInNewWindow={() => void openDetachedPreviewWindow(tab.id)}
          onAddToConversation={() => onAddToConversation(tab.id)}
          onPinnedChange={(pinned) => onPinnedChange(tab.id, pinned)}
          onClose={() => onCloseTab(tab.id)}
          onCloseOthers={() => onCloseTabs(otherClosableTabs.map((item) => item.id))}
          onCloseAll={onCloseAllTabs}
        />
      </ContextMenu.Root>
    );
  };
  return (
    <div
      className={`flex h-full min-h-0 flex-col ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS}`}
    >
      <div
        ref={previewTabbarRef}
        className={`flex ${WORKSPACE_PANEL_TOPBAR_HEIGHT_CLASS} shrink-0 items-stretch ${WORKSPACE_PANEL_HEADER_BORDER_CLASS} ${WORKSPACE_PANEL_HEADER_SURFACE_CLASS}`}
        data-testid="user-space-preview-tabbar"
        onClickCapture={suppressPreviewTabReleaseEvent}
        onFocusCapture={suppressPreviewTabReleaseEvent}
        onMouseUpCapture={suppressPreviewTabReleaseEvent}
        onPointerUpCapture={suppressPreviewTabReleaseEvent}
        onPointerLeave={() => {
          if (!dragStateActive) setPreviewTabHoverSuppressed(false);
        }}
      >
        <button
          type="button"
          data-testid="preview-space-panel-toggle"
          aria-label={
            spacePanelCollapsed ? workspaceCopy.expandSpacePanel : workspaceCopy.collapseSpacePanel
          }
          title={
            spacePanelCollapsed ? workspaceCopy.expandSpacePanel : workspaceCopy.collapseSpacePanel
          }
          aria-pressed={spacePanelCollapsed}
          onClick={() => onSpacePanelCollapsedChange(!spacePanelCollapsed)}
          className={`my-1 ml-2 mr-1 flex h-8 w-8 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
        >
          {spacePanelCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        {pinnedDockedTabs.length > 0 && (
          <div
            ref={pinnedGroupRef}
            className="relative flex shrink-0 items-stretch p-1 pr-0"
            data-testid="preview-pinned-tab-group"
            onPointerEnter={() => setPinnedGroupHovered(true)}
            onPointerLeave={() => setPinnedGroupHovered(false)}
            onPointerCancel={() => {
              setPinnedGroupHovered(false);
              setPinnedGroupContextMenuOpen(false);
            }}
          >
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <button
                  type="button"
                  data-testid="preview-pinned-tab-group-toggle"
                  className={`flex h-full shrink-0 items-center gap-0.5 ${WORKSPACE_CONTROL_RADIUS_CLASS} px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-accent data-[state=open]:text-foreground ${
                    activeTab?.pinned ? "bg-accent text-foreground" : ""
                  }`}
                  aria-label={
                    pinnedGroupOpen
                      ? workspaceCopy.collapsePinnedPreviewTabs
                      : workspaceCopy.expandPinnedPreviewTabs
                  }
                  title={
                    pinnedGroupOpen
                      ? workspaceCopy.collapsePinnedPreviewTabs
                      : workspaceCopy.expandPinnedPreviewTabs
                  }
                  aria-expanded={pinnedGroupOpen}
                >
                  <Pin className="h-3.5 w-3.5" aria-hidden={true} />
                  <span className="min-w-3 text-center text-[13px] tabular-nums" aria-hidden={true}>
                    {pinnedDockedTabs.length}
                  </span>
                  {pinnedGroupOpen ? (
                    <ChevronUp className="h-3 w-3" aria-hidden={true} />
                  ) : (
                    <ChevronDown className="h-3 w-3" aria-hidden={true} />
                  )}
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content
                  className="piwork-dropdown-motion piwork-superellipse-panel z-[var(--piwork-z-popover)] min-w-[190px] rounded-[var(--piwork-panel-radius)] border border-border bg-card p-1 outline-none"
                  collisionPadding={8}
                >
                  <PreviewTabContextMenuItem icon={PinOff} onSelect={onUnpinAll}>
                    {workspaceCopy.unpinAllPreviewTabs}
                  </PreviewTabContextMenuItem>
                  <PreviewTabContextMenuItem icon={ListX} onSelect={onCloseAllPinned}>
                    {workspaceCopy.closeAllPinnedPreviewTabs}
                  </PreviewTabContextMenuItem>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
            {pinnedGroupOpen && (
              <div
                className="piwork-superellipse-panel absolute left-1 top-full z-[var(--piwork-z-popover)] flex w-[220px] flex-col gap-1 rounded-[var(--piwork-panel-radius)] border border-border bg-card p-1"
                data-testid="preview-pinned-tab-list"
              >
                {pinnedDockedTabs.map((tab) =>
                  renderPreviewTab(tab, {
                    vertical: true,
                    onContextMenuOpenChange: setPinnedGroupContextMenuOpen,
                  }),
                )}
              </div>
            )}
          </div>
        )}
        <div
          ref={previewTabScrollRef}
          className="piwork-scrollbar-hidden flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto p-1"
          data-testid="user-space-preview-tab-scroll"
        >
          {unpinnedDockedTabs.map((tab) => {
            const TabIcon = previewTabIcon(tab);
            const closableTabs = tabs.filter((item) => !item.pinned);
            const otherClosableTabs = closableTabs.filter((item) => item.id !== tab.id);
            return (
              <ContextMenu.Root key={tab.id}>
                <ContextMenu.Trigger asChild>
                  <div
                    data-testid={`preview-tab-${tab.id}`}
                    data-preview-tab-id={tab.id}
                    draggable={false}
                    onPointerDown={(event) => startPreviewTabPointerDrag(event, tab.id)}
                    className={`piwork-context-target-trigger group/tab relative flex h-full max-w-[190px] shrink-0 items-center rounded-[var(--piwork-control-radius)] border border-border text-sm transition-none ${
                      tab.id === activeTab?.id
                        ? "bg-accent text-foreground"
                        : `bg-transparent ${WORKSPACE_SELECTABLE_TEXT_CLASS} ${previewTabHoverSuppressed ? "" : "hover:bg-accent"}`
                    } data-[state=open]:bg-accent data-[state=open]:text-foreground`}
                  >
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        if (shouldSuppressPreviewTabClick(tab.id)) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.blur();
                          blurPreviewTabFocus();
                          return;
                        }
                        onSelectTab(tab.id);
                      }}
                      className="absolute inset-0 z-0 cursor-default border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      title={tab.title}
                      aria-label={workspaceCopy.previewTab(tab.title)}
                    />
                    <span
                      className="pointer-events-none relative z-10 ml-1.5 flex h-6 w-6 shrink-0 items-center justify-center"
                      data-testid={`preview-tab-icon-${tab.id}`}
                      aria-hidden="true"
                    >
                      <TabIcon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
                    </span>
                    <span
                      className="pointer-events-none relative z-10 min-w-0 flex-1 truncate px-1 text-left font-medium"
                      title={tab.title}
                    >
                      {tab.title}
                    </span>
                    <button
                      type="button"
                      data-preview-tab-close=""
                      onPointerUp={(event) => {
                        if (event.button !== 0 || tab.hasUnsavedChanges) return;
                        disposeOfficePreview(tab.id);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className={`relative z-20 mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        previewTabHoverSuppressed ? "" : "group-hover/tab:opacity-100"
                      }`}
                      aria-label={workspaceCopy.closePreview(tab.title)}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {tab.hasUnsavedChanges && (
                      <span
                        className={`pointer-events-none absolute right-2.5 top-1/2 z-10 h-2 w-2 -translate-y-1/2 rounded-full bg-muted-foreground ${
                          previewTabHoverSuppressed ? "" : "group-hover/tab:opacity-0"
                        }`}
                        data-testid={`preview-tab-dirty-${tab.id}`}
                        aria-hidden="true"
                      />
                    )}
                    {previewTabInsertionTarget?.tabId === tab.id && draggingTabId !== tab.id && (
                      <span
                        className={`pointer-events-none absolute bottom-1 top-1 z-30 w-0.5 rounded-full bg-preview-drop-indicator ${
                          previewTabInsertionTarget.edge === "before"
                            ? "left-0 -translate-x-1/2"
                            : "right-0 translate-x-1/2"
                        }`}
                        data-testid="preview-tab-drop-indicator"
                        data-drop-edge={previewTabInsertionTarget.edge}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                </ContextMenu.Trigger>
                <PreviewTabContextMenu
                  showAddToConversation={Boolean(
                    tab.mountId && !isAgentPreviewTabId(tab.id) && !isWtermPreviewTabId(tab.id),
                  )}
                  pinned={Boolean(tab.pinned)}
                  showCloseCurrent={!tab.pinned}
                  showCloseOthers={otherClosableTabs.length > 0}
                  showCloseAll={closableTabs.length > 1}
                  onOpenInNewWindow={() => void openDetachedPreviewWindow(tab.id)}
                  onAddToConversation={() => onAddToConversation(tab.id)}
                  onPinnedChange={(pinned) => onPinnedChange(tab.id, pinned)}
                  onClose={() => onCloseTab(tab.id)}
                  onCloseOthers={() => onCloseTabs(otherClosableTabs.map((item) => item.id))}
                  onCloseAll={onCloseAllTabs}
                />
              </ContextMenu.Root>
            );
          })}
        </div>
        <button
          type="button"
          data-testid="preview-session-panel-toggle"
          aria-label={
            sessionPanelCollapsed
              ? workspaceCopy.expandSessionPanel
              : workspaceCopy.collapseSessionPanel
          }
          title={
            sessionPanelCollapsed
              ? workspaceCopy.expandSessionPanel
              : workspaceCopy.collapseSessionPanel
          }
          aria-pressed={sessionPanelCollapsed}
          onClick={() => onSessionPanelCollapsedChange(!sessionPanelCollapsed)}
          className={`my-1 ml-1 mr-2 flex h-8 w-8 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
        >
          {sessionPanelCollapsed ? (
            <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelRightClose className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      <div
        ref={previewBodyRef}
        className={`relative min-h-0 flex-1 overflow-hidden ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS}`}
        data-testid="user-space-preview-body-area"
        onDragOver={handlePreviewBodyDragOver}
        onDragLeave={handlePreviewBodyDragLeave}
        onDrop={handlePreviewBodyDrop}
      >
        {tabs.length === 0 ? (
          <WorkspacePreviewBody uiLanguage={uiLanguage} previewVisible={previewVisible} />
        ) : (
          previewBodyTabs.map((tab) => {
            const agentTab = isAgentPreviewTabId(tab.id);
            const detachedRecord = detachedPreviewByTabId.get(tab.id);
            const tabIsDetached = Boolean(detachedRecord);
            const tabIsActive = !tabIsDetached && tab.id === activeTab?.id;
            const preserveOfficeSurface = isOfficePreviewState(tab.state);
            const textToolbar = agentTab ? undefined : textToolbarByTabId.get(tab.id);
            return (
              <div
                key={tab.id}
                ref={(node) => {
                  if (node) previewSurfaceByTabIdRef.current.set(tab.id, node);
                  else previewSurfaceByTabIdRef.current.delete(tab.id);
                }}
                data-testid={`preview-body-${tab.id}`}
                data-preview-surface-owner={tabIsDetached ? "detached" : "tab-group"}
                className={
                  tabIsDetached || tabIsActive
                    ? `absolute inset-0 flex min-h-0 flex-col overflow-hidden ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS}`
                    : preserveOfficeSurface
                      ? `pointer-events-none absolute inset-0 flex min-h-0 flex-col overflow-hidden opacity-0 ${WORKSPACE_PANEL_BG_CLASS} ${WORKSPACE_PANEL_BODY_TEXT_CLASS}`
                      : "hidden"
                }
                aria-hidden={tabIsDetached || tabIsActive ? undefined : true}
                inert={!tabIsDetached && !tabIsActive ? true : undefined}
              >
                <PreviewFileToolbar
                  uiLanguage={uiLanguage}
                  tab={tab}
                  state={tab.state}
                  textToolbar={textToolbar}
                  canSwitchView={!tabIsDetached && tabIsActive && canSwitchView}
                  onViewModeChange={onViewModeChange}
                  onOpenInNewWindow={
                    !tabIsDetached ? () => openDetachedPreviewWindow(tab.id) : undefined
                  }
                  onReturnToTabGroup={
                    detachedRecord
                      ? () => restoreDetachedPreviewWindow(detachedRecord.id)
                      : undefined
                  }
                  testId={
                    tabIsDetached
                      ? "detached-preview-window-header"
                      : tabIsActive
                        ? "user-space-preview-toolbar"
                        : null
                  }
                  filenameTestId={
                    tabIsDetached
                      ? "detached-preview-window-header-filename"
                      : tabIsActive
                        ? "user-space-preview-toolbar-filename"
                        : null
                  }
                />
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <WorkspacePreviewBody
                    key={
                      isOfficePreviewState(tab.state)
                        ? `${tab.id}:${tabIsDetached ? "detached" : "docked"}`
                        : tab.id
                    }
                    uiLanguage={uiLanguage}
                    tab={tab}
                    mount={mountsById.get(tab.mountId)}
                    previewVisible={tabIsDetached || (previewVisible && tabIsActive)}
                    detached={tabIsDetached}
                    onSaveTextContent={agentTab ? undefined : onSaveTextContent}
                    onSaveImageFile={agentTab ? undefined : onSaveImageFile}
                    waitForWorkspaceMutation={agentTab ? undefined : waitForWorkspaceMutation}
                    resolvePreviewTabPath={agentTab ? undefined : resolvePreviewTabPath}
                    onUnsavedChange={agentTab ? undefined : onUnsavedChange}
                    onEditingChange={agentTab ? undefined : onEditingChange}
                    onTextEditorToolbarChange={agentTab ? undefined : handleTextToolbarChange}
                    onOfficeFileMigration={agentTab ? undefined : onOfficeFileMigration}
                    onOfficeFileCreated={agentTab ? undefined : onOfficeFileCreated}
                    onOfficeFileSaved={agentTab ? undefined : onOfficeFileSaved}
                  />
                </div>
              </div>
            );
          })
        )}
        {draggingTabId && (
          <div
            className={`z-40 ${
              previewBodyDragActive
                ? `${PREVIEW_BLUR_MASK_CLASS} flex items-center justify-center text-sm font-medium text-foreground`
                : "absolute inset-0 bg-transparent"
            }`}
            data-testid={
              previewBodyDragActive
                ? "user-space-preview-popout-dropzone"
                : "user-space-preview-pointer-shield"
            }
            onDragOver={handlePreviewBodyDragOver}
            onDragLeave={handlePreviewBodyDragLeave}
            onDrop={handlePreviewBodyDrop}
          >
            {previewBodyDragActive && (
              <span className="rounded-full border border-border bg-card px-3 py-1.5">
                {workspaceCopy.popOutPreviewDropHint}
              </span>
            )}
          </div>
        )}
      </div>
      {detachedPreviewWindows.map((record) => {
        const tab = tabs.find((item) => item.id === record.tabId);
        if (!tab) return null;
        return (
          <DetachedPreviewWindow
            key={record.id}
            record={record}
            tab={tab}
            uiLanguage={uiLanguage}
            onClosed={closeDetachedPreviewWindow}
          />
        );
      })}
      {previewTabDragProxy &&
        (() => {
          const tab = tabs.find((item) => item.id === previewTabDragProxy.tabId);
          if (!tab) return null;
          const TabIcon = previewTabIcon(tab);
          return (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[var(--piwork-z-toast)] flex -translate-x-1/2 -translate-y-1/2 items-center overflow-hidden rounded-[var(--piwork-control-radius)] border-0 bg-accent text-sm text-foreground transition-none"
              data-testid="preview-tab-drag-proxy"
              style={{
                left: previewTabDragProxy.x,
                top: previewTabDragProxy.y,
                width: previewTabDragProxy.width,
                height: previewTabDragProxy.height,
              }}
            >
              <span className="pointer-events-none relative z-10 ml-1.5 flex h-6 w-6 shrink-0 items-center justify-center">
                <TabIcon className="h-5 w-5 shrink-0 object-contain" aria-hidden={true} />
              </span>
              <span className="pointer-events-none relative z-10 min-w-0 flex-1 truncate px-1 text-left font-medium">
                {tab.title}
              </span>
              <span
                className="pointer-events-none relative z-10 mr-0.5 h-5 w-5 shrink-0 opacity-0"
                aria-hidden="true"
              />
            </div>
          );
        })()}
    </div>
  );
});

const DETACHED_PREVIEW_ROOT_ID = "piwork-detached-preview-root";

function PreviewFileToolbar({
  uiLanguage: _uiLanguage,
  tab,
  state,
  textToolbar,
  canSwitchView = false,
  onViewModeChange,
  onOpenInNewWindow,
  onReturnToTabGroup,
  testId = "user-space-preview-toolbar",
  filenameTestId = "user-space-preview-toolbar-filename",
}: {
  uiLanguage: UiLanguage;
  tab: PreviewTab;
  state: PreviewState;
  textToolbar?: TextEditorToolbarState;
  canSwitchView?: boolean;
  onViewModeChange?: (tabId: string, viewMode: PreviewViewMode) => void;
  onOpenInNewWindow?: () => void;
  onReturnToTabGroup?: () => void;
  testId?: string | null;
  filenameTestId?: string | null;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const showEditorToolbar = Boolean(
    textToolbar &&
    state.status === "ready" &&
    (state.kind === "text" ||
      state.kind === "html" ||
      state.kind === "markdown" ||
      state.kind === "image"),
  );
  const showDocumentViewSwitch = Boolean(canSwitchView && onViewModeChange);
  const showEditorTools = Boolean(
    showEditorToolbar &&
    textToolbar?.editing &&
    state.status === "ready" &&
    (state.kind === "markdown" || state.kind === "image"),
  );
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !onReturnToTabGroup) return undefined;
    const handleDetachedToolbarClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const action = target?.closest?.<HTMLElement>("[data-detached-preview-action]")?.dataset
        .detachedPreviewAction;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "edit") textToolbar?.onStartEditing();
      else if (action === "save") textToolbar?.onFinishEditing();
      else if (action === "return") onReturnToTabGroup();
    };
    toolbar.addEventListener("click", handleDetachedToolbarClick);
    return () => toolbar.removeEventListener("click", handleDetachedToolbarClick);
  }, [onReturnToTabGroup, textToolbar]);
  return (
    <div
      ref={toolbarRef}
      className={`flex ${WORKSPACE_PANEL_TOPBAR_HEIGHT_CLASS} shrink-0 items-center gap-2 py-1 ${showEditorTools ? "pl-2" : "pl-4"} pr-2 ${WORKSPACE_PANEL_HEADER_BORDER_CLASS} ${WORKSPACE_PANEL_HEADER_SURFACE_CLASS}`}
      data-testid={testId || undefined}
    >
      {showEditorTools ? (
        <div
          id={editorToolbarPortalId(tab.id)}
          className="piwork-editor-toolbar-slot min-w-0 flex-1 self-stretch overflow-hidden"
          data-testid="user-space-preview-editor-toolbar-slot"
        />
      ) : (
        <div
          className="min-w-0 flex-1 truncate pr-3 text-left text-sm font-semibold leading-5 text-foreground"
          title={tab.title}
          data-testid={filenameTestId || undefined}
        >
          {tab.title}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {showEditorToolbar && textToolbar?.message && (
          <span
            className={`max-w-[180px] truncate ${PREVIEW_TOOLBAR_ACTION_TEXT_CLASS} text-muted-foreground`}
            title={textToolbar.message}
          >
            {textToolbar.message}
          </span>
        )}
        <div className="flex items-center gap-1">
          {showEditorToolbar &&
            !showDocumentViewSwitch &&
            textToolbar &&
            (!textToolbar.editing ? (
              <button
                type="button"
                onClick={onReturnToTabGroup ? undefined : textToolbar.onStartEditing}
                data-detached-preview-action={onReturnToTabGroup ? "edit" : undefined}
                disabled={!textToolbar.canEdit}
                title={textToolbar.editActionTitle}
                aria-label={uiCopy.common.edit}
                className={PREVIEW_TOOLBAR_BUTTON_CLASS}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onReturnToTabGroup ? undefined : textToolbar.onFinishEditing}
                data-detached-preview-action={onReturnToTabGroup ? "save" : undefined}
                disabled={!textToolbar.canEdit || textToolbar.saving}
                title={textToolbar.saving ? uiCopy.common.saving : uiCopy.common.save}
                aria-label={uiCopy.common.save}
                className={PREVIEW_TOOLBAR_BUTTON_CLASS}
              >
                <Save className="size-4" aria-hidden="true" />
              </button>
            ))}
          {showDocumentViewSwitch && onViewModeChange && (
            <div className="flex items-center gap-1" data-testid="user-space-preview-view-switch">
              <button
                type="button"
                onClick={() => onViewModeChange(tab.id, "preview")}
                className={`h-7 ${WORKSPACE_CONTROL_RADIUS_CLASS} px-2 ${PREVIEW_TOOLBAR_ACTION_TEXT_CLASS} transition-colors ${
                  tab.viewMode === "preview" ? "text-foreground" : WORKSPACE_SELECTABLE_TEXT_CLASS
                }`}
              >
                {uiCopy.common.preview}
              </button>
              <span
                className={`select-none ${PREVIEW_TOOLBAR_ACTION_TEXT_CLASS} text-muted-foreground/40`}
                aria-hidden="true"
              >
                ｜
              </span>
              {textToolbar?.editing ? (
                <button
                  type="button"
                  onClick={onReturnToTabGroup ? undefined : textToolbar.onFinishEditing}
                  data-detached-preview-action={onReturnToTabGroup ? "save" : undefined}
                  disabled={!textToolbar.canEdit || textToolbar.saving}
                  title={textToolbar.saving ? uiCopy.common.saving : uiCopy.common.save}
                  aria-label={uiCopy.common.save}
                  className={PREVIEW_TOOLBAR_BUTTON_CLASS}
                >
                  <Save className="size-4" aria-hidden="true" />
                </button>
              ) : tab.viewMode === "text" && textToolbar ? (
                <button
                  type="button"
                  onClick={onReturnToTabGroup ? undefined : textToolbar.onStartEditing}
                  data-detached-preview-action={onReturnToTabGroup ? "edit" : undefined}
                  disabled={!textToolbar.canEdit}
                  title={textToolbar.editActionTitle}
                  aria-label={uiCopy.common.edit}
                  className={PREVIEW_TOOLBAR_BUTTON_CLASS}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onViewModeChange(tab.id, "text")}
                  className={`h-7 ${WORKSPACE_CONTROL_RADIUS_CLASS} px-2 ${PREVIEW_TOOLBAR_ACTION_TEXT_CLASS} ${WORKSPACE_SELECTABLE_TEXT_CLASS} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
                >
                  {uiCopy.common.text}
                </button>
              )}
            </div>
          )}
          {onOpenInNewWindow && (
            <button
              type="button"
              onClick={onOpenInNewWindow}
              title={workspaceCopy.openPreviewInNewWindow}
              aria-label={workspaceCopy.openPreviewInNewWindow}
              className={`ml-1 flex size-[var(--piwork-titlebar-control-size)] items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
              data-testid="preview-open-in-new-window"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </button>
          )}
          {onReturnToTabGroup && (
            <button
              type="button"
              data-detached-preview-action="return"
              title={workspaceCopy.returnPreviewToTabs}
              aria-label={workspaceCopy.returnPreviewToTabs}
              className={`ml-1 flex size-[var(--piwork-titlebar-control-size)] items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
              data-testid="detached-preview-return-to-tabs"
            >
              <PanelTopOpen className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const DetachedPreviewWindow = memo(function DetachedPreviewWindow({
  record,
  tab,
  uiLanguage,
  onClosed,
}: {
  record: DetachedPreviewWindowRecord;
  tab: PreviewTab;
  uiLanguage: UiLanguage;
  onClosed: (windowId: string) => void;
}) {
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const uiLanguageRef = useRef(uiLanguage);
  uiLanguageRef.current = uiLanguage;

  useEffect(() => {
    if (record.win.closed) {
      if (!record.closeIntent) onClosed(record.id);
      return undefined;
    }
    const root = prepareDetachedPreviewWindow(record.win, tab.title);
    if (!root) {
      onClosed(record.id);
      return undefined;
    }
    setPortalRoot(root);
    const detachDocumentSync = attachDetachedPreviewDocumentSync(
      record.win.document,
      () => uiLanguageRef.current,
    );
    record.win.focus();
    const handleBeforeUnload = () => {
      if (!record.closeIntent) onClosed(record.id);
    };
    record.win.addEventListener("beforeunload", handleBeforeUnload);
    const closedPollId = window.setInterval(() => {
      if (record.win.closed && !record.closeIntent) onClosed(record.id);
    }, 1_000);
    return () => {
      detachDocumentSync();
      window.clearInterval(closedPollId);
      record.win.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [onClosed, record.closeIntent, record.id, record.win, tab.title]);

  useEffect(() => {
    if (record.win.closed) return;
    record.win.document.title = detachedPreviewWindowTitle(tab.title);
    syncDetachedPreviewAppearance(record.win.document, uiLanguage);
  }, [record.win, tab.title, uiLanguage]);

  if (!portalRoot) return null;
  return createPortal(<span hidden data-piwork-detached-preview-event-root="true" />, portalRoot);
});

function detachedPreviewWindowTitle(title: string): string {
  return `${title} - ${workspaceCopy.filePreview}`;
}

function prepareDetachedPreviewWindow(targetWindow: Window, title: string): HTMLElement | null {
  const targetDocument = targetWindow.document;
  if (!targetDocument?.head || !targetDocument.body) return null;
  targetDocument.title = detachedPreviewWindowTitle(title);
  syncDetachedPreviewAppearance(targetDocument);
  targetDocument.body.style.margin = "0";
  targetDocument.body.style.width = "100vw";
  targetDocument.body.style.height = "100vh";
  targetDocument.body.style.overflow = "hidden";

  if (!targetDocument.head.querySelector("[data-piwork-detached-preview-base]")) {
    const baseStyle = targetDocument.createElement("style");
    baseStyle.dataset.piworkDetachedPreviewBase = "true";
    baseStyle.textContent = `
      html, body, #${DETACHED_PREVIEW_ROOT_ID} {
        width: 100%;
        height: 100%;
        min-height: 0;
      }
      body {
        background: var(--background);
      }
    `;
    targetDocument.head.appendChild(baseStyle);
  }

  syncDetachedPreviewStyles(targetDocument);

  let root = targetDocument.getElementById(DETACHED_PREVIEW_ROOT_ID);
  if (!root) {
    root = targetDocument.createElement("div");
    root.id = DETACHED_PREVIEW_ROOT_ID;
    targetDocument.body.replaceChildren(root);
  }
  root.className = "h-screen min-h-0 bg-background text-foreground";
  return root;
}

function syncDetachedPreviewAppearance(targetDocument: Document, uiLanguage?: UiLanguage): void {
  const sourceRoot = document.documentElement;
  const targetRoot = targetDocument.documentElement;
  targetRoot.className = sourceRoot.className;
  for (const attribute of Array.from(targetRoot.attributes)) {
    if (attribute.name.startsWith("data-") && !sourceRoot.hasAttribute(attribute.name)) {
      targetRoot.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(sourceRoot.attributes)) {
    if (attribute.name.startsWith("data-"))
      targetRoot.setAttribute(attribute.name, attribute.value);
  }
  targetRoot.lang = uiLanguage || sourceRoot.lang;
  if (sourceRoot.hasAttribute("dir"))
    targetRoot.setAttribute("dir", sourceRoot.getAttribute("dir") || "");
  else targetRoot.removeAttribute("dir");
  targetRoot.style.cssText = sourceRoot.style.cssText;
  targetDocument.body.className = document.body.className;
}

function syncDetachedPreviewStyles(targetDocument: Document): void {
  for (const current of Array.from(
    targetDocument.head.querySelectorAll("[data-piwork-detached-preview-styles]"),
  )) {
    current.remove();
  }
  for (const source of Array.from(
    document.head.querySelectorAll<HTMLLinkElement | HTMLStyleElement>(
      "link[rel='stylesheet'], style",
    ),
  )) {
    const clone = source.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
    clone.dataset.piworkDetachedPreviewStyles = "true";
    if (source instanceof HTMLLinkElement && clone instanceof HTMLLinkElement)
      clone.href = source.href;
    targetDocument.head.appendChild(clone);
  }
}

function attachDetachedPreviewDocumentSync(
  targetDocument: Document,
  getUiLanguage: () => UiLanguage,
): () => void {
  let disposed = false;
  let stylesScheduled = false;
  const syncAppearance = () => {
    if (!disposed) syncDetachedPreviewAppearance(targetDocument, getUiLanguage());
  };
  const scheduleStyles = () => {
    if (disposed || stylesScheduled) return;
    stylesScheduled = true;
    queueMicrotask(() => {
      stylesScheduled = false;
      if (!disposed) syncDetachedPreviewStyles(targetDocument);
    });
  };
  const appearanceObserver = new MutationObserver(syncAppearance);
  appearanceObserver.observe(document.documentElement, { attributes: true });
  appearanceObserver.observe(document.body, { attributes: true });
  const styleObserver = new MutationObserver(scheduleStyles);
  styleObserver.observe(document.head, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return () => {
    disposed = true;
    appearanceObserver.disconnect();
    styleObserver.disconnect();
  };
}

function PreviewTabContextMenu({
  showAddToConversation,
  pinned,
  showCloseCurrent,
  showCloseOthers,
  showCloseAll,
  onOpenInNewWindow,
  onAddToConversation,
  onPinnedChange,
  onClose,
  onCloseOthers,
  onCloseAll,
}: {
  showAddToConversation: boolean;
  pinned: boolean;
  showCloseCurrent: boolean;
  showCloseOthers: boolean;
  showCloseAll: boolean;
  onOpenInNewWindow: () => void;
  onAddToConversation: () => void;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        className="piwork-dropdown-motion piwork-superellipse-panel z-[var(--piwork-z-popover)] min-w-[190px] rounded-[var(--piwork-panel-radius)] border border-border bg-card p-1 outline-none"
        collisionPadding={8}
      >
        <PreviewTabContextMenuItem icon={ExternalLink} onSelect={onOpenInNewWindow}>
          {workspaceCopy.openPreviewInNewWindow}
        </PreviewTabContextMenuItem>
        {showAddToConversation && (
          <PreviewTabContextMenuItem icon={AtSign} onSelect={onAddToConversation}>
            {workspaceCopy.contextMenu.addToConversation}
          </PreviewTabContextMenuItem>
        )}
        <PreviewTabContextMenuItem
          icon={pinned ? PinOff : Pin}
          onSelect={() => onPinnedChange(!pinned)}
        >
          {pinned ? workspaceCopy.unpinPreviewTab : workspaceCopy.pinPreviewTab}
        </PreviewTabContextMenuItem>
        <ContextMenu.Separator className="my-1 h-px bg-border/80" />
        {showCloseCurrent && !showCloseOthers && !showCloseAll ? (
          <PreviewTabContextMenuItem icon={X} onSelect={onClose}>
            {workspaceCopy.closeCurrentPreviewTab}
          </PreviewTabContextMenuItem>
        ) : showCloseCurrent || showCloseOthers || showCloseAll ? (
          <>
            {showCloseCurrent && (
              <PreviewTabContextMenuItem icon={X} onSelect={onClose}>
                {workspaceCopy.closeCurrentPreviewTab}
              </PreviewTabContextMenuItem>
            )}
            {showCloseOthers && (
              <PreviewTabContextMenuItem icon={CircleX} onSelect={onCloseOthers}>
                {workspaceCopy.closeOtherPreviewTabs}
              </PreviewTabContextMenuItem>
            )}
            {showCloseAll && (
              <PreviewTabContextMenuItem icon={ListX} onSelect={onCloseAll}>
                {workspaceCopy.closeAllPreviewTabs}
              </PreviewTabContextMenuItem>
            )}
          </>
        ) : null}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

function PreviewTabContextMenuItem({
  icon: Icon,
  children,
  onSelect,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      className={`flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-[var(--piwork-control-radius)] px-2.5 text-[13px] font-medium ${WORKSPACE_SELECTABLE_TEXT_CLASS} outline-none transition-colors hover:bg-accent focus:bg-accent data-[highlighted]:bg-accent`}
      onSelect={onSelect}
    >
      {Icon ? (
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden={true} />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" aria-hidden={true} />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenu.Item>
  );
}

function previewTabIcon(tab: PreviewTab) {
  if (isWtermPreviewTabId(tab.id)) return SquareTerminal;
  return iconForWorkspaceEntry({
    name: tab.title,
    path: tab.path,
    kind: "file",
    previewKind: previewKindForTabState(tab.state),
  });
}

function previewKindForTabState(state: PreviewState): WorkspaceEntry["previewKind"] | undefined {
  if (state.status !== "ready") return undefined;
  if (
    state.kind === "image" ||
    state.kind === "audio" ||
    state.kind === "video" ||
    state.kind === "pdf" ||
    state.kind === "office" ||
    state.kind === "binary"
  )
    return state.kind;
  return "text";
}

const WorkspacePreviewBody = memo(function WorkspacePreviewBody({
  uiLanguage,
  tab,
  mount,
  previewVisible = true,
  detached = false,
  onSaveTextContent,
  onSaveImageFile,
  waitForWorkspaceMutation,
  resolvePreviewTabPath,
  onUnsavedChange,
  onEditingChange,
  onTextEditorToolbarChange,
  initialEditing = false,
  onOfficeFileMigration,
  onOfficeFileCreated,
  onOfficeFileSaved,
  searchHighlightQuery = "",
}: {
  uiLanguage: UiLanguage;
  tab?: PreviewTab;
  mount?: UserSpaceMount;
  previewVisible?: boolean;
  detached?: boolean;
  onSaveTextContent?: (tabId: string, content: string) => Promise<void>;
  onSaveImageFile?: (tabId: string, file: File) => Promise<void>;
  waitForWorkspaceMutation?: () => Promise<void>;
  resolvePreviewTabPath?: (tabId: string) => string | undefined;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
  onEditingChange?: (tabId: string, isEditing: boolean) => void;

  onTextEditorToolbarChange?: (tabId: string, state: TextEditorToolbarState | null) => void;
  initialEditing?: boolean;
  onOfficeFileMigration?: (migration: OfficeFileMigration) => void;
  onOfficeFileCreated?: (created: OfficeFileCreated) => void;
  onOfficeFileSaved?: (saved: OfficeFileSaved) => void;
  searchHighlightQuery?: string;
}) {
  const preview = tab?.state || { status: "empty" as const };
  if (preview.status === "empty") return null;
  if (preview.status === "loading") {
    return OFFICE_EXTENSIONS.has(getExtension(preview.path)) ? (
      <OfficeLoadingState />
    ) : (
      <PreviewLoadingState />
    );
  }
  if (preview.status === "error") {
    if (preview.messageKey === "unsupportedPreview") {
      return <UnsupportedPreviewDetails path={preview.path} size={preview.size} />;
    }
    return <PreviewNoticeBanner>{previewErrorMessage(preview)}</PreviewNoticeBanner>;
  }
  if (preview.kind === "image") {
    return (
      <ImagePreview
        uiLanguage={uiLanguage}
        tab={tab}
        mount={mount}
        preview={preview as ImagePreviewState}
        onSaveImageFile={onSaveImageFile}
        onUnsavedChange={onUnsavedChange}
        onEditingChange={onEditingChange}
        onEditorToolbarChange={onTextEditorToolbarChange}
      />
    );
  }
  if (preview.kind === "audio" || preview.kind === "video") {
    return <MediaPreview uiLanguage={uiLanguage} preview={preview as MediaPreviewState} />;
  }
  if (preview.kind === "pdf") {
    return (
      <iframe
        title={workspaceCopy.pdfPreviewTitle(preview.name)}
        src={preview.objectUrl}
        className="h-full min-h-[260px] w-full border-0 bg-background"
      />
    );
  }
  if (preview.kind === "wterm") {
    return (
      <WtermPreview
        key={`${mount?.mountId || "unmounted"}:${mount?.rootName || mount?.name || ""}`}
        mount={mount}
        visible={previewVisible}
      />
    );
  }
  if (preview.kind === "html") {
    if (
      (tab?.viewMode === "text" || searchHighlightQuery.trim()) &&
      preview.textContent !== undefined
    ) {
      return (
        <TextEditorPreview
          uiLanguage={uiLanguage}
          tab={tab}
          mount={mount}
          preview={preview as EditablePreviewState}
          onSaveTextContent={onSaveTextContent}
          onUnsavedChange={onUnsavedChange}
          onEditingChange={onEditingChange}
          onTextEditorToolbarChange={onTextEditorToolbarChange}
          initialEditing={initialEditing}
          searchHighlightQuery={searchHighlightQuery}
        />
      );
    }
    return (
      <NativeFramePreview
        uiLanguage={uiLanguage}
        name={preview.name}
        src={preview.objectUrl}
        title={workspaceCopy.htmlPreviewTitle(preview.name)}
        sandbox
        truncated={preview.truncated}
      />
    );
  }
  if (isMarkdownPreviewState(preview)) {
    if (searchHighlightQuery.trim()) {
      return (
        <TextEditorPreview
          uiLanguage={uiLanguage}
          tab={tab}
          mount={mount}
          preview={preview as EditablePreviewState}
          searchHighlightQuery={searchHighlightQuery}
        />
      );
    }
    return (
      <MarkdownPreview
        uiLanguage={uiLanguage}
        tab={tab}
        preview={preview}
        mount={mount}
        onSaveTextContent={onSaveTextContent}
        onUnsavedChange={onUnsavedChange}
        onEditingChange={onEditingChange}
        onTextEditorToolbarChange={onTextEditorToolbarChange}
        initialEditing={initialEditing}
        detached={detached}
      />
    );
  }
  if (preview.kind === "text") {
    return (
      <TextEditorPreview
        uiLanguage={uiLanguage}
        tab={tab}
        mount={mount}
        preview={preview as EditablePreviewState}
        onSaveTextContent={onSaveTextContent}
        onUnsavedChange={onUnsavedChange}
        onEditingChange={onEditingChange}
        onTextEditorToolbarChange={onTextEditorToolbarChange}
        initialEditing={initialEditing}
        searchHighlightQuery={searchHighlightQuery}
      />
    );
  }
  if (isOfficePreviewState(preview)) {
    return (
      <OfficePreview
        tabId={tab?.id || preview.path}
        mount={mount}
        preview={preview}
        foreground={previewVisible}
        waitForWorkspaceMutation={waitForWorkspaceMutation}
        resolvePreviewTabPath={resolvePreviewTabPath}
        onOfficeFileMigration={onOfficeFileMigration}
        onOfficeFileCreated={onOfficeFileCreated}
        onOfficeFileSaved={onOfficeFileSaved}
        onUnsavedChange={onUnsavedChange}
      />
    );
  }
  if (preview.kind === "binary") {
    return <UnsupportedPreviewDetails path={preview.path} size={preview.size} />;
  }
  return null;
});

export function WorkspaceSearchPreviewBody({
  dialog,
  mount,
  uiLanguage,
}: WorkspaceSearchPreviewRenderArgs) {
  const tab = useMemo<PreviewTab>(
    () => ({
      id: `search-preview:${mount.mountId}:${dialog.path}`,
      mountId: mount.mountId,
      path: dialog.path,
      title: previewTitleForPath(dialog.path),
      viewMode: "preview",
      state: dialog.state,
    }),
    [dialog.path, dialog.state, mount.mountId],
  );

  return (
    <WorkspacePreviewBody
      uiLanguage={uiLanguage}
      tab={tab}
      mount={mount}
      previewVisible
      searchHighlightQuery={dialog.searchQuery}
    />
  );
}

function PreviewLoadingState({
  overlay = false,
  testId = "preview-loading-state",
}: {
  overlay?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={`flex h-full min-h-[120px] items-center justify-center bg-background ${overlay ? "absolute inset-0" : ""}`}
      aria-busy="true"
      data-testid={testId}
    >
      <ProgressCircle isIndeterminate aria-label={uiCopy.common.loading}>
        <ProgressCircle.Track>
          <ProgressCircle.TrackCircle />
          <ProgressCircle.FillCircle />
        </ProgressCircle.Track>
      </ProgressCircle>
    </div>
  );
}

function OfficeLoadingState({ overlay = false }: { overlay?: boolean }) {
  return <PreviewLoadingState overlay={overlay} testId="office-loading-state" />;
}

type ImagePreviewState = ReadyPreviewState & { kind: "image" };
type MediaPreviewState = ReadyPreviewState & { kind: "audio" | "video" };
type EditablePreviewState = ReadyPreviewState & { kind: "html" | "markdown" | "text" };

const EDITABLE_IMAGE_MIME_BY_EXTENSION = new Map<string, "image/png" | "image/jpeg" | "image/webp">(
  [
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ],
);

const ImagePreview = memo(function ImagePreview({
  uiLanguage,
  tab,
  mount,
  preview,
  onSaveImageFile,
  onUnsavedChange,
  onEditingChange,
  onEditorToolbarChange,
}: {
  uiLanguage: UiLanguage;
  tab?: PreviewTab;
  mount?: UserSpaceMount;
  preview: ImagePreviewState;
  onSaveImageFile?: (tabId: string, file: File) => Promise<void>;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
  onEditingChange?: (tabId: string, isEditing: boolean) => void;
  onEditorToolbarChange?: (tabId: string, state: TextEditorToolbarState | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [editorReady, setEditorReady] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const editorRef = useRef<ImageEditorSurfaceHandle | null>(null);
  const tabId = tab?.id || "";
  const mimeType = EDITABLE_IMAGE_MIME_BY_EXTENSION.get(getExtension(preview.path));
  const canWrite = Boolean(
    mount && mount.status === "mounted" && mount.access === "readwrite" && mount.canWrite !== false,
  );
  const canEdit = canWrite && Boolean(tabId && mimeType && onSaveImageFile);
  const editActionTitle = !canWrite
    ? workspaceCopy.textSaveAction.readonly
    : !mimeType
      ? workspaceCopy.imagePreview.unsupportedFormat
      : workspaceCopy.textSaveAction.edit;

  useEffect(() => {
    setEditing(false);
    setDirty(false);
    setSaving(false);
    setMessage("");
    setEditorReady(false);
    setZoomScale(1);
  }, [preview.objectUrl]);

  useEffect(() => {
    if (tabId && onUnsavedChange) onUnsavedChange(tabId, dirty);
  }, [dirty, onUnsavedChange, tabId]);
  useEffect(
    () => () => {
      if (tabId && onUnsavedChange) onUnsavedChange(tabId, false);
    },
    [onUnsavedChange, tabId],
  );
  useEffect(() => {
    if (tabId && onEditingChange) onEditingChange(tabId, editing);
  }, [editing, onEditingChange, tabId]);

  const handleStartEditing = useCallback(() => {
    if (!canEdit) return;
    setMessage("");
    setEditorReady(false);
    setEditing(true);
  }, [canEdit]);

  const handleSave = useCallback(async () => {
    if (!tabId || !onSaveImageFile || !dirty || saving) return;
    setSaving(true);
    setMessage("");
    try {
      const file = await editorRef.current?.exportFile();
      if (!file) throw new Error(workspaceCopy.imagePreview.saveFailed);
      await onSaveImageFile(tabId, file);
      setDirty(false);
      setEditing(false);
    } catch (reason) {
      setMessage(
        reason instanceof Error && reason.message
          ? reason.message
          : workspaceCopy.imagePreview.saveFailed,
      );
    } finally {
      setSaving(false);
    }
  }, [dirty, onSaveImageFile, saving, tabId]);

  const handleFinishEditing = useCallback(() => {
    if (saving) return;
    if (dirty) void handleSave();
    else setEditing(false);
  }, [dirty, handleSave, saving]);

  useLayoutEffect(() => {
    if (!tabId || !onEditorToolbarChange) return;
    onEditorToolbarChange(tabId, {
      canEdit,
      editing,
      editActionTitle,
      message,
      saving,
      onStartEditing: handleStartEditing,
      onFinishEditing: handleFinishEditing,
    });
  }, [
    canEdit,
    editActionTitle,
    editing,
    handleFinishEditing,
    handleStartEditing,
    message,
    onEditorToolbarChange,
    saving,
    tabId,
    uiLanguage,
  ]);
  useEffect(
    () => () => {
      if (tabId && onEditorToolbarChange) onEditorToolbarChange(tabId, null);
    },
    [onEditorToolbarChange, tabId],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!editing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (dirty && !saving) void handleSave();
    },
    [dirty, editing, handleSave, saving],
  );

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      <div
        className={`piwork-image-mode-layer absolute inset-0 ${editing && editorReady ? "pointer-events-none opacity-0" : "opacity-100"}`}
        aria-hidden={editing && editorReady ? "true" : undefined}
      >
        <ImageViewer
          preview={preview}
          scale={zoomScale}
          showControls={!editing}
          onScaleChange={setZoomScale}
        />
      </div>
      {editing && mimeType && (
        <div
          className={`piwork-image-mode-layer absolute inset-0 ${editorReady ? "opacity-100" : "pointer-events-none opacity-0"}`}
          onKeyDown={handleKeyDown}
          data-testid={`image-editor-${preview.path}`}
        >
          <Suspense fallback={null}>
            <ImageEditorSurface
              ref={editorRef}
              source={preview.objectUrl}
              fileName={preview.name}
              mimeType={mimeType}
              labels={workspaceCopy.imagePreview.editor}
              onDirtyChange={setDirty}
              onReadyChange={setEditorReady}
              onZoomScaleChange={setZoomScale}
              toolbarPortalId={editorToolbarPortalId(tabId)}
              zoomScale={zoomScale}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
});

const TextEditorPreview = memo(function TextEditorPreview({
  uiLanguage,
  tab,
  mount,
  preview,
  onSaveTextContent,
  onUnsavedChange,
  onEditingChange,

  onTextEditorToolbarChange,
  initialEditing = false,
  searchHighlightQuery = "",
}: {
  uiLanguage: UiLanguage;
  tab?: PreviewTab;
  mount?: UserSpaceMount;
  preview: EditablePreviewState;
  onSaveTextContent?: (tabId: string, content: string) => Promise<void>;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
  onEditingChange?: (tabId: string, isEditing: boolean) => void;
  onTextEditorToolbarChange?: (tabId: string, state: TextEditorToolbarState | null) => void;
  initialEditing?: boolean;
  searchHighlightQuery?: string;
}) {
  const darkMode = useStore((state) => state.darkMode);
  const originalContent = preview.textContent || "";
  const [draft, setDraft] = useState(originalContent);
  const initialEditingRef = useRef(initialEditing);
  const firstContentSyncRef = useRef(true);
  const contentIdentityRef = useRef({ path: preview.path, originalContent });
  const [editing, setEditing] = useState(initialEditingRef.current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const tabId = tab?.id || "";
  const pendingLocalSaveRef = useRef<{ path: string; content: string } | null>(null);

  useEffect(() => {
    const previousIdentity = contentIdentityRef.current;
    contentIdentityRef.current = { path: preview.path, originalContent };
    if (
      previousIdentity.path !== preview.path &&
      previousIdentity.originalContent === originalContent
    ) {
      return;
    }
    const pendingLocalSave = pendingLocalSaveRef.current;
    if (pendingLocalSave?.path === preview.path && pendingLocalSave.content === originalContent) {
      pendingLocalSaveRef.current = null;
      setDraft(originalContent);
      return;
    }
    setDraft(originalContent);
    setEditing(firstContentSyncRef.current ? initialEditingRef.current : false);
    firstContentSyncRef.current = false;
    setSaving(false);
    setMessage("");
  }, [originalContent, preview.path]);

  const dirty = draft !== originalContent;
  const canWrite = Boolean(
    mount && mount.status === "mounted" && mount.access === "readwrite" && mount.canWrite !== false,
  );
  const canEdit = canWrite && !preview.truncated && Boolean(tab && onSaveTextContent);
  const readOnly = !editing || !canEdit;

  useEffect(() => {
    if (!tabId || !onUnsavedChange) return;
    onUnsavedChange(tabId, dirty);
  }, [dirty, onUnsavedChange, tabId]);

  useEffect(() => {
    if (!tabId || !onUnsavedChange) return undefined;
    return () => onUnsavedChange(tabId, false);
  }, [onUnsavedChange, tabId]);

  useEffect(() => {
    if (!tabId || !onEditingChange) return;
    onEditingChange(tabId, editing);
  }, [editing, onEditingChange, tabId]);

  useEffect(() => {
    if (!tabId || !onEditingChange) return undefined;
    return () => onEditingChange(tabId, false);
  }, [onEditingChange, tabId]);

  const handleSave = useCallback(async () => {
    if (!tab || !onSaveTextContent || !canEdit || !dirty || saving) return;
    const nextContent = draft;
    pendingLocalSaveRef.current = { path: preview.path, content: nextContent };
    setSaving(true);
    setMessage("");
    try {
      await onSaveTextContent(tab.id, nextContent);
      setEditing(false);
    } catch (err) {
      pendingLocalSaveRef.current = null;
      setMessage(err instanceof Error ? err.message : workspaceCopy.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [canEdit, dirty, draft, onSaveTextContent, preview.path, saving, tab]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!editing || !canEdit) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (!dirty || saving) return;
      void handleSave();
    },
    [canEdit, dirty, editing, handleSave, saving],
  );

  const handleStartEditing = useCallback(() => {
    setEditing(true);
    setMessage("");
  }, []);

  const handleFinishEditing = useCallback(() => {
    if (saving) return;
    if (dirty) {
      void handleSave();
      return;
    }
    setEditing(false);
    setMessage("");
  }, [dirty, handleSave, saving]);

  const editActionTitle = !canWrite
    ? workspaceCopy.textSaveAction.readonly
    : preview.truncated
      ? workspaceCopy.textSaveAction.partial
      : workspaceCopy.textSaveAction.edit;
  const contentBytes = preview.size || new TextEncoder().encode(originalContent).byteLength;
  const usePlainText = contentBytes > CODEMIRROR_LANGUAGE_MAX_BYTES;

  useEffect(() => {
    if (!tabId || !onTextEditorToolbarChange) return;
    onTextEditorToolbarChange(tabId, {
      canEdit,
      editing,
      editActionTitle,
      message,
      saving,
      onStartEditing: handleStartEditing,
      onFinishEditing: handleFinishEditing,
    });
  }, [
    canEdit,
    editActionTitle,
    editing,
    handleFinishEditing,
    handleStartEditing,
    message,
    onTextEditorToolbarChange,
    saving,
    tabId,
    uiLanguage,
  ]);

  useEffect(() => {
    if (!tabId || !onTextEditorToolbarChange) return undefined;
    return () => onTextEditorToolbarChange(tabId, null);
  }, [onTextEditorToolbarChange, tabId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" onKeyDown={handleEditorKeyDown}>
      {preview.truncated && (
        <div className="shrink-0 border-b border-border bg-warning-muted px-3 py-1.5 text-xs text-warning">
          {workspaceCopy.truncatedNotice(preview.name, formatBytes(MAX_TEXT_PREVIEW_BYTES))}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<div className="h-full bg-background" aria-busy="true" />}>
          <TextEditorSurface
            ariaLabel={workspaceCopy.textEditorLabel(preview.name)}
            darkMode={darkMode}
            path={preview.path}
            plainText={usePlainText}
            readOnly={readOnly}
            searchHighlightQuery={searchHighlightQuery}
            testId={`text-editor-${tab?.id || preview.path}`}
            value={draft}
            onChange={(value) => {
              setDraft(value);
              if (message) setMessage("");
            }}
          />
        </Suspense>
      </div>
    </div>
  );
});

const NativeFramePreview = memo(function NativeFramePreview({
  uiLanguage: _uiLanguage,
  name,
  src,
  title,
  sandbox = false,
  truncated = false,
}: {
  uiLanguage: UiLanguage;
  name: string;
  src: string;
  title: string;
  sandbox?: boolean;
  truncated?: boolean;
}) {
  return (
    <div className="flex h-full min-h-[260px] flex-col bg-background">
      {truncated && (
        <div className="shrink-0 border-b border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
          {workspaceCopy.truncatedNotice(name, formatBytes(MAX_TEXT_PREVIEW_BYTES))}
        </div>
      )}
      <iframe
        title={title}
        src={src}
        sandbox={sandbox ? "" : undefined}
        className="min-h-0 flex-1 border-0 bg-background"
      />
    </div>
  );
});

const MarkdownPreview = memo(function MarkdownPreview({
  uiLanguage,
  tab,
  preview,
  mount,
  onSaveTextContent,
  onUnsavedChange,
  onEditingChange,
  onTextEditorToolbarChange,
  initialEditing = false,
  detached = false,
}: {
  uiLanguage: UiLanguage;
  tab?: PreviewTab;
  preview: MarkdownPreviewState;
  mount?: UserSpaceMount;
  onSaveTextContent?: (tabId: string, content: string) => Promise<void>;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
  onEditingChange?: (tabId: string, isEditing: boolean) => void;
  onTextEditorToolbarChange?: (tabId: string, state: TextEditorToolbarState | null) => void;
  initialEditing?: boolean;
  detached?: boolean;
}) {
  const darkMode = useStore((state) => state.darkMode);
  const originalContent = preview.textContent || "";
  const tabId = tab?.id || "";
  const pendingLocalSaveRef = useRef<{ path: string; content: string } | null>(null);
  const [draft, setDraft] = useState(originalContent);
  const [cleanMarkdown, setCleanMarkdown] = useState(originalContent);
  const initialEditingRef = useRef(initialEditing);
  const firstContentSyncRef = useRef(true);
  const contentIdentityRef = useRef({ path: preview.path, originalContent });
  const [editing, setEditing] = useState(initialEditingRef.current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const imageSrcMap = useMarkdownRelativeImageUrls(preview, mount);
  const resolveImageSrc = useCallback((src: string) => imageSrcMap[src] || src, [imageSrcMap]);
  const canWrite = Boolean(
    mount && mount.status === "mounted" && mount.access === "readwrite" && mount.canWrite !== false,
  );
  const canEdit = canWrite && !preview.truncated && Boolean(tab && onSaveTextContent);
  const dirty = draft !== cleanMarkdown;

  useEffect(() => {
    const previousIdentity = contentIdentityRef.current;
    contentIdentityRef.current = { path: preview.path, originalContent };
    if (
      previousIdentity.path !== preview.path &&
      previousIdentity.originalContent === originalContent
    ) {
      return;
    }
    const pendingLocalSave = pendingLocalSaveRef.current;
    if (pendingLocalSave?.path === preview.path && pendingLocalSave.content === originalContent) {
      pendingLocalSaveRef.current = null;
    }
    setDraft(originalContent);
    setCleanMarkdown(originalContent);
    setEditing(firstContentSyncRef.current ? initialEditingRef.current : false);
    firstContentSyncRef.current = false;
    setSaving(false);
    setMessage("");
  }, [originalContent, preview.path]);

  useEffect(() => {
    if (!tabId || !onUnsavedChange) return;
    onUnsavedChange(tabId, dirty);
  }, [dirty, onUnsavedChange, tabId]);

  useEffect(() => {
    if (!tabId || !onUnsavedChange) return undefined;
    return () => onUnsavedChange(tabId, false);
  }, [onUnsavedChange, tabId]);

  useEffect(() => {
    if (!tabId || !onEditingChange) return;
    onEditingChange(tabId, editing);
  }, [editing, onEditingChange, tabId]);

  useEffect(() => {
    if (!tabId || !onEditingChange) return undefined;
    return () => onEditingChange(tabId, false);
  }, [onEditingChange, tabId]);

  const handleSave = useCallback(async () => {
    if (!tab || !onSaveTextContent || !canEdit || !dirty || saving) return;
    const nextContent = restoreMarkdownEditorImageSources(draft, imageSrcMap);
    pendingLocalSaveRef.current = { path: preview.path, content: nextContent };
    setSaving(true);
    setMessage("");
    try {
      await onSaveTextContent(tab.id, nextContent);
      setDraft(nextContent);
      setCleanMarkdown(nextContent);
      setEditing(false);
    } catch (err) {
      pendingLocalSaveRef.current = null;
      setMessage(err instanceof Error ? err.message : workspaceCopy.saveFailed);
    } finally {
      setSaving(false);
    }
  }, [canEdit, dirty, draft, imageSrcMap, onSaveTextContent, preview.path, saving, tab]);

  const handleStartEditing = useCallback(() => {
    if (!canEdit) return;
    setEditing(true);
    setMessage("");
  }, [canEdit]);

  const handleFinishEditing = useCallback(() => {
    if (saving) return;
    if (dirty) {
      void handleSave();
      return;
    }
    setEditing(false);
    setMessage("");
  }, [dirty, handleSave, saving]);

  useEffect(() => {
    if (!editing || canEdit) return;
    setEditing(false);
  }, [canEdit, editing]);

  useLayoutEffect(() => {
    if (!tabId || !onTextEditorToolbarChange) return;
    const editActionTitle = !canWrite
      ? workspaceCopy.textSaveAction.readonly
      : preview.truncated
        ? workspaceCopy.textSaveAction.partial
        : workspaceCopy.textSaveAction.edit;
    onTextEditorToolbarChange(tabId, {
      canEdit,
      editing,
      editActionTitle,
      message,
      saving,
      onStartEditing: handleStartEditing,
      onFinishEditing: handleFinishEditing,
    });
  }, [
    canEdit,
    canWrite,
    handleFinishEditing,
    editing,
    handleStartEditing,
    message,
    onTextEditorToolbarChange,
    preview.truncated,

    saving,
    tabId,
    uiLanguage,
  ]);

  useEffect(() => {
    if (!tabId || !onTextEditorToolbarChange) return undefined;
    return () => onTextEditorToolbarChange(tabId, null);
  }, [onTextEditorToolbarChange, tabId]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement> | KeyboardEvent) => {
      if (!editing || !canEdit) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (!dirty || saving) return;
      void handleSave();
    },
    [canEdit, dirty, editing, handleSave, saving],
  );

  const topBarCopy = uiCopy.markdownEditor.topBar;
  const toolbarCopy: MarkdownEditorToolbarCopy = {
    actions: {
      bold: topBarCopy.actions.bold,
      italic: topBarCopy.actions.italic,
      strikethrough: topBarCopy.actions.strikethrough,
      "bullet-list": topBarCopy.actions.bulletList,
      "ordered-list": topBarCopy.actions.orderedList,
      "task-list": topBarCopy.actions.taskList,
      table: topBarCopy.actions.table,
      "code-block": topBarCopy.actions.codeBlock,
      quote: topBarCopy.actions.quote,
      divider: topBarCopy.actions.divider,
    },
    headings: [
      uiCopy.markdownEditor.blockEdit.textGroup.h1,
      uiCopy.markdownEditor.blockEdit.textGroup.h2,
      uiCopy.markdownEditor.blockEdit.textGroup.h3,
      uiCopy.markdownEditor.blockEdit.textGroup.h4,
      uiCopy.markdownEditor.blockEdit.textGroup.h5,
      uiCopy.markdownEditor.blockEdit.textGroup.h6,
    ],
    label: topBarCopy.label,
    paragraph: topBarCopy.paragraph,
    stylePicker: topBarCopy.stylePicker,
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-testid={`markdown-editor-${tabId || preview.path}`}
      data-editing={editing ? "true" : "false"}
      data-readonly={editing && canEdit ? "false" : "true"}
      tabIndex={0}
      onKeyDown={handleEditorKeyDown}
    >
      {preview.truncated && (
        <div
          className={`m-3 ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground`}
        >
          {workspaceCopy.truncatedNotice(preview.name, formatBytes(MAX_TEXT_PREVIEW_BYTES))}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="h-full bg-background" aria-busy="true" />}>
          <MarkdownEditorSurface
            ariaLabel={workspaceCopy.textEditorLabel(preview.name)}
            darkMode={darkMode}
            detached={detached}
            path={preview.path}
            readOnly={!editing || !canEdit}
            resolveImageSrc={resolveImageSrc}
            testId={`markdown-wysiwyg-editor-${tabId || preview.path}`}
            toolbarPortalId={editorToolbarPortalId(tabId)}
            toolbarCopy={toolbarCopy}
            value={draft}
            onChange={(value) => {
              setDraft(value);
              if (message) setMessage("");
            }}
          />
        </Suspense>
      </div>
    </div>
  );
});

function useMarkdownRelativeImageUrls(
  preview: MarkdownPreviewState,
  mount?: UserSpaceMount,
): Record<string, string> {
  const [imageSrcMap, setImageSrcMap] = useState<Record<string, string>>({});
  const mountId = mount?.mountId;
  const mountStatus = mount?.status;

  useEffect(() => {
    const sources = collectMarkdownImageSources(preview.textContent || "").filter((src) =>
      isRelativeMarkdownImageSrc(src),
    );
    if (!mountId || mountStatus !== "mounted" || sources.length === 0) {
      setImageSrcMap({});
      return undefined;
    }

    let cancelled = false;
    const createdUrls: string[] = [];
    setImageSrcMap({});

    void (async () => {
      const entries: Array<[string, string]> = [];
      for (const src of sources) {
        const assetPath = resolveMarkdownAssetPath(preview.path, src);
        if (!assetPath) continue;
        try {
          const file = await getUserSpaceFile(mountId, assetPath);
          if (!file.type.startsWith("image/") && !isImageFile(assetPath)) continue;
          const objectUrl = createImageObjectUrl(file, assetPath);
          if (cancelled) {
            previewResourceRegistry.revoke(objectUrl);
            continue;
          }
          createdUrls.push(objectUrl);
          entries.push([src, objectUrl]);
        } catch {
          // Keep the original relative src if the piwork image cannot be read.
        }
      }
      if (!cancelled) setImageSrcMap(Object.fromEntries(entries));
    })();

    return () => {
      cancelled = true;
      for (const objectUrl of createdUrls) previewResourceRegistry.revoke(objectUrl);
    };
  }, [mountId, mountStatus, preview.path, preview.textContent]);

  return imageSrcMap;
}

function restoreMarkdownEditorImageSources(
  markdown: string,
  imageSrcMap: Record<string, string>,
): string {
  let restored = markdown;
  for (const [originalSrc, objectUrl] of Object.entries(imageSrcMap)) {
    if (!objectUrl || !restored.includes(objectUrl)) continue;
    restored = restored.split(objectUrl).join(originalSrc);
  }
  return restored;
}

function isMarkdownPreviewState(preview: PreviewState): preview is MarkdownPreviewState {
  return preview.status === "ready" && preview.kind === "markdown";
}

function isOfficePreviewState(preview: PreviewState): preview is OfficePreviewState {
  return preview.status === "ready" && preview.kind === "office";
}

const OfficePreview = memo(function OfficePreview({
  tabId,
  mount,
  preview,
  foreground,
  waitForWorkspaceMutation,
  resolvePreviewTabPath,
  onOfficeFileMigration,
  onOfficeFileCreated,
  onOfficeFileSaved,
  onUnsavedChange,
}: {
  tabId: string;
  mount?: UserSpaceMount;
  preview: OfficePreviewState;
  foreground: boolean;
  waitForWorkspaceMutation?: () => Promise<void>;
  resolvePreviewTabPath?: (tabId: string) => string | undefined;
  onOfficeFileMigration?: (migration: OfficeFileMigration) => void;
  onOfficeFileCreated?: (created: OfficeFileCreated) => void;
  onOfficeFileSaved?: (saved: OfficeFileSaved) => void;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
}) {
  if (!preview.officeFile) {
    return <PanelNotice>{workspaceCopy.office.localPreviewFailed}</PanelNotice>;
  }
  const mountId = mount?.mountId || "";
  const canWrite = Boolean(
    mount && mount.status === "mounted" && mount.access === "readwrite" && mount.canWrite !== false,
  );
  return (
    <OnlyOfficeBrowserPreview
      tabId={tabId}
      mountId={mountId}
      file={preview.officeFile}
      name={preview.name}
      path={preview.path}
      foreground={foreground}
      canWrite={canWrite}
      waitForWorkspaceMutation={waitForWorkspaceMutation}
      resolvePreviewTabPath={resolvePreviewTabPath}
      onOfficeFileMigration={onOfficeFileMigration}
      onOfficeFileCreated={onOfficeFileCreated}
      onOfficeFileSaved={onOfficeFileSaved}
      onUnsavedChange={onUnsavedChange}
    />
  );
});

const OFFICE_BROWSER_RESIZE_COMMIT_DELAY_MS = 180;
const OFFICE_BROWSER_FALLBACK_WIDTH = 1280;
const OFFICE_BROWSER_FALLBACK_HEIGHT = 720;

const OnlyOfficeBrowserPreview = memo(function OnlyOfficeBrowserPreview({
  tabId,
  mountId,
  file,
  name,
  path,
  foreground,
  canWrite,
  waitForWorkspaceMutation,
  resolvePreviewTabPath,
  onOfficeFileMigration,
  onOfficeFileCreated,
  onOfficeFileSaved,
  onUnsavedChange,
}: {
  tabId: string;
  mountId: string;
  file: File;
  name: string;
  path: string;
  foreground: boolean;
  canWrite: boolean;
  waitForWorkspaceMutation?: () => Promise<void>;
  resolvePreviewTabPath?: (tabId: string) => string | undefined;
  onOfficeFileMigration?: (migration: OfficeFileMigration) => void;
  onOfficeFileCreated?: (created: OfficeFileCreated) => void;
  onOfficeFileSaved?: (saved: OfficeFileSaved) => void;
  onUnsavedChange?: (tabId: string, hasUnsavedChanges: boolean) => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<ThemeAwareOfficeEditorInstance | null>(null);
  const aiRegistrationRef = useRef<OnlyOfficeEditorRegistration | null>(null);
  const aiRegistrationEditorIdRef = useRef<string | null>(null);
  const aiDocumentRef = useRef({
    title: name,
    mountId,
    path,
    fileType: getExtension(path),
    documentType: officeDocumentType(path),
    writable: canWrite,
    foreground,
  });
  const initialFileRef = useRef(file);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;
  const initialPathRef = useRef(path);
  const initialRuntimeFileNameRef = useRef(officeRuntimeFileName(name, path));
  const officeResourceKey = `${tabId}:office`;
  const initialForegroundRef = useRef(foreground);
  const foregroundRef = useRef(foreground);
  const onOfficeFileMigrationRef = useRef(onOfficeFileMigration);
  const onOfficeFileCreatedRef = useRef(onOfficeFileCreated);
  const onOfficeFileSavedRef = useRef(onOfficeFileSaved);
  const officeInterfaceTheme = useStore((state) => state.themeMode as OfficeInterfaceTheme);
  const officeInterfaceThemeRef = useRef<OfficeInterfaceTheme>(officeInterfaceTheme);
  const [opening, setOpening] = useState(true);
  const [error, setError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [browserResizeActive, setBrowserResizeActive] = useState(false);
  const [pendingResourcePlan, setPendingResourcePlan] = useState<ResourcePlan | null>(null);
  const [preparingResources, setPreparingResources] = useState(false);
  const resourcePlanResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const editorMode = canWrite ? "edit" : "preview";
  const readonly = !canWrite;
  foregroundRef.current = foreground;
  aiDocumentRef.current = {
    title: name,
    mountId,
    path,
    fileType: getExtension(path),
    documentType: officeDocumentType(path),
    writable: canWrite,
    foreground,
  };

  useEffect(() => {
    aiRegistrationRef.current?.updateDocument(aiDocumentRef.current);
  }, [canWrite, foreground, mountId, name, path]);

  useLayoutEffect(() => {
    if (!foreground) return undefined;
    let cancelled = false;
    void officePreviewRuntimeManagerPromise.then((manager) => {
      if (!cancelled) {
        manager.setForeground(officeResourceKey);
        aiRegistrationRef.current?.setForeground(true);
      }
    });
    return () => {
      cancelled = true;
      aiRegistrationRef.current?.setForeground(false);
    };
  }, [foreground, officeResourceKey]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const container = containerRef.current;
    const previewWindow = preview?.ownerDocument.defaultView;
    if (!preview || !container || !previewWindow) return undefined;

    const initialRect = preview.getBoundingClientRect();
    let committedWidth = initialRect.width || OFFICE_BROWSER_FALLBACK_WIDTH;
    let committedHeight = initialRect.height || OFFICE_BROWSER_FALLBACK_HEIGHT;
    let lastViewportWidth = previewWindow.innerWidth;
    let frozen = false;
    let fallbackSizeApplied = false;
    let commitTimer: number | undefined;

    const syncStableSize = () => {
      const rect = preview.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        committedWidth = rect.width;
        committedHeight = rect.height;
        if (fallbackSizeApplied && !frozen) {
          fallbackSizeApplied = false;
          container.style.removeProperty("width");
          container.style.removeProperty("height");
          container.style.removeProperty("right");
          container.style.removeProperty("bottom");
        }
        return;
      }
      if (frozen) return;
      fallbackSizeApplied = true;
      container.style.width = `${committedWidth || OFFICE_BROWSER_FALLBACK_WIDTH}px`;
      container.style.height = `${committedHeight || OFFICE_BROWSER_FALLBACK_HEIGHT}px`;
      container.style.right = "auto";
      container.style.bottom = "auto";
    };

    const commitResize = () => {
      commitTimer = undefined;
      frozen = false;
      container.style.removeProperty("width");
      container.style.removeProperty("right");
      fallbackSizeApplied = false;
      syncStableSize();
      setBrowserResizeActive(false);
    };

    const handleWindowResize = () => {
      const viewportWidth = previewWindow.innerWidth;
      const widthChanged = viewportWidth !== lastViewportWidth;
      lastViewportWidth = viewportWidth;
      if (!widthChanged && !frozen) return;

      if (!frozen) {
        if (committedWidth <= 0) committedWidth = preview.getBoundingClientRect().width;
        if (committedWidth <= 0) return;
        frozen = true;
        container.style.width = `${committedWidth}px`;
        container.style.right = "auto";
        setBrowserResizeActive(true);
      }

      if (commitTimer !== undefined) previewWindow.clearTimeout(commitTimer);
      commitTimer = previewWindow.setTimeout(commitResize, OFFICE_BROWSER_RESIZE_COMMIT_DELAY_MS);
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            syncStableSize();
          });
    observer?.observe(preview);
    syncStableSize();
    previewWindow.addEventListener("resize", handleWindowResize);

    return () => {
      previewWindow.removeEventListener("resize", handleWindowResize);
      observer?.disconnect();
      if (commitTimer !== undefined) previewWindow.clearTimeout(commitTimer);
      container.style.removeProperty("width");
      container.style.removeProperty("height");
      container.style.removeProperty("right");
      container.style.removeProperty("bottom");
    };
  }, []);

  useEffect(() => {
    onOfficeFileMigrationRef.current = onOfficeFileMigration;
  }, [onOfficeFileMigration]);

  useEffect(() => {
    onOfficeFileCreatedRef.current = onOfficeFileCreated;
  }, [onOfficeFileCreated]);

  useEffect(() => {
    onOfficeFileSavedRef.current = onOfficeFileSaved;
  }, [onOfficeFileSaved]);

  useEffect(() => {
    officeInterfaceThemeRef.current = officeInterfaceTheme;
    editorRef.current?.setInterfaceTheme?.(officeInterfaceTheme);
  }, [officeInterfaceTheme]);

  const dismissSaveMessage = useCallback(() => {
    setSaveMessage("");
  }, []);

  const requestResourcePreparation = useCallback((plan: ResourcePlan) => {
    return new Promise<boolean>((resolve) => {
      resourcePlanResolverRef.current?.(false);
      resourcePlanResolverRef.current = resolve;
      setPendingResourcePlan(plan);
    });
  }, []);

  const resolveResourcePreparation = useCallback((approved: boolean) => {
    const resolve = resourcePlanResolverRef.current;
    resourcePlanResolverRef.current = null;
    if (!approved) setPendingResourcePlan(null);
    resolve?.(approved);
  }, []);

  useEffect(() => {
    if (!saveMessage || saveMessage === workspaceCopy.office.saving) return undefined;
    const timeoutId = window.setTimeout(() => {
      setSaveMessage("");
    }, 2_000);
    return () => window.clearTimeout(timeoutId);
  }, [saveMessage]);

  const handleOfficeSave = useCallback(
    async (savedFile: File, instance: OfficeEditorInstance) => {
      if (!mountId || !canWrite) {
        throw new Error(workspaceCopy.office.noSaveAccess);
      }
      setSaveMessage(workspaceCopy.office.saving);
      setError("");
      try {
        await waitForWorkspaceMutation?.();
        const currentPath = resolvePreviewTabPath?.(tabId) || currentPathRef.current;
        const savePath = officeSavedWorkspacePath(currentPath, savedFile.name);
        const migratedPath = savePath !== currentPath;
        const legacyMigration = migratedPath && isLegacyOfficePath(currentPath);
        if (legacyMigration) {
          if (typeof instance.confirmSaveToNewFormat !== "function") {
            throw new Error(workspaceCopy.office.legacyConfirmUnavailable);
          }
          const confirmed = await instance.confirmSaveToNewFormat();
          if (!confirmed) {
            setSaveMessage(workspaceCopy.office.cancelledSave);
            setError("");
            throw createOfficeLegacyMigrationCancelledError();
          }
        }
        if (migratedPath) {
          await saveUserSpaceFile(mountId, savePath, savedFile, { create: true });
        } else {
          await saveUserSpaceFile(mountId, currentPath, savedFile);
        }
        if (legacyMigration) {
          try {
            await executeUserSpaceOperation("delete_entry", { mountId, path: currentPath });
          } catch (deleteError) {
            const message =
              deleteError instanceof Error ? deleteError.message : String(deleteError);
            throw new Error(
              workspaceCopy.office.savedAsButDeleteOriginalFailed(
                previewTitleForPath(savePath),
                previewTitleForPath(currentPath),
                message,
              ),
            );
          }
        }
        if (!migratedPath) {
          onOfficeFileSavedRef.current?.({ mountId, path: currentPath, file: savedFile });
        }
        setSaveMessage(
          legacyMigration
            ? workspaceCopy.office.savedAsAndDeletedOriginal(
                previewTitleForPath(savePath),
                previewTitleForPath(currentPath),
              )
            : migratedPath
              ? workspaceCopy.office.savedAs(previewTitleForPath(savePath))
              : "",
        );
        if (legacyMigration) {
          window.setTimeout(() => {
            onOfficeFileMigrationRef.current?.({
              mountId,
              oldPath: currentPath,
              newPath: savePath,
            });
          }, 0);
        }
      } catch (nextError) {
        if (
          nextError instanceof Error &&
          nextError.name === OFFICE_LEGACY_MIGRATION_CANCELLED_ERROR
        ) {
          setSaveMessage(nextError.message || workspaceCopy.office.cancelledSave);
          setError("");
          throw nextError;
        }
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSaveMessage(workspaceCopy.office.saveFailed);
        setError(message || workspaceCopy.office.saveFileFailed);
        throw nextError;
      }
    },
    [canWrite, mountId, resolvePreviewTabPath, tabId, waitForWorkspaceMutation],
  );

  const handleOfficeSaveAs = useCallback(
    async (savedFile: File) => {
      if (!mountId || !canWrite) {
        throw new Error(workspaceCopy.office.noSaveCopyAccess);
      }

      setSaveMessage(workspaceCopy.office.saving);
      setError("");
      try {
        await waitForWorkspaceMutation?.();
        const currentPath = resolvePreviewTabPath?.(tabId) || currentPathRef.current;
        const savePath = officeSaveCopyWorkspacePath(currentPath, savedFile.name);
        await saveUserSpaceFile(mountId, savePath, savedFile, { create: true });
        setSaveMessage(workspaceCopy.office.savedAsCopy(previewTitleForPath(savePath)));
        onOfficeFileCreatedRef.current?.({
          mountId,
          path: savePath,
          previewKind: previewKindForWorkspacePath(savePath),
        });
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setSaveMessage(workspaceCopy.office.saveFailed);
        setError(message || workspaceCopy.office.saveCopyFailed);
        throw nextError;
      }
    },
    [canWrite, mountId, resolvePreviewTabPath, tabId, waitForWorkspaceMutation],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    setOpening(true);
    setError("");
    setSaveMessage("");

    resetOfficePreviewHostForMount(container);
    container.replaceChildren();
    const mountFile = initialFileRef.current;
    const emptyOfficeType =
      mountFile.size === 0 ? emptyOfficeTypeForWorkspacePath(initialPathRef.current) : undefined;
    const officeEditorOptions: CreateOfficeEditorOptions & {
      interfaceTheme?: OfficeInterfaceTheme;
    } = {
      hostUrl: (context) => resolvePiworkOnlyOfficeHostUrl(context, getTargetOfficeReleaseId()),
      ...(emptyOfficeType ? { emptyType: emptyOfficeType } : { file: mountFile }),
      fileName: initialRuntimeFileNameRef.current,
      mode: editorMode,
      readonly,
      interfaceTheme: officeInterfaceThemeRef.current,
      lang: "zh",
      saveBehavior: "callback",
      plugins: {
        configUrls: ["/onlyoffice-plugin/config.json"],
        autostart: [ONLYOFFICE_PLUGIN_GUID],
      },
      onReady(instance) {
        if (disposed) return;
        editorRef.current = instance as ThemeAwareOfficeEditorInstance;
        setOpening(false);
      },
      onPluginReady(pluginGuid, _editorType, instance) {
        if (disposed || pluginGuid !== ONLYOFFICE_PLUGIN_GUID) return;
        const sessionId = runtimeContextCoordinator.current()?.context.sessionId;
        if (!sessionId) return;
        if (aiRegistrationEditorIdRef.current === instance.id && aiRegistrationRef.current) return;
        aiRegistrationRef.current?.dispose();
        aiRegistrationRef.current = registerOnlyOfficeEditor({
          sessionId,
          instance,
          ...aiDocumentRef.current,
        });
        aiRegistrationEditorIdRef.current = instance.id;
      },
      onError(nextError) {
        if (disposed) return;
        if (nextError.name === OFFICE_LEGACY_MIGRATION_CANCELLED_ERROR) {
          setSaveMessage(nextError.message || workspaceCopy.office.cancelledSave);
          setError("");
          setOpening(false);
          return;
        }
        setError(nextError.message || workspaceCopy.office.localPreviewFailed);
        setSaveMessage((current) =>
          current === workspaceCopy.office.saving ? workspaceCopy.office.saveFailed : current,
        );
        setOpening(false);
      },
      onDirtyChange(nextDirty) {
        if (disposed) return;
        onUnsavedChange?.(tabId, nextDirty);
        if (nextDirty) setSaveMessage("");
      },
      onSave: handleOfficeSave,
      onSaveAs: handleOfficeSaveAs,
    };

    let lease: OfficePreviewLease | null = null;
    let disposePromise: Promise<void> | null = null;
    const leasePromise = Promise.all([
      officePreviewRuntimeManagerPromise,
      ensureOfficeResources().catch(() => null),
    ]).then(async ([manager]) => {
      if (disposed) {
        throw new DOMException("Office preview mount was cancelled", "AbortError");
      }
      const plan = await planOfficeResourcesForFile(initialRuntimeFileNameRef.current);
      if (plan.downloadBytes > 0) {
        const approved = await requestResourcePreparation(plan);
        if (!approved || disposed) {
          throw new DOMException("Office resource preparation was cancelled", "AbortError");
        }
      }
      if (!officeResourcesReadyForRelease(plan.releaseId)) {
        setPreparingResources(true);
        try {
          await applyOfficeResourcePlan(plan);
        } finally {
          setPreparingResources(false);
          setPendingResourcePlan(null);
        }
      }
      if (!officeResourcesReadyForRelease(plan.releaseId)) {
        throw new Error(workspaceCopy.office.resourcesNotReady);
      }
      lease = manager.mount(container, {
        ...officeEditorOptions,
        downloadedFonts: getVerifiedOfficeFontPaths(),
        resourceKey: officeResourceKey,
        foreground: initialForegroundRef.current,
      });
      return lease;
    });

    const dispose = (reason: "close" | "handoff" = "close"): Promise<void> => {
      if (disposePromise) return disposePromise;
      if (reason === "close") disposed = true;
      const pending = (async () => {
        let activeLease: OfficePreviewLease;
        try {
          activeLease = lease ?? (await leasePromise);
        } catch (nextError) {
          if (reason === "handoff" && !disposed) throw nextError;
          return;
        }
        if (reason === "handoff") {
          const instance = editorRef.current ?? (await activeLease.ready);
          if (instance.getState().dirty) {
            await instance.save();
            if (instance.getState().dirty) {
              throw new Error(workspaceCopy.office.saveFileFailed);
            }
          }
          disposed = true;
        }
        hideOfficePreviewHostForTeardown(container);
        aiRegistrationRef.current?.dispose();
        aiRegistrationRef.current = null;
        aiRegistrationEditorIdRef.current = null;
        editorRef.current = null;
        onUnsavedChange?.(tabId, false);
        await activeLease.dispose();
      })();
      disposePromise = pending.catch((nextError) => {
        if (reason === "handoff" && !disposed) disposePromise = null;
        throw nextError;
      });
      return disposePromise;
    };
    const unregisterDispose = registerOfficePreviewDisposer(tabId, dispose);
    void leasePromise
      .then((activeLease) => activeLease.ready)
      .then((instance) => {
        if (disposed) return;
        editorRef.current = instance as ThemeAwareOfficeEditorInstance;
        setOpening(false);
      })
      .catch((nextError: unknown) => {
        if (disposed) return;
        setError(
          nextError instanceof Error &&
            (nextError.name === "OfficeHostPoolExhaustedError" ||
              nextError.name === "OfficePreviewLimitError")
            ? workspaceCopy.office.openLimitReached
            : nextError instanceof Error
              ? nextError.message
              : workspaceCopy.office.localPreviewFailed,
        );
        setOpening(false);
      });

    return () => {
      resolveResourcePreparation(false);
      unregisterDispose();
      void dispose();
    };
  }, [
    canWrite,
    editorMode,
    handleOfficeSave,
    handleOfficeSaveAs,
    officeResourceKey,
    onUnsavedChange,
    readonly,
    requestResourcePreparation,
    resolveResourcePreparation,
    tabId,
  ]);

  return (
    <>
      <div
        ref={previewRef}
        data-testid="onlyoffice-browser-preview"
        className="relative h-full min-h-0 w-full overflow-hidden bg-background"
      >
        <div
          ref={containerRef}
          title={workspaceCopy.office.title(editorMode === "edit" ? "edit" : "preview", name)}
          data-piwork-office-preview-path={path}
          className="piwork-onlyoffice-browser-host absolute inset-0 block h-full min-h-0 w-full border-0 bg-background"
        />
        {browserResizeActive && (
          <div
            aria-hidden="true"
            data-testid="onlyoffice-browser-resize-mask"
            className={`pointer-events-none z-30 ${PREVIEW_BLUR_MASK_CLASS}`}
          />
        )}
        {opening && (
          <div className="pointer-events-none absolute inset-0 z-10 bg-background" aria-busy="true">
            <OfficeLoadingState overlay />
          </div>
        )}
        {saveMessage && saveMessage !== workspaceCopy.office.saving && (
          <div
            className={`absolute inset-x-3 top-3 z-20 flex min-h-11 items-center gap-2 ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-warning/40 bg-warning-muted px-3 py-2 text-sm text-warning`}
            role="status"
            data-testid="onlyoffice-save-tip"
          >
            <span className="min-w-0 flex-1 truncate" title={saveMessage}>
              {saveMessage}
            </span>
            <button
              type="button"
              onClick={dismissSaveMessage}
              className={`flex h-6 w-6 shrink-0 items-center justify-center ${WORKSPACE_CONTROL_RADIUS_CLASS} text-warning transition-colors hover:bg-warning-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning`}
              aria-label={workspaceCopy.closeOfficeSaveAlert}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {error && (
          <div
            className={`absolute inset-x-3 top-3 flex items-center gap-3 ${WORKSPACE_CONTROL_RADIUS_CLASS} border border-warning/35 bg-warning-muted px-3 py-2 text-xs text-warning`}
          >
            <span className="min-w-0 flex-1">{error}</span>
            {officeResourcesNeedAttention() && (
              <button
                type="button"
                className="shrink-0 font-semibold underline underline-offset-2"
                onClick={requestOfficeResourceSettings}
              >
                {workspaceCopy.office.manageResources}
              </button>
            )}
          </div>
        )}
      </div>
      <Dialog
        isOpen={Boolean(pendingResourcePlan)}
        onOpenChange={(open) => {
          if (!open && !preparingResources) resolveResourcePreparation(false);
        }}
        title={workspaceCopy.office.resourcePreparationTitle}
        closeLabel={workspaceCopy.office.resourcePreparationClose}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          {workspaceCopy.office.resourcePreparationDescription(
            formatBytes(pendingResourcePlan?.downloadBytes ?? 0),
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={preparingResources}
            onPress={() => resolveResourcePreparation(false)}
          >
            {uiCopy.common.cancel}
          </Button>
          <Button
            size="sm"
            loading={preparingResources}
            onPress={() => resolveResourcePreparation(true)}
          >
            {workspaceCopy.office.prepareResources}
          </Button>
        </div>
      </Dialog>
    </>
  );
});

function PanelNotice({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div
      className={`flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground ${compact ? "min-h-[88px]" : "min-h-[120px]"}`}
    >
      {children}
    </div>
  );
}

function PreviewNoticeBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-danger/30 bg-danger-muted px-6 text-sm text-danger">
      {children}
    </div>
  );
}

function UnsupportedPreviewDetails({ path, size }: { path: string; size?: number }) {
  const name = previewTitleForPath(path);
  const extension = getExtension(path);
  const fileTypes = workspaceCopy.detailsDialog.fileTypes as Record<string, string>;
  const type = fileTypes[extension] || workspaceCopy.detailsDialog.typeFile;
  const FileIcon = iconForWorkspaceEntry({ name, path, kind: "file" });

  return (
    <div
      className="flex h-full min-h-[260px] items-center justify-center overflow-auto px-6 py-10"
      data-testid="unsupported-preview-details"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <FileIcon className="mb-5 size-12 text-muted-foreground/75" aria-hidden={true} />
        <h2 className="max-w-full break-all text-base font-semibold text-foreground">{name}</h2>
        <dl className="mt-4 grid max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-left text-sm">
          <dt className="text-muted-foreground">{workspaceCopy.detailsDialog.labels.type}</dt>
          <dd className="min-w-0 break-words text-foreground/85">{type}</dd>
          <dt className="text-muted-foreground">{workspaceCopy.detailsDialog.labels.size}</dt>
          <dd className="min-w-0 break-words text-foreground/85">
            {typeof size === "number" ? formatBytes(size) : workspaceCopy.detailsDialog.unknownSize}
          </dd>
        </dl>
      </div>
    </div>
  );
}

function collectMarkdownImageSources(markdown: string): string[] {
  const sources = new Set<string>();
  const markdownImagePattern =
    /!\[[^\]\r\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const htmlImagePattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  for (const match of markdown.matchAll(markdownImagePattern)) {
    if (match[1]) sources.add(match[1]);
  }
  for (const match of markdown.matchAll(htmlImagePattern)) {
    const src = match[1] || match[2] || match[3];
    if (src) sources.add(src);
  }
  return [...sources];
}

function isRelativeMarkdownImageSrc(src: string): boolean {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed)) return false;
  if (/^(?:data|blob|mailto|tel):/i.test(trimmed)) return false;
  return true;
}

function resolveMarkdownAssetPath(markdownPath: string, src: string): string | null {
  const cleanSrc = stripUrlSuffix(src.trim()).replace(/\\/g, "/");
  if (!cleanSrc || cleanSrc.startsWith("#")) return null;
  const baseDir = dirnameWorkspacePath(markdownPath);
  const joined = cleanSrc.startsWith("/")
    ? cleanSrc.replace(/^\/+/, "")
    : baseDir
      ? `${baseDir}/${cleanSrc}`
      : cleanSrc;
  const normalized = normalizeWorkspacePath(joined);
  return normalized || null;
}

function stripUrlSuffix(src: string): string {
  const hashIndex = src.indexOf("#");
  const queryIndex = src.indexOf("?");
  const cutIndexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const cutIndex = cutIndexes.length > 0 ? Math.min(...cutIndexes) : -1;
  return cutIndex >= 0 ? src.slice(0, cutIndex) : src;
}

function officeRuntimeFileName(name: string, path: string): string {
  const title =
    previewTitleForPath(name || path).trim() || previewTitleForPath(path).trim() || "document";
  const extension = getExtension(title) || getExtension(path) || "docx";
  const suffix = `.${extension}`;
  const stem = title.toLowerCase().endsWith(suffix)
    ? title.slice(0, Math.max(0, title.length - suffix.length))
    : title;
  const safeStem = stem
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, "_")
    .replace(/[._\s-]+$/g, "")
    .replace(/^[._\s-]+/g, "");
  return `${safeStem || "document"}.${extension}`;
}

function officeSavedWorkspacePath(currentPath: string, savedFileName: string): string {
  const currentExt = getExtension(currentPath);
  const legacyTargetExt = LEGACY_OFFICE_TARGET_EXTENSIONS[currentExt];
  if (legacyTargetExt)
    return workspacePathWithSourceExtensionMarker(currentPath, currentExt, legacyTargetExt);

  const savedExt = getExtension(savedFileName);
  if (!currentExt || !savedExt || currentExt === savedExt) return currentPath;
  if (!OFFICE_EXTENSIONS.has(currentExt) || !OFFICE_EXTENSIONS.has(savedExt)) return currentPath;

  return workspacePathWithExtension(currentPath, savedExt);
}

function officeSaveCopyWorkspacePath(currentPath: string, savedFileName: string): string {
  const currentExt = getExtension(currentPath);
  const savedExt = getExtension(savedFileName) || currentExt || "docx";
  if (LEGACY_OFFICE_TARGET_EXTENSIONS[currentExt]) {
    const marker = sourceExtensionMarker(currentExt);
    return workspacePathWithNameSuffixAndExtension(
      currentPath,
      `_${marker}_${workspaceCopy.copySuffix}`,
      savedExt,
    );
  }

  const dir = dirnameWorkspacePath(currentPath);
  const currentName = previewTitleForPath(currentPath);
  const safeName = workspaceSafeFileName(savedFileName, currentName);
  const saveName = workspaceCopyFileName(safeName, savedExt);
  return dir ? `${dir}/${saveName}` : saveName;
}

function workspaceSafeFileName(fileName: string, fallback: string): string {
  const candidate = previewTitleForPath(fileName || fallback)
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, "_")
    .replace(/^[._\s-]+|[._\s-]+$/g, "");
  return candidate || "document";
}

function workspaceCopyFileName(fileName: string, fallbackExtension: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && dotIndex < fileName.length - 1;
  const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex + 1) : fallbackExtension;
  const suffix = `_${workspaceCopy.copySuffix}`;
  const copyStem = stem.endsWith(suffix) ? stem : `${stem}${suffix}`;
  return `${copyStem}.${extension || "docx"}`;
}

function workspacePathWithSourceExtensionMarker(
  currentPath: string,
  sourceExtension: string,
  targetExtension: string,
): string {
  const marker = sourceExtensionMarker(sourceExtension);
  return workspacePathWithNameSuffixAndExtension(currentPath, `_${marker}`, targetExtension);
}

function sourceExtensionMarker(sourceExtension: string): string {
  return (
    sourceExtension
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "legacy"
  );
}

function workspacePathWithExtension(currentPath: string, extension: string): string {
  return workspacePathWithNameSuffixAndExtension(currentPath, "", extension);
}

function workspacePathWithNameSuffixAndExtension(
  currentPath: string,
  suffix: string,
  extension: string,
): string {
  const dir = dirnameWorkspacePath(currentPath);
  const currentName = previewTitleForPath(currentPath);
  const dotIndex = currentName.lastIndexOf(".");
  const stem = dotIndex > 0 ? currentName.slice(0, dotIndex) : currentName;
  const nextName = `${stem}${suffix}.${extension}`;
  return dir ? `${dir}/${nextName}` : nextName;
}

function isLegacyOfficePath(path: string): boolean {
  return Boolean(LEGACY_OFFICE_TARGET_EXTENSIONS[getExtension(path)]);
}

function createOfficeLegacyMigrationCancelledError(): Error {
  const error = new Error(workspaceCopy.office.cancelledWithDirtyFile);
  error.name = OFFICE_LEGACY_MIGRATION_CANCELLED_ERROR;
  return error;
}
