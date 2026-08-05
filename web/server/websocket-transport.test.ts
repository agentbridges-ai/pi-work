import { describe, expect, it } from "vitest";
import {
  BROWSER_WS_MAX_MESSAGE_BYTES,
  RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES,
  WEBSOCKET_IDLE_TIMEOUT_SECONDS,
  websocketTransportLimits,
} from "./websocket-transport.js";

describe("WebSocket transport limits", () => {
  it("caps the shared Bun listener at the established 8 MiB CLI boundary", () => {
    expect(RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES).toBe(8 * 1024 * 1024);
    expect(websocketTransportLimits()).toEqual({
      maxPayloadLength: RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES,
      idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,
      sendPings: true,
    });
  });

  it("keeps the browser semantic limit narrower than the shared transport", () => {
    expect(BROWSER_WS_MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(BROWSER_WS_MAX_MESSAGE_BYTES).toBeLessThan(RUNTIME_TRANSPORT_MAX_MESSAGE_BYTES);
  });
});
