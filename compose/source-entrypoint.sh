#!/usr/bin/env bash
set -euo pipefail

cd /workspace/web

# Source Compose can receive the provider bootstrap through the private
# runtime-secrets volume. Keep the API key on a one-use inherited descriptor;
# never copy it into the container environment or command line. The host-side
# selfhost setup may omit this file when no provider is configured.
provider_bootstrap_path="${PIWORK_PI_PROVIDER_BOOTSTRAP_FILE:-/run/piwork-secrets/pi-provider-bootstrap}"
if [[ -r "$provider_bootstrap_path" ]]; then
  exec 9<"$provider_bootstrap_path"
  export PIWORK_PI_PROVIDER_BOOTSTRAP_FD=9
fi

bun server/index.ts &
api_pid=$!
bun node_modules/vite/bin/vite.js --host 0.0.0.0 --port 3458 --strictPort &
vite_pid=$!

if [[ -n "${PIWORK_PI_PROVIDER_BOOTSTRAP_FD:-}" ]]; then
  exec 9<&-
fi

cleanup() {
  kill "$api_pid" "$vite_pid" 2>/dev/null || true
  wait "$api_pid" "$vite_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait -n "$api_pid" "$vite_pid"
