import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockHandler = vi.hoisted(() => vi.fn());

vi.mock("./better-auth.js", () => ({
  auth: {
    api: { getSession: (...args: unknown[]) => mockGetSession(...args) },
    handler: (...args: unknown[]) => mockHandler(...args),
  },
}));

import { LocalAuth } from "./local-auth.js";

const savedEnv = { ...process.env };

describe("LocalAuth Better Auth adapter", () => {
  let root: string;

  beforeEach(() => {
    process.env = { ...savedEnv };
    root = mkdtempSync(join(tmpdir(), "piwork-auth-"));
    process.env.PIWORK_DATA_ROOT = join(root, "data");
    mockGetSession.mockReset();
    mockHandler.mockReset();
    mockHandler.mockResolvedValue(new Response("better-auth"));
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  it("returns Better Auth local auth mode without touching Postgres", async () => {
    const auth = new LocalAuth();
    const res = await auth.handlePublicRequest(new Request("http://localhost/api/auth/mode"));

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toMatchObject({
      mode: "better-auth",
      runtimeMode: "local",
      emailAndPassword: true,
      signUpEnabled: true,
    });
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("delegates Better Auth native routes", async () => {
    const auth = new LocalAuth();
    const req = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });

    const res = await auth.handlePublicRequest(req);

    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("better-auth");
    expect(mockHandler).toHaveBeenCalledWith(req);
  });

  it("reports and enforces disabled public sign-up", async () => {
    const rbac = {
      isRegistrationEnabled: vi.fn().mockResolvedValue(false),
    };
    const auth = new LocalAuth(rbac as never);

    const modeRes = await auth.handlePublicRequest(new Request("http://localhost/api/auth/mode"));
    await expect(modeRes?.json()).resolves.toMatchObject({ signUpEnabled: false });

    const signUpRes = await auth.handlePublicRequest(
      new Request("http://localhost/api/auth/sign-up/email", { method: "POST" }),
    );

    expect(signUpRes?.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("keeps sign-up disabled per request on non-loopback listeners", async () => {
    const rbac = {
      isRegistrationEnabled: vi.fn().mockResolvedValue(true),
    };
    const auth = new LocalAuth(rbac as never, async (user) => user, "0.0.0.0");

    const modeRes = await auth.handlePublicRequest(new Request("http://localhost/api/auth/mode"));
    await expect(modeRes?.json()).resolves.toMatchObject({ signUpEnabled: false });
    const signUpRes = await auth.handlePublicRequest(
      new Request("http://localhost/api/auth/sign-up/email", { method: "POST" }),
    );

    expect(signUpRes?.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
    expect(rbac.isRegistrationEnabled).not.toHaveBeenCalled();
  });

  it("still delegates sign-in when public sign-up is disabled", async () => {
    const rbac = {
      isRegistrationEnabled: vi.fn().mockResolvedValue(false),
    };
    const auth = new LocalAuth(rbac as never);
    const req = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });

    const res = await auth.handlePublicRequest(req);

    expect(res?.status).toBe(200);
    expect(mockHandler).toHaveBeenCalledWith(req);
  });

  it("fails closed when the registration setting cannot be read", async () => {
    const rbac = {
      isRegistrationEnabled: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    const auth = new LocalAuth(rbac as never);

    const modeRes = await auth.handlePublicRequest(new Request("http://localhost/api/auth/mode"));
    await expect(modeRes?.json()).resolves.toMatchObject({ signUpEnabled: false });

    const signUpRes = await auth.handlePublicRequest(
      new Request("http://localhost/api/auth/sign-up/email", { method: "POST" }),
    );
    expect(signUpRes?.status).toBe(403);
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("maps a Better Auth session to Piwork user shape and writes a profile snapshot", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "better-auth-user",
        email: "TestUser@Example.Test",
        name: "御坂美琴",
      },
      session: { id: "session" },
    });
    const auth = new LocalAuth();

    const result = await auth.authenticate(new Request("http://localhost/api/sessions"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({
      userId: "better-auth-user",
      uuid: "better-auth-user",
      username: "testuser@example.test",
      displayName: "御坂美琴",
      orgId: "local",
      orgName: "Local",
      roles: ["user"],
      email: "testuser@example.test",
    });
    const profilePath = join(root, "data", "better-auth-user", "profile.json");
    expect(existsSync(profilePath)).toBe(true);
    expect(JSON.parse(readFileSync(profilePath, "utf-8")).data).toMatchObject({
      uuid: "better-auth-user",
      email: "testuser@example.test",
    });
  });

  it("returns the active tenant principal from /api/me", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "better-auth-user",
        email: "tenant-user@example.test",
        name: "Tenant User",
      },
      session: { id: "session" },
    });
    const resolveActiveUser = vi.fn(async (user) => ({
      ...user,
      tenantId: "tenant-active",
      tenantName: "Active Tenant",
      tenantType: "team" as const,
      membershipId: "membership-active",
      orgId: "tenant-active",
      orgName: "Active Tenant",
    }));
    const auth = new LocalAuth(undefined, resolveActiveUser);

    const response = await auth.handlePublicRequest(new Request("http://localhost/api/me"));

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      user: {
        userId: "better-auth-user",
        tenantId: "tenant-active",
        tenantName: "Active Tenant",
        tenantType: "team",
        membershipId: "membership-active",
        orgId: "tenant-active",
        orgName: "Active Tenant",
      },
    });
    expect(resolveActiveUser).toHaveBeenCalledOnce();
  });

  it("persists local preferences for the current Better Auth user", async () => {
    mockGetSession.mockResolvedValue({
      user: {
        id: "better-auth-user",
        email: "TestUser@Example.Test",
        name: "御坂美琴",
      },
      session: { id: "session" },
    });
    const auth = new LocalAuth();
    const updateRes = await auth.handlePublicRequest(
      new Request("http://localhost/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: {
            filePreviewDefaults: {
              html: "alternate",
              markdown: "preview",
              word: "alternate",
              ppt: "preview",
              excel: "alternate",
            },
            userSpace: {
              showHiddenEntries: true,
              searchHiddenEntries: false,
            },
          },
        }),
      }),
    );

    expect(updateRes?.status).toBe(200);
    await expect(updateRes?.json()).resolves.toMatchObject({
      preferences: {
        filePreviewDefaults: {
          html: "alternate",
          word: "alternate",
          excel: "alternate",
        },
        userSpace: {
          showHiddenEntries: true,
          searchHiddenEntries: true,
        },
      },
    });
    const preferencesPath = join(root, "data", "better-auth-user", "preferences.json");
    expect(JSON.parse(readFileSync(preferencesPath, "utf-8")).data).toMatchObject({
      filePreviewDefaults: {
        html: "alternate",
        word: "alternate",
        excel: "alternate",
      },
      userSpace: {
        showHiddenEntries: true,
        searchHiddenEntries: true,
      },
    });

    const getRes = await auth.handlePublicRequest(new Request("http://localhost/api/preferences"));
    await expect(getRes?.json()).resolves.toMatchObject({
      preferences: {
        filePreviewDefaults: {
          html: "alternate",
          word: "alternate",
          excel: "alternate",
        },
        userSpace: {
          showHiddenEntries: true,
          searchHiddenEntries: true,
        },
      },
    });
  });

  it("rejects requests without a Better Auth session", async () => {
    mockGetSession.mockResolvedValue(null);
    const auth = new LocalAuth();

    const result = await auth.authenticate(new Request("http://localhost/api/sessions"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
