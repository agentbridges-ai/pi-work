// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginRuntimeContextTransition } from "./runtime-context-switch.js";
import { runtimeContextCoordinator } from "./runtime-context.js";
import { api } from "./api.js";
import { registerOfficeContextGate } from "./office-context-gate.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await runtimeContextCoordinator.dispose();
  runtimeContextCoordinator.activate({ userId: "user-a", agentId: "agent", sessionId: "a" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtimeContextCoordinator.dispose();
});

describe("runtime context transition", () => {
  it("runs a registered Office save gate before activating the next session", async () => {
    const gate = vi.fn().mockResolvedValue(undefined);
    const unregister = registerOfficeContextGate(gate);
    const activation = vi.spyOn(api, "activateSession").mockResolvedValue({ ok: true } as never);

    const transition = beginRuntimeContextTransition({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "b",
    });

    await expect(transition.commit(() => undefined)).resolves.toBe(true);
    expect(gate).toHaveBeenCalledWith({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "b",
    });
    expect(gate.mock.invocationCallOrder[0]).toBeLessThan(activation.mock.invocationCallOrder[0]);
    unregister();
  });

  it("commits only C when A→B→C preparation resolves out of order", async () => {
    const commits: string[] = [];
    const bActivation = deferred<unknown>();
    const cActivation = deferred<unknown>();
    let bSignal: AbortSignal | undefined;
    vi.spyOn(api, "activateSession").mockImplementation((sessionId, options) => {
      if (sessionId === "b") {
        bSignal = options?.signal;
        return bActivation.promise as ReturnType<typeof api.activateSession>;
      }
      return cActivation.promise as ReturnType<typeof api.activateSession>;
    });
    const second = beginRuntimeContextTransition({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "b",
    });
    const secondCommit = second.commit(() => commits.push("b"));
    await vi.waitFor(() =>
      expect(api.activateSession).toHaveBeenCalledWith("b", expect.any(Object)),
    );

    const third = beginRuntimeContextTransition({
      userId: "user-a",
      agentId: "agent-b",
      sessionId: "c",
    });
    const thirdCommit = third.commit(() => commits.push("c"));
    await vi.waitFor(() =>
      expect(api.activateSession).toHaveBeenCalledWith("c", expect.any(Object)),
    );

    cActivation.resolve({ ok: true });
    expect(await thirdCommit).toBe(true);
    bActivation.resolve({ ok: true });
    expect(await secondCommit).toBe(false);
    expect(bSignal?.aborted).toBe(true);
    expect(commits).toEqual(["c"]);
    expect(runtimeContextCoordinator.current()?.context.sessionId).toBe("c");
  });

  it("keeps A active when activation fails before commit", async () => {
    vi.spyOn(api, "activateSession").mockRejectedValue(new Error("activation failed"));
    const apply = vi.fn();
    const oldContextCleanup = vi.fn();
    runtimeContextCoordinator.current()?.scope.add(oldContextCleanup);
    const transition = beginRuntimeContextTransition({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "b",
    });

    await expect(transition.commit(apply)).rejects.toThrow("activation failed");
    expect(apply).not.toHaveBeenCalled();
    expect(oldContextCleanup).not.toHaveBeenCalled();
    expect(runtimeContextCoordinator.current()?.context.sessionId).toBe("a");
  });

  it("releases old context sockets, workers, iframes, and timers only after commit", async () => {
    vi.spyOn(api, "activateSession").mockResolvedValue({ ok: true } as never);
    const socketCleanup = vi.fn();
    const workerCleanup = vi.fn();
    const iframeCleanup = vi.fn();
    const timerCleanup = vi.fn();
    const oldScope = runtimeContextCoordinator.current()!.scope;
    oldScope.add(socketCleanup);
    oldScope.add(workerCleanup);
    oldScope.add(iframeCleanup);
    oldScope.add(timerCleanup);
    const transition = beginRuntimeContextTransition({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "b",
    });

    expect(socketCleanup).not.toHaveBeenCalled();
    expect(await transition.commit(() => undefined)).toBe(true);
    await vi.waitFor(() => expect(socketCleanup).toHaveBeenCalledTimes(1));
    expect(workerCleanup).toHaveBeenCalledTimes(1);
    expect(iframeCleanup).toHaveBeenCalledTimes(1);
    expect(timerCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous context when candidate preparation is cancelled", async () => {
    const transition = beginRuntimeContextTransition(
      {
        userId: "user-a",
        agentId: "agent-a",
        sessionId: "b",
      },
      { activateSession: false },
    );
    await transition.cancel();

    expect(await transition.commit(() => undefined)).toBe(false);
    expect(runtimeContextCoordinator.current()?.context.sessionId).toBe("a");
  });
});
