#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

forbidden_paths=(
  "web/server/claude-adapter.ts"
  "web/server/claude-ccrv2-bridge.ts"
  "web/server/claude-code-version.ts"
  "web/server/cli-launcher.ts"
  "web/server/local-claude-config.ts"
  "web/server/sdk-bypass.ts"
  "web/server/session-launch-preparer.ts"
  "web/server/protocol/claude-upstream"
)

for relative_path in "${forbidden_paths[@]}"; do
  if [[ -e "$ROOT_DIR/$relative_path" || -L "$ROOT_DIR/$relative_path" ]]; then
    printf '[pi-only] forbidden legacy runtime path remains: %s\n' "$relative_path" >&2
    exit 1
  fi
done

if rg -n -i \
  --glob '*.{js,mjs,cjs,ts,tsx}' \
  --glob '!*.test.*' \
  --glob '!*.spec.*' \
  '(claude|ccr|--sdk-url|sdk[_-]?url|worker[_ -]?token)' \
  "$ROOT_DIR/web/bin" \
  "$ROOT_DIR/web/server" \
  "$ROOT_DIR/web/shared" \
  "$ROOT_DIR/web/src" \
  "$ROOT_DIR/web/scripts"; then
  echo '[pi-only] production source still contains a legacy Agent runtime surface' >&2
  exit 1
fi

if rg -n \
  --glob '*.{js,mjs,cjs,ts,tsx}' \
  --glob '!*.test.*' \
  --glob '!*.spec.*' \
  '(cliSessionId|session:first-turn-completed|CLI WebSocket|CLI socket|--resume)' \
  "$ROOT_DIR/web/bin" \
  "$ROOT_DIR/web/server" \
  "$ROOT_DIR/web/shared" \
  "$ROOT_DIR/web/src" \
  "$ROOT_DIR/web/scripts"; then
  echo '[pi-only] production source still contains a retired CLI transport contract' >&2
  exit 1
fi

echo '[pi-only] production source contains only the native Pi runtime surface'
