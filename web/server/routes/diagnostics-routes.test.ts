import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerDiagnosticsRoutes } from "./diagnostics-routes.js";
import type { PiLauncher } from "../pi-launcher.js";
import type { GaugeDataProvider } from "../metrics-collector.js";
import type { RecorderManager } from "../recorder.js";

describe("GET /diagnostics/runtime", () => {
  it("requires the runtime:view authorization boundary when configured", async () => {
    const app = new Hono();
    const launcher = { listSessions: () => [] } as unknown as PiLauncher;
    const gaugeProvider = {
      getSessionMemoryStats: () => [],
      getSessionPhases: () => new Map(),
    } satisfies GaugeDataProvider;
    registerDiagnosticsRoutes(app, {
      launcher,
      gaugeProvider,
      runtimeStateProvider: { listRuntimeStates: () => [] },
      authorize: async () => false,
    });
    const response = await app.request("/diagnostics/runtime");
    expect(response.status).toBe(403);
  });

  it("returns bounded local diagnostics without session paths or prompts", async () => {
    const app = new Hono();
    const launcher = {
      listSessions: () => [
        { sessionId: "secret-session", state: "connected", cwd: "/private/workspace", pid: 123 },
        { sessionId: "other-session", state: "exited", cwd: "/private/other" },
      ],
    } as unknown as PiLauncher;
    const gaugeProvider = {
      getSessionMemoryStats: () => [],
      getSessionPhases: () => new Map(),
    } satisfies GaugeDataProvider;
    const recorder = {
      isGloballyEnabled: () => true,
      getRetentionPolicy: () => ({
        maxSessionBytes: 100,
        maxUserBytes: 500,
        retentionDays: 7,
      }),
      listRecordings: vi.fn(() => []),
    } as unknown as RecorderManager;
    const runtimeStateProvider = {
      listRuntimeStates: () => [
        {
          sessionId: "secret-session",
          state: "ready" as const,
          generation: 2,
          reason: "ready",
          updatedAt: 1,
        },
        {
          sessionId: "other-session",
          state: "stopped" as const,
          generation: 3,
          reason: "stopped",
          updatedAt: 2,
        },
      ],
    };
    registerDiagnosticsRoutes(app, {
      launcher,
      gaugeProvider,
      recorder,
      runtimeStateProvider,
      authorize: async () => true,
    });

    const response = await app.request("/diagnostics/runtime");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body).toMatchObject({
      schemaVersion: 1,
      runtime: {
        sessions: 2,
        lifecycle: { connected: 1, exited: 1 },
        supervisor: { ready: 1, stopped: 1 },
        activePiProcesses: 1,
        memory: {
          rss: expect.any(Number),
          heapUsed: expect.any(Number),
        },
      },
      recordings: { enabled: true, count: 0 },
    });
    expect(JSON.stringify(body)).not.toContain("secret-session");
    expect(JSON.stringify(body)).not.toContain("/private/");
  });
});
