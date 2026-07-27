// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import type { PiSessionInfo } from "../types.js";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { uiCopy } from "../ui-copy.js";
import { ChatView } from "./ChatView.js";

vi.mock("@lobehub/ui/es/ThemeProvider/ThemeProvider", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="message-feed">{sessionId}</div>
  ),
}));

vi.mock("./Composer.js", () => ({
  Composer: ({ sessionId }: { sessionId: string }) => <div data-testid="composer">{sessionId}</div>,
}));

vi.mock("./InteractionCard.js", () => ({
  InteractionCard: ({
    interaction,
  }: {
    interaction: { id: string; kind: string; prompt?: string };
  }) => <div data-testid={`interaction-${interaction.id}`}>{interaction.kind}</div>,
}));

vi.mock("./BrowserBridgePanel.js", () => ({
  BrowserBridgePanel: () => <div data-testid="browser-bridge" />,
}));

vi.mock("./KeyboardShortcutsDialog.js", () => ({
  KeyboardShortcutsDialog: () => null,
}));

vi.mock("./chat-view/AgentSessionSelector.js", () => ({
  AgentSessionSelector: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="agent-selector">{sessionId}</div>
  ),
}));

vi.mock("./UserSpaceExplorer.js", () => ({
  UserSpaceExplorer: () => <div data-testid="user-space-explorer" />,
}));

vi.mock("./UserSettingsDialog.js", () => ({
  UserSettingsDialog: ({
    archivedSessions,
    selectedArchivedSessionIds,
    onSetAllArchivedSessionSelection,
    onRestoreArchivedSession,
    onRestoreSelectedArchivedSessions,
  }: {
    archivedSessions: PiSessionInfo[];
    selectedArchivedSessionIds: Set<string>;
    onSetAllArchivedSessionSelection: (checked: boolean) => void;
    onRestoreArchivedSession: (sessionId: string) => void | Promise<void>;
    onRestoreSelectedArchivedSessions: () => void | Promise<void>;
  }) => (
    <div data-testid="user-settings-dialog">
      <span data-testid="selected-count">{selectedArchivedSessionIds.size}</span>
      {archivedSessions.map((session) => (
        <button
          type="button"
          key={session.sessionId}
          data-testid={`restore-${session.sessionId}`}
          onClick={() => void onRestoreArchivedSession(session.sessionId)}
        >
          restore {session.sessionId}
        </button>
      ))}
      <button
        type="button"
        data-testid="select-all-archived"
        onClick={() => onSetAllArchivedSessionSelection(true)}
      >
        select all
      </button>
      <button
        type="button"
        data-testid="restore-selected-archived"
        onClick={() => void onRestoreSelectedArchivedSessions()}
      >
        restore selected
      </button>
    </div>
  ),
}));

vi.mock("../user-space.js", () => ({
  attachUserSpaceMountsToSession: vi.fn(),
  detachUserSpaceFromSession: vi.fn(),
  resendSessionUserSpaces: vi.fn(),
  restorePersistedUserSpaces: vi.fn(async () => []),
}));

vi.mock("../ws.js", () => ({
  disconnectAll: vi.fn(),
}));

vi.mock("../workspace-session-state.js", () => ({
  persistWorkspaceSessionStateNow: vi.fn(),
}));

vi.mock("../preferences-persistence.js", () => ({
  savePreferencesLatest: vi.fn(),
}));

vi.mock("../user-space-configuration.js", () => ({
  captureUserSpaceConfigurationContext: vi.fn(() => null),
  configureUserSpaceLatest: vi.fn(),
}));

const archivedOne: PiSessionInfo = {
  sessionId: "archived-1",
  state: "exited",
  lifecycleState: "closed",
  transport: "pi-rpc",
  cwd: "/workspace",
  createdAt: 10,
  archived: true,
  archivedAt: 20,
  name: "Archived topic",
  backendType: "pi",
};

function seedChatState(): void {
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
      permissions: [],
      tenantId: "tenant-1",
    },
    preferencesLoaded: true,
    runtimeSessions: [
      {
        sessionId: "session-live",
        state: "connected",
        transport: "pi-rpc",
        cwd: "/workspace",
        createdAt: 1,
        backendType: "pi",
      },
    ],
  });
  useStore.getState().addInteraction("session-live", {
    id: "ask-live",
    kind: "ask",
    toolCallId: "tool-ask",
    questions: [
      {
        id: "question-0",
        question: "Choose",
        options: [],
        allowMultiple: false,
        allowFreeText: true,
      },
    ],
  });
}

async function openArchivedSettings(): Promise<void> {
  fireEvent.click(screen.getByTestId("user-avatar-button"));
  fireEvent.click(screen.getByRole("button", { name: uiCopy.chat.preferences }));
  await screen.findByTestId("restore-archived-1");
}

beforeEach(() => {
  vi.restoreAllMocks();
  seedChatState();
  vi.spyOn(api, "listArchivedSessions").mockResolvedValue({
    sessions: [archivedOne],
    total: 1,
    cursor: 0,
    nextCursor: 1,
    hasMore: false,
  });
  vi.spyOn(api, "unarchiveSession").mockResolvedValue({
    ok: true,
    session: { ...archivedOne, archived: false },
  });
});

afterEach(() => {
  useStore.getState().reset();
});

describe("ChatView native Pi runtime projections", () => {
  it("renders pending Pi interactions and restores one archived session", async () => {
    render(<ChatView sessionId="session-live" />);

    expect(screen.getByTestId("message-feed")).toHaveTextContent("session-live");
    expect(screen.getByTestId("interaction-ask-live")).toHaveTextContent("ask");
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();

    await openArchivedSettings();
    fireEvent.click(screen.getByTestId("restore-archived-1"));

    await waitFor(() => {
      expect(api.unarchiveSession).toHaveBeenCalledWith("archived-1");
      expect(
        useStore.getState().runtimeSessions.find((session) => session.sessionId === "archived-1"),
      ).toMatchObject({ archived: false });
    });
  });

  it("batch restores selected archived sessions into the live runtime list", async () => {
    render(<ChatView sessionId="session-live" />);
    await openArchivedSettings();

    fireEvent.click(screen.getByTestId("select-all-archived"));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("restore-selected-archived"));

    await waitFor(() => {
      expect(api.unarchiveSession).toHaveBeenCalledWith("archived-1");
      expect(useStore.getState().runtimeSessions.map((session) => session.sessionId)).toEqual([
        "archived-1",
        "session-live",
      ]);
    });
  });
});
