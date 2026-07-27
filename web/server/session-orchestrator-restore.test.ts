import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionOrchestrator } from "./session-orchestrator.js";
import { SessionStore } from "./session-store.js";
import { WsBridge } from "./ws-bridge.js";

const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("inactive Pi session restoration", () => {
  it("projects model, thinking and mode from the validated Pi JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-orchestrator-restore-"));
    roots.push(root);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionDir = join(root, sessionId);
    const workspace = join(sessionDir, "workspace");
    const piSessions = join(sessionDir, "pi-sessions");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(piSessions, { recursive: true });

    const records = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: workspace,
      },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "local",
        modelId: "model-restored",
      },
      {
        type: "thinking_level_change",
        id: "thinking",
        parentId: "model",
        timestamp: "2026-01-01T00:00:02.000Z",
        thinkingLevel: "high",
      },
      {
        type: "custom",
        id: "mode",
        parentId: "thinking",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "piwork.mode",
        data: { mode: "plan" },
      },
    ];
    writeFileSync(
      join(piSessions, "conversation.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const store = new SessionStore(root, { layout: "session-dir" });
    stores.push(store);
    store.saveSync({
      id: sessionId,
      piSessionRelativePath: "pi-sessions/conversation.jsonl",
      offlineQueue: [],
      processedClientMessageIds: [],
    });
    const bridge = new WsBridge();
    const restoreSession = vi.fn();
    const orchestrator = new SessionOrchestrator({
      launcher: { restoreSession } as never,
      wsBridge: bridge,
      sessionStore: store,
      buildLaunchOptions: vi.fn() as never,
    });

    orchestrator.initialize();

    expect(restoreSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        model: {
          key: "local/model-restored",
          provider: "local",
          modelId: "model-restored",
        },
        thinkingLevel: "high",
        mode: "plan",
      }),
    );
    expect(bridge.getSession(sessionId)?.state).toMatchObject({
      model: {
        key: "local/model-restored",
        provider: "local",
        modelId: "model-restored",
      },
      thinkingLevel: "high",
      mode: "plan",
    });
  });
});
