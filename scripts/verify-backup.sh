#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf '[backup-verify] %s\n' "$*" >&2
  exit 1
}

verify_data_archive() {
  local archive="$1"
  local listing
  listing="$(mktemp "${TMPDIR:-/tmp}/piwork-backup-list.XXXXXX")"
  trap 'rm -f "$listing"' RETURN
  tar -tf "$archive" >"$listing"
  node - "$listing" <<'NODE'
const fs = require("node:fs");
const forbidden = new Set([".cache", "cache", "caches", "checkouts", "recordings", "tmp", "user-space-checkouts"]);
const entries = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
for (const entry of entries) {
  if (entry.includes("\0") || entry.startsWith("/")) throw new Error(`unsafe archive path: ${entry}`);
  const parts = entry.replace(/^\.\//, "").replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.includes("..")) throw new Error(`archive traversal path: ${entry}`);
  const excluded = parts.find((part) => forbidden.has(part));
  if (excluded) throw new Error(`excluded directory present in archive (${excluded}): ${entry}`);
}
NODE
  rm -f "$listing"
  trap - RETURN
}

run_self_test() {
  local temp_dir source_dir backup_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/piwork-backup-self-test.XXXXXX")"
  trap "rm -rf '$temp_dir'" EXIT
  source_dir="$temp_dir/source"
  backup_dir="$temp_dir/backup"
  mkdir -p \
    "$source_dir/user/session/workspace" \
    "$source_dir/user/session/tmp" \
    "$source_dir/user/session/recordings" \
    "$source_dir/user/session/user-space-checkouts" \
    "$source_dir/user/session/cache" \
    "$backup_dir"
  printf '%s\n' '{"ok":true}' >"$source_dir/user/session/session.json"
  printf '%s\n' 'durable' >"$source_dir/user/session/workspace/file.txt"
  printf '%s\n' 'excluded' >"$source_dir/user/session/tmp/file.txt"
  printf '%s\n' 'excluded' >"$source_dir/user/session/recordings/raw.jsonl"
  printf '%s\n' 'excluded' >"$source_dir/user/session/user-space-checkouts/blob"
  printf '%s\n' 'excluded' >"$source_dir/user/session/cache/item"
  printf '%s\n' 'self-test dump placeholder' >"$backup_dir/postgres.dump"
  tar -C "$source_dir" \
    --exclude='*/tmp' --exclude='*/tmp/*' \
    --exclude='*/recordings' --exclude='*/recordings/*' \
    --exclude='*/user-space-checkouts' --exclude='*/user-space-checkouts/*' \
    --exclude='*/checkouts' --exclude='*/checkouts/*' \
    --exclude='*/.cache' --exclude='*/.cache/*' \
    --exclude='*/cache' --exclude='*/cache/*' \
    --exclude='*/caches' --exclude='*/caches/*' \
    -cf "$backup_dir/data.tar" .
  node "$ROOT_DIR/scripts/backup-manifest.mjs" create \
    "$backup_dir" \
    '2026-07-10T00:00:00Z' \
    '0000000000000000000000000000000000000000' \
    'self-test' \
    'data' >/dev/null
  node "$ROOT_DIR/scripts/backup-manifest.mjs" verify "$backup_dir" >/dev/null
  verify_data_archive "$backup_dir/data.tar"
  printf '%s' 'tamper' >>"$backup_dir/data.tar"
  if node "$ROOT_DIR/scripts/backup-manifest.mjs" verify "$backup_dir" >/dev/null 2>&1; then
    fail "checksum self-test accepted a modified archive"
  fi
  printf '[backup-verify] self-test ready\n'
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

[[ $# -eq 1 ]] || fail "usage: verify-backup.sh /path/to/backup"
for command in node pg_restore tar; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

BACKUP_DIR="$(cd "$1" 2>/dev/null && pwd -P)" || fail "backup directory does not exist: $1"
node "$ROOT_DIR/scripts/backup-manifest.mjs" verify "$BACKUP_DIR"
pg_restore --list "$BACKUP_DIR/postgres.dump" >/dev/null
verify_data_archive "$BACKUP_DIR/data.tar"
printf '[backup-verify] PostgreSQL dump and durable data archive are valid\n'
printf '[backup-verify] no restore or extraction was performed\n'
