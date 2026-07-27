import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES,
  DEFAULT_USER_DISK_QUOTA_BYTES,
  DiskQuotaExceededError,
  DiskQuotaStateUnavailableError,
  UserDiskQuota,
  withDiskReservation,
  withDiskReservationSync,
} from "./user-disk-quota.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "piwork-disk-quota-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UserDiskQuota", () => {
  it("exports the product defaults", () => {
    expect(DEFAULT_USER_DISK_QUOTA_BYTES).toBe(5 * 1024 * 1024 * 1024);
    expect(DEFAULT_USER_DISK_LAUNCH_HEADROOM_BYTES).toBe(256 * 1024 * 1024);
  });

  it("does not follow symbolic links outside the user roots", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(root, "owned.txt"), "1234");
    writeFileSync(join(outside, "secret.txt"), "x".repeat(100));
    symlinkSync(outside, join(root, "outside"));
    const quota = new UserDiskQuota({ maxBytes: 1_000, reservedHeadroomBytes: 100 });
    quota.addRoot(root);

    expect((await quota.reconcile()).usedBytes).toBe(4);
  });

  it("counts hard-linked files once across nested and tenant roots", async () => {
    const root = makeRoot();
    const tenantRoot = join(root, "tenant");
    mkdirSync(tenantRoot);
    const source = join(root, "source.bin");
    writeFileSync(source, "x".repeat(64));
    linkSync(source, join(tenantRoot, "linked.bin"));
    const quota = new UserDiskQuota({ maxBytes: 1_000, reservedHeadroomBytes: 100 });
    quota.addRoot(root);
    quota.addRoot(tenantRoot);

    expect((await quota.reconcile()).usedBytes).toBe(64);
  });

  it("fails closed until the asynchronous usage cache is initialized", () => {
    const quota = new UserDiskQuota({ maxBytes: 100, reservedHeadroomBytes: 10 });
    quota.addRoot(makeRoot());

    expect(() => quota.snapshot()).toThrow(DiskQuotaStateUnavailableError);
    expect(() => quota.assertLaunchAllowed()).toThrow(DiskQuotaStateUnavailableError);
    expect(() => quota.reserve(1)).toThrow(DiskQuotaStateUnavailableError);
  });

  it("reserves atomic-write peak bytes and releases failed writes", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "existing.bin"), "x".repeat(60));
    const quota = new UserDiskQuota({
      maxBytes: 100,
      reservedHeadroomBytes: 10,
      cacheTtlMs: 60_000,
    });
    quota.addRoot(root);
    await quota.reconcile();

    const reservation = quota.reserve(40);
    expect(quota.snapshot().reservedBytes).toBe(40);
    expect(() => quota.reserve(1)).toThrow(DiskQuotaExceededError);
    reservation.release();
    expect(quota.snapshot().reservedBytes).toBe(0);
  });

  it("accounts committed writes synchronously without rescanning", async () => {
    const root = makeRoot();
    let now = 1;
    const quota = new UserDiskQuota({
      maxBytes: 1_000,
      reservedHeadroomBytes: 100,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    quota.addRoot(root);
    expect((await quota.reconcile()).usedBytes).toBe(0);

    const reservation = quota.reserve(3);
    writeFileSync(join(root, "new.txt"), "123");
    reservation.commit();
    now += 1;

    expect(quota.snapshot().usedBytes).toBe(3);
  });

  it("reserves server-managed writes and conservatively accounts failed operations", async () => {
    const root = makeRoot();
    const quota = new UserDiskQuota({
      maxBytes: 100,
      reservedHeadroomBytes: 10,
      cacheTtlMs: 60_000,
    });
    quota.addRoot(root);
    await quota.reconcile();

    await expect(withDiskReservation(quota, 3, async () => "ok")).resolves.toBe("ok");
    await expect(
      withDiskReservation(quota, 4, async () => {
        throw new Error("partial write may remain");
      }),
    ).rejects.toThrow("partial write may remain");

    expect(quota.snapshot()).toMatchObject({ usedBytes: 7, reservedBytes: 0 });
  });

  it("supports synchronous atomic writes with the same conservative accounting", async () => {
    const root = makeRoot();
    const quota = new UserDiskQuota({ maxBytes: 100, reservedHeadroomBytes: 10 });
    quota.addRoot(root);
    await quota.reconcile();

    expect(withDiskReservationSync(undefined, 2, () => "unmanaged")).toBe("unmanaged");
    expect(withDiskReservationSync(quota, 3, () => "ok")).toBe("ok");
    expect(() =>
      withDiskReservationSync(quota, 4, () => {
        throw new Error("partial sync write may remain");
      }),
    ).toThrow("partial sync write may remain");
    expect(quota.snapshot()).toMatchObject({ usedBytes: 7, reservedBytes: 0 });
  });

  it("blocks launch admission when safety headroom is exhausted", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "large.bin"), "x".repeat(91));
    const quota = new UserDiskQuota({ maxBytes: 100, reservedHeadroomBytes: 10 });
    quota.addRoot(root);
    await quota.reconcile();

    expect(() => quota.assertLaunchAllowed()).toThrow(DiskQuotaExceededError);
  });

  it("fails closed when the last successful asynchronous scan is stale", async () => {
    let now = 1;
    const quota = new UserDiskQuota({
      maxBytes: 100,
      reservedHeadroomBytes: 10,
      cacheTtlMs: 5,
      now: () => now,
    });
    quota.addRoot(makeRoot());
    await quota.reconcile();
    now = 7;

    expect(() => quota.reserve(1)).toThrow(DiskQuotaStateUnavailableError);
    expect(() => quota.assertLaunchAllowed()).toThrow(DiskQuotaStateUnavailableError);
  });

  it("yields the event loop while recursively reconciling a large tree", async () => {
    const root = makeRoot();
    for (let index = 0; index < 500; index += 1) {
      const dir = join(root, `dir-${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, "entry.bin"), "x");
    }
    const quota = new UserDiskQuota({ maxBytes: 10_000, reservedHeadroomBytes: 100 });
    quota.addRoot(root);

    let scanSettled = false;
    const scan = quota.reconcile().finally(() => {
      scanSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(scanSettled).toBe(false);
    await expect(scan).resolves.toMatchObject({ usedBytes: 500 });
  });

  it("coalesces monitor checks and reports only true quota overruns", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "large.bin"), "x".repeat(91));
    const quota = new UserDiskQuota({ maxBytes: 100, reservedHeadroomBytes: 10 });
    quota.addRoot(root);
    const overQuota: number[] = [];
    const monitor = quota.startMonitoring((snapshot) => {
      overQuota.push(snapshot.usedBytes);
    }, 60_000);

    // startMonitoring immediately primes the cache and coalesces callers with
    // that first asynchronous walk.
    const first = monitor.checkNow();
    const second = monitor.checkNow();
    expect(first).toBe(second);
    await first;
    expect(overQuota).toEqual([]);

    writeFileSync(join(root, "overflow.bin"), "x".repeat(10));
    await monitor.checkNow();
    expect(overQuota).toEqual([101]);
    monitor.stop();
  });
});
