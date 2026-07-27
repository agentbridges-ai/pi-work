import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRoutes } from "../routes.js";
import type { SocketData } from "../ws-bridge.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CONTEXT_A = "a".repeat(32);
const CONTEXT_B = "b".repeat(32);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function browserSocket(contextEpoch: number, contextId: string): ServerWebSocket<SocketData> {
  return {
    data: {
      kind: "browser",
      sessionId: SESSION_ID,
      protocolVersion: 1,
      contextEpoch,
      contextId,
    },
  } as ServerWebSocket<SocketData>;
}

function fixture() {
  const originalSocket = browserSocket(1, CONTEXT_A);
  const session = {
    id: SESSION_ID,
    backendType: "claude",
    browserSockets: new Set<ServerWebSocket<SocketData>>([originalSocket]),
    state: { user_space: null, user_spaces: [] },
  };
  const configureSession = vi.fn(() => ({ mounts: [] }));
  const setUserSpaces = vi.fn();
  const injectSystemPrompt = vi.fn();
  const wsBridge = {
    getSession: (sessionId: string) => (sessionId === SESSION_ID ? session : undefined),
    setUserSpaces,
    injectSystemPrompt,
  };
  const app = new Hono();
  app.route(
    "/api",
    createRoutes(
      { hasSessionData: () => false } as never,
      { getSession: () => undefined } as never,
      wsBridge as never,
      undefined,
      undefined,
      { configureSession } as never,
    ),
  );
  return { app, configureSession, originalSocket, session, setUserSpaces };
}

describe("User Space configuration browser context", () => {
  it("rejects a slow request when its exact browser socket is replaced before commit", async () => {
    const { app, configureSession, originalSocket, session, setUserSpaces } = fixture();
    const sameEpochOtherTab = browserSocket(1, CONTEXT_B);
    session.browserSockets.add(sameEpochOtherTab);
    const parserNeedsMoreBody = deferred();
    const releaseBody = deferred();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"userSpace":'));
      },
      async pull(controller) {
        parserNeedsMoreBody.resolve();
        await releaseBody.promise;
        controller.enqueue(encoder.encode("null}"));
        controller.close();
      },
    });

    const responsePromise = app.fetch(
      new Request(`http://localhost/api/sessions/${SESSION_ID}/user-space/configure`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Piwork-Context-Epoch": "1",
          "X-Piwork-Context-Id": CONTEXT_A,
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    await parserNeedsMoreBody.promise;
    session.browserSockets.delete(originalSocket);
    releaseBody.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Stale browser runtime context" });
    expect(configureSession).not.toHaveBeenCalled();
    expect(setUserSpaces).not.toHaveBeenCalled();
    expect(session.state).toEqual({ user_space: null, user_spaces: [] });
  });

  it("rejects an epoch that is not attached to the active browser session", async () => {
    const { app, configureSession } = fixture();
    const response = await app.request(`/api/sessions/${SESSION_ID}/user-space/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Piwork-Context-Epoch": "2",
        "X-Piwork-Context-Id": CONTEXT_A,
      },
      body: JSON.stringify({ userSpace: null }),
    });

    expect(response.status).toBe(409);
    expect(configureSession).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON instead of interpreting it as an unmount", async () => {
    const { app, configureSession, setUserSpaces } = fixture();
    const response = await app.request(`/api/sessions/${SESSION_ID}/user-space/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Piwork-Context-Epoch": "1",
        "X-Piwork-Context-Id": CONTEXT_A,
      },
      body: '{"userSpace":',
    });

    expect(response.status).toBe(400);
    expect(configureSession).not.toHaveBeenCalled();
    expect(setUserSpaces).not.toHaveBeenCalled();
  });

  it("rejects partial context headers and no-header requests while negotiated sockets exist", async () => {
    const { app, configureSession } = fixture();
    const path = `/api/sessions/${SESSION_ID}/user-space/configure`;

    const partial = await app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Piwork-Context-Epoch": "1",
      },
      body: JSON.stringify({ userSpace: null }),
    });
    const missing = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userSpace: null }),
    });

    expect(partial.status).toBe(409);
    expect(missing.status).toBe(409);
    expect(configureSession).not.toHaveBeenCalled();
  });

  it("keeps the no-header legacy path only when no negotiated socket exists", async () => {
    const { app, configureSession, session } = fixture();
    session.browserSockets.clear();

    const response = await app.request(`/api/sessions/${SESSION_ID}/user-space/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userSpace: null }),
    });

    expect(response.status).toBe(200);
    expect(configureSession).toHaveBeenCalledOnce();
  });
});
