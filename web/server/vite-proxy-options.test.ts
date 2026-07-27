import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { firstHeader, preserveOriginalOriginProxyOptions } from "./vite-config-runtime.js";

function configuredListener() {
  let listener: ((proxyReq: ClientRequest, req: IncomingMessage) => void) | undefined;
  const options = preserveOriginalOriginProxyOptions({ ws: true });
  options.configure({
    on: vi.fn((_event, nextListener) => {
      listener = nextListener;
    }),
  });
  if (!listener) throw new Error("Expected proxy request listener to be registered");
  return { listener, options };
}

describe("Vite proxy options", () => {
  it("preserves the browser Origin header on WebSocket upgrades", () => {
    const { options } = configuredListener();

    expect(options).toMatchObject({
      changeOrigin: true,
      ws: true,
      rewriteWsOrigin: false,
    });
    expect(options.target).toBeTruthy();
  });

  it("does not add WebSocket-only options to the HTTP API proxy", () => {
    expect(preserveOriginalOriginProxyOptions()).not.toHaveProperty("ws");
    expect(preserveOriginalOriginProxyOptions()).not.toHaveProperty("rewriteWsOrigin");
  });

  it("forwards the original host and protocol without trusting a rewritten target", () => {
    const { listener } = configuredListener();
    const setHeader = vi.fn();

    listener(
      { setHeader } as unknown as ClientRequest,
      {
        headers: {
          "x-forwarded-host": ["workbench.example.test", "ignored.example.test"],
          "x-forwarded-proto": "https",
          host: "127.0.0.1:3458",
        },
        socket: {},
      } as unknown as IncomingMessage,
    );

    expect(setHeader).toHaveBeenCalledWith("X-Forwarded-Host", "workbench.example.test");
    expect(setHeader).toHaveBeenCalledWith("X-Forwarded-Proto", "https");
  });

  it("falls back to the request host and encrypted socket protocol", () => {
    const { listener } = configuredListener();
    const setHeader = vi.fn();

    listener(
      { setHeader } as unknown as ClientRequest,
      {
        headers: { host: "localhost:3458" },
        socket: { encrypted: true },
      } as unknown as IncomingMessage,
    );

    expect(setHeader).toHaveBeenCalledWith("X-Forwarded-Host", "localhost:3458");
    expect(setHeader).toHaveBeenCalledWith("X-Forwarded-Proto", "https");
  });

  it("normalizes absent and array-valued headers", () => {
    expect(firstHeader(undefined)).toBe("");
    expect(firstHeader([])).toBe("");
    expect(firstHeader(["first", "second"])).toBe("first");
    expect(firstHeader("single")).toBe("single");
  });
});
