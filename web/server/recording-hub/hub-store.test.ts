import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Mock PIWORK_HOME before importing hub-store
const TEST_HOME = join(tmpdir(), `hub-test-${randomBytes(4).toString("hex")}`);
vi.mock("../paths.js", () => ({ PIWORK_HOME: TEST_HOME }));

// Must import after mock
const { HubStore } = await import("./hub-store.js");
const { UserDiskQuota } = await import("../user-disk-quota.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRecordingContent(options?: { sessionId?: string; entries?: number }): string {
  const sessionId = options?.sessionId ?? "test-session";
  const entryCount = options?.entries ?? 3;

  const header = JSON.stringify({
    _header: true,
    version: 2,
    session_id: sessionId,
    backend_type: "pi",
    transport: "pi-rpc",
    started_at: 1000000,
    cwd: "/test/dir",
  });

  const entries: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    entries.push(
      JSON.stringify({
        ts: 1000000 + i * 1000,
        dir: "out",
        raw: JSON.stringify({
          type: "agent_message",
          generation: 1,
          message: {
            id: `message-${i}`,
            role: i === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `message ${i}` }],
            timestamp: 1000000 + i * 1000,
          },
        }),
        ch: "browser",
      }),
    );
  }

  return [header, ...entries].join("\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HubStore", () => {
  beforeEach(() => {
    // Ensure clean test directory
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
    mkdirSync(join(TEST_HOME, "hub", "recordings"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  });

  describe("importContent", () => {
    it("imports valid JSONL content and returns metadata", () => {
      const store = new HubStore();
      const content = makeRecordingContent();
      const meta = store.importContent(content, "test.jsonl");

      expect(meta.id).toBeTruthy();
      expect(meta.sessionId).toBe("test-session");
      expect(meta.backendType).toBe("pi");
      expect(meta.entryCount).toBe(3);
      expect(meta.filename).toBe("test.jsonl");
      expect(meta.tags).toEqual([]);
    });

    it("rejects empty content", () => {
      const store = new HubStore();
      expect(() => store.importContent("")).toThrow("empty");
    });

    it("rejects invalid header", () => {
      const store = new HubStore();
      expect(() => store.importContent('{"version": 2}')).toThrow("Invalid Pi recording header");
    });

    it("rejects invalid backend_type", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 2,
        session_id: "s",
        backend_type: "invalid",
        transport: "pi-rpc",
        started_at: 0,
        cwd: "/",
      });
      expect(() => store.importContent(header)).toThrow("Invalid Pi recording header");
    });

    it("rejects malformed entry JSON", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 2,
        session_id: "s",
        backend_type: "pi",
        transport: "pi-rpc",
        started_at: 0,
        cwd: "/",
      });
      expect(() => store.importContent(header + "\n{not json}")).toThrow("Malformed JSON");
    });
  });

  describe("list", () => {
    it("returns empty array when no recordings", () => {
      const store = new HubStore();
      expect(store.list()).toEqual([]);
    });

    it("returns all imported recordings", () => {
      const store = new HubStore();
      store.importContent(makeRecordingContent({ sessionId: "s1" }));
      store.importContent(makeRecordingContent({ sessionId: "s2" }));

      const list = store.list();
      expect(list).toHaveLength(2);
      const sessionIds = list.map((m) => m.sessionId);
      expect(sessionIds).toContain("s1");
      expect(sessionIds).toContain("s2");
    });
  });

  describe("get", () => {
    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns meta for known id", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      expect(store.get(meta.id)).toEqual(meta);
    });
  });

  describe("delete", () => {
    it("returns false for unknown id", () => {
      const store = new HubStore();
      expect(store.delete("nonexistent")).toBe(false);
    });

    it("removes recording and returns true", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      expect(store.delete(meta.id)).toBe(true);
      expect(store.get(meta.id)).toBeNull();
      expect(store.list()).toHaveLength(0);
    });
  });

  describe("updateTags", () => {
    it("updates tags on existing recording", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent());
      const updated = store.updateTags(meta.id, ["regression", "pi-rpc"]);
      expect(updated?.tags).toEqual(["regression", "pi-rpc"]);
    });

    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.updateTags("nonexistent", ["tag"])).toBeNull();
    });
  });

  describe("loadRecording", () => {
    it("loads full recording content", () => {
      const store = new HubStore();
      const meta = store.importContent(makeRecordingContent({ entries: 5 }));
      const recording = store.loadRecording(meta.id);
      expect(recording).not.toBeNull();
      expect(recording!.header.session_id).toBe("test-session");
      expect(recording!.entries).toHaveLength(5);
    });

    it("returns null for unknown id", () => {
      const store = new HubStore();
      expect(store.loadRecording("nonexistent")).toBeNull();
    });
  });

  describe("getSummary", () => {
    it("returns summary with Pi tools and interaction count", () => {
      const store = new HubStore();
      const header = JSON.stringify({
        _header: true,
        version: 2,
        session_id: "s",
        backend_type: "pi",
        transport: "pi-rpc",
        started_at: 0,
        cwd: "/",
      });
      const entries = [
        JSON.stringify({
          ts: 100,
          dir: "out",
          raw: JSON.stringify({
            type: "tool_execution",
            generation: 1,
            toolCallId: "tool-1",
            toolName: "bash",
            status: "started",
            timestamp: 100,
          }),
          ch: "browser",
        }),
        JSON.stringify({
          ts: 200,
          dir: "out",
          raw: JSON.stringify({
            type: "tool_execution",
            generation: 1,
            toolCallId: "tool-2",
            toolName: "edit",
            status: "completed",
            timestamp: 200,
          }),
          ch: "browser",
        }),
        JSON.stringify({
          ts: 300,
          dir: "out",
          raw: JSON.stringify({
            type: "interaction_request",
            generation: 1,
            request: {
              id: "ask-1",
              kind: "ask",
              toolCallId: "tool-3",
              prompt: "Choose",
            },
            timestamp: 300,
          }),
          ch: "browser",
        }),
      ];
      const content = [header, ...entries].join("\n");
      const meta = store.importContent(content);
      const summary = store.getSummary(meta.id);

      expect(summary).not.toBeNull();
      expect(summary!.toolNames).toEqual(["bash", "edit"]);
      expect(summary!.interactionCount).toBe(1);
    });
  });

  describe("importLocal", () => {
    it("copies a recording file from the auto-recordings directory", () => {
      const store = new HubStore();
      // Create a source file in a temp location
      const sourceDir = join(TEST_HOME, "recordings");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "source.jsonl");
      writeFileSync(sourcePath, makeRecordingContent());

      const meta = store.importLocal(sourcePath);
      expect(meta.sessionId).toBe("test-session");
      // Source file should still exist (copy, not move)
      expect(existsSync(sourcePath)).toBe(true);
      // Hub file should exist
      expect(existsSync(store.recordingPath(meta.id))).toBe(true);
    });
  });

  describe("persistence", () => {
    it("persists index across HubStore instances", () => {
      // Import with first store
      const store1 = new HubStore();
      const meta = store1.importContent(makeRecordingContent());

      // Load with second store instance
      const store2 = new HubStore();
      expect(store2.get(meta.id)).toBeTruthy();
      expect(store2.get(meta.id)!.sessionId).toBe("test-session");
    });
  });

  describe("tenant isolation and disk quota", () => {
    it("keeps explicitly scoped hub indexes and recordings isolated", () => {
      const userA = join(TEST_HOME, "tenant-a", "user-a", "recording-hub");
      const userB = join(TEST_HOME, "tenant-b", "user-a", "recording-hub");
      const storeA = new HubStore({ baseDir: userA });
      const storeB = new HubStore({ baseDir: userB });

      const imported = storeA.importContent(makeRecordingContent({ sessionId: "private-a" }));

      expect(storeA.get(imported.id)?.sessionId).toBe("private-a");
      expect(storeB.list()).toEqual([]);
      expect(storeA.recordingPath(imported.id)).toContain(userA);
      expect(storeB.recordingPath(imported.id)).toContain(userB);
      expect(existsSync(storeB.recordingPath(imported.id))).toBe(false);
    });

    it("reserves both recording bytes and the atomic index temporary-file peak", async () => {
      const baseDir = join(TEST_HOME, "quota-allowed");
      mkdirSync(baseDir, { recursive: true });
      const quota = new UserDiskQuota({ maxBytes: 100_000, reservedHeadroomBytes: 1 });
      quota.addRoot(baseDir);
      await quota.reconcile();
      const store = new HubStore({ baseDir, diskQuota: quota });

      const meta = store.importContent(makeRecordingContent());

      const persistedBytes =
        statSync(store.recordingPath(meta.id)).size + statSync(join(baseDir, "index.json")).size;
      expect(quota.snapshot().usedBytes).toBe(persistedBytes);
    });

    it("includes the first legacy index backup in the import reservation", async () => {
      const baseDir = join(TEST_HOME, "legacy-index-quota");
      mkdirSync(join(baseDir, "recordings"), { recursive: true });
      const indexPath = join(baseDir, "index.json");
      writeFileSync(indexPath, "[]");
      const legacyIndexBytes = statSync(indexPath).size;
      const quota = new UserDiskQuota({ maxBytes: 100_000, reservedHeadroomBytes: 1 });
      quota.addRoot(baseDir);
      await quota.reconcile();
      const reserve = vi.spyOn(quota, "reserve");
      const store = new HubStore({ baseDir, diskQuota: quota });
      const content = makeRecordingContent();

      const meta = store.importContent(content);

      expect(reserve).toHaveBeenCalledWith(
        Buffer.byteLength(content) + statSync(indexPath).size + legacyIndexBytes,
      );
      expect(statSync(`${indexPath}.bak-v0`).size).toBe(legacyIndexBytes);
      expect(statSync(store.recordingPath(meta.id)).size).toBe(Buffer.byteLength(content));
    });

    it("returns a 507 admission error before leaving a recording or index behind", async () => {
      const baseDir = join(TEST_HOME, "quota-denied");
      mkdirSync(baseDir, { recursive: true });
      const quota = new UserDiskQuota({ maxBytes: 64, reservedHeadroomBytes: 1 });
      quota.addRoot(baseDir);
      await quota.reconcile();
      const store = new HubStore({ baseDir, diskQuota: quota });

      expect(() => store.importContent(makeRecordingContent())).toThrowError(
        expect.objectContaining({ status: 507 }),
      );
      expect(store.list()).toEqual([]);
      expect(readdirSync(join(baseDir, "recordings"))).toEqual([]);
      expect(existsSync(join(baseDir, "index.json"))).toBe(false);
    });
  });
});
