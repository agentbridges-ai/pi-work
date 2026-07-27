import { describe, expect, it, vi } from "vitest";
import { ScopedLatestWriteCoordinator } from "./scoped-latest-write-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("ScopedLatestWriteCoordinator", () => {
  it("serializes preference saves and exposes only the latest response", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const write = vi
      .fn<(value: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSavingChange = vi.fn();
    const coordinator = new ScopedLatestWriteCoordinator({
      write,
      onSuccess,
      onError,
      onSavingChange,
    });

    coordinator.enqueue("user-a", "preference-a");
    coordinator.enqueue("user-a", "preference-b");
    expect(write).toHaveBeenCalledTimes(1);

    first.resolve("old-response");
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      "preference-b",
      expect.objectContaining({ scopeKey: "user-a" }),
    );
    expect(onSuccess).not.toHaveBeenCalled();

    second.resolve("latest-response");
    await coordinator.whenIdle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith("latest-response", "preference-b", "user-a");
    expect(onError).not.toHaveBeenCalled();
    expect(onSavingChange.mock.calls).toEqual([
      [true, "user-a"],
      [false, "user-a"],
    ]);
  });

  it("ignores an older error when a newer preference is queued", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const write = vi
      .fn<(value: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const coordinator = new ScopedLatestWriteCoordinator({ write, onSuccess, onError });

    coordinator.enqueue("user-a", "old");
    coordinator.enqueue("user-a", "latest");
    first.reject(new Error("old failure"));
    await Promise.resolve();
    await Promise.resolve();
    second.resolve("saved");
    await coordinator.whenIdle();

    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith("saved", "latest", "user-a");
  });

  it("cancels the old scope and never applies its late response", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const signals: AbortSignal[] = [];
    const write = vi
      .fn<(value: string, context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce((_value, context) => {
        signals.push(context.signal);
        return first.promise;
      })
      .mockImplementationOnce((_value, context) => {
        signals.push(context.signal);
        return second.promise;
      });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const coordinator = new ScopedLatestWriteCoordinator({ write, onSuccess, onError });

    coordinator.enqueue("tenant-a", "tenant-a-preference");
    coordinator.setScope("tenant-b");
    coordinator.enqueue("tenant-b", "tenant-b-preference");
    expect(signals[0]?.aborted).toBe(true);

    first.resolve("stale-tenant-response");
    await Promise.resolve();
    await Promise.resolve();
    second.resolve("current-tenant-response");
    await coordinator.whenIdle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(
      "current-tenant-response",
      "tenant-b-preference",
      "tenant-b",
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
