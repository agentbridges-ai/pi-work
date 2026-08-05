// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  api,
  ApiError,
  type AppCloudflareBrowserConfig,
  type AppCloudflareConnection,
  type AppDeployment,
  type AppDeploymentEvent,
  type CurrentUser,
  type PublishedApp,
  type PublishedAppSummary,
} from "../api.js";
import { runtimeContextCoordinator } from "../runtime-context.js";
import { useStore } from "../store.js";
import { userScopeKeyFromCurrentUser } from "../store/user-scoped-storage.js";
import { setUiCopyLanguage, uiCopy } from "../ui-copy.js";
import { AppsPage } from "./AppsPage.js";

const userA: CurrentUser = {
  userId: "user-a",
  uuid: "user-a",
  username: "alice@example.com",
  displayName: "Alice",
  orgId: "tenant-a",
  orgName: "Tenant A",
  roles: [],
  tenantId: "tenant-a",
  membershipId: "membership-a",
};

function summary(overrides: Partial<PublishedAppSummary> = {}): PublishedAppSummary {
  return {
    id: "app-a",
    tenantId: "tenant-a",
    ownerUserId: "user-a",
    ownerDisplayName: "Alice",
    sourceSessionId: "session-a",
    slug: "demo",
    displayName: "演示应用",
    status: "needs_action",
    stableUrl: null,
    latestDeploymentNumber: 2,
    latestDeploymentId: "deployment-2",
    targetKind: "unassigned",
    cloudflareConnectionId: null,
    canManage: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<PublishedApp> = {}): PublishedApp {
  return {
    ...summary(),
    customDomain: null,
    ...overrides,
  };
}

function deployment(overrides: Partial<AppDeployment> = {}): AppDeployment {
  return {
    id: "deployment-2",
    appId: "app-a",
    number: 2,
    phase: "awaiting_target",
    targetKind: "unassigned",
    sourceDigest: "digest-2",
    stableUrl: null,
    requestedCustomDomain: null,
    temporaryPreview: null,
    createdByUserId: "user-a",
    createdAt: "2026-08-02T00:00:00.000Z",
    current: true,
    ...overrides,
  };
}

function event(overrides: Partial<AppDeploymentEvent> = {}): AppDeploymentEvent {
  return {
    id: "event-1",
    deploymentId: "deployment-2",
    phase: "building",
    timestamp: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function activate(user: CurrentUser, sessionId = "session-a") {
  runtimeContextCoordinator.activate({
    userId: user.uuid || user.userId,
    userScopeKey: userScopeKeyFromCurrentUser(user),
    agentId: "agent",
    sessionId,
  });
  useStore.setState({
    authInitialized: true,
    isAuthenticated: true,
    currentUser: user,
    currentSessionId: sessionId,
    selectedAgentId: "agent",
    uiLanguage: "zh-CN",
  });
}

function mockDetails(input: {
  app?: PublishedApp;
  deployment?: AppDeployment;
  events?: AppDeploymentEvent[];
  connections?: AppCloudflareConnection[];
  config?: AppCloudflareBrowserConfig;
}) {
  const app = input.app || detail();
  const currentDeployment = input.deployment || deployment();
  vi.spyOn(api, "listApps").mockResolvedValue({ apps: [app], nextCursor: null });
  vi.spyOn(api, "getApp").mockResolvedValue({ app });
  vi.spyOn(api, "listAppVersions").mockResolvedValue({
    versions: [currentDeployment],
    nextCursor: null,
  });
  vi.spyOn(api, "getAppDeployment").mockResolvedValue({ deployment: currentDeployment });
  vi.spyOn(api, "getAppDeploymentEvents").mockResolvedValue({ events: input.events || [] });
  vi.spyOn(api, "listCloudflareConnections").mockResolvedValue({
    connections: input.connections || [],
  });
  vi.spyOn(api, "getCloudflareConfig").mockResolvedValue(
    input.config || {
      temporaryEnabled: true,
      byocEnabled: true,
      turnstileEnabled: false,
      siteKey: null,
    },
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await runtimeContextCoordinator.dispose();
  useStore.getState().reset();
  setUiCopyLanguage("zh-CN");
  activate(userA);
});

afterEach(async () => {
  delete window.turnstile;
  document.getElementById("piwork-cloudflare-turnstile")?.remove();
  window.history.replaceState({}, "", "/");
  useStore.getState().reset();
  await runtimeContextCoordinator.dispose();
  setUiCopyLanguage("en-US");
});

describe("AppsPage", () => {
  it("lists Apps with only the BYOC/Temporary product copy and follows live language changes", async () => {
    vi.spyOn(api, "listApps").mockResolvedValue({ apps: [summary()], nextCursor: null });

    render(<AppsPage />);

    expect(await screen.findByText("演示应用")).toBeInTheDocument();
    expect(
      screen.getByText(
        "将 Agent 结果发布到你的 Cloudflare 账户，或创建一次性 Temporary Account 预览。",
      ),
    ).toBeInTheDocument();
    expect(api.listApps).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "current-session", sessionId: "session-a" }),
      expect.objectContaining({
        contextEpoch: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );

    act(() => {
      setUiCopyLanguage("en-US");
      useStore.setState({ uiLanguage: "en-US" });
    });
    expect(
      await screen.findByText(
        "Publish Agent results to your Cloudflare account or create a one-time Temporary Account preview.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Visibility")).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime logs")).not.toBeInTheDocument();
  });

  it("presents archived Apps as unlinked while Cloudflare resources remain", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    vi.spyOn(api, "listApps").mockResolvedValue({
      apps: [
        summary({
          status: "archived",
          targetKind: "byoc",
          stableUrl: "https://demo.example.workers.dev",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      nextCursor: null,
    });

    render(<AppsPage />);

    expect(await screen.findByText(uiCopy.apps.archivedResourcesRemain)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: uiCopy.apps.open })).toHaveAttribute(
      "href",
      "https://demo.example.workers.dev",
    );
    expect(screen.queryByText("Delete App")).not.toBeInTheDocument();
  });

  it("does not commit a stale tenant response after the runtime context changes", async () => {
    let resolveOld!: (value: { apps: PublishedAppSummary[]; nextCursor: null }) => void;
    let resolveNew!: (value: { apps: PublishedAppSummary[]; nextCursor: null }) => void;
    const oldPage = new Promise<{ apps: PublishedAppSummary[]; nextCursor: null }>((resolve) => {
      resolveOld = resolve;
    });
    const newPage = new Promise<{ apps: PublishedAppSummary[]; nextCursor: null }>((resolve) => {
      resolveNew = resolve;
    });
    vi.spyOn(api, "listApps").mockReturnValueOnce(oldPage).mockReturnValueOnce(newPage);

    render(<AppsPage />);
    await waitFor(() => expect(api.listApps).toHaveBeenCalledTimes(1));

    const userB: CurrentUser = {
      ...userA,
      orgId: "tenant-b",
      orgName: "Tenant B",
      tenantId: "tenant-b",
      membershipId: "membership-b",
    };
    act(() => activate(userB, "session-b"));
    await waitFor(() => expect(api.listApps).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNew({
        apps: [
          summary({
            id: "app-b",
            tenantId: "tenant-b",
            sourceSessionId: "session-b",
            displayName: "新租户应用",
          }),
        ],
        nextCursor: null,
      });
    });
    expect(await screen.findByText("新租户应用")).toBeInTheDocument();

    await act(async () => {
      resolveOld({ apps: [summary({ displayName: "旧租户应用" })], nextCursor: null });
    });
    expect(screen.queryByText("旧租户应用")).not.toBeInTheDocument();
    expect(screen.getByText("新租户应用")).toBeInTheDocument();
  });

  it("does not commit an action result after switching Apps while it is pending", async () => {
    const appA = detail({ id: "app-a", displayName: "应用 A" });
    const appB = detail({
      id: "app-b",
      displayName: "应用 B",
      latestDeploymentId: "deployment-b",
      sourceSessionId: "session-b",
    });
    const deploymentA = deployment({ id: "deployment-a", appId: "app-a" });
    const deploymentB = deployment({ id: "deployment-b", appId: "app-b" });
    let resolveArchive!: (value: { app: PublishedApp }) => void;
    vi.spyOn(api, "listApps").mockResolvedValue({
      apps: [appA, appB],
      nextCursor: null,
    });
    vi.spyOn(api, "getApp").mockImplementation(async (appId) => ({
      app: appId === "app-b" ? appB : appA,
    }));
    vi.spyOn(api, "listAppVersions").mockImplementation(async (appId) => ({
      versions: [appId === "app-b" ? deploymentB : deploymentA],
      nextCursor: null,
    }));
    vi.spyOn(api, "getAppDeployment").mockImplementation(async (deploymentId) => ({
      deployment: deploymentId === "deployment-b" ? deploymentB : deploymentA,
    }));
    vi.spyOn(api, "getAppDeploymentEvents").mockResolvedValue({ events: [] });
    vi.spyOn(api, "listCloudflareConnections").mockResolvedValue({ connections: [] });
    vi.spyOn(api, "getCloudflareConfig").mockResolvedValue({
      temporaryEnabled: true,
      byocEnabled: true,
      turnstileEnabled: false,
      siteKey: null,
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const archive = vi.spyOn(api, "archiveApp").mockReturnValue(
      new Promise((resolve) => {
        resolveArchive = resolve;
      }),
    );

    render(<AppsPage />);
    const user = userEvent.setup();
    const manageButtons = await screen.findAllByRole("button", { name: uiCopy.apps.manage });
    await user.click(manageButtons[0]);
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.archive }));
    expect(archive).toHaveBeenCalledWith(
      "app-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await user.click(screen.getByRole("button", { name: uiCopy.apps.closeDetails }));
    await user.click((await screen.findAllByRole("button", { name: uiCopy.apps.manage }))[1]);
    expect(await screen.findByText("应用 B")).toBeInTheDocument();

    await act(async () => {
      resolveArchive({ app: { ...appA, status: "archived" } });
    });
    expect(screen.getByText("应用 B")).toBeInTheDocument();
    expect(screen.queryByText(uiCopy.apps.archived)).not.toBeInTheDocument();
  });

  it("requires both Cloudflare policy confirmations before selecting a Temporary target", async () => {
    const currentDeployment = deployment();
    mockDetails({ deployment: currentDeployment });
    const selectTarget = vi.spyOn(api, "selectAppDeploymentTarget").mockResolvedValue({
      deployment: deployment({ phase: "queued", targetKind: "temporary" }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    const submit = await screen.findByRole("button", { name: uiCopy.apps.deployToTarget });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflareTerms }));
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflarePrivacy }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(selectTarget).toHaveBeenCalledWith(
        "deployment-2",
        {
          target: "temporary",
          termsAcceptance: {
            acceptedTermsOfService: true,
            acceptedPrivacyPolicy: true,
          },
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    expect(await screen.findByText(uiCopy.apps.targetSelected)).toBeInTheDocument();
    expect(screen.queryByLabelText(uiCopy.apps.turnstile.label)).not.toBeInTheDocument();
  });

  it("exposes only the Temporary target when browser config enables Temporary alone", async () => {
    mockDetails({
      config: {
        temporaryEnabled: true,
        byocEnabled: false,
        turnstileEnabled: false,
        siteKey: null,
      },
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    expect(await screen.findByText(uiCopy.apps.temporaryTarget)).toBeInTheDocument();
    expect(screen.queryByText(uiCopy.apps.byocTarget)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: uiCopy.apps.connectCloudflare }),
    ).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: uiCopy.apps.deployToTarget });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflareTerms }));
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflarePrivacy }));
    expect(submit).toBeEnabled();
  });

  it("exposes only BYOC and submits BYOC when browser config disables Temporary", async () => {
    const connection: AppCloudflareConnection = {
      id: "connection-active",
      accountId: "account-active",
      accountName: "Alice Cloudflare",
      scope: "user",
      status: "active",
    };
    mockDetails({
      connections: [connection],
      config: {
        temporaryEnabled: false,
        byocEnabled: true,
        turnstileEnabled: false,
        siteKey: null,
      },
    });
    const selectTarget = vi.spyOn(api, "selectAppDeploymentTarget").mockResolvedValue({
      deployment: deployment({ phase: "queued", targetKind: "byoc" }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    expect(await screen.findByText(uiCopy.apps.byocTarget)).toBeInTheDocument();
    expect(screen.queryByText(uiCopy.apps.temporaryTarget)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: uiCopy.apps.acceptCloudflareTerms }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: uiCopy.apps.deployToTarget }));
    await waitFor(() =>
      expect(selectTarget).toHaveBeenCalledWith(
        "deployment-2",
        { target: "byoc", connectionId: "connection-active" },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
  });

  it("blocks target submission and offers a return action when all deployment targets are off", async () => {
    mockDetails({
      config: {
        temporaryEnabled: false,
        byocEnabled: false,
        turnstileEnabled: false,
        siteKey: null,
      },
    });
    const continueDevelopment = vi.spyOn(api, "continueAppDevelopment").mockResolvedValue({
      sessionId: "session-a",
      restoredFromSnapshot: false,
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    expect(await screen.findByText(uiCopy.apps.deploymentTargetsUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(uiCopy.apps.temporaryTarget)).not.toBeInTheDocument();
    expect(screen.queryByText(uiCopy.apps.byocTarget)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: uiCopy.apps.deployToTarget }),
    ).not.toBeInTheDocument();

    act(() => {
      setUiCopyLanguage("en-US");
      useStore.setState({ uiLanguage: "en-US" });
    });
    expect(await screen.findByText(uiCopy.apps.deploymentTargetsUnavailable)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: uiCopy.apps.deploymentTargetsUnavailableAction }),
    );
    await waitFor(() =>
      expect(continueDevelopment).toHaveBeenCalledWith(
        "app-a",
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
  });

  it("requires an in-memory Turnstile token and submits it with Temporary terms acceptance", async () => {
    const currentDeployment = deployment();
    mockDetails({ deployment: currentDeployment });
    vi.mocked(api.getCloudflareConfig).mockResolvedValue({
      temporaryEnabled: true,
      byocEnabled: true,
      turnstileEnabled: true,
      siteKey: "site-key-public",
    });
    let options:
      | {
          sitekey: string;
          action: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
        }
      | undefined;
    const remove = vi.fn();
    const reset = vi.fn();
    const renderTurnstile = vi.fn((_container, nextOptions) => {
      options = nextOptions;
      return "widget-1";
    });
    window.turnstile = { render: renderTurnstile, remove, reset };
    const selectTarget = vi.spyOn(api, "selectAppDeploymentTarget").mockResolvedValue({
      deployment: deployment({ phase: "queued", targetKind: "temporary" }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflareTerms }));
    await user.click(screen.getByRole("checkbox", { name: uiCopy.apps.acceptCloudflarePrivacy }));

    const submit = await screen.findByRole("button", { name: uiCopy.apps.deployToTarget });
    expect(submit).toBeDisabled();
    await waitFor(() => expect(renderTurnstile).toHaveBeenCalledTimes(1));
    expect(options).toMatchObject({ sitekey: "site-key-public", action: "temporary-preview" });
    act(() => options?.["error-callback"]());
    expect(await screen.findByText(uiCopy.apps.turnstile.failed)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("button", { name: uiCopy.apps.turnstile.retry }));
    await waitFor(() => expect(renderTurnstile).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenCalledWith("widget-1");
    act(() => options?.callback("turnstile-token-memory-only"));
    expect(await screen.findByText(uiCopy.apps.turnstile.verified)).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(selectTarget).toHaveBeenCalledWith(
        "deployment-2",
        {
          target: "temporary",
          termsAcceptance: {
            acceptedTermsOfService: true,
            acceptedPrivacyPolicy: true,
            turnstileToken: "turnstile-token-memory-only",
          },
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith("widget-1"));
    expect(screen.queryByText("turnstile-token-memory-only")).not.toBeInTheDocument();
  });

  it("does not render a late Turnstile config after the runtime context changes", async () => {
    mockDetails({ deployment: deployment() });
    let resolveConfig!: (value: {
      temporaryEnabled: boolean;
      byocEnabled: boolean;
      turnstileEnabled: boolean;
      siteKey: string | null;
    }) => void;
    vi.mocked(api.getCloudflareConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    const renderTurnstile = vi.fn(() => "widget-stale");
    window.turnstile = { render: renderTurnstile, remove: vi.fn(), reset: vi.fn() };

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    await waitFor(() => expect(api.getCloudflareConfig).toHaveBeenCalledTimes(1));

    const userB: CurrentUser = {
      ...userA,
      orgId: "tenant-b",
      orgName: "Tenant B",
      tenantId: "tenant-b",
      membershipId: "membership-b",
    };
    act(() => activate(userB, "session-b"));
    await act(async () => {
      resolveConfig({
        temporaryEnabled: true,
        byocEnabled: true,
        turnstileEnabled: true,
        siteKey: "stale-site-key",
      });
    });

    expect(renderTurnstile).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(uiCopy.apps.turnstile.label)).not.toBeInTheDocument();
  });

  it("shows OAuth denial without starting an unbound fallback authorization", async () => {
    window.history.replaceState({}, "", "/apps?cloudflare=denied");
    vi.spyOn(api, "listApps").mockResolvedValue({ apps: [summary()], nextCursor: null });
    const startOAuth = vi.spyOn(api, "startCloudflareOAuth");

    render(<AppsPage />);

    expect(await screen.findByText(uiCopy.apps.oauthCancelled)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: uiCopy.apps.connectCloudflare }),
    ).not.toBeInTheDocument();
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it("renders complete deployment phases, owner-only claim URL, and both expiry countdowns", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    const app = detail({
      status: "preview",
      targetKind: "temporary",
      stableUrl: "https://demo.example.workers.dev",
    });
    const currentDeployment = deployment({
      phase: "temporary_ready",
      targetKind: "temporary",
      stableUrl: "https://demo.example.workers.dev",
      temporaryPreview: {
        id: "preview-1",
        expiresAt: "2099-08-02T01:00:00.000Z",
        claimExpiresAt: "2099-08-02T00:30:00.000Z",
        claimAvailable: true,
      },
    });
    mockDetails({
      app,
      deployment: currentDeployment,
      events: [
        event({ phase: "building" }),
        event({ id: "event-2", phase: "temporary_ready", timestamp: "2026-08-02T00:01:00Z" }),
        event({ id: "event-3", phase: "claim_pending", timestamp: "2026-08-02T00:02:00Z" }),
      ],
    });
    const startOAuth = vi
      .spyOn(api, "startCloudflareOAuth")
      .mockReturnValue(new Promise<never>(() => undefined));

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    const claim = await screen.findByRole("link", { name: uiCopy.apps.claimTemporaryPreview });
    expect(claim).toHaveAttribute("href", "/api/apps/deployments/deployment-2/claim");
    await user.click(claim);
    await user.click(
      await screen.findByRole("button", { name: uiCopy.apps.claimThenConnectCloudflare }),
    );
    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith(
        {
          returnPath: "/",
          deploymentId: "deployment-2",
          purpose: "claim",
          temporaryPreviewId: "preview-1",
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    expect(screen.getByText(/Preview time remaining:/)).toBeInTheDocument();
    expect(screen.getByText(/Claim link time remaining:/)).toBeInTheDocument();
    expect(screen.getAllByText(uiCopy.apps.phase.building).length).toBeGreaterThan(0);
    expect(screen.getAllByText(uiCopy.apps.phase.temporary_ready).length).toBeGreaterThan(0);
    expect(screen.getAllByText(uiCopy.apps.phase.claim_pending).length).toBeGreaterThan(0);

    act(() => {
      setUiCopyLanguage("zh-CN");
      useStore.setState({ uiLanguage: "zh-CN" });
    });
    expect(await screen.findByText("在 Cloudflare 认领此预览")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "认领后连接 Cloudflare" })).toBeInTheDocument();
    expect(screen.getByText(/预览剩余时间：/)).toBeInTheDocument();
  });

  it("does not expose a claim action while OAuth BYOC is disabled", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    mockDetails({
      app: detail({ status: "preview", targetKind: "temporary" }),
      deployment: deployment({
        phase: "claim_pending",
        targetKind: "temporary",
        temporaryPreview: {
          id: "preview-1",
          expiresAt: "2099-08-02T01:00:00.000Z",
          claimExpiresAt: "2099-08-02T00:30:00.000Z",
          claimAvailable: true,
        },
      }),
      config: {
        temporaryEnabled: true,
        byocEnabled: false,
        turnstileEnabled: false,
        siteKey: null,
      },
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    expect(await screen.findByText(uiCopy.apps.claimRequiresByoc)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: uiCopy.apps.claimTemporaryPreview }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: uiCopy.apps.claimThenConnectCloudflare }),
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "account mismatch",
      value: deployment({ phase: "failed", errorCode: "temporary_account_mismatch" }),
      message: "oauthAccountMismatch" as const,
      action: "chooseClaimedAccount" as const,
    },
    {
      name: "OAuth cancellation",
      value: deployment({ phase: "awaiting_oauth", errorCode: "oauth_cancelled" }),
      message: "oauthCancelled" as const,
      action: "retryOAuth" as const,
    },
    {
      name: "Temporary expiry",
      value: deployment({ phase: "expired", errorCode: "temporary_expired" }),
      message: "temporaryExpired" as const,
      action: "createNewTemporaryPreview" as const,
    },
    {
      name: "retryable deployment failure",
      value: deployment({ phase: "failed", errorCode: "provider_failed" }),
      message: "deploymentFailed" as const,
      action: "retryDeployment" as const,
    },
  ])("offers a fail-closed recovery action for $name", async ({ value, message, action }) => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    mockDetails({ deployment: value });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));

    expect(await screen.findByText(uiCopy.apps[message])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: uiCopy.apps[action] })).toBeInTheDocument();
    if (message === "oauthAccountMismatch") {
      expect(
        screen.getByRole("button", { name: uiCopy.apps.redeployToAnotherAccount }),
      ).toBeInTheDocument();
    }
  });

  it("selects an active BYOC account and does not expose revoked connections", async () => {
    const connections: AppCloudflareConnection[] = [
      {
        id: "connection-active",
        accountId: "account-active",
        accountName: "Alice Cloudflare",
        scope: "user",
        status: "active",
      },
      {
        id: "connection-revoked",
        accountId: "account-revoked",
        accountName: "Old Cloudflare",
        scope: "user",
        status: "revoked",
      },
    ];
    mockDetails({ connections });
    const selectTarget = vi.spyOn(api, "selectAppDeploymentTarget").mockResolvedValue({
      deployment: deployment({ phase: "queued", targetKind: "byoc" }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    await user.click(await screen.findByText(uiCopy.apps.byocTarget));

    expect(screen.getByRole("option", { name: /Alice Cloudflare/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Old Cloudflare/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: uiCopy.apps.deployToTarget }));
    await waitFor(() =>
      expect(selectTarget).toHaveBeenCalledWith(
        "deployment-2",
        { target: "byoc", connectionId: "connection-active" },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
  });

  it("offers incremental OAuth after BYOC scope preflight fails", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    const connections: AppCloudflareConnection[] = [
      {
        id: "connection-active",
        accountId: "account-active",
        accountName: "Alice Cloudflare",
        scope: "user",
        status: "active",
      },
    ];
    mockDetails({ connections });
    vi.spyOn(api, "selectAppDeploymentTarget").mockRejectedValue(
      new ApiError({
        category: "conflict",
        code: "needs_oauth",
        status: 409,
        requestId: "request-1",
        message: "Cloudflare account needs additional OAuth permissions.",
        requiredPermissionNames: ["Workers Scripts Write", "D1 Write"],
      }),
    );
    const startOAuth = vi
      .spyOn(api, "startCloudflareOAuth")
      .mockReturnValue(new Promise<never>(() => undefined));

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    await user.click(await screen.findByText(uiCopy.apps.byocTarget));
    await user.click(screen.getByRole("button", { name: uiCopy.apps.deployToTarget }));

    expect(
      await screen.findByText(
        uiCopy.apps.additionalOAuthPermissionsRequired(["Workers Scripts Write", "D1 Write"]),
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: uiCopy.apps.connectCloudflare }));
    await waitFor(() =>
      expect(startOAuth).toHaveBeenCalledWith(
        {
          returnPath: "/",
          deploymentId: "deployment-2",
          purpose: "direct",
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );

    act(() => {
      setUiCopyLanguage("zh-CN");
      useStore.setState({ uiLanguage: "zh-CN" });
    });
    expect(await screen.findByText(/所选连接缺少此 App 所需权限/)).toBeInTheDocument();
  });

  it("attaches only the exact Worker Custom Domain declared by the current deployment", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    const app = detail({
      status: "ready",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-active",
      stableUrl: "https://demo.example.workers.dev",
    });
    const connections: AppCloudflareConnection[] = [
      {
        id: "connection-active",
        accountId: "account-active",
        accountName: "Alice Cloudflare",
        scope: "user",
        status: "active",
      },
      {
        id: "connection-other",
        accountId: "account-other",
        accountName: "Other Cloudflare",
        scope: "user",
        status: "active",
      },
    ];
    mockDetails({
      app,
      connections,
      deployment: deployment({
        phase: "ready",
        targetKind: "byoc",
        requestedCustomDomain: "app.example.com",
      }),
    });
    const listZones = vi.spyOn(api, "listCloudflareConnectionZones").mockResolvedValue({
      zones: [
        { id: "zone-active", name: "example.com", status: "active" },
        { id: "zone-pending", name: "pending.example", status: "pending" },
      ],
    });
    const attach = vi.spyOn(api, "setAppWorkerCustomDomain").mockResolvedValue({
      app: detail({
        ...app,
        customDomain: {
          id: "domain-1",
          hostname: "app.example.com",
          connectionId: "connection-active",
          zoneId: "zone-active",
          status: "pending",
          sslStatus: "pending_validation",
          createdAt: "2026-08-02T00:10:00.000Z",
          updatedAt: "2026-08-02T00:10:00.000Z",
        },
      }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    expect(await screen.findByText(uiCopy.apps.workerDomain.title)).toBeInTheDocument();
    await waitFor(() =>
      expect(listZones).toHaveBeenCalledWith(
        "connection-active",
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    expect(
      screen.queryByRole("option", { name: "Other Cloudflare (account-other)" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "pending.example" })).not.toBeInTheDocument();

    const hostname = screen.getByRole("textbox", { name: uiCopy.apps.workerDomain.hostname });
    const attachButton = screen.getByRole("button", { name: uiCopy.apps.workerDomain.attach });
    expect(hostname).toHaveValue("app.example.com");
    expect(hostname).toHaveAttribute("readonly");
    await user.click(
      screen.getByRole("checkbox", { name: uiCopy.apps.workerDomain.confirmImpact }),
    );
    expect(attachButton).toBeEnabled();
    await user.click(attachButton);

    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith(
        "app-a",
        {
          connectionId: "connection-active",
          zoneId: "zone-active",
          hostname: "app.example.com",
          confirmImpact: true,
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    expect(await screen.findByText(uiCopy.apps.workerDomain.attached)).toBeInTheDocument();

    act(() => {
      setUiCopyLanguage("zh-CN");
      useStore.setState({ uiLanguage: "zh-CN" });
    });
    expect(
      await screen.findByText("workers.dev 默认 URL 会永久保留，绑定或解绑域名都不会移除它。"),
    ).toBeInTheDocument();
  });

  it("detaches the exact current Worker Custom Domain without claiming certificate deletion", async () => {
    setUiCopyLanguage("en-US");
    useStore.setState({ uiLanguage: "en-US" });
    const app = detail({
      status: "ready",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-active",
      stableUrl: "https://demo.example.workers.dev",
      customDomain: {
        id: "domain-1",
        hostname: "app.example.com",
        connectionId: "connection-active",
        zoneId: "zone-active",
        status: "active",
        sslStatus: "active",
        createdAt: "2026-08-02T00:10:00.000Z",
        updatedAt: "2026-08-02T00:20:00.000Z",
      },
    });
    mockDetails({
      app,
      connections: [
        {
          id: "connection-active",
          accountId: "account-active",
          accountName: "Alice Cloudflare",
          scope: "user",
          status: "active",
        },
      ],
      deployment: deployment({ phase: "ready", targetKind: "byoc" }),
    });
    vi.spyOn(api, "listCloudflareConnectionZones").mockResolvedValue({
      zones: [{ id: "zone-active", name: "example.com", status: "active" }],
    });
    const detach = vi.spyOn(api, "removeAppWorkerCustomDomain").mockResolvedValue({
      app: detail({ ...app, customDomain: null }),
    });

    render(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: uiCopy.apps.manage }));
    expect(
      await screen.findByText(uiCopy.apps.workerDomain.detachCertificateImpact),
    ).toBeInTheDocument();
    const detachButton = screen.getByRole("button", { name: uiCopy.apps.workerDomain.detach });
    await waitFor(() => expect(detachButton).toBeDisabled());
    await user.click(
      screen.getByRole("checkbox", { name: uiCopy.apps.workerDomain.confirmImpact }),
    );
    await waitFor(() => expect(detachButton).toBeEnabled());
    await user.click(detachButton);

    await waitFor(() =>
      expect(detach).toHaveBeenCalledWith(
        "app-a",
        {
          connectionId: "connection-active",
          zoneId: "zone-active",
          hostname: "app.example.com",
          confirmImpact: true,
        },
        expect.objectContaining({ contextId: expect.any(String) }),
      ),
    );
    expect(await screen.findByText(uiCopy.apps.workerDomain.detached)).toBeInTheDocument();
  });
});
