#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
recordings_root="${PIWORK_RECORDINGS_DIR:-${PIWORK_DATA_ROOT:-$ROOT_DIR/data}}"
session_id="${1:-}"

[[ -d "$recordings_root" ]] || {
  printf 'Recordings root not found: %s\n' "$recordings_root" >&2
  exit 1
}

node - "$recordings_root" "$session_id" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
const sessionId = process.argv[3];
const candidates = [];
function walk(current, depth = 0) {
  if (depth > 10) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const candidate = path.join(current, entry.name);
    if (entry.isDirectory()) walk(candidate, depth + 1);
    else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      entry.name.includes("_pi_") &&
      (!sessionId || entry.name.startsWith(`${sessionId}_pi_`))
    ) {
      candidates.push(candidate);
    }
  }
}
walk(root);
candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
const recording = candidates[0];
if (!recording) throw new Error(`No matching Pi recording found below ${root}.`);

const counts = { message_update: 0, message_delta: 0, tool_execution_update: 0 };
const lines = fs.readFileSync(recording, "utf8").split("\n");
if (lines.at(-1) !== "") throw new Error("Recording has a non-LF-terminated final frame.");
for (const line of lines.slice(1, -1)) {
  const entry = JSON.parse(line);
  if (!entry.raw) continue;
  const message = JSON.parse(entry.raw);
  if (Object.hasOwn(counts, message.type)) counts[message.type] += 1;
}
console.log(`Recording: ${recording}`);
for (const [type, count] of Object.entries(counts)) console.log(`${type}: ${count}`);
if (counts.message_update + counts.message_delta + counts.tool_execution_update === 0) {
  throw new Error("No native Pi or browser streaming deltas were found.");
}
NODE
