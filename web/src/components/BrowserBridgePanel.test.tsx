// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { AgentBrowserBridgeStatus, BrowserControlState } from "../types.js";
import { setUiCopyLanguage, uiCopy } from "../ui-copy.js";

const mockApi = vi.hoisted(() => ({
  getBrowserBridgeStatus: vi.fn(),
  startBrowserBridge: vi.fn(),
  verifyBrowserBridge: vi.fn(),
  getBrowserControl: vi.fn(),
  takeOverBrowserControl: vi.fn(),
  resumeBrowserControl: vi.fn(),
  stopBrowserControl: vi.fn(),
}));

vi.mock("../api.js", () => ({ api: mockApi }));

vi.mock("@heroui/react", () => {
  const Modal = Object.assign(
    ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
      isOpen ? <>{children}</> : null,
    {
      Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Container: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
      Header: ({ children }: { children: ReactNode }) => <header>{children}</header>,
      Body: ({ children }: { children: ReactNode }) => <main>{children}</main>,
      Footer: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
      Heading: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      CloseTrigger: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
        <button type="button" {...props}>
          {children}
        </button>
      ),
    },
  );
  const Card = Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  });
  const Button = ({
    children,
    onPress,
    isDisabled,
    isIconOnly: _isIconOnly,
    isPending: _isPending,
    ...props
  }: {
    children: ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type="button" disabled={isDisabled} onClick={onPress} {...props}>
      {children}
    </button>
  );
  const Surface = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  );
  const TextField = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <label {...props}>{children}</label>
  );
  const Label = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <span {...props}>{children}</span>
  );
  const TextArea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  );
  const Description = ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => (
    <span {...props}>{children}</span>
  );
  const FieldError = Description;
  return { Button, Card, Modal, Surface, TextField, Label, TextArea, Description, FieldError };
});

import { BrowserBridgePanel } from "./BrowserBridgePanel.js";

function bridgeStatus(phase: AgentBrowserBridgeStatus["phase"]): AgentBrowserBridgeStatus {
  const connected = phase === "connected";
  return {
    schemaVersion: 1,
    phase,
    runtime: {
      ready: phase !== "unavailable",
      version: "0.31.1",
      sourceCommit: "abf04f20132a6d61c2ea8b2fed02cd3243ff5b43",
      missing: phase === "unavailable" ? ["Chrome extension manifest"] : [],
    },
    daemon: {
      state: phase === "stopped" || phase === "unavailable" ? "offline" : "online",
      port: 19826,
      version: "0.31.1",
      protocolVersion: 1,
      sessionCount: connected ? 1 : 0,
    },
    extension: {
      connected,
      path: "/repo/agent-browser/packages/@agent-browser/chrome-extension-provider/.output/chrome-mv3",
      profiles: connected ? [{ profileId: "profile-1", chromeVersion: "126", tabCount: 2 }] : [],
    },
  };
}

function controlState(
  phase: BrowserControlState["phase"],
  overrides: Partial<BrowserControlState> = {},
): BrowserControlState {
  return {
    schemaVersion: 1,
    sessionId: "session-a",
    phase,
    epoch: 1,
    updatedAt: 100,
    reason: "test",
    pendingActionRisk: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setUiCopyLanguage("zh-CN");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  mockApi.getBrowserControl.mockResolvedValue(controlState("agent"));
});

describe("BrowserBridgePanel", () => {
  it("does not keep polling while the bridge panel is closed", async () => {
    vi.useFakeTimers();
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("connected"));

    try {
      render(<BrowserBridgePanel />);
      await act(async () => undefined);
      expect(mockApi.getBrowserBridgeStatus).toHaveBeenCalledOnce();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mockApi.getBrowserBridgeStatus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses open-panel polling while the document is hidden", async () => {
    vi.useFakeTimers();
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("connected"));

    try {
      render(<BrowserBridgePanel />);
      await act(async () => undefined);
      fireEvent.click(screen.getByTestId("browser-bridge-trigger"));
      await act(async () => undefined);
      const visibleCalls = mockApi.getBrowserBridgeStatus.mock.calls.length;

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mockApi.getBrowserBridgeStatus).toHaveBeenCalledTimes(visibleCalls);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => undefined);
      expect(mockApi.getBrowserBridgeStatus).toHaveBeenCalledTimes(visibleCalls + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the bridge and shows extension setup guidance", async () => {
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("stopped"));
    mockApi.startBrowserBridge.mockResolvedValue(bridgeStatus("waiting_for_extension"));

    render(<BrowserBridgePanel />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText(uiCopy.browserBridge.stopped)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.start }));

    await waitFor(() => expect(mockApi.startBrowserBridge).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(uiCopy.browserBridge.waiting)).toBeInTheDocument();
    expect(screen.getByText(uiCopy.browserBridge.setupTitle)).toBeInTheDocument();
    expect(screen.getByText(uiCopy.browserBridge.stepOne)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.copyPath }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        bridgeStatus("waiting_for_extension").extension.path,
      ),
    );
    expect(await screen.findByLabelText(uiCopy.browserBridge.pathCopied)).toBeInTheDocument();
  });

  it("uses the standard Piwork dialog hierarchy instead of nested content cards", async () => {
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("stopped"));

    render(<BrowserBridgePanel sessionId="session-a" />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    const statusSection = await screen.findByTestId("browser-bridge-status-section");
    const controlSection = screen.getByTestId("browser-control-section");
    const setupSection = screen.getByTestId("browser-bridge-setup-section");
    const summary = screen.getByTestId("browser-bridge-status-summary");

    expect(statusSection).toContainElement(summary);
    expect(summary.tagName).toBe("DL");
    expect(summary.querySelectorAll("dt")).toHaveLength(3);
    expect(summary.querySelectorAll("dd")).toHaveLength(6);
    expect(controlSection).toHaveClass("border-t", "border-border", "pt-5");
    expect(setupSection).toHaveClass("border-t", "border-border", "pt-5");
  });

  it("renders the normalized dialog hierarchy with English copy", async () => {
    setUiCopyLanguage("en-US");
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("connected"));

    render(<BrowserBridgePanel sessionId="session-a" />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current session control" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify connection" })).toBeInTheDocument();
    expect(screen.getByText("1 Chrome profiles connected")).toBeInTheDocument();
  });

  it("shows unavailable runtime diagnostics and refreshes on demand", async () => {
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("unavailable"));

    render(<BrowserBridgePanel />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    expect(await screen.findByText(uiCopy.browserBridge.unavailable)).toBeInTheDocument();
    expect(screen.getByText(/Chrome extension manifest/)).toBeInTheDocument();
    const beforeRefresh = mockApi.getBrowserBridgeStatus.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.refresh }));
    await waitFor(() =>
      expect(mockApi.getBrowserBridgeStatus).toHaveBeenCalledTimes(beforeRefresh + 1),
    );
  });

  it("verifies a connected Chrome bridge", async () => {
    const connected = bridgeStatus("connected");
    mockApi.getBrowserBridgeStatus.mockResolvedValue(connected);
    mockApi.verifyBrowserBridge.mockResolvedValue({
      ok: true,
      durationMs: 42,
      probe: "active_tab_url",
      status: connected,
    });

    render(<BrowserBridgePanel />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    expect(await screen.findByText(uiCopy.browserBridge.connected)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.verify }));

    await waitFor(() => expect(mockApi.verifyBrowserBridge).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(uiCopy.browserBridge.verifySuccess(42))).toBeInTheDocument();
    expect(screen.getByText(uiCopy.browserBridge.connectedProfiles(1))).toBeInTheDocument();
    expect(screen.getByText(uiCopy.browserBridge.tabs(2))).toBeInTheDocument();
  });

  it("fences Agent actions during takeover and requires a handoff summary before resume", async () => {
    mockApi.getBrowserBridgeStatus.mockResolvedValue(bridgeStatus("connected"));
    mockApi.takeOverBrowserControl.mockResolvedValue(controlState("human", { epoch: 2 }));
    mockApi.resumeBrowserControl.mockResolvedValue(
      controlState("agent", {
        epoch: 3,
        lastHandoff: { summary: "Completed MFA", resumedAt: 101 },
      }),
    );
    mockApi.stopBrowserControl.mockResolvedValue(controlState("stopped", { epoch: 4 }));

    render(<BrowserBridgePanel sessionId="session-a" />);
    fireEvent.click(screen.getByTestId("browser-bridge-trigger"));

    expect(await screen.findByText(uiCopy.browserBridge.agentControl)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.takeOver }));
    expect(await screen.findByText(uiCopy.browserBridge.humanControl)).toBeInTheDocument();

    const summary = screen.getByPlaceholderText(uiCopy.browserBridge.handoffPlaceholder);
    const resume = screen.getByRole("button", { name: uiCopy.browserBridge.resumeControl });
    expect(resume).toBeDisabled();
    fireEvent.change(summary, { target: { value: "Completed MFA" } });
    expect(resume).toBeEnabled();
    fireEvent.click(resume);

    await waitFor(() =>
      expect(mockApi.resumeBrowserControl).toHaveBeenCalledWith("session-a", "Completed MFA"),
    );
    expect(await screen.findByText(uiCopy.browserBridge.agentControl)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: uiCopy.browserBridge.stopControl }));
    expect(await screen.findByText(uiCopy.browserBridge.stoppedControl)).toBeInTheDocument();
  });
});
