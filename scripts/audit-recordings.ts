#!/usr/bin/env bun
/**
 * Audit redacted native Pi RPC recordings without replaying them.
 *
 * Usage:
 *   bun run scripts/audit-recordings.ts
 *   bun run scripts/audit-recordings.ts --latest
 *   bun run scripts/audit-recordings.ts --session <id>
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface RecordingHeader {
  _header: true;
  version: number;
  session_id: string;
  backend_type: "pi";
  started_at: number;
}

interface RecordingEntry {
  ts: number;
  dir: "in" | "out";
  raw: string;
  ch: string;
  event?: string;
}

const args = process.argv.slice(2);
const latestOnly = args.includes("--latest");
const sessionIndex = args.indexOf("--session");
const sessionFilter = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
if (sessionIndex >= 0 && !sessionFilter) {
  throw new Error("--session requires an exact session ID.");
}

const configuredRoot =
  process.env.PIWORK_RECORDINGS_DIR || process.env.PIWORK_DATA_ROOT || join(process.cwd(), "data");
const recordingsRoot = resolve(configuredRoot);
const files: string[] = [];

function discover(path: string, depth = 0): void {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      discover(candidate, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(candidate);
    }
  }
}

discover(recordingsRoot);
let selected = files.filter((path) => {
  if (!basename(path).includes("_pi_")) return false;
  return !sessionFilter || basename(path).startsWith(`${sessionFilter}_pi_`);
});
if (latestOnly) {
  selected = selected
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, 1);
}
if (selected.length === 0) {
  throw new Error(`No matching Pi recordings found below ${recordingsRoot}.`);
}

const CORE_BROWSER_TYPES = new Set([
  "agent_message",
  "message_delta",
  "tool_execution",
  "interaction_request",
  "interaction_response",
  "run_state",
  "history_snapshot",
]);
const SENSITIVE_KEY =
  /^(api[_-]?key|authorization|bearer|capability|credential|password|private[_-]?key|secret|token)$/i;
const SAFE_REDACTION = /^\[(redacted|secret)\]$/i;
const counts = new Map<string, number>();
const browserTypes = new Map<string, number>();
const toolNames = new Map<string, number>();
let totalEntries = 0;
let lifecycleEntries = 0;
let extensionEntries = 0;
let invalidFiles = 0;
let sensitiveValues = 0;

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function inspectSecrets(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) inspectSecrets(item, seen);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      SENSITIVE_KEY.test(key) &&
      typeof child === "string" &&
      child.length > 0 &&
      !SAFE_REDACTION.test(child)
    ) {
      sensitiveValues += 1;
    }
    inspectSecrets(child, seen);
  }
}

for (const path of selected) {
  if (lstatSync(path).isSymbolicLink()) {
    invalidFiles += 1;
    continue;
  }
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) !== "") {
    invalidFiles += 1;
    continue;
  }
  lines.pop();
  if (lines.length === 0) {
    invalidFiles += 1;
    continue;
  }

  let header: RecordingHeader;
  try {
    header = JSON.parse(lines.shift() || "") as RecordingHeader;
  } catch {
    invalidFiles += 1;
    continue;
  }
  if (
    header._header !== true ||
    header.backend_type !== "pi" ||
    !Number.isInteger(header.version) ||
    header.version < 1
  ) {
    invalidFiles += 1;
    continue;
  }

  for (const line of lines) {
    let entry: RecordingEntry;
    try {
      entry = JSON.parse(line) as RecordingEntry;
    } catch {
      invalidFiles += 1;
      break;
    }
    if (
      typeof entry.ts !== "number" ||
      (entry.dir !== "in" && entry.dir !== "out") ||
      typeof entry.raw !== "string" ||
      typeof entry.ch !== "string"
    ) {
      invalidFiles += 1;
      break;
    }
    totalEntries += 1;
    if (entry.event) lifecycleEntries += 1;
    if (entry.ch.includes("extension")) extensionEntries += 1;
    if (!entry.raw) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(entry.raw) as Record<string, unknown>;
    } catch {
      invalidFiles += 1;
      break;
    }
    inspectSecrets(record);
    const type = typeof record.type === "string" ? record.type : "unknown";
    increment(counts, `${entry.ch}:${entry.dir}:${type}`);
    if (entry.ch === "browser" && entry.dir === "out") {
      increment(browserTypes, type);
    }
    const toolName =
      typeof record.toolName === "string"
        ? record.toolName
        : typeof record.tool_name === "string"
          ? record.tool_name
          : undefined;
    if (toolName) increment(toolNames, toolName);
  }
}

console.log(`Pi recordings: ${selected.length}`);
console.log(`Entries: ${totalEntries}`);
console.log(`Lifecycle entries: ${lifecycleEntries}`);
console.log(`Extension entries: ${extensionEntries}`);
for (const [key, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${key}: ${count}`);
}
if (browserTypes.size > 0) {
  console.log("Browser events:");
  for (const [type, count] of [...browserTypes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    console.log(`  ${CORE_BROWSER_TYPES.has(type) ? "core" : "additional"} ${type}: ${count}`);
  }
}
if (toolNames.size > 0) {
  console.log("Tools:");
  for (const [name, count] of [...toolNames].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${name}: ${count}`);
  }
}
if (invalidFiles > 0 || sensitiveValues > 0) {
  throw new Error(
    `Recording audit failed: ${invalidFiles} malformed file(s), ` +
      `${sensitiveValues} unredacted sensitive value(s).`,
  );
}
