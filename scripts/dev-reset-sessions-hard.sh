#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_ROOT="$(node -e 'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1], process.argv[2]));' \
  "$ROOT_DIR" "${PIWORK_DATA_ROOT:-data}")"

if [[ "${CONFIRM_HARD_RESET:-0}" != "1" ]]; then
  echo "Refusing to hard reset local session data. Re-run with CONFIRM_HARD_RESET=1." >&2
  exit 2
fi

case "$DATA_ROOT" in
  "$ROOT_DIR"/data|"$ROOT_DIR"/data/)
    ;;
  *)
    if [[ "${ALLOW_EXTERNAL_DATA_ROOT_RESET:-0}" != "1" ]]; then
      echo "Data root is outside the repository: $DATA_ROOT" >&2
      echo "Set ALLOW_EXTERNAL_DATA_ROOT_RESET=1 only for disposable local data." >&2
      exit 2
    fi
    ;;
esac

echo "Hard reset will remove local Piwork data at: $DATA_ROOT"
rm -rf "$DATA_ROOT"
mkdir -p "$DATA_ROOT"
echo "Local data reset complete."
