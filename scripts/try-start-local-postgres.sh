#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
DATABASE_URL="${1:-}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "DATABASE_URL is required to start local Postgres." >&2
  exit 1
fi

database_endpoint="$(
  DATABASE_URL="$DATABASE_URL" node -e '
    const url = new URL(process.env.DATABASE_URL);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") process.exit(1);
    process.stdout.write(`${url.hostname}\t${url.port || "5432"}`);
  ' 2>/dev/null
)" || {
  echo "DATABASE_URL is not a valid Postgres URL." >&2
  exit 1
}
IFS=$'\t' read -r database_host database_port <<<"$database_endpoint"

case "$database_host" in
  127.0.0.1 | localhost | ::1 | \[::1\]) ;;
  *)
    echo "Postgres auto-start skipped because DATABASE_URL is not local." >&2
    exit 1
    ;;
esac

mkdir -p "$RUNTIME_DIR"

postgres_port_is_accepting() {
  local port="$1"
  if ! command -v pg_isready >/dev/null 2>&1; then
    return 1
  fi

  local host="${database_host#[}"
  host="${host%]}"
  pg_isready -h "$host" -p "$port" >/dev/null 2>&1
}

postgres_endpoint_is_accepting() {
  postgres_port_is_accepting "$database_port"
}

recover_stale_postmaster_pid() {
  local data_dir="$1"
  local pid_file="$data_dir/postmaster.pid"

  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi

  local recorded_pid recorded_data_dir recorded_port process_command lock_signature
  lock_signature="$(cksum "$pid_file")"
  recorded_pid="$(sed -n '1p' "$pid_file")"
  recorded_data_dir="$(sed -n '2p' "$pid_file")"
  recorded_port="$(sed -n '4p' "$pid_file")"

  if [[ ! "$recorded_pid" =~ ^[1-9][0-9]*$ ]] || [[ "$recorded_data_dir" != "$data_dir" ]] || \
      [[ ! "$recorded_port" =~ ^[1-9][0-9]*$ ]]; then
    echo "Refusing to modify an invalid or mismatched Postgres lock file: $pid_file" >&2
    return 1
  fi

  if postgres_endpoint_is_accepting || \
      { [[ "$recorded_port" != "$database_port" ]] && postgres_port_is_accepting "$recorded_port"; }; then
    echo "Refusing stale-lock recovery because Postgres is accepting connections." >&2
    return 1
  fi

  process_command="$(ps -p "$recorded_pid" -o command= 2>/dev/null || true)"
  if [[ "$process_command" =~ (^|/)postgres([[:space:]]|$) ]]; then
    echo "Refusing stale-lock recovery because PID $recorded_pid is a Postgres process." >&2
    return 1
  fi

  if [[ ! -f "$pid_file" ]] || [[ "$(cksum "$pid_file")" != "$lock_signature" ]]; then
    echo "Refusing stale-lock recovery because the lock file changed during validation." >&2
    return 1
  fi

  local backup_path="$RUNTIME_DIR/postmaster.pid.stale-$(date +%Y%m%d-%H%M%S)-$$"
  echo "Backing up stale Postgres lock file (PID $recorded_pid: ${process_command:-not running})"
  mv "$pid_file" "$backup_path"
  echo "Stale Postgres lock file moved to $backup_path"
}

if postgres_endpoint_is_accepting; then
  echo "Postgres is accepting local connections; verify DATABASE_URL credentials." >&2
  exit 1
fi

postgres_data_dir="${PIWORK_POSTGRES_DATA_DIR:-}"
pg_ctl_bin="${PIWORK_PG_CTL_BIN:-}"

if [[ -z "$postgres_data_dir" ]] || [[ -z "$pg_ctl_bin" ]]; then
  echo "Local Postgres auto-start requires PIWORK_POSTGRES_DATA_DIR and PIWORK_PG_CTL_BIN." >&2
  exit 1
fi
if [[ ! -x "$pg_ctl_bin" ]]; then
  echo "PIWORK_PG_CTL_BIN is not executable: $pg_ctl_bin" >&2
  exit 1
fi
if [[ -d "$postgres_data_dir" ]]; then
  postgres_data_dir="$(cd "$postgres_data_dir" && pwd -P)"
fi

echo "Postgres is unavailable; attempting $pg_ctl_bin start for data directory $postgres_data_dir"
if "$pg_ctl_bin" -D "$postgres_data_dir" -l "$RUNTIME_DIR/postgres.log" start; then
  exit 0
fi
if recover_stale_postmaster_pid "$postgres_data_dir"; then
  "$pg_ctl_bin" -D "$postgres_data_dir" -l "$RUNTIME_DIR/postgres.log" start
  exit 0
fi
exit 1
