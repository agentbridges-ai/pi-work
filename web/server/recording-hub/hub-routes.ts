/**
 * REST API routes for the Recording Hub.
 *
 * All routes are under /api/hub/ and only registered when PIWORK_RECORDING_HUB=1.
 */

import type { Context, Hono } from "hono";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HubStore } from "./hub-store.js";
import type { ReplayAdapter } from "./replay-adapter.js";
import type { WsBridge } from "../ws-bridge.js";
import type { UserDiskQuota } from "../user-disk-quota.js";
import { readScopedFileSnapshotNoFollow } from "../path-policy.js";
import { getMaxUploadBytes } from "./hub-config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HubRoutesOptions {
  wsBridge: WsBridge;
  recordingsDir: string; // Auto-recording directory for import-local
  baseDir?: string;
  diskQuota?: UserDiskQuota;
}

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerHubRoutes(api: Hono, options: HubRoutesOptions): void {
  const store = new HubStore({ baseDir: options.baseDir, diskQuota: options.diskQuota });
  const replayAdapters = new Map<string, ReplayAdapter>();

  // ── Recording CRUD ────────────────────────────────────────────────────

  api.get("/hub/recordings", (c) => {
    return c.json(store.list());
  });

  api.get("/hub/recordings/:id", (c) => {
    const meta = store.get(c.req.param("id"));
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    return c.json(meta);
  });

  api.get("/hub/recordings/:id/summary", (c) => {
    const summary = store.getSummary(c.req.param("id"));
    if (!summary) return c.json({ error: "Recording not found" }, 404);
    return c.json(summary);
  });

  api.delete("/hub/recordings/:id", (c) => {
    try {
      const deleted = store.delete(c.req.param("id"));
      if (!deleted) return c.json({ error: "Recording not found" }, 404);
      return c.json({ ok: true });
    } catch (error) {
      return hubMutationError(c, error, 500);
    }
  });

  // ── Upload (raw JSONL content in body) ────────────────────────────────

  api.post("/hub/recordings/upload", async (c) => {
    try {
      const contentType = c.req.header("content-type") || "";

      let content: string;
      let originalFilename: string | undefined;

      if (contentType.includes("multipart/form-data")) {
        const formData = await c.req.formData();
        const file = formData.get("file");
        if (!file || !(file instanceof File)) {
          return c.json({ error: "Missing 'file' field in multipart form" }, 400);
        }
        content = await file.text();
        originalFilename = file.name;
      } else {
        // Plain text body
        content = await c.req.text();
      }

      const meta = store.importContent(content, originalFilename);
      return c.json(meta, 201);
    } catch (e: unknown) {
      return hubMutationError(c, e, 400);
    }
  });

  // ── Import from local auto-recordings ─────────────────────────────────

  api.post("/hub/recordings/import-local", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}) as { filename?: string });
      if (!body.filename) {
        return c.json({ error: "Missing 'filename' field" }, 400);
      }
      const sourcePath = resolveLocalRecordingPath(options.recordingsDir, body.filename);
      let snapshot;
      try {
        snapshot = await readScopedFileSnapshotNoFollow(sourcePath, [options.recordingsDir], {
          maxBytes: getMaxUploadBytes(),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "Recording file not found in auto-recordings directory" }, 404);
        }
        throw error;
      }
      const meta = store.importContent(Buffer.from(snapshot.bytes).toString("utf-8"));
      return c.json(meta, 201);
    } catch (e: unknown) {
      return hubMutationError(c, e, 400);
    }
  });

  // ── Tags ──────────────────────────────────────────────────────────────

  api.put("/hub/recordings/:id/tags", async (c) => {
    const body = await c.req.json().catch(() => ({}) as { tags?: string[] });
    if (!Array.isArray(body.tags)) {
      return c.json({ error: "Missing 'tags' array" }, 400);
    }
    try {
      const meta = store.updateTags(c.req.param("id"), body.tags);
      if (!meta) return c.json({ error: "Recording not found" }, 404);
      return c.json(meta);
    } catch (error) {
      return hubMutationError(c, error, 500);
    }
  });

  // ── Replay Sessions ───────────────────────────────────────────────────

  api.post("/hub/replay", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}) as { recordingId?: string; speed?: number });
      if (!body.recordingId) {
        return c.json({ error: "Missing 'recordingId'" }, 400);
      }

      if (body.speed !== undefined && (typeof body.speed !== "number" || body.speed <= 0)) {
        return c.json({ error: "Invalid 'speed' value" }, 400);
      }

      const recording = store.loadRecording(body.recordingId);
      if (!recording) {
        return c.json({ error: "Recording not found" }, 404);
      }

      // Lazy import to avoid circular dependency at module load time
      const { ReplayAdapter } = await import("./replay-adapter.js");

      const replaySessionId = `replay-${randomUUID()}`;
      const speed = body.speed ?? 1;
      const generation = 1;
      const adapter = new ReplayAdapter(recording, speed, generation);
      options.wsBridge.restoreSession({
        sessionId: replaySessionId,
        state: "ready",
        lifecycleState: "enabled",
        thinkingLevel: "off",
        mode: "agent",
        cwd: recording.header.cwd,
        createdAt: Date.now(),
        backendType: "pi",
        transport: "pi-rpc",
        generation,
        piVersion: "0.82.1",
      });
      adapter.onBrowserMessage((message) => {
        options.wsBridge.broadcastToSession(replaySessionId, message);
      });

      replayAdapters.set(replaySessionId, adapter);

      // Clean up when replay finishes
      adapter.onFinished(() => {
        replayAdapters.delete(replaySessionId);
        options.wsBridge.restoreSession({
          sessionId: replaySessionId,
          state: "exited",
          lifecycleState: "closed",
          exitCode: 0,
          thinkingLevel: "off",
          mode: "agent",
          cwd: recording.header.cwd,
          createdAt: Date.now(),
          backendType: "pi",
          transport: "pi-rpc",
          generation,
          piVersion: "0.82.1",
        });
      });

      // Start playback
      adapter.play();

      return c.json(
        {
          sessionId: replaySessionId,
          backendType: "pi",
          speed,
          entryCount: recording.entries.length,
        },
        201,
      );
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/hub/replay/:sessionId/pause", (c) => {
    const adapter = replayAdapters.get(c.req.param("sessionId"));
    if (!adapter) return c.json({ error: "Replay session not found" }, 404);
    adapter.pause();
    return c.json({ ok: true, paused: true });
  });

  api.post("/hub/replay/:sessionId/resume", (c) => {
    const adapter = replayAdapters.get(c.req.param("sessionId"));
    if (!adapter) return c.json({ error: "Replay session not found" }, 404);
    adapter.play();
    return c.json({ ok: true, paused: false });
  });

  api.post("/hub/replay/:sessionId/speed", async (c) => {
    const adapter = replayAdapters.get(c.req.param("sessionId"));
    if (!adapter) return c.json({ error: "Replay session not found" }, 404);
    const body = await c.req.json().catch(() => ({}) as { speed?: number });
    if (typeof body.speed !== "number" || body.speed <= 0) {
      return c.json({ error: "Invalid 'speed' value" }, 400);
    }
    adapter.setSpeed(body.speed);
    return c.json({ ok: true, speed: body.speed });
  });

  api.get("/hub/replay/:sessionId/progress", (c) => {
    const adapter = replayAdapters.get(c.req.param("sessionId"));
    if (!adapter) return c.json({ error: "Replay session not found" }, 404);
    return c.json(adapter.getProgress());
  });

  // ── Compatibility Validation ──────────────────────────────────────────

  api.post("/hub/recordings/:id/validate", async (c) => {
    try {
      const recording = store.loadRecording(c.req.param("id"));
      if (!recording) return c.json({ error: "Recording not found" }, 404);
      const { validateRecording } = await import("./compat-validator.js");
      const result = validateRecording(recording);
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ── Disconnection Diagnostics ─────────────────────────────────────────

  api.get("/hub/recordings/:id/diagnostics", async (c) => {
    try {
      const recording = store.loadRecording(c.req.param("id"));
      if (!recording) return c.json({ error: "Recording not found" }, 404);
      const { analyzeDisconnections } = await import("./diagnostics.js");
      return c.json(analyzeDisconnections(recording));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/hub/recordings/:id/timeline", async (c) => {
    try {
      const recording = store.loadRecording(c.req.param("id"));
      if (!recording) return c.json({ error: "Recording not found" }, 404);
      const { buildTimeline } = await import("./diagnostics.js");
      return c.json(buildTimeline(recording));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

function hubMutationError(c: Context, error: unknown, fallbackStatus: 400 | 500) {
  const status = (error as { status?: unknown })?.status === 507 ? 507 : fallbackStatus;
  return c.json(
    { error: error instanceof Error ? error.message : String(error) },
    status as 400 | 500 | 507,
  );
}

function resolveLocalRecordingPath(baseDir: string, filename: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, filename);
  const lexicalRelative = relative(base, target);
  if (
    isAbsolute(lexicalRelative) ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`)
  ) {
    throw new Error("Invalid filename");
  }
  if (!lexicalRelative) throw new Error("Invalid filename");
  return target;
}
