#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

MANIFEST="$ROOT_DIR/release/agent-browser-release-manifest.json"
AGENT_BROWSER_DIR="${PIWORK_AGENT_BROWSER_DIR:-$ROOT_DIR/agent-browser}"

log() {
  printf '[agent-browser] %s\n' "$*"
}

fail() {
  printf '[agent-browser] %s\n' "$*" >&2
  exit 1
}

manifest_value() {
  node -e '
    const fs = require("node:fs");
    const value = process.argv[2].split(".").reduce((cursor, part) => cursor?.[part], JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
    if ((typeof value !== "string" && typeof value !== "number") || value === "") process.exit(1);
    process.stdout.write(String(value));
  ' "$MANIFEST" "$1"
}

manifest_optional_value() {
  node -e '
    const fs = require("node:fs");
    const value = process.argv[2].split(".").reduce((cursor, part) => cursor?.[part], JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
    if (typeof value === "string" || typeof value === "number") process.stdout.write(String(value));
  ' "$MANIFEST" "$1"
}

[[ -f "$MANIFEST" ]] || fail "release manifest is missing: $MANIFEST"

PINNED_REPOSITORY="$(manifest_value repository)"
PINNED_BRANCH="$(manifest_value sourceBranch)"
PINNED_FETCH_REPOSITORY="$(manifest_optional_value fetchRepository)"
PINNED_FETCH_BRANCH="$(manifest_optional_value fetchBranch)"
PINNED_COMMIT="$(manifest_value commitSha)"
PINNED_VERSION="$(manifest_value cliVersion)"
PROVIDER_PACKAGE="$(manifest_value providerPackage)"
AGENT_BROWSER_REPOSITORY="${PIWORK_AGENT_BROWSER_REPOSITORY:-${PINNED_FETCH_REPOSITORY:-$PINNED_REPOSITORY}}"
AGENT_BROWSER_BRANCH="${PINNED_FETCH_BRANCH:-$PINNED_BRANCH}"
AGENT_BROWSER_COMMIT="${PIWORK_AGENT_BROWSER_COMMIT:-$PINNED_COMMIT}"

[[ "$AGENT_BROWSER_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "invalid pinned commit: $AGENT_BROWSER_COMMIT"

node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
(( node_major >= 24 )) || fail "Node.js 24 or newer is required to build the Chrome extension provider"

run_pnpm() {
  local candidate resolved

  if [[ -n "${PIWORK_PNPM_BIN:-}" ]]; then
    [[ -x "$PIWORK_PNPM_BIN" ]] || fail "PIWORK_PNPM_BIN is not executable: $PIWORK_PNPM_BIN"
    "$PIWORK_PNPM_BIN" "$@"
    return
  fi

  # Prefer a real pnpm installation. Corepack's pnpm shim prompts for a
  # download whenever its cache is unavailable, which makes `make dev`
  # unexpectedly interactive on every invocation after a failed download.
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] || continue
    resolved="$candidate"
    if command -v realpath >/dev/null 2>&1; then
      resolved="$(realpath "$candidate" 2>/dev/null || printf '%s' "$candidate")"
    fi
    [[ "$resolved" == */corepack/* || "$resolved" == */corepack ]] && continue
    "$candidate" "$@"
    return
  done < <(type -ap pnpm 2>/dev/null | awk '!seen[$0]++')

  if command -v corepack >/dev/null 2>&1; then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@" || fail "pnpm 11 or newer is required. Install pnpm 11 (for example: brew install pnpm) or set PIWORK_PNPM_BIN to a real pnpm executable."
    return
  fi
  fail "pnpm 11 or newer is required. Install pnpm 11 or set PIWORK_PNPM_BIN to a real pnpm executable."
}

clone_checkout() {
  local staged_dir="${AGENT_BROWSER_DIR}.clone.$$"
  mkdir -p "$(dirname "$AGENT_BROWSER_DIR")"
  rm -rf "$staged_dir"
  log "fetching $AGENT_BROWSER_COMMIT from $AGENT_BROWSER_REPOSITORY ($AGENT_BROWSER_BRANCH)"
  if ! (
    git init -q "$staged_dir" \
      && git -C "$staged_dir" remote add origin "$AGENT_BROWSER_REPOSITORY" \
      && git -C "$staged_dir" fetch --depth 1 origin "$AGENT_BROWSER_COMMIT" >/dev/null \
      && git -C "$staged_dir" checkout --detach FETCH_HEAD >/dev/null
  ); then
    rm -rf "$staged_dir"
    fail "failed to fetch pinned agent-browser commit"
  fi
  mv "$staged_dir" "$AGENT_BROWSER_DIR"
}

ensure_checkout() {
  if [[ -d "$AGENT_BROWSER_DIR/.git" ]] && ! git -C "$AGENT_BROWSER_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
    if find "$AGENT_BROWSER_DIR" -mindepth 1 -maxdepth 1 ! -name .git -print -quit | grep -q .; then
      fail "$AGENT_BROWSER_DIR is an incomplete checkout with unexpected files; refusing to replace it"
    fi
    rm -rf "$AGENT_BROWSER_DIR"
  fi
  if [[ ! -e "$AGENT_BROWSER_DIR" ]]; then
    clone_checkout
  fi
  [[ -d "$AGENT_BROWSER_DIR/.git" ]] || fail "$AGENT_BROWSER_DIR exists but is not a git checkout"
  [[ -f "$AGENT_BROWSER_DIR/package.json" ]] || fail "$AGENT_BROWSER_DIR/package.json is missing"

  local current_commit
  current_commit="$(git -C "$AGENT_BROWSER_DIR" rev-parse HEAD)"
  if [[ "$current_commit" != "$AGENT_BROWSER_COMMIT" ]]; then
    git -C "$AGENT_BROWSER_DIR" diff --quiet && git -C "$AGENT_BROWSER_DIR" diff --cached --quiet \
      || fail "$AGENT_BROWSER_DIR has local changes; refusing to replace its checkout"
    log "checking out pinned commit $AGENT_BROWSER_COMMIT"
    git -C "$AGENT_BROWSER_DIR" fetch --depth 1 origin "$AGENT_BROWSER_COMMIT" >/dev/null
    git -C "$AGENT_BROWSER_DIR" checkout --detach FETCH_HEAD >/dev/null
  fi

  local current_version
  current_version="$(node -p "require(process.argv[1]).version" "$AGENT_BROWSER_DIR/package.json")"
  [[ "$current_version" == "$PINNED_VERSION" ]] || fail "agent-browser version is $current_version, expected $PINNED_VERSION"
}

platform_binary() {
  node -e '
    const os = require("node:os");
    const platform = os.platform();
    const arch = os.arch();
    const osKey = platform === "win32" ? "win32" : platform;
    const archKey = platform === "win32" && arch === "arm64" ? "x64" : arch;
    process.stdout.write(`agent-browser-${osKey}-${archKey}${platform === "win32" ? ".exe" : ""}`);
  '
}

ensure_dependencies() {
  local provider_dir="$AGENT_BROWSER_DIR/$PROVIDER_PACKAGE"
  if [[ ! -f "$provider_dir/node_modules/.bin/tsc" || "$AGENT_BROWSER_DIR/pnpm-lock.yaml" -nt "$provider_dir/node_modules/.bin/tsc" ]]; then
    log "installing Chrome extension provider dependencies"
    (cd "$AGENT_BROWSER_DIR" && run_pnpm install --frozen-lockfile --filter '@agent-browser/chrome-extension-provider...')
  fi
}

ensure_cli() {
  local binary="$AGENT_BROWSER_DIR/bin/$(platform_binary)"
  if [[ ! -x "$binary" ]]; then
    log "installing the pinned $PINNED_VERSION native CLI"
    (cd "$AGENT_BROWSER_DIR" && node scripts/postinstall.js)
  fi
  [[ -x "$binary" ]] || fail "native agent-browser CLI is unavailable: $binary"
}

ensure_provider() {
  local provider_dir="$AGENT_BROWSER_DIR/$PROVIDER_PACKAGE"
  local plugin="$provider_dir/dist/plugin.js"
  local extension_manifest="$provider_dir/.output/chrome-mv3/manifest.json"
  local source_newer=0
  local extension_source_newer=0
  if [[ -f "$plugin" ]] && find "$provider_dir/src" -type f -newer "$plugin" -print -quit | grep -q .; then
    source_newer=1
  fi
  if [[ -f "$extension_manifest" ]] && find "$provider_dir/entrypoints" -type f -newer "$extension_manifest" -print -quit | grep -q .; then
    extension_source_newer=1
  fi
  if [[ ! -f "$plugin" || ! -f "$extension_manifest" \
    || "$source_newer" == "1" || "$extension_source_newer" == "1" ]]; then
    log "building Chrome extension provider"
    (cd "$AGENT_BROWSER_DIR" && run_pnpm --filter '@agent-browser/chrome-extension-provider' build)
  fi
  [[ -f "$plugin" ]] || fail "provider plugin build is missing: $plugin"
  [[ -f "$extension_manifest" ]] || fail "Chrome extension build is missing: $extension_manifest"
}

ensure_checkout
ensure_dependencies
ensure_cli
ensure_provider

log "ready at commit $AGENT_BROWSER_COMMIT"
log "Chrome unpacked extension: $AGENT_BROWSER_DIR/$PROVIDER_PACKAGE/.output/chrome-mv3"
