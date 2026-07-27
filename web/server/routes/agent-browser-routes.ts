import type { Hono } from "hono";
import type {
  AgentBrowserBridgeService,
  AgentBrowserBridgeStatus,
  AgentBrowserVerification,
} from "../agent-browser-bridge-service.js";
import type { BrowserControlState } from "../browser-control-session.js";

export interface AgentBrowserBridgeApi {
  status(): Promise<AgentBrowserBridgeStatus>;
  start(): Promise<AgentBrowserBridgeStatus>;
  verify(): Promise<AgentBrowserVerification>;
}

export interface AgentBrowserControlApi {
  get(sessionId: string): BrowserControlState;
  takeOver(sessionId: string): Promise<BrowserControlState>;
  resume(sessionId: string, summary: string): Promise<BrowserControlState>;
  stop(sessionId: string): Promise<BrowserControlState>;
}

export function registerAgentBrowserRoutes(
  api: Hono,
  deps: {
    bridge: AgentBrowserBridgeApi | AgentBrowserBridgeService;
    control?: AgentBrowserControlApi;
  },
): void {
  api.get("/browser-bridge/status", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json(await deps.bridge.status());
  });

  api.post("/browser-bridge/start", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    const status = await deps.bridge.start();
    return c.json(status, status.phase === "error" ? 503 : 200);
  });

  api.post("/browser-bridge/verify", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    try {
      return c.json(await deps.bridge.verify());
    } catch (error) {
      const status = await deps.bridge.status();
      return c.json(
        {
          error: error instanceof Error ? error.message : "Browser verification failed",
          status,
        },
        status.phase === "waiting_for_extension" ? 409 : 503,
      );
    }
  });

  if (!deps.control) return;

  api.get("/sessions/:id/browser-control", (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json(deps.control!.get(c.req.param("id")));
  });

  api.post("/sessions/:id/browser-control/takeover", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    try {
      return c.json(await deps.control!.takeOver(c.req.param("id")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  api.post("/sessions/:id/browser-control/resume", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    const body: { summary?: unknown } = await c.req.json().catch(() => ({}));
    if (typeof body.summary !== "string" || !body.summary.trim()) {
      return c.json({ error: "A handoff summary is required" }, 400);
    }
    try {
      return c.json(await deps.control!.resume(c.req.param("id"), body.summary));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, message.includes("exceeds") ? 400 : 409);
    }
  });

  api.post("/sessions/:id/browser-control/stop", async (c) => {
    c.header("Cache-Control", "no-store, max-age=0");
    try {
      return c.json(await deps.control!.stop(c.req.param("id")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
    }
  });
}
