#!/usr/bin/env bash
set -euo pipefail

cd /workspace/web
bun scripts/compose-migrate.ts
