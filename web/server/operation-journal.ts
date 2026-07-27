import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  constants,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AtomicJsonStore } from "./atomic-json-store.js";

export type JournalStep =
  | { type: "mkdir"; path: string }
  | { type: "move-if-exists"; from: string; to: string }
  | { type: "copy-file-if-missing"; from: string; to: string };

export type JournalOperationStatus = "pending" | "applying" | "completed" | "failed";

export interface JournalOperation {
  id: string;
  kind: string;
  status: JournalOperationStatus;
  createdAt: string;
  updatedAt: string;
  nextStep: number;
  steps: JournalStep[];
  error?: string;
}

export interface JournalReplayReport {
  completed: string[];
  failed: Array<{ id: string; error: string }>;
  alreadyCompleted: string[];
  quarantined: string[];
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPERATION_KIND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\")
  ) {
    throw new Error("Journal paths must be non-empty relative paths");
  }
  if (isAbsolute(value)) throw new Error("Journal paths must be relative");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Journal paths may not contain empty or traversal segments");
  }
  return segments.join("/");
}

function normalizeStep(value: unknown): JournalStep {
  if (!isRecord(value)) throw new Error("Invalid journal step");
  if (value.type === "mkdir") {
    return { type: "mkdir", path: normalizeRelativePath(value.path) };
  }
  if (value.type === "move-if-exists") {
    const from = normalizeRelativePath(value.from);
    const to = normalizeRelativePath(value.to);
    if (from === to) throw new Error("Journal move source and destination must differ");
    return { type: "move-if-exists", from, to };
  }
  if (value.type === "copy-file-if-missing") {
    const from = normalizeRelativePath(value.from);
    const to = normalizeRelativePath(value.to);
    if (from === to) throw new Error("Journal copy source and destination must differ");
    return { type: "copy-file-if-missing", from, to };
  }
  throw new Error("Unsupported journal step");
}

function normalizeOperation(value: unknown): JournalOperation {
  if (!isRecord(value)) throw new Error("Invalid journal operation");
  if (typeof value.id !== "string" || !OPERATION_ID.test(value.id)) {
    throw new Error("Invalid journal operation id");
  }
  if (typeof value.kind !== "string" || !OPERATION_KIND.test(value.kind)) {
    throw new Error("Invalid journal operation kind");
  }
  if (!["pending", "applying", "completed", "failed"].includes(String(value.status))) {
    throw new Error("Invalid journal operation status");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new Error("Invalid journal timestamps");
  }
  if (!Array.isArray(value.steps)) throw new Error("Invalid journal steps");
  const steps = value.steps.map(normalizeStep);
  if (
    !Number.isInteger(value.nextStep) ||
    Number(value.nextStep) < 0 ||
    Number(value.nextStep) > steps.length
  ) {
    throw new Error("Invalid journal checkpoint");
  }
  return {
    id: value.id,
    kind: value.kind,
    status: value.status as JournalOperationStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextStep: Number(value.nextStep),
    steps,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function syncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported by every filesystem. Individual journal
    // records are still fsynced by AtomicJsonStore.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/**
 * A small, local write-ahead journal for filesystem operations under one user
 * root. Every step is idempotent and checkpointed through AtomicJsonStore, so a
 * process can replay an operation after crashing between the filesystem change
 * and its checkpoint write.
 */
export class OperationJournal {
  readonly directory: string;
  private readonly root: string;

  constructor(root: string, directory?: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    this.directory = directory ? resolve(directory) : join(this.root, ".operations");
    this.assertParentInsideRoot(this.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!this.isInsideRoot(realpathSync(this.directory))) {
      throw new Error("Operation journal may not escape its user root through a symbolic link");
    }
    try {
      chmodSync(this.directory, 0o700);
    } catch {}
    syncDirectory(this.root);
  }

  begin(kind: string, steps: JournalStep[], id: string = randomUUID()): JournalOperation {
    if (!OPERATION_ID.test(id)) throw new Error("Invalid journal operation id");
    if (!OPERATION_KIND.test(kind)) throw new Error("Invalid journal operation kind");
    const now = new Date().toISOString();
    const operation = normalizeOperation({
      id,
      kind,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      nextStep: 0,
      steps,
    });
    const store = this.storeFor(id);
    if (existsSync(store.path)) throw new Error(`Journal operation already exists: ${id}`);
    store.write(operation);
    return operation;
  }

  get(id: string): JournalOperation | null {
    return this.storeFor(id).readValue();
  }

  removeCompleted(id: string): boolean {
    const operation = this.get(id);
    if (operation?.status !== "completed") return false;
    try {
      rmSync(join(this.directory, `${id}.json`), { force: true });
      syncDirectory(this.directory);
      return true;
    } catch {
      return false;
    }
  }

  execute(id: string): JournalOperation {
    const store = this.storeFor(id);
    let operation = store.readValue();
    if (!operation) throw new Error(`Journal operation does not exist: ${id}`);
    if (operation.status === "completed") return operation;

    operation = this.persist(store, { ...operation, status: "applying", error: undefined });
    try {
      while (operation.nextStep < operation.steps.length) {
        this.applyStep(operation.steps[operation.nextStep]);
        operation = this.persist(store, {
          ...operation,
          nextStep: operation.nextStep + 1,
        });
      }
      operation = this.persist(store, { ...operation, status: "completed", error: undefined });
      return operation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        operation = this.persist(store, { ...operation, status: "failed", error: message });
      } catch {
        // Preserve the original filesystem error when even the failure
        // checkpoint cannot be persisted (for example ENOSPC).
      }
      throw error;
    }
  }

  replayIncomplete(): JournalReplayReport {
    const report: JournalReplayReport = {
      completed: [],
      failed: [],
      alreadyCompleted: [],
      quarantined: [],
    };
    let files: string[] = [];
    try {
      files = readdirSync(this.directory).filter((name) => name.endsWith(".json"));
    } catch {
      return report;
    }
    for (const file of files.sort()) {
      const id = file.slice(0, -5);
      if (!OPERATION_ID.test(id)) continue;
      const recordPath = join(this.directory, file);
      const operation = this.get(id);
      if (!operation) {
        if (!existsSync(recordPath)) report.quarantined.push(id);
        continue;
      }
      if (operation.status === "completed") {
        report.alreadyCompleted.push(id);
        this.removeCompleted(id);
        continue;
      }
      try {
        this.execute(id);
        report.completed.push(id);
      } catch (error) {
        report.failed.push({
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  }

  private storeFor(id: string): AtomicJsonStore<JournalOperation> {
    if (!OPERATION_ID.test(id)) throw new Error("Invalid journal operation id");
    return new AtomicJsonStore<JournalOperation>(join(this.directory, `${id}.json`), {
      schemaVersion: 1,
      normalize: normalizeOperation,
      pretty: false,
      backupLegacy: false,
    });
  }

  private persist(
    store: AtomicJsonStore<JournalOperation>,
    operation: JournalOperation,
  ): JournalOperation {
    const next = normalizeOperation({
      ...operation,
      updatedAt: new Date().toISOString(),
    });
    store.write(next);
    return next;
  }

  private applyStep(step: JournalStep): void {
    if (step.type === "mkdir") {
      const target = this.resolveJournalPath(step.path);
      this.assertParentInsideRoot(target);
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Journal mkdir target is not a directory: ${step.path}`);
        }
        return;
      }
      mkdirSync(target, { recursive: true, mode: 0o700 });
      try {
        chmodSync(target, 0o700);
      } catch {}
      syncDirectory(dirname(target));
      return;
    }

    const source = this.resolveJournalPath(step.from);
    const destination = this.resolveJournalPath(step.to);
    this.assertParentInsideRoot(source);
    this.assertParentInsideRoot(destination);
    const sourceExists = existsSync(source) || this.isSymbolicLink(source);
    const destinationExists = existsSync(destination) || this.isSymbolicLink(destination);

    if (step.type === "copy-file-if-missing") {
      if (destinationExists) {
        const destinationStat = lstatSync(destination);
        if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
          throw new Error(`Journal copy destination is not a regular file: ${step.to}`);
        }
        return;
      }
      if (!sourceExists) throw new Error(`Journal copy source is missing: ${step.from}`);
      const sourceStat = lstatSync(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Journal copy source is not a regular file: ${step.from}`);
      }
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      this.assertParentInsideRoot(destination);
      const tmp = join(
        dirname(destination),
        `.${basename(destination)}.journal-copy-tmp-${process.pid}-${randomUUID()}`,
      );
      try {
        copyFileSync(source, tmp, constants.COPYFILE_EXCL);
        try {
          chmodSync(tmp, 0o600);
        } catch {}
        const fd = openSync(tmp, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, destination);
        syncDirectory(dirname(destination));
      } catch (error) {
        try {
          rmSync(tmp, { force: true });
        } catch {}
        throw error;
      }
      return;
    }

    if (!sourceExists) {
      if (destinationExists) return;
      throw new Error(`Journal move source and destination are both missing: ${step.from}`);
    }
    if (destinationExists) {
      throw new Error(`Journal move destination already exists: ${step.to}`);
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    this.assertParentInsideRoot(destination);
    renameSync(source, destination);
    syncDirectory(dirname(source));
    syncDirectory(dirname(destination));
  }

  private isSymbolicLink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  private resolveJournalPath(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const target = resolve(this.root, normalized);
    if (!this.isInsideRoot(target) || target === this.root) {
      throw new Error("Journal path escapes its user root");
    }
    return target;
  }

  private assertParentInsideRoot(path: string): void {
    let cursor = dirname(path);
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const canonical = realpathSync(cursor);
    if (!this.isInsideRoot(canonical))
      throw new Error("Journal path escapes through a symbolic link");
  }

  private isInsideRoot(path: string): boolean {
    const rel = relative(this.root, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
}
