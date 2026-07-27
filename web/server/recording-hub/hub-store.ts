/**
 * Storage and indexing for curated recording files.
 *
 * Production injects a Better Auth user/tenant-scoped base directory. The
 * historical ~/.piwork/hub default remains only for standalone callers and
 * compatibility tests. Hub recordings stay separate from auto-recordings to
 * avoid rotation cleanup; index.json provides fast listing without re-parsing.
 */

import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PIWORK_HOME } from "../paths.js";
import { loadRecording, parseRecordingContent } from "../replay.js";
import type { RecordingHeader, RecordingEntry } from "../recorder.js";
import type { BackendType } from "../session-types.js";
import { getMaxUploadBytes } from "./hub-config.js";
import { AtomicJsonStore } from "../atomic-json-store.js";
import { withDiskReservationSync, type UserDiskQuota } from "../user-disk-quota.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HubRecordingMeta {
  id: string;
  filename: string;
  sessionId: string;
  backendType: BackendType;
  startedAt: number;
  duration: number;
  entryCount: number;
  cwd: string;
  tags: string[];
  importedAt: number;
  messageTypeSummary: Record<string, number>;
}

export interface HubRecordingSummary extends HubRecordingMeta {
  toolNames: string[];
  interactionCount: number;
}

// ─── HubStore ────────────────────────────────────────────────────────────────

const DEFAULT_HUB_DIR = join(PIWORK_HOME, "hub");

export interface HubStoreOptions {
  /** Production passes a Better Auth user/tenant-scoped directory explicitly. */
  baseDir?: string;
  diskQuota?: UserDiskQuota;
}

export class HubStore {
  private index: Map<string, HubRecordingMeta> = new Map();
  private dirCreated = false;
  private readonly baseDir: string;
  private readonly recordingsDir: string;
  private readonly indexStore: AtomicJsonStore<HubRecordingMeta[]>;
  private readonly diskQuota?: UserDiskQuota;

  constructor(options: HubStoreOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_HUB_DIR;
    this.recordingsDir = join(this.baseDir, "recordings");
    this.diskQuota = options.diskQuota;
    this.indexStore = new AtomicJsonStore<HubRecordingMeta[]>(join(this.baseDir, "index.json"), {
      schemaVersion: 1,
      defaultValue: () => [],
      normalize: (value) => (Array.isArray(value) ? (value as HubRecordingMeta[]) : []),
    });
    this.ensureDir();
    this.loadIndex();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Import a recording from the auto-recordings directory by copying it. */
  importLocal(sourcePath: string): HubRecordingMeta {
    this.validateFileSize(sourcePath);
    const recording = loadRecording(sourcePath);
    const id = randomUUID();
    const destFilename = `${id}.jsonl`;
    const destPath = join(this.recordingsDir, destFilename);
    const meta = this.buildMeta(id, destFilename, recording.header, recording.entries);
    const entries = [...this.index.values(), meta];
    const recordingBytes = statSync(sourcePath).size;
    this.writeImportedRecording(recordingBytes, entries, destPath, () => {
      copyFileSync(sourcePath, destPath);
    });
    this.index.set(id, meta);
    return meta;
  }

  /** Import from raw JSONL content (e.g. from an upload). */
  importContent(content: string, originalFilename?: string): HubRecordingMeta {
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > getMaxUploadBytes()) {
      throw new Error(`File too large: ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds limit`);
    }

    const { header, entries } = parseRecordingContent(content);

    const id = randomUUID();
    const destFilename = `${id}.jsonl`;
    const destPath = join(this.recordingsDir, destFilename);
    const meta = this.buildMeta(id, originalFilename || destFilename, header, entries);
    const indexEntries = [...this.index.values(), meta];
    this.writeImportedRecording(sizeBytes, indexEntries, destPath, () => {
      writeFileSync(destPath, content, { encoding: "utf-8", mode: 0o600 });
    });
    this.index.set(id, meta);
    return meta;
  }

  list(): HubRecordingMeta[] {
    return Array.from(this.index.values()).sort((a, b) => b.importedAt - a.importedAt);
  }

  get(id: string): HubRecordingMeta | null {
    return this.index.get(id) ?? null;
  }

  /** Load the full recording content from disk. */
  loadRecording(id: string) {
    const meta = this.index.get(id);
    if (!meta) return null;
    const filePath = this.recordingPath(id);
    if (!existsSync(filePath)) return null;
    return loadRecording(filePath);
  }

  /** Get the file path for a recording. */
  recordingPath(id: string): string {
    return join(this.recordingsDir, `${id}.jsonl`);
  }

  delete(id: string): boolean {
    const meta = this.index.get(id);
    if (!meta) return false;
    const entries = Array.from(this.index.values()).filter((entry) => entry.id !== id);
    this.writeIndex(entries);
    this.index.delete(id);
    const filePath = this.recordingPath(id);
    try {
      unlinkSync(filePath);
    } catch {
      // File may already be gone
    }
    return true;
  }

  updateTags(id: string, tags: string[]): HubRecordingMeta | null {
    const meta = this.index.get(id);
    if (!meta) return null;
    const updated = { ...meta, tags };
    const entries = Array.from(this.index.values(), (entry) => (entry.id === id ? updated : entry));
    this.writeIndex(entries);
    this.index.set(id, updated);
    return updated;
  }

  /** Get a Pi-native summary with tools and product interaction count. */
  getSummary(id: string): HubRecordingSummary | null {
    const recording = this.loadRecording(id);
    if (!recording) return null;
    const meta = this.index.get(id);
    if (!meta) return null;

    const toolNames = new Set<string>();
    const interactions = new Set<string>();

    for (const entry of recording.entries) {
      if (entry.dir !== "out" || entry.ch !== "browser") continue;
      try {
        const msg = JSON.parse(entry.raw) as Record<string, unknown>;
        if (msg.type === "tool_execution" && typeof msg.toolName === "string") {
          toolNames.add(msg.toolName);
        } else if (msg.type === "interaction_request") {
          const request = msg.request;
          if (
            request &&
            typeof request === "object" &&
            typeof (request as { id?: unknown }).id === "string"
          ) {
            interactions.add((request as { id: string }).id);
          }
        }
      } catch {
        // Skip unparseable
      }
    }

    return {
      ...meta,
      toolNames: Array.from(toolNames).sort(),
      interactionCount: interactions.size,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private buildMeta(
    id: string,
    filename: string,
    header: RecordingHeader,
    entries: RecordingEntry[],
  ): HubRecordingMeta {
    const typeSummary: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.dir !== "out" || entry.ch !== "browser") continue;
      try {
        const msg = JSON.parse(entry.raw);
        const type = msg.type || "unknown";
        typeSummary[type] = (typeSummary[type] || 0) + 1;
      } catch {
        // Skip
      }
    }

    const firstTs = entries[0]?.ts ?? header.started_at;
    const lastTs = entries[entries.length - 1]?.ts ?? firstTs;

    return {
      id,
      filename,
      sessionId: header.session_id,
      backendType: header.backend_type,
      startedAt: header.started_at,
      duration: lastTs - firstTs,
      entryCount: entries.length,
      cwd: header.cwd,
      tags: [],
      importedAt: Date.now(),
      messageTypeSummary: typeSummary,
    };
  }

  private validateFileSize(path: string): void {
    const stat = statSync(path);
    if (stat.size > getMaxUploadBytes()) {
      throw new Error(`File too large: ${Math.round(stat.size / 1024 / 1024)}MB exceeds limit`);
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.baseDir, 0o700);
      chmodSync(this.recordingsDir, 0o700);
    } catch {}
    this.dirCreated = true;
  }

  private loadIndex(): void {
    const entries = this.indexStore.readValue() || [];
    for (const entry of entries) {
      if (entry && typeof entry.id === "string") this.index.set(entry.id, entry);
    }
  }

  private writeImportedRecording(
    recordingBytes: number,
    entries: HubRecordingMeta[],
    destination: string,
    writeRecording: () => void,
  ): void {
    const preparedIndex = this.indexStore.prepareWrite(entries);
    withDiskReservationSync(this.diskQuota, recordingBytes + preparedIndex.reservationBytes, () => {
      try {
        writeRecording();
        try {
          chmodSync(destination, 0o600);
        } catch {}
        preparedIndex.commit();
      } catch (error) {
        try {
          unlinkSync(destination);
        } catch {}
        throw error;
      }
    });
  }

  private writeIndex(entries: HubRecordingMeta[]): void {
    const prepared = this.indexStore.prepareWrite(entries);
    withDiskReservationSync(this.diskQuota, prepared.reservationBytes, () => prepared.commit());
  }
}
