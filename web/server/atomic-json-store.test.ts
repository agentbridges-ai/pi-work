import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AtomicJsonConflictError,
  AtomicJsonStore,
  atomicJsonFileMode,
  type AtomicJsonEnvelope,
} from "./atomic-json-store.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-json-"));
  path = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AtomicJsonStore", () => {
  it("writes a versioned envelope with monotonically increasing revisions", () => {
    const store = new AtomicJsonStore<{ value: string }>(path);

    const first = store.write({ value: "one" });
    const second = store.write({ value: "two" });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(store.readValue()).toEqual({ value: "two" });
    const disk = JSON.parse(readFileSync(path, "utf-8")) as AtomicJsonEnvelope<{ value: string }>;
    expect(disk).toMatchObject({ schemaVersion: 1, revision: 2, data: { value: "two" } });
    if (process.platform !== "win32") expect(atomicJsonFileMode(path)).toBe(0o600);
  });

  it("estimates the exact UTF-8 byte size of the next serialized write", () => {
    const store = new AtomicJsonStore<{ value: string }>(path);
    const value = { value: "多语言 session 🚀" };

    const estimatedBytes = store.estimateSerializedWriteBytes(value);
    store.write(value);

    expect(statSync(path).size).toBe(estimatedBytes);
  });

  it("prepares the complete legacy-backup plus temporary-file quota peak", () => {
    const legacy = JSON.stringify({ value: "legacy 多语言" });
    writeFileSync(path, legacy, "utf-8");
    const store = new AtomicJsonStore<{ value: string }>(path);

    const prepared = store.prepareWrite({ value: "current 🚀" });
    expect(prepared.legacyBackupBytes).toBe(Buffer.byteLength(legacy));
    expect(prepared.reservationBytes).toBe(prepared.serializedBytes + Buffer.byteLength(legacy));

    prepared.commit();

    expect(statSync(path).size).toBe(prepared.serializedBytes);
    expect(statSync(`${path}.bak-v0`).size).toBe(prepared.legacyBackupBytes);
    expect(statSync(path).size + statSync(`${path}.bak-v0`).size).toBe(prepared.reservationBytes);
  });

  it("normalizes only once between quota preparation and commit", () => {
    let normalizeCalls = 0;
    const store = new AtomicJsonStore<{ value: string }>(path, {
      normalize: (value) => ({
        value: `${(value as { value: string }).value}:${++normalizeCalls}`,
      }),
    });

    const prepared = store.prepareWrite({ value: "stable" });
    expect(normalizeCalls).toBe(1);
    const envelope = prepared.commit();

    expect(normalizeCalls).toBe(1);
    expect(envelope.data).toEqual({ value: "stable:1" });
    expect(JSON.parse(readFileSync(path, "utf-8")).data).toEqual({ value: "stable:1" });
  });

  it("reads legacy JSON and keeps a one-time backup when upgrading", () => {
    writeFileSync(path, JSON.stringify({ value: "legacy" }), "utf-8");
    const store = new AtomicJsonStore<{ value: string }>(path);

    expect(store.read()).toMatchObject({ value: { value: "legacy" }, legacy: true });
    store.write({ value: "current" });

    expect(JSON.parse(readFileSync(`${path}.bak-v0`, "utf-8"))).toEqual({ value: "legacy" });
    expect(store.readValue()).toEqual({ value: "current" });
  });

  it("quarantines corrupt JSON instead of overwriting it", () => {
    writeFileSync(path, "{broken", "utf-8");
    const store = new AtomicJsonStore(path, { defaultValue: () => ({ value: "default" }) });

    expect(store.readValue()).toEqual({ value: "default" });
    expect(existsSync(path)).toBe(false);
    const quarantine = join(dir, ".quarantine");
    expect(readdirSync(quarantine)).toHaveLength(1);
    expect(readFileSync(join(quarantine, readdirSync(quarantine)[0]), "utf-8")).toBe("{broken");
  });

  it("rejects stale compare-and-swap revisions", () => {
    const store = new AtomicJsonStore<{ value: string }>(path);
    store.write({ value: "one" });

    expect(() => store.write({ value: "stale" }, { expectedRevision: 0 })).toThrow(
      AtomicJsonConflictError,
    );
    expect(store.readValue()).toEqual({ value: "one" });
  });

  it("removes abandoned temporary files during construction", () => {
    writeFileSync(join(dir, ".state.json.tmp-123"), "partial", "utf-8");

    new AtomicJsonStore(path);

    expect(existsSync(join(dir, ".state.json.tmp-123"))).toBe(false);
  });
});
