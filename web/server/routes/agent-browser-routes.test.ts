import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentBrowserRoutes } from "./agent-browser-routes.js";
import type { AgentBrowserBridgeStatus } from "../agent-browser-bridge-service.js";

function status(phase: AgentBrowserBridgeStatus["phase"]): AgentBrowserBridgeStatus {
  return {
    schemaVersion: 1,
    phase,
    runtime: { ready: true, version: "0.31.1", sourceCommit: "a".repeat(40), missing: [] },
    daemon: {
      state: "online",
      port: 19826,
      version: "0.31.1",
      protocolVersion: 1,
      sessionCount: 0,
    },
    extension: { connected: phase === "connected", path: "/extension", profiles: [] },
  };
}

describe("agent-browser bridge routes", () => {
  it("returns no-store sanitized status", async () => {
    const bridge = {
      status: vi.fn(async () => status("waiting_for_extension")),
      start: vi.fn(),
      verify: vi.fn(),
    };
    const app = new Hono();
    registerAgentBrowserRoutes(app, { bridge });

    const response = await app.request("/browser-bridge/status");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ phase: "waiting_for_extension" });
  });

  it("distinguishes a missing extension from a broken runtime during verification", async () => {
    const waiting = status("waiting_for_extension");
    const bridge = {
      status: vi.fn(async () => waiting),
      start: vi.fn(async () => waiting),
      verify: vi.fn(async () => {
        throw new Error("Chrome extension is not connected");
      }),
    };
    const app = new Hono();
    registerAgentBrowserRoutes(app, { bridge });

    const response = await app.request("/browser-bridge/verify", { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Chrome extension is not connected",
      status: { phase: "waiting_for_extension" },
    });
  });

  it("maps bridge startup and runtime verification failures to service availability", async () => {
    const failed = status("error");
    const bridge = {
      status: vi.fn(async () => failed),
      start: vi.fn(async () => failed),
      verify: vi.fn(async () => Promise.reject(new Error("runtime broken"))),
    };
    const app = new Hono();
    registerAgentBrowserRoutes(app, { bridge });

    const started = await app.request("/browser-bridge/start", { method: "POST" });
    const verified = await app.request("/browser-bridge/verify", { method: "POST" });

    expect(started.status).toBe(503);
    expect(verified.status).toBe(503);
    expect(await verified.json()).toMatchObject({ error: "runtime broken" });
  });

  it("exposes session control without page identity and requires a resume summary", async () => {
    const bridge = {
      status: vi.fn(async () => status("connected")),
      start: vi.fn(),
      verify: vi.fn(),
    };
    const state = {
      schemaVersion: 1 as const,
      sessionId: "session-a",
      phase: "human" as const,
      epoch: 2,
      updatedAt: 100,
      reason: "agent_interrupted",
      pendingActionRisk: false,
    };
    const control = {
      get: vi.fn(() => state),
      takeOver: vi.fn(async () => state),
      resume: vi.fn(async (_sessionId: string, summary: string) => ({
        ...state,
        phase: "agent" as const,
        epoch: 3,
        lastHandoff: { summary, resumedAt: 101 },
      })),
      stop: vi.fn(async () => ({ ...state, phase: "stopped" as const, epoch: 3 })),
    };
    const app = new Hono();
    registerAgentBrowserRoutes(app, { bridge, control });

    const current = await app.request("/sessions/session-a/browser-control");
    const missing = await app.request("/sessions/session-a/browser-control/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resumed = await app.request("/sessions/session-a/browser-control/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Completed MFA" }),
    });
    const takeover = await app.request("/sessions/session-a/browser-control/takeover", {
      method: "POST",
    });
    const stopped = await app.request("/sessions/session-a/browser-control/stop", {
      method: "POST",
    });

    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(state);
    expect(missing.status).toBe(400);
    expect(resumed.status).toBe(200);
    expect(takeover.status).toBe(200);
    expect(stopped.status).toBe(200);
    expect(control.resume).toHaveBeenCalledWith("session-a", "Completed MFA");
    expect(await resumed.json()).not.toHaveProperty("url");
  });

  it("maps control conflicts, validation errors, and stop failures", async () => {
    const bridge = {
      status: vi.fn(async () => status("connected")),
      start: vi.fn(),
      verify: vi.fn(),
    };
    const control = {
      get: vi.fn(),
      takeOver: vi.fn(async () => Promise.reject(new Error("already stopped"))),
      resume: vi.fn(async () => Promise.reject(new Error("summary exceeds limit"))),
      stop: vi.fn(async () => Promise.reject(new Error("cleanup failed"))),
    };
    const app = new Hono();
    registerAgentBrowserRoutes(app, { bridge, control });

    const takeover = await app.request("/sessions/session-a/browser-control/takeover", {
      method: "POST",
    });
    const malformed = await app.request("/sessions/session-a/browser-control/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const tooLong = await app.request("/sessions/session-a/browser-control/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "present" }),
    });
    const stopped = await app.request("/sessions/session-a/browser-control/stop", {
      method: "POST",
    });

    expect(takeover.status).toBe(409);
    expect(malformed.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(stopped.status).toBe(503);
  });
});
