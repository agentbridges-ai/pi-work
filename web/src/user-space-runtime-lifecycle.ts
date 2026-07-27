type UserSpaceRuntimeModule = Pick<
  typeof import("./user-space.js"),
  "disposeUserSpaceRuntimeState"
>;

let loadedRuntime: UserSpaceRuntimeModule | null = null;
let runtimeLoad: Promise<UserSpaceRuntimeModule> | null = null;
let lifecycleGeneration = 0;
let loadedRuntimeGeneration = -1;

/**
 * Load the browser filesystem runtime only when an authenticated workbench
 * route needs it. Keeping this import behind the route boundary prevents the
 * large User Space implementation from becoming part of the login entry.
 */
export async function ensureUserSpaceRuntimeLoaded(): Promise<void> {
  if (loadedRuntime) return;
  const generation = lifecycleGeneration;
  const load = runtimeLoad ?? import("./user-space.js");
  runtimeLoad = load;
  try {
    const runtime = await load;
    if (loadedRuntime !== runtime || loadedRuntimeGeneration !== lifecycleGeneration) {
      loadedRuntime = runtime;
      loadedRuntimeGeneration = lifecycleGeneration;
      if (generation !== lifecycleGeneration) runtime.disposeUserSpaceRuntimeState();
    }
  } catch (error) {
    if (runtimeLoad === load) runtimeLoad = null;
    throw error;
  }
}

/**
 * User-scope cleanup must stay synchronous: a newly activated account must
 * never race with delayed cleanup from the previous account. If the workbench
 * route was never opened there is no User Space state to release.
 */
export function disposeLoadedUserSpaceRuntimeState(): void {
  lifecycleGeneration++;
  if (!loadedRuntime) return;
  loadedRuntime.disposeUserSpaceRuntimeState();
  loadedRuntimeGeneration = lifecycleGeneration;
}
