import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { isAtomicJsonEnvelope } from "./atomic-json-store.js";
import { OperationJournal, type JournalStep } from "./operation-journal.js";

const ROOT_STATE_FILES = ["profile.json", "preferences.json", "workspace-state.json"] as const;

const SESSION_LAYOUT_MARKERS = [
  "workspace",
  "home",
  "tmp",
  "pi-config",
  "pi-sessions",
  "recordings",
  "user-space-checkouts",
] as const;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATOMIC_TEMP_FILE = /^\..+\.json\.tmp-\d+-\d+-\d+$/;

export interface ReconciliationReport {
  replayedOperations: number;
  replayFailures: number;
  removedTemporaryFiles: number;
  validSessions: number;
  quarantinedSessions: number;
  quarantinedStateFiles: number;
  recoveredLegacyBackups: number;
  ignoredDirectories: number;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonData(path: string): { ok: true; data: unknown } | { ok: false } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return {
      ok: true,
      data: isAtomicJsonEnvelope(parsed) ? parsed.data : parsed,
    };
  } catch {
    return { ok: false };
  }
}

function isValidSessionData(value: unknown, expectedId: string): boolean {
  if (!isRecord(value) || value.id !== expectedId || !isRecord(value.state)) return false;
  if (value.state.session_id !== expectedId) return false;
  for (const field of ["messageHistory", "pendingMessages", "pendingPermissions"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field)) return false;
  }
  return true;
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Startup recovery for one Better Auth user's filesystem scope.
 *
 * The classifier is intentionally conservative: a directory with a valid
 * session.json is always kept. A directory without session.json is treated as
 * an incomplete/orphan session only when a UUID name and app-owned layout
 * markers make that intent unambiguous. Unknown directories are never moved or
 * deleted, even if their child names resemble parts of the runtime layout.
 */
export class UserDataReconciler {
  private readonly journal: OperationJournal;

  constructor(
    private readonly userRoot: string,
    journal?: OperationJournal,
  ) {
    mkdirSync(userRoot, { recursive: true, mode: 0o700 });
    this.journal = journal ?? new OperationJournal(userRoot);
  }

  reconcile(): ReconciliationReport {
    const report: ReconciliationReport = {
      replayedOperations: 0,
      replayFailures: 0,
      removedTemporaryFiles: 0,
      validSessions: 0,
      quarantinedSessions: 0,
      quarantinedStateFiles: 0,
      recoveredLegacyBackups: 0,
      ignoredDirectories: 0,
      warnings: [],
    };

    report.removedTemporaryFiles += this.cleanupAtomicTemps(this.userRoot);
    report.removedTemporaryFiles += this.cleanupAtomicTemps(this.journal.directory);

    const replay = this.journal.replayIncomplete();
    report.replayedOperations = replay.completed.length;
    report.replayFailures = replay.failed.length + replay.quarantined.length;
    for (const failure of replay.failed) {
      report.warnings.push(`operation ${failure.id} could not be replayed: ${failure.error}`);
    }
    for (const id of replay.quarantined) {
      report.warnings.push(`operation ${id} was corrupt and moved to journal quarantine`);
    }

    for (const file of ROOT_STATE_FILES) {
      this.reconcileRootStateFile(file, report);
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(this.userRoot, { withFileTypes: true });
    } catch (error) {
      report.warnings.push(error instanceof Error ? error.message : String(error));
      return report;
    }

    for (const entry of entries) {
      if (
        entry.name === ".operations" ||
        entry.name === ".quarantine" ||
        entry.name === "pi-resources" ||
        entry.name === "profile"
      ) {
        continue;
      }
      const entryPath = join(this.userRoot, entry.name);
      if (entry.isSymbolicLink()) {
        if (SESSION_UUID.test(entry.name)) {
          if (this.quarantineSession(entry.name, "symlink", report))
            report.quarantinedSessions += 1;
        } else {
          report.ignoredDirectories += 1;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;

      const sessionFile = join(entryPath, "session.json");
      const sessionBackup = `${sessionFile}.bak-v0`;
      const hasSessionFile = existsSync(sessionFile) || this.isSymbolicLink(sessionFile);
      if (hasSessionFile) {
        report.removedTemporaryFiles += this.cleanupAtomicTemps(entryPath);
        if (this.isSymbolicLink(sessionFile)) {
          if (this.quarantineSession(entry.name, "session-file-symlink", report))
            report.quarantinedSessions += 1;
          continue;
        }
        const current = readJsonData(sessionFile);
        if (current.ok && isValidSessionData(current.data, entry.name)) {
          report.validSessions += 1;
          continue;
        }

        const backup =
          existsSync(sessionBackup) && !this.isSymbolicLink(sessionBackup)
            ? readJsonData(sessionBackup)
            : { ok: false as const };
        if (backup.ok && isValidSessionData(backup.data, entry.name)) {
          if (
            this.recoverFromBackup(
              `${entry.name}/session.json`,
              `${entry.name}/session.json.bak-v0`,
              ".quarantine/state",
              "session-json",
              report,
            )
          ) {
            report.recoveredLegacyBackups += 1;
            report.validSessions += 1;
          }
          continue;
        }

        if (this.quarantineSession(entry.name, "invalid-session-json", report)) {
          report.quarantinedSessions += 1;
        }
        continue;
      }

      const childEntries = this.safeDirectoryEntries(entryPath);
      const markerCount = SESSION_LAYOUT_MARKERS.filter((marker) => {
        const markerPath = join(entryPath, marker);
        try {
          const stat = lstatSync(markerPath);
          return stat.isDirectory() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      }).length;
      const uuidNamed = SESSION_UUID.test(entry.name);
      const clearRuntimeOrphan = uuidNamed && markerCount >= 3;
      const clearUuidHalfCreation =
        uuidNamed && !clearRuntimeOrphan && (childEntries.length === 0 || markerCount > 0);

      if (clearUuidHalfCreation || clearRuntimeOrphan) {
        report.removedTemporaryFiles += this.cleanupAtomicTemps(entryPath);
        if (
          this.quarantineSession(
            entry.name,
            clearUuidHalfCreation ? "half-created" : "orphan-runtime",
            report,
          )
        ) {
          report.quarantinedSessions += 1;
        }
      } else {
        report.ignoredDirectories += 1;
      }
    }

    return report;
  }

  private reconcileRootStateFile(file: string, report: ReconciliationReport): void {
    const path = join(this.userRoot, file);
    if (!existsSync(path) && !this.isSymbolicLink(path)) return;
    if (!this.isSymbolicLink(path) && readJsonData(path).ok) return;

    const backupName = `${file}.bak-v0`;
    const backupPath = join(this.userRoot, backupName);
    if (
      !this.isSymbolicLink(path) &&
      existsSync(backupPath) &&
      !this.isSymbolicLink(backupPath) &&
      readJsonData(backupPath).ok
    ) {
      if (this.recoverFromBackup(file, backupName, ".quarantine/state", "root-json", report)) {
        report.recoveredLegacyBackups += 1;
      }
      return;
    }

    const destination = this.quarantineDestination(".quarantine/state", file, "invalid-root-json");
    if (
      this.runOperation(
        "reconcile-root-json",
        [
          { type: "mkdir", path: ".quarantine/state" },
          { type: "move-if-exists", from: file, to: destination },
        ],
        report,
      )
    ) {
      report.quarantinedStateFiles += 1;
    }
  }

  private recoverFromBackup(
    current: string,
    backup: string,
    bucket: string,
    reason: string,
    report: ReconciliationReport,
  ): boolean {
    const destination = this.quarantineDestination(bucket, current.replaceAll("/", "_"), reason);
    return this.runOperation(
      `recover-${reason}`,
      [
        { type: "mkdir", path: bucket },
        { type: "move-if-exists", from: current, to: destination },
        { type: "copy-file-if-missing", from: backup, to: current },
      ],
      report,
    );
  }

  private quarantineSession(name: string, reason: string, report: ReconciliationReport): boolean {
    const destination = this.quarantineDestination(".quarantine/sessions", name, reason);
    return this.runOperation(
      `quarantine-${reason}`,
      [
        { type: "mkdir", path: ".quarantine/sessions" },
        { type: "move-if-exists", from: name, to: destination },
      ],
      report,
    );
  }

  private runOperation(kind: string, steps: JournalStep[], report: ReconciliationReport): boolean {
    try {
      const operation = this.journal.begin(kind, steps);
      this.journal.execute(operation.id);
      return true;
    } catch (error) {
      report.warnings.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private quarantineDestination(bucket: string, name: string, reason: string): string {
    return `${bucket}/${name}.${reason}-${timestampForPath()}-${randomUUID().slice(0, 8)}`;
  }

  private cleanupAtomicTemps(directory: string): number {
    let removed = 0;
    for (const entry of this.safeDirectoryEntries(directory)) {
      if (!entry.isFile() || !ATOMIC_TEMP_FILE.test(entry.name)) continue;
      try {
        rmSync(join(directory, entry.name), { force: true });
        removed += 1;
      } catch {}
    }
    return removed;
  }

  private safeDirectoryEntries(directory: string): Dirent[] {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private isSymbolicLink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }
}
