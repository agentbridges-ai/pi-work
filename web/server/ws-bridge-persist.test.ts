import { describe, expect, it, vi } from "vitest";
import { WsBridge } from "./ws-bridge.js";
import { persistSession, serializeForStore } from "./ws-bridge-persist.js";

describe("Pi bridge persistence boundary", () => {
  it("serializes only authority, archive, Pi path, offline queue, and de-duplication", () => {
    const bridge = new WsBridge();
    const session = bridge.restoreSession(
      {
        sessionId: "session-1",
        state: "exited",
        thinkingLevel: "high",
        mode: "plan",
        cwd: "/tmp/session-1/workspace",
        createdAt: 1,
        backendType: "pi",
        transport: "pi-rpc",
        generation: 4,
        piVersion: "0.82.1",
        piSessionRelativePath: "pi-sessions/session.jsonl",
      },
      {
        id: "session-1",
        authority: {
          tenantId: "tenant-1",
          userId: "user-1",
          membershipId: "membership-1",
          orgNodeId: "org-root",
          agentDefinitionId: "agent-1",
          agentVersionId: "version-1",
          effectivePolicyHash: "policy-1",
        },
        piSessionRelativePath: "pi-sessions/session.jsonl",
        offlineQueue: [
          {
            clientMessageId: "client-1",
            queuedAt: 1,
            message: {
              id: "client-1",
              role: "user",
              content: [{ type: "text", text: "queued" }],
              timestamp: 1,
            },
          },
        ],
        processedClientMessageIds: ["client-1"],
        archived: true,
        archivedAt: 2,
      },
    );
    session.eventBuffer.push({
      seq: 1,
      message: {
        type: "run_state",
        state: "ready",
        generation: 4,
        timestamp: 1,
      },
    });
    session.interactionKinds.set("ask-1", {
      kind: "ask",
      method: "input",
      optionValues: new Map(),
      generation: 4,
      request: {
        id: "ask-1",
        kind: "ask",
        toolCallId: "tool-1",
        questions: [],
      },
    });
    const serialized = serializeForStore(session);
    expect(serialized).toEqual({
      id: "session-1",
      authority: session.authority,
      piSessionRelativePath: "pi-sessions/session.jsonl",
      offlineQueue: session.offlineQueue,
      processedClientMessageIds: ["client-1"],
      archived: true,
      archivedAt: 2,
    });
    expect(Object.keys(serialized).sort()).toEqual([
      "archived",
      "archivedAt",
      "authority",
      "id",
      "offlineQueue",
      "piSessionRelativePath",
      "processedClientMessageIds",
    ]);

    const queuedPart = session.offlineQueue[0]!.message.content[0] as {
      type: "text";
      text: string;
    };
    queuedPart.text = "mutated after serialization";
    session.processedClientMessageIds.push("client-2");
    expect(
      (serialized.offlineQueue[0]!.message.content[0] as { type: "text"; text: string }).text,
    ).toBe("queued");
    expect(serialized.processedClientMessageIds).toEqual(["client-1"]);
  });

  it("persists the authority-only snapshot and safely no-ops without a store", () => {
    const bridge = new WsBridge();
    const session = bridge.restoreSession(
      {
        sessionId: "session-2",
        state: "exited",
        thinkingLevel: "medium",
        mode: "agent",
        cwd: "/tmp/session-2/workspace",
        createdAt: 1,
        backendType: "pi",
        transport: "pi-rpc",
        generation: 1,
        piVersion: "0.82.1",
      },
      {
        id: "session-2",
        offlineQueue: [],
        processedClientMessageIds: [],
      },
    );
    expect(() => persistSession(session, null)).not.toThrow();
    const save = vi.fn();
    persistSession(session, { save } as never);
    expect(save).toHaveBeenCalledWith({
      id: "session-2",
      authority: undefined,
      piSessionRelativePath: undefined,
      offlineQueue: [],
      processedClientMessageIds: [],
      archived: undefined,
      archivedAt: undefined,
    });
  });
});
