import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  constants,
} from "node:fs";
import { basename, dirname, join } from "node:path";

let tempSequence = 0;

export interface AtomicJsonEnvelope<T> {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  data: T;
}

export interface AtomicJsonReadResult<T> {
  value: T;
  envelope: AtomicJsonEnvelope<T> | null;
  legacy: boolean;
}

export interface AtomicJsonStoreOptions<T> {
  schemaVersion?: number;
  normalize?: (value: unknown) => T;
  defaultValue?: () => T;
  pretty?: boolean;
  quarantineCorrupt?: boolean;
  backupLegacy?: boolean;
}

export interface AtomicJsonWriteOptions {
  expectedRevision?: number;
  /** Internal cleanup rewrites may intentionally avoid creating a new backup. */
  backupLegacy?: boolean;
}

export interface PreparedAtomicJsonWrite<T> {
  /** Exact bytes written to the replacement temporary file. */
  readonly serializedBytes: number;
  /** Additional bytes created by a first-time legacy backup. */
  readonly legacyBackupBytes: number;
  /** Complete incremental peak callers must reserve before commit. */
  readonly reservationBytes: number;
  commit(): AtomicJsonEnvelope<T>;
}

export class AtomicJsonConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Atomic JSON revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "AtomicJsonConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isAtomicJsonEnvelope<T = unknown>(value: unknown): value is AtomicJsonEnvelope<T> {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.schemaVersion) &&
    Number(value.schemaVersion) > 0 &&
    Number.isInteger(value.revision) &&
    Number(value.revision) >= 0 &&
    typeof value.updatedAt === "string" &&
    Object.prototype.hasOwnProperty.call(value, "data")
  );
}

function syncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directories. The file itself was
    // already synced, so keep the write usable on those platforms.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function tempPrefix(path: string): string {
  return `.${basename(path)}.tmp-`;
}

function cleanupTempFiles(path: string): number {
  const parent = dirname(path);
  const prefix = tempPrefix(path);
  let removed = 0;
  try {
    for (const entry of readdirSync(parent)) {
      if (!entry.startsWith(prefix)) continue;
      try {
        rmSync(join(parent, entry), { force: true });
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}

function quarantineFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const quarantineDir = join(dirname(path), ".quarantine");
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  const target = join(quarantineDir, `${basename(path)}.corrupt-${safeTimestamp()}`);
  try {
    renameSync(path, target);
    syncDirectory(dirname(path));
    syncDirectory(quarantineDir);
    return target;
  } catch {
    return null;
  }
}

function backupLegacyFile(path: string): void {
  if (!existsSync(path)) return;
  const backup = `${path}.bak-v0`;
  if (existsSync(backup)) return;
  try {
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
    const fd = openSync(backup, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(dirname(path));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : "";
    if (code !== "EEXIST") throw error;
  }
}

/**
 * Crash-safe JSON persistence with an additive envelope and legacy bare-JSON
 * reader. Writes are synchronous on purpose: callers currently mutate local
 * runtime state synchronously, so this also provides single-process ordering.
 */
export class AtomicJsonStore<T> {
  private readonly schemaVersion: number;
  private readonly normalize: (value: unknown) => T;
  private readonly defaultValue?: () => T;
  private readonly pretty: boolean;
  private readonly quarantineCorrupt: boolean;
  private readonly backupLegacy: boolean;

  constructor(
    readonly path: string,
    options: AtomicJsonStoreOptions<T> = {},
  ) {
    this.schemaVersion = options.schemaVersion ?? 1;
    this.normalize = options.normalize ?? ((value) => value as T);
    this.defaultValue = options.defaultValue;
    this.pretty = options.pretty ?? true;
    this.quarantineCorrupt = options.quarantineCorrupt ?? true;
    this.backupLegacy = options.backupLegacy ?? true;
    cleanupTempFiles(path);
  }

  read(): AtomicJsonReadResult<T> | null {
    if (!existsSync(this.path)) {
      return this.defaultValue
        ? { value: this.defaultValue(), envelope: null, legacy: false }
        : null;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
      if (isAtomicJsonEnvelope<T>(parsed)) {
        return {
          value: this.normalize(parsed.data),
          envelope: {
            schemaVersion: parsed.schemaVersion,
            revision: parsed.revision,
            updatedAt: parsed.updatedAt,
            data: this.normalize(parsed.data),
          },
          legacy: false,
        };
      }
      return { value: this.normalize(parsed), envelope: null, legacy: true };
    } catch {
      if (this.quarantineCorrupt) quarantineFile(this.path);
      return this.defaultValue
        ? { value: this.defaultValue(), envelope: null, legacy: false }
        : null;
    }
  }

  readValue(): T | null {
    return this.read()?.value ?? null;
  }

  /**
   * Returns the exact UTF-8 size of the temporary file the next atomic write
   * will create. Callers enforcing disk quotas reserve this full size because
   * the previous destination and the replacement temporary file coexist until
   * rename commits the write.
   */
  estimateSerializedWriteBytes(value: T, options: AtomicJsonWriteOptions = {}): number {
    return this.prepareWrite(value, options).serializedBytes;
  }

  /**
   * Normalizes and serializes once, then exposes the complete quota peak and a
   * synchronous commit. This prevents quota admission and the actual write
   * from observing different results from a stateful normalizer.
   */
  prepareWrite(value: T, options: AtomicJsonWriteOptions = {}): PreparedAtomicJsonWrite<T> {
    const current = this.read();
    const actualRevision = current?.envelope?.revision ?? 0;
    if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
      throw new AtomicJsonConflictError(options.expectedRevision, actualRevision);
    }

    const shouldBackupLegacy =
      current?.legacy === true && (options.backupLegacy ?? this.backupLegacy);
    const legacyBackupPath = `${this.path}.bak-v0`;
    const legacyBackupBytes =
      shouldBackupLegacy && !existsSync(legacyBackupPath) ? statSync(this.path).size : 0;
    const envelope: AtomicJsonEnvelope<T> = {
      schemaVersion: this.schemaVersion,
      revision: actualRevision + 1,
      updatedAt: new Date().toISOString(),
      data: this.normalize(value),
    };
    const serialized = this.serializeEnvelope(envelope);
    const serializedBytes = Buffer.byteLength(serialized, "utf-8");
    let committed = false;

    return {
      serializedBytes,
      legacyBackupBytes,
      reservationBytes: serializedBytes + legacyBackupBytes,
      commit: () => {
        if (committed)
          throw new Error(`Atomic JSON prepared write was already committed: ${this.path}`);
        committed = true;
        if (shouldBackupLegacy) backupLegacyFile(this.path);
        this.writeEnvelope(serialized);
        return envelope;
      },
    };
  }

  write(value: T, options: AtomicJsonWriteOptions = {}): AtomicJsonEnvelope<T> {
    return this.prepareWrite(value, options).commit();
  }

  update(mutator: (value: T) => T): AtomicJsonEnvelope<T> {
    const current = this.read();
    if (!current)
      throw new Error(`Atomic JSON file does not exist and has no default: ${this.path}`);
    return this.write(mutator(current.value), {
      expectedRevision: current.envelope?.revision ?? 0,
    });
  }

  reconcile(): { removedTemps: number; quarantinedPath: string | null } {
    const removedTemps = cleanupTempFiles(this.path);
    if (!existsSync(this.path)) return { removedTemps, quarantinedPath: null };
    try {
      JSON.parse(readFileSync(this.path, "utf-8"));
      return { removedTemps, quarantinedPath: null };
    } catch {
      return {
        removedTemps,
        quarantinedPath: this.quarantineCorrupt ? quarantineFile(this.path) : null,
      };
    }
  }

  private writeEnvelope(serialized: string): void {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      chmodSync(parent, 0o700);
    } catch {}

    const tmp = join(
      parent,
      `${tempPrefix(this.path)}${process.pid}-${Date.now()}-${++tempSequence}`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, serialized, { encoding: "utf-8" });
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {}
      syncDirectory(parent);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        rmSync(tmp, { force: true });
      } catch {}
      throw error;
    }
  }

  private serializeEnvelope(envelope: AtomicJsonEnvelope<T>): string {
    return this.pretty ? `${JSON.stringify(envelope, null, 2)}\n` : JSON.stringify(envelope);
  }
}

export function atomicJsonFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
