import {
  LEGACY_PIWORK_CACHE_PREFIXES,
  PIWORK_CACHE_PREFIX,
  PIWORK_SW_PATH,
  registrationScriptPath,
} from "./cache-policy.js";

export interface CleanupPiworkPwaOptions {
  includeCurrent?: boolean;
  includeLegacy?: boolean;
}

function isOfficeHost(hostname: string): boolean {
  return hostname.includes(".office-host.") || hostname.startsWith("office-host.");
}

/**
 * Retires only Piwork-owned PWA state. In particular, this must never clear
 * the complete CacheStorage namespace or unregister OnlyOffice's `/sw.js` on
 * its isolated editor origin.
 */
export async function cleanupPiworkPwa(
  options: CleanupPiworkPwaOptions = {},
  windowObject: Window = window,
  navigatorObject: Navigator = navigator,
): Promise<void> {
  const includeCurrent = options.includeCurrent === true;
  const includeLegacy = options.includeLegacy !== false;
  const unregister: Promise<boolean>[] = [];

  if ("serviceWorker" in navigatorObject) {
    const registrations = await navigatorObject.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const pathname = registrationScriptPath(registration);
      if (pathname === PIWORK_SW_PATH && includeCurrent) {
        unregister.push(registration.unregister());
      }
      if (pathname === "/sw.js" && includeLegacy && !isOfficeHost(windowObject.location.hostname)) {
        unregister.push(registration.unregister());
      }
    }
  }

  await Promise.all(unregister);

  if (!("caches" in windowObject)) return;
  const cacheKeys = await windowObject.caches.keys();
  const prefixes = includeCurrent
    ? [PIWORK_CACHE_PREFIX, ...LEGACY_PIWORK_CACHE_PREFIXES]
    : [...LEGACY_PIWORK_CACHE_PREFIXES];
  await Promise.all(
    cacheKeys
      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix)))
      .map((key) => windowObject.caches.delete(key)),
  );
}
