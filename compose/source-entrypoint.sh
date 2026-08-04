#!/usr/bin/env bash
set -euo pipefail

cd /workspace/web
bun server/index.ts &
api_pid=$!
bun node_modules/vite/bin/vite.js --host 0.0.0.0 --port 3458 --strictPort &
vite_pid=$!

cleanup() {
  kill "$api_pid" "$vite_pid" 2>/dev/null || true
  wait "$api_pid" "$vite_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait -n "$api_pid" "$vite_pid"
