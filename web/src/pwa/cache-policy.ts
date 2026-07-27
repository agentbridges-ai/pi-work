export const PIWORK_SW_PATH = "/piwork-sw.js";
export const PIWORK_CACHE_PREFIX = "piwork-pwa-";

export const LEGACY_PIWORK_CACHE_PREFIXES = [
  "piwork-app-shell-",
  "piwork-runtime-legacy-",
  "companion-app-shell-",
] as const;

export function registrationScriptPath(registration: ServiceWorkerRegistration): string | null {
  const scriptUrl =
    registration.installing?.scriptURL ||
    registration.waiting?.scriptURL ||
    registration.active?.scriptURL;
  if (!scriptUrl) return null;
  try {
    return new URL(scriptUrl).pathname;
  } catch {
    return null;
  }
}
