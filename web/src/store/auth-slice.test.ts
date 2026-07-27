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
import * as userSpaceLifecycle from "../user-space-runtime-lifecycle.js";

const misakaUser = {
  userId: "misaka.mikoto",
  uuid: "0bf8be70-f8fc-1040-9f90-2d72fd78b284",
  username: "misaka.mikoto",
  displayName: "御坂美琴",
  orgId: "tokiwadai",
  orgName: "常盘台中学",
  roles: ["tokiwadai"],
};

const shiraiUser = {
  userId: "shirai.kuroko",
  uuid: "f706a468-d311-4a03-bec4-292ec0371665",
  username: "shirai.kuroko",
  displayName: "白井黑子",
  orgId: "judgment-177",
  orgName: "第177支部风纪委员",
  roles: ["judgment-177"],
};

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
});

// ─── Auth actions ────────────────────────────────────────────────────────────

describe("Auth actions", () => {
  it("setAuthToken: keeps token in memory only and sets isAuthenticated true", () => {
    useStore.getState().setAuthToken("my-secret-token");

    const state = useStore.getState();
    expect(state.authToken).toBe("my-secret-token");
    expect(state.isAuthenticated).toBe(true);
    expect(localStorage.getItem("piwork_auth_token")).toBeNull();
  });

  it("logout: clears in-memory auth state", () => {
    // First authenticate
    useStore.getState().setAuthToken("token-123");
    expect(useStore.getState().isAuthenticated).toBe(true);

    // Then logout
    useStore.getState().logout();

    const state = useStore.getState();
    expect(state.authToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(localStorage.getItem("piwork_auth_token")).toBeNull();
  });

  it("logout: clears local workspace state without writing a browser session bucket", () => {
    useStore.getState().setAuthToken("token-123");
    useStore.getState().setCurrentUser(misakaUser, "local");
    useStore.getState().setCurrentSession("old-session");
    useStore.getState().setRuntimeSessions([
      {
        sessionId: "old-session",
        state: "connected",
        backendType: "pi",
        transport: "pi-rpc",
        cwd: "/data",
        createdAt: Date.now(),
      },
    ]);
    useStore.getState().setMessages("old-session", [
      {
        id: "m1",
        role: "assistant",
        content: "previous user",
        timestamp: Date.now(),
      },
    ]);
    useStore.getState().bindSessionToAgent("agent", "old-session");

    useStore.getState().logout();

    const state = useStore.getState();
    expect(state.runtimeMode).toBe("local");
    expect(state.currentSessionId).toBeNull();
    expect(state.runtimeSessions).toEqual([]);
    expect(state.messages.size).toBe(0);
    expect(state.agentSessionIds.agent).toBe("");
    expect(state.agentSessionHistoryIds.agent).toEqual([]);
    expect(localStorage.getItem("piwork-current-session")).toBeNull();
    expect(localStorage.getItem("piwork-digital-agent-sessions")).toBeNull();
    expect(localStorage.getItem("piwork-digital-agent-session-history")).toBeNull();
  });

  it("setCurrentUser: switching local users avoids restoring browser session buckets", () => {
    useStore.getState().setCurrentUser(misakaUser, "local");
    useStore.getState().setCurrentSession("misaka-session");
    useStore.getState().bindSessionToAgent("agent", "misaka-session");

    useStore.getState().setCurrentUser(shiraiUser, "local");
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");

    useStore.getState().setCurrentSession("shirai-session");
    useStore.getState().bindSessionToAgent("agent", "shirai-session");

    useStore.getState().setCurrentUser(misakaUser, "local");
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");

    useStore.getState().setCurrentUser(shiraiUser, "local");
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");
  });

  it("setCurrentUser: switching tenants for the same user clears the previous tenant runtime", () => {
    const disposeUserSpace = vi.spyOn(userSpaceLifecycle, "disposeLoadedUserSpaceRuntimeState");
    const tenantA = { ...misakaUser, tenantId: "tenant-a", tenantName: "Tenant A" };
    const tenantB = { ...misakaUser, tenantId: "tenant-b", tenantName: "Tenant B" };
    useStore.getState().setCurrentUser(tenantA, "local");
    useStore.getState().setCurrentSession("tenant-a-session");
    useStore.getState().bindSessionToAgent("agent", "tenant-a-session");
    useStore.getState().setMessages("tenant-a-session", [
      {
        id: "tenant-a-message",
        role: "assistant",
        content: "tenant A only",
        timestamp: Date.now(),
      },
    ]);

    useStore.getState().setCurrentUser(tenantB, "local");

    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");
    expect(useStore.getState().messages.size).toBe(0);
    expect(useStore.getState().currentUser?.tenantId).toBe("tenant-b");
    expect(disposeUserSpace).toHaveBeenCalledTimes(2);
    disposeUserSpace.mockRestore();
  });

  it("setCurrentUser: local mode waits for server-side workspace state instead of localStorage", () => {
    useStore.getState().setCurrentUser(misakaUser, "local");
    useStore.getState().setCurrentSession("misaka-session");
    useStore.getState().bindSessionToAgent("agent", "misaka-session");

    useStore.getState().setCurrentUser(shiraiUser, "local");
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");

    useStore.getState().setCurrentSession("shirai-session");
    useStore.getState().bindSessionToAgent("agent", "shirai-session");

    useStore.getState().setCurrentUser(misakaUser, "local");
    expect(useStore.getState().currentSessionId).toBeNull();
    expect(useStore.getState().agentSessionIds.agent).toBe("");
  });
});
