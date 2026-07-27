import { describe, expect, it, vi } from "vitest";
import { WsConnectionRegistry } from "./ws-connection-registry.js";

describe("WsConnectionRegistry", () => {
  it("keeps socket, exact runtime context, and scope ownership together", () => {
    const registry = new WsConnectionRegistry();
    const socket = {} as WebSocket;
    const detach = vi.fn();
    registry.attach("session-1", socket, { epoch: 4, contextId: "a".repeat(32) });
    registry.attachScope("session-1", detach);
    expect(registry.get("session-1")).toBe(socket);
    expect(registry.epoch("session-1")).toBe(4);
    expect(registry.context("session-1")).toEqual({
      epoch: 4,
      contextId: "a".repeat(32),
    });
    expect(registry.isCurrent("session-1", socket)).toBe(true);

    expect(registry.remove("session-1", socket)).toBe(true);
    expect(detach).toHaveBeenCalledOnce();
    expect(registry.get("session-1")).toBeUndefined();
  });

  it("ignores stale socket cleanup", () => {
    const registry = new WsConnectionRegistry();
    const current = {} as WebSocket;
    registry.attach("session-1", current);
    expect(registry.remove("session-1", {} as WebSocket)).toBe(false);
    expect(registry.get("session-1")).toBe(current);
  });

  it("releases previous scope ownership on replacement", () => {
    const registry = new WsConnectionRegistry();
    const detach = vi.fn();
    registry.attach("session-1", {} as WebSocket);
    registry.attachScope("session-1", detach);
    registry.attach("session-1", {} as WebSocket);
    expect(detach).toHaveBeenCalledOnce();
  });
});
