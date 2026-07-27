// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import type { PiSessionInfo } from "../../types.js";
import { api } from "../../api.js";
import { useStore } from "../../store.js";
import { uiCopy } from "../../ui-copy.js";
import { AgentSessionSelector } from "./AgentSessionSelector.js";

const transitionControl = vi.hoisted(() => ({
  commitResult: true,
  prepareResult: true,
}));
const connectSessionMock = vi.hoisted(() => vi.fn());
const navigateToSessionMock = vi.hoisted(() => vi.fn());
const navigateHomeMock = vi.hoisted(() => vi.fn());

vi.mock("../ui/index.js", () => ({
  DropdownMotion: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="mock-dropdown">{children}</div> : null,
  IconButton: ({
    label,
    isDisabled,
    onPress,
    children,
  }: {
    label: string;
    isDisabled?: boolean;
    onPress?: () => void;
    children: ReactNode;
  }) => (
    <button type="button" aria-label={label} disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("../../runtime-context-switch.js", () => ({
  beginRuntimeContextTransition: (input: {
    userId: string;
    userScopeKey: string;
    agentId: string;
    sessionId: string | null;
  }) => {
    const controller = new AbortController();
    return {
      context: { ...input, epoch: 1, contextId: "test-context" },
      signal: controller.signal,
      prepare: vi.fn(async () => transitionControl.prepareResult),
      commit: vi.fn(async (apply: () => void) => {
        if (transitionControl.commitResult) apply();
        return transitionControl.commitResult;
      }),
      cancel: vi.fn(async () => controller.abort()),
    };
  },
}));

vi.mock("../../ws.js", () => ({
  connectSession: connectSessionMock,
}));

vi.mock("../../utils/routing.js", () => ({
  navigateHome: navigateHomeMock,
  navigateToSession: navigateToSessionMock,
}));

vi.mock("../../user-space.js", () => ({
  attachUserSpaceMountsToSession: vi.fn(),
}));

vi.mock("../../workspace-session-state.js", () => ({
  persistWorkspaceSessionStateNow: vi.fn(),
}));

const model = { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" };
const currentSession: PiSessionInfo = {
  sessionId: "current",
  state: "connected",
  transport: "pi-rpc",
  model,
  thinkingLevel: "high",
  mode: "agent",
  runState: "ready",
  cwd: "/workspace",
  createdAt: 20,
  name: "Current topic",
  backendType: "pi",
};
const olderSession: PiSessionInfo = {
  sessionId: "older",
  state: "exited",
  lifecycleState: "closed",
  transport: "pi-rpc",
  model,
  thinkingLevel: "low",
  mode: "plan",
  runState: "stopped",
  cwd: "/workspace",
  createdAt: 10,
  name: "Older topic",
  backendType: "pi",
};

function seedSelectorState(): void {
  useStore.getState().reset();
  useStore.setState({
    currentUser: {
      userId: "user-1",
      uuid: "user-uuid",
      username: "alice",
      displayName: "Alice",
      orgId: "org-1",
      orgName: "Example",
      roles: ["member"],
      tenantId: "tenant-1",
    },
    runtimeSessions: [currentSession],
    currentSessionId: "current",
  });
  useStore.getState().hydrateWorkspaceSessionState({
    selectedAgentId: "agent",
    agentSessionIds: { agent: "current" },
    agentSessionHistoryIds: {
      agent: ["current", "older"],
    },
    agentUserSpaces: { agent: [] },
  });
  useStore.getState().setRuntimeConnected("current", true);
}

function renderSelector(overrides?: {
  onCreatingAgentChange?: (agentId: string | null) => void;
  onArchiveError?: (message: string) => void;
}) {
  return render(
    <AgentSessionSelector
      sessionId="current"
      agentId="agent"
      openSearchRequest={1}
      onCreatingAgentChange={overrides?.onCreatingAgentChange ?? vi.fn()}
      onArchiveError={overrides?.onArchiveError ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  transitionControl.commitResult = true;
  transitionControl.prepareResult = true;
  connectSessionMock.mockReset();
  navigateToSessionMock.mockReset();
  navigateHomeMock.mockReset();
  seedSelectorState();
  vi.spyOn(api, "listSessionsPage").mockResolvedValue({
    sessions: [currentSession, olderSession],
    total: 2,
    cursor: 0,
    nextCursor: 2,
    hasMore: false,
    agentId: "agent",
  });
});

afterEach(() => {
  useStore.getState().reset();
});

describe("AgentSessionSelector Pi lifecycle", () => {
  it("loads, searches and activates an existing native Pi topic", async () => {
    renderSelector();

    const oldButton = await screen.findByRole("button", {
      name: `${uiCopy.chat.selectSession} Older topic`,
    });
    expect(api.listSessionsPage).toHaveBeenCalledWith({
      agentId: "agent",
      cursor: 0,
      limit: 100,
    });
    expect(useStore.getState().runtimeSessions.map((session) => session.sessionId)).toEqual([
      "current",
      "older",
    ]);

    fireEvent.change(screen.getByTestId("session-search-input"), {
      target: { value: "openai/gpt-5" },
    });
    expect(screen.getAllByTestId("topic-session-row")).toHaveLength(2);

    fireEvent.click(oldButton);
    await waitFor(() => expect(useStore.getState().currentSessionId).toBe("older"));
    expect(useStore.getState().agentSessionIds.agent).toBe("older");
    expect(connectSessionMock).toHaveBeenCalledWith("older");
    expect(navigateToSessionMock).toHaveBeenCalledWith(
      "older",
      false,
      expect.objectContaining({ userUuid: "user-uuid", agentId: "agent" }),
    );
  });

  it("creates a new Pi topic with the controlled model probe", async () => {
    const onCreatingAgentChange = vi.fn();
    vi.spyOn(api, "getBackendModels").mockResolvedValue([
      {
        model,
        label: "GPT-5",
        thinkingLevels: ["off", "high"],
      },
    ]);
    vi.spyOn(api, "createSession").mockResolvedValue({
      sessionId: "created",
      state: "connected",
      cwd: "/workspace",
      backendType: "pi",
      transport: "pi-rpc",
      model,
      thinkingLevel: "high",
      mode: "agent",
    });
    renderSelector({ onCreatingAgentChange });
    await screen.findByRole("button", {
      name: `${uiCopy.chat.selectSession} Current topic`,
    });

    fireEvent.click(screen.getByRole("button", { name: uiCopy.chat.createSession }));

    await waitFor(() => expect(useStore.getState().currentSessionId).toBe("created"));
    expect(api.getBackendModels).toHaveBeenCalledWith("agent");
    expect(api.createSession).toHaveBeenCalledWith(
      {
        backend: "pi",
        agentId: "agent",
        model,
        userSpace: null,
      },
      expect.objectContaining({ signal: undefined, contextEpoch: undefined }),
    );
    expect(useStore.getState().runtimeSessions).toContainEqual(
      expect.objectContaining({
        sessionId: "created",
        backendType: "pi",
        transport: "pi-rpc",
        model,
      }),
    );
    expect(useStore.getState().previousAgentMode.get("created")).toBe("agent");
    expect(onCreatingAgentChange).toHaveBeenNthCalledWith(1, "agent");
    expect(onCreatingAgentChange).toHaveBeenLastCalledWith(null);
    expect(connectSessionMock).toHaveBeenCalledWith("created");
  });

  it("fails closed when no model survives the Pi policy intersection", async () => {
    vi.spyOn(api, "getBackendModels").mockResolvedValue([]);
    const createSpy = vi.spyOn(api, "createSession");
    renderSelector();
    await screen.findByRole("button", {
      name: `${uiCopy.chat.selectSession} Current topic`,
    });

    fireEvent.click(screen.getByRole("button", { name: uiCopy.chat.createSession }));

    await waitFor(() => expect(useStore.getState().creationError).toBe(uiCopy.piRuntime.noModels));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("renames a loaded Pi topic", async () => {
    vi.spyOn(api, "renameSession").mockResolvedValue({ ok: true, name: "Renamed topic" });
    renderSelector();
    await screen.findByRole("button", {
      name: `${uiCopy.chat.selectSession} Older topic`,
    });

    fireEvent.click(screen.getByRole("button", { name: uiCopy.chat.renameSession("Older topic") }));
    const input = screen.getByRole("textbox", { name: uiCopy.chat.sessionName });
    fireEvent.change(input, { target: { value: "Renamed topic" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(useStore.getState().sessionNames.get("older")).toBe("Renamed topic"),
    );
    expect(api.renameSession).toHaveBeenCalledWith("older", "Renamed topic");
  });

  it("reconciles the visible runtime list when archive activation cannot commit", async () => {
    transitionControl.commitResult = false;
    vi.spyOn(api, "archiveSession").mockResolvedValue({ ok: true });
    renderSelector();
    await screen.findByRole("button", {
      name: `${uiCopy.chat.selectSession} Older topic`,
    });

    fireEvent.click(
      screen.getByRole("button", { name: uiCopy.chat.archiveSession("Current topic") }),
    );

    await waitFor(() => {
      expect(api.archiveSession).toHaveBeenCalledWith("current");
      expect(useStore.getState().runtimeSessions.map((session) => session.sessionId)).toEqual([
        "older",
      ]);
    });
    expect(connectSessionMock).not.toHaveBeenCalled();
  });
});
