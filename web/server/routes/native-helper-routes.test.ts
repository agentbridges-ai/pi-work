import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { NativeHelperService } from "../native-helper.js";
import { registerNativeHelperRoutes } from "./native-helper-routes.js";

function fixture() {
  const service = {
    status: vi.fn(async () => ({
      supported: true,
      installed: true,
      connected: true,
      compatible: true,
      helperVersion: "0.1.0",
      protocolVersion: 1,
      platformVersion: "macOS test",
      capabilities: ["file.share", "file.nativeEdit"],
      latestVersion: "0.2.0",
      updateAvailable: true,
      upgradeCommand: "upgrade",
      lastError: null,
    })),
    createFileAction: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "session-a",
      action: "file.nativeEdit",
      filename: "AGENTS.md",
      source: { space: "agent", path: "AGENTS.md" },
      baselineSha256: "a".repeat(64),
      managedSha256: "a".repeat(64),
      state: "editing",
      createdAt: "2026-07-30T00:00:00.000Z",
    })),
    reclaimFileAction: vi.fn(async () => ({
      operation: {
        id: "00000000-0000-4000-8000-000000000001",
        sessionId: "session-a",
        action: "file.nativeEdit",
        filename: "AGENTS.md",
        source: { space: "agent", path: "AGENTS.md" },
        baselineSha256: "a".repeat(64),
        managedSha256: "b".repeat(64),
        state: "ready-to-reclaim",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
      bytes: new TextEncoder().encode("changed"),
      managedSha256: "b".repeat(64),
      changed: true,
    })),
    cancelFileAction: vi.fn(async () => undefined),
  };
  const api = new Hono();
  registerNativeHelperRoutes(api, {
    service: service as unknown as NativeHelperService,
  });
  return { api, service };
}

describe("native helper routes", () => {
  it("returns helper status without caching it", async () => {
    const { api, service } = fixture();
    const response = await api.request("/native-helper/status?refresh=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
      updateAvailable: true,
    });
    expect(service.status).toHaveBeenCalledWith({ refreshLatest: true });
  });

  it("accepts a bounded managed file action without returning a host path", async () => {
    const { api, service } = fixture();
    const response = await api.request(
      `/sessions/session-a/native-file-actions?${new URLSearchParams({
        action: "file.nativeEdit",
        filename: "AGENTS.md",
        space: "agent",
        path: "AGENTS.md",
        baselineSha256: "a".repeat(64),
      })}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "source",
      },
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("/Users/");
    expect(service.createFileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-a",
        action: "file.nativeEdit",
        filename: "AGENTS.md",
        bytes: expect.any(Uint8Array),
        source: expect.objectContaining({ space: "agent", path: "AGENTS.md" }),
      }),
    );
  });

  it("streams reclaimed bytes and deletes only the bound session operation", async () => {
    const { api, service } = fixture();
    const operationId = "00000000-0000-4000-8000-000000000001";
    const reclaimed = await api.request(
      `/sessions/session-a/native-file-actions/${operationId}/reclaim`,
      { method: "POST" },
    );
    expect(reclaimed.status).toBe(200);
    expect(await reclaimed.text()).toBe("changed");
    expect(reclaimed.headers.get("X-Piwork-Native-Changed")).toBe("true");

    const cancelled = await api.request(`/sessions/session-a/native-file-actions/${operationId}`, {
      method: "DELETE",
    });
    expect(cancelled.status).toBe(200);
    expect(service.cancelFileAction).toHaveBeenCalledWith(operationId, "session-a", "local-user");
  });

  it("rejects User Space actions without a browser-owned mount id", async () => {
    const { api, service } = fixture();
    const response = await api.request(
      "/sessions/session-a/native-file-actions?action=file.open&filename=x&space=user&path=x",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "x",
      },
    );
    expect(response.status).toBe(400);
    expect(service.createFileAction).not.toHaveBeenCalled();
  });
});
