import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppOperationOutboxRecord } from "./apps-types.js";
import { AppsOutboxWorker, type AppsOutboxWorkerDependencies } from "./apps-outbox-worker.js";

function record(overrides: Partial<AppOperationOutboxRecord> = {}): AppOperationOutboxRecord {
  return {
    id: "outbox-1",
    appId: "app-1",
    tenantId: "tenant-1",
    operation: "deploy",
    payload: {
      userId: "user-1",
      membershipId: "membership-1",
      deploymentId: "deployment-1",
      target: "byoc",
      connectionId: "connection-1",
      temporaryAccountId: null,
    },
    appGeneration: 4,
    idempotencyKey: "deploy:key",
    attempts: 1,
    leaseOwner: "worker",
    leaseUntil: "2026-08-04T00:00:30.000Z",
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<AppsOutboxWorkerDependencies> = {},
): AppsOutboxWorkerDependencies {
  return {
    claim: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(true),
    retry: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AppsOutboxWorker", () => {
  it("runs and completes a strictly projected deployment operation", async () => {
    const item = record({ operation: "rollback" });
    const deps = dependencies({ claim: vi.fn().mockResolvedValue([item]) });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-1" });

    await expect(worker.pollOnce()).resolves.toBe(1);

    expect(deps.claim).toHaveBeenCalledWith("worker-1", 10, 30_000);
    expect(deps.run).toHaveBeenCalledWith(
      { tenantId: "tenant-1", userId: "user-1", membershipId: "membership-1" },
      {
        appId: "app-1",
        deploymentId: "deployment-1",
        appGeneration: 4,
        phase: "queued",
        target: "byoc",
        connectionId: "connection-1",
        temporaryAccountId: null,
      },
      expect.any(AbortSignal),
    );
    expect(deps.complete).toHaveBeenCalledWith("outbox-1", "worker-1");
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("returns runner failures to the durable retry/backoff handler", async () => {
    const failure = new Error("provider unavailable");
    const deps = dependencies({
      claim: vi.fn().mockResolvedValue([record()]),
      run: vi.fn().mockRejectedValue(failure),
    });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-2" });

    await expect(worker.pollOnce()).resolves.toBe(1);

    expect(deps.retry).toHaveBeenCalledWith("outbox-1", "worker-2", failure);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("coalesces concurrent wakeups into one claim and execution", async () => {
    let releaseClaim!: (records: AppOperationOutboxRecord[]) => void;
    const claimed = new Promise<AppOperationOutboxRecord[]>((resolve) => {
      releaseClaim = resolve;
    });
    const deps = dependencies({ claim: vi.fn(() => claimed) });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-singleflight" });

    const first = worker.pollOnce();
    const second = worker.pollOnce();
    expect(first).toBe(second);
    expect(deps.claim).toHaveBeenCalledOnce();

    releaseClaim([record()]);
    await expect(first).resolves.toBe(1);
    expect(deps.run).toHaveBeenCalledOnce();
  });

  it("fails malformed and unsupported records closed without running them", async () => {
    const malformed = record({
      id: "outbox-malformed",
      payload: {
        userId: "user-1",
        membershipId: "membership-1",
        deploymentId: "deployment-1",
        target: "temporary",
        connectionId: null,
        temporaryAccountId: "temporary-1",
        leakedToken: "must-not-be-accepted",
      },
    });
    const unsupported = record({ id: "outbox-domain", operation: "domain_set" });
    const deps = dependencies({ claim: vi.fn().mockResolvedValue([malformed, unsupported]) });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-3" });

    await expect(worker.pollOnce()).resolves.toBe(2);

    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledTimes(2);
    expect(deps.fail).toHaveBeenNthCalledWith(
      1,
      malformed,
      "worker-3",
      expect.objectContaining({ message: "Apps outbox payload has missing or unknown fields." }),
    );
    expect(deps.fail).toHaveBeenNthCalledWith(
      2,
      unsupported,
      "worker-3",
      expect.objectContaining({
        message: "Apps outbox worker only accepts deploy and rollback operations.",
      }),
    );
  });

  it("rejects an unsafe App generation before coordinator execution", async () => {
    const unsafe = record({ appGeneration: Number.MAX_SAFE_INTEGER + 1 });
    const deps = dependencies({ claim: vi.fn().mockResolvedValue([unsafe]) });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-generation" });

    await expect(worker.pollOnce()).resolves.toBe(1);

    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith(
      unsafe,
      "worker-generation",
      expect.objectContaining({
        message: "Apps outbox record appGeneration must be a positive safe integer.",
      }),
    );
  });

  it("stops polling and does not schedule another claim", async () => {
    vi.useFakeTimers();
    const deps = dependencies();
    const worker = new AppsOutboxWorker(deps, {
      workerId: "worker-4",
      pollIntervalMs: 50,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.claim).toHaveBeenCalledTimes(1);

    await worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.claim).toHaveBeenCalledTimes(1);
  });

  it("releases active and unstarted claims when a cooperative runner is stopped", async () => {
    vi.useFakeTimers();
    const first = record({ id: "outbox-active" });
    const second = record({ id: "outbox-unstarted" });
    const deps = dependencies({
      claim: vi.fn().mockResolvedValue([first, second]),
      run: vi.fn(
        (_context, _deployment, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("stopped", "AbortError")),
              { once: true },
            );
          }),
      ),
    });
    const worker = new AppsOutboxWorker(deps, { workerId: "worker-stop" });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.run).toHaveBeenCalledOnce();

    await worker.stop();
    expect(deps.retry).toHaveBeenCalledTimes(2);
    expect(deps.retry).toHaveBeenNthCalledWith(
      1,
      "outbox-active",
      "worker-stop",
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(deps.retry).toHaveBeenNthCalledWith(
      2,
      "outbox-unstarted",
      "worker-stop",
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(deps.complete).not.toHaveBeenCalled();
  });
});
