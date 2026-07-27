/** Native-Pi transport and browser disconnection diagnostics. */

import type { Recording } from "../replay.js";
import type { RecordingChannel, RecordingEntry } from "../recorder.js";

export interface TimelineEntry {
  ts: number;
  event: string;
  channel: RecordingChannel;
  detail?: string;
}

export interface DisconnectionEvent {
  ts: number;
  channel: RecordingChannel;
  closeCode?: number;
  closeReason?: string;
  reconnectedAt?: number;
  gapMs: number;
  messagesLostEstimate: number;
}

export interface DisconnectionReport {
  sessionId: string;
  backendType: "pi";
  totalDuration: number;
  totalDisconnections: number;
  disconnections: DisconnectionEvent[];
  patterns: string[];
  dataGaps: DataGap[];
}

export interface DataGap {
  startTs: number;
  endTs: number;
  gapMs: number;
  channel: RecordingChannel;
  messagesBefore: number;
  messagesAfter: number;
}

const PI_RPC_GAP_THRESHOLD_MS = 30_000;
const PATTERN_MIN_COUNT = 3;
const INTERVAL_TOLERANCE = 0.2;
const PI_RPC_TIMELINE_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
]);
const DISCONNECT_EVENTS = new Set([
  "ws_close",
  "ws_error",
  "process_exit",
  "transport_error",
  "run_state:disconnected",
  "run_state:error",
]);
const RECONNECT_EVENTS = new Set([
  "ws_open",
  "process_ready",
  "reconnect_success",
  "run_state:ready",
  "run_state:running",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function analyzeDisconnections(recording: Recording): DisconnectionReport {
  const entries = recording.entries;
  const timeline = buildTimeline(recording);
  const disconnections = detectDisconnections(entries, timeline);
  const dataGaps = detectDataGaps(entries);
  const patterns = detectPatterns(disconnections, dataGaps);
  const firstTs = entries[0]?.ts ?? recording.header.started_at;
  const lastTs = entries.at(-1)?.ts ?? firstTs;

  return {
    sessionId: recording.header.session_id,
    backendType: "pi",
    totalDuration: lastTs - firstTs,
    totalDisconnections: disconnections.length,
    disconnections,
    patterns,
    dataGaps,
  };
}

/** Build a bounded lifecycle timeline from native recording channels. */
export function buildTimeline(recording: Recording): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];

  for (const entry of recording.entries) {
    if (entry.event) {
      timeline.push({
        ts: entry.ts,
        event: entry.event,
        channel: entry.ch,
        detail: entry.meta ? JSON.stringify(entry.meta) : undefined,
      });
      continue;
    }

    const frame = parseFrame(entry.raw);
    if (!frame) continue;
    if (entry.ch === "browser" && entry.dir === "out" && frame.type === "run_state") {
      const state = typeof frame.state === "string" ? frame.state : "unknown";
      timeline.push({
        ts: entry.ts,
        event: `run_state:${state}`,
        channel: "browser",
        detail: typeof frame.reason === "string" ? frame.reason : undefined,
      });
      continue;
    }
    if (entry.ch === "extension") {
      const event =
        typeof frame.type === "string"
          ? frame.type
          : typeof frame.event === "string"
            ? frame.event
            : "event";
      timeline.push({
        ts: entry.ts,
        event: `extension:${event}`,
        channel: "extension",
      });
      continue;
    }
    if (
      entry.ch === "pi-rpc" &&
      typeof frame.type === "string" &&
      PI_RPC_TIMELINE_EVENTS.has(frame.type)
    ) {
      timeline.push({ ts: entry.ts, event: frame.type, channel: "pi-rpc" });
    }
  }

  return timeline.sort((left, right) => left.ts - right.ts);
}

function detectDisconnections(
  entries: RecordingEntry[],
  timeline: TimelineEntry[],
): DisconnectionEvent[] {
  const disconnections: DisconnectionEvent[] = [];

  for (let index = 0; index < timeline.length; index++) {
    const event = timeline[index]!;
    if (!DISCONNECT_EVENTS.has(event.event)) continue;

    let reconnectedAt: number | undefined;
    for (let cursor = index + 1; cursor < timeline.length; cursor++) {
      const candidate = timeline[cursor]!;
      if (candidate.channel === event.channel && RECONNECT_EVENTS.has(candidate.event)) {
        reconnectedAt = candidate.ts;
        break;
      }
    }

    let meta: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = event.detail ? JSON.parse(event.detail) : undefined;
      meta = isRecord(parsed) ? parsed : undefined;
    } catch {
      meta = undefined;
    }
    const messagesLostEstimate = reconnectedAt
      ? entries.filter(
          (entry) => entry.ts > event.ts && entry.ts < reconnectedAt! && entry.ch !== event.channel,
        ).length
      : 0;

    disconnections.push({
      ts: event.ts,
      channel: event.channel,
      closeCode: typeof meta?.code === "number" ? meta.code : undefined,
      closeReason: typeof meta?.reason === "string" ? meta.reason : event.detail,
      reconnectedAt,
      gapMs: reconnectedAt ? reconnectedAt - event.ts : 0,
      messagesLostEstimate,
    });
  }

  const deduped: DisconnectionEvent[] = [];
  for (const event of disconnections) {
    const sameOutage = deduped.some(
      (existing) =>
        existing.channel === event.channel &&
        (!existing.reconnectedAt || event.ts < existing.reconnectedAt),
    );
    if (!sameOutage) deduped.push(event);
  }
  return deduped;
}

function detectDataGaps(entries: RecordingEntry[]): DataGap[] {
  const rpcEntries = entries.filter(
    (entry) => entry.ch === "pi-rpc" && entry.dir === "in" && !entry.event,
  );
  const gaps: DataGap[] = [];
  for (let index = 1; index < rpcEntries.length; index++) {
    const previous = rpcEntries[index - 1]!;
    const current = rpcEntries[index]!;
    const gapMs = current.ts - previous.ts;
    if (gapMs <= PI_RPC_GAP_THRESHOLD_MS) continue;
    gaps.push({
      startTs: previous.ts,
      endTs: current.ts,
      gapMs,
      channel: "pi-rpc",
      messagesBefore: index,
      messagesAfter: rpcEntries.length - index,
    });
  }
  return gaps;
}

function detectPatterns(disconnections: DisconnectionEvent[], dataGaps: DataGap[]): string[] {
  const patterns: string[] = [];
  const rpcDisconnections = disconnections.filter((event) => event.channel === "pi-rpc");

  if (rpcDisconnections.length >= PATTERN_MIN_COUNT) {
    const intervals = rpcDisconnections
      .slice(1)
      .map((event, index) => event.ts - rpcDisconnections[index]!.ts);
    const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    if (
      intervals.every((interval) => Math.abs(interval - average) / average < INTERVAL_TOLERANCE)
    ) {
      patterns.push(`regular_pi_rpc_disconnects:${Math.round(average / 1000)}`);
    }
  }

  const rapidReconnects = disconnections.filter(
    (event) => event.reconnectedAt !== undefined && event.gapMs < 5_000,
  );
  if (rapidReconnects.length >= PATTERN_MIN_COUNT) {
    patterns.push(`rapid_reconnects:${rapidReconnects.length}`);
  }

  const unexplainedGaps = dataGaps.filter(
    (gap) => !disconnections.some((event) => event.ts >= gap.startTs && event.ts <= gap.endTs),
  );
  if (unexplainedGaps.length > 0) {
    patterns.push(`unexplained_pi_rpc_gaps:${unexplainedGaps.length}`);
  }

  const browserDisconnections = disconnections.filter((event) => event.channel === "browser");
  if (rpcDisconnections.length > 0 && browserDisconnections.length === 0) {
    patterns.push(`pi_rpc_only_disconnects:${rpcDisconnections.length}`);
  } else if (browserDisconnections.length > 0 && rpcDisconnections.length === 0) {
    patterns.push(`browser_only_disconnects:${browserDisconnections.length}`);
  }

  if (patterns.length === 0 && disconnections.length === 0 && dataGaps.length === 0) {
    patterns.push("no_disconnection_issues");
  }
  return patterns;
}
