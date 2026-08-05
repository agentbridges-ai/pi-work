import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Archive, ChevronDown, ChevronRight, Pencil, Search } from "lucide-react";
import { DropdownMotion, IconButton } from "../ui/index.js";
import { CodexPlusIcon } from "../CodexIcons.js";
import { api } from "../../api.js";
import {
  AGENTS,
  getAgent,
  getAgentDisplayName,
  isAgentDisplayName,
  type Agent,
  type AgentId,
} from "../../agents.js";
import { useStore, type AppState } from "../../store.js";
import type { BackendType, PiSessionInfo, UserSpaceMount } from "../../types.js";
import { uiCopy } from "../../ui-copy.js";
import { attachUserSpaceMountsToSession } from "../../user-space.js";
import { beginRuntimeContextTransition } from "../../runtime-context-switch.js";
import { isAbortError, runtimeContextCoordinator } from "../../runtime-context.js";
import {
  rawUserIdFromCurrentUser,
  userScopeKeyFromCurrentUser,
} from "../../store/user-scoped-storage.js";
import { persistWorkspaceSessionStateNow } from "../../workspace-session-state.js";
import { connectSession } from "../../ws.js";
import { getDefaultSessionName, isPlaceholderSessionName } from "../../utils/names.js";
import { navigateHome, navigateToSession, type RouteContext } from "../../utils/routing.js";
import {
  formatSessionTime,
  getSessionDisplayMeta,
  getSessionSortPriority,
  getSessionSystemState,
  toUserSpaceMetadata,
} from "../chat-view-session-utils.js";
import { useSessionMenuMessageTimes } from "../use-session-menu-message-times.js";
import { useAutoFocusSearchInput } from "../use-auto-focus-search-input.js";

const emptyUserSpaceMounts: UserSpaceMount[] = [];

type SelectorPanel = "agent" | "topic" | null;

type SessionPageState = {
  cursor: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error?: string;
};

function getAgentHistoryFromState(
  state: Pick<AppState, "agentSessionHistoryIds" | "agentSessionIds" | "runtimeSessions">,
  agentId: AgentId,
): PiSessionInfo[] {
  const historyIds = new Set(state.agentSessionHistoryIds[agentId] || []);
  return state.runtimeSessions
    .filter((session) => !session.archived)
    .filter(
      (session) =>
        historyIds.has(session.sessionId) || session.sessionId === state.agentSessionIds[agentId],
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function reconcileArchivedSessionList(expectedUserScopeKey: string, targetSessionId: string): void {
  const store = useStore.getState();
  if (userScopeKeyFromCurrentUser(store.currentUser) !== expectedUserScopeKey) return;
  const reconciledSessions = store.runtimeSessions.filter(
    (session) => session.sessionId !== targetSessionId,
  );
  if (reconciledSessions.length !== store.runtimeSessions.length) {
    // A newer transition owns agent/session authority. Reconcile only the
    // session list backing visible history after the server archive succeeds.
    store.setRuntimeSessions(reconciledSessions);
  }
}

export type AgentSessionSelectorProps = {
  sessionId: string;
  agentId: AgentId;
  openSearchRequest?: number;
  onCreatingAgentChange: (agentId: AgentId | null) => void;
  onArchiveError: (message: string) => void;
};

function pointInTriangle(
  point: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const sign = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Owns the agent/topic lifecycle seam: discovery, paging, ordering, rename,
 * creation, activation, and archival all commit through one runtime transition.
 */
export function AgentSessionSelector({
  sessionId,
  agentId,
  openSearchRequest = 0,
  onCreatingAgentChange,
  onArchiveError,
}: AgentSessionSelectorProps) {
  const [selectorPanel, setSelectorPanel] = useState<SelectorPanel>(null);
  const [selectorAgentId, setSelectorAgentId] = useState<AgentId | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [topicSearch, setTopicSearch] = useState("");
  const [sessionPagesByAgent, setSessionPagesByAgent] = useState<
    Partial<Record<AgentId, SessionPageState>>
  >({});
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);
  const [topicPopoverLeft, setTopicPopoverLeft] = useState(0);

  const renameCancelledRef = useRef(false);
  const renameSavingRef = useRef(false);
  const creatingRef = useRef(false);
  const selectorAnchorRef = useRef<HTMLDivElement | null>(null);
  const topicSelectorButtonRef = useRef<HTMLButtonElement | null>(null);
  const pointerTrailRef = useRef<Array<{ x: number; y: number }>>([]);
  const pendingAgentHoverRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topicPanelRef = useRef<HTMLDivElement | null>(null);
  const handledOpenSearchRequestRef = useRef(0);

  const agentSessionIds = useStore((state) => state.agentSessionIds);
  const agentSessionHistoryIds = useStore((state) => state.agentSessionHistoryIds);
  const runtimeSessions = useStore((state) => state.runtimeSessions);
  const sessionNames = useStore((state) => state.sessionNames);
  const runStateById = useStore((state) => state.runStates);
  const runActiveById = useStore((state) => state.runActive);
  const activityById = useStore((state) => state.agentActivity);
  const runtimeConnectedById = useStore((state) => state.runtimeConnected);
  const pendingInteractionsById = useStore((state) => state.pendingInteractions);
  const agentUserSpaces = useStore((state) => state.agentUserSpaces);
  const currentUser = useStore((state) => state.currentUser);

  const agent = useMemo(() => getAgent(agentId), [agentId]);
  const focusedAgentId = selectorAgentId || agentId;
  const focusedAgent = useMemo(() => getAgent(focusedAgentId), [focusedAgentId]);
  const topicPanelOpen = selectorPanel === "topic";
  const selectorOpen = selectorPanel !== null;
  const agentPanelOpen = selectorPanel === "agent";
  const lastSelectorPanelRef = useRef<Exclude<SelectorPanel, null>>("agent");
  if (selectorPanel) lastSelectorPanelRef.current = selectorPanel;
  const renderedSelectorPanel = selectorPanel || lastSelectorPanelRef.current;
  const topicSearchInputRef = useAutoFocusSearchInput<HTMLInputElement>(
    selectorOpen,
    `${selectorPanel || "closed"}:${focusedAgentId}:${openSearchRequest}`,
  );

  const routeContextForAgent = useCallback(
    (targetAgentId: AgentId): RouteContext => ({
      userUuid: currentUser?.uuid || currentUser?.userId,
      agentId: targetAgentId,
    }),
    [currentUser?.uuid, currentUser?.userId],
  );

  const mergeRuntimeSessions = useCallback((incoming: PiSessionInfo[]) => {
    if (incoming.length === 0) return;
    const store = useStore.getState();
    const byId = new Map(store.runtimeSessions.map((session) => [session.sessionId, session]));
    for (const session of incoming) {
      byId.set(session.sessionId, { ...byId.get(session.sessionId), ...session });
    }
    store.setRuntimeSessions(
      Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    );
  }, []);

  const loadAgentSessionPage = useCallback(
    async (targetAgentId: AgentId, options: { reset?: boolean } = {}) => {
      const currentPage = sessionPagesByAgent[targetAgentId];
      if (currentPage?.loading) return;
      const cursor = options.reset ? 0 : currentPage?.cursor || 0;
      setSessionPagesByAgent((pages) => ({
        ...pages,
        [targetAgentId]: {
          cursor,
          hasMore: options.reset ? false : pages[targetAgentId]?.hasMore || false,
          loaded: options.reset ? false : pages[targetAgentId]?.loaded || false,
          loading: true,
        },
      }));
      try {
        const page = await api.listSessionsPage({
          agentId: targetAgentId,
          cursor,
          limit: 100,
        });
        mergeRuntimeSessions(page.sessions);
        setSessionPagesByAgent((pages) => ({
          ...pages,
          [targetAgentId]: {
            cursor: page.nextCursor,
            hasMore: page.hasMore,
            loaded: true,
            loading: false,
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSessionPagesByAgent((pages) => ({
          ...pages,
          [targetAgentId]: {
            cursor,
            hasMore: pages[targetAgentId]?.hasMore || false,
            loaded: pages[targetAgentId]?.loaded || false,
            loading: false,
            error: message,
          },
        }));
      }
    },
    [mergeRuntimeSessions, sessionPagesByAgent],
  );

  const focusedAgentPage = sessionPagesByAgent[focusedAgentId];
  const getAgentHistory = useCallback(
    (targetAgentId: AgentId) =>
      getAgentHistoryFromState(
        { agentSessionHistoryIds, agentSessionIds, runtimeSessions },
        targetAgentId,
      ),
    [agentSessionHistoryIds, agentSessionIds, runtimeSessions],
  );

  useEffect(() => {
    if (selectorPanel !== "topic") return;
    const page = sessionPagesByAgent[focusedAgentId];
    if (page?.loaded || page?.loading || page?.error) return;
    void loadAgentSessionPage(focusedAgentId, { reset: true });
  }, [focusedAgentId, loadAgentSessionPage, selectorPanel, sessionPagesByAgent]);

  useEffect(() => {
    if (openSearchRequest <= handledOpenSearchRequestRef.current) return;
    handledOpenSearchRequestRef.current = openSearchRequest;
    setSelectorAgentId(agentId);
    setSelectorPanel("topic");
    setTopicSearch("");
  }, [agentId, openSearchRequest]);

  const focusedAgentHistory = useMemo(
    () => getAgentHistory(focusedAgentId),
    [focusedAgentId, getAgentHistory],
  );
  const sessionMenuMessageTimes = useSessionMenuMessageTimes(focusedAgentHistory, topicPanelOpen);
  const filteredFocusedHistory = useMemo(() => {
    const query = topicSearch.trim().toLowerCase();
    const filtered = !query
      ? focusedAgentHistory
      : focusedAgentHistory.filter((session) => {
          const title = (sessionNames.get(session.sessionId) || session.name || "").toLowerCase();
          const model = session.model
            ? `${session.model.provider}/${session.model.modelId}`.toLowerCase()
            : "";
          return (
            title.includes(query) ||
            model.includes(query) ||
            session.sessionId.toLowerCase().includes(query)
          );
        });
    return filtered
      .map((session) => ({
        session,
        meta: getSessionDisplayMeta(
          session.sessionId,
          runStateById,
          pendingInteractionsById,
          runActiveById,
        ),
      }))
      .sort((a, b) => {
        const priorityDelta = getSessionSortPriority(a.meta) - getSessionSortPriority(b.meta);
        if (priorityDelta !== 0) return priorityDelta;
        return (
          (sessionMenuMessageTimes[b.session.sessionId] || b.session.createdAt || 0) -
          (sessionMenuMessageTimes[a.session.sessionId] || a.session.createdAt || 0)
        );
      })
      .map((item) => item.session);
  }, [
    runActiveById,
    focusedAgentHistory,
    pendingInteractionsById,
    runStateById,
    sessionMenuMessageTimes,
    sessionNames,
    topicSearch,
  ]);

  const topicGroups = useMemo(() => {
    const running: PiSessionInfo[] = [];
    const active: PiSessionInfo[] = [];
    const idle: PiSessionInfo[] = [];
    for (const session of filteredFocusedHistory) {
      const meta = getSessionDisplayMeta(
        session.sessionId,
        runStateById,
        pendingInteractionsById,
        runActiveById,
      );
      const state = getSessionSystemState(
        session,
        meta,
        runtimeConnectedById.get(session.sessionId) === true,
      );
      if (state === "running") running.push(session);
      else if (state === "active") active.push(session);
      else idle.push(session);
    }
    return [
      {
        key: "running",
        label: uiCopy.chat.runningGroup,
        sessions: running,
        labelClassName: "text-foreground",
      },
      {
        key: "active",
        label: uiCopy.chat.activeGroup,
        sessions: active,
        labelClassName: "text-success",
      },
      {
        key: "idle",
        label: uiCopy.chat.idleGroup,
        sessions: idle,
        labelClassName: "text-muted-foreground",
      },
    ].filter((group) => group.sessions.length > 0);
  }, [
    runActiveById,
    filteredFocusedHistory,
    pendingInteractionsById,
    runStateById,
    runtimeConnectedById,
  ]);

  const currentRuntimeSession = useMemo(
    () => runtimeSessions.find((session) => session.sessionId === sessionId),
    [runtimeSessions, sessionId],
  );

  const getSessionTitle = useCallback(
    (session: PiSessionInfo) => {
      const name = sessionNames.get(session.sessionId) || session.name;
      return isPlaceholderSessionName(name) || isAgentDisplayName(name)
        ? getDefaultSessionName()
        : (name ?? getDefaultSessionName());
    },
    [sessionNames],
  );

  const createConversationForAgent = useCallback(
    async (targetAgent: Agent) => {
      if (creatingRef.current || creating) return;
      creatingRef.current = true;
      setCreating(true);
      onCreatingAgentChange(targetAgent.id);
      const backend: BackendType = "pi";
      const targetAgentUserSpaces = agentUserSpaces[targetAgent.id] || emptyUserSpaceMounts;
      const initiatingStore = useStore.getState();
      const initiatingUserId = rawUserIdFromCurrentUser(initiatingStore.currentUser);
      const initiatingUserScopeKey = userScopeKeyFromCurrentUser(initiatingStore.currentUser);
      const initiatingLease = runtimeContextCoordinator.current();
      const operationScope = initiatingLease
        ? runtimeContextCoordinator.operationScope(initiatingLease.context)
        : null;

      try {
        const availableModels = await api.getBackendModels(targetAgent.id);
        const model = availableModels[0]?.model;
        if (!model) {
          throw new Error(uiCopy.piRuntime.noModels);
        }
        const store = useStore.getState();
        if (
          operationScope?.signal.aborted ||
          userScopeKeyFromCurrentUser(store.currentUser) !== initiatingUserScopeKey
        )
          return;
        store.clearCreation();
        store.setSessionCreating(true, backend);
        store.addCreationProgress({
          step: "launching_pi",
          label: uiCopy.chat.startingAgentSession(targetAgent.name),
          status: "in_progress",
        });
        const result = await api.createSession(
          {
            backend,
            agentId: targetAgent.id,
            model,
            userSpace: toUserSpaceMetadata(targetAgentUserSpaces),
          },
          {
            signal: operationScope?.signal,
            contextEpoch: initiatingLease?.context.epoch,
          },
        );
        const transitionStore = useStore.getState();
        if (
          operationScope?.signal.aborted ||
          userScopeKeyFromCurrentUser(transitionStore.currentUser) !== initiatingUserScopeKey
        )
          return;
        transitionStore.addCreationProgress({
          step: "launching_pi",
          label: uiCopy.chat.agentSessionStarted,
          status: "done",
        });
        const runtimeSession: PiSessionInfo = {
          sessionId: result.sessionId,
          state: result.state as PiSessionInfo["state"],
          cwd: result.cwd,
          createdAt: Date.now(),
          backendType: result.backendType,
          transport: result.transport,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          mode: result.mode,
        };
        const transition = beginRuntimeContextTransition(
          {
            userId: initiatingUserId,
            userScopeKey: initiatingUserScopeKey,
            agentId: targetAgent.id,
            sessionId: result.sessionId,
          },
          { activateSession: false },
        );
        const committed = await transition.commit(() => {
          const nextStore = useStore.getState();
          nextStore.setRuntimeSessions([
            ...nextStore.runtimeSessions.filter(
              (session) => session.sessionId !== result.sessionId,
            ),
            runtimeSession,
          ]);
          nextStore.bindSessionToAgent(targetAgent.id, result.sessionId);
          nextStore.setSelectedAgentId(targetAgent.id);
          nextStore.setPreviousAgentMode(result.sessionId, result.mode);
          nextStore.clearCreation();
          nextStore.setCurrentSession(result.sessionId);
          persistWorkspaceSessionStateNow();
        });
        if (!committed) return;
        navigateToSession(result.sessionId, true, routeContextForAgent(targetAgent.id));
        connectSession(result.sessionId);
        setSelectorPanel(null);
        if (targetAgentUserSpaces.length > 0) {
          attachUserSpaceMountsToSession(
            result.sessionId,
            targetAgentUserSpaces.map((mount) => mount.mountId),
          );
        }
      } catch (error) {
        if (isAbortError(error)) return;
        const message = error instanceof Error ? error.message : String(error);
        const nextStore = useStore.getState();
        nextStore.setCreationError(message || uiCopy.chat.errors.startAgentFailed);
        nextStore.setSessionCreating(false);
      } finally {
        if (operationScope) void operationScope.dispose();
        creatingRef.current = false;
        setCreating(false);
        onCreatingAgentChange(null);
      }
    },
    [creating, agentUserSpaces, onCreatingAgentChange, routeContextForAgent],
  );

  const handleSelectHistory = useCallback(
    async (targetSessionId: string, targetAgentId: AgentId = agentId) => {
      setEditingSessionId(null);
      if (targetSessionId === sessionId) {
        setSelectorPanel(null);
        return;
      }
      const targetSession = useStore
        .getState()
        .runtimeSessions.find((item) => item.sessionId === targetSessionId);
      try {
        if (!targetSession) throw new Error("Session not found");
        const transitionStore = useStore.getState();
        transitionStore.setCreationError(null);
        setSessionPagesByAgent((pages) => {
          const page = pages[targetAgentId];
          if (!page?.error) return pages;
          return { ...pages, [targetAgentId]: { ...page, error: undefined } };
        });
        const transition = beginRuntimeContextTransition({
          userId: rawUserIdFromCurrentUser(transitionStore.currentUser),
          userScopeKey: userScopeKeyFromCurrentUser(transitionStore.currentUser),
          agentId: targetAgentId,
          sessionId: targetSessionId,
        });
        const committed = await transition.commit(() => {
          const store = useStore.getState();
          store.setRuntimeSessions([
            ...store.runtimeSessions.filter((item) => item.sessionId !== targetSessionId),
            targetSession,
          ]);
          store.bindSessionToAgent(targetAgentId, targetSessionId);
          store.setSelectedAgentId(targetAgentId);
          store.setCurrentSession(targetSessionId);
          persistWorkspaceSessionStateNow();
        });
        if (!committed) return;
        navigateToSession(targetSessionId, false, routeContextForAgent(targetAgentId));
        connectSession(targetSessionId);
        setSelectorPanel(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        useStore.getState().setCreationError(message);
        setSessionPagesByAgent((pages) => ({
          ...pages,
          [targetAgentId]: {
            cursor: pages[targetAgentId]?.cursor || 0,
            hasMore: pages[targetAgentId]?.hasMore || false,
            loading: false,
            loaded: pages[targetAgentId]?.loaded || false,
            error: message,
          },
        }));
      }
    },
    [agentId, routeContextForAgent, sessionId],
  );

  const startRename = useCallback(
    (session: PiSessionInfo) => {
      renameCancelledRef.current = false;
      setEditingSessionId(session.sessionId);
      setEditingName(getSessionTitle(session));
      setRenameError("");
    },
    [getSessionTitle],
  );

  const saveRename = useCallback(async () => {
    if (!editingSessionId) return;
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    if (renameSavingRef.current) return;
    const nextName = editingName.trim();
    if (!nextName) {
      setRenameError(uiCopy.chat.renameSessionEmpty);
      return;
    }
    const existingSession = runtimeSessions.find(
      (session) => session.sessionId === editingSessionId,
    );
    if (existingSession && nextName === getSessionTitle(existingSession)) {
      setEditingSessionId(null);
      setEditingName("");
      return;
    }
    renameSavingRef.current = true;
    setRenameError("");
    try {
      const result = await api.renameSession(editingSessionId, nextName);
      useStore.getState().setSessionName(editingSessionId, result.name || nextName);
      setEditingSessionId(null);
      setEditingName("");
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : uiCopy.chat.errors.renameFailed);
    } finally {
      renameSavingRef.current = false;
    }
  }, [editingName, editingSessionId, getSessionTitle, runtimeSessions]);

  const cancelRename = useCallback(() => {
    renameCancelledRef.current = true;
    setEditingSessionId(null);
    setEditingName("");
    setRenameError("");
  }, []);

  const archiveHistorySession = useCallback(
    async (targetSessionId: string, targetAgentId: AgentId = agentId) => {
      setArchivingSessionId(targetSessionId);
      onArchiveError("");
      let transition: ReturnType<typeof beginRuntimeContextTransition> | null = null;
      let archiveSucceeded = false;
      let needsPostArchiveFallback = false;
      const initiatingUserScopeKey = userScopeKeyFromCurrentUser(useStore.getState().currentUser);
      try {
        let nextSession = getAgentHistory(targetAgentId).find(
          (session) => session.sessionId !== targetSessionId,
        );
        if (targetSessionId === sessionId) {
          const store = useStore.getState();
          transition = beginRuntimeContextTransition({
            userId: rawUserIdFromCurrentUser(store.currentUser),
            userScopeKey: userScopeKeyFromCurrentUser(store.currentUser),
            agentId: targetAgentId,
            sessionId: nextSession?.sessionId || null,
          });
          if (!(await transition.prepare())) {
            await transition.cancel();
            return;
          }
        }
        await api.archiveSession(targetSessionId);
        archiveSucceeded = true;
        if (!transition) {
          const store = useStore.getState();
          if (userScopeKeyFromCurrentUser(store.currentUser) !== initiatingUserScopeKey) return;
          if (store.currentSessionId !== targetSessionId) {
            store.removeSession(targetSessionId);
            return;
          }
          nextSession = getAgentHistoryFromState(store, targetAgentId).find(
            (session) => session.sessionId !== targetSessionId,
          );
          transition = beginRuntimeContextTransition({
            userId: rawUserIdFromCurrentUser(store.currentUser),
            userScopeKey: initiatingUserScopeKey,
            agentId: targetAgentId,
            sessionId: nextSession?.sessionId || null,
          });
          needsPostArchiveFallback = true;
        }
        const committed = await transition.commit(() => {
          const store = useStore.getState();
          store.removeSession(targetSessionId);
          if (nextSession) {
            store.bindSessionToAgent(targetAgentId, nextSession.sessionId);
            store.setCurrentSession(nextSession.sessionId);
          } else {
            store.clearAgentSessionBinding(targetAgentId);
            store.setCurrentSession(null);
          }
          persistWorkspaceSessionStateNow();
        });
        if (!committed) {
          reconcileArchivedSessionList(initiatingUserScopeKey, targetSessionId);
          return;
        }
        if (nextSession) {
          navigateToSession(nextSession.sessionId, false, routeContextForAgent(targetAgentId));
          connectSession(nextSession.sessionId);
        } else {
          navigateHome(false, routeContextForAgent(targetAgentId));
        }
      } catch (error) {
        if (transition) await transition.cancel();
        if (!isAbortError(error)) {
          if (archiveSucceeded && needsPostArchiveFallback) {
            const store = useStore.getState();
            if (
              userScopeKeyFromCurrentUser(store.currentUser) === initiatingUserScopeKey &&
              store.currentSessionId === targetSessionId
            ) {
              // The server archive and fallback activation form one user-visible
              // operation. Restore the target when activation fails so the
              // still-active client context never points at an archived session.
              try {
                await api.unarchiveSession(targetSessionId);
              } catch {
                // Preserve the activation error. A refresh will reconcile the
                // authoritative server state if the compensating write also fails.
              }
            }
          }
          onArchiveError(
            error instanceof Error ? error.message : uiCopy.chat.archived.restoreFailed,
          );
        }
      } finally {
        setArchivingSessionId(null);
      }
    },
    [agentId, getAgentHistory, onArchiveError, routeContextForAgent, sessionId],
  );

  const openSelector = useCallback(
    (panel: Exclude<SelectorPanel, null>) => {
      setSelectorPanel((current) => {
        const next = current === panel ? null : panel;
        if (next) {
          setSelectorAgentId(agentId);
          setTopicSearch("");
          setEditingSessionId(null);
          setRenameError("");
        }
        return next;
      });
    },
    [agentId],
  );

  const updateMenuPointerTrail = useCallback((event: MouseEvent) => {
    pointerTrailRef.current = [
      ...pointerTrailRef.current,
      { x: event.clientX, y: event.clientY },
    ].slice(-3);
  }, []);

  const focusAgentInSelector = useCallback((targetAgentId: AgentId) => {
    if (pendingAgentHoverRef.current) {
      clearTimeout(pendingAgentHoverRef.current);
      pendingAgentHoverRef.current = null;
    }
    setSelectorAgentId(targetAgentId);
    setEditingSessionId(null);
    setRenameError("");
  }, []);

  const shouldDelayAgentHover = useCallback((event: MouseEvent): boolean => {
    const trail = pointerTrailRef.current;
    const previous = trail.length > 1 ? trail[trail.length - 2] : trail[0];
    const topicRect = topicPanelRef.current?.getBoundingClientRect();
    if (!previous || !topicRect) return false;
    const current = { x: event.clientX, y: event.clientY };
    if (current.x - previous.x < 6) return false;
    return pointInTriangle(
      current,
      previous,
      { x: topicRect.left, y: topicRect.top },
      { x: topicRect.left, y: topicRect.bottom },
    );
  }, []);

  const handleAgentPreview = useCallback(
    (targetAgentId: AgentId, event: MouseEvent) => {
      if (targetAgentId === focusedAgentId) return;
      if (pendingAgentHoverRef.current) {
        clearTimeout(pendingAgentHoverRef.current);
        pendingAgentHoverRef.current = null;
      }
      if (shouldDelayAgentHover(event)) {
        pendingAgentHoverRef.current = setTimeout(() => focusAgentInSelector(targetAgentId), 220);
        return;
      }
      focusAgentInSelector(targetAgentId);
    },
    [focusedAgentId, focusAgentInSelector, shouldDelayAgentHover],
  );

  const cancelPendingAgentHover = useCallback(() => {
    if (pendingAgentHoverRef.current) {
      clearTimeout(pendingAgentHoverRef.current);
      pendingAgentHoverRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cancelPendingAgentHover();
    },
    [cancelPendingAgentHover],
  );

  useLayoutEffect(() => {
    if (!selectorOpen || !topicPanelOpen) return undefined;
    const updateTopicPopoverLeft = () => {
      const anchor = selectorAnchorRef.current;
      const topicButton = topicSelectorButtonRef.current;
      if (!anchor || !topicButton) return;
      const anchorRect = anchor.getBoundingClientRect();
      const topicRect = topicButton.getBoundingClientRect();
      const nextLeft = Math.max(0, Math.round(topicRect.left - anchorRect.left));
      setTopicPopoverLeft((current) => (current === nextLeft ? current : nextLeft));
    };
    updateTopicPopoverLeft();
    window.addEventListener("resize", updateTopicPopoverLeft);
    return () => window.removeEventListener("resize", updateTopicPopoverLeft);
  }, [selectorOpen, topicPanelOpen]);

  useEffect(() => {
    if (!selectorOpen) return undefined;
    const handleCloseIntent = (event: globalThis.MouseEvent | FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && selectorAnchorRef.current?.contains(target)) return;
      setSelectorPanel(null);
      setSelectorAgentId(null);
      cancelPendingAgentHover();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectorPanel(null);
        setSelectorAgentId(null);
        cancelPendingAgentHover();
      }
    };
    window.addEventListener("mousedown", handleCloseIntent);
    window.addEventListener("focusin", handleCloseIntent);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleCloseIntent);
      window.removeEventListener("focusin", handleCloseIntent);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [cancelPendingAgentHover, selectorOpen]);

  const currentTopicTitle = currentRuntimeSession
    ? getSessionTitle(currentRuntimeSession)
    : getDefaultSessionName();

  const topicPanel = (
    <div className="min-w-0">
      <div data-testid="topic-toolbar" className="mb-1.5 flex h-8 items-center gap-1.5 pr-1">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--piwork-control-radius)] border border-input bg-background px-2.5 text-muted-foreground transition-colors focus-within:border-ring">
          <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={topicSearchInputRef}
            data-testid="session-search-input"
            type="search"
            value={topicSearch}
            onChange={(event) => setTopicSearch(event.target.value)}
            aria-label={uiCopy.chat.searchSession}
            placeholder={uiCopy.chat.searchSession}
            className="min-w-0 flex-1 bg-transparent text-xs font-medium text-foreground outline-none placeholder:text-foreground"
          />
        </label>
        <span className="inline-flex" title={uiCopy.chat.createSession}>
          <IconButton
            label={uiCopy.chat.createSession}
            size="sm"
            variant="ghost"
            isDisabled={creating}
            onPress={() => void createConversationForAgent(focusedAgent)}
            className="h-8 min-h-8 w-8 min-w-8 rounded-[var(--piwork-control-radius)] border border-border bg-accent bg-clip-padding p-0 text-foreground hover:bg-accent data-[hover=true]:bg-accent"
          >
            <CodexPlusIcon className="h-5 w-5" />
          </IconButton>
        </span>
      </div>
      <div className="h-[300px] rounded-xl bg-card">
        <div data-testid="topic-list" className="h-full overflow-y-auto pr-1">
          {topicGroups.length > 0 ? (
            topicGroups.map((group) => (
              <section
                key={group.key}
                aria-label={uiCopy.chat.sessionGroupLabel(group.label)}
                className="pb-2 last:pb-0"
              >
                <div
                  className={`sticky top-0 z-10 mb-1 bg-card px-2 py-1 text-xs font-semibold ${group.labelClassName}`}
                >
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.sessions.map((session) => {
                    const active = session.sessionId === sessionId;
                    const title = getSessionTitle(session);
                    const meta = getSessionDisplayMeta(
                      session.sessionId,
                      runStateById,
                      pendingInteractionsById,
                      runActiveById,
                    );
                    const activity = activityById.get(session.sessionId);
                    const attentionLabel = meta.needsConfirmation
                      ? uiCopy.chat.waitingReply
                      : activity?.attention === "blocked"
                        ? uiCopy.activity.status.blocked
                        : activity?.attention === "review_ready"
                          ? uiCopy.activity.status.reviewReady
                          : activity?.operation === "retrying"
                            ? uiCopy.activity.status.retrying
                            : activity?.operation === "compacting"
                              ? uiCopy.activity.status.compacting
                              : "";
                    return (
                      <div
                        key={session.sessionId}
                        data-testid="topic-session-row"
                        className={`group/topic relative rounded-[var(--piwork-control-radius)] transition-colors ${
                          active ? "bg-accent text-foreground" : "text-foreground hover:bg-accent"
                        }`}
                      >
                        {editingSessionId === session.sessionId ? (
                          <div className="p-2">
                            <input
                              value={editingName}
                              onChange={(event) => setEditingName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void saveRename();
                                if (event.key === "Escape") cancelRename();
                              }}
                              onBlur={() => void saveRename()}
                              autoFocus
                              aria-label={uiCopy.chat.sessionName}
                              className="h-9 w-full rounded-[var(--piwork-control-radius)] border border-primary/35 bg-background px-2 text-sm font-medium text-foreground outline-none focus:border-primary"
                            />
                            {renameError && (
                              <div className="mt-1 text-xs text-danger">{renameError}</div>
                            )}
                          </div>
                        ) : (
                          <div
                            data-testid="topic-session-row-content"
                            className="relative flex h-8 items-center gap-1 px-2"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                handleSelectHistory(session.sessionId, focusedAgent.id)
                              }
                              aria-label={`${uiCopy.chat.selectSession} ${title}${attentionLabel ? ` · ${attentionLabel}` : ""}`}
                              title={title}
                              className="absolute inset-0 z-0 rounded-[var(--piwork-control-radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <div className="pointer-events-none relative z-10 min-w-0 flex-1 text-left text-foreground">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="block min-w-0 truncate text-xs font-semibold overflow-visible">
                                  {title}
                                </span>
                                {attentionLabel && (
                                  <span
                                    className={`shrink-0 rounded-[var(--piwork-control-radius)] px-1.5 py-0.5 text-xs font-semibold leading-3 ${
                                      activity?.attention === "blocked"
                                        ? "bg-danger/10 text-danger"
                                        : activity?.attention === "review_ready"
                                          ? "bg-success/10 text-success"
                                          : "bg-accent text-accent-foreground"
                                    }`}
                                  >
                                    {attentionLabel}
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="pointer-events-none relative z-10 flex h-7 w-16 shrink-0 items-center justify-end">
                              <span
                                className={`max-w-full truncate text-right text-xs group-hover/topic:opacity-0 group-focus-within/topic:opacity-0 ${active ? "text-foreground/80" : "text-muted-foreground"}`}
                              >
                                {formatSessionTime(
                                  sessionMenuMessageTimes[session.sessionId] ||
                                    session.createdAt ||
                                    0,
                                )}
                              </span>
                              <div className="pointer-events-auto absolute inset-y-0 right-0 z-20 flex items-center justify-end gap-1 opacity-0 group-hover/topic:opacity-100 group-focus-within/topic:opacity-100">
                                <button
                                  type="button"
                                  onClick={() => startRename(session)}
                                  aria-label={uiCopy.chat.renameSession(title)}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <Pencil
                                    className="h-3.5 w-3.5"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void archiveHistorySession(session.sessionId, focusedAgent.id)
                                  }
                                  disabled={archivingSessionId === session.sessionId}
                                  aria-label={uiCopy.chat.archiveSession(title)}
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                                >
                                  <Archive
                                    className="h-3.5 w-3.5"
                                    strokeWidth={1.8}
                                    aria-hidden="true"
                                  />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          ) : (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              {uiCopy.chat.noSessions}
            </div>
          )}
          {(focusedAgentPage?.hasMore || focusedAgentPage?.loading || focusedAgentPage?.error) && (
            <div className="px-2 py-1.5">
              <button
                type="button"
                onClick={() => void loadAgentSessionPage(focusedAgentId)}
                disabled={focusedAgentPage?.loading}
                className="w-full rounded-[var(--piwork-control-radius)] px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:text-muted-foreground"
              >
                {focusedAgentPage?.loading
                  ? uiCopy.common.loading
                  : focusedAgentPage?.error
                    ? uiCopy.chat.reloadSessions
                    : uiCopy.chat.loadMoreSessions}
              </button>
              {focusedAgentPage?.error && (
                <div className="mt-1 truncate text-center text-xs text-danger">
                  {focusedAgentPage.error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      ref={selectorAnchorRef}
      data-testid="agent-topic-anchor"
      className="relative flex h-full min-w-0 max-w-[calc(100%-5rem)] items-center"
    >
      <div
        data-testid="agent-topic-triggers"
        className="flex min-w-0 max-w-full items-center gap-1"
      >
        <button
          type="button"
          aria-label={uiCopy.chat.agentSelector}
          data-testid="agent-selector-button"
          aria-expanded={agentPanelOpen}
          aria-haspopup="dialog"
          onClick={() => openSelector("agent")}
          className={`flex h-[var(--piwork-titlebar-control-size)] min-w-0 items-center gap-1.5 rounded-[var(--piwork-control-radius)] px-2.5 text-left text-foreground transition-colors hover:bg-accent ${
            agentPanelOpen ? "bg-accent" : "bg-transparent"
          }`}
        >
          <span
            data-testid="agent-selector-title"
            className="min-w-0 max-w-[128px] truncate text-sm font-semibold"
          >
            {getAgentDisplayName(agent.id)}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-current transition ${agentPanelOpen ? "rotate-180" : ""}`}
            strokeWidth={1.8}
          />
        </button>
        <span
          data-testid="agent-topic-separator"
          className="shrink-0 text-xs font-semibold text-foreground"
        >
          /
        </span>
        <button
          ref={topicSelectorButtonRef}
          type="button"
          aria-label={uiCopy.chat.sessionSelector}
          data-testid="topic-selector-button"
          aria-expanded={topicPanelOpen}
          aria-haspopup="dialog"
          onClick={() => openSelector("topic")}
          className={`flex h-[var(--piwork-titlebar-control-size)] min-w-0 items-center gap-1.5 rounded-[var(--piwork-control-radius)] px-2.5 text-left text-foreground transition-colors hover:bg-accent ${
            topicPanelOpen ? "bg-accent" : "bg-transparent"
          }`}
        >
          <span
            data-testid="topic-selector-title"
            className="min-w-0 max-w-[220px] truncate text-sm font-semibold"
          >
            {currentTopicTitle}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-current transition ${topicPanelOpen ? "rotate-180" : ""}`}
            strokeWidth={1.8}
          />
        </button>
      </div>
      <DropdownMotion
        open={selectorOpen}
        role="dialog"
        aria-label={uiCopy.chat.assistantAndSessionSelector}
        data-testid="agent-topic-cascade"
        onMouseMove={updateMenuPointerTrail}
        style={{
          left: renderedSelectorPanel === "topic" ? topicPopoverLeft : 0,
          top: "calc(100% + 2px)",
        }}
        className={`piwork-superellipse-panel absolute z-40 w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card p-0.5 text-foreground ${
          renderedSelectorPanel === "topic" ? "sm:w-[272px]" : "sm:w-[368px]"
        }`}
      >
        {renderedSelectorPanel === "agent" ? (
          <div data-testid="agent-topic-columns" className="grid gap-2 sm:grid-cols-[124px_232px]">
            <div className="min-w-0">
              <div data-testid="agent-list" className="h-[340px] space-y-0.5 overflow-y-auto pr-1">
                {AGENTS.map((candidate) => {
                  const active = candidate.id === focusedAgentId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      data-testid={`agent-menuitem-${candidate.id}`}
                      onMouseEnter={(event) => handleAgentPreview(candidate.id, event)}
                      onFocus={() => focusAgentInSelector(candidate.id)}
                      onClick={() => focusAgentInSelector(candidate.id)}
                      className={`flex h-8 w-full items-center gap-1.5 rounded-[var(--piwork-control-radius)] px-2 text-left transition-colors ${
                        active ? "bg-accent text-foreground" : "text-foreground hover:bg-accent"
                      }`}
                    >
                      <span className="block min-w-0 flex-1 truncate text-xs font-semibold">
                        {getAgentDisplayName(candidate.id)}
                      </span>
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              ref={topicPanelRef}
              data-testid="topic-panel"
              onMouseEnter={cancelPendingAgentHover}
              className="min-w-0 border-t border-border pt-2 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0"
            >
              {topicPanel}
            </div>
          </div>
        ) : (
          <div className="min-w-0">{topicPanel}</div>
        )}
      </DropdownMotion>
    </div>
  );
}
