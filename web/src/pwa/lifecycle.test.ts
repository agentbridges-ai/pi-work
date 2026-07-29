import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activatePwaUpdate,
  disposePwaLifecycleForTests,
  getPwaLifecycleState,
  initializePwaLifecycle,
  registerPwaUpdateGuard,
  requestPwaInstall,
} from "./lifecycle.js";

function createWorker(state: ServiceWorkerState = "installed") {
  const target = new EventTarget() as EventTarget & ServiceWorker;
  Object.assign(target, { state, postMessage: vi.fn() });
  return target;
}

function createRuntime(
  options: { waiting?: boolean; controlled?: boolean; unsafePeer?: boolean } = {},
) {
  const windowTarget = new EventTarget() as EventTarget & {
    location: { reload: ReturnType<typeof vi.fn> };
    document: { visibilityState: DocumentVisibilityState };
    matchMedia: Window["matchMedia"];
  };
  windowTarget.location = { reload: vi.fn() };
  windowTarget.document = { visibilityState: "visible" };
  windowTarget.matchMedia = vi.fn(
    () =>
      ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  if (options.unsafePeer) {
    class TestBroadcastChannel extends EventTarget {
      postMessage(message: { type?: string; requestId?: string }) {
        if (message.type === "HELLO") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: { protocol: 1, type: "HELLO_ACK", tabId: "remote-tab" },
              }),
            ),
          );
        }
        if (message.type === "PREPARE_UPDATE") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  protocol: 1,
                  type: "PREPARE_RESULT",
                  tabId: "remote-tab",
                  requestId: message.requestId,
                  safe: false,
                },
              }),
            ),
          );
        }
      }
      close() {}
    }
    Object.assign(windowTarget, { BroadcastChannel: TestBroadcastChannel });
  }

  const waiting = options.waiting ? createWorker() : null;
  const registrationTarget = new EventTarget() as EventTarget & ServiceWorkerRegistration;
  Object.assign(registrationTarget, {
    waiting,
    installing: null,
    active: null,
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => true),
  });

  const containerTarget = new EventTarget() as EventTarget & ServiceWorkerContainer;
  Object.assign(containerTarget, {
    controller: options.controlled ? {} : null,
    register: vi.fn(async () => registrationTarget),
  });
  const navigatorObject = {
    onLine: true,
    serviceWorker: containerTarget,
  } as unknown as Navigator;

  return {
    windowObject: windowTarget as unknown as Window,
    navigatorObject,
    serviceWorker: containerTarget,
    registration: registrationTarget,
    waiting,
  };
}

afterEach(() => disposePwaLifecycleForTests());

describe("PWA lifecycle", () => {
  it("registers only the rooted Piwork worker and leaves a waiting update under user control", async () => {
    const runtime = createRuntime({ waiting: true, controlled: true });

    await initializePwaLifecycle(true, runtime.windowObject, runtime.navigatorObject);

    expect(runtime.serviceWorker.register).toHaveBeenCalledWith("/piwork-sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(getPwaLifecycleState()).toMatchObject({
      registrationStatus: "ready",
      updateAvailable: true,
    });
    expect(runtime.waiting?.postMessage).not.toHaveBeenCalled();
    expect(runtime.windowObject.location.reload).not.toHaveBeenCalled();
  });

  it("captures a browser install prompt and consumes a dismissal once", async () => {
    const runtime = createRuntime();
    await initializePwaLifecycle(false, runtime.windowObject, runtime.navigatorObject);
    const event = new Event("beforeinstallprompt") as Event & {
      prompt: ReturnType<typeof vi.fn>;
      userChoice: Promise<{ outcome: "dismissed"; platform: string }>;
    };
    event.prompt = vi.fn(async () => {});
    event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
    const preventDefault = vi.spyOn(event, "preventDefault");

    runtime.windowObject.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getPwaLifecycleState().installAvailable).toBe(true);
    await expect(requestPwaInstall()).resolves.toBe("dismissed");
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(getPwaLifecycleState().installAvailable).toBe(false);
    await expect(requestPwaInstall()).resolves.toBe("unavailable");
  });

  it("does not activate a waiting worker while an editor guard blocks refresh", async () => {
    const runtime = createRuntime({ waiting: true, controlled: true });
    await initializePwaLifecycle(true, runtime.windowObject, runtime.navigatorObject);
    registerPwaUpdateGuard(() => false);

    await expect(activatePwaUpdate(runtime.windowObject)).resolves.toBe("blocked");
    expect(runtime.waiting?.postMessage).not.toHaveBeenCalled();
    expect(runtime.windowObject.location.reload).not.toHaveBeenCalled();
  });

  it("does not activate while another tab reports an unsafe Office state", async () => {
    const runtime = createRuntime({ waiting: true, controlled: true, unsafePeer: true });
    await initializePwaLifecycle(true, runtime.windowObject, runtime.navigatorObject);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(activatePwaUpdate(runtime.windowObject)).resolves.toBe("blocked");
    expect(runtime.waiting?.postMessage).not.toHaveBeenCalled();
    expect(runtime.windowObject.location.reload).not.toHaveBeenCalled();
  });

  it("reloads once only after the user activates the waiting worker", async () => {
    const runtime = createRuntime({ waiting: true, controlled: true });
    await initializePwaLifecycle(true, runtime.windowObject, runtime.navigatorObject);
    const waiting = runtime.waiting!;
    vi.mocked(waiting.postMessage).mockImplementation(() => {
      Object.assign(waiting, { state: "activated" as ServiceWorkerState });
      waiting.dispatchEvent(new Event("statechange"));
    });

    await expect(activatePwaUpdate(runtime.windowObject)).resolves.toBe("activated");

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(runtime.windowObject.location.reload).toHaveBeenCalledOnce();
  });

  it("fails closed when the same waiting worker already triggered one refresh", async () => {
    const runtime = createRuntime({ waiting: true, controlled: true });
    const waiting = runtime.waiting!;
    Object.assign(waiting, { scriptURL: "https://piwork.test/piwork-sw.js?v=2" });
    const storage = new Map<string, string>([
      ["piwork-pwa-refresh:https://piwork.test/piwork-sw.js?v=2", "1"],
    ]);
    Object.assign(runtime.windowObject, {
      sessionStorage: {
        get length() {
          return storage.size;
        },
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => [...storage.keys()][index] ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    await initializePwaLifecycle(true, runtime.windowObject, runtime.navigatorObject);
    storage.set("piwork-pwa-refresh:https://piwork.test/piwork-sw.js?v=2", "1");

    await expect(activatePwaUpdate(runtime.windowObject)).resolves.toBe("failed");
    expect(getPwaLifecycleState()).toMatchObject({
      updateActivating: false,
      error: "This app update already refreshed once and still did not activate",
    });
    expect(waiting.postMessage).not.toHaveBeenCalled();
  });
});
