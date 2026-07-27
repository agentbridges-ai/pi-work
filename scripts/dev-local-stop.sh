#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
RUNNER_LOCK_PATH="${PIWORK_RUNNER_LOCK_PATH:-$HOME/.piwork/runner.lock}"

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
    echo "stopping $label: $pid"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..300}; do
      if ! process_is_running "$pid"; then
        break
      fi
      sleep 0.1
    done
    if process_is_running "$pid"; then
      echo "force stopping $label after 30 seconds: $pid"
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

local_api_pid="$(cat "$RUNTIME_DIR/server.pid" 2>/dev/null || true)"
stop_pid_file "local API" "$RUNTIME_DIR/server.pid"
cleanup_runner_lock "$local_api_pid"
stop_pid_file "Vite" "$RUNTIME_DIR/vite.pid"

rm -f \
  "$RUNTIME_DIR/com.piwork.local-api.plist" \
  "$RUNTIME_DIR/com.piwork.local-vite.plist" \
  "$RUNTIME_DIR/ports.env"
