import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_RESOURCE_LIMITS,
  ResourceLimitError,
  UserResourceGovernor,
} from "./resource-governor.js";

describe("UserResourceGovernor", () => {
  it("uses the product defaults for one Better Auth user across runtimes", () => {
    const governor = new UserResourceGovernor();

    expect(DEFAULT_USER_RESOURCE_LIMITS).toEqual({
      maxConcurrentSessions: 4,
      maxManagedProcesses: 8,
    });
    expect(governor.snapshot()).toMatchObject({ sessionLimit: 4, processLimit: 8 });
  });

  it("atomically rejects a third concurrent Pi session", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 2,
      maxManagedProcesses: 4,
    });
    const first = governor.reservePiProcess("session-a", "session-a:1");
    const second = governor.reservePiProcess("session-b", "session-b:1");

    expect(() => governor.reservePiProcess("session-c", "session-c:1")).toThrow(ResourceLimitError);
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 2,
      managedProcesses: 2,
    });

    first.release();
    second.release();
  });

  it("counts overlapping generations as one session and two processes", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 1,
      maxManagedProcesses: 2,
    });
    const oldGeneration = governor.reservePiProcess("session-a", "session-a:1");
    const newGeneration = governor.reservePiProcess("session-a", "session-a:2");

    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 1,
      managedProcesses: 2,
    });
    oldGeneration.release();
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 1,
      managedProcesses: 1,
    });
    newGeneration.release();
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 0,
      managedProcesses: 0,
    });
  });

  it("shares capacity between Pi process groups", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 2,
      maxManagedProcesses: 2,
    });
    const pi = governor.reservePiProcess("tenant-a:session-a", "tenant-a:session-a:1");
    const task = governor.reserveManagedProcess("pi-task", "tenant-b:task-a");

    expect(() => governor.reservePiProcess("tenant-b:session-b", "tenant-b:session-b:1")).toThrow(
      ResourceLimitError,
    );
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 1,
      managedProcesses: 2,
    });

    pi.release();
    task.release();
  });

  it("rolls back the session slot when process capacity is exhausted", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 2,
      maxManagedProcesses: 1,
    });
    const task = governor.reserveManagedProcess("pi-task", "task-b");

    expect(() => governor.reservePiProcess("session-a", "session-a:1")).toThrow(/process limit/i);
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 0,
      managedProcesses: 1,
    });

    task.release();
  });

  it("makes releases idempotent", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 1,
      maxManagedProcesses: 1,
    });
    const lease = governor.reservePiProcess("session-a", "session-a:1");

    lease.release();
    lease.release();

    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 0,
      managedProcesses: 0,
    });
  });

  it("accounts for already-running Pi processes beyond configured limits", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 1,
      maxManagedProcesses: 1,
    });
    const admitted = governor.reservePiProcess("session-a", "session-a:1");

    const firstExisting = governor.accountForExistingPiProcess("session-b", "session-b:1");
    const secondExisting = governor.accountForExistingPiProcess("session-c", "session-c:1");

    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 3,
      managedProcesses: 3,
      sessionLimit: 1,
      processLimit: 1,
    });

    secondExisting.release();
    firstExisting.release();
    admitted.release();
  });

  it("blocks normal admission while existing-process debt remains and reopens after release", () => {
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 4,
      maxManagedProcesses: 4,
    });
    const existing = governor.accountForExistingPiProcess("restored-session", "restored-session:1");

    expect(() => governor.reserveSession("session-a")).toThrow(ResourceLimitError);
    expect(() => governor.reserveManagedProcess("pi-task", "task-b")).toThrow(ResourceLimitError);
    expect(() => governor.reservePiProcess("session-b", "session-b:1")).toThrow(ResourceLimitError);
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 1,
      managedProcesses: 1,
    });

    existing.release();
    existing.release();

    const session = governor.reserveSession("session-a");
    const task = governor.reserveManagedProcess("pi-task", "task-b");
    const pi = governor.reservePiProcess("session-b", "session-b:1");
    expect(governor.snapshot()).toMatchObject({
      concurrentSessions: 2,
      managedProcesses: 2,
    });

    pi.release();
    task.release();
    session.release();
  });

  it("validates limits and owner identifiers", () => {
    expect(
      () => new UserResourceGovernor({ maxConcurrentSessions: 0, maxManagedProcesses: 1 }),
    ).toThrow(/positive integer/i);
    const governor = new UserResourceGovernor({
      maxConcurrentSessions: 1,
      maxManagedProcesses: 1,
    });
    expect(() => governor.reserveSession("   ")).toThrow(/sessionId/i);
  });
});
