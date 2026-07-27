import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createRoutes } from "../routes.js";
import type { AuthenticatedUser } from "../auth-types.js";

const OWNED_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("recording route runtime ownership", () => {
  let dataRoot: string;
  let previousDataRoot: string | undefined;
  let app: Hono;
  const enableForSession = vi.fn();
  const disableForSession = vi.fn();
  const isRecording = vi.fn(() => true);
  const getRecordingStatus = vi.fn(() => ({}));

  beforeEach(() => {
    vi.clearAllMocks();
    dataRoot = mkdtempSync(join(tmpdir(), "piwork-recording-routes-"));
    previousDataRoot = process.env.PIWORK_DATA_ROOT;
    process.env.PIWORK_DATA_ROOT = dataRoot;

    const user: AuthenticatedUser = {
      userId: "user-a",
      uuid: "user-a",
      username: "user-a@example.test",
      displayName: "User A",
      orgId: "local",
      orgName: "Local",
      roles: ["user"],
    };
    const launcher = {
      getSession: (sessionId: string) =>
        sessionId === OWNED_SESSION
          ? {
              sessionId,
              state: "connected",
              cwd: join(dataRoot, "user-a", sessionId, "workspace"),
              createdAt: 1,
            }
          : undefined,
    };
    const wsBridge = { getSession: () => undefined };
    const recorder = {
      enableForSession,
      disableForSession,
      isRecording,
      getRecordingStatus,
      listRecordings: () => [],
      getRecordingsDir: () => join(dataRoot, "user-a"),
    };

    app = new Hono();
    app.route(
      "/api",
      createRoutes(
        {} as never,
        launcher as never,
        wsBridge as never,
        recorder as never,
        3457,
        undefined,
        undefined,
        undefined,
        { getCurrentUser: () => user },
      ),
    );
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.PIWORK_DATA_ROOT;
    else process.env.PIWORK_DATA_ROOT = previousDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("starts, stops, and reports recording only for a session owned by this user runtime", async () => {
    expect(
      (await app.request(`/api/sessions/${OWNED_SESSION}/recording/start`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(enableForSession).toHaveBeenCalledWith(OWNED_SESSION);

    expect((await app.request(`/api/sessions/${OWNED_SESSION}/recording/status`)).status).toBe(200);
    expect(getRecordingStatus).not.toHaveBeenCalled();

    expect(
      (await app.request(`/api/sessions/${OWNED_SESSION}/recording/stop`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(disableForSession).toHaveBeenCalledWith(OWNED_SESSION);
  });

  it.each(["start", "stop", "status"])(
    "returns 404 before touching recorder for another user's %s request",
    async (action) => {
      const method = action === "status" ? "GET" : "POST";
      const response = await app.request(`/api/sessions/${FOREIGN_SESSION}/recording/${action}`, {
        method,
      });
      expect(response.status).toBe(404);
      expect(enableForSession).not.toHaveBeenCalled();
      expect(disableForSession).not.toHaveBeenCalled();
      expect(getRecordingStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects a double-encoded session path segment before touching recorder", async () => {
    const response = await app.request("/api/sessions/%252e%252e/recording/status");
    expect(response.status).toBe(400);
    expect(getRecordingStatus).not.toHaveBeenCalled();
  });
});
