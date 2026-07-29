#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
RUNTIME_DIR="$ROOT_DIR/.runtime"
SERVER_LOG="$RUNTIME_DIR/server.log"
VITE_LOG="$RUNTIME_DIR/vite.log"
SERVER_PID="$RUNTIME_DIR/server.pid"
VITE_PID="$RUNTIME_DIR/vite.pid"
PORTS_ENV="$RUNTIME_DIR/ports.env"

if [[ -f "$ROOT_DIR/.env" ]]; then
  if ! chmod 600 "$ROOT_DIR/.env" 2>/dev/null; then
    echo "warning: could not restrict $ROOT_DIR/.env to mode 600" >&2
  fi
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

requested_port="${PORT:-}"
requested_vite_port="${VITE_PORT:-}"
HOST="${HOST:-127.0.0.1}"
VITE_HOST="${VITE_HOST:-$HOST}"
RUNNER_LOCK_PATH="${PIWORK_RUNNER_LOCK_PATH:-$HOME/.piwork/runner.lock}"

mkdir -p "$RUNTIME_DIR" "$ROOT_DIR/data"

process_is_running() {
  local pid="$1"
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi
  local state
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [[ "$state" != Z* ]]
}

cleanup_runner_lock() {
  local pid="$1"
  if [[ -n "$pid" ]] && [[ -f "$RUNNER_LOCK_PATH" ]] && \
      grep -Eq "\"pid\"[[:space:]]*:[[:space:]]*$pid([,}])" "$RUNNER_LOCK_PATH"; then
    echo "removing orphaned runner lock for local API: $pid"
    rm -f "$RUNNER_LOCK_PATH"
  fi
}

stop_pid_file() {
  local label="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return 0
  fi

  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && process_is_running "$pid"; then
    echo "stopping existing $label: $pid"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..300}; do
      if ! process_is_running "$pid"; then
        break
      fi
      sleep 0.1
    done
    if process_is_running "$pid"; then
      echo "force stopping existing $label after 30 seconds: $pid"
      kill -KILL "$pid" >/dev/null 2>&1 || true
      for _ in {1..50}; do
        if ! process_is_running "$pid"; then
          break
        fi
        sleep 0.1
      done
    fi
    if process_is_running "$pid"; then
      echo "$label did not stop after SIGKILL: $pid" >&2
      return 1
    fi
  fi
  rm -f "$file"
}

local_api_pid="$(cat "$SERVER_PID" 2>/dev/null || true)"
stop_pid_file "local API" "$SERVER_PID"
cleanup_runner_lock "$local_api_pid"
stop_pid_file "Vite" "$VITE_PID"
rm -f \
  "$RUNTIME_DIR/com.piwork.local-api.plist" \
  "$RUNTIME_DIR/com.piwork.local-vite.plist" \
  "$PORTS_ENV"

clear_vite_cache() {
  if [[ "${PIWORK_ONLYOFFICE_KEEP_VITE_CACHE:-0}" == "1" ]]; then
    return 0
  fi

  local vite_cache_dir="$WEB_DIR/node_modules/.vite"
  if [[ -d "$vite_cache_dir" ]]; then
    echo "clearing Vite optimized dependency cache: $vite_cache_dir"
    rm -rf "$vite_cache_dir"
  fi
}

is_port_free() {
  local port="$1"
  ! lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local start="$1"
  local port="$start"
  while ! is_port_free "$port"; do
    port="$((port + 1))"
    if [[ "$port" -gt "$((start + 100))" ]]; then
      echo "no free port found starting at $start" >&2
      return 1
    fi
  done
  printf '%s\n' "$port"
}

PORT="${requested_port:-$(find_free_port 3457)}"
VITE_PORT="${requested_vite_port:-$(find_free_port 3458)}"

if [[ -n "$requested_port" ]] && ! is_port_free "$PORT"; then
  echo "requested API port $PORT is already in use" >&2
  exit 1
fi

if [[ -n "$requested_vite_port" ]] && ! is_port_free "$VITE_PORT"; then
  echo "requested Vite port $VITE_PORT is already in use" >&2
  exit 1
fi

BUN_BIN="$(command -v bun)"
BUNX_BIN="$(command -v bunx)"
DATA_ROOT="$(node -e 'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1], process.argv[2]));' \
  "$ROOT_DIR" "${PIWORK_DATA_ROOT:-data}")"
BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://127.0.0.1:$PORT}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for Better Auth + Postgres." >&2
  echo "Set DATABASE_URL in your shell or root .env, then run make migrate." >&2
  exit 1
fi

postgres_is_ready() {
  (
    cd "$WEB_DIR"
    DATABASE_URL="$DATABASE_URL" "$BUN_BIN" --eval '
    import { Pool } from "pg";
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query("select 1");
    } finally {
      await pool.end();
    }
    ' >/dev/null 2>&1
  )
}

if ! postgres_is_ready; then
  if "$ROOT_DIR/scripts/try-start-local-postgres.sh" "$DATABASE_URL"; then
    for _ in {1..20}; do
      if postgres_is_ready; then
        break
      fi
      sleep 0.5
    done
  fi
fi

if ! postgres_is_ready; then
  echo "Could not connect to Postgres using DATABASE_URL." >&2
  echo "Automatic local startup did not restore the connection; verify the service and credentials, then run make migrate." >&2
  exit 1
fi

api_env=(
  "PATH=$PATH"
  "TERM=xterm-256color"
  "PORT=$PORT"
  "HOST=$HOST"
  "PIWORK_SERVE_FRONTEND=0"
  "PIWORK_DATA_ROOT=$DATA_ROOT"
  "DATABASE_URL=$DATABASE_URL"
  "BETTER_AUTH_URL=$BETTER_AUTH_URL"
  "VITE_PORT=$VITE_PORT"
)

vite_env=(
  "PATH=$PATH"
  "TERM=xterm-256color"
  "PIWORK_DEV_CONTROL_PLANE_URL=http://127.0.0.1:$PORT"
)

add_optional_api_env() {
  local key="$1"
  local value="${2:-}"
  if [[ -n "$value" ]]; then
    api_env+=("$key=$value")
  fi
}

add_optional_vite_env() {
  local key="$1"
  local value="${2:-}"
  if [[ -n "$value" ]]; then
    vite_env+=("$key=$value")
  fi
}

for key in \
  BETTER_AUTH_SECRET \
  PIWORK_SESSION_SANDBOX \
  PIWORK_REQUIRE_SESSION_SANDBOX; do
  add_optional_api_env "$key" "${!key:-}"
done

add_optional_api_env "TMPDIR" "${TMPDIR:-}"

: >"$SERVER_LOG"
: >"$VITE_LOG"
clear_vite_cache

start_detached() {
  local label="$1"
  local cwd="$2"
  local log_file="$3"
  local pid_file="$4"
  shift 4

  local pid
  if ! pid="$(/usr/bin/perl -MPOSIX=setsid -e '
    my ($cwd, $log_file, @cmd) = @ARGV;
    defined(my $pid = fork) or die "fork failed: $!";
    if ($pid) {
      print "$pid\n";
      exit 0;
    }
    setsid() or die "setsid failed: $!";
    chdir $cwd or die "chdir $cwd failed: $!";
    open STDIN, "<", "/dev/null" or die "redirect stdin failed: $!";
    open STDOUT, ">>", $log_file or die "redirect stdout failed: $!";
    open STDERR, ">&", \*STDOUT or die "redirect stderr failed: $!";
    exec @cmd or die "exec $cmd[0] failed: $!";
  ' "$cwd" "$log_file" "$@")"; then
    echo "failed to start $label" >&2
    return 1
  fi
  printf '%s\n' "$pid" >"$pid_file"
}

cleanup_on_error() {
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    stop_pid_file "local API" "$SERVER_PID"
    stop_pid_file "Vite" "$VITE_PID"
  fi
}
trap cleanup_on_error EXIT

vite_args=(vite --host "$VITE_HOST" --port "$VITE_PORT" --strictPort)
if [[ "${PIWORK_ONLYOFFICE_KEEP_VITE_CACHE:-0}" != "1" ]]; then
  vite_args+=(--force)
fi

provider_bootstrap_fd=""
provider_api_key="${PIWORK_PI_PROVIDER_API_KEY:-}"
provider_keychain_service="${PIWORK_PI_PROVIDER_KEYCHAIN_SERVICE:-}"
if [[ -n "$provider_api_key" ]] && [[ -n "$provider_keychain_service" ]]; then
  echo "Set only one of PIWORK_PI_PROVIDER_API_KEY or PIWORK_PI_PROVIDER_KEYCHAIN_SERVICE." >&2
  exit 1
fi
if [[ -n "$provider_api_key" ]] || [[ -n "$provider_keychain_service" ]]; then
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v security >/dev/null 2>&1; then
    if [[ -n "$provider_keychain_service" ]]; then
      echo "PIWORK_PI_PROVIDER_KEYCHAIN_SERVICE requires macOS Keychain." >&2
      exit 1
    fi
  fi
  provider_bootstrap_file="$(mktemp "$RUNTIME_DIR/pi-provider-bootstrap.XXXXXX")"
  chmod 600 "$provider_bootstrap_file"
  if [[ -n "$provider_api_key" ]]; then
    provider_secret_command=(printf '%s' "$provider_api_key")
  else
    provider_secret_command=(security find-generic-password -s "$provider_keychain_service" -w)
  fi
  if ! "${provider_secret_command[@]}" |
    env -u PIWORK_PI_PROVIDER_API_KEY \
      "$BUN_BIN" "$WEB_DIR/scripts/prepare-provider-bootstrap.ts" >"$provider_bootstrap_file"; then
    rm -f "$provider_bootstrap_file"
    echo "Could not prepare the one-use Pi provider bootstrap." >&2
    exit 1
  fi
  unset PIWORK_PI_PROVIDER_API_KEY provider_api_key provider_secret_command
  exec 9<"$provider_bootstrap_file"
  rm -f "$provider_bootstrap_file"
  provider_bootstrap_fd="9"
  api_env+=("PIWORK_PI_PROVIDER_BOOTSTRAP_FD=$provider_bootstrap_fd")
fi

start_detached "local API" "$WEB_DIR" "$SERVER_LOG" "$SERVER_PID" env "${api_env[@]}" "$BUN_BIN" --hot server/index.ts
if [[ -n "$provider_bootstrap_fd" ]]; then
  exec 9<&-
fi
start_detached "Vite" "$WEB_DIR" "$VITE_LOG" "$VITE_PID" env "${vite_env[@]}" "$BUNX_BIN" "${vite_args[@]}"

wait_for_url() {
  local label="$1"
  local url="$2"
  local log_file="$3"

  for _ in {1..40}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "$label did not become ready. Last log lines:" >&2
  tail -n 80 "$log_file" >&2 || true
  return 1
}

wait_for_url "local API" "http://127.0.0.1:$PORT/build-info" "$SERVER_LOG"
wait_for_url "Vite" "http://127.0.0.1:$VITE_PORT/index.html" "$VITE_LOG"

cat >"$PORTS_ENV" <<EOF
PORT=$PORT
VITE_PORT=$VITE_PORT
PIWORK_DATA_ROOT=$(printf '%q' "$DATA_ROOT")
BETTER_AUTH_URL=$(printf '%q' "$BETTER_AUTH_URL")
EOF

echo "Piwork local dev started"
echo "  API:      http://127.0.0.1:$PORT"
echo "  Frontend: http://127.0.0.1:$VITE_PORT"
echo "  Data:     $DATA_ROOT"
echo "  Logs:     $SERVER_LOG, $VITE_LOG"

trap - EXIT
