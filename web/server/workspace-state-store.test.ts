import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStateStore } from "./workspace-state-store.js";

let tempDirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "workspace-state-"));
  tempDirs.push(dir);
  return join(dir, "workspace-state.json");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("WorkspaceStateStore", () => {
  it("returns an empty canonical snapshot when the file is missing", () => {
    const store = new WorkspaceStateStore(tempFile());

    expect(store.get()).toMatchObject({
      selectedAgentId: "agent",
      currentSessionId: null,
      agentSessionIds: {},
      agentSessionHistoryIds: {},
    });
  });

  it("atomically writes and normalizes agent bindings", () => {
    const path = tempFile();
    const store = new WorkspaceStateStore(path);

    store.bindSession("agent-b", "s1");
    store.bindSession("agent-b", "s2");
    store.bindSession("agent-b", "s1");

    expect(store.get()).toMatchObject({
      selectedAgentId: "agent-b",
      currentSessionId: "s1",
      agentSessionIds: { "agent-b": "s1" },
      agentSessionHistoryIds: { "agent-b": ["s1", "s2"] },
    });
    expect(JSON.parse(readFileSync(path, "utf-8")).data.currentSessionId).toBe("s1");
  });

  it("persists normalized agent user-spaces", () => {
    const store = new WorkspaceStateStore(tempFile());

    const next = store.put({
      agentUserSpaces: {
        agent: [
          {
            mountId: "uw-it",
            name: "Client Files",
            rootName: "Client Files",
            status: "mounted",
            access: "readonly",
            canRead: true,
            canWrite: true,
            permissionState: "granted",
            includeHidden: true,
          },
        ],
        "agent-a": [
          {
            mountId: "",
            name: "bad",
            rootName: "bad",
            status: "mounted",
            access: "readwrite",
            includeHidden: true,
          },
        ],
      },
    });

    expect(next.agentUserSpaces.agent).toEqual([
      expect.objectContaining({
        mountId: "uw-it",
        access: "readonly",
        canRead: true,
        canWrite: false,
        status: "mounted",
      }),
    ]);
    expect(next.agentUserSpaces["agent-a"]).toBeUndefined();
  });

  it("falls back to an empty snapshot when the file is corrupt", () => {
    const path = tempFile();
    writeFileSync(path, "{not-json", "utf-8");

    const store = new WorkspaceStateStore(path);

    expect(store.get().currentSessionId).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(dirname(path), ".quarantine"))).toHaveLength(1);
  });

  it("removes a deleted session from bindings, history, and current session", () => {
    const store = new WorkspaceStateStore(tempFile());
    store.bindSession("agent-a", "s1");

    const next = store.removeSession("s1");

    expect(next.currentSessionId).toBeNull();
    expect(next.agentSessionIds["agent-a"]).toBeUndefined();
    expect(next.agentSessionHistoryIds["agent-a"]).toEqual([]);
  });
});
