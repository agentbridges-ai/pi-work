import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserDataReconciler } from "./user-data-reconciler.js";

function sessionData(id: string) {
  return {
    id,
    state: { session_id: id },
  };
}

function quarantineEntries(root: string, bucket: "sessions" | "state"): string[] {
  const directory = join(root, ".quarantine", bucket);
  return existsSync(directory) ? readdirSync(directory) : [];
}

describe("UserDataReconciler", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "piwork-reconcile-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves a valid Pi session using session.json as product authority", () => {
    const id = "normal-session";
    mkdirSync(join(root, id));
    const persisted = JSON.stringify(sessionData(id));
    writeFileSync(join(root, id, "session.json"), persisted);

    const report = new UserDataReconciler(root).reconcile();

    expect(report.validSessions).toBe(1);
    expect(report.quarantinedSessions).toBe(0);
    expect(readFileSync(join(root, id, "session.json"), "utf-8")).toBe(persisted);
    expect(quarantineEntries(root, "sessions")).toEqual([]);
  });

  it("restores a valid backup and quarantines only the corrupt current JSON", () => {
    const id = "backup-session";
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "session.json"), "{broken");
    writeFileSync(join(root, id, "session.json.bak-v0"), JSON.stringify(sessionData(id)));

    const report = new UserDataReconciler(root).reconcile();

    expect(report.recoveredLegacyBackups).toBe(1);
    expect(report.validSessions).toBe(1);
    expect(JSON.parse(readFileSync(join(root, id, "session.json"), "utf-8"))).toEqual(
      sessionData(id),
    );
    expect(existsSync(join(root, id, "session.json.bak-v0"))).toBe(true);
    const stateFiles = quarantineEntries(root, "state");
    expect(stateFiles.some((name) => name.startsWith(`${id}_session.json.session-json-`))).toBe(
      true,
    );
  });

  it("moves an invalid session directory to quarantine without deleting its contents", () => {
    const id = "corrupt-session";
    mkdirSync(join(root, id, "workspace"), { recursive: true });
    writeFileSync(join(root, id, "workspace", "valuable.txt"), "keep me");
    writeFileSync(join(root, id, "session.json"), JSON.stringify(sessionData("different-id")));

    const report = new UserDataReconciler(root).reconcile();

    expect(report.quarantinedSessions).toBe(1);
    expect(existsSync(join(root, id))).toBe(false);
    const quarantined = quarantineEntries(root, "sessions").find((name) =>
      name.startsWith(`${id}.invalid-session-json-`),
    );
    expect(quarantined).toBeTruthy();
    expect(
      readFileSync(
        join(root, ".quarantine/sessions", quarantined!, "workspace/valuable.txt"),
        "utf-8",
      ),
    ).toBe("keep me");
  });

  it("quarantines clear half-created and orphan runtimes but leaves ordinary directories alone", () => {
    const halfCreated = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mkdirSync(join(root, halfCreated, "workspace"), { recursive: true });
    writeFileSync(join(root, halfCreated, "workspace/draft.txt"), "draft");

    const orphan = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    for (const marker of ["workspace", "home", "tmp", "pi-config", "pi-sessions"]) {
      mkdirSync(join(root, orphan, marker), { recursive: true });
    }
    writeFileSync(join(root, orphan, "workspace", "work.txt"), "work");

    for (const marker of ["workspace", "home", "tmp"]) {
      mkdirSync(join(root, "shared-project", marker), { recursive: true });
    }
    writeFileSync(join(root, "shared-project", "README.md"), "ordinary data");

    const report = new UserDataReconciler(root).reconcile();

    expect(report.quarantinedSessions).toBe(2);
    expect(existsSync(join(root, halfCreated))).toBe(false);
    expect(existsSync(join(root, orphan))).toBe(false);
    expect(readFileSync(join(root, "shared-project/README.md"), "utf-8")).toBe("ordinary data");
    expect(report.ignoredDirectories).toBe(1);
    const quarantined = quarantineEntries(root, "sessions");
    expect(quarantined.some((name) => name.startsWith(`${halfCreated}.half-created-`))).toBe(true);
    expect(quarantined.some((name) => name.startsWith(`${orphan}.orphan-runtime-`))).toBe(true);
  });

  it("does not let removed launcher state rescue an orphan Pi runtime", () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    for (const marker of ["workspace", "home", "tmp", "pi-config", "pi-sessions"]) {
      mkdirSync(join(root, id, marker), { recursive: true });
    }
    writeFileSync(join(root, id, "workspace", "early-work.txt"), "preserve");
    writeFileSync(
      join(root, "launcher.json"),
      JSON.stringify([
        {
          sessionId: id,
          state: "starting",
          cwd: join(root, id, "workspace"),
        },
      ]),
    );

    const report = new UserDataReconciler(root).reconcile();

    expect(report.quarantinedSessions).toBe(1);
    expect(existsSync(join(root, id))).toBe(false);
    const quarantined = quarantineEntries(root, "sessions").find((name) =>
      name.startsWith(`${id}.orphan-runtime-`),
    );
    expect(quarantined).toBeTruthy();
    expect(
      readFileSync(
        join(root, ".quarantine/sessions", quarantined!, "workspace/early-work.txt"),
        "utf-8",
      ),
    ).toBe("preserve");
  });

  it("quarantines session authority that embeds removed message or permission state", () => {
    for (const field of ["messageHistory", "pendingMessages", "pendingPermissions"] as const) {
      const id = `legacy-${field}`;
      mkdirSync(join(root, id));
      writeFileSync(
        join(root, id, "session.json"),
        JSON.stringify({ ...sessionData(id), [field]: [] }),
      );
    }

    const report = new UserDataReconciler(root).reconcile();

    expect(report.quarantinedSessions).toBe(3);
    expect(quarantineEntries(root, "sessions")).toHaveLength(3);
  });

  it("cleans only AtomicJsonStore temporary files", () => {
    const id = "temp-session";
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "session.json"), JSON.stringify(sessionData(id)));
    writeFileSync(join(root, ".workspace-state.json.tmp-12-34-1"), "stale");
    writeFileSync(join(root, id, ".session.json.tmp-12-34-2"), "stale");
    writeFileSync(join(root, id, ".notes.tmp-12-34-3"), "user file");

    const report = new UserDataReconciler(root).reconcile();

    expect(report.removedTemporaryFiles).toBe(2);
    expect(existsSync(join(root, ".workspace-state.json.tmp-12-34-1"))).toBe(false);
    expect(existsSync(join(root, id, ".session.json.tmp-12-34-2"))).toBe(false);
    expect(readFileSync(join(root, id, ".notes.tmp-12-34-3"), "utf-8")).toBe("user file");
  });

  it("recovers corrupt root state from backup and retains both backup and quarantined bytes", () => {
    writeFileSync(join(root, "workspace-state.json"), "not-json");
    writeFileSync(
      join(root, "workspace-state.json.bak-v0"),
      JSON.stringify({ currentSessionId: "s1" }),
    );

    const report = new UserDataReconciler(root).reconcile();

    expect(report.recoveredLegacyBackups).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "workspace-state.json"), "utf-8"))).toEqual({
      currentSessionId: "s1",
    });
    expect(existsSync(join(root, "workspace-state.json.bak-v0"))).toBe(true);
    expect(
      quarantineEntries(root, "state").some((name) =>
        name.startsWith("workspace-state.json.root-json-"),
      ),
    ).toBe(true);
  });

  it("quarantines a UUID session symlink without touching its external target", () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const external = mkdtempSync(join(tmpdir(), "piwork-external-"));
    try {
      writeFileSync(join(external, "valuable.txt"), "external");
      symlinkSync(external, join(root, id));

      const report = new UserDataReconciler(root).reconcile();

      expect(report.quarantinedSessions).toBe(1);
      expect(readFileSync(join(external, "valuable.txt"), "utf-8")).toBe("external");
      const quarantined = quarantineEntries(root, "sessions").find((name) =>
        name.startsWith(`${id}.symlink-`),
      );
      expect(quarantined).toBeTruthy();
      expect(existsSync(join(root, ".quarantine/sessions", quarantined!))).toBe(true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
