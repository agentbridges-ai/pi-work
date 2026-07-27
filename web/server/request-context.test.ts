import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  anonymousUserHash,
  getRequestContext,
  registerRequestContext,
  resolveRequestId,
} from "./request-context.js";

describe("request context", () => {
  it("accepts safe request ids and replaces malformed values", () => {
    expect(resolveRequestId("client_request-123")).toBe("client_request-123");
    expect(resolveRequestId("bad id with spaces")).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("correlates handlers and structured errors without exposing internals", async () => {
    const app = new Hono();
    registerRequestContext(app, { getUserId: () => "better-auth-user" });
    app.get("/sessions/session-1/ok", (c) => c.json(getRequestContext()));
    app.get("/fail", () => {
      throw new Error("secret filesystem path /private/data");
    });
    app.get("/legacy", (c) => c.json({ error: "Cannot read /private/data/secret.txt" }, 400));

    const ok = await app.request("/sessions/session-1/ok", {
      headers: {
        "X-Request-ID": "request_12345",
        "X-Piwork-Context-Epoch": "42",
      },
    });
    expect(ok.headers.get("X-Request-ID")).toBe("request_12345");
    expect(await ok.json()).toEqual({
      requestId: "request_12345",
      userHash: anonymousUserHash("better-auth-user"),
      sessionId: "session-1",
      contextEpoch: 42,
    });

    const failed = await app.request("/fail", { headers: { "X-Request-ID": "request_67890" } });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("X-Request-ID")).toBe("request_67890");
    const body = await failed.json();
    expect(body).toMatchObject({
      category: "server",
      code: "internal_error",
      status: 500,
      requestId: "request_67890",
    });
    expect(JSON.stringify(body)).not.toContain("/private/data");

    const legacy = await app.request("/legacy", { headers: { "X-Request-ID": "request_legacy" } });
    expect(await legacy.json()).toEqual({
      category: "validation",
      code: "http_400",
      status: 400,
      requestId: "request_legacy",
      message: "The request was invalid.",
    });
  });
});
