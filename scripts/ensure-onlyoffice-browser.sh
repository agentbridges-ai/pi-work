#!/usr/bin/env bash
set -euo pipefail

echo "[onlyoffice-browser] retired: Piwork must not clone, build, or prepare OnlyOffice runtime assets." >&2
echo "Publish and verify the immutable runtime from agentbridges-ai/onlyoffice-browser, then update release/onlyoffice-release-manifest.json." >&2
exit 2
