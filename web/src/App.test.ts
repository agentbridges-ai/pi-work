// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import {
  default as App,
  applyDocumentLocale,
  applyDocumentTheme,
  applyWorkspaceBootstrapUserIfCurrent,
} from "./App.js";
import { api, type CurrentUser } from "./api.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { useStore } from "./store.js";
import { userScopeKeyFromCurrentUser } from "./store/user-scoped-storage.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("applyDocumentTheme", () => {
  it("marks the document as dark and enables native dark controls", () => {
    const root = document.createElement("html");
    root.className = "bg-background light";

    applyDocumentTheme(true, root);

    expect(root).toHaveClass("dark");
    expect(root).not.toHaveClass("light");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("marks the document as light and disables stale dark state", () => {
    const root = document.createElement("html");
    root.className = "bg-background dark";

    applyDocumentTheme(false, root);

    expect(root).toHaveClass("light");
    expect(root).not.toHaveClass("dark");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("removes obsolete design preset and radius attributes", () => {
    const root = document.createElement("html");
    root.dataset.designTheme = "manus";
    root.dataset.designRadius = "soft";

    applyDocumentTheme(false, root);

    expect(root).not.toHaveAttribute("data-design-theme");
    expect(root).not.toHaveAttribute("data-design-radius");
  });
});

describe("applyDocumentLocale", () => {
  it("keeps document metadata in the active Chinese and English catalogs", () => {
    const description = document.createElement("meta");
    description.name = "description";
    document.head.append(description);

    applyDocumentLocale("en-US", document);

    expect(document.documentElement.lang).toBe("en-US");
    expect(document.title).toBe("All-in-One Paperwork Agent Workspace");
    expect(description.content).toBe("All-in-One Paperwork Agent Workspace");

    applyDocumentLocale("zh-CN", document);
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe("一站式Paperwork Agent工作台");
    expect(description.content).toBe("一站式Paperwork Agent工作台");

    description.remove();
  });
});

describe("workspace bootstrap identity gate", () => {
  it("does not apply an older tenant bootstrap when responses resolve in reverse order", async () => {
    const baseUser: CurrentUser = {
      userId: "better-auth-user",
      uuid: "better-auth-user",
      username: "user",
      displayName: "User",
      orgId: "org",
      orgName: "Org",
      roles: [],
    };
    const tenantA = { ...baseUser, tenantId: "tenant-a" };
    const tenantB = { ...baseUser, tenantId: "tenant-b" };
    const expectedScopeKey = userScopeKeyFromCurrentUser(tenantB);
    const oldBootstrap = deferred<CurrentUser>();
    const latestBootstrap = deferred<CurrentUser>();
    let currentUser: CurrentUser = tenantB;
    const setCurrentUser = vi.fn((user: CurrentUser) => {
      currentUser = user;
    });
    const apply = async (pending: Promise<CurrentUser>, expectedScopeKey: string) =>
      applyWorkspaceBootstrapUserIfCurrent(
        await pending,
        expectedScopeKey,
        currentUser,
        "local",
        setCurrentUser,
      );

    const oldResult = apply(oldBootstrap.promise, userScopeKeyFromCurrentUser(tenantA));
    const latestResult = apply(latestBootstrap.promise, userScopeKeyFromCurrentUser(tenantB));
    latestBootstrap.resolve(tenantB);
    await expect(latestResult).resolves.toBe(true);
    oldBootstrap.resolve(tenantA);
    await expect(oldResult).resolves.toBe(false);

    expect(setCurrentUser).toHaveBeenCalledTimes(1);
    expect(setCurrentUser).toHaveBeenCalledWith(tenantB, "local");
  });

  it("hydrates and persists only within the active tenant-scoped runtime", async () => {
    const user: CurrentUser = {
      userId: "better-auth-user",
      uuid: "compat-user-id",
      username: "user",
      displayName: "User",
      orgId: "org",
      orgName: "Org",
      roles: [],
      tenantId: "tenant-a",
    };
    const emptyBindings = { agent: "", "agent-a": "", "agent-b": "", "agent-c": "" };
    const emptyHistory = { agent: [], "agent-a": [], "agent-b": [], "agent-c": [] };
    const emptyUserSpaces = { agent: [], "agent-a": [], "agent-b": [], "agent-c": [] };
    await runtimeContextCoordinator.dispose();
    useStore.getState().reset();
    useStore.setState({
      authInitialized: true,
      isAuthenticated: true,
      currentUser: user,
      runtimeMode: "local",
    });
    window.history.replaceState({}, "", "/");

    const getMe = vi.spyOn(api, "getMe").mockResolvedValue({ user, runtimeMode: "local" });
    const getWorkspaceBootstrap = vi.spyOn(api, "getWorkspaceBootstrap").mockResolvedValue({
      user,
      sessions: [],
      workspaceState: {
        selectedAgentId: "agent",
        currentSessionId: null,
        agentSessionIds: emptyBindings,
        agentSessionHistoryIds: emptyHistory,
        agentUserSpaces: emptyUserSpaces,
      },
    });
    const getBackendModels = vi
      .spyOn(api, "getBackendModels")
      .mockImplementation(() => new Promise<never>(() => {}));
    const putWorkspaceSessionState = vi
      .spyOn(api, "putWorkspaceSessionState")
      .mockImplementation(async (state) => state);

    const view = render(createElement(App));
    try {
      await waitFor(() => expect(getWorkspaceBootstrap).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(putWorkspaceSessionState).toHaveBeenCalledTimes(1), {
        timeout: 1_500,
      });

      expect(runtimeContextCoordinator.current()?.context).toMatchObject({
        userId: "compat-user-id",
        userScopeKey: '["compat-user-id","tenant-a"]',
        agentId: "agent",
        sessionId: null,
      });
      expect(useStore.getState().currentUser).toEqual(user);
    } finally {
      view.unmount();
      getMe.mockRestore();
      getWorkspaceBootstrap.mockRestore();
      getBackendModels.mockRestore();
      putWorkspaceSessionState.mockRestore();
      useStore.getState().reset();
      await runtimeContextCoordinator.dispose();
    }
  });
});
