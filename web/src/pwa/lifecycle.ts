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

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const listeners = new Set<PwaListener>();
const updateGuards = new Set<UpdateGuard>();
let registration: ServiceWorkerRegistration | null = null;
let installPrompt: BeforeInstallPromptEvent | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let lastUpdateCheck = 0;

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
  windowObject.addEventListener("online", () => updateState({ online: true }));
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
    lastUpdateCheck = Date.now();
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
  for (const guard of updateGuards) {
    if (!(await guard())) return "blocked";
  }

  updateState({ updateActivating: true, error: null });
  const waitingWorker = registration.waiting;
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
  updateInterval = null;
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
