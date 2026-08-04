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
    listFileActions: vi.fn(async () => []),
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

  it("parses User Space metadata and complete anchor rectangles", async () => {
    const { api, service } = fixture();
    const query = new URLSearchParams({
      action: "file.open",
      filename: "report.pdf",
      space: "user",
      path: "documents/report.pdf",
      mountId: "mount-1",
      baselineSha256: "A".repeat(64),
      baselineMtime: "12.5",
      x: "1",
      y: "2",
      width: "640",
      height: "480",
    });
    const response = await api.request(`/sessions/session-a/native-file-actions?${query}`, {
      method: "POST",
      body: "pdf",
    });
    expect(response.status).toBe(202);
    expect(service.createFileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          space: "user",
          path: "documents/report.pdf",
          mountId: "mount-1",
          baselineSha256: "a".repeat(64),
          baselineMtime: 12.5,
        },
        anchor: { x: 1, y: 2, width: 640, height: 480 },
      }),
    );
    await expect(api.request("/sessions/session-a/native-file-actions")).resolves.toMatchObject({
      status: 200,
    });
    expect(service.listFileActions).toHaveBeenCalledWith("local-user", "session-a");
  });

  it("rejects malformed native action metadata and maps service outages", async () => {
    const { api, service } = fixture();
    const base = "filename=x&space=agent&path=x";
    for (const suffix of [
      "action=not-supported",
      "action=file.open&baselineSha256=bad",
      "action=file.open&x=1",
      "action=file.open&x=bad&y=2&width=3&height=4",
    ]) {
      const response = await api.request(
        `/sessions/session-a/native-file-actions?${base}&${suffix}`,
        {
          method: "POST",
          body: "x",
        },
      );
      expect(response.status).toBe(400);
    }
    service.listFileActions.mockRejectedValueOnce(new Error("helper unavailable"));
    const unavailable = await api.request("/sessions/session-a/native-file-actions");
    expect(unavailable.status).toBe(503);
    service.reclaimFileAction.mockRejectedValueOnce(new Error("operation timed out"));
    const timedOut = await api.request(
      "/sessions/session-a/native-file-actions/operation/reclaim",
      { method: "POST" },
    );
    expect(timedOut.status).toBe(503);
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
