// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./analytics.js", () => ({
  captureEvent: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("./auth-client.js", () => ({
  authClient: { signOut: vi.fn(async () => ({})) },
}));

import { ApiError, api, createSessionStream } from "./api.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { useStore } from "./store.js";
import { userScopeKeyFromCurrentUser } from "./store/user-scoped-storage.js";
import { setUiCopyLanguage, uiCopy } from "./ui-copy.js";

const user = {
  userId: "user-a",
  uuid: "user-a",
  username: "user-a",
  displayName: "User A",
  orgId: "org",
  orgName: "Org",
  roles: [],
};

function response(input: {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
  requestId?: string;
}): Response {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText || "",
    headers: new Headers(input.requestId ? { "x-request-id": input.requestId } : {}),
    json: async () => input.body,
  } as Response;
}

function sessionCreateStreamResponse(payload: unknown): Response {
  return sessionCreateRawStreamResponse(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sessionCreateRawStreamResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

beforeEach(async () => {
  setUiCopyLanguage("zh-CN");
  await api.logoutSession();
  await runtimeContextCoordinator.dispose();
  useStore.getState().reset();
  vi.restoreAllMocks();
});

afterEach(async () => {
  setUiCopyLanguage("zh-CN");
  await runtimeContextCoordinator.dispose();
  vi.unstubAllGlobals();
});

describe("API request contracts", () => {
  it("accepts only a complete native Pi session creation result", async () => {
    const sessionId = "session-123";
    const dynamicAgentId = "1f440778-b209-4be4-83dc-199633a7ca33";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sessionCreateStreamResponse({
          sessionId,
          state: "running",
          cwd: "/tmp/piwork/session-123/workspace",
          backendType: "pi",
          transport: "pi-rpc",
          model: {
            key: "openai/gpt-5",
            provider: "openai",
            modelId: "gpt-5",
          },
          thinkingLevel: "high",
          mode: "agent",
          authority: {
            tenantId: "tenant-1",
            userId: "user-1",
            agentDefinitionId: "agent-1",
            agentVersionId: "version-1",
            effectivePolicyHash: "policy-hash",
          },
          workspaceState: {
            selectedAgentId: dynamicAgentId,
            currentSessionId: sessionId,
            agentSessionIds: { [dynamicAgentId]: sessionId },
            agentSessionHistoryIds: { [dynamicAgentId]: [sessionId] },
            agentUserSpaces: {
              [dynamicAgentId]: [
                {
                  mountId: "mount-1",
                  name: "Documents",
                  rootName: "Documents",
                  status: "mounted",
                  access: "readwrite",
                  canRead: true,
                  canWrite: true,
                  permissionState: "granted",
                  includeHidden: true,
                },
              ],
            },
            updatedAt: "2026-07-26T00:00:00.000Z",
          },
        }),
      ),
    );

    await expect(createSessionStream(undefined, vi.fn())).resolves.toEqual({
      sessionId,
      state: "running",
      cwd: "/tmp/piwork/session-123/workspace",
      backendType: "pi",
      transport: "pi-rpc",
      model: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      thinkingLevel: "high",
      mode: "agent",
      workspaceState: {
        selectedAgentId: dynamicAgentId,
        currentSessionId: sessionId,
        agentSessionIds: { [dynamicAgentId]: sessionId },
        agentSessionHistoryIds: { [dynamicAgentId]: [sessionId] },
        agentUserSpaces: {
          [dynamicAgentId]: [
            {
              mountId: "mount-1",
              name: "Documents",
              rootName: "Documents",
              status: "mounted",
              access: "readwrite",
              canRead: true,
              canWrite: true,
              permissionState: "granted",
              includeHidden: true,
            },
          ],
        },
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    });
  });

  it("strictly validates Pi creation progress and error frames", async () => {
    const donePayload = {
      sessionId: "session-123",
      state: "running",
      cwd: "/tmp/piwork/session-123/workspace",
      backendType: "pi",
      transport: "pi-rpc",
      model: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      thinkingLevel: "medium",
      mode: "agent",
    };
    const onProgress = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sessionCreateRawStreamResponse(
          `event: progress\ndata: ${JSON.stringify({
            step: "launching_pi",
            label: "Starting native Pi",
            status: "in_progress",
            detail: "Allocating runtime",
          })}\n\nevent: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
        ),
      )
      .mockResolvedValueOnce(
        sessionCreateRawStreamResponse(
          `event: progress\ndata: ${JSON.stringify({
            step: "launching_pi",
            label: "Starting native Pi",
            status: "in_progress",
            sdkMessage: "legacy",
          })}\n\n`,
        ),
      )
      .mockResolvedValueOnce(
        sessionCreateRawStreamResponse(
          `event: error\ndata: ${JSON.stringify({
            error: "untrusted",
            claudeCode: "legacy",
          })}\n\n`,
        ),
      )
      .mockResolvedValueOnce(
        sessionCreateRawStreamResponse(
          `event: progress\ndata: ${JSON.stringify({
            step: "waiting_for_ready",
            label: "Waiting for ready",
            status: "in_progress",
          })}\n\n`,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await createSessionStream(undefined, onProgress);
    expect(onProgress).toHaveBeenCalledWith({
      step: "launching_pi",
      label: "Starting native Pi",
      status: "in_progress",
      detail: "Allocating runtime",
    });
    await expect(createSessionStream(undefined, vi.fn())).rejects.toThrow(
      uiCopy.piRuntime.invalidSessionCreateResponse,
    );
    await expect(createSessionStream(undefined, vi.fn())).rejects.toThrow(
      uiCopy.piRuntime.sessionCreationFailed,
    );
    await expect(createSessionStream(undefined, vi.fn())).rejects.toThrow(
      uiCopy.piRuntime.sessionCreateStreamEnded,
    );
  });

  it("rejects Claude-shaped and extra legacy session creation fields", async () => {
    const validPiPayload = {
      sessionId: "session-123",
      state: "running",
      cwd: "/tmp/piwork/session-123/workspace",
      backendType: "pi",
      transport: "pi-rpc",
      model: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      thinkingLevel: "medium",
      mode: "agent",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sessionCreateStreamResponse({ ...validPiPayload, backendType: "claude" }),
      )
      .mockResolvedValueOnce(
        sessionCreateStreamResponse({ ...validPiPayload, sdkSessionId: "legacy-sdk-session" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSessionStream(undefined, vi.fn())).rejects.toThrow(
      uiCopy.piRuntime.invalidSessionCreateResponse,
    );
    await expect(createSessionStream(undefined, vi.fn())).rejects.toThrow(
      uiCopy.piRuntime.invalidSessionCreateResponse,
    );
  });

  it("uses only the agent-scoped Pi model probe and exposes no process kill APIs", async () => {
    const fetchMock = vi.fn(async () => response({ ok: true, status: 200, body: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getBackendModels("agent/with space");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/backends/pi/models?agentId=agent%2Fwith%20space",
      expect.any(Object),
    );
    expect("killProcess" in api).toBe(false);
    expect("killAllProcesses" in api).toBe(false);
    expect("getSystemProcesses" in api).toBe(false);
    expect("killSystemProcess" in api).toBe(false);
    expect("getBackends" in api).toBe(false);
  });

  it("targets the authenticated browser bridge and encoded session control routes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      response({ ok: true, status: 200, body: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getBrowserBridgeStatus();
    await api.startBrowserBridge();
    await api.verifyBrowserBridge();
    await api.getBrowserControl("session/with space");
    await api.takeOverBrowserControl("session/with space");
    await api.resumeBrowserControl("session/with space", "Completed MFA");
    await api.stopBrowserControl("session/with space");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-bridge/status",
      "/api/browser-bridge/start",
      "/api/browser-bridge/verify",
      "/api/sessions/session%2Fwith%20space/browser-control",
      "/api/sessions/session%2Fwith%20space/browser-control/takeover",
      "/api/sessions/session%2Fwith%20space/browser-control/resume",
      "/api/sessions/session%2Fwith%20space/browser-control/stop",
    ]);
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ summary: "Completed MFA" }),
    });
  });

  it("binds Apps and Cloudflare deployment requests to the active runtime context", async () => {
    const lease = runtimeContextCoordinator.activate({
      userId: "user-a",
      userScopeKey: userScopeKeyFromCurrentUser({ ...user, tenantId: "tenant-a" }),
      agentId: "agent",
      sessionId: "session-a",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: {
            apps: [
              {
                id: "app-a",
                tenantId: "tenant-a",
                ownerUserId: "user-a",
                sourceSessionId: "session/a",
                slug: "demo",
                name: "Demo",
                status: "preview",
                targetKind: "temporary",
                stableUrl: "https://demo.example.workers.dev",
                currentDeploymentId: "deployment-2",
                canManage: true,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: {
            deployment: {
              id: "deployment-2",
              appId: "app-a",
              version: 2,
              phase: "claim_pending",
              targetKind: "temporary",
              stableUrl: "https://demo.example.workers.dev",
              requestedCustomDomain: "App.Example.com",
              temporaryPreview: {
                id: "preview-1",
                expiresAt: "2026-08-01T01:00:00.000Z",
                claimExpiresAt: "2026-08-01T00:30:00.000Z",
                claimAvailable: true,
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: {
            events: [
              {
                id: "event-1",
                phase: "temporary_ready",
                at: "2026-08-01T00:10:00.000Z",
                detail: "Preview ready",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: {
            connections: [
              {
                id: "connection-1",
                accountId: "account-1",
                accountName: "Alice Cloudflare",
                scope: "user",
                status: "active",
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: { authorizationUrl: "https://dash.cloudflare.com/oauth2/auth" },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 202,
          body: {
            deployment: {
              id: "deployment-2",
              appId: "app-a",
              version: 2,
              phase: "queued",
              targetKind: "temporary",
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const appPage = await api.listApps({ scope: "current-session", sessionId: "session/a" });
    const deployment = await api.getAppDeployment("deployment/2");
    const events = await api.getAppDeploymentEvents("deployment/2");
    await api.listCloudflareConnections();
    await api.startCloudflareOAuth({
      returnPath: "/apps?scope=mine",
      deploymentId: "deployment/2",
      purpose: "claim",
      temporaryPreviewId: "preview-1",
    });
    await api.selectAppDeploymentTarget("deployment/2", {
      target: "temporary",
      termsAcceptance: {
        acceptedTermsOfService: true,
        acceptedPrivacyPolicy: true,
      },
    });

    expect(appPage.apps[0]).toMatchObject({
      displayName: "Demo",
      ownerDisplayName: "user-a",
      latestDeploymentId: "deployment-2",
      status: "preview",
      targetKind: "temporary",
      stableUrl: "https://demo.example.workers.dev",
    });
    expect(deployment.deployment).toMatchObject({
      number: 2,
      phase: "claim_pending",
      requestedCustomDomain: "app.example.com",
      temporaryPreview: expect.objectContaining({ id: "preview-1", claimAvailable: true }),
    });
    expect(events.events[0]).toMatchObject({
      deploymentId: "deployment/2",
      phase: "temporary_ready",
      message: "Preview ready",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/apps?scope=current-session&sessionId=session%2Fa",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({
        "X-Piwork-Context-Epoch": String(lease.context.epoch),
        "X-Piwork-Context-Id": lease.context.contextId,
      }),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/apps?scope=current-session&sessionId=session%2Fa",
      "/api/apps/deployments/deployment%2F2",
      "/api/apps/deployments/deployment%2F2/events",
      "/api/cloudflare/connections",
      "/api/cloudflare/oauth/start",
      "/api/apps/deployments/deployment%2F2/target",
    ]);
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        returnPath: "/apps?scope=mine",
        deploymentId: "deployment/2",
        purpose: "claim",
        temporaryPreviewId: "preview-1",
      }),
    });
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        target: "temporary",
        termsAcceptance: {
          acceptedTermsOfService: true,
          acceptedPrivacyPolicy: true,
        },
      }),
    });
    expect(api.getAppDeploymentClaimUrl("deployment/2")).toBe(
      "/api/apps/deployments/deployment%2F2/claim",
    );
  });

  it("uses BYOC Worker Custom Domain routes with an explicit impact confirmation", async () => {
    runtimeContextCoordinator.activate({
      userId: "user-a",
      userScopeKey: userScopeKeyFromCurrentUser({ ...user, tenantId: "tenant-a" }),
      agentId: "agent",
      sessionId: "session-a",
    });
    const app = {
      id: "app-a",
      tenantId: "tenant-a",
      ownerUserId: "user-a",
      sourceSessionId: "session-a",
      slug: "demo",
      name: "Demo",
      status: "ready",
      targetKind: "byoc",
      cloudflareConnectionId: "connection-1",
      stableUrl: "https://demo.example.workers.dev",
      canManage: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: { zones: [{ id: "zone-1", name: "example.com", status: "active" }] },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: {
            app: {
              ...app,
              customDomain: {
                id: "domain-1",
                cloudflareConnectionId: "connection-1",
                zoneId: "zone-1",
                hostname: "app.example.com",
                status: "pending",
                sslStatus: "pending_validation",
                createdAt: "2026-08-01T00:10:00.000Z",
                updatedAt: "2026-08-01T00:10:00.000Z",
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          ok: true,
          status: 200,
          body: { app: { ...app, customDomain: null } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      connectionId: "connection-1",
      zoneId: "zone-1",
      hostname: "app.example.com",
      confirmImpact: true as const,
    };

    const zones = await api.listCloudflareConnectionZones("connection/1");
    const attached = await api.setAppWorkerCustomDomain("app/a", input);
    await api.removeAppWorkerCustomDomain("app/a", input);

    expect(zones.zones).toEqual([{ id: "zone-1", name: "example.com", status: "active" }]);
    expect(attached.app.customDomain).toMatchObject({
      hostname: "app.example.com",
      connectionId: "connection-1",
      zoneId: "zone-1",
      status: "pending",
      sslStatus: "pending_validation",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/cloudflare/connections/connection%2F1/zones",
      "/api/apps/app%2Fa/domains",
      "/api/apps/app%2Fa/domains",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(input),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify(input),
    });
  });

  it("loads browser-safe Cloudflare feature config inside the active runtime context", async () => {
    const lease = runtimeContextCoordinator.activate({
      userId: "user-a",
      userScopeKey: userScopeKeyFromCurrentUser({ ...user, tenantId: "tenant-a" }),
      agentId: "agent",
      sessionId: "session-a",
    });
    const fetchMock = vi.fn(async () =>
      response({
        ok: true,
        status: 200,
        body: {
          temporaryEnabled: true,
          byocEnabled: true,
          turnstileEnabled: true,
          siteKey: "site-key-public",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getCloudflareConfig()).resolves.toEqual({
      temporaryEnabled: true,
      byocEnabled: true,
      turnstileEnabled: true,
      siteKey: "site-key-public",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cloudflare/config",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Piwork-Context-Epoch": String(lease.context.epoch),
          "X-Piwork-Context-Id": lease.context.contextId,
        }),
      }),
    );
  });

  it("fails Apps authority-bearing requests when no runtime context is active", async () => {
    await runtimeContextCoordinator.dispose();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => api.listApps({ scope: "mine" })).toThrow("Runtime context is stale");
    expect(() => api.getCloudflareConfig()).toThrow("Runtime context is stale");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal through bootstrap requests and preserves AbortError", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.getWorkspaceBootstrap({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/bootstrap",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("normalizes the shared structured error response into ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ok: false,
          status: 409,
          body: {
            category: "conflict",
            code: "revision_conflict",
            status: 409,
            message: "Workspace state changed",
            requestId: "req-body",
            requiredPermissionNames: ["Workers Scripts Write", "D1 Write"],
          },
        }),
      ),
    );

    const error = await api.getWorkspaceBootstrap().catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      category: "conflict",
      code: "revision_conflict",
      status: 409,
      requestId: "req-body",
      message: "Workspace state changed",
      requiredPermissionNames: ["Workers Scripts Write", "D1 Write"],
    });
  });

  it("sends the runtime context epoch as diagnostic correlation metadata", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        ok: true,
        status: 200,
        body: { sessions: [], workspaceState: {} },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getWorkspaceBootstrap({ contextEpoch: 27 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/bootstrap",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Piwork-Context-Epoch": "27" }),
      }),
    );
  });

  it("binds User Space configuration to the exact current runtime capability", async () => {
    const lease = runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent",
      sessionId: "session-a",
    });
    const fetchMock = vi.fn(async () =>
      response({
        ok: true,
        status: 200,
        body: { user_space: null, user_spaces: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.configureUserSpace("session-a", null, undefined, {
      contextEpoch: lease.context.epoch,
      contextId: lease.context.contextId,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-a/user-space/configure",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Piwork-Context-Epoch": String(lease.context.epoch),
          "X-Piwork-Context-Id": lease.context.contextId,
        }),
      }),
    );
  });

  it("fails closed before fetch when User Space configuration names a stale context", async () => {
    const stale = runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent",
      sessionId: "session-a",
    });
    runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent",
      sessionId: "session-b",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.configureUserSpace("session-a", null, undefined, {
        contextEpoch: stale.context.epoch,
        contextId: stale.context.contextId,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins each runtime request to the tenant membership captured when it was constructed", async () => {
    const tenantA = {
      ...user,
      tenantId: "tenant-a",
      tenantName: "Tenant A",
      tenantType: "team" as const,
      membershipId: "membership-a",
    };
    let resolveTenantAPut!: (value: Response) => void;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/workspace/session-state" && init?.method === "PUT") {
        return new Promise<Response>((resolve) => {
          resolveTenantAPut = resolve;
        });
      }
      return Promise.resolve(response({ ok: true, status: 200, body: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().setCurrentUser(tenantA, "local");
    const tenantAPut = api.putWorkspaceSessionState({
      selectedAgentId: "agent",
      currentSessionId: null,
      agentSessionIds: {} as never,
      agentSessionHistoryIds: {} as never,
    });
    useStore.getState().setCurrentUser(
      {
        ...tenantA,
        tenantId: "tenant-b",
        tenantName: "Tenant B",
        membershipId: "membership-b",
      },
      "local",
    );
    resolveTenantAPut(response({ ok: true, status: 200, body: {} }));
    await tenantAPut;
    await api.getWorkspaceBootstrap();

    const tenantAPutHeaders = calls[0]?.init?.headers as Record<string, string>;
    const tenantBGetHeaders = calls[1]?.init?.headers as Record<string, string>;
    expect(tenantAPutHeaders).toMatchObject({
      "X-Piwork-Tenant-Id": "tenant-a",
      "X-Piwork-Membership-Id": "membership-a",
    });
    expect(tenantBGetHeaders).toMatchObject({
      "X-Piwork-Tenant-Id": "tenant-b",
      "X-Piwork-Membership-Id": "membership-b",
    });
  });

  it("binds the tenant switch to A and subsequent requests to the returned B membership", async () => {
    const tenantA = {
      ...user,
      tenantId: "tenant-a",
      tenantName: "Tenant A",
      tenantType: "team" as const,
      membershipId: "membership-a",
    };
    const membershipB = {
      id: "membership-b",
      tenantId: "tenant-b",
      tenantName: "Tenant B",
      tenantType: "team" as const,
      userId: user.userId,
      status: "active" as const,
      isDefault: false,
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/api/tenants/active") {
          return response({ ok: true, status: 200, body: { active: membershipB } });
        }
        return response({ ok: true, status: 200, body: {} });
      }),
    );

    useStore.getState().setCurrentUser(tenantA, "local");
    await api.switchTenant("tenant-b");
    useStore.getState().setCurrentUser(
      {
        ...tenantA,
        tenantId: membershipB.tenantId,
        tenantName: membershipB.tenantName,
        tenantType: membershipB.tenantType,
        membershipId: membershipB.id,
      },
      "local",
    );
    await api.getWorkspaceBootstrap();

    expect(calls[0]?.init?.headers).toMatchObject({
      "X-Piwork-Tenant-Id": "tenant-a",
      "X-Piwork-Membership-Id": "membership-a",
    });
    expect(calls[1]?.init?.headers).toMatchObject({
      "X-Piwork-Tenant-Id": "tenant-b",
      "X-Piwork-Membership-Id": "membership-b",
    });
  });

  it("does not let a stale 401 response log out a newer context", async () => {
    useStore.getState().setCurrentUser(user, "local");
    const first = runtimeContextCoordinator.activate({
      userId: user.uuid,
      agentId: "agent",
      sessionId: "session-a",
    });
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const pending = api.getWorkspaceBootstrap({ contextEpoch: first.context.epoch });
    useStore.getState().setCurrentUser(
      {
        ...user,
        userId: "user-b",
        uuid: "user-b",
        username: "user-b",
        displayName: "User B",
      },
      "local",
    );
    resolveFetch(
      response({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: { error: "Unauthorized" },
      }),
    );

    await expect(pending).rejects.toMatchObject({ status: 401 });
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().isAuthenticated).toBe(true);
    expect(useStore.getState().currentUser?.uuid).toBe("user-b");
  });

  it("logs out the current tenant context using the raw Better Auth user id", async () => {
    const tenantUser = { ...user, tenantId: "tenant-a" };
    useStore.getState().setCurrentUser(tenantUser, "local");
    const lease = runtimeContextCoordinator.activate({
      userId: tenantUser.uuid,
      userScopeKey: userScopeKeyFromCurrentUser(tenantUser),
      agentId: "agent",
      sessionId: "session-a",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          body: { error: "Unauthorized" },
        }),
      ),
    );

    await expect(
      api.getWorkspaceBootstrap({ contextEpoch: lease.context.epoch }),
    ).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => {
      expect(useStore.getState().isAuthenticated).toBe(false);
      expect(useStore.getState().currentUser).toBeNull();
    });
  });
});
