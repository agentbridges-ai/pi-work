import { enUSCopyOverrides } from "./ui-copy/en-US.js";
import { zhCNCopy } from "./ui-copy/zh-CN.js";
import type { DeepPartialUiCopy, UiCopy, UiCopyLanguage } from "./ui-copy/types.js";

export type { UiCopyLanguage } from "./ui-copy/types.js";

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeUiCopy<T>(base: T, overrides: DeepPartialUiCopy<T> | undefined): T {
  if (!isRecord(base) || !isRecord(overrides)) return (overrides ?? base) as T;
  const result: Record<PropertyKey, unknown> = { ...base };
  for (const key of Reflect.ownKeys(overrides)) {
    const baseValue = (base as Record<PropertyKey, unknown>)[key];
    const overrideValue = (overrides as Record<PropertyKey, unknown>)[key];
    result[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeUiCopy(baseValue, overrideValue as DeepPartialUiCopy<typeof baseValue>)
        : overrideValue;
  }
  return result as T;
}

const uiCopyCatalog: Record<UiCopyLanguage, UiCopy> = {
  "zh-CN": zhCNCopy,
  "en-US": mergeUiCopy<UiCopy>(zhCNCopy, enUSCopyOverrides),
};

let activeUiCopyLanguage: UiCopyLanguage = "zh-CN";

export function getUiCopyLanguage(): UiCopyLanguage {
  return activeUiCopyLanguage;
}

export function setUiCopyLanguage(language: UiCopyLanguage): void {
  activeUiCopyLanguage = language;
}

export function getUiCopyCatalog(language: UiCopyLanguage): UiCopy {
  return uiCopyCatalog[language];
}

function getPathValue(path: readonly PropertyKey[]): unknown {
  let value: unknown = uiCopyCatalog[activeUiCopyLanguage];
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

const proxyCache = new Map<string, object>();

function createUiCopyProxy(path: readonly PropertyKey[] = []): unknown {
  const cacheKey = path.map(String).join(".");
  const cached = proxyCache.get(cacheKey);
  if (cached) return cached;

  const proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === Symbol.toStringTag) return "UiCopy";
        const nextPath = [...path, property];
        const value = getPathValue(nextPath);
        return isRecord(value) ? createUiCopyProxy(nextPath) : value;
      },
      has(_target, property) {
        const value = getPathValue(path);
        return isRecord(value) && property in value;
      },
      ownKeys() {
        const value = getPathValue(path);
        return isRecord(value) ? Reflect.ownKeys(value) : [];
      },
      getOwnPropertyDescriptor(_target, property) {
        const value = getPathValue(path);
        if (!isRecord(value) || !(property in value)) return undefined;
        return { enumerable: true, configurable: true };
      },
    },
  );

  proxyCache.set(cacheKey, proxy);
  return proxy;
}

export const uiCopy = createUiCopyProxy() as UiCopy;
