import { ensureUserSpaceRuntimeLoaded } from "./user-space-runtime-lifecycle.js";

type WsRuntimeModule = Pick<typeof import("./ws.js"), "connectSession" | "disconnectAll">;

let loadedRuntime: WsRuntimeModule | null = null;
let runtimeLoad: Promise<WsRuntimeModule> | null = null;
let connectionGeneration = 0;

async function loadWsRuntime(): Promise<WsRuntimeModule> {
  if (loadedRuntime) return loadedRuntime;
  const load = runtimeLoad ?? import("./ws.js");
  runtimeLoad = load;
  try {
    loadedRuntime = await load;
    return loadedRuntime;
  } catch (error) {
    if (runtimeLoad === load) runtimeLoad = null;
    throw error;
  }
}

/** Load the WebSocket client only after an authenticated session needs it. */
export function connectSession(sessionId: string): void {
  const generation = connectionGeneration;
  void Promise.all([loadWsRuntime(), ensureUserSpaceRuntimeLoaded()])
    .then(([runtime]) => {
      if (generation !== connectionGeneration) return;
      runtime.connectSession(sessionId);
    })
    .catch((error) => {
      console.warn(`[ws] Failed to load the session client for ${sessionId}`, error);
    });
}

/**
 * Invalidate pending connects before synchronously closing an already-loaded
 * client. This prevents a late dynamic import from reconnecting after logout.
 */
export function disconnectAll(): void {
  connectionGeneration += 1;
  loadedRuntime?.disconnectAll();
}
