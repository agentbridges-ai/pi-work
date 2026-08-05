// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const createSessionStreamMock = vi.hoisted(() => vi.fn());
const connectSessionMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    createSessionStream: createSessionStreamMock,
  };
});

vi.mock("./ws-runtime-lifecycle.js", () => ({
  connectSession: connectSessionMock,
  disconnectAll: vi.fn(),
}));

vi.mock("./workspace-session-state.js", () => ({
  persistWorkspaceSessionStateNow: vi.fn(),
  scheduleWorkspaceSessionStatePersist: vi.fn(),
}));

vi.mock("./user-space-runtime-lifecycle.js", () => ({
  disposeLoadedUserSpaceRuntimeState: vi.fn(),
  ensureUserSpaceRuntimeLoaded: vi.fn(async () => {}),
}));

vi.mock("./components/ChatView.js", () => ({
  ChatView: ({ sessionId }: { sessionId: string }) => (
    <main data-testid="chat-view">{sessionId}</main>
  ),
}));

vi.mock("./components/AppsPage.js", () => ({
  AppsPage: () => <main data-testid="apps-page" />,
}));

import App from "./App.js";
import { api, type CurrentUser } from "./api.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { useStore } from "./store.js";
import { uiCopy } from "./ui-copy.js";

const user: CurrentUser = {
  userId: "better-auth-user",
  uuid: "pi-user",
  username: "user",
  displayName: "User",
  orgId: "org",
  orgName: "Org",
  roles: [],
  tenantId: "tenant-a",
};
const model = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };
const emptyBindings = { agent: "", "agent-a": "", "agent-b": "", "agent-c": "" };
const emptyHistory = { agent: [], "agent-a": [], "agent-b": [], "agent-c": [] };
const emptyUserSpaces = { agent: [], "agent-a": [], "agent-b": [], "agent-c": [] };

async function prepareWorkspace(): Promise<void> {
  await runtimeContextCoordinator.dispose();
  useStore.getState().reset();
  useStore.setState({
    authInitialized: true,
    isAuthenticated: true,
    currentUser: user,
    runtimeMode: "local",
    preferencesLoaded: true,
  });
  window.history.replaceState({}, "", "/");
  vi.spyOn(api, "getMe").mockResolvedValue({ user, runtimeMode: "local" });
  vi.spyOn(api, "getWorkspaceBootstrap").mockResolvedValue({
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
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  createSessionStreamMock.mockReset();
  connectSessionMock.mockReset();
  await prepareWorkspace();
});

afterEach(async () => {
  useStore.getState().reset();
  await runtimeContextCoordinator.dispose();
});

describe("automatic Pi workspace creation", () => {
  it("loads the lazy Apps route through the authenticated shell", async () => {
    window.history.replaceState({}, "", "/apps");
    const view = render(createElement(App));
    try {
      await waitFor(() => expect(screen.getByTestId("apps-page")).toBeInTheDocument());
    } finally {
      view.unmount();
    }
  });

  it("creates and binds a native Pi session with the probed model", async () => {
    vi.spyOn(api, "getBackendModels").mockImplementation(async () => {
      useStore.getState().setRuntimeSessions([
        {
          sessionId: "unbound-existing",
          state: "connected",
          transport: "pi-rpc",
          cwd: "/workspace",
          createdAt: 1,
          backendType: "pi",
        },
      ]);
      return [
        {
          model,
          label: "GPT-5",
          description: "Native Pi",
          thinkingLevels: ["off", "high"],
        },
      ];
    });
    createSessionStreamMock.mockResolvedValue({
      sessionId: "pi-session",
      state: "connected",
      cwd: "/workspace",
      backendType: "pi",
      transport: "pi-rpc",
      model,
      thinkingLevel: "high",
      mode: "agent",
    });

    const view = render(createElement(App));
    try {
      await waitFor(() => {
        expect(createSessionStreamMock).toHaveBeenCalledWith(
          { backend: "pi", agentId: "agent", model },
          expect.any(Function),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(useStore.getState().currentSessionId).toBe("pi-session");
      });

      expect(useStore.getState().runtimeSessions).toEqual([
        expect.objectContaining({ sessionId: "unbound-existing" }),
        expect.objectContaining({
          sessionId: "pi-session",
          backendType: "pi",
          transport: "pi-rpc",
          model,
          thinkingLevel: "high",
          mode: "agent",
        }),
      ]);
      expect(useStore.getState().previousAgentMode.get("pi-session")).toBe("agent");
      expect(useStore.getState().agentSessionIds.agent).toBe("pi-session");
      await waitFor(() => expect(connectSessionMock).toHaveBeenCalledWith("pi-session"));
    } finally {
      view.unmount();
    }
  });

  it("fails closed when the controlled Pi probe returns no allowed models", async () => {
    vi.spyOn(api, "getBackendModels").mockResolvedValue([]);

    const view = render(createElement(App));
    try {
      await waitFor(() => {
        expect(useStore.getState().creationError).toBe(uiCopy.piRuntime.noModels);
      });
      expect(createSessionStreamMock).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(uiCopy.piRuntime.noModels);
    } finally {
      view.unmount();
    }
  });
});
