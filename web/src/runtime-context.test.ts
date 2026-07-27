import { describe, expect, it, vi } from "vitest";
import { ResourceScope, RuntimeContextCoordinator } from "./runtime-context.js";

describe("ResourceScope", () => {
  it("aborts children and releases each registered resource once", async () => {
    const scope = new ResourceScope();
    const child = scope.child();
    const cleanup = vi.fn();
    child.add(cleanup);

    await scope.dispose();
    await scope.dispose();

    expect(scope.signal.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("immediately releases resources registered after disposal", async () => {
    const scope = new ResourceScope();
    await scope.dispose();
    const cleanup = vi.fn();

    scope.add(cleanup);
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("RuntimeContextCoordinator", () => {
  it("gives same-epoch contexts in separate tabs distinct 128-bit capability ids", () => {
    const firstCoordinator = new RuntimeContextCoordinator();
    const secondCoordinator = new RuntimeContextCoordinator();
    const input = { userId: "u1", agentId: "agent", sessionId: "a" };

    const first = firstCoordinator.activate(input);
    const second = secondCoordinator.activate(input);

    expect(first.context.epoch).toBe(second.context.epoch);
    expect(first.context.contextId).toMatch(/^[a-f0-9]{32}$/);
    expect(second.context.contextId).toMatch(/^[a-f0-9]{32}$/);
    expect(first.context.contextId).not.toBe(second.context.contextId);
    expect(firstCoordinator.isCurrent(first.context)).toBe(true);
    expect(firstCoordinator.isCurrent(second.context)).toBe(false);
  });

  it("increments epoch and aborts only the previous context for same-user switches", () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "a" });
    const second = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "b" });

    expect(second.context.epoch).toBeGreaterThan(first.context.epoch);
    expect(first.scope.signal.aborted).toBe(true);
    expect(first.userScope.signal.aborted).toBe(false);
    expect(coordinator.isCurrent(first.context)).toBe(false);
    expect(coordinator.isCurrent(second.context)).toBe(true);
  });

  it("disposes the complete user scope when the Better Auth user changes", () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "a" });
    const cleanup = vi.fn();
    first.userScope.add(cleanup);

    const second = coordinator.activate({ userId: "u2", agentId: "agent", sessionId: null });

    expect(first.userScope.signal.aborted).toBe(true);
    expect(first.scope.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(second.userScope.signal.aborted).toBe(false);
  });

  it("keeps raw identity stable while replacing the user scope on a tenant switch", () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({
      userId: "u1",
      userScopeKey: '["u1","tenant-a"]',
      agentId: "agent",
      sessionId: "a",
    });

    const second = coordinator.activate({
      userId: "u1",
      userScopeKey: '["u1","tenant-b"]',
      agentId: "agent",
      sessionId: "a",
    });

    expect(second.context.userId).toBe("u1");
    expect(second.context.userScopeKey).toBe('["u1","tenant-b"]');
    expect(first.userScope.signal.aborted).toBe(true);
    expect(second.userScope).not.toBe(first.userScope);
  });

  it("returns an already-disposed operation scope for a stale epoch", () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "a" });
    coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "b" });

    expect(coordinator.operationScope(first.context).signal.aborted).toBe(true);
  });

  it("keeps A active while preparing B and allows only the newest C to commit", () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "a" });
    const second = coordinator.prepare({ userId: "u1", agentId: "agent-a", sessionId: "b" });

    expect(first.scope.signal.aborted).toBe(false);
    expect(coordinator.current()?.context.sessionId).toBe("a");

    const third = coordinator.prepare({ userId: "u1", agentId: "agent-b", sessionId: "c" });
    expect(second.scope.signal.aborted).toBe(true);
    expect(second.commit()).toBe(false);
    expect(third.commit()).toBe(true);
    expect(coordinator.current()?.context.sessionId).toBe("c");
    expect(first.scope.signal.aborted).toBe(true);
    expect(first.userScope.signal.aborted).toBe(false);
  });

  it("retains the previous context when a candidate fails", async () => {
    const coordinator = new RuntimeContextCoordinator();
    const first = coordinator.activate({ userId: "u1", agentId: "agent", sessionId: "a" });
    const candidate = coordinator.prepare({ userId: "u1", agentId: "agent-a", sessionId: "b" });

    await candidate.abort();

    expect(coordinator.current()).toBe(first);
    expect(first.scope.signal.aborted).toBe(false);
    expect(candidate.scope.signal.aborted).toBe(true);
  });
});
