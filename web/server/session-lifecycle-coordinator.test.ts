import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";

describe("SessionLifecycleCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks independent session epochs and rejects superseded work", () => {
    const lifecycle = new SessionLifecycleCoordinator();
    const signal = lifecycle.signal;

    expect(lifecycle.currentEpoch("one")).toBe(0);
    expect(lifecycle.bumpEpoch("one")).toBe(1);
    expect(lifecycle.bumpEpoch("two")).toBe(1);
    expect(lifecycle.isCurrent("one", 1, signal)).toBe(true);

    expect(lifecycle.bumpEpoch("one")).toBe(2);
    expect(lifecycle.isCurrent("one", 1, signal)).toBe(false);
    expect(lifecycle.isCurrent("two", 1, signal)).toBe(true);
  });

  it("cancels delays and ordinary timeouts during shutdown", async () => {
    const lifecycle = new SessionLifecycleCoordinator();
    const callback = vi.fn();
    const delayed = lifecycle.delay(10_000);
    lifecycle.setTimeout(callback, 10_000);

    lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(delayed).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("restarts with a fresh abort signal after shutdown", async () => {
    const lifecycle = new SessionLifecycleCoordinator();
    const oldSignal = lifecycle.signal;
    lifecycle.bumpEpoch("session");
    lifecycle.shutdown();

    lifecycle.resume();
    const delayed = lifecycle.delay(25);
    await vi.advanceTimersByTimeAsync(25);

    expect(lifecycle.signal).not.toBe(oldSignal);
    expect(oldSignal.aborted).toBe(true);
    expect(lifecycle.isCurrent("session", 0, oldSignal)).toBe(false);
    await expect(delayed).resolves.toBe(true);
  });

  it("replaces and cancels session-scoped timeouts", async () => {
    const lifecycle = new SessionLifecycleCoordinator();
    const first = vi.fn();
    const second = vi.fn();

    lifecycle.setSessionTimeout("session", first, 10);
    lifecycle.setSessionTimeout("session", second, 20);
    await vi.advanceTimersByTimeAsync(20);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    lifecycle.setSessionTimeout("session", second, 20);
    lifecycle.cancelSessionTimeout("session");
    await vi.advanceTimersByTimeAsync(20);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
