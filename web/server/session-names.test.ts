import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAX_SESSION_NAME_BYTES,
  SessionNameStore,
  SessionNameTooLongError,
  getName,
  setName,
  getAllNames,
  removeName,
  isPlaceholderName,
  _resetForTest,
} from "./session-names.js";
import { UserDiskQuota } from "./user-disk-quota.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "session-names-test-"));
  _resetForTest(join(tempDir, "session-names.json"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("session-names", () => {
  it("returns undefined for unknown session", () => {
    expect(getName("unknown")).toBeUndefined();
  });

  it("setName + getName round-trip", () => {
    setName("s1", "Fix auth bug");
    expect(getName("s1")).toBe("Fix auth bug");
  });

  it("persists to disk", () => {
    setName("s1", "My Session");
    const raw = readFileSync(join(tempDir, "session-names.json"), "utf-8");
    const data = JSON.parse(raw).data;
    expect(data).toEqual({ s1: "My Session" });
  });

  it("getAllNames returns a copy of all names", () => {
    setName("s1", "First");
    setName("s2", "Second");
    const all = getAllNames();
    expect(all).toEqual({ s1: "First", s2: "Second" });
    // Verify it's a copy (mutating doesn't affect internal state)
    all.s3 = "Third";
    expect(getName("s3")).toBeUndefined();
  });

  it("removeName deletes a name", () => {
    setName("s1", "Session One");
    removeName("s1");
    expect(getName("s1")).toBeUndefined();
    const raw = readFileSync(join(tempDir, "session-names.json"), "utf-8");
    expect(JSON.parse(raw).data).toEqual({});
  });

  it("overwrites existing name", () => {
    setName("s1", "Old Name");
    setName("s1", "New Name");
    expect(getName("s1")).toBe("New Name");
  });

  it("enforces the session name limit in UTF-8 bytes", () => {
    const store = new SessionNameStore(join(tempDir, "bounded-names.json"));
    const exact = "a".repeat(MAX_SESSION_NAME_BYTES);
    store.setName("exact", exact);
    expect(store.getName("exact")).toBe(exact);

    expect(() => store.setName("too-large", "界".repeat(86))).toThrow(SessionNameTooLongError);
    expect(store.getName("too-large")).toBeUndefined();
  });

  it("reserves the complete atomic JSON temporary-file peak before persisting", async () => {
    const quotaRoot = join(tempDir, "quota-root");
    mkdirSync(quotaRoot, { recursive: true });
    const quota = new UserDiskQuota({ maxBytes: 10_000, reservedHeadroomBytes: 1 });
    quota.addRoot(quotaRoot);
    await quota.reconcile();
    const filePath = join(quotaRoot, "session-names.json");
    const store = new SessionNameStore(filePath, quota);

    store.setName("s1", "磁盘配额");

    expect(quota.snapshot().usedBytes).toBe(readFileSync(filePath).byteLength);
  });

  it("includes a first-time legacy backup in quota admission", async () => {
    const quotaRoot = join(tempDir, "legacy-quota");
    mkdirSync(quotaRoot, { recursive: true });
    const filePath = join(quotaRoot, "session-names.json");
    const legacyNames = { old: "Legacy session" };
    writeFileSync(filePath, JSON.stringify(legacyNames));
    const probe = new AtomicJsonStore<Record<string, string>>(filePath);
    const prepared = probe.prepareWrite({ ...legacyNames, next: "Next session" });
    const existingBytes = statSync(filePath).size;
    const quota = new UserDiskQuota({
      maxBytes: existingBytes + prepared.reservationBytes - 1,
      reservedHeadroomBytes: 1,
    });
    quota.addRoot(quotaRoot);
    await quota.reconcile();
    const store = new SessionNameStore(filePath, quota);

    expect(() => store.setName("next", "Next session")).toThrowError(
      expect.objectContaining({ status: 507 }),
    );
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(legacyNames);
    expect(existsSync(`${filePath}.bak-v0`)).toBe(false);
  });

  it("never exceeds quota and removes stale name metadata after session space is released", async () => {
    const quotaRoot = join(tempDir, "cleanup-at-limit");
    mkdirSync(quotaRoot, { recursive: true });
    const filePath = join(quotaRoot, "session-names.json");
    const sessionDataPath = join(quotaRoot, "session-data.bin");
    const initialStore = new SessionNameStore(filePath);
    initialStore.setName("s1", "First session");
    initialStore.setName("s2", "Second session");
    writeFileSync(sessionDataPath, "x".repeat(2_048));
    const quotaBytes = statSync(filePath).size + statSync(sessionDataPath).size;
    const quota = new UserDiskQuota({
      maxBytes: quotaBytes,
      reservedHeadroomBytes: 1,
    });
    quota.addRoot(quotaRoot);
    await quota.reconcile();
    const quotaStore = new SessionNameStore(filePath, quota);

    expect(() => quotaStore.removeName("s1")).toThrowError(
      expect.objectContaining({ status: 507 }),
    );
    expect(quota.snapshot()).toMatchObject({ usedBytes: quotaBytes, reservedBytes: 0 });
    expect(quota.snapshot().usedBytes + quota.snapshot().reservedBytes).toBeLessThanOrEqual(
      quota.snapshot().maxBytes,
    );
    await expect(quotaStore.removeNameAfterSpaceRelease("s1")).resolves.toBe(false);
    expect(quotaStore.getName("s1")).toBe("First session");
    expect(quota.snapshot().usedBytes + quota.snapshot().reservedBytes).toBeLessThanOrEqual(
      quota.snapshot().maxBytes,
    );

    unlinkSync(sessionDataPath);
    await expect(quotaStore.removeNameAfterSpaceRelease("s1")).resolves.toBe(true);

    expect(quotaStore.getAllNames()).toEqual({ s2: "Second session" });
    expect(quota.snapshot().usedBytes + quota.snapshot().reservedBytes).toBeLessThanOrEqual(
      quota.snapshot().maxBytes,
    );
  });

  it("fails closed without mutating memory or disk when name persistence exceeds quota", async () => {
    const quotaRoot = join(tempDir, "quota-denied");
    mkdirSync(quotaRoot, { recursive: true });
    const quota = new UserDiskQuota({ maxBytes: 64, reservedHeadroomBytes: 1 });
    quota.addRoot(quotaRoot);
    await quota.reconcile();
    const filePath = join(quotaRoot, "session-names.json");
    const store = new SessionNameStore(filePath, quota);

    expect(() => store.setName("s1", "valid name")).toThrowError(
      expect.objectContaining({ status: 507 }),
    );
    expect(store.getName("s1")).toBeUndefined();
    expect(() => readFileSync(filePath)).toThrow();
  });

  it("creates parent directories if needed", () => {
    const nestedPath = join(tempDir, "nested", "dir", "names.json");
    _resetForTest(nestedPath);
    setName("s1", "Deep Session");
    expect(getName("s1")).toBe("Deep Session");
  });

  it("loads existing data from disk on first access", () => {
    // Write data to file before any module access
    writeFileSync(
      join(tempDir, "session-names.json"),
      JSON.stringify({ existing: "Pre-existing Name" }),
    );
    // Reset to re-read from the file
    _resetForTest(join(tempDir, "session-names.json"));
    expect(getName("existing")).toBe("Pre-existing Name");
  });

  it("handles corrupt JSON gracefully", () => {
    writeFileSync(join(tempDir, "session-names.json"), "NOT VALID JSON");
    _resetForTest(join(tempDir, "session-names.json"));
    expect(getName("any")).toBeUndefined();
  });

  it("only treats empty names as placeholders", () => {
    expect(isPlaceholderName(undefined)).toBe(true);
    expect(isPlaceholderName("")).toBe(true);
    expect(isPlaceholderName("未命名")).toBe(false);
    expect(isPlaceholderName("新聊天")).toBe(false);
    expect(isPlaceholderName("ITAgent")).toBe(false);
    expect(isPlaceholderName("Firm Tide")).toBe(false);
  });
});
