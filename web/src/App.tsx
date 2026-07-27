import {
  lazy,
  Suspense,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { useStore } from "./store.js";
import { connectSession, disconnectAll } from "./ws-runtime-lifecycle.js";
import { api, createSessionStream } from "./api.js";
import { capturePageView } from "./analytics.js";
import { parseRoute, setRouteContext, navigateHome, navigateToSession } from "./utils/routing.js";
import { LoginPage } from "./components/LoginPage.js";
import { isAgentId, type AgentId } from "./agents.js";
import { DEFAULT_AGENT_ID, AGENTS } from "./agents.js";
import type { BackendType, PiSessionInfo, UserSpaceMount } from "./types.js";
import type { CurrentUser, WorkspaceSessionState } from "./api.js";
import {
  persistWorkspaceSessionStateNow,
  scheduleWorkspaceSessionStatePersist,
} from "./workspace-session-state.js";
import { initialWorkspaceRuntimeState, workspaceRuntimeReducer } from "./workspace-runtime.js";
import { clientEnvironment } from "./environment.js";
import { setUiCopyLanguage, uiCopy, type UiCopyLanguage } from "./ui-copy.js";
import {
  disposeLoadedUserSpaceRuntimeState,
  ensureUserSpaceRuntimeLoaded,
} from "./user-space-runtime-lifecycle.js";
import { previewResourceRegistry } from "./components/preview-resource-registry.js";
import { isAbortError, runtimeContextCoordinator, type ResourceScope } from "./runtime-context.js";
import { beginRuntimeContextTransition } from "./runtime-context-switch.js";
import { subscribeToNotificationSessionOpen } from "./pwa/notifications.js";
import {
  rawUserIdFromCurrentUser,
  userScopeKeyFromCurrentUser,
} from "./store/user-scoped-storage.js";

async function retryDynamicImport<T>(
  load: () => Promise<T>,
  retryLoad?: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isDynamicImportFetchError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return clientEnvironment.isDevelopment && retryLoad ? retryLoad() : load();
  }
}

function isDynamicImportFetchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module")
  );
}

function lazyRoute<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  devModulePath: string,
  exportName: string,
  prepare?: () => Promise<void>,
) {
  const loadPrepared = async () => {
    const [module] = await Promise.all([load(), prepare?.()]);
    return module;
  };
  return lazy(() =>
    retryDynamicImport(loadPrepared, async () => {
      const [mod] = await Promise.all([
        import(/* @vite-ignore */ `${devModulePath}?retry=${Date.now()}`) as Promise<
          Record<string, T>
        >,
        prepare?.(),
      ]);
      return { default: mod[exportName] };
    }),
  );
}

// Lazy-loaded route-level pages (not needed for initial render)
const ChatView = lazyRoute(
  () => import("./components/ChatView.js").then((m) => ({ default: m.ChatView })),
  "/src/components/ChatView.tsx",
  "ChatView",
  ensureUserSpaceRuntimeLoaded,
);
const RbacAdminPage = lazyRoute(
  () => import("./components/RbacAdminPage.js").then((m) => ({ default: m.RbacAdminPage })),
  "/src/components/RbacAdminPage.tsx",
  "RbacAdminPage",
);

function LazyFallback() {
  return (
    <div
      className="flex items-center justify-center h-full"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="text-sm text-muted-foreground">{uiCopy.common.loading}</div>
    </div>
  );
}

function SkipToMainLink() {
  return (
    <a
      href="#main-content"
      className="piwork-skip-link fixed left-3 top-3 z-[var(--piwork-z-toast)] rounded-[var(--piwork-control-radius)] bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
    >
      {uiCopy.common.skipToMainContent}
    </a>
  );
}

function getRouteSnapshot() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function useRouteLocation() {
  return useSyncExternalStore((cb) => {
    window.addEventListener("popstate", cb);
    window.addEventListener("hashchange", cb);
    return () => {
      window.removeEventListener("popstate", cb);
      window.removeEventListener("hashchange", cb);
    };
  }, getRouteSnapshot);
}

async function leaveMissingSessionRoute(
  sessionId: string,
  liveSessions: PiSessionInfo[],
): Promise<boolean> {
  const store = useStore.getState();
  const selectedBound =
    store.agentSessionIds[store.selectedAgentId] === sessionId
      ? ""
      : store.agentSessionIds[store.selectedAgentId];
  const fallbackSession =
    liveSessions.find((session) => session.sessionId === selectedBound && !session.archived) ||
    liveSessions.find((session) => !session.archived);
  const transition = beginRuntimeContextTransition({
    userId: rawUserIdFromCurrentUser(store.currentUser),
    userScopeKey: userScopeKeyFromCurrentUser(store.currentUser),
    agentId: store.selectedAgentId,
    sessionId: fallbackSession?.sessionId || null,
  });
  const committed = await transition.commit(() => {
    const nextStore = useStore.getState();
    nextStore.setRuntimeSessions(liveSessions);
    for (const [agentId, boundSessionId] of Object.entries(nextStore.agentSessionIds)) {
      if (boundSessionId === sessionId) {
        nextStore.clearAgentSessionBinding(agentId as AgentId);
      }
    }
    nextStore.removeSession(sessionId);
    nextStore.setCurrentSession(fallbackSession?.sessionId || null);
    persistWorkspaceSessionStateNow();
  });
  if (!committed) return false;

  if (fallbackSession) {
    const nextStore = useStore.getState();
    navigateToSession(fallbackSession.sessionId, true, {
      userUuid: nextStore.currentUser?.uuid || nextStore.currentUser?.userId,
      agentId: nextStore.selectedAgentId,
    });
    connectSession(fallbackSession.sessionId);
  } else {
    const nextStore = useStore.getState();
    navigateHome(true, {
      userUuid: nextStore.currentUser?.uuid || nextStore.currentUser?.userId,
      agentId: nextStore.selectedAgentId,
    });
  }
  return true;
}

export function applyDocumentTheme(
  darkMode: boolean,
  root: HTMLElement = document.documentElement,
): void {
  const resolvedTheme = darkMode ? "dark" : "light";
  root.classList.toggle("dark", darkMode);
  root.classList.toggle("light", !darkMode);
  root.dataset.theme = resolvedTheme;
  root.removeAttribute("data-design-theme");
  root.removeAttribute("data-design-radius");
  root.style.colorScheme = resolvedTheme;
  const themeColor = root.ownerDocument.defaultView
    ?.getComputedStyle(root)
    .getPropertyValue("--background")
    .trim();
  if (themeColor) {
    root
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", themeColor);
  }
}

export function applyDocumentLocale(
  language: UiCopyLanguage,
  targetDocument: Document = document,
): void {
  setUiCopyLanguage(language);
  targetDocument.documentElement.lang = language;
  targetDocument.title = uiCopy.app.documentTitle;
  targetDocument
    .querySelector<HTMLMetaElement>('meta[name="description"]')
    ?.setAttribute("content", uiCopy.app.description);
}

function emptyAgentSessionIds(): Record<AgentId, string> {
  return Object.fromEntries(AGENTS.map((agent) => [agent.id, ""])) as Record<AgentId, string>;
}

function emptyAgentSessionHistoryIds(): Record<AgentId, string[]> {
  return AGENTS.reduce(
    (acc, agent) => {
      acc[agent.id] = [];
      return acc;
    },
    {} as Record<AgentId, string[]>,
  );
}

function emptyAgentUserSpaces(): Record<AgentId, UserSpaceMount[]> {
  return AGENTS.reduce(
    (acc, agent) => {
      acc[agent.id] = [];
      return acc;
    },
    {} as Record<AgentId, UserSpaceMount[]>,
  );
}

function prependUnique(sessionIds: string[], sessionId: string): string[] {
  return [sessionId, ...sessionIds.filter((id) => id !== sessionId)];
}

function liveSessionExists(
  liveSessions: PiSessionInfo[],
  sessionId: string | null | undefined,
): sessionId is string {
  return !!sessionId && liveSessions.some((session) => session.sessionId === sessionId);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeoutId: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
}

function normalizeWorkspaceSessionState(
  remote: WorkspaceSessionState,
  liveSessions: PiSessionInfo[],
  route: ReturnType<typeof parseRoute>,
  options: { sessionsPartial?: boolean } = {},
) {
  const agentSessionIds = emptyAgentSessionIds();
  const agentSessionHistoryIds = emptyAgentSessionHistoryIds();
  const agentUserSpaces = emptyAgentUserSpaces();
  const sessionsPartial = options.sessionsPartial ?? false;

  for (const agent of AGENTS) {
    const sessionId = remote.agentSessionIds?.[agent.id];
    if (sessionsPartial ? !!sessionId : liveSessionExists(liveSessions, sessionId)) {
      agentSessionIds[agent.id] = sessionId;
    }

    const history = remote.agentSessionHistoryIds?.[agent.id] || [];
    agentSessionHistoryIds[agent.id] = sessionsPartial
      ? [...history]
      : history.filter((sessionId) => liveSessionExists(liveSessions, sessionId));
    agentUserSpaces[agent.id] = (remote.agentUserSpaces?.[agent.id] || []).map((mount) => ({
      ...mount,
    }));
  }

  const selectedAgentId =
    "agentId" in route && isAgentId(route.agentId)
      ? route.agentId
      : isAgentId(remote.selectedAgentId)
        ? remote.selectedAgentId
        : DEFAULT_AGENT_ID;

  let currentSessionId: string | null = liveSessionExists(liveSessions, remote.currentSessionId)
    ? remote.currentSessionId
    : null;

  if (route.page === "session") {
    if (liveSessionExists(liveSessions, route.sessionId)) {
      currentSessionId = route.sessionId;
      agentSessionIds[selectedAgentId] = route.sessionId;
      agentSessionHistoryIds[selectedAgentId] = prependUnique(
        agentSessionHistoryIds[selectedAgentId] || [],
        route.sessionId,
      );
    } else {
      currentSessionId = null;
    }
  }

  if (!currentSessionId) {
    const selectedBoundSessionId = agentSessionIds[selectedAgentId];
    if (liveSessionExists(liveSessions, selectedBoundSessionId)) {
      currentSessionId = selectedBoundSessionId;
    }
  }

  if (!currentSessionId) {
    currentSessionId = liveSessions.find((session) => !session.archived)?.sessionId || null;
  }

  if (currentSessionId && !Object.values(agentSessionIds).includes(currentSessionId)) {
    agentSessionIds[selectedAgentId] = currentSessionId;
    agentSessionHistoryIds[selectedAgentId] = prependUnique(
      agentSessionHistoryIds[selectedAgentId] || [],
      currentSessionId,
    );
  }

  return {
    selectedAgentId,
    currentSessionId,
    agentSessionIds,
    agentSessionHistoryIds,
    agentUserSpaces,
  };
}

export function applyWorkspaceBootstrapUserIfCurrent(
  snapshotUser: CurrentUser,
  expectedUserScopeKey: string,
  currentUser: CurrentUser | null,
  runtimeMode: string,
  setCurrentUser: (user: CurrentUser, runtimeMode: string) => void,
): boolean {
  if (userScopeKeyFromCurrentUser(currentUser) !== expectedUserScopeKey) return false;
  if (userScopeKeyFromCurrentUser(snapshotUser) !== expectedUserScopeKey) return false;
  setCurrentUser(snapshotUser, runtimeMode);
  return true;
}

export default function App() {
  const isAuthenticated = useStore((s) => s.isAuthenticated);
  const authInitialized = useStore((s) => s.authInitialized);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const currentUser = useStore((s) => s.currentUser);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const agentSessionIds = useStore((s) => s.agentSessionIds);
  const agentSessionHistoryIds = useStore((s) => s.agentSessionHistoryIds);
  const agentUserSpaces = useStore((s) => s.agentUserSpaces);
  const themeMode = useStore((s) => s.themeMode);
  const darkMode = useStore((s) => s.darkMode);
  const uiLanguage = useStore((s) => s.uiLanguage);
  const refreshSystemTheme = useStore((s) => s.refreshSystemTheme);
  const currentUserId = rawUserIdFromCurrentUser(currentUser);
  const currentUserScopeKey = userScopeKeyFromCurrentUser(currentUser);
  const [workspaceStateReadyUserScopeKey, setWorkspaceStateReadyUserScopeKey] = useState("");
  const [workspaceStateError, setWorkspaceStateError] = useState("");
  const workspaceReady = isAuthenticated && !!currentUserScopeKey;
  const workspaceStateReady =
    !!currentUserScopeKey && workspaceStateReadyUserScopeKey === currentUserScopeKey;
  const [, dispatchWorkspaceRuntime] = useReducer(
    workspaceRuntimeReducer,
    initialWorkspaceRuntimeState,
  );
  const routeLocation = useRouteLocation();
  const route = parseRoute();
  const routeRef = useRef(route);
  const workspaceLoadOperationRef = useRef(0);
  const configuredUserScopeRef = useRef<ResourceScope | null>(null);
  const isSessionView = route.page === "session" || route.page === "home";

  useEffect(() => {
    capturePageView(routeLocation || "/");
  }, [routeLocation]);

  useEffect(
    () =>
      subscribeToNotificationSessionOpen((sessionId) => {
        const store = useStore.getState();
        const agentId =
          (Object.entries(store.agentSessionIds).find(
            ([, boundSessionId]) => boundSessionId === sessionId,
          )?.[0] as AgentId | undefined) || store.selectedAgentId;
        navigateToSession(sessionId, false, {
          userUuid: store.currentUser?.uuid || store.currentUser?.userId,
          agentId: agentId,
        });
      }),
    [],
  );

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    setRouteContext({
      userUuid: currentUser?.uuid || currentUser?.userId || null,
      agentId: selectedAgentId,
    });
  }, [currentUser?.uuid, currentUser?.userId, selectedAgentId]);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!workspaceStateReady) return;
    const currentUserUuid = currentUser?.uuid || currentUser?.userId || "";
    if (
      "userUuid" in route &&
      route.userUuid &&
      currentUserUuid &&
      route.userUuid !== currentUserUuid
    ) {
      const store = useStore.getState();
      navigateHome(true, {
        userUuid: currentUserUuid,
        agentId: store.selectedAgentId,
      });
      return;
    }
    // Session routes are addressable switch intents. The validated route effect
    // below commits their agent/session authority together after the Office
    // and activation gates have succeeded.
    if (route.page === "session") return;
    if (!("agentId" in route) || !isAgentId(route.agentId)) return;
    const store = useStore.getState();
    if (store.selectedAgentId === route.agentId) return;
    const boundSessionId = store.agentSessionIds[route.agentId];
    const boundSession = boundSessionId
      ? store.runtimeSessions.find(
          (session) => session.sessionId === boundSessionId && !session.archived,
        )
      : undefined;
    const targetSessionId = boundSession?.sessionId || null;
    let disposed = false;
    const transition = beginRuntimeContextTransition({
      userId: currentUserId,
      userScopeKey: currentUserScopeKey,
      agentId: route.agentId,
      sessionId: targetSessionId,
    });
    transition
      .commit(() => {
        const nextStore = useStore.getState();
        nextStore.setSelectedAgentId(route.agentId as AgentId);
        nextStore.setCurrentSession(targetSessionId);
        persistWorkspaceSessionStateNow();
      })
      .then((committed) => {
        if (!committed || disposed || !targetSessionId) return;
        navigateToSession(targetSessionId, true, {
          userUuid: currentUserUuid,
          agentId: route.agentId,
        });
        connectSession(targetSessionId);
      })
      .catch((error) => {
        if (isAbortError(error) || disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setWorkspaceStateError(message || uiCopy.app.enterWorkbenchFailed);
      });
    return () => {
      disposed = true;
      void transition.cancel();
    };
  }, [
    currentUser?.uuid,
    currentUser?.userId,
    currentUserId,
    currentUserScopeKey,
    isAuthenticated,
    route,
    workspaceStateReady,
  ]);

  useEffect(() => {
    applyDocumentTheme(darkMode);
  }, [darkMode]);

  useEffect(() => {
    applyDocumentLocale(uiLanguage);
  }, [uiLanguage]);

  useEffect(() => {
    if (themeMode !== "system" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => refreshSystemTheme();
    refreshSystemTheme();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [refreshSystemTheme, themeMode]);

  useEffect(() => {
    if (!isAuthenticated) {
      setWorkspaceStateReadyUserScopeKey("");
      setWorkspaceStateError("");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const nextUserId = isAuthenticated ? currentUserId : "";
    const nextUserScopeKey = isAuthenticated ? currentUserScopeKey : "";
    const lease = runtimeContextCoordinator.activate({
      userId: nextUserId,
      userScopeKey: nextUserScopeKey,
      agentId: selectedAgentId,
      sessionId: currentSessionId,
    });
    if (configuredUserScopeRef.current !== lease.userScope) {
      configuredUserScopeRef.current = lease.userScope;
      lease.userScope.add(() => {
        disconnectAll();
        previewResourceRegistry.revokeAll();
      });
    }
  }, [currentSessionId, currentUserId, currentUserScopeKey, isAuthenticated, selectedAgentId]);

  useEffect(
    () => () => {
      configuredUserScopeRef.current = null;
      disposeLoadedUserSpaceRuntimeState();
      void runtimeContextCoordinator.dispose();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const lease = runtimeContextCoordinator.current();
    const operationScope = lease ? runtimeContextCoordinator.operationScope(lease.context) : null;
    const requestOptions =
      operationScope && lease
        ? { signal: operationScope.signal, contextEpoch: lease.context.epoch }
        : undefined;
    dispatchWorkspaceRuntime({ type: "authChecking" });
    api
      .getMe(requestOptions)
      .then(({ user, runtimeMode: nextRuntimeMode }) => {
        if (cancelled) return;
        useStore.getState().setCurrentUser(user, nextRuntimeMode);
        dispatchWorkspaceRuntime({ type: "authAuthenticated" });
      })
      .catch(async (error) => {
        if (isAbortError(error)) return;
        if (cancelled) return;
        await api.getAuthMode(requestOptions).catch(() => null);
        if (cancelled) return;
        useStore.getState().setUnauthenticated("local");
        dispatchWorkspaceRuntime({ type: "authUnauthenticated" });
      });
    return () => {
      cancelled = true;
      if (operationScope) void operationScope.dispose();
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !workspaceReady || !currentUserScopeKey) {
      return;
    }
    const operationId = workspaceLoadOperationRef.current + 1;
    workspaceLoadOperationRef.current = operationId;
    const runtimeStore = useStore.getState();
    const lease =
      runtimeContextCoordinator.current() ||
      runtimeContextCoordinator.activate({
        userId: currentUserId,
        userScopeKey: currentUserScopeKey,
        agentId: runtimeStore.selectedAgentId,
        sessionId: runtimeStore.currentSessionId,
      });
    const operationScope = runtimeContextCoordinator.operationScope(lease.context);
    const isActiveOperation = () =>
      workspaceLoadOperationRef.current === operationId &&
      !operationScope.isDisposed &&
      runtimeContextCoordinator.isCurrent(lease.context);
    dispatchWorkspaceRuntime({ type: "workspaceLoadingSnapshot", operationId });

    setWorkspaceStateReadyUserScopeKey("");
    setWorkspaceStateError("");
    withTimeout(
      api.getWorkspaceBootstrap({
        signal: operationScope.signal,
        contextEpoch: lease.context.epoch,
      }),
      4_000,
      "Workspace bootstrap",
      () => {
        void operationScope.dispose();
      },
    )
      .then(async (snapshot) => {
        if (!isActiveOperation()) return;
        const storeBeforeBootstrap = useStore.getState();
        if (
          !applyWorkspaceBootstrapUserIfCurrent(
            snapshot.user,
            currentUserScopeKey,
            storeBeforeBootstrap.currentUser,
            storeBeforeBootstrap.runtimeMode,
            storeBeforeBootstrap.setCurrentUser,
          )
        )
          return;
        const activeRoute = routeRef.current;
        const remoteState = snapshot.workspaceState;
        let liveSessions = snapshot.sessions;
        if (
          activeRoute.page === "session" &&
          !liveSessionExists(liveSessions, activeRoute.sessionId)
        ) {
          const routeSession = await api
            .getSession(activeRoute.sessionId, {
              signal: operationScope.signal,
              contextEpoch: lease.context.epoch,
            })
            .catch((error) => {
              if (isAbortError(error)) throw error;
              return null;
            });
          if (!isActiveOperation()) return;
          if (routeSession) {
            liveSessions = [
              routeSession,
              ...liveSessions.filter((session) => session.sessionId !== routeSession.sessionId),
            ];
          }
        }
        const currentUserUuid = snapshot.user.uuid || snapshot.user.userId || "";
        const routeUserMismatch =
          "userUuid" in activeRoute &&
          !!activeRoute.userUuid &&
          !!currentUserUuid &&
          activeRoute.userUuid !== currentUserUuid;
        const routeAgentId =
          "agentId" in activeRoute && isAgentId(activeRoute.agentId)
            ? activeRoute.agentId
            : undefined;
        const snapshotRoute = routeUserMismatch
          ? { page: "home" as const, userUuid: currentUserUuid, agentId: routeAgentId }
          : activeRoute;
        const normalized = normalizeWorkspaceSessionState(
          remoteState,
          liveSessions,
          snapshotRoute,
          {
            sessionsPartial: snapshot.sessionsHasMore === true,
          },
        );
        if (!isActiveOperation()) return;
        if (activeRoute.page === "session" && !normalized.currentSessionId) {
          await leaveMissingSessionRoute(activeRoute.sessionId, liveSessions);
          return;
        }

        const transition = beginRuntimeContextTransition({
          userId: currentUserId,
          userScopeKey: currentUserScopeKey,
          agentId: normalized.selectedAgentId,
          sessionId: normalized.currentSessionId,
        });
        const committed = await transition.commit(() => {
          const store = useStore.getState();
          store.setRuntimeSessions(liveSessions);
          store.hydrateWorkspaceSessionState({
            selectedAgentId: normalized.selectedAgentId,
            agentSessionIds: normalized.agentSessionIds,
            agentSessionHistoryIds: normalized.agentSessionHistoryIds,
            agentUserSpaces: normalized.agentUserSpaces,
          });
          store.setCurrentSession(normalized.currentSessionId);
          setWorkspaceStateReadyUserScopeKey(currentUserScopeKey);
          dispatchWorkspaceRuntime({ type: "workspaceSnapshotLoaded", operationId });
        });
        if (!committed) return;

        if (normalized.currentSessionId) {
          const store = useStore.getState();
          const routeSessionMismatch =
            activeRoute.page === "session" && activeRoute.sessionId !== normalized.currentSessionId;
          if (routeUserMismatch || activeRoute.page === "home" || routeSessionMismatch) {
            navigateToSession(normalized.currentSessionId, true, {
              userUuid: store.currentUser?.uuid || store.currentUser?.userId,
              agentId: normalized.selectedAgentId,
            });
          }
          connectSession(normalized.currentSessionId);
        }
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        if (workspaceLoadOperationRef.current !== operationId) return;
        const message = err instanceof Error ? err.message : String(err);
        setWorkspaceStateError(message);
        dispatchWorkspaceRuntime({ type: "workspaceError", operationId, error: message });
      })
      .finally(() => {
        void operationScope.dispose();
      });

    return () => {
      if (workspaceLoadOperationRef.current === operationId) {
        workspaceLoadOperationRef.current += 1;
      }
      void operationScope.dispose();
    };
  }, [currentUserId, currentUserScopeKey, isAuthenticated, workspaceReady]);

  useEffect(() => {
    if (!isAuthenticated || !workspaceReady || !workspaceStateReady || !currentUserScopeKey) return;
    scheduleWorkspaceSessionStatePersist();
  }, [
    currentSessionId,
    currentUserScopeKey,
    agentSessionHistoryIds,
    agentSessionIds,
    agentUserSpaces,
    isAuthenticated,
    selectedAgentId,
    workspaceReady,
    workspaceStateReady,
  ]);

  // Sync route -> store. The URL is an addressable intent only; session authority
  // still comes from the authenticated local session snapshot before we connect.
  useEffect(() => {
    if (!isAuthenticated || !workspaceReady || !workspaceStateReady || route.page !== "session")
      return;

    const initialStore = useStore.getState();
    const targetAgentId =
      "agentId" in route && isAgentId(route.agentId) ? route.agentId : initialStore.selectedAgentId;
    const targetUserId = rawUserIdFromCurrentUser(initialStore.currentUser);
    const targetUserScopeKey = userScopeKeyFromCurrentUser(initialStore.currentUser);
    const activeContext = runtimeContextCoordinator.current()?.context;
    if (
      initialStore.currentSessionId === route.sessionId &&
      initialStore.selectedAgentId === targetAgentId &&
      activeContext?.userId === targetUserId &&
      activeContext.userScopeKey === targetUserScopeKey &&
      activeContext.agentId === targetAgentId &&
      activeContext.sessionId === route.sessionId
    ) {
      connectSession(route.sessionId);
      return;
    }

    let disposed = false;
    setWorkspaceStateError("");
    const transition = beginRuntimeContextTransition({
      userId: targetUserId,
      userScopeKey: targetUserScopeKey,
      agentId: targetAgentId,
      sessionId: route.sessionId,
    });

    api
      .listSessions({
        signal: transition.signal,
        contextEpoch: transition.context.epoch,
      })
      .then(async (liveSessions) => {
        if (disposed || transition.signal.aborted) return;
        const exists = liveSessions.some((session) => session.sessionId === route.sessionId);
        if (!exists) {
          await transition.cancel();
          if (disposed) return;
          await leaveMissingSessionRoute(route.sessionId, liveSessions);
          return;
        }

        const committed = await transition.commit(() => {
          const store = useStore.getState();
          store.setRuntimeSessions(liveSessions);
          store.bindSessionToAgent(targetAgentId, route.sessionId);
          store.setCurrentSession(route.sessionId);
          persistWorkspaceSessionStateNow();
        });
        if (!committed || disposed) return;

        const store = useStore.getState();
        navigateToSession(route.sessionId, true, {
          userUuid: store.currentUser?.uuid || store.currentUser?.userId,
          agentId: targetAgentId,
        });
        connectSession(route.sessionId);
      })
      .catch((error) => {
        if (isAbortError(error) || disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setWorkspaceStateError(message || uiCopy.app.enterWorkbenchFailed);
      });

    return () => {
      disposed = true;
      void transition.cancel();
    };
  }, [isAuthenticated, route, workspaceReady, workspaceStateReady]);

  useEffect(() => {
    if (!isAuthenticated || route.page !== "home" || !currentSessionId) return;
    navigateToSession(currentSessionId, true, {
      userUuid: currentUser?.uuid || currentUser?.userId,
      agentId: selectedAgentId,
    });
  }, [
    currentSessionId,
    currentUser?.uuid,
    currentUser?.userId,
    isAuthenticated,
    route.page,
    selectedAgentId,
  ]);

  // Auth gate: show login page when not authenticated
  if (!authInitialized) {
    return (
      <>
        <SkipToMainLink />
        <AppLoading label={uiCopy.app.checkingAuth} />
      </>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <SkipToMainLink />
        <main id="main-content">
          <LoginPage />
        </main>
      </>
    );
  }

  // Keep rendering the last committed context while an addressable route intent
  // is still being authorized and prepared.
  const renderedSessionId = currentSessionId;
  const shell = (
    <div className="fixed inset-0 flex flex-col font-sans-ui bg-background text-foreground antialiased pt-safe overflow-hidden overscroll-none">
      <SkipToMainLink />
      <main
        id="main-content"
        className="flex-1 flex flex-col min-w-0 overflow-hidden"
        aria-busy={!workspaceStateReady}
      >
        <div className="flex-1 overflow-hidden relative">
          {route.page === "rbacAdmin" && (
            <Suspense fallback={<LazyFallback />}>
              <RbacAdminPage />
            </Suspense>
          )}
          {isSessionView && (
            <>
              <div className="absolute inset-0">
                {!workspaceStateReady ? (
                  <div
                    className="flex h-full items-center justify-center bg-background"
                    aria-busy={!workspaceStateError}
                  >
                    <div
                      className="rounded-[var(--piwork-control-radius)] border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground"
                      role={workspaceStateError ? "alert" : "status"}
                      aria-live="polite"
                    >
                      {workspaceStateError || uiCopy.app.syncingAccountSession}
                    </div>
                  </div>
                ) : route.page === "home" && currentSessionId ? (
                  <div
                    className="flex h-full items-center justify-center bg-background"
                    aria-busy="true"
                  >
                    <div
                      className="rounded-[var(--piwork-control-radius)] border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground"
                      role="status"
                      aria-live="polite"
                    >
                      {uiCopy.app.restoringWorkbench}
                    </div>
                  </div>
                ) : route.page === "session" && renderedSessionId ? (
                  <Suspense fallback={<LazyFallback />}>
                    <ChatView sessionId={renderedSessionId} />
                  </Suspense>
                ) : (
                  <WorkspaceBootstrap />
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );

  return shell;
}

function AppLoading({ label }: { label: string }) {
  return (
    <main
      id="main-content"
      className="flex h-[100dvh] items-center justify-center bg-background text-sm font-medium text-muted-foreground"
      aria-busy="true"
    >
      <div
        className="rounded-[var(--piwork-control-radius)] border border-border bg-card px-4 py-2"
        role="status"
        aria-live="polite"
      >
        {label}
      </div>
    </main>
  );
}

function WorkspaceBootstrap() {
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    let transition: ReturnType<typeof beginRuntimeContextTransition> | null = null;
    const initialLease = runtimeContextCoordinator.current();
    const operationScope = initialLease
      ? runtimeContextCoordinator.operationScope(initialLease.context)
      : null;

    const activateWorkspace = async () => {
      try {
        const store = useStore.getState();
        const agentId = store.selectedAgentId;
        const userId = rawUserIdFromCurrentUser(store.currentUser);
        const userScopeKey = userScopeKeyFromCurrentUser(store.currentUser);
        const boundSessionId = store.agentSessionIds[agentId];
        const boundRuntimeInfo = boundSessionId
          ? store.runtimeSessions.find((session) => session.sessionId === boundSessionId)
          : undefined;
        const reusableSessionId =
          boundSessionId &&
          !boundRuntimeInfo?.archived &&
          (boundRuntimeInfo || store.sessions.has(boundSessionId))
            ? boundSessionId
            : "";

        if (reusableSessionId) {
          transition = beginRuntimeContextTransition({
            userId,
            userScopeKey,
            agentId,
            sessionId: reusableSessionId,
          });
          const committed = await transition.commit(() => {
            const nextStore = useStore.getState();
            nextStore.setCurrentSession(reusableSessionId);
            persistWorkspaceSessionStateNow();
          });
          if (!committed || disposed) return;
          const nextStore = useStore.getState();
          navigateToSession(reusableSessionId, true, {
            userUuid: nextStore.currentUser?.uuid || nextStore.currentUser?.userId,
            agentId: agentId,
          });
          connectSession(reusableSessionId);
          return;
        }

        const backend: BackendType = "pi";
        const availableModels = await api.getBackendModels(agentId);
        const model = availableModels[0]?.model;
        if (!model) {
          throw new Error(uiCopy.piRuntime.noModels);
        }
        if (disposed || operationScope?.signal.aborted) return;
        store.clearCreation();
        store.setSessionCreating(true, backend);

        const result = await createSessionStream(
          {
            backend,
            agentId: agentId,
            model,
          },
          (progress) => {
            if (disposed || operationScope?.signal.aborted) return;
            useStore.getState().addCreationProgress(progress);
          },
          {
            signal: operationScope?.signal,
            contextEpoch: initialLease?.context.epoch,
          },
        );
        if (disposed || operationScope?.signal.aborted) return;
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
        transition = beginRuntimeContextTransition(
          {
            userId,
            userScopeKey,
            agentId,
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
          nextStore.bindSessionToAgent(agentId as AgentId, result.sessionId);
          nextStore.setPreviousAgentMode(result.sessionId, result.mode);
          nextStore.clearCreation();
          nextStore.setCurrentSession(result.sessionId);
          persistWorkspaceSessionStateNow();
        });
        if (!committed || disposed) return;
        const nextStore = useStore.getState();
        navigateToSession(result.sessionId, true, {
          userUuid: nextStore.currentUser?.uuid || nextStore.currentUser?.userId,
          agentId: agentId,
        });
        connectSession(result.sessionId);
      } catch (err) {
        if (isAbortError(err) || disposed || operationScope?.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || uiCopy.app.enterWorkbenchFailed);
        const nextStore = useStore.getState();
        nextStore.setCreationError(message || uiCopy.app.enterWorkbenchFailed);
        nextStore.setSessionCreating(false);
      }
    };

    void activateWorkspace();
    return () => {
      disposed = true;
      if (transition) void transition.cancel();
      if (operationScope) void operationScope.dispose();
    };
  }, []);

  return (
    <div className="flex h-full items-center justify-center bg-background" aria-busy={!error}>
      <div
        className="rounded-[var(--piwork-control-radius)] border border-border bg-card px-4 py-2 text-sm font-medium text-muted-foreground"
        role={error ? "alert" : "status"}
        aria-live="polite"
      >
        {error || uiCopy.app.enteringWorkbench}
      </div>
    </div>
  );
}
