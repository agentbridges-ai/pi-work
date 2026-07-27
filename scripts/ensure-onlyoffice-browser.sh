#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

ONLYOFFICE_RELEASE_MANIFEST="$ROOT_DIR/release/onlyoffice-release-manifest.json"
if [[ ! -f "$ONLYOFFICE_RELEASE_MANIFEST" ]]; then
  printf '[onlyoffice-browser] release manifest is missing: %s\n' "$ONLYOFFICE_RELEASE_MANIFEST" >&2
  exit 1
fi

read_release_manifest_value() {
  local expression="$1"
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const parts = process.argv[2].split(".");
    let value = manifest;
    for (const part of parts) value = value?.[part];
    if (typeof value !== "string" || !value) process.exit(1);
    process.stdout.write(value);
  ' "$ONLYOFFICE_RELEASE_MANIFEST" "$expression"
}

PINNED_ONLYOFFICE_BROWSER_VERSION="$(read_release_manifest_value 'repositories.onlyoffice-browser.version')"
PINNED_ONLYOFFICE_BROWSER_COMMIT="$(read_release_manifest_value 'repositories.onlyoffice-browser.commitSha')"
PINNED_ONLYOFFICE_HOST_BUILD_ID="$(read_release_manifest_value 'runtimeIdentity.hostBuildId')"

DEFAULT_ONLYOFFICE_BROWSER_VERSION="$(
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const dep =
      pkg.dependencies?.["@agentbridges-ai/onlyoffice-browser"] ||
      pkg.devDependencies?.["@agentbridges-ai/onlyoffice-browser"] ||
      "0.3.29";
    const match = String(dep).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    process.stdout.write(match ? match[0] : "0.3.29");
  ' "$ROOT_DIR/web/package.json" 2>/dev/null || printf '0.3.29'
)"
if [[ "$DEFAULT_ONLYOFFICE_BROWSER_VERSION" != "$PINNED_ONLYOFFICE_BROWSER_VERSION" ]]; then
  printf '[onlyoffice-browser] web/package.json requires %s but the release manifest pins %s. Update both together.\n' \
    "$DEFAULT_ONLYOFFICE_BROWSER_VERSION" \
    "$PINNED_ONLYOFFICE_BROWSER_VERSION" >&2
  exit 1
fi

CONFIGURED_ONLYOFFICE_BROWSER_VERSION="${PIWORK_ONLYOFFICE_BROWSER_VERSION:-}"
if [[ -n "$CONFIGURED_ONLYOFFICE_BROWSER_VERSION" && "$CONFIGURED_ONLYOFFICE_BROWSER_VERSION" != "$DEFAULT_ONLYOFFICE_BROWSER_VERSION" ]]; then
  if [[ "${PIWORK_ONLYOFFICE_BROWSER_ALLOW_VERSION_OVERRIDE:-0}" == "1" ]]; then
    ONLYOFFICE_BROWSER_VERSION="$CONFIGURED_ONLYOFFICE_BROWSER_VERSION"
  else
    printf '[onlyoffice-browser] ignoring PIWORK_ONLYOFFICE_BROWSER_VERSION=%s because web/package.json requires %s. Set PIWORK_ONLYOFFICE_BROWSER_ALLOW_VERSION_OVERRIDE=1 to force it.\n' \
      "$CONFIGURED_ONLYOFFICE_BROWSER_VERSION" \
      "$DEFAULT_ONLYOFFICE_BROWSER_VERSION"
    ONLYOFFICE_BROWSER_VERSION="$DEFAULT_ONLYOFFICE_BROWSER_VERSION"
  fi
else
  ONLYOFFICE_BROWSER_VERSION="${CONFIGURED_ONLYOFFICE_BROWSER_VERSION:-$DEFAULT_ONLYOFFICE_BROWSER_VERSION}"
fi

ONLYOFFICE_BROWSER_COMMIT="$PINNED_ONLYOFFICE_BROWSER_COMMIT"
CONFIGURED_ONLYOFFICE_BROWSER_COMMIT="${PIWORK_ONLYOFFICE_BROWSER_COMMIT:-}"
if [[ -n "$CONFIGURED_ONLYOFFICE_BROWSER_COMMIT" && "$CONFIGURED_ONLYOFFICE_BROWSER_COMMIT" != "$PINNED_ONLYOFFICE_BROWSER_COMMIT" ]]; then
  if [[ "${PIWORK_ONLYOFFICE_BROWSER_ALLOW_COMMIT_OVERRIDE:-0}" == "1" ]]; then
    ONLYOFFICE_BROWSER_COMMIT="$CONFIGURED_ONLYOFFICE_BROWSER_COMMIT"
  else
    printf '[onlyoffice-browser] ignoring PIWORK_ONLYOFFICE_BROWSER_COMMIT=%s because the release manifest pins %s. Set PIWORK_ONLYOFFICE_BROWSER_ALLOW_COMMIT_OVERRIDE=1 for development only.\n' \
      "$CONFIGURED_ONLYOFFICE_BROWSER_COMMIT" \
      "$PINNED_ONLYOFFICE_BROWSER_COMMIT"
  fi
fi
if [[ "$ONLYOFFICE_BROWSER_VERSION" != "$PINNED_ONLYOFFICE_BROWSER_VERSION" && "$ONLYOFFICE_BROWSER_COMMIT" == "$PINNED_ONLYOFFICE_BROWSER_COMMIT" ]]; then
  printf '[onlyoffice-browser] a version override also requires an explicit commit override; refusing to use a moving branch.\n' >&2
  exit 1
fi
if [[ ! "$ONLYOFFICE_BROWSER_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  printf '[onlyoffice-browser] invalid pinned commit: %s\n' "$ONLYOFFICE_BROWSER_COMMIT" >&2
  exit 1
fi
ONLYOFFICE_BROWSER_REPO="${PIWORK_ONLYOFFICE_BROWSER_REPO:-https://github.com/agentbridges-ai/onlyoffice-browser.git}"
ONLYOFFICE_BROWSER_DIR="${PIWORK_ONLYOFFICE_BROWSER_DIR:-$ROOT_DIR/onlyoffice-browser}"
ONLYOFFICE_BROWSER_FONT_ASSETS_DIR="${PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR:-${ONLYOFFICE_BROWSER_FONT_ASSETS_DIR:-$ONLYOFFICE_BROWSER_DIR/.onlyoffice-font-assets}}"
ONLYOFFICE_BROWSER_FONT_SOURCE_DIR="${PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR:-${ONLYOFFICE_BROWSER_FONT_SOURCE_DIR:-}}"
ONLYOFFICE_BROWSER_FONT_SET_CONFIGURED="${PIWORK_ONLYOFFICE_BROWSER_FONT_SET:-${ONLYOFFICE_BROWSER_FONT_SET:-}}"
ONLYOFFICE_BROWSER_FONT_SET="${ONLYOFFICE_BROWSER_FONT_SET_CONFIGURED:-zh-core}"
ONLYOFFICE_BROWSER_DEFAULT_FONT_ASSETS_DIR="$ONLYOFFICE_BROWSER_DIR/.onlyoffice-font-assets"
ONLYOFFICE_BROWSER_PLATFORM_METADATA_REMOVED=0
ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT="${PIWORK_ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT:-0}"

if [[ "$ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT" != "0" && "$ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT" != "1" ]]; then
  printf '[onlyoffice-browser] PIWORK_ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT must be 0 or 1.\n' >&2
  exit 1
fi

log() {
  printf '[onlyoffice-browser] %s\n' "$*"
}

fail() {
  printf '[onlyoffice-browser] %s\n' "$*" >&2
  exit 1
}

package_version() {
  node -e 'const fs = require("node:fs"); const path = process.argv[1]; console.log(JSON.parse(fs.readFileSync(path, "utf8")).version || "");' "$1/package.json"
}

git_is_dirty() {
  ! git -C "$ONLYOFFICE_BROWSER_DIR" diff --quiet || ! git -C "$ONLYOFFICE_BROWSER_DIR" diff --cached --quiet
}

clone_onlyoffice_browser() {
  mkdir -p "$(dirname "$ONLYOFFICE_BROWSER_DIR")"
  log "fetching onlyoffice-browser $ONLYOFFICE_BROWSER_COMMIT into $ONLYOFFICE_BROWSER_DIR"
  mkdir -p "$ONLYOFFICE_BROWSER_DIR"
  git -C "$ONLYOFFICE_BROWSER_DIR" init -q
  git -C "$ONLYOFFICE_BROWSER_DIR" remote add origin "$ONLYOFFICE_BROWSER_REPO"
  git -C "$ONLYOFFICE_BROWSER_DIR" fetch --depth 1 origin "$ONLYOFFICE_BROWSER_COMMIT" >/dev/null
  git -C "$ONLYOFFICE_BROWSER_DIR" checkout --detach FETCH_HEAD >/dev/null
}

checkout_onlyoffice_browser_version() {
  if [[ ! -d "$ONLYOFFICE_BROWSER_DIR/.git" ]]; then
    fail "$ONLYOFFICE_BROWSER_DIR exists but is not a git checkout. Set PIWORK_ONLYOFFICE_BROWSER_DIR or move it aside."
  fi

  if git_is_dirty; then
    fail "$ONLYOFFICE_BROWSER_DIR has local changes and is not version $ONLYOFFICE_BROWSER_VERSION. Commit/stash them or set PIWORK_ONLYOFFICE_BROWSER_VERSION."
  fi

  log "checking out onlyoffice-browser $ONLYOFFICE_BROWSER_COMMIT"
  git -C "$ONLYOFFICE_BROWSER_DIR" fetch --depth 1 origin "$ONLYOFFICE_BROWSER_COMMIT" >/dev/null
  git -C "$ONLYOFFICE_BROWSER_DIR" checkout --detach FETCH_HEAD >/dev/null
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    fail "pnpm or corepack is required to prepare onlyoffice-browser."
  fi
}

ensure_checkout() {
  if [[ ! -e "$ONLYOFFICE_BROWSER_DIR" ]]; then
    clone_onlyoffice_browser
  fi

  if [[ ! -f "$ONLYOFFICE_BROWSER_DIR/package.json" ]]; then
    fail "$ONLYOFFICE_BROWSER_DIR/package.json is missing."
  fi
  if [[ ! -d "$ONLYOFFICE_BROWSER_DIR/.git" ]]; then
    fail "$ONLYOFFICE_BROWSER_DIR exists but is not a git checkout. Set PIWORK_ONLYOFFICE_BROWSER_DIR or move it aside."
  fi

  if [[ "$ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT" == "1" ]]; then
    # Release preparation intentionally leaves the managed checkout detached at
    # the manifest commit. Development must return to the repo-local main branch
    # when it is safe, otherwise a later `make dev` silently serves the old
    # released runtime instead of the current OnlyOffice worktree.
    if ! git_is_dirty \
      && ! git -C "$ONLYOFFICE_BROWSER_DIR" symbolic-ref -q HEAD >/dev/null \
      && git -C "$ONLYOFFICE_BROWSER_DIR" show-ref --verify --quiet refs/heads/main; then
      log "restoring repo-local onlyoffice-browser main branch for development"
      git -C "$ONLYOFFICE_BROWSER_DIR" switch main >/dev/null
    fi

    local development_version development_commit development_branch
    development_version="$(package_version "$ONLYOFFICE_BROWSER_DIR")"
    development_commit="$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)"
    development_branch="$(git -C "$ONLYOFFICE_BROWSER_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
    log "using repo-local development checkout $development_commit ($development_branch, version $development_version)"
    return
  fi

  local current_version current_commit
  current_version="$(package_version "$ONLYOFFICE_BROWSER_DIR")"
  current_commit="$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)"
  if [[ "$current_version" != "$ONLYOFFICE_BROWSER_VERSION" || "$current_commit" != "$ONLYOFFICE_BROWSER_COMMIT" ]]; then
    checkout_onlyoffice_browser_version
    current_version="$(package_version "$ONLYOFFICE_BROWSER_DIR")"
    current_commit="$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)"
  fi

  if [[ "$current_version" != "$ONLYOFFICE_BROWSER_VERSION" ]]; then
    fail "$ONLYOFFICE_BROWSER_DIR is version $current_version, expected $ONLYOFFICE_BROWSER_VERSION."
  fi
  if [[ "$current_commit" != "$ONLYOFFICE_BROWSER_COMMIT" ]]; then
    fail "$ONLYOFFICE_BROWSER_DIR is commit $current_commit, expected $ONLYOFFICE_BROWSER_COMMIT."
  fi
}

self_test_development_checkout() {
  local temp_dir="$1"
  local old_commit new_commit

  ONLYOFFICE_BROWSER_DIR="$temp_dir/onlyoffice-browser"
  ONLYOFFICE_BROWSER_USE_CURRENT_CHECKOUT=1
  mkdir -p "$ONLYOFFICE_BROWSER_DIR"
  git -C "$ONLYOFFICE_BROWSER_DIR" init -q -b main
  git -C "$ONLYOFFICE_BROWSER_DIR" config user.email "onlyoffice-self-test@example.invalid"
  git -C "$ONLYOFFICE_BROWSER_DIR" config user.name "OnlyOffice self-test"
  printf '%s\n' '{"name":"onlyoffice-browser","version":"0.3.31"}' >"$ONLYOFFICE_BROWSER_DIR/package.json"
  printf '%s\n' 'released' >"$ONLYOFFICE_BROWSER_DIR/runtime.txt"
  git -C "$ONLYOFFICE_BROWSER_DIR" add package.json runtime.txt
  git -C "$ONLYOFFICE_BROWSER_DIR" commit -q -m released
  old_commit="$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)"
  printf '%s\n' 'development' >"$ONLYOFFICE_BROWSER_DIR/runtime.txt"
  git -C "$ONLYOFFICE_BROWSER_DIR" add runtime.txt
  git -C "$ONLYOFFICE_BROWSER_DIR" commit -q -m development
  new_commit="$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)"
  git -C "$ONLYOFFICE_BROWSER_DIR" checkout -q --detach "$old_commit"

  ensure_checkout

  [[ "$(git -C "$ONLYOFFICE_BROWSER_DIR" symbolic-ref --quiet --short HEAD)" == "main" ]] \
    || fail "Development checkout did not restore the repo-local main branch."
  [[ "$(git -C "$ONLYOFFICE_BROWSER_DIR" rev-parse HEAD)" == "$new_commit" ]] \
    || fail "Development checkout was left at the released manifest commit."
}

ensure_dependencies() {
  local modules_marker="$ONLYOFFICE_BROWSER_DIR/node_modules/.modules.yaml"
  if [[ ! -f "$modules_marker" || "$ONLYOFFICE_BROWSER_DIR/package.json" -nt "$modules_marker" || "$ONLYOFFICE_BROWSER_DIR/pnpm-lock.yaml" -nt "$modules_marker" ]]; then
    log "installing onlyoffice-browser dependencies"
    (cd "$ONLYOFFICE_BROWSER_DIR" && run_pnpm install --frozen-lockfile)
  fi
}

remove_platform_metadata() {
  local path
  while IFS= read -r path; do
    rm -f "$path"
    ONLYOFFICE_BROWSER_PLATFORM_METADATA_REMOVED=1
  done < <(find \
    "$ONLYOFFICE_BROWSER_DIR/public" \
    "$ONLYOFFICE_BROWSER_DIR/dist" \
    "$ONLYOFFICE_BROWSER_DIR/.onlyoffice-runtime-asset-packs" \
    -type f -name '.DS_Store' -print 2>/dev/null)
  if [[ "$ONLYOFFICE_BROWSER_PLATFORM_METADATA_REMOVED" == "1" ]]; then
    log "removed platform metadata before building runtime assets"
  fi
}

runtime_assets_ready() {
  [[ -f "$ONLYOFFICE_BROWSER_DIR/dist/office-host.html" ]] \
    && [[ -f "$ONLYOFFICE_BROWSER_DIR/dist/document_editor_service_worker.js" ]] \
    && [[ -d "$ONLYOFFICE_BROWSER_DIR/dist/web-apps" ]] \
    && [[ -d "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs" ]] \
    && [[ -d "$ONLYOFFICE_BROWSER_DIR/dist/wasm" ]] \
    && [[ -d "$ONLYOFFICE_BROWSER_DIR/dist/libs" ]] \
    && runtime_assets_optimized
}

runtime_assets_optimized() {
  local dist_dir="$ONLYOFFICE_BROWSER_DIR/dist"
  local manifest="$dist_dir/onlyoffice-runtime-assets.json"
  [[ -f "$manifest" ]] || return 1
  [[ -d "$dist_dir/dictionaries/en_US" ]] || return 1
  [[ ! -e "$dist_dir/sdkjs/pdf" ]] || return 1
  [[ ! -e "$dist_dir/sdkjs/visio" ]] || return 1
  [[ ! -e "$dist_dir/fonts" ]] || return 1
  [[ ! -e "$dist_dir/server/FileConverter" ]] || return 1
  ! find "$dist_dir" -type f -path '*/resources/help/*' -print -quit 2>/dev/null | grep -q . || return 1
  ! find "$dist_dir/dictionaries" -mindepth 1 -maxdepth 1 -type d ! -name 'en_US' -print -quit 2>/dev/null | grep -q . || return 1
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const types = JSON.stringify(manifest.types || []);
    const dictionaries = JSON.stringify(manifest.dictionaries || []);
    const packs = manifest.packs || {};
    const hasPacks = ["core", "word", "cell", "slide"].every((pack) => Number(packs[pack]) > 0);
    process.exit(
      manifest.version === 1 &&
      types === JSON.stringify(["word", "cell", "slide"]) &&
      dictionaries === JSON.stringify(["en_US"]) &&
      manifest.keepHelp === false &&
      Number(manifest.selected) > 0 &&
      Number(manifest.excluded) > 0 &&
      hasPacks ? 0 : 1
    );
  ' "$manifest" >/dev/null 2>&1
}

runtime_assets_stale() {
  if [[ "$ONLYOFFICE_BROWSER_PLATFORM_METADATA_REMOVED" == "1" ]]; then
    return 0
  fi
  if ! runtime_assets_ready; then
    return 0
  fi

  find \
    "$ONLYOFFICE_BROWSER_DIR/src" \
    "$ONLYOFFICE_BROWSER_DIR/pages" \
    "$ONLYOFFICE_BROWSER_DIR/bin/build.sh" \
    "$ONLYOFFICE_BROWSER_DIR/vite.config.ts" \
    "$ONLYOFFICE_BROWSER_DIR/package.json" \
    -type f -newer "$ONLYOFFICE_BROWSER_DIR/dist/office-host.html" -print -quit 2>/dev/null \
    | grep -q .
}

normalize_runtime_manifest() {
  local manifest="$ONLYOFFICE_BROWSER_DIR/dist/onlyoffice-runtime-assets.json"
  [[ -f "$manifest" ]] || return 0
  local commit_time
  commit_time="$(git -C "$ONLYOFFICE_BROWSER_DIR" show -s --format='%cI' "$ONLYOFFICE_BROWSER_COMMIT")"
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
    manifest.generatedAt = new Date(process.argv[2]).toISOString();
    const next = `${JSON.stringify(manifest, null, 2)}\n`;
    if (fs.readFileSync(path, "utf8") === next) process.exit(0);
    const tmp = `${path}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, path);
  ' "$manifest" "$commit_time"
}

ensure_runtime_assets() {
  if ! runtime_assets_stale; then
    normalize_runtime_manifest
    log "runtime assets ready: $ONLYOFFICE_BROWSER_DIR/dist"
    return
  fi

  log "building runtime assets"
  (cd "$ONLYOFFICE_BROWSER_DIR" && run_pnpm run build)
  normalize_runtime_manifest
  if ! runtime_assets_optimized; then
    fail "OnlyOffice runtime assets were built but not optimized. Expected dist/onlyoffice-runtime-assets.json, only en_US dictionaries, no sdkjs/pdf or sdkjs/visio, no bundled fonts, no FileConverter fonts, and no bundled help assets."
  fi
}

runtime_host_bundle_contains() {
  local needle="$1"
  local bundle
  while IFS= read -r bundle; do
    if grep -Fq "$needle" "$bundle"; then
      return 0
    fi
  done < <(find "$ONLYOFFICE_BROWSER_DIR/dist/assets" -maxdepth 1 -type f -name 'officeHost-*.js' -print 2>/dev/null)
  return 1
}

runtime_bundle_signature_problem() {
  local runtime_source="$ONLYOFFICE_BROWSER_DIR/src/lib/office-editor-runtime.ts"
  local host_source="$ONLYOFFICE_BROWSER_DIR/src/office-host.ts"
  [[ -f "$runtime_source" ]] || return 0

  if ! runtime_host_bundle_contains "$PINNED_ONLYOFFICE_HOST_BUILD_ID"; then
    printf 'OnlyOffice host bundle is missing runtime identity %s. Rebuild the real officeHost-* asset before starting Piwork.' "$PINNED_ONLYOFFICE_HOST_BUILD_ID"
    return 1
  fi

  if grep -Fq "installSpreadsheetPdfPrintPanelBridge" "$runtime_source"; then
    local missing=()
    local needle
    for needle in "download:settings" "file:printpreview" "onlyofficeBrowserSpreadsheetPdfPrintPanel" "保存副本"; do
      if ! runtime_host_bundle_contains "$needle"; then
        missing+=("$needle")
      fi
    done
    if (( ${#missing[@]} > 0 )); then
      printf 'OnlyOffice runtime source contains Spreadsheet PDF print-preview bridge, but dist/assets/officeHost-*.js is missing runtime signature(s): %s. Run ./scripts/ensure-onlyoffice-browser.sh or pnpm run build in onlyoffice-browser, then reload/reopen the Office iframe before Chrome verification.' "${missing[*]}"
      return 1
    fi
  fi

  if [[ -f "$host_source" ]] && grep -Fq "pluginInstanceId" "$host_source"; then
    if ! runtime_host_bundle_contains "pluginInstanceId"; then
      printf 'OnlyOffice host source contains plugin runtime identity checks, but dist/assets/officeHost-*.js is missing pluginInstanceId. Rebuild the real host bundle, then reload/reopen the Office iframe before Chrome verification.'
      return 1
    fi
  fi

  return 0
}

verify_runtime_bundle_signatures() {
  local problem
  if ! problem="$(runtime_bundle_signature_problem)"; then
    fail "$problem"
  fi
}

self_test_runtime_assets_stale() {
  local temp_dir="$1"
  ONLYOFFICE_BROWSER_DIR="$temp_dir/onlyoffice-browser"

  mkdir -p \
    "$ONLYOFFICE_BROWSER_DIR/src" \
    "$ONLYOFFICE_BROWSER_DIR/pages" \
    "$ONLYOFFICE_BROWSER_DIR/bin" \
    "$ONLYOFFICE_BROWSER_DIR/dist/web-apps" \
    "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs" \
    "$ONLYOFFICE_BROWSER_DIR/dist/wasm" \
    "$ONLYOFFICE_BROWSER_DIR/dist/libs" \
    "$ONLYOFFICE_BROWSER_DIR/dist/dictionaries/en_US"

  printf '%s\n' 'export {};' >"$ONLYOFFICE_BROWSER_DIR/src/runtime.ts"
  printf '%s\n' '<div id="office-host"></div>' >"$ONLYOFFICE_BROWSER_DIR/pages/office-host.html"
  printf '%s\n' '#!/usr/bin/env bash' >"$ONLYOFFICE_BROWSER_DIR/bin/build.sh"
  printf '%s\n' 'export default {};' >"$ONLYOFFICE_BROWSER_DIR/vite.config.ts"
  printf '%s\n' '{"name":"onlyoffice-browser","version":"0.0.0"}' >"$ONLYOFFICE_BROWSER_DIR/package.json"
  printf '%s\n' '<html></html>' >"$ONLYOFFICE_BROWSER_DIR/dist/office-host.html"
  printf '%s\n' 'self.addEventListener("fetch", () => {});' >"$ONLYOFFICE_BROWSER_DIR/dist/document_editor_service_worker.js"
  cat >"$ONLYOFFICE_BROWSER_DIR/dist/onlyoffice-runtime-assets.json" <<'JSON'
{
  "version": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "types": ["word", "cell", "slide"],
  "dictionaries": ["en_US"],
  "keepHelp": false,
  "packs": { "core": 1, "word": 1, "cell": 1, "slide": 1 },
  "selected": 4,
  "excluded": 1
}
JSON

  touch -t 202001010000 \
    "$ONLYOFFICE_BROWSER_DIR/src/runtime.ts" \
    "$ONLYOFFICE_BROWSER_DIR/pages/office-host.html" \
    "$ONLYOFFICE_BROWSER_DIR/bin/build.sh" \
    "$ONLYOFFICE_BROWSER_DIR/vite.config.ts" \
    "$ONLYOFFICE_BROWSER_DIR/package.json"
  touch -t 202001010001 "$ONLYOFFICE_BROWSER_DIR/dist/office-host.html"

  if ! runtime_assets_ready; then
    fail "runtime asset fixture should be ready"
  fi
  if runtime_assets_stale; then
    fail "runtime assets should not be stale when dist is newer than source"
  fi

  touch -t 202001010002 "$ONLYOFFICE_BROWSER_DIR/src/runtime.ts"
  if ! runtime_assets_stale; then
    fail "runtime assets should be stale when source is newer than dist"
  fi
}

self_test_runtime_bundle_signature() {
  local temp_dir="$1"
  ONLYOFFICE_BROWSER_DIR="$temp_dir/onlyoffice-browser"

  mkdir -p "$ONLYOFFICE_BROWSER_DIR/src/lib" "$ONLYOFFICE_BROWSER_DIR/dist/assets"
  printf '%s\n' 'class Runtime { installSpreadsheetPdfPrintPanelBridge() {} }' >"$ONLYOFFICE_BROWSER_DIR/src/lib/office-editor-runtime.ts"
  printf '%s\n' 'const pluginInstanceId = "pluginInstanceId";' >"$ONLYOFFICE_BROWSER_DIR/src/office-host.ts"
  printf '%s\n' 'console.log("old host bundle");' >"$ONLYOFFICE_BROWSER_DIR/dist/assets/officeHost-old.js"

  if runtime_bundle_signature_problem >/dev/null; then
    fail "runtime bundle signature check should fail when the host bundle misses bridge signatures"
  fi

  printf '%s\n' "console.log(\"$PINNED_ONLYOFFICE_HOST_BUILD_ID download:settings file:printpreview onlyofficeBrowserSpreadsheetPdfPrintPanel 保存副本 pluginInstanceId\");" >"$ONLYOFFICE_BROWSER_DIR/dist/assets/officeHost-new.js"
  if ! runtime_bundle_signature_problem >/dev/null; then
    fail "runtime bundle signature check should pass when the host bundle contains bridge signatures"
  fi
}

self_test_runtime_asset_optimization() {
  local temp_dir="$1"
  ONLYOFFICE_BROWSER_DIR="$temp_dir/onlyoffice-browser"

  mkdir -p \
    "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/api" \
    "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/documenteditor/main" \
    "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/spreadsheeteditor/main" \
    "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/presentationeditor/main" \
    "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/common" \
    "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/word" \
    "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/cell" \
    "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/slide" \
    "$ONLYOFFICE_BROWSER_DIR/dist/wasm/x2t" \
    "$ONLYOFFICE_BROWSER_DIR/dist/libs" \
    "$ONLYOFFICE_BROWSER_DIR/dist/dictionaries/en_US"

  printf '%s\n' '<html></html>' >"$ONLYOFFICE_BROWSER_DIR/dist/office-host.html"
  printf '%s\n' 'self.addEventListener("fetch", () => {});' >"$ONLYOFFICE_BROWSER_DIR/dist/document_editor_service_worker.js"
  cat >"$ONLYOFFICE_BROWSER_DIR/dist/onlyoffice-runtime-assets.json" <<'JSON'
{
  "version": 1,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "types": ["word", "cell", "slide"],
  "dictionaries": ["en_US"],
  "keepHelp": false,
  "packs": { "core": 1, "word": 1, "cell": 1, "slide": 1 },
  "selected": 4,
  "excluded": 1
}
JSON

  if ! runtime_assets_ready; then
    fail "optimized runtime assets should be accepted"
  fi

  mkdir -p "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/pdf"
  printf '%s\n' 'pdf payload' >"$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/pdf/unused.js"
  if runtime_assets_ready; then
    fail "runtime assets should be stale when excluded PDF SDK assets are present"
  fi
  rm -rf "$ONLYOFFICE_BROWSER_DIR/dist/sdkjs/pdf"

  mkdir -p "$ONLYOFFICE_BROWSER_DIR/dist/dictionaries/fr_FR"
  printf '%s\n' 'fr' >"$ONLYOFFICE_BROWSER_DIR/dist/dictionaries/fr_FR/fr_FR.dic"
  if runtime_assets_ready; then
    fail "runtime assets should be stale when non-selected dictionaries are present"
  fi
  rm -rf "$ONLYOFFICE_BROWSER_DIR/dist/dictionaries/fr_FR"

  mkdir -p "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/documenteditor/main/resources/help/en/images"
  printf '%s\n' 'help' >"$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/documenteditor/main/resources/help/en/images/large.gif"
  if runtime_assets_ready; then
    fail "runtime assets should be stale when bundled help assets are present"
  fi
  rm -rf "$ONLYOFFICE_BROWSER_DIR/dist/web-apps/apps/documenteditor/main/resources/help"
}

npm_lib_ready() {
  [[ -f "$ONLYOFFICE_BROWSER_DIR/dist/npm/public-api.js" ]] \
    && [[ -f "$ONLYOFFICE_BROWSER_DIR/dist/npm/public-api.d.ts" ]]
}

npm_lib_stale() {
  if ! npm_lib_ready; then
    return 0
  fi

  find \
    "$ONLYOFFICE_BROWSER_DIR/src" \
    "$ONLYOFFICE_BROWSER_DIR/tsconfig.lib.json" \
    "$ONLYOFFICE_BROWSER_DIR/vite.lib.config.ts" \
    -type f -newer "$ONLYOFFICE_BROWSER_DIR/dist/npm/public-api.js" -print -quit 2>/dev/null \
    | grep -q .
}

ensure_npm_lib() {
  if npm_lib_stale; then
    log "building npm library bundle"
    (cd "$ONLYOFFICE_BROWSER_DIR" && run_pnpm run build:lib)
  fi
}

clear_vite_onlyoffice_cache() {
  if [[ "${PIWORK_ONLYOFFICE_KEEP_VITE_CACHE:-0}" == "1" ]]; then
    return
  fi

  local vite_cache_dir="$ROOT_DIR/web/node_modules/.vite"
  local vite_pid_file="$ROOT_DIR/.runtime/vite.pid"
  local vite_pid=""
  if [[ -f "$vite_pid_file" ]]; then
    vite_pid="$(cat "$vite_pid_file" 2>/dev/null || true)"
  fi
  if { [[ "$vite_pid" =~ ^[0-9]+$ ]] && kill -0 "$vite_pid" 2>/dev/null; } \
    || { command -v pgrep >/dev/null 2>&1 && pgrep -f "$ROOT_DIR/web/node_modules/.bin/vite" >/dev/null; }; then
    log "keeping Vite optimized dependency cache because the dev server is running"
    return
  fi
  if [[ -d "$vite_cache_dir" ]]; then
    log "clearing Vite optimized dependency cache"
    rm -rf "$vite_cache_dir"
  fi
}

sync_npm_lib_to_web() {
  local source_dir="$ONLYOFFICE_BROWSER_DIR/dist/npm"
  local package_dir="$ROOT_DIR/web/node_modules/@agentbridges-ai/onlyoffice-browser"
  local target_dir="$package_dir/dist/npm"

  if [[ ! -d "$package_dir" ]]; then
    clear_vite_onlyoffice_cache
    return
  fi

  if [[ ! -d "$target_dir" ]] || ! diff -qr "$source_dir" "$target_dir" >/dev/null 2>&1; then
    log "syncing npm library bundle into web/node_modules"
    rm -rf "$target_dir"
    mkdir -p "$package_dir/dist"
    cp -R "$source_dir" "$target_dir"
  fi

  # Vite serves prebundled deps with immutable ?v= hashes. When we overlay the
  # local onlyoffice-browser build into web/node_modules, Chrome can otherwise
  # keep executing an older optimized URL even after the file on disk changes.
  clear_vite_onlyoffice_cache
}

font_assets_ready() {
  [[ -f "$ONLYOFFICE_BROWSER_DIR/scripts/verify-onlyoffice-font-assets.mjs" ]] \
    && node "$ONLYOFFICE_BROWSER_DIR/scripts/verify-onlyoffice-font-assets.mjs" --input "$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR" >/dev/null 2>&1 \
    && font_assets_have_cjk_fallback \
    && font_assets_match_development_policy
}

dir_has_fonts() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  local found
  found="$(find "$dir" -type f \( -iname '*.ttf' -o -iname '*.tte' -o -iname '*.otf' -o -iname '*.otc' -o -iname '*.ttc' -o -iname '*.woff' -o -iname '*.woff2' \) -print -quit 2>/dev/null || true)"
  [[ -n "$found" ]]
}

dir_has_zh_core_cjk_fonts() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  local found
  found="$(find "$dir" -type f \( \
    -iname '*msyh*' -o -iname '*simsun*' -o -iname '*simhei*' -o -iname '*kaiti*' -o \
    -iname '*fangsong*' -o -iname '*deng*' -o -iname '*notosanssc*' -o \
    -iname '*notosanscjksc*' -o -iname '*noto*sans*cjk*sc*' -o -iname '*wenquanyi*' -o \
    -iname '*droid*sans*fallback*' \
  \) -print -quit 2>/dev/null || true)"
  [[ -n "$found" ]]
}

dir_has_cjk_fonts() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  local found
  found="$(find "$dir" -type f \( \
    -iname '*msyh*' -o -iname '*simsun*' -o -iname '*simhei*' -o -iname '*kaiti*' -o \
    -iname '*fangsong*' -o -iname '*deng*' -o -iname '*notosanssc*' -o \
    -iname '*notosanscjksc*' -o -iname '*noto*sans*cjk*sc*' -o -iname '*songti*' -o \
    -iname '*heiti*' -o -iname '*pingfang*' -o -iname '*adobeheiti*' -o -iname '*hiragino*sans*gb*' -o \
    -iname '*wenquanyi*' -o -iname '*droid*sans*fallback*' \
  \) -print -quit 2>/dev/null || true)"
  [[ -n "$found" ]]
}

font_assets_have_cjk_fallback() {
  local source_map="$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR/onlyoffice-browser-font-source-map.json"
  [[ -f "$source_map" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const sourceMap = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const families = (sourceMap.keptFamilies || []).join("\n").toLowerCase();
    const markers = [
      "microsoft yahei", "simsun", "simhei", "fangsong", "kaiti", "dengxian",
      "noto sans sc", "noto sans cjk sc", "songti", "heiti", "pingfang",
      "adobe heiti", "hiragino sans gb", "wenquanyi", "droid sans fallback"
    ];
    process.exit(markers.some((marker) => families.includes(marker)) ? 0 : 1);
  ' "$source_map" >/dev/null 2>&1
}

font_assets_match_development_policy() {
  if [[ "${PIWORK_ONLYOFFICE_SKIP_FONT_POLICY:-0}" == "1" ]]; then
    return 0
  fi
  local all_fonts="$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR/sdkjs/common/AllFonts.js"
  local source_map="$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR/onlyoffice-browser-font-source-map.json"
  [[ -f "$all_fonts" ]] || return 1
  [[ -f "$source_map" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const allFontsPath = process.argv[1];
    const sourceMapPath = process.argv[2];
    const expected = [
      "Aptos",
      "Calibri",
      "Arial",
      "Times New Roman",
      "Cambria",
      "Microsoft YaHei",
      "SimSun",
      "DengXian",
      "SimHei",
      "KaiTi",
    ];
    const expectedHiddenRegistered = [
      "ASCW3",
      "Bookshelf Symbol 7",
      "DejaVu Sans",
      "Marlett",
      "Monotype Sorts",
      "MS Reference Specialty",
      "MS Gothic",
      "MS PGothic",
      "MS UI Gothic",
      "MT Extra",
      "OpenSymbol",
      "Segoe UI Symbol",
      "Symbol",
      "Symbola",
      "Webdings",
      "Wingdings",
      "Wingdings 2",
      "Wingdings 3",
      "Cambria Math",
    ];
    const expectedHiddenSources = {
      "ASCW3": /\/ASC\.ttf$/i,
      "Bookshelf Symbol 7": /bookshelf symbol 7\.ttf$/i,
      "DejaVu Sans": /DejaVuSans(?:-Bold|-Oblique|-BoldOblique)?\.ttf$/i,
      "Marlett": /marlett\.ttf$/i,
      "Monotype Sorts": /monotypesorts\.ttf$/i,
      "MS Reference Specialty": /ms reference specialty\.ttf$/i,
      "MT Extra": /mtextra\.ttf$/i,
      "MS Gothic": /msgothic\.ttc$/i,
      "MS PGothic": /msgothic\.ttc$/i,
      "MS UI Gothic": /msgothic\.ttc$/i,
      "OpenSymbol": /opens___\.ttf$/i,
      "Segoe UI Symbol": /seguisym\.ttf$/i,
      "Symbol": /symbol\.ttf$/i,
      "Symbola": /Symbola_hint\.ttf$/i,
      "Webdings": /webdings\.ttf$/i,
      "Wingdings": /wingdings\.ttf$/i,
      "Wingdings 2": /wingdings 2\.ttf$/i,
      "Wingdings 3": /wingdings 3\.ttf$/i,
      "Cambria Math": /cambria\.ttc$/i,
    };
    const source = fs.readFileSync(allFontsPath, "utf8");
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
    const visibleMatch = source.match(/window\["__fonts_visible_names"\]\s*=\s*(\[[\s\S]*?\]);/);
    if (!visibleMatch) process.exit(1);
    const visible = JSON.parse(visibleMatch[1]);
    if (JSON.stringify(visible) !== JSON.stringify(expected)) process.exit(1);
    const infosMatch = source.match(/window\["__fonts_infos"\]\s*=\s*(\[[\s\S]*?\]);/);
    if (!infosMatch) process.exit(1);
    const filesMatch = source.match(/window\["__fonts_files"\]\s*=\s*(\[[\s\S]*?\]);/);
    if (!filesMatch) process.exit(1);
    const files = JSON.parse(filesMatch[1]);
    const infos = JSON.parse(infosMatch[1]);
    const names = new Set(infos.map((info) => info?.[0]).filter(Boolean));
    const sourceByFile = new Map((sourceMap.fonts || []).map((font) => [String(font.file || "").replace(/^fonts\//, ""), String(font.source || "")]));
    const hiddenRegistered = expectedHiddenRegistered.every((name) => names.has(name) && !visible.includes(name));
    const hiddenSourcesMatch = Object.entries(expectedHiddenSources).every(([name, pattern]) => {
      const info = infos.find((entry) => entry?.[0] === name);
      if (!info || info[1] < 0) return false;
      const packedFile = files[info[1]];
      const sourcePath = sourceByFile.get(packedFile) || "";
      return pattern.test(sourcePath);
    });
    process.exit(expected.every((name) => names.has(name)) && hiddenRegistered && hiddenSourcesMatch ? 0 : 1);
  ' "$all_fonts" "$source_map" >/dev/null 2>&1
}

detect_font_source_dir() {
  if [[ -n "$ONLYOFFICE_BROWSER_FONT_SOURCE_DIR" ]]; then
    if dir_has_fonts "$ONLYOFFICE_BROWSER_FONT_SOURCE_DIR"; then
      printf '%s\n' "$ONLYOFFICE_BROWSER_FONT_SOURCE_DIR"
      return 0
    fi
    fail "Configured font source has no supported font files: $ONLYOFFICE_BROWSER_FONT_SOURCE_DIR"
  fi

  local candidates=(
    "$ROOT_DIR/fonts/source"
    "$HOME/Library/Fonts"
    "/Library/Fonts"
    "/System/Library/Fonts"
    "/System/Library/Fonts/Supplemental"
    "/usr/local/share/fonts"
    "/usr/share/fonts"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if dir_has_zh_core_cjk_fonts "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for candidate in "${candidates[@]}"; do
    if dir_has_cjk_fonts "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for candidate in "${candidates[@]}"; do
    if dir_has_fonts "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  fail "No font source directory found. Set PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR to a directory containing .ttf/.ttc/.otf fonts."
}

ensure_font_assets() {
  if font_assets_ready; then
    node "$ONLYOFFICE_BROWSER_DIR/scripts/verify-onlyoffice-font-assets.mjs" --input "$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR"
    return
  fi

  if [[ -z "$ONLYOFFICE_BROWSER_FONT_SOURCE_DIR" && "$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR" == "$ONLYOFFICE_BROWSER_DEFAULT_FONT_ASSETS_DIR" ]]; then
    fail "OnlyOffice generated font assets are missing or invalid at $ONLYOFFICE_BROWSER_FONT_ASSETS_DIR. Run make prepare-onlyoffice-fonts to generate them in the onlyoffice-browser checkout, or set PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR explicitly to regenerate."
  fi

  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker is required to generate OnlyOffice font assets. Install Docker or set PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR to existing generated assets."
  fi

  local font_source_dir
  font_source_dir="$(detect_font_source_dir)"
  local font_set="$ONLYOFFICE_BROWSER_FONT_SET"
  if [[ -z "$ONLYOFFICE_BROWSER_FONT_SET_CONFIGURED" && "$font_set" == "zh-core" && "$(uname -s)" == "Darwin" ]] && ! dir_has_zh_core_cjk_fonts "$font_source_dir"; then
    font_set="full"
    log "using full font set because $font_source_dir has macOS CJK fonts but no zh-core Microsoft/Noto SC font files"
  fi
  log "generating font assets from $font_source_dir"
  node "$ONLYOFFICE_BROWSER_DIR/scripts/generate-onlyoffice-font-assets.mjs" \
    --input "$font_source_dir" \
    --output "$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR" \
    --font-set "$font_set"
  node "$ONLYOFFICE_BROWSER_DIR/scripts/verify-onlyoffice-font-assets.mjs" --input "$ONLYOFFICE_BROWSER_FONT_ASSETS_DIR"
  if ! font_assets_have_cjk_fallback; then
    fail "Generated OnlyOffice font assets do not include a Chinese/CJK fallback. Set PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR to a directory containing Microsoft YaHei, SimSun, Noto Sans SC, STHeiti, Songti, or another supported CJK font."
  fi
  if ! font_assets_match_development_policy; then
    fail "Generated OnlyOffice font assets do not match the Piwork development font policy. The visible font list must be exactly: Aptos, Calibri, Arial, Times New Roman, Cambria, Microsoft YaHei, SimSun, DengXian, SimHei, KaiTi, and Office symbol fonts must be registered but hidden."
  fi
}

main() {
  if [[ "${1:-}" == "--self-test-development-checkout" ]]; then
    local temp_dir
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/piwork-onlyoffice-development-checkout.XXXXXX")"
    trap "rm -rf '$temp_dir'" EXIT
    self_test_development_checkout "$temp_dir"
    log "development checkout self-test ready"
    return
  fi

  if [[ "${1:-}" == "--self-test-runtime-assets-stale" ]]; then
    local temp_dir
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/piwork-onlyoffice-runtime-stale.XXXXXX")"
    trap "rm -rf '$temp_dir'" EXIT
    self_test_runtime_assets_stale "$temp_dir"
    log "runtime asset stale self-test ready"
    return
  fi

  if [[ "${1:-}" == "--self-test-runtime-bundle-signature" ]]; then
    local temp_dir
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/piwork-onlyoffice-runtime-signature.XXXXXX")"
    trap "rm -rf '$temp_dir'" EXIT
    self_test_runtime_bundle_signature "$temp_dir"
    log "runtime bundle signature self-test ready"
    return
  fi

  if [[ "${1:-}" == "--self-test-runtime-asset-optimization" ]]; then
    local temp_dir
    temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/piwork-onlyoffice-runtime-optimization.XXXXXX")"
    trap "rm -rf '$temp_dir'" EXIT
    self_test_runtime_asset_optimization "$temp_dir"
    log "runtime asset optimization self-test ready"
    return
  fi

  ensure_checkout
  ensure_dependencies
  remove_platform_metadata
  ensure_runtime_assets
  verify_runtime_bundle_signatures
  ensure_npm_lib
  sync_npm_lib_to_web
  ensure_font_assets

  log "ready"
}

main "$@"
