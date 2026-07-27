// Setup file for jsdom-based tests
// Polyfills that must be available before any module import
import { beforeEach, vi } from "vitest";
import { setUiCopyLanguage } from "./ui-copy.js";

// The historical component suite asserts English copy. Pin its baseline so
// host locale and language changes in other test files cannot leak across
// tests; i18n-specific suites override this in their own hooks.
setUiCopyLanguage("en-US");
beforeEach(() => {
  setUiCopyLanguage("en-US");
});

// Register vitest-axe matchers (toHaveNoViolations) in jsdom environments.
// The vitest-axe/extend-expect entry is an empty file in some builds, so we
// manually import the matcher and extend expect ourselves.
if (typeof window !== "undefined") {
  const matchers = (await import("vitest-axe/matchers")) as any;
  expect.extend({ toHaveNoViolations: matchers.toHaveNoViolations });
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  const getComputedStyleWithoutPseudo = window.getComputedStyle.bind(window);
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: (element: Element) => getComputedStyleWithoutPseudo(element),
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: window.getComputedStyle,
  });

  if (typeof HTMLCanvasElement !== "undefined") {
    const canvasContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      measureText: vi.fn(() => ({ width: 0 })),
      restore: vi.fn(),
      save: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: vi.fn(() => canvasContext),
    });
  }

  if (typeof window.ResizeObserver === "undefined") {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      value: ResizeObserverMock,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: ResizeObserverMock,
      writable: true,
      configurable: true,
    });
  }

  // Node.js 22+ ships native localStorage that requires --localstorage-file.
  // Vitest may provide an invalid path, leaving a broken global that shadows
  // jsdom's working implementation. Polyfill when getItem is missing.
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      writable: true,
      configurable: true,
    });
  }

  if (typeof globalThis.fetch === "function" && typeof window.fetch !== "function") {
    Object.defineProperty(window, "fetch", {
      value: globalThis.fetch.bind(globalThis),
      writable: true,
      configurable: true,
    });
  }
}

export {};
