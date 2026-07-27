#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

fail() {
  printf '[backup] %s\n' "$*" >&2
  exit 1
}

resolve_from_root() {
  node -e 'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1], process.argv[2]));' "$ROOT_DIR" "$1"
}

for command in node git pg_dump pg_restore tar; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required; set it in the environment or root .env"
DATA_ROOT="$(resolve_from_root "${PIWORK_DATA_ROOT:-data}")"
BACKUP_ROOT="$(resolve_from_root "${PIWORK_BACKUP_ROOT:-backups}")"
[[ -d "$DATA_ROOT" ]] || fail "data root does not exist: $DATA_ROOT"

mkdir -p "$BACKUP_ROOT" "$RUNTIME_DIR"
chmod 0700 "$BACKUP_ROOT" "$RUNTIME_DIR"
DATA_ROOT="$(cd "$DATA_ROOT" && pwd -P)"
BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
case "$BACKUP_ROOT/" in
  "$DATA_ROOT/"*) fail "backup root must not be inside the data root" ;;
esac

LOCK_DIR="${PIWORK_MAINTENANCE_LOCK_DIR:-$RUNTIME_DIR/maintenance-backup.lock}"
if ! mkdir -m 0700 "$LOCK_DIR" 2>/dev/null; then
  fail "maintenance lock is already held: $LOCK_DIR"
fi

partial_dir=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$partial_dir" && -d "$partial_dir" ]]; then rm -rf "$partial_dir"; fi
  rm -rf "$LOCK_DIR"
  exit "$status"
}
trap cleanup EXIT INT TERM
printf '%s\n' "$$" >"$LOCK_DIR/pid"
chmod 0600 "$LOCK_DIR/pid"

server_pid_file="$RUNTIME_DIR/server.pid"
if [[ -f "$server_pid_file" ]]; then
  server_pid="$(tr -cd '0-9' <"$server_pid_file")"
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    fail "local API process $server_pid is running; stop it before taking a maintenance backup"
  fi
fi

runner_lock_path="${PIWORK_RUNNER_LOCK_PATH:-${PIWORK_HOME:-$HOME/.piwork}/runner.lock}"
if [[ -f "$runner_lock_path" ]]; then
  if node -e '
    const fs = require("node:fs");
    try {
      const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(Date.now() - Number(lock.heartbeatAt || 0) <= 45000 ? 0 : 1);
    } catch { process.exit(1); }
  ' "$runner_lock_path"; then
    fail "an active Piwork runner lock exists; stop the writer before backing up"
  fi
fi

created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
final_dir="$BACKUP_ROOT/piwork-$stamp"
partial_dir="$BACKUP_ROOT/.piwork-$stamp-$$.partial"
[[ ! -e "$final_dir" && ! -e "$partial_dir" ]] || fail "backup destination already exists"
mkdir -m 0700 "$partial_dir"

printf '[backup] dumping Postgres\n'
DATABASE_URL="$DATABASE_URL" node "$ROOT_DIR/scripts/run-pg-dump.mjs" "$partial_dir/postgres.dump"
chmod 0600 "$partial_dir/postgres.dump"

printf '[backup] archiving durable data\n'
tar -C "$DATA_ROOT" \
  --exclude='./tmp' --exclude='./tmp/*' --exclude='*/tmp' --exclude='*/tmp/*' \
  --exclude='./recordings' --exclude='./recordings/*' --exclude='*/recordings' --exclude='*/recordings/*' \
  --exclude='./user-space-checkouts' --exclude='./user-space-checkouts/*' --exclude='*/user-space-checkouts' --exclude='*/user-space-checkouts/*' \
  --exclude='./checkouts' --exclude='./checkouts/*' --exclude='*/checkouts' --exclude='*/checkouts/*' \
  --exclude='./.cache' --exclude='./.cache/*' --exclude='*/.cache' --exclude='*/.cache/*' \
  --exclude='./cache' --exclude='./cache/*' --exclude='*/cache' --exclude='*/cache/*' \
  --exclude='./caches' --exclude='./caches/*' --exclude='*/caches' --exclude='*/caches/*' \
  -cf "$partial_dir/data.tar" .
chmod 0600 "$partial_dir/data.tar"

source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
piwork_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT_DIR/package.json")"
node "$ROOT_DIR/scripts/backup-manifest.mjs" create \
  "$partial_dir" \
  "$created_at" \
  "$source_sha" \
  "$piwork_version" \
  "$(basename "$DATA_ROOT")" >/dev/null

"$ROOT_DIR/scripts/verify-backup.sh" "$partial_dir" >/dev/null
mv "$partial_dir" "$final_dir"
partial_dir=""
node "$ROOT_DIR/scripts/backup-manifest.mjs" seal "$final_dir"

printf '[backup] ready: %s\n' "$final_dir"
