import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createRoutes } from "../routes.js";
import { SessionStore } from "../session-store.js";
import { SessionNameStore } from "../session-names.js";
import { UserDiskQuota } from "../user-disk-quota.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "22222222-2222-4222-8222-222222222222";

describe("session deletion routes", () => {
  let root: string;
  let sessionStore: SessionStore;

  beforeEach(() => {
    root = join(tmpdir(), `piwork-delete-route-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    sessionStore = new SessionStore(root, { layout: "session-dir" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createApp(removeDirectory = true) {
    const hardDeleteSession = vi.fn(async (sessionId: string) => ({
      ok: true,
      removedSessionDir: removeDirectory ? sessionStore.removeSessionDirectory(sessionId) : false,
    }));
    const orchestrator = {
      hasSessionData: (sessionId: string) => sessionStore.hasSessionData(sessionId),
      hardDeleteSession,
    };
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        orchestrator as never,
        { getSession: () => undefined } as never,
        { getSession: () => undefined } as never,
      ),
    );
    return { app, hardDeleteSession };
  }

  it("permanently deletes orphaned on-disk session data", async () => {
    const sessionDir = join(root, SESSION_ID);
    mkdirSync(join(sessionDir, "workspace"), { recursive: true });
    writeFileSync(join(sessionDir, "workspace", "artifact.txt"), "data");
    const { app, hardDeleteSession } = createApp();

    const response = await app.request(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(hardDeleteSession).toHaveBeenCalledWith(SESSION_ID);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("does not expose or delete a session absent from the current user's data root", async () => {
    const { app, hardDeleteSession } = createApp();

    const response = await app.request(`/api/sessions/${UNKNOWN_ID}`, { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(hardDeleteSession).not.toHaveBeenCalled();
  });

  it("reports failure when the session directory remains on disk", async () => {
    mkdirSync(join(root, SESSION_ID), { recursive: true });
    const { app } = createApp(false);

    const response = await app.request(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(existsSync(join(root, SESSION_ID))).toBe(true);
  });

  it("preserves session data when the orchestrator cannot commit deletion", async () => {
    mkdirSync(join(root, SESSION_ID), { recursive: true });
    const hardDeleteSession = vi.fn(async () => ({
      ok: false as const,
      error: "runtime drain was not proven",
    }));
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        {
          hasSessionData: (sessionId: string) => sessionStore.hasSessionData(sessionId),
          hardDeleteSession,
        } as never,
        { getSession: () => undefined } as never,
        { getSession: () => undefined } as never,
      ),
    );

    const response = await app.request(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "runtime drain was not proven" });
    expect(existsSync(join(root, SESSION_ID))).toBe(true);
  });

  it("reports an archive conflict when the lifecycle operation is not committed", async () => {
    const archiveSession = vi.fn(async () => ({ ok: false as const }));
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        { archiveSession } as never,
        {
          getSession: (sessionId: string) => (sessionId === SESSION_ID ? { sessionId } : undefined),
        } as never,
        { getSession: () => undefined } as never,
      ),
    );

    const response = await app.request(`/api/sessions/${SESSION_ID}/archive`, {
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Session archive was not committed",
    });
  });

  it("preserves resource-admission status from session relaunch", async () => {
    const relaunchSession = vi.fn(async () => ({
      ok: false as const,
      status: 507 as const,
      error: "disk quota exceeded",
    }));
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        { relaunchSession } as never,
        {
          getSession: (id: string) => (id === SESSION_ID ? { sessionId: id } : undefined),
        } as never,
        { getSession: () => undefined } as never,
      ),
    );

    const response = await app.request(`/api/sessions/${SESSION_ID}/relaunch`, {
      method: "POST",
    });

    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toEqual({ error: "disk quota exceeded" });
  });

  it("returns 400 before broadcasting a session name over the 256-byte UTF-8 limit", async () => {
    const markSessionNameManual = vi.fn();
    const broadcastNameUpdate = vi.fn();
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        { markSessionNameManual } as never,
        { getSession: () => ({ sessionId: SESSION_ID }) } as never,
        { getSession: () => undefined, broadcastNameUpdate } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        new SessionNameStore(join(root, "session-names.json")),
      ),
    );

    const response = await app.request(`/api/sessions/${SESSION_ID}/name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "界".repeat(86) }),
    });

    expect(response.status).toBe(400);
    expect(markSessionNameManual).not.toHaveBeenCalled();
    expect(broadcastNameUpdate).not.toHaveBeenCalled();
  });

  it("preserves 507 from session-name atomic persistence", async () => {
    const quota = new UserDiskQuota({ maxBytes: 64, reservedHeadroomBytes: 1 });
    quota.addRoot(root);
    await quota.reconcile();
    const markSessionNameManual = vi.fn();
    const broadcastNameUpdate = vi.fn();
    const app = new Hono();
    app.route(
      "/api",
      createRoutes(
        { markSessionNameManual } as never,
        { getSession: () => ({ sessionId: SESSION_ID }) } as never,
        { getSession: () => undefined, broadcastNameUpdate } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        new SessionNameStore(join(root, "session-names.json"), quota),
      ),
    );

    const response = await app.request(`/api/sessions/${SESSION_ID}/name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "valid name" }),
    });

    expect(response.status).toBe(507);
    expect(markSessionNameManual).not.toHaveBeenCalled();
    expect(broadcastNameUpdate).not.toHaveBeenCalled();
  });
});
