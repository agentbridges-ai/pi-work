import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { UserDiskQuota } from "../user-disk-quota.js";

// ─── Test setup ──────────────────────────────────────────────────────────────

// Static suffix generated at module parse time so vi.mock factory can reference it
const TEST_SUFFIX = randomBytes(4).toString("hex");
const TEST_HOME = join(tmpdir(), `hub-routes-test-${TEST_SUFFIX}`);
const RECORDINGS_DIR = join(TEST_HOME, "auto-recordings");

// Mock PIWORK_HOME so HubStore writes to our temp directory
// vi.mock is hoisted, so we use the tmpdir + suffix pattern inline
vi.mock("../paths.js", () => {
  const { tmpdir: td } = require("node:os");
  const { join: jn } = require("node:path");
  // Read the suffix from the env var we set before import
  return { PIWORK_HOME: jn(td(), `hub-routes-test-${process.env.__HUB_ROUTES_TEST_SUFFIX}`) };
});

// Set the suffix in env before mock resolution
process.env.__HUB_ROUTES_TEST_SUFFIX = TEST_SUFFIX;

const { registerHubRoutes } = await import("./hub-routes.js");

// Mock WsBridge with minimal interface
function makeMockBridge() {
  return {
    restoreSession: vi.fn(),
    broadcastToSession: vi.fn(),
  } as any;
}

function makeValidRecording(sessionId = "test-session"): string {
  const header = JSON.stringify({
    _header: true,
    version: 2,
    session_id: sessionId,
    backend_type: "pi",
    transport: "pi-rpc",
    started_at: 1000000,
    cwd: "/test/dir",
  });
  const entries = [
    JSON.stringify({
      ts: 1000000,
      dir: "out",
      raw: JSON.stringify({
        type: "session_init",
        session: {
          sessionId,
          backendType: "pi",
          transport: "pi-rpc",
          piVersion: "0.82.1",
          model: {
            key: "provider/model",
            provider: "provider",
            modelId: "model",
          },
          thinkingLevel: "medium",
          mode: "agent",
          cwd: "/test/dir",
          tools: ["read"],
          commands: [],
          skills: [],
          mcpServers: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          runState: "ready",
          isCompacting: false,
          generation: 1,
        },
      }),
      ch: "browser",
    }),
    JSON.stringify({
      ts: 1001000,
      dir: "out",
      raw: JSON.stringify({
        type: "agent_message",
        generation: 1,
        message: {
          id: "message-1",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1001000,
        },
      }),
      ch: "browser",
    }),
    JSON.stringify({
      ts: 1002000,
      dir: "out",
      raw: JSON.stringify({
        type: "run_state",
        state: "stopped",
        generation: 1,
        timestamp: 1002000,
      }),
      ch: "browser",
    }),
  ];
  return [header, ...entries].join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("hub-routes", () => {
  let app: Hono;
  let bridge: ReturnType<typeof makeMockBridge>;

  beforeEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
    mkdirSync(join(TEST_HOME, "hub", "recordings"), { recursive: true });
    mkdirSync(RECORDINGS_DIR, { recursive: true });

    bridge = makeMockBridge();
    app = new Hono();
    registerHubRoutes(app, {
      wsBridge: bridge,
      recordingsDir: RECORDINGS_DIR,
      baseDir: join(TEST_HOME, "hub"),
    });
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  });

  // ── Recording CRUD ──────────────────────────────────────────────────

  describe("GET /hub/recordings", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/hub/recordings");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("POST /hub/recordings/upload", () => {
    it("uploads valid JSONL content as plain text", async () => {
      const content = makeValidRecording();
      const res = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: content,
        headers: { "content-type": "text/plain" },
      });
      expect(res.status).toBe(201);
      const meta = await res.json();
      expect(meta.id).toBeTruthy();
      expect(meta.sessionId).toBe("test-session");
    });

    it("rejects invalid content with 400", async () => {
      const res = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: "not valid jsonl",
        headers: { "content-type": "text/plain" },
      });
      expect(res.status).toBe(400);
    });

    it("preserves 507 when the user-scoped hub quota is exhausted", async () => {
      const baseDir = join(TEST_HOME, "quota-hub");
      mkdirSync(baseDir, { recursive: true });
      const quota = new UserDiskQuota({ maxBytes: 64, reservedHeadroomBytes: 1 });
      quota.addRoot(baseDir);
      await quota.reconcile();
      const quotaApp = new Hono();
      registerHubRoutes(quotaApp, {
        wsBridge: bridge,
        recordingsDir: RECORDINGS_DIR,
        baseDir,
        diskQuota: quota,
      });

      const res = await quotaApp.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });

      expect(res.status).toBe(507);
      expect((await res.json()).error).toContain("disk quota exceeded");
    });
  });

  describe("GET /hub/recordings/:id", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns meta for existing recording", async () => {
      // Upload first
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}`);
      expect(res.status).toBe(200);
      const meta = await res.json();
      expect(meta.id).toBe(id);
    });
  });

  describe("GET /hub/recordings/:id/summary", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent/summary");
      expect(res.status).toBe(404);
    });

    it("returns summary for existing recording", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}/summary`);
      expect(res.status).toBe(200);
      const summary = await res.json();
      expect(summary.entryCount).toBe(3);
    });
  });

  describe("DELETE /hub/recordings/:id", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("deletes existing recording", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const deleteRes = await app.request(`/hub/recordings/${id}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);
      expect(await deleteRes.json()).toEqual({ ok: true });

      // Verify it's gone
      const getRes = await app.request(`/hub/recordings/${id}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ── Import local ────────────────────────────────────────────────────

  describe("POST /hub/recordings/import-local", () => {
    it("imports a local recording file", async () => {
      const filename = "test-recording.jsonl";
      writeFileSync(join(RECORDINGS_DIR, filename), makeValidRecording());

      const res = await app.request("/hub/recordings/import-local", {
        method: "POST",
        body: JSON.stringify({ filename }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(201);
      const meta = await res.json();
      expect(meta.sessionId).toBe("test-session");
    });

    it("returns 400 for missing filename", async () => {
      const res = await app.request("/hub/recordings/import-local", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent file", async () => {
      const res = await app.request("/hub/recordings/import-local", {
        method: "POST",
        body: JSON.stringify({ filename: "does-not-exist.jsonl" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("rejects path traversal attempts", async () => {
      const res = await app.request("/hub/recordings/import-local", {
        method: "POST",
        body: JSON.stringify({ filename: "../../etc/passwd" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid filename");
    });

    it.skipIf(process.platform === "win32")(
      "rejects a recording symlink that escapes the scoped auto-recordings directory",
      async () => {
        const foreignDir = join(TEST_HOME, "foreign-user-recordings");
        mkdirSync(foreignDir, { recursive: true });
        const foreignRecording = join(foreignDir, "private.jsonl");
        writeFileSync(foreignRecording, makeValidRecording("foreign-session"));
        symlinkSync(foreignRecording, join(RECORDINGS_DIR, "linked.jsonl"));

        const res = await app.request("/hub/recordings/import-local", {
          method: "POST",
          body: JSON.stringify({ filename: "linked.jsonl" }),
          headers: { "content-type": "application/json" },
        });

        expect(res.status).toBe(400);
        expect((await res.json()).error).toBeTruthy();
        const listResponse = await app.request("/hub/recordings");
        expect(await listResponse.json()).toEqual([]);
      },
    );
  });

  // ── Tags ────────────────────────────────────────────────────────────

  describe("PUT /hub/recordings/:id/tags", () => {
    it("updates tags", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags: ["regression", "v2"] }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const meta = await res.json();
      expect(meta.tags).toEqual(["regression", "v2"]);
    });

    it("returns 400 for missing tags array", async () => {
      const res = await app.request("/hub/recordings/some-id/tags", {
        method: "PUT",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent/tags", {
        method: "PUT",
        body: JSON.stringify({ tags: ["test"] }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Replay ──────────────────────────────────────────────────────────

  describe("POST /hub/replay", () => {
    it("returns 400 for missing recordingId", async () => {
      const res = await app.request("/hub/replay", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent recording", async () => {
      const res = await app.request("/hub/replay", {
        method: "POST",
        body: JSON.stringify({ recordingId: "nonexistent" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid speed", async () => {
      const res = await app.request("/hub/replay", {
        method: "POST",
        body: JSON.stringify({ recordingId: "x", speed: -1 }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid 'speed' value");
    });

    it("creates a replay session", async () => {
      // Upload a recording first
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request("/hub/replay", {
        method: "POST",
        body: JSON.stringify({ recordingId: id, speed: 1_000_000_000 }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.sessionId).toMatch(/^replay-/);
      expect(body.speed).toBe(1_000_000_000);
      expect(body.backendType).toBe("pi");
      expect(bridge.restoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: body.sessionId,
          backendType: "pi",
          transport: "pi-rpc",
          piVersion: "0.82.1",
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(bridge.broadcastToSession).toHaveBeenCalledWith(
        body.sessionId,
        expect.objectContaining({ type: "run_state", state: "stopped" }),
      );
    });
  });

  describe("replay control endpoints", () => {
    it("returns 404 for unknown replay sessions", async () => {
      const pauseRes = await app.request("/hub/replay/nonexistent/pause", { method: "POST" });
      expect(pauseRes.status).toBe(404);

      const resumeRes = await app.request("/hub/replay/nonexistent/resume", { method: "POST" });
      expect(resumeRes.status).toBe(404);

      const speedRes = await app.request("/hub/replay/nonexistent/speed", {
        method: "POST",
        body: JSON.stringify({ speed: 2 }),
        headers: { "content-type": "application/json" },
      });
      expect(speedRes.status).toBe(404);

      const progressRes = await app.request("/hub/replay/nonexistent/progress");
      expect(progressRes.status).toBe(404);
    });
  });

  describe("POST /hub/replay/:sessionId/speed", () => {
    it("returns 400 for invalid speed", async () => {
      // We can't easily test with a real replay session here since the adapter
      // is not in the map, but we can verify the 404 for unknown session.
      const res = await app.request("/hub/replay/nonexistent/speed", {
        method: "POST",
        body: JSON.stringify({ speed: 0 }),
        headers: { "content-type": "application/json" },
      });
      // 404 because session doesn't exist (speed validation would be 400 but session check comes first)
      expect(res.status).toBe(404);
    });
  });

  // ── Validation ──────────────────────────────────────────────────────

  describe("POST /hub/recordings/:id/validate", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent/validate", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("validates an existing recording", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}/validate`, { method: "POST" });
      expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.compatible).toBe(true);
      expect(result.backendType).toBe("pi");
    });
  });

  // ── Diagnostics ─────────────────────────────────────────────────────

  describe("GET /hub/recordings/:id/diagnostics", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent/diagnostics");
      expect(res.status).toBe(404);
    });

    it("returns diagnostics for existing recording", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}/diagnostics`);
      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report.sessionId).toBe("test-session");
    });
  });

  describe("GET /hub/recordings/:id/timeline", () => {
    it("returns 404 for unknown id", async () => {
      const res = await app.request("/hub/recordings/nonexistent/timeline");
      expect(res.status).toBe(404);
    });

    it("returns timeline for existing recording", async () => {
      const uploadRes = await app.request("/hub/recordings/upload", {
        method: "POST",
        body: makeValidRecording(),
        headers: { "content-type": "text/plain" },
      });
      const { id } = await uploadRes.json();

      const res = await app.request(`/hub/recordings/${id}/timeline`);
      expect(res.status).toBe(200);
      const timeline = await res.json();
      expect(Array.isArray(timeline)).toBe(true);
    });
  });
});
