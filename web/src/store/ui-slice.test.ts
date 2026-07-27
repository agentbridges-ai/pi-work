// @vitest-environment jsdom

// vi.hoisted runs before any imports, ensuring browser globals are available when store.ts initializes.
vi.hoisted(() => {
  // jsdom does not implement matchMedia
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
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

  // Node.js 22+ native localStorage may be broken (invalid --localstorage-file).
  // Polyfill before store.ts import triggers getInitialSessionId().
  if (
    typeof globalThis.localStorage === "undefined" ||
    typeof globalThis.localStorage.getItem !== "function"
  ) {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
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
      },
      writable: true,
      configurable: true,
    });
  }
});

import { useStore } from "../store.js";
import { legacyStorageKey } from "../utils/local-storage.js";

function setSystemDarkMode(matches: boolean): void {
  Object.defineProperty(globalThis.window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  setSystemDarkMode(false);
  useStore.getState().reset();
  localStorage.clear();
});

// ─── UI state ───────────────────────────────────────────────────────────────

describe("UI state", () => {
  it("defaults to following the system theme", () => {
    useStore.getState().reset();

    expect(useStore.getState().themeMode).toBe("system");
    expect(useStore.getState().darkMode).toBe(false);
    expect(useStore.getState().uiLanguage).toBe("zh-CN");
  });

  it("reset: removes the obsolete radius preference", () => {
    localStorage.setItem("piwork-design-radius", "compact");

    useStore.getState().reset();

    expect(localStorage.getItem("piwork-design-radius")).toBeNull();
    expect("designRadius" in useStore.getState()).toBe(false);
    expect("setDesignRadius" in useStore.getState()).toBe(false);
  });

  it("setUiLanguage: stores the selected UI language", () => {
    useStore.getState().setUiLanguage("en-US");

    expect(useStore.getState().uiLanguage).toBe("en-US");
    expect(localStorage.getItem("piwork-ui-language")).toBe("en-US");

    useStore.getState().setUiLanguage("zh-CN");
    expect(useStore.getState().uiLanguage).toBe("zh-CN");
    expect(localStorage.getItem("piwork-ui-language")).toBe("zh-CN");
  });

  it("reset: restores a persisted UI language", () => {
    localStorage.setItem("piwork-ui-language", "en-US");

    useStore.getState().reset();

    expect(useStore.getState().uiLanguage).toBe("en-US");
  });

  it("setThemeMode: stores explicit dark mode and resolved legacy value", () => {
    localStorage.setItem(legacyStorageKey("theme-mode"), "light");
    localStorage.setItem(legacyStorageKey("dark-mode"), "false");

    useStore.getState().setThemeMode("dark");

    expect(useStore.getState().themeMode).toBe("dark");
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("piwork-theme-mode")).toBe("dark");
    expect(localStorage.getItem("piwork-dark-mode")).toBe("true");
    expect(localStorage.getItem(legacyStorageKey("theme-mode"))).toBeNull();
    expect(localStorage.getItem(legacyStorageKey("dark-mode"))).toBeNull();
  });

  it("setDarkMode: maps the legacy boolean API to explicit light or dark modes", () => {
    useStore.getState().setDarkMode(true);
    expect(useStore.getState().themeMode).toBe("dark");
    expect(useStore.getState().darkMode).toBe(true);

    useStore.getState().setDarkMode(false);
    expect(useStore.getState().themeMode).toBe("light");
    expect(useStore.getState().darkMode).toBe(false);
    expect(localStorage.getItem("piwork-theme-mode")).toBe("light");
    expect(localStorage.getItem("piwork-dark-mode")).toBe("false");
  });

  it("toggleDarkMode: toggles between explicit light and dark modes", () => {
    useStore.getState().toggleDarkMode();

    expect(useStore.getState().themeMode).toBe("dark");
    expect(useStore.getState().darkMode).toBe(true);

    useStore.getState().toggleDarkMode();
    expect(useStore.getState().themeMode).toBe("light");
    expect(useStore.getState().darkMode).toBe(false);
    expect(localStorage.getItem("piwork-dark-mode")).toBe("false");
  });

  it("reset: migrates the legacy theme-mode key when the new key is absent", () => {
    localStorage.setItem(legacyStorageKey("theme-mode"), "dark");

    useStore.getState().reset();

    expect(useStore.getState().themeMode).toBe("dark");
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("piwork-theme-mode")).toBe("dark");
    expect(localStorage.getItem(legacyStorageKey("theme-mode"))).toBeNull();
  });

  it("reset: maps old false dark-mode storage back to system mode", () => {
    setSystemDarkMode(true);
    localStorage.setItem(legacyStorageKey("dark-mode"), "false");

    useStore.getState().reset();

    expect(useStore.getState().themeMode).toBe("system");
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("piwork-dark-mode")).toBe("false");
    expect(localStorage.getItem(legacyStorageKey("dark-mode"))).toBeNull();
  });

  it("reset: migrates the legacy true dark-mode key when the new mode key is absent", () => {
    localStorage.setItem(legacyStorageKey("dark-mode"), "true");

    useStore.getState().reset();

    expect(useStore.getState().themeMode).toBe("dark");
    expect(useStore.getState().darkMode).toBe(true);
    expect(localStorage.getItem("piwork-dark-mode")).toBe("true");
    expect(localStorage.getItem(legacyStorageKey("dark-mode"))).toBeNull();
  });

  it("refreshSystemTheme: follows the system only while theme mode is system", () => {
    useStore.getState().setThemeMode("system");
    setSystemDarkMode(true);

    useStore.getState().refreshSystemTheme();

    expect(useStore.getState().themeMode).toBe("system");
    expect(useStore.getState().darkMode).toBe(true);

    useStore.getState().setThemeMode("light");
    setSystemDarkMode(false);
    useStore.getState().refreshSystemTheme();

    expect(useStore.getState().themeMode).toBe("light");
    expect(useStore.getState().darkMode).toBe(false);
  });

  it("setSelectedAgentId: selects without browser session persistence", () => {
    useStore.getState().setSelectedAgentId("agent-b");

    expect(useStore.getState().selectedAgentId).toBe("agent-b");
    expect(localStorage.getItem("piwork-selected-digital-agent")).toBeNull();
  });

  it("bindSessionToAgent: keeps a stable agent-to-session mapping", () => {
    useStore.getState().bindSessionToAgent("agent-a", "session-ops");

    expect(useStore.getState().selectedAgentId).toBe("agent-a");
    expect(useStore.getState().agentSessionIds["agent-a"]).toBe("session-ops");
    expect(useStore.getState().agentSessionHistoryIds["agent-a"]).toEqual(["session-ops"]);
    expect(localStorage.getItem("piwork-digital-agent-sessions")).toBeNull();
    expect(localStorage.getItem("piwork-digital-agent-session-history")).toBeNull();
  });

  it("bindSessionToAgent: keeps recent agent history without duplicates", () => {
    useStore.getState().bindSessionToAgent("agent-a", "session-1");
    useStore.getState().bindSessionToAgent("agent-a", "session-2");
    useStore.getState().bindSessionToAgent("agent-a", "session-1");

    expect(useStore.getState().agentSessionHistoryIds["agent-a"]).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("clearAgentSessionBinding: removes only the selected agent binding", () => {
    useStore.getState().bindSessionToAgent("agent-b", "finance-session");
    useStore.getState().bindSessionToAgent("agent", "agent-session");

    useStore.getState().clearAgentSessionBinding("agent-b");

    expect(useStore.getState().agentSessionIds["agent-b"]).toBe("");
    expect(useStore.getState().agentSessionIds.agent).toBe("agent-session");
  });

  it("setAgentUserSpaces: stores independent user directories per agent", () => {
    useStore.getState().setAgentUserSpaces("agent-a", [
      {
        mountId: "uw-ops",
        name: "Ops Files",
        rootName: "Ops Files",
        status: "mounted",
        access: "readwrite",
        includeHidden: true,
      },
    ]);
    useStore.getState().setAgentUserSpaces("agent-b", [
      {
        mountId: "uw-finance",
        name: "Finance Files",
        rootName: "Finance Files",
        status: "mounted",
        access: "readwrite",
        includeHidden: true,
      },
    ]);

    expect(useStore.getState().agentUserSpaces["agent-a"]).toEqual([
      expect.objectContaining({ mountId: "uw-ops", rootName: "Ops Files", status: "mounted" }),
    ]);
    expect(useStore.getState().agentUserSpaces["agent-b"]).toEqual([
      expect.objectContaining({
        mountId: "uw-finance",
        rootName: "Finance Files",
        status: "mounted",
      }),
    ]);
    expect(localStorage.getItem("piwork-digital-agent-user-spaces")).toBeNull();
  });
});

// ─── Notification settings ───────────────────────────────────────────────────

describe("Notification settings", () => {
  it("setNotificationDesktop: persists value to localStorage", () => {
    useStore.getState().setNotificationDesktop(true);
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("piwork-notification-desktop")).toBe("true");

    useStore.getState().setNotificationDesktop(false);
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("piwork-notification-desktop")).toBe("false");
  });

  it("toggleNotificationDesktop: flips value and persists to localStorage", () => {
    useStore.getState().setNotificationDesktop(false);

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(true);
    expect(localStorage.getItem("piwork-notification-desktop")).toBe("true");

    useStore.getState().toggleNotificationDesktop();
    expect(useStore.getState().notificationDesktop).toBe(false);
    expect(localStorage.getItem("piwork-notification-desktop")).toBe("false");
  });
});
