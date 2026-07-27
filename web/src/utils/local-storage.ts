const LEGACY_STORAGE_PREFIX = "cc";

export function legacyStorageKey(name: string): string {
  return `${LEGACY_STORAGE_PREFIX}-${name}`;
}

function getBrowserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function readStorageItem(key: string, legacyKey?: string): string | null {
  const storage = getBrowserLocalStorage();
  if (!storage) return null;

  const value = storage.getItem(key);
  if (value !== null || !legacyKey) return value;

  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue === null) return null;

  try {
    storage.setItem(key, legacyValue);
    storage.removeItem(legacyKey);
  } catch {
    // Keep using the legacy value if migration is blocked by storage settings.
  }
  return legacyValue;
}

export function writeStorageItem(key: string, value: string, legacyKey?: string): void {
  const storage = getBrowserLocalStorage();
  if (!storage) return;

  storage.setItem(key, value);
  if (legacyKey) storage.removeItem(legacyKey);
}

export function removeStorageItem(key: string, legacyKey?: string): void {
  const storage = getBrowserLocalStorage();
  if (!storage) return;

  storage.removeItem(key);
  if (legacyKey) storage.removeItem(legacyKey);
}
