import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomicJsonEnvelope } from "./atomic-json-store.js";
import { SessionStore, type OfflineQueueEntry, type PersistedSession } from "./session-store.js";

let tempDir: string;
let store: SessionStore;

function makeSession(id: string, overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    offlineQueue: [],
    processedClientMessageIds: [],
    ...overrides,
  };
}

function makeOfflineEntry(id: string): OfflineQueueEntry {
  return {
    clientMessageId: id,
    queuedAt: 123,
    message: {
      id: `message-${id}`,
      role: "user",
      content: [{ type: "text", text: `prompt ${id}` }],
      timestamp: 122,
    },
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-session-store-test-"));
  store = new SessionStore(tempDir);
});

afterEach(() => {
  store.dispose();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Pi authority persistence", () => {
  it("round-trips only allowed session metadata in a v2 envelope", () => {
    const session = makeSession("s1", {
      authority: {
        tenantId: "tenant",
        userId: "user",
        agentDefinitionId: "agent",
        agentVersionId: "version",
        effectivePolicyHash: "sha256:abc",
      },
      piSessionRelativePath: "pi-sessions/session-1.jsonl",
      offlineQueue: [makeOfflineEntry("client-1")],
      processedClientMessageIds: ["client-0"],
      archived: true,
      archivedAt: 456,
    });

    store.saveSync(session);

    expect(store.load("s1")).toEqual(session);
    const envelope = JSON.parse(
      readFileSync(join(tempDir, "s1.json"), "utf8"),
    ) as AtomicJsonEnvelope<PersistedSession>;
    expect(envelope.schemaVersion).toBe(2);
    expect(Object.keys(envelope.data).sort()).toEqual([
      "archived",
      "archivedAt",
      "authority",
      "id",
      "offlineQueue",
      "piSessionRelativePath",
      "processedClientMessageIds",
    ]);
  });

  it("rejects legacy session state instead of creating a compatibility layer", () => {
    for (const field of [
      "messages",
      "history",
      "messageHistory",
      "pendingPermission",
      "pendingPermissions",
    ]) {
      expect(() =>
        store.saveSync({
          ...makeSession("legacy"),
          [field]: [],
        } as unknown as PersistedSession),
      ).toThrow("Legacy session field is not accepted");
    }
  });

  it("rejects every unknown session.json field", () => {
    expect(() =>
      store.saveSync({
        ...makeSession("unknown"),
        model: { provider: "p", modelId: "m" },
      } as unknown as PersistedSession),
    ).toThrow("Unsupported session.json field: model");
  });

  it("quarantines a legacy authority file on read", () => {
    writeFileSync(
      join(tempDir, "legacy.json"),
      JSON.stringify({
        ...makeSession("legacy"),
        pendingPermissions: [],
      }),
    );

    expect(store.load("legacy")).toBeNull();
    expect(existsSync(join(tempDir, "legacy.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".quarantine"))).toBe(true);
  });

  it("only accepts a direct pi-sessions JSONL relative path", () => {
    for (const invalid of [
      "/tmp/session.jsonl",
      "../pi-sessions/session.jsonl",
      "pi-sessions/nested/session.jsonl",
      "pi-sessions/session.txt",
    ]) {
      expect(() =>
        store.saveSync(makeSession("bad-path", { piSessionRelativePath: invalid })),
      ).toThrow("exact JSONL child");
    }
  });

  it("rejects a persisted id that does not match its filename", () => {
    writeFileSync(join(tempDir, "expected.json"), JSON.stringify(makeSession("different")));
    expect(store.load("expected")).toBeNull();
    expect(existsSync(join(tempDir, "expected.json"))).toBe(false);
  });

  it("returns null for a missing session", () => {
    expect(store.load("missing")).toBeNull();
  });
});

describe("offline delivery and client deduplication", () => {
  beforeEach(() => {
    store.saveSync(makeSession("queue"));
  });

  it("queues a user prompt once and drains it atomically", () => {
    const entry = makeOfflineEntry("client-1");
    expect(store.enqueueOffline("queue", entry)).toBe(true);
    expect(store.enqueueOffline("queue", entry)).toBe(true);
    expect(store.load("queue")?.offlineQueue).toEqual([entry]);

    expect(store.drainOffline("queue")).toEqual([entry]);
    expect(store.load("queue")?.offlineQueue).toEqual([]);
    expect(store.drainOffline("queue")).toEqual([]);
  });

  it("rejects non-user and thinking-only offline messages", () => {
    expect(() =>
      store.enqueueOffline("queue", {
        ...makeOfflineEntry("client-2"),
        message: {
          id: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "no" }],
          timestamp: 1,
        },
      }),
    ).toThrow("user message");
    expect(() =>
      store.enqueueOffline("queue", {
        ...makeOfflineEntry("client-3"),
        message: {
          id: "thinking",
          role: "user",
          content: [{ type: "thinking", thinking: "secret" }],
          timestamp: 1,
        },
      }),
    ).toThrow("Only text and image");
  });

  it("persists processed client ids without duplicates", () => {
    expect(store.markClientMessageProcessed("queue", "client-1")).toBe(true);
    expect(store.markClientMessageProcessed("queue", "client-1")).toBe(true);
    expect(store.markClientMessageProcessed("queue", "client-2")).toBe(true);
    expect(store.load("queue")?.processedClientMessageIds).toEqual(["client-1", "client-2"]);
  });
});

describe("updates, debounce and discovery", () => {
  it("coalesces debounced authority writes and flushes on dispose", () => {
    vi.useFakeTimers();
    try {
      store.save(makeSession("debounced", { processedClientMessageIds: ["first"] }));
      store.save(makeSession("debounced", { processedClientMessageIds: ["second"] }));
      expect(existsSync(join(tempDir, "debounced.json"))).toBe(false);

      store.dispose();
      expect(store.load("debounced")?.processedClientMessageIds).toEqual(["second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and swallows a failed debounced persistence", () => {
    vi.useFakeTimers();
    const saveSync = vi.spyOn(store, "saveSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      store.save(makeSession("failed"));
      expect(() => vi.advanceTimersByTime(150)).not.toThrow();
      expect(saveSync).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates authority, Pi path and archive metadata", () => {
    store.saveSync(makeSession("updates"));
    expect(
      store.setAuthority("updates", {
        tenantId: "t",
        userId: "u",
        agentDefinitionId: "a",
        agentVersionId: "v",
        effectivePolicyHash: "hash",
      }),
    ).toBe(true);
    expect(store.setPiSessionRelativePath("updates", "pi-sessions/real.jsonl")).toBe(true);
    expect(store.setArchived("updates", true)).toBe(true);
    expect(store.load("updates")).toMatchObject({
      piSessionRelativePath: "pi-sessions/real.jsonl",
      archived: true,
      authority: { tenantId: "t" },
    });
    expect(store.setArchived("updates", false)).toBe(true);
    expect(store.load("updates")?.archivedAt).toBeUndefined();
  });

  it("loads flat and session-directory layouts and skips corrupt entries", () => {
    store.saveSync(makeSession("one"));
    store.saveSync(makeSession("two"));
    writeFileSync(join(tempDir, "bad.json"), "not json");
    expect(
      store
        .loadAll()
        .map((session) => session.id)
        .sort(),
    ).toEqual(["one", "two"]);

    const directoryRoot = join(tempDir, "directory-layout");
    const directoryStore = new SessionStore(directoryRoot, { layout: "session-dir" });
    directoryStore.saveSync(makeSession("three"));
    expect(directoryStore.getSessionDirectory("three")).toBe(join(directoryRoot, "three"));
    expect(directoryStore.loadAll().map((session) => session.id)).toEqual(["three"]);
    directoryStore.dispose();
  });
});

describe("removal", () => {
  it("cancels a pending write and removes a flat authority file", () => {
    vi.useFakeTimers();
    try {
      store.save(makeSession("removed"));
      store.remove("removed");
      vi.advanceTimersByTime(300);
      expect(store.hasSessionData("removed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an entire fixed per-session layout including orphan data", () => {
    const directoryStore = new SessionStore(tempDir, { layout: "session-dir" });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const sessionDir = join(tempDir, sessionId);
    mkdirSync(join(sessionDir, "workspace", "nested"), { recursive: true });
    writeFileSync(join(sessionDir, "workspace", "nested", "artifact.txt"), "data");

    expect(directoryStore.hasSessionData(sessionId)).toBe(true);
    expect(directoryStore.removeSessionDirectory(sessionId)).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
    directoryStore.dispose();
  });

  it("rejects traversal before touching the filesystem", () => {
    expect(() => store.load("../escape")).toThrow("Invalid session id");
    expect(() => store.remove("nested/session")).toThrow("Invalid session id");
  });
});
