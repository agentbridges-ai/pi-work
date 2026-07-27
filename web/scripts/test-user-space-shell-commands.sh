#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

bunx vitest run src/user-space.test.ts \
  -t "runs the just-bash browser command matrix|matches upstream just-bash shell-like syntax|runs the ruok self-test command"
