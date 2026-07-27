/** Load, validate, and query native-Pi v2 protocol recordings. */

import { readFileSync } from "node:fs";
import type {
  RecordingChannel,
  RecordingHeader,
  RecordingEntry,
  RecordingDirection,
  RecordingLifecycleEvent,
} from "./recorder.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Recording {
  header: RecordingHeader;
  entries: RecordingEntry[];
}

// ─── Loading ─────────────────────────────────────────────────────────────────

const RECORDING_CHANNELS = new Set<RecordingChannel>(["pi-rpc", "browser", "extension"]);
const RECORDING_DIRECTIONS = new Set<RecordingDirection>(["in", "out"]);
const RECORDING_LIFECYCLE_EVENTS = new Set<RecordingLifecycleEvent>([
  "ws_open",
  "ws_close",
  "ws_error",
  "process_spawn",
  "process_ready",
  "process_exit",
  "generation_change",
  "transport_error",
  "reconnect_attempt",
  "reconnect_success",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(value: unknown): RecordingHeader {
  if (
    !isRecord(value) ||
    value._header !== true ||
    value.version !== 2 ||
    value.backend_type !== "pi" ||
    value.transport !== "pi-rpc" ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    typeof value.started_at !== "number" ||
    !Number.isFinite(value.started_at) ||
    typeof value.cwd !== "string"
  ) {
    throw new Error("Invalid Pi recording header");
  }
  return value as unknown as RecordingHeader;
}

function parseEntry(value: unknown, lineNumber: number): RecordingEntry {
  if (
    !isRecord(value) ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    !RECORDING_DIRECTIONS.has(value.dir as RecordingDirection) ||
    typeof value.raw !== "string" ||
    !RECORDING_CHANNELS.has(value.ch as RecordingChannel)
  ) {
    throw new Error(`Malformed Pi recording entry at line ${lineNumber}`);
  }
  if (
    value.event !== undefined &&
    !RECORDING_LIFECYCLE_EVENTS.has(value.event as RecordingLifecycleEvent)
  ) {
    throw new Error(`Unknown Pi recording lifecycle event at line ${lineNumber}`);
  }
  if (value.meta !== undefined && !isRecord(value.meta)) {
    throw new Error(`Malformed Pi recording metadata at line ${lineNumber}`);
  }
  if (value.event === undefined) {
    try {
      const frame: unknown = JSON.parse(value.raw);
      if (!isRecord(frame)) throw new Error("frame must be an object");
    } catch {
      throw new Error(`Malformed recorded JSONL frame at line ${lineNumber}`);
    }
  } else if (value.raw !== "") {
    throw new Error(`Lifecycle entry must not contain a protocol frame at line ${lineNumber}`);
  }
  return value as unknown as RecordingEntry;
}

export function parseRecordingContent(
  content: string,
  options: { allowTruncatedFinalEntry?: boolean } = {},
): Recording {
  if (content.includes("\r")) {
    throw new Error("Pi recordings must use LF JSONL framing");
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines[0]?.trim() === "") {
    throw new Error("Recording file is empty");
  }
  if (lines.some((line) => line.trim() === "")) {
    throw new Error("Pi recordings must not contain blank JSONL frames");
  }

  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0]!);
  } catch {
    throw new Error("Invalid Pi recording header");
  }
  const header = parseHeader(headerValue);
  const entries: RecordingEntry[] = [];
  for (let index = 1; index < lines.length; index++) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch (error) {
      if (options.allowTruncatedFinalEntry && index === lines.length - 1) break;
      if (error instanceof SyntaxError) {
        throw new Error(`Malformed JSON at line ${index + 1}`);
      }
      throw error;
    }
    entries.push(parseEntry(value, index + 1));
  }
  return { header, entries };
}

/**
 * Load a JSONL recording file. Returns the parsed header and all entries.
 * A single truncated final entry is ignored because process exit can interrupt
 * the last append. Earlier malformed frames remain a hard failure.
 */
export function loadRecording(path: string): Recording {
  const content = readFileSync(path, "utf-8");
  return parseRecordingContent(content, { allowTruncatedFinalEntry: true });
}

// ─── Replay helpers ──────────────────────────────────────────────────────────

/**
 * Filter recording entries by direction and channel.
 * Lifecycle records are intentionally excluded from raw protocol queries.
 */
export function filterEntries(
  entries: RecordingEntry[],
  dir: "in" | "out",
  channel: RecordingChannel,
): RecordingEntry[] {
  return entries.filter((entry) => !entry.event && entry.dir === dir && entry.ch === channel);
}

/**
 * Get all outgoing browser messages from a recording.
 * These represent what the server actually sent to browsers during the recorded session.
 */
export function getExpectedBrowserMessages(entries: RecordingEntry[]): string[] {
  return filterEntries(entries, "out", "browser").map((e) => e.raw);
}

/**
 * Get all incoming Pi RPC messages from a recording.
 * These are the strict LF JSONL frames received from native Pi.
 */
export function getIncomingPiRpcMessages(entries: RecordingEntry[]): string[] {
  return filterEntries(entries, "in", "pi-rpc").map((e) => e.raw);
}

/** Get all requests written by Piwork to native Pi. */
export function getOutgoingPiRpcMessages(entries: RecordingEntry[]): string[] {
  return filterEntries(entries, "out", "pi-rpc").map((entry) => entry.raw);
}

/** Get trusted-extension events in their recorded direction. */
export function getExtensionEvents(
  entries: RecordingEntry[],
  direction?: RecordingDirection,
): RecordingEntry[] {
  return entries.filter(
    (entry) =>
      !entry.event &&
      entry.ch === "extension" &&
      (direction === undefined || entry.dir === direction),
  );
}
