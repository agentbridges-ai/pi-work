import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AtomicJsonEnvelope } from "./atomic-json-store.js";
import { OperationJournal, type JournalOperation } from "./operation-journal.js";

describe("OperationJournal", () => {
  let root: string;
  let journal: OperationJournal;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piwork-journal-"));
    journal = new OperationJournal(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists durable envelope records with private permissions", () => {
    const operation = journal.begin(
      "quarantine-session",
      [{ type: "mkdir", path: ".quarantine/sessions" }],
      "operation-1",
    );

    const path = join(root, ".operations", `${operation.id}.json`);
    const envelope = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as AtomicJsonEnvelope<JournalOperation>;
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      data: { id: "operation-1", status: "pending", nextStep: 0 },
    });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, ".operations")).mode & 0o777).toBe(0o700);
    }
  });

  it("executes and replays multi-step moves idempotently", () => {
    mkdirSync(join(root, "source"));
    writeFileSync(join(root, "source", "one.json"), "one");
    writeFileSync(join(root, "source", "two.json"), "two");
    const operation = journal.begin(
      "move-pair",
      [
        { type: "mkdir", path: ".quarantine/state" },
        { type: "move-if-exists", from: "source/one.json", to: ".quarantine/state/one.json" },
        { type: "move-if-exists", from: "source/two.json", to: ".quarantine/state/two.json" },
      ],
      "operation-2",
    );

    const completed = journal.execute(operation.id);
    expect(completed.status).toBe("completed");
    expect(completed.nextStep).toBe(3);
    expect(readFileSync(join(root, ".quarantine/state/one.json"), "utf-8")).toBe("one");
    expect(readFileSync(join(root, ".quarantine/state/two.json"), "utf-8")).toBe("two");

    expect(journal.execute(operation.id)).toMatchObject({ status: "completed", nextStep: 3 });
    expect(journal.replayIncomplete().alreadyCompleted).toContain(operation.id);
    expect(journal.get(operation.id)).toBeNull();
  });

  it("recovers when a move happened before its checkpoint was written", () => {
    mkdirSync(join(root, "source"));
    mkdirSync(join(root, ".quarantine/state"), { recursive: true });
    writeFileSync(join(root, "source", "first"), "first");
    writeFileSync(join(root, "source", "second"), "second");
    const operation = journal.begin(
      "interrupted-move",
      [
        { type: "move-if-exists", from: "source/first", to: ".quarantine/state/first" },
        { type: "move-if-exists", from: "source/second", to: ".quarantine/state/second" },
      ],
      "operation-3",
    );

    // Model a crash after rename(2) succeeded but before nextStep was persisted.
    renameSync(join(root, "source/first"), join(root, ".quarantine/state/first"));

    const replay = journal.replayIncomplete();
    expect(replay.completed).toEqual([operation.id]);
    expect(readFileSync(join(root, ".quarantine/state/first"), "utf-8")).toBe("first");
    expect(readFileSync(join(root, ".quarantine/state/second"), "utf-8")).toBe("second");
    expect(journal.get(operation.id)).toMatchObject({ status: "completed", nextStep: 2 });
  });

  it("restores a backup with an atomic copy while retaining the source", () => {
    mkdirSync(join(root, "session"));
    writeFileSync(join(root, "session/state.json.bak-v0"), "legacy");
    const operation = journal.begin(
      "recover-backup",
      [
        {
          type: "copy-file-if-missing",
          from: "session/state.json.bak-v0",
          to: "session/state.json",
        },
      ],
      "operation-4",
    );

    journal.execute(operation.id);
    expect(readFileSync(join(root, "session/state.json"), "utf-8")).toBe("legacy");
    expect(readFileSync(join(root, "session/state.json.bak-v0"), "utf-8")).toBe("legacy");
    expect(journal.execute(operation.id).status).toBe("completed");
  });

  it("rejects traversal before a journal record is created", () => {
    expect(() =>
      journal.begin(
        "escape",
        [{ type: "move-if-exists", from: "../outside", to: ".quarantine/outside" }],
        "operation-5",
      ),
    ).toThrow(/relative|traversal/);
    expect(existsSync(join(root, ".operations/operation-5.json"))).toBe(false);
  });

  it("never overwrites an existing move destination", () => {
    writeFileSync(join(root, "source"), "source");
    writeFileSync(join(root, "destination"), "destination");
    const operation = journal.begin(
      "conflict",
      [{ type: "move-if-exists", from: "source", to: "destination" }],
      "operation-6",
    );

    expect(() => journal.execute(operation.id)).toThrow(/destination already exists/);
    expect(readFileSync(join(root, "source"), "utf-8")).toBe("source");
    expect(readFileSync(join(root, "destination"), "utf-8")).toBe("destination");
    expect(journal.get(operation.id)).toMatchObject({ status: "failed", nextStep: 0 });
  });

  it("rejects a destination whose parent symlink escapes the user root", () => {
    const outside = mkdtempSync(join(tmpdir(), "piwork-journal-outside-"));
    try {
      writeFileSync(join(root, "source"), "source");
      symlinkSync(outside, join(root, "escape"));
      const operation = journal.begin(
        "symlink-escape",
        [{ type: "move-if-exists", from: "source", to: "escape/destination" }],
        "operation-7",
      );

      expect(() => journal.execute(operation.id)).toThrow(/symbolic link/);
      expect(readFileSync(join(root, "source"), "utf-8")).toBe("source");
      expect(existsSync(join(outside, "destination"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt journal record instead of applying it", () => {
    writeFileSync(join(root, ".operations/broken.json"), "{not-json");

    expect(journal.replayIncomplete()).toEqual({
      completed: [],
      failed: [],
      alreadyCompleted: [],
      quarantined: ["broken"],
    });
    expect(existsSync(join(root, ".operations/broken.json"))).toBe(false);
    expect(readdirSync(join(root, ".operations/.quarantine"))).toHaveLength(1);
  });
});
