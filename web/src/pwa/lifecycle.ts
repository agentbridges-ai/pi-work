import { PIWORK_SW_PATH } from "./cache-policy.js";

export type PwaRegistrationStatus = "idle" | "registering" | "ready" | "error" | "disabled";

export interface PwaLifecycleState {
  registrationStatus: PwaRegistrationStatus;
  online: boolean;
  standalone: boolean;
  installed: boolean;
  installAvailable: boolean;
  installPrompting: boolean;
  updateAvailable: boolean;
  updateActivating: boolean;
  offlineReady: boolean;
  error: string | null;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type PwaListener = () => void;
type UpdateGuard = () => boolean | Promise<boolean>;
type PwaUpdateMessage =
  | { protocol: 1; type: "HELLO"; tabId: string }
  | { protocol: 1; type: "HELLO_ACK"; tabId: string }
  | { protocol: 1; type: "PREPARE_UPDATE"; tabId: string; requestId: string }
  | {
      protocol: 1;
      type: "PREPARE_RESULT";
      tabId: string;
      requestId: string;
      safe: boolean;
    };

const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_CHANNEL_NAME = "piwork-pwa-update-v1";
const UPDATE_PEER_MAX_AGE_MS = 30_000;
const UPDATE_PREPARE_TIMEOUT_MS = 500;
const listeners = new Set<PwaListener>();
const updateGuards = new Set<UpdateGuard>();
let registration: ServiceWorkerRegistration | null = null;
let installPrompt: BeforeInstallPromptEvent | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let lastUpdateCheck = 0;
let updateChannel: BroadcastChannel | null = null;
let updatePeerInterval: ReturnType<typeof setInterval> | null = null;
const updateTabId = crypto.randomUUID();
const updatePeers = new Map<string, number>();
const prepareResponses = new Map<string, Map<string, boolean>>();

function isStandalone(windowObject: Window, navigatorObject: Navigator): boolean {
  return (
    windowObject.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigatorObject as Navigator & { standalone?: boolean }).standalone === true
  );
}

const initialStandalone =
  typeof window !== "undefined" && typeof navigator !== "undefined"
    ? isStandalone(window, navigator)
    : false;

let state: PwaLifecycleState = {
  registrationStatus: "idle",
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  standalone: initialStandalone,
  installed: initialStandalone,
  installAvailable: false,
  installPrompting: false,
  updateAvailable: false,
  updateActivating: false,
  offlineReady: false,
  error: null,
};

function updateState(patch: Partial<PwaLifecycleState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function getPwaLifecycleState(): PwaLifecycleState {
  return state;
}

export function subscribePwaLifecycle(listener: PwaListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerPwaUpdateGuard(guard: UpdateGuard): () => void {
  updateGuards.add(guard);
  return () => updateGuards.delete(guard);
}

async function localUpdateIsSafe(): Promise<boolean> {
  for (const guard of updateGuards) {
    if (!(await guard())) return false;
  }
  return true;
}

function broadcastUpdateMessage(message: PwaUpdateMessage): void {
  updateChannel?.postMessage(message);
}

function initializeUpdateChannel(windowObject: Window): void {
  const Channel = (windowObject as Window & { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel;
  if (!Channel || updateChannel) return;
  updateChannel = new Channel(UPDATE_CHANNEL_NAME);
  updateChannel.addEventListener("message", (event: MessageEvent<PwaUpdateMessage>) => {
    const message = event.data;
    if (!message || message.protocol !== 1 || message.tabId === updateTabId) return;
    updatePeers.set(message.tabId, Date.now());
    if (message.type === "HELLO") {
      broadcastUpdateMessage({ protocol: 1, type: "HELLO_ACK", tabId: updateTabId });
      return;
    }
    if (message.type === "HELLO_ACK") return;
    if (message.type === "PREPARE_UPDATE") {
      void localUpdateIsSafe().then((safe) => {
        broadcastUpdateMessage({
          protocol: 1,
          type: "PREPARE_RESULT",
          tabId: updateTabId,
          requestId: message.requestId,
          safe,
        });
      });
      return;
    }
    prepareResponses.get(message.requestId)?.set(message.tabId, message.safe);
  });
  const announce = () => broadcastUpdateMessage({ protocol: 1, type: "HELLO", tabId: updateTabId });
  announce();
  updatePeerInterval = setInterval(announce, 10_000);
}

async function allUpdatePeersAreSafe(): Promise<boolean> {
  if (!updateChannel) return true;
  const now = Date.now();
  const expected = [...updatePeers.entries()]
    .filter(([, seenAt]) => now - seenAt <= UPDATE_PEER_MAX_AGE_MS)
    .map(([tabId]) => tabId);
  if (!expected.length) return true;
  const requestId = crypto.randomUUID();
  const responses = new Map<string, boolean>();
  prepareResponses.set(requestId, responses);
  broadcastUpdateMessage({ protocol: 1, type: "PREPARE_UPDATE", tabId: updateTabId, requestId });
  await new Promise((resolve) => setTimeout(resolve, UPDATE_PREPARE_TIMEOUT_MS));
  prepareResponses.delete(requestId);
  return expected.every((tabId) => responses.get(tabId) === true);
}

function observeInstallingWorker(worker: ServiceWorker, navigatorObject: Navigator): void {
  worker.addEventListener("statechange", () => {
    if (worker.state !== "installed") return;
    if (navigatorObject.serviceWorker.controller) {
      updateState({ updateAvailable: true });
    } else {
      updateState({ offlineReady: true });
    }
  });
}

async function checkForUpdate(): Promise<void> {
  if (!registration) return;
  lastUpdateCheck = Date.now();
  try {
    await registration.update();
  } catch (error) {
    updateState({ error: error instanceof Error ? error.message : String(error) });
  }
}

export async function initializePwaLifecycle(
  enabled = true,
  windowObject: Window = window,
  navigatorObject: Navigator = navigator,
): Promise<void> {
  if (initialized) return;
  initialized = true;

  const displayMode = windowObject.matchMedia?.("(display-mode: standalone)");
  const refreshDisplayMode = () => {
    const standalone = isStandalone(windowObject, navigatorObject);
    updateState({
      standalone,
      installed: state.installed || standalone,
      installAvailable: standalone ? false : state.installAvailable,
    });
  };
  displayMode?.addEventListener?.("change", refreshDisplayMode);
  windowObject.addEventListener("online", () => {
    updateState({ online: true });
    void checkForUpdate();
  });
  windowObject.addEventListener("offline", () => updateState({ online: false }));
  windowObject.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    updateState({ installAvailable: !state.installed && !state.standalone, error: null });
  });
  windowObject.addEventListener("appinstalled", () => {
    installPrompt = null;
    updateState({ installed: true, installAvailable: false, installPrompting: false });
  });

  if (!enabled || !("serviceWorker" in navigatorObject)) {
    updateState({ registrationStatus: "disabled" });
    return;
  }

  initializeUpdateChannel(windowObject);
  updateState({ registrationStatus: "registering", error: null });
  try {
    // Keep this production URL literal so static PWA audits can verify that
    // Piwork never registers OnlyOffice's reserved `/sw.js` worker.
    registration =
      navigatorObject === navigator
        ? await navigator.serviceWorker.register("/piwork-sw.js", {
            scope: "/",
            updateViaCache: "none",
          })
        : await navigatorObject.serviceWorker.register(PIWORK_SW_PATH, {
            scope: "/",
            updateViaCache: "none",
          });

    if (!registration.waiting) {
      const storage = windowObject.sessionStorage;
      if (storage) {
        const keys = Array.from({ length: storage.length }, (_, index) =>
          storage.key(index),
        ).filter((key): key is string => Boolean(key?.startsWith("piwork-pwa-refresh:")));
        keys.forEach((key) => storage.removeItem(key));
      }
    }
    if (registration.waiting && navigatorObject.serviceWorker.controller) {
      updateState({ updateAvailable: true });
    }
    if (registration.installing) observeInstallingWorker(registration.installing, navigatorObject);
    registration.addEventListener("updatefound", () => {
      if (registration?.installing)
        observeInstallingWorker(registration.installing, navigatorObject);
    });

    updateInterval = setInterval(() => void checkForUpdate(), UPDATE_INTERVAL_MS);
    windowObject.addEventListener("visibilitychange", () => {
      if (windowObject.document.visibilityState !== "visible") return;
      if (Date.now() - lastUpdateCheck < UPDATE_INTERVAL_MS) return;
      void checkForUpdate();
    });
    void checkForUpdate();
    updateState({ registrationStatus: "ready" });
  } catch (error) {
    updateState({
      registrationStatus: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function requestPwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!installPrompt || state.installPrompting) return "unavailable";
  const prompt = installPrompt;
  updateState({ installPrompting: true, error: null });
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    installPrompt = null;
    updateState({
      installed: state.installed || outcome === "accepted",
      installAvailable: false,
      installPrompting: false,
    });
    return outcome;
  } catch (error) {
    installPrompt = null;
    updateState({
      installAvailable: false,
      installPrompting: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

export async function activatePwaUpdate(
  windowObject: Window = window,
): Promise<"activated" | "blocked" | "unavailable" | "failed"> {
  if (!registration?.waiting || state.updateActivating) return "unavailable";
  if (!(await localUpdateIsSafe()) || !(await allUpdatePeersAreSafe())) return "blocked";

  updateState({ updateActivating: true, error: null });
  const waitingWorker = registration.waiting;
  const refreshKey = `piwork-pwa-refresh:${waitingWorker.scriptURL || "waiting"}`;
  const refreshStorage = windowObject.sessionStorage;
  if (refreshStorage?.getItem(refreshKey) === "1") {
    updateState({
      updateActivating: false,
      error: "This app update already refreshed once and still did not activate",
    });
    return "failed";
  }
  const activated = new Promise<void>((resolve) => {
    if (waitingWorker.state === "activated") {
      resolve();
      return;
    }
    waitingWorker.addEventListener("statechange", () => {
      if (waitingWorker.state === "activated") resolve();
    });
  });
  waitingWorker.postMessage({ type: "SKIP_WAITING" });

  try {
    await Promise.race([
      activated,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Service Worker update timed out")), 10_000),
      ),
    ]);
    updateState({ updateAvailable: false, updateActivating: false });
    refreshStorage?.setItem(refreshKey, "1");
    windowObject.location.reload();
    return "activated";
  } catch (error) {
    updateState({
      updateActivating: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

export function disposePwaLifecycleForTests(): void {
  if (updateInterval) clearInterval(updateInterval);
  if (updatePeerInterval) clearInterval(updatePeerInterval);
  updateInterval = null;
  updatePeerInterval = null;
  updateChannel?.close();
  updateChannel = null;
  updatePeers.clear();
  prepareResponses.clear();
  registration = null;
  installPrompt = null;
  initialized = false;
  lastUpdateCheck = 0;
  listeners.clear();
  updateGuards.clear();
  state = {
    registrationStatus: "idle",
    online: true,
    standalone: false,
    installed: false,
    installAvailable: false,
    installPrompting: false,
    updateAvailable: false,
    updateActivating: false,
    offlineReady: false,
    error: null,
  };
}
