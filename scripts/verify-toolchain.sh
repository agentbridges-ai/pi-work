#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="$ROOT_DIR/.tool-versions"

command -v mise >/dev/null 2>&1 || { echo '[toolchain] mise is required' >&2; exit 1; }

legacy_version() {
  local tool="$1"
  awk -v tool="$tool" '$1 == tool { print $2; exit }' "$VERSIONS_FILE"
}

mise_version() {
  local tool="$1"
  (cd "$ROOT_DIR" && mise config get "tools.$tool" --raw)
}

expected_version() {
  local tool="$1"
  mise_version "$tool"
}

for tool_pair in 'bun:bun' 'nodejs:node' 'postgres:postgres'; do
  legacy_tool="${tool_pair%%:*}"
  mise_tool="${tool_pair##*:}"
  expected="$(mise_version "$mise_tool")"
  legacy="$(legacy_version "$legacy_tool")"
  if [[ -z "$expected" || "$legacy" != "$expected" ]]; then
    printf '[toolchain] .tool-versions is out of sync with mise.toml for %s: expected %s, got %s\n' \
      "$mise_tool" "${expected:-<missing pin>}" "${legacy:-<missing mirror>}" >&2
    exit 1
  fi
done

check_exact() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    printf '[toolchain] %s version mismatch: expected %s, got %s\n' "$label" "${expected:-<missing pin>}" "${actual:-<missing binary>}" >&2
    exit 1
  fi
  printf '[toolchain] %s %s\n' "$label" "$actual"
}

command -v pg_dump >/dev/null 2>&1 || { echo '[toolchain] PostgreSQL client tools are required' >&2; exit 1; }

check_exact bun "$(expected_version bun)" "$(cd "$ROOT_DIR" && mise exec --locked --no-deps -- bun --version)"

version_at_least() {
  awk -v actual="$1" -v minimum="$2" 'BEGIN {
    split(actual, a, "."); split(minimum, m, ".");
    for (i = 1; i <= 3; i++) {
      if ((a[i] + 0) > (m[i] + 0)) exit 0;
      if ((a[i] + 0) < (m[i] + 0)) exit 1;
    }
    exit 0;
  }'
}

actual_node="$(cd "$ROOT_DIR" && mise exec --locked --no-deps -- node --version | sed 's/^v//')"
minimum_node='22.19.0'
version_at_least "$actual_node" "$minimum_node" || {
  printf '[toolchain] Node.js %s is unsupported; version %s or newer is required\n' "$actual_node" "$minimum_node" >&2
  exit 1
}
printf '[toolchain] Node.js %s (supported: >= %s)\n' "$actual_node" "$minimum_node"

mise exec --locked --no-deps -- node - "$ROOT_DIR/web" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const webRoot = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(webRoot, "package.json"), "utf8"));
const expected = {
  "@earendil-works/pi-coding-agent": "0.82.1",
  "@modelcontextprotocol/sdk": "1.29.0",
};
for (const [name, version] of Object.entries(expected)) {
  if (manifest.dependencies?.[name] !== version) {
    throw new Error(`${name} must be a direct exact dependency at ${version}`);
  }
  const installedPath = path.join(webRoot, "node_modules", ...name.split("/"), "package.json");
  const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
  if (installed.version !== version) {
    throw new Error(`${name} install mismatch: expected ${version}, found ${installed.version}`);
  }
}
if (Object.keys(manifest.dependencies || {}).some((name) => name.startsWith("@mariozechner/"))) {
  throw new Error("@mariozechner packages must not be direct dependencies");
}
const piPath = path.join(
  webRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const pi = JSON.parse(fs.readFileSync(piPath, "utf8"));
const optional = Object.entries(pi.optionalDependencies || {});
if (
  optional.length !== 1 ||
  optional[0][0] !== "@mariozechner/clipboard" ||
  optional[0][1] !== "0.3.9"
) {
  throw new Error(
    "Pi's sole allowed upstream @mariozechner dependency must be optional clipboard@0.3.9",
  );
}
const rpcExport = pi.exports?.["./rpc-entry"]?.import;
if (typeof rpcExport !== "string") throw new Error("Pi package does not export ./rpc-entry");
const rpcEntry = path.resolve(path.dirname(piPath), rpcExport);
if (!fs.statSync(rpcEntry).isFile()) throw new Error("Pi rpc-entry export is not a regular file");
console.log("[toolchain] Pi 0.82.1 rpc-entry and MCP SDK 1.29.0 verified");
NODE

if rg -n \
  --glob '*.{js,mjs,cjs,ts,tsx}' \
  --glob '!*.test.*' \
  --glob '!*.spec.*' \
  '@mariozechner/' \
  "$ROOT_DIR/web/bin" \
  "$ROOT_DIR/web/server" \
  "$ROOT_DIR/web/shared" \
  "$ROOT_DIR/web/src" \
  "$ROOT_DIR/web/scripts"; then
  echo '[toolchain] Production source must not import or reference @mariozechner packages.' >&2
  exit 1
fi

expected_postgres_major="$(expected_version postgres | cut -d. -f1)"
actual_postgres_major="$(pg_dump --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
check_exact 'PostgreSQL major' "$expected_postgres_major" "$actual_postgres_major"
