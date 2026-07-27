import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiRpcTransport } from "./pi-rpc-transport.js";
import {
  PiReadinessError,
  waitForPiReadiness,
  type PiExtensionReadyState,
} from "./pi-readiness.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-pi-ready-"));
  roots.push(root);
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, "{}\n", { mode: 0o600 });
  const transport = {
    sessionId: "session-1",
    getState: vi.fn(async () => ({
      sessionId: "session-1",
      sessionFile,
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 0,
    })),
    getAvailableModels: vi.fn(async () => [{ provider: "openai", id: "gpt-5" }]),
    replayHistory: vi.fn(async () => ({
      entries: [
        {
          type: "model_change",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          provider: "openai",
          modelId: "gpt-5",
        },
      ],
      leafId: "entry-1",
    })),
    getCommands: vi.fn(async () => [{ name: "piwork-plan" }]),
  } as unknown as PiRpcTransport;
  const extension: PiExtensionReadyState = {
    version: 1,
    mode: "plan",
    mcp: [
      { name: "files", status: "connected" },
      { name: "disabled", status: "disabled" },
    ],
  };
  return { sessionFile, transport, extension };
}

describe("Pi readiness", () => {
  it("waits for state, models, exact history, extension, and MCP", async () => {
    const value = await fixture();
    const result = await waitForPiReadiness({
      transport: value.transport,
      expectedSessionFile: value.sessionFile,
      expectedMode: "plan",
      extensionReady: Promise.resolve(value.extension),
      getMcpStatus: async () => [
        { name: "files", status: "connected" },
        { name: "disabled", status: "disabled" },
      ],
    });
    expect(result.models).toEqual([{ provider: "openai", id: "gpt-5" }]);
    expect(value.transport.replayHistory).toHaveBeenCalledTimes(1);
  });

  it("reads the managed MCP snapshot only after the extension is ready", async () => {
    const value = await fixture();
    let resolveExtension!: (state: PiExtensionReadyState) => void;
    const extensionReady = new Promise<PiExtensionReadyState>((resolve) => {
      resolveExtension = resolve;
    });
    const getMcpStatus = vi.fn(async () => [
      { name: "files", status: "connected" as const },
      { name: "disabled", status: "disabled" as const },
    ]);

    const readiness = waitForPiReadiness({
      transport: value.transport,
      expectedMode: "plan",
      extensionReady,
      getMcpStatus,
    });
    await Promise.resolve();
    expect(getMcpStatus).not.toHaveBeenCalled();

    resolveExtension(value.extension);
    await expect(readiness).resolves.toMatchObject({ extension: value.extension });
    expect(getMcpStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects a resume replay that does not contain the exact JSONL prefix", async () => {
    const value = await fixture();
    await expect(
      waitForPiReadiness({
        transport: value.transport,
        expectedMode: "plan",
        expectedHistoryEntries: [
          {
            type: "model_change",
            id: "entry-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            provider: "openai",
            modelId: "different",
          },
        ],
        extensionReady: Promise.resolve(value.extension),
        getMcpStatus: async () => [
          { name: "files", status: "connected" },
          { name: "disabled", status: "disabled" },
        ],
      }),
    ).rejects.toMatchObject({ code: "history_mismatch" });
  });

  it("rejects mode or MCP mismatches", async () => {
    const value = await fixture();
    await expect(
      waitForPiReadiness({
        transport: value.transport,
        expectedMode: "agent",
        extensionReady: Promise.resolve(value.extension),
        getMcpStatus: async () => [
          { name: "files", status: "connecting" },
          { name: "disabled", status: "disabled" },
        ],
      }),
    ).rejects.toBeInstanceOf(PiReadinessError);
    await expect(
      waitForPiReadiness({
        transport: value.transport,
        expectedMode: "plan",
        extensionReady: Promise.resolve({
          ...value.extension,
          mcp: [
            { name: "files", status: "failed" },
            { name: "disabled", status: "disabled" },
          ],
        }),
        getMcpStatus: async () => [
          { name: "files", status: "failed" },
          { name: "disabled", status: "disabled" },
        ],
      }),
    ).rejects.toMatchObject({ code: "mcp_unavailable" });
  });

  it("fails closed when any readiness component exceeds the deadline", async () => {
    const value = await fixture();
    await expect(
      waitForPiReadiness({
        transport: value.transport,
        expectedMode: "plan",
        extensionReady: new Promise(() => undefined),
        getMcpStatus: async () => [],
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("uses one overall deadline across extension and MCP readiness", async () => {
    vi.useFakeTimers();
    try {
      const value = await fixture();
      const extensionReady = new Promise<PiExtensionReadyState>((resolve) => {
        setTimeout(() => resolve(value.extension), 20);
      });
      const pending = waitForPiReadiness({
        transport: value.transport,
        expectedMode: "plan",
        extensionReady,
        getMcpStatus: () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve([
                  { name: "files", status: "connected" },
                  { name: "disabled", status: "disabled" },
                ]),
              20,
            );
          }),
        timeoutMs: 30,
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(30);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
