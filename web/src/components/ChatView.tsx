import {
  lazy,
  Suspense,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import LobeThemeProvider from "@lobehub/ui/es/ThemeProvider/ThemeProvider";
import { Button, Dialog, DropdownMotion, SegmentedControl } from "./ui/index.js";
import { Keyboard, LogOut, Power, Settings, ShieldCheck } from "lucide-react";
import { useStore } from "../store.js";
import { api, type UserPreferences } from "../api.js";
import { disconnectAll } from "../ws.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { InteractionCard } from "./InteractionCard.js";
import { BrowserBridgePanel } from "./BrowserBridgePanel.js";
import { UserSettingsDialog } from "./UserSettingsDialog.js";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog.js";
import { getAgentIdForSession, isAgentDisplayName, type AgentId } from "../agents.js";
import { navigateHome, navigateRbacAdmin } from "../utils/routing.js";
import { getDefaultSessionName, isPlaceholderSessionName } from "../utils/names.js";
import {
  attachUserSpaceMountsToSession,
  detachUserSpaceFromSession,
  resendSessionUserSpaces,
  restorePersistedUserSpaces,
  type UserSpacePersistenceScope,
} from "../user-space.js";
import type { PiSessionInfo, UserSpaceMount } from "../types.js";
import { persistWorkspaceSessionStateNow } from "../workspace-session-state.js";
import { savePreferencesLatest } from "../preferences-persistence.js";
import { uiCopy } from "../ui-copy.js";
import { isAbortError, runtimeContextCoordinator } from "../runtime-context.js";
import { userScopeKeyFromCurrentUser } from "../store/user-scoped-storage.js";
import {
  captureUserSpaceConfigurationContext,
  configureUserSpaceLatest,
} from "../user-space-configuration.js";
import { WORKBENCH_GEOMETRY } from "../workbench-geometry.js";
import {
  getUserInitials,
  sameUserSpaceMounts,
  toUserSpaceMetadataItem,
  userSpaceSyncKey,
} from "./chat-view-session-utils.js";
import { AgentSessionSelector } from "./chat-view/AgentSessionSelector.js";
import {
  readFilePreviewLayoutMode,
  writeFilePreviewLayoutMode,
} from "./chat-view/file-preview-layout-state.js";
import type { ThemeMode, UiLanguage } from "../store/ui-slice.js";

const emptyUserSpaceMounts: UserSpaceMount[] = [];
const DEFAULT_MESSAGE_FEED_BOTTOM_INSET_PX = WORKBENCH_GEOMETRY.composerBottomInsetPx;
const MESSAGE_FEED_COMPOSER_GAP_PX = WORKBENCH_GEOMETRY.composerGapPx;
type ArchivedDeleteRequest =
  { kind: "one"; sessionId: string; title: string } | { kind: "many"; sessionIds: string[] };

const DEFAULT_WORKSPACE_OPEN_BASIS = "70%";
const DEFAULT_WORKSPACE_CLOSED_BASIS = "20%";
const MIN_TREE_PANEL_WIDTH = WORKBENCH_GEOMETRY.treePanelMinWidthPx;
const MIN_PREVIEW_PANEL_WIDTH = WORKBENCH_GEOMETRY.previewPanelMinWidthPx;
const WORKSPACE_PANEL_BG_CLASS = "bg-background";

const UserSpaceExplorer = lazy(async () => {
  const module = await import("./UserSpaceExplorer.js");
  return { default: module.UserSpaceExplorer };
});

export function ChatView({ sessionId }: { sessionId: string }) {
  const [creatingAgentId, setCreatingAgentId] = useState<AgentId | null>(null);
  const [userSpacePreviewOpen, setUserSpacePreviewOpen] = useState(false);
  const [sessionPanelCollapsed, setSessionPanelCollapsed] = useState(false);
  const [restoringWorkspaceKey, setRestoringWorkspaceKey] = useState("");
  const [logoutHovering, setLogoutHovering] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userSettingsOpen, setUserSettingsOpen] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [workspaceSearchRequest, setWorkspaceSearchRequest] = useState(0);
  const [sessionSearchRequest, setSessionSearchRequest] = useState(0);
  const [spacePanelToggleRequest, setSpacePanelToggleRequest] = useState(0);
  const [composerDraftRequest, setComposerDraftRequest] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const [archivedSessions, setArchivedSessions] = useState<PiSessionInfo[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const [archivedActionId, setArchivedActionId] = useState<string | null>(null);
  const [archivedDeleteRequest, setArchivedDeleteRequest] = useState<ArchivedDeleteRequest | null>(
    null,
  );
  const [archivedDeleteConfirming, setArchivedDeleteConfirming] = useState(false);
  const [selectedArchivedSessionIds, setSelectedArchivedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const userAvatarButtonRef = useRef<HTMLButtonElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const floatingComposerLayerRef = useRef<HTMLDivElement | null>(null);
  const userSpacePanelRef = useRef<HTMLDivElement | null>(null);
  const composerDraftSequenceRef = useRef(0);
  const restoredWorkspaceKeysRef = useRef(new Set<string>());
  const workspaceConfigureKeyRef = useRef("");
  const [messageFeedBottomInsetPx, setMessageFeedBottomInsetPx] = useState(
    DEFAULT_MESSAGE_FEED_BOTTOM_INSET_PX,
  );
  const sessionInteractions = useStore((s) => s.pendingInteractions.get(sessionId));
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const agentSessionIds = useStore((s) => s.agentSessionIds);
  const agentSessionHistoryIds = useStore((s) => s.agentSessionHistoryIds);
  const sessionNames = useStore((s) => s.sessionNames);
  const userSpaces = useStore((s) => s.sessions.get(sessionId)?.userSpaces || emptyUserSpaceMounts);
  const agentUserSpaces = useStore((s) => s.agentUserSpaces);
  const currentUser = useStore((s) => s.currentUser);
  const themeMode = useStore((s) => s.themeMode);
  const darkMode = useStore((s) => s.darkMode);
  const setThemeMode = useStore((s) => s.setThemeMode);
  const uiLanguage = useStore((s) => s.uiLanguage);
  const setUiLanguage = useStore((s) => s.setUiLanguage);
  const preferences = useStore((s) => s.preferences);
  const preferencesLoaded = useStore((s) => s.preferencesLoaded);
  const preferencesError = useStore((s) => s.preferencesError);
  const setAgentUserSpaces = useStore((s) => s.setAgentUserSpaces);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPreferencesError = useStore((s) => s.setPreferencesError);
  const updateSession = useStore((s) => s.updateSession);
  const resolvedAgentId = useMemo(
    () => getAgentIdForSession(agentSessionIds, sessionId, selectedAgentId),
    [agentSessionIds, selectedAgentId, sessionId],
  );
  const agentId = creatingAgentId || resolvedAgentId;
  const filePreviewLayoutOwnerKey = JSON.stringify([
    currentUser?.uuid || currentUser?.userId || "",
    currentUser?.tenantId || "",
    agentId,
    sessionId,
  ]);
  const rememberedPreviewSessionCollapsedRef = useRef(
    readFilePreviewLayoutMode(filePreviewLayoutOwnerKey) === "four-fifths",
  );
  const agentWorkspaceMounts = agentUserSpaces[agentId] || emptyUserSpaceMounts;
  const effectiveUserSpaces = agentWorkspaceMounts;
  const userSpacePersistenceScope = useMemo<UserSpacePersistenceScope | null>(() => {
    const userId = currentUser?.uuid || currentUser?.userId;
    return userId ? { userId, tenantId: currentUser?.tenantId } : null;
  }, [currentUser?.tenantId, currentUser?.userId, currentUser?.uuid]);
  const agentWorkspaceRestoreUserKey = userSpacePersistenceScope
    ? `${userSpacePersistenceScope.userId}:${userSpacePersistenceScope.tenantId || ""}`
    : "";
  const agentWorkspaceRestoreKey =
    agentWorkspaceMounts.length > 0
      ? `${agentWorkspaceRestoreUserKey}:${agentId}:${agentWorkspaceMounts.map((mount) => mount.mountId).join("|")}`
      : "";
  const agentWorkspaceRestorePending = Boolean(
    userSpacePersistenceScope &&
    agentWorkspaceRestoreKey &&
    !restoredWorkspaceKeysRef.current.has(agentWorkspaceRestoreKey),
  );
  const activeWorkspaceRestoreOwnerRef = useRef(true);
  const currentAgentWorkspaceRestoreKeyRef = useRef(agentWorkspaceRestoreKey);
  currentAgentWorkspaceRestoreKeyRef.current = agentWorkspaceRestoreKey;
  const logoutLocally = useCallback(() => {
    disconnectAll();
    useStore.getState().logout();
    navigateHome(true, { userUuid: null, agentId: null });
  }, []);

  const handleLogout = useCallback(() => {
    logoutLocally();
    void api.logoutSession();
  }, [logoutLocally]);

  const handleDestroyWorkspaceAndLogout = useCallback(() => {
    logoutLocally();
    void api.destroyWorkspaceAndLogout().catch(() => api.logoutSession());
  }, [logoutLocally]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftPressed(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftPressed(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return undefined;
    const handleCloseIntent = (event: globalThis.MouseEvent | FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUserMenuOpen(false);
    };
    window.addEventListener("mousedown", handleCloseIntent);
    window.addEventListener("focusin", handleCloseIntent);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleCloseIntent);
      window.removeEventListener("focusin", handleCloseIntent);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [userMenuOpen]);

  const preferencesUserKey = userScopeKeyFromCurrentUser(currentUser);
  useEffect(() => {
    if (!preferencesUserKey || preferencesLoaded) return undefined;
    let cancelled = false;
    const lease = runtimeContextCoordinator.current();
    const requestScope =
      lease?.context.userScopeKey === preferencesUserKey ? lease.userScope.child() : null;
    setPreferencesError("");
    api
      .getPreferences(
        requestScope && lease
          ? { signal: requestScope.signal, contextEpoch: lease.context.epoch }
          : undefined,
      )
      .then((result) => {
        if (
          !cancelled &&
          userScopeKeyFromCurrentUser(useStore.getState().currentUser) === preferencesUserKey
        ) {
          setPreferences(result.preferences);
        }
      })
      .catch((err: unknown) => {
        if (
          !cancelled &&
          !isAbortError(err) &&
          userScopeKeyFromCurrentUser(useStore.getState().currentUser) === preferencesUserKey
        ) {
          setPreferencesError(
            err instanceof Error ? err.message : uiCopy.chat.errors.preferencesLoadFailed,
          );
        }
      });
    return () => {
      cancelled = true;
      if (requestScope) void requestScope.dispose();
    };
  }, [preferencesLoaded, preferencesUserKey, setPreferences, setPreferencesError]);

  const handleUserSpacePreferenceChange = useCallback(
    async (key: keyof UserPreferences["userSpace"], value: boolean) => {
      const currentPreferences = useStore.getState().preferences;
      const nextPreferences: UserPreferences = {
        ...currentPreferences,
        userSpace: {
          ...currentPreferences.userSpace,
          [key]: value,
        },
      };
      setPreferences(nextPreferences);
      savePreferencesLatest(nextPreferences);
    },
    [setPreferences],
  );

  const handleOfficeFileDefaultChange = useCallback(
    (value: "preview" | "alternate") => {
      const currentPreferences = useStore.getState().preferences;
      const nextPreferences: UserPreferences = {
        ...currentPreferences,
        filePreviewDefaults: {
          ...currentPreferences.filePreviewDefaults,
          word: value,
          excel: value,
          ppt: value,
        },
      };
      setPreferences(nextPreferences);
      savePreferencesLatest(nextPreferences);
    },
    [setPreferences],
  );

  const loadArchivedSessions = useCallback(async () => {
    setArchivedLoading(true);
    setArchivedError("");
    try {
      const page = await api.listArchivedSessions({ limit: 500 });
      setArchivedSessions(page.sessions);
      setSelectedArchivedSessionIds((selected) => {
        if (selected.size === 0) return selected;
        const availableIds = new Set(page.sessions.map((session) => session.sessionId));
        const next = new Set(Array.from(selected).filter((id) => availableIds.has(id)));
        return next.size === selected.size ? selected : next;
      });
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : uiCopy.chat.archived.loadFailed);
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userSettingsOpen || !currentUser) {
      setSelectedArchivedSessionIds(new Set());
      return;
    }
    setSelectedArchivedSessionIds(new Set());
    void loadArchivedSessions();
  }, [currentUser, loadArchivedSessions, userSettingsOpen]);

  const restoreArchivedSession = useCallback(
    async (targetSessionId: string) => {
      const session = archivedSessions.find((item) => item.sessionId === targetSessionId);
      setArchivedActionId(targetSessionId);
      try {
        await api.unarchiveSession(targetSessionId);
        setArchivedSessions((items) => items.filter((item) => item.sessionId !== targetSessionId));
        setSelectedArchivedSessionIds((selected) => {
          if (!selected.has(targetSessionId)) return selected;
          const next = new Set(selected);
          next.delete(targetSessionId);
          return next;
        });
        if (session) {
          const store = useStore.getState();
          store.setRuntimeSessions(
            [
              ...store.runtimeSessions.filter((item) => item.sessionId !== targetSessionId),
              { ...session, archived: false },
            ].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
          );
        }
      } catch (err) {
        setArchivedError(err instanceof Error ? err.message : uiCopy.chat.archived.restoreFailed);
      } finally {
        setArchivedActionId(null);
      }
    },
    [archivedSessions],
  );

  const hardDeleteArchivedSession = useCallback(
    (targetSessionId: string) => {
      const session = archivedSessions.find((item) => item.sessionId === targetSessionId);
      const rawTitle = session?.name?.trim();
      const title =
        rawTitle && !isPlaceholderSessionName(rawTitle) && !isAgentDisplayName(rawTitle)
          ? rawTitle
          : getDefaultSessionName();
      setArchivedDeleteRequest({ kind: "one", sessionId: targetSessionId, title });
    },
    [archivedSessions],
  );

  const toggleArchivedSessionSelection = useCallback((targetSessionId: string) => {
    setSelectedArchivedSessionIds((selected) => {
      const next = new Set(selected);
      if (next.has(targetSessionId)) next.delete(targetSessionId);
      else next.add(targetSessionId);
      return next;
    });
  }, []);

  const setAllArchivedSessionSelection = useCallback(
    (checked: boolean) => {
      setSelectedArchivedSessionIds(
        checked ? new Set(archivedSessions.map((session) => session.sessionId)) : new Set(),
      );
    },
    [archivedSessions],
  );

  const restoreSelectedArchivedSessions = useCallback(async () => {
    const selected = archivedSessions.filter((session) =>
      selectedArchivedSessionIds.has(session.sessionId),
    );
    if (selected.length === 0) return;
    setArchivedActionId("__batch_restore__");
    setArchivedError("");
    try {
      await Promise.all(selected.map((session) => api.unarchiveSession(session.sessionId)));
      const selectedIds = new Set(selected.map((session) => session.sessionId));
      setArchivedSessions((items) => items.filter((item) => !selectedIds.has(item.sessionId)));
      setSelectedArchivedSessionIds(new Set());
      const store = useStore.getState();
      const restored = selected.map((session) => ({ ...session, archived: false }));
      store.setRuntimeSessions(
        [
          ...store.runtimeSessions.filter((item) => !selectedIds.has(item.sessionId)),
          ...restored,
        ].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      );
    } catch (err) {
      setArchivedError(err instanceof Error ? err.message : uiCopy.chat.archived.bulkRestoreFailed);
    } finally {
      setArchivedActionId(null);
    }
  }, [archivedSessions, selectedArchivedSessionIds]);

  const hardDeleteSelectedArchivedSessions = useCallback(() => {
    const selected = archivedSessions.filter((session) =>
      selectedArchivedSessionIds.has(session.sessionId),
    );
    if (selected.length === 0) return;
    setArchivedDeleteRequest({
      kind: "many",
      sessionIds: selected.map((session) => session.sessionId),
    });
  }, [archivedSessions, selectedArchivedSessionIds]);

  const confirmArchivedSessionDeletion = useCallback(async () => {
    const request = archivedDeleteRequest;
    if (!request || archivedDeleteConfirming) return;
    const selectedIds = new Set(request.kind === "one" ? [request.sessionId] : request.sessionIds);
    const actionId = request.kind === "one" ? request.sessionId : "__batch_delete__";
    setArchivedDeleteConfirming(true);
    setArchivedActionId(actionId);
    setArchivedError("");
    try {
      await Promise.all(Array.from(selectedIds, (sessionId) => api.deleteSession(sessionId)));
      const store = useStore.getState();
      for (const id of selectedIds) store.removeSession(id);
      setArchivedSessions((items) => items.filter((item) => !selectedIds.has(item.sessionId)));
      setSelectedArchivedSessionIds((selected) => {
        const next = new Set(selected);
        for (const id of selectedIds) next.delete(id);
        return next;
      });
      setArchivedDeleteRequest(null);
    } catch (err) {
      setArchivedError(
        err instanceof Error
          ? err.message
          : request.kind === "one"
            ? uiCopy.chat.archived.deleteFailed
            : uiCopy.chat.archived.bulkDeleteFailed,
      );
    } finally {
      setArchivedActionId(null);
      setArchivedDeleteConfirming(false);
    }
  }, [archivedDeleteConfirming, archivedDeleteRequest]);

  const handleAgentWorkspaceConfigured = useCallback(
    (mounts: UserSpaceMount[]) => {
      setAgentUserSpaces(agentId, mounts);
      persistWorkspaceSessionStateNow();
    },
    [agentId, setAgentUserSpaces],
  );

  useEffect(() => {
    activeWorkspaceRestoreOwnerRef.current = true;
    return () => {
      activeWorkspaceRestoreOwnerRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (agentWorkspaceMounts.length === 0 || !userSpacePersistenceScope) return;
    const restoreKey = agentWorkspaceRestoreKey;
    if (restoredWorkspaceKeysRef.current.has(restoreKey)) return;
    restoredWorkspaceKeysRef.current.add(restoreKey);
    setRestoringWorkspaceKey(restoreKey);

    void restorePersistedUserSpaces(userSpacePersistenceScope, agentWorkspaceMounts)
      .then((restoredMounts) => {
        if (
          !activeWorkspaceRestoreOwnerRef.current ||
          currentAgentWorkspaceRestoreKeyRef.current !== restoreKey ||
          restoredMounts.length === 0
        )
          return;
        const nextMounts = agentWorkspaceMounts.map(
          (mount) => restoredMounts.find((restored) => restored.mountId === mount.mountId) || mount,
        );
        if (!sameUserSpaceMounts(agentWorkspaceMounts, nextMounts, { includeStatus: true })) {
          setAgentUserSpaces(agentId, nextMounts);
          persistWorkspaceSessionStateNow();
        }
        const mountedIds = nextMounts
          .filter((mount) => mount.status === "mounted")
          .map((mount) => mount.mountId);
        if (mountedIds.length > 0) {
          workspaceConfigureKeyRef.current = "";
          attachUserSpaceMountsToSession(sessionId, mountedIds);
          resendSessionUserSpaces(sessionId);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (
          activeWorkspaceRestoreOwnerRef.current &&
          currentAgentWorkspaceRestoreKeyRef.current === restoreKey
        )
          setRestoringWorkspaceKey((current) => (current === restoreKey ? "" : current));
      });
  }, [
    agentId,
    agentWorkspaceMounts,
    agentWorkspaceRestoreKey,
    sessionId,
    setAgentUserSpaces,
    userSpacePersistenceScope,
  ]);

  useEffect(() => {
    const currentMountKey = userSpaceSyncKey(userSpaces);
    const desiredMountKey = userSpaceSyncKey(agentWorkspaceMounts);
    const configureKey = `${sessionId}:${agentId}:${currentMountKey}->${desiredMountKey}`;

    if (agentWorkspaceMounts.length === 0) {
      if (userSpaces.length === 0) return;
      if (workspaceConfigureKeyRef.current === configureKey) return;
      const configurationContext = captureUserSpaceConfigurationContext(sessionId, agentId);
      if (!configurationContext) return;
      workspaceConfigureKeyRef.current = configureKey;
      for (const mount of userSpaces) {
        detachUserSpaceFromSession(sessionId, mount.mountId);
      }
      configureUserSpaceLatest({
        context: configurationContext,
        userSpace: null,
        onSuccess: ({ user_space }) => {
          updateSession(sessionId, { userSpace: user_space, userSpaces: [] });
        },
      });
      return;
    }

    // Session switches and WebSocket reconnects can leave the server-side
    // broker marked offline even when the browser still owns a restored
    // directory handle. Re-announce every locally available mount before the
    // equality fast path; attachUserSpaceMountsToSession filters handles that
    // have not been restored yet, and resend is intentionally idempotent.
    attachUserSpaceMountsToSession(
      sessionId,
      agentWorkspaceMounts.map((mount) => mount.mountId),
    );
    resendSessionUserSpaces(sessionId);
    if (sameUserSpaceMounts(userSpaces, agentWorkspaceMounts, { includeStatus: true })) return;
    if (workspaceConfigureKeyRef.current === configureKey) return;
    const configurationContext = captureUserSpaceConfigurationContext(sessionId, agentId);
    if (!configurationContext) return;
    workspaceConfigureKeyRef.current = configureKey;
    configureUserSpaceLatest({
      context: configurationContext,
      userSpace: agentWorkspaceMounts.map(toUserSpaceMetadataItem),
      onSuccess: ({ user_space, user_spaces }) => {
        resendSessionUserSpaces(sessionId);
        updateSession(sessionId, {
          userSpace: user_space,
          userSpaces: user_spaces.length > 0 ? user_spaces : agentWorkspaceMounts,
        });
      },
    });
  }, [agentId, agentWorkspaceMounts, sessionId, updateSession, userSpaces]);

  const getSessionTitle = useCallback(
    (session: PiSessionInfo) => {
      const name = sessionNames.get(session.sessionId) || session.name;
      return isPlaceholderSessionName(name) || isAgentDisplayName(name)
        ? getDefaultSessionName()
        : (name ?? getDefaultSessionName());
    },
    [sessionNames],
  );

  const interactions = useMemo(
    () => (sessionInteractions ? Array.from(sessionInteractions.values()) : []),
    [sessionInteractions],
  );
  const destroyLogoutMode = logoutHovering && shiftPressed;
  const canAccessAdmin = currentUser?.permissions?.includes("admin:access") === true;
  const handleUserSpacePreviewOpenChange = useCallback(
    (open: boolean, options?: { resetLayout?: boolean }) => {
      if (!open && options?.resetLayout) {
        rememberedPreviewSessionCollapsedRef.current = false;
        writeFilePreviewLayoutMode(filePreviewLayoutOwnerKey, "two-fifths");
        setSessionPanelCollapsed(false);
        setUserSpacePreviewOpen(false);
        return;
      }
      if (open === userSpacePreviewOpen) return;
      if (open) {
        setSessionPanelCollapsed(rememberedPreviewSessionCollapsedRef.current);
      } else {
        rememberedPreviewSessionCollapsedRef.current = sessionPanelCollapsed;
        setSessionPanelCollapsed(false);
      }
      setUserSpacePreviewOpen(open);
    },
    [filePreviewLayoutOwnerKey, sessionPanelCollapsed, userSpacePreviewOpen],
  );

  const handleSessionPanelCollapsedChange = useCallback(
    (collapsed: boolean) => {
      rememberedPreviewSessionCollapsedRef.current = collapsed;
      writeFilePreviewLayoutMode(
        filePreviewLayoutOwnerKey,
        collapsed ? "four-fifths" : "two-fifths",
      );
      setSessionPanelCollapsed(collapsed);
    },
    [filePreviewLayoutOwnerKey],
  );

  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const activeDialog =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>('[role="dialog"]')
          : null;
      if (activeDialog && activeDialog.dataset.testid !== "user-menu") return;

      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        setUserMenuOpen(false);
        setSessionSearchRequest((request) => request + 1);
        return;
      }
      if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setUserMenuOpen(false);
        setWorkspaceSearchRequest((request) => request + 1);
        return;
      }
      if (key === "p" && event.shiftKey) {
        event.preventDefault();
        handleUserSpacePreviewOpenChange(!userSpacePreviewOpen);
        return;
      }
      if (key === "b" && event.shiftKey && userSpacePreviewOpen) {
        event.preventDefault();
        handleSessionPanelCollapsedChange(!sessionPanelCollapsed);
        return;
      }
      if (key === "u" && event.shiftKey && userSpacePreviewOpen) {
        event.preventDefault();
        setSpacePanelToggleRequest((request) => request + 1);
        return;
      }
      if (key === "/" && !event.shiftKey) {
        event.preventDefault();
        setUserMenuOpen(false);
        setKeyboardShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [
    handleSessionPanelCollapsedChange,
    handleUserSpacePreviewOpenChange,
    sessionPanelCollapsed,
    userSpacePreviewOpen,
  ]);

  useEffect(() => {
    const collapsed = readFilePreviewLayoutMode(filePreviewLayoutOwnerKey) === "four-fifths";
    rememberedPreviewSessionCollapsedRef.current = collapsed;
    setSessionPanelCollapsed(userSpacePreviewOpen ? collapsed : false);
  }, [filePreviewLayoutOwnerKey, userSpacePreviewOpen]);

  const updateMessageFeedBottomInset = useCallback(() => {
    const composerLayer = floatingComposerLayerRef.current;
    if (!composerLayer) return;
    const height = composerLayer.getBoundingClientRect().height;
    if (height <= 0) return;
    const nextInset = Math.ceil(height + MESSAGE_FEED_COMPOSER_GAP_PX);
    setMessageFeedBottomInsetPx((current) =>
      Math.abs(current - nextInset) < 1 ? current : nextInset,
    );
  }, []);

  useLayoutEffect(() => {
    updateMessageFeedBottomInset();
    const composerLayer = floatingComposerLayerRef.current;
    if (!composerLayer || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateMessageFeedBottomInset);
    observer.observe(composerLayer);
    return () => observer.disconnect();
  }, [updateMessageFeedBottomInset]);

  const workspacePanelBasis = sessionPanelCollapsed
    ? "100%"
    : userSpacePreviewOpen
      ? DEFAULT_WORKSPACE_OPEN_BASIS
      : DEFAULT_WORKSPACE_CLOSED_BASIS;
  const requestComposerDraft = (text: string) => {
    composerDraftSequenceRef.current += 1;
    setComposerDraftRequest({ id: composerDraftSequenceRef.current, text });
  };
  const workbench = (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="chat-workbench-layout"
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={userSpacePanelRef}
          data-testid="chat-user-space-panel"
          className="relative z-10 flex h-full min-h-0 min-w-[var(--piwork-workspace-min-width)] flex-none basis-[var(--piwork-workspace-basis)] overflow-visible"
          style={
            {
              "--piwork-workspace-basis": workspacePanelBasis,
              "--piwork-workspace-min-width": sessionPanelCollapsed
                ? "100%"
                : userSpacePreviewOpen
                  ? `min(${MIN_TREE_PANEL_WIDTH + MIN_PREVIEW_PANEL_WIDTH}px, ${DEFAULT_WORKSPACE_OPEN_BASIS})`
                  : DEFAULT_WORKSPACE_CLOSED_BASIS,
            } as CSSProperties
          }
        >
          <Suspense
            fallback={
              <div
                className="flex h-full w-full items-center justify-center bg-card text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {uiCopy.common.loading}
              </div>
            }
          >
            <UserSpaceExplorer
              sessionId={sessionId}
              agentId={agentId}
              openSearchRequest={workspaceSearchRequest}
              toggleSpacePanelRequest={spacePanelToggleRequest}
              mounts={effectiveUserSpaces}
              persistenceScope={userSpacePersistenceScope || undefined}
              uiLanguage={uiLanguage}
              previewOpen={userSpacePreviewOpen}
              onPreviewOpenChange={handleUserSpacePreviewOpenChange}
              sessionPanelCollapsed={sessionPanelCollapsed}
              onSessionPanelCollapsedChange={handleSessionPanelCollapsedChange}
              onMountsConfigured={handleAgentWorkspaceConfigured}
              workspaceRestoring={
                agentWorkspaceRestorePending ||
                (restoringWorkspaceKey === agentWorkspaceRestoreKey &&
                  agentWorkspaceRestoreKey !== "")
              }
            />
          </Suspense>
          {userSpacePreviewOpen && (
            <span
              aria-hidden="true"
              data-testid="chat-user-space-edge-titlebar-fill"
              className="pointer-events-none absolute right-0 top-0 z-30 h-10 w-px border-b border-border bg-border"
            />
          )}
        </div>
        <div
          data-testid="chat-session-area"
          aria-hidden={sessionPanelCollapsed || undefined}
          inert={sessionPanelCollapsed || undefined}
          className={
            sessionPanelCollapsed
              ? "invisible h-full min-h-0 w-0 flex-none overflow-hidden"
              : "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          }
        >
          <div className="piwork-conversation-surface flex h-10 shrink-0 items-center border-b border-border px-3 sm:px-6">
            <div
              data-testid="agent-titlebar-content"
              className="mx-auto flex h-full w-full max-w-[var(--piwork-composer-width)] items-center gap-2"
            >
              <AgentSessionSelector
                sessionId={sessionId}
                agentId={agentId}
                openSearchRequest={sessionSearchRequest}
                onCreatingAgentChange={setCreatingAgentId}
                onArchiveError={setArchivedError}
              />
              <div className="min-w-0 flex-1" />
              <div
                data-testid="session-actions"
                className="relative flex h-full items-center gap-1"
              >
                <BrowserBridgePanel sessionId={sessionId} />
                {currentUser && (
                  <div ref={userMenuRef} className="relative ml-1 flex h-full items-center">
                    <button
                      ref={userAvatarButtonRef}
                      type="button"
                      aria-label={uiCopy.chat.userDetails}
                      data-testid="user-avatar-button"
                      onClick={() => setUserMenuOpen((open) => !open)}
                      className="flex h-[var(--piwork-titlebar-control-size)] w-[var(--piwork-titlebar-control-size)] shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] bg-accent text-xs font-bold text-accent-foreground transition-colors hover:bg-accent/80"
                    >
                      {getUserInitials(currentUser)}
                    </button>
                    <DropdownMotion
                      open={userMenuOpen}
                      role="dialog"
                      aria-label={uiCopy.chat.userDetails}
                      data-testid="user-menu"
                      style={{ top: "calc(100% + 2px)" }}
                      className="piwork-superellipse-panel absolute right-0 z-50 w-72 rounded-xl border border-border bg-card p-0.5 text-foreground"
                    >
                      <div className="flex items-center gap-2.5 border-b border-border/70 px-2 pb-2 pt-1.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-[var(--piwork-control-radius)] bg-accent text-xs font-bold text-accent-foreground">
                          {getUserInitials(currentUser)}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">
                            {currentUser.displayName}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {currentUser.username}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {currentUser.orgName}
                          </div>
                        </div>
                      </div>
                      <div data-testid="user-menu-appearance" className="space-y-2 px-2 py-2">
                        <div>
                          <div className="mb-1 text-xs font-medium text-muted-foreground">
                            {uiCopy.chat.userMenu.theme}
                          </div>
                          <SegmentedControl
                            ariaLabel={uiCopy.chat.userMenu.theme}
                            className="w-full"
                            isEqualWidth
                            size="sm"
                            value={themeMode}
                            onChange={(mode) => setThemeMode(mode as ThemeMode)}
                            items={[
                              {
                                id: "system",
                                label: (
                                  <span
                                    title={uiCopy.chat.backendTheme.system.description}
                                    aria-label={uiCopy.chat.userMenu.themeOption(
                                      uiCopy.chat.backendTheme.system.label,
                                    )}
                                  >
                                    {uiCopy.chat.backendTheme.system.label}
                                  </span>
                                ),
                              },
                              {
                                id: "light",
                                label: (
                                  <span
                                    title={uiCopy.chat.backendTheme.light.description}
                                    aria-label={uiCopy.chat.userMenu.themeOption(
                                      uiCopy.chat.backendTheme.light.label,
                                    )}
                                  >
                                    {uiCopy.chat.backendTheme.light.label}
                                  </span>
                                ),
                              },
                              {
                                id: "dark",
                                label: (
                                  <span
                                    title={uiCopy.chat.backendTheme.dark.description}
                                    aria-label={uiCopy.chat.userMenu.themeOption(
                                      uiCopy.chat.backendTheme.dark.label,
                                    )}
                                  >
                                    {uiCopy.chat.backendTheme.dark.label}
                                  </span>
                                ),
                              },
                            ]}
                          />
                        </div>
                        <div>
                          <div className="mb-1 text-xs font-medium text-muted-foreground">
                            {uiCopy.topBar.language}
                          </div>
                          <SegmentedControl
                            ariaLabel={uiCopy.topBar.language}
                            className="w-full"
                            isEqualWidth
                            size="sm"
                            value={uiLanguage}
                            onChange={(language) => setUiLanguage(language as UiLanguage)}
                            items={[
                              {
                                id: "zh-CN",
                                label: (
                                  <span
                                    title={uiCopy.topBar.languages.zhCN.description}
                                    aria-label={uiCopy.topBar.languageOption(
                                      uiCopy.topBar.languages.zhCN.label,
                                    )}
                                  >
                                    {uiCopy.topBar.languages.zhCN.label}
                                  </span>
                                ),
                              },
                              {
                                id: "en-US",
                                label: (
                                  <span
                                    title={uiCopy.topBar.languages.enUS.description}
                                    aria-label={uiCopy.topBar.languageOption(
                                      uiCopy.topBar.languages.enUS.label,
                                    )}
                                  >
                                    {uiCopy.topBar.languages.enUS.label}
                                  </span>
                                ),
                              },
                            ]}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5 border-t border-border/70 px-1.5 py-2">
                        {canAccessAdmin && (
                          <button
                            type="button"
                            data-testid="user-menu-admin-button"
                            className="flex h-9 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                            onClick={() => {
                              navigateRbacAdmin(false);
                              setUserMenuOpen(false);
                            }}
                          >
                            <ShieldCheck className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                            {uiCopy.chat.userMenu.admin}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid="user-menu-keyboard-shortcuts-button"
                          className="flex h-9 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                          onClick={() => {
                            setKeyboardShortcutsOpen(true);
                            setUserMenuOpen(false);
                          }}
                        >
                          <Keyboard className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          {uiCopy.chat.userMenu.keyboardShortcuts}
                        </button>
                        <button
                          type="button"
                          className="flex h-9 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                          onClick={() => {
                            setUserSettingsOpen(true);
                            setUserMenuOpen(false);
                          }}
                        >
                          <Settings className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          {uiCopy.chat.preferences}
                        </button>
                        <button
                          type="button"
                          data-testid="user-menu-logout-button"
                          onMouseEnter={(event) => {
                            setLogoutHovering(true);
                            setShiftPressed(event.shiftKey);
                          }}
                          onMouseMove={(event) => setShiftPressed(event.shiftKey)}
                          onMouseLeave={() => setLogoutHovering(false)}
                          onClick={
                            destroyLogoutMode ? handleDestroyWorkspaceAndLogout : handleLogout
                          }
                          className={`flex h-9 w-full items-center gap-2 rounded-[var(--piwork-control-radius)] px-3 text-left text-sm font-semibold transition-colors ${
                            destroyLogoutMode
                              ? "bg-danger text-danger-foreground hover:bg-danger/90"
                              : "bg-danger/10 text-danger hover:bg-danger/15"
                          }`}
                        >
                          {destroyLogoutMode ? (
                            <Power className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          ) : (
                            <LogOut className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          )}
                          {destroyLogoutMode
                            ? uiCopy.chat.userMenu.destroyAndLogout
                            : uiCopy.chat.userMenu.logout}
                        </button>
                      </div>
                    </DropdownMotion>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            data-testid="chat-floating-stage"
            className={`piwork-conversation-surface relative flex min-h-0 flex-1 flex-col overflow-hidden ${WORKSPACE_PANEL_BG_CLASS}`}
          >
            <MessageFeed
              sessionId={sessionId}
              suppressScrollToBottom={interactions.length > 0}
              bottomInsetPx={messageFeedBottomInsetPx}
              hasUserSpace={effectiveUserSpaces.length > 0}
              onOpenWorkspace={() =>
                userSpacePanelRef.current
                  ?.querySelector<HTMLElement>("button, [tabindex='0']")
                  ?.focus()
              }
              onPrefillComposer={requestComposerDraft}
            />

            <div
              ref={floatingComposerLayerRef}
              data-testid="floating-composer-layer"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-30"
            >
              <div className="pointer-events-auto">
                {interactions.length > 0 ? (
                  <div className="shrink-0 px-3 pb-4 pt-3 sm:px-6 sm:pb-5">
                    <div className="mx-auto w-full max-w-[var(--piwork-composer-width)] space-y-2">
                      {interactions.map((interaction) => (
                        <InteractionCard
                          key={interaction.id}
                          interaction={interaction}
                          sessionId={sessionId}
                          inline
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <Composer sessionId={sessionId} draftRequest={composerDraftRequest} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {currentUser && userSettingsOpen && (
        <UserSettingsDialog
          user={currentUser}
          archivedSessions={archivedSessions}
          selectedArchivedSessionIds={selectedArchivedSessionIds}
          archivedLoading={archivedLoading}
          archivedError={archivedError}
          archivedActionId={archivedActionId}
          preferences={preferences}
          preferencesError={preferencesError}
          uiLanguage={uiLanguage}
          agentSessionIds={agentSessionIds}
          agentSessionHistoryIds={agentSessionHistoryIds}
          getSessionTitle={getSessionTitle}
          onUserSpacePreferenceChange={handleUserSpacePreferenceChange}
          onOfficeFileDefaultChange={handleOfficeFileDefaultChange}
          onToggleArchivedSessionSelection={toggleArchivedSessionSelection}
          onSetAllArchivedSessionSelection={setAllArchivedSessionSelection}
          onRestoreArchivedSession={restoreArchivedSession}
          onHardDeleteArchivedSession={hardDeleteArchivedSession}
          onRestoreSelectedArchivedSessions={restoreSelectedArchivedSessions}
          onHardDeleteSelectedArchivedSessions={hardDeleteSelectedArchivedSessions}
          onClose={() => {
            setUserSettingsOpen(false);
            requestAnimationFrame(() => userAvatarButtonRef.current?.focus());
          }}
        />
      )}
      <KeyboardShortcutsDialog
        isOpen={keyboardShortcutsOpen}
        onOpenChange={(open) => {
          setKeyboardShortcutsOpen(open);
          if (!open) requestAnimationFrame(() => userAvatarButtonRef.current?.focus());
        }}
      />
      <Dialog
        closeLabel={uiCopy.common.close}
        footer={
          <>
            <Button
              isDisabled={archivedDeleteConfirming}
              onPress={() => setArchivedDeleteRequest(null)}
              size="sm"
              variant="secondary"
            >
              {uiCopy.common.cancel}
            </Button>
            <Button
              loading={archivedDeleteConfirming}
              onPress={() => void confirmArchivedSessionDeletion()}
              size="sm"
              variant="danger"
            >
              {archivedDeleteRequest?.kind === "many"
                ? uiCopy.chat.archived.bulkDelete
                : uiCopy.chat.archived.delete}
            </Button>
          </>
        }
        isDismissable={!archivedDeleteConfirming}
        isOpen={archivedDeleteRequest !== null}
        onOpenChange={(open) => {
          if (!open && !archivedDeleteConfirming) setArchivedDeleteRequest(null);
        }}
        size="sm"
        title={
          archivedDeleteRequest?.kind === "many"
            ? uiCopy.chat.archived.bulkDelete
            : uiCopy.chat.archived.delete
        }
      >
        <p className="text-sm leading-6 text-secondary-foreground">
          {archivedDeleteRequest?.kind === "one"
            ? uiCopy.chat.archived.deleteOneConfirm(archivedDeleteRequest.title)
            : uiCopy.chat.archived.bulkDeleteConfirm(archivedDeleteRequest?.sessionIds.length || 0)}
        </p>
      </Dialog>
    </div>
  );

  return (
    <LobeThemeProvider
      appearance={darkMode ? "dark" : "light"}
      className="contents"
      enableGlobalStyle={false}
    >
      {workbench}
    </LobeThemeProvider>
  );
}
