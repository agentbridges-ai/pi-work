#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELFHOST_DIR="${PIWORK_SELFHOST_DIR:-$ROOT_DIR/.runtime/selfhost}"
ENV_FILE="$SELFHOST_DIR/selfhost.env"
KEY_FILE="$SELFHOST_DIR/runtime-control.key"
MARKER_FILE="$SELFHOST_DIR/runtime-security.marker"
POSTGRES_APP_PASSWORD_FILE="$SELFHOST_DIR/postgres-app.password"
COMPOSE_BASE="$ROOT_DIR/compose/docker-compose.yml"

usage() {
  printf '%s\n' \
    'Usage: scripts/selfhost.sh <init|configure|doctor|up|down|status|backup|restore|upgrade> [options]' \
    '  init                         Generate private config and secret files' \
    '  configure                   Re-run init without replacing existing secrets' \
    '  doctor [--require-verified] Validate Compose and Runtime security gates' \
    '  up [--source|--release]     Start the fixed Compose stack' \
    '  down                        Stop the fixed Compose stack' \
    '  status                      Show fixed Compose service status' \
    '  backup [DIR]                Stop new sessions and write a DB/data backup' \
    '  restore DIR                 Restore a verified backup into the fixed volumes' \
    '  upgrade [--source|--release] Backup, migrate, smoke-test, and start'
}

compose_files=()
mode=source
RELEASE_MANIFEST="${PIWORK_RELEASE_MANIFEST:-$ROOT_DIR/release/piwork-compose-release-manifest.json}"

load_config() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing $ENV_FILE; run selfhost init first." >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  RELEASE_MANIFEST="${PIWORK_RELEASE_MANIFEST:-$ROOT_DIR/release/piwork-compose-release-manifest.json}"
}

compose() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" \
    -f "$COMPOSE_BASE" "${compose_files[@]}" "$@"
}

select_mode() {
  compose_files=()
  case "$mode" in
    source) compose_files+=( -f "$ROOT_DIR/compose/docker-compose.source.yml" ) ;;
    release)
      load_release_images
      compose_files+=( -f "$ROOT_DIR/compose/docker-compose.release.yml" )
      ;;
    *) echo "Unknown selfhost mode: $mode" >&2; exit 2 ;;
  esac
}

load_release_images() {
  [[ -f "$RELEASE_MANIFEST" ]] || {
    echo "Missing release manifest: $RELEASE_MANIFEST" >&2
    exit 2
  }
  local service variable value current
  for service in caddy web runtime postgres; do
    variable="PIWORK_$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')_IMAGE"
    value="$(node "$ROOT_DIR/scripts/release-manifest.mjs" get "$RELEASE_MANIFEST" "$service")"
    case "$variable" in
      PIWORK_CADDY_IMAGE) current="${PIWORK_CADDY_IMAGE:-}" ;;
      PIWORK_WEB_IMAGE) current="${PIWORK_WEB_IMAGE:-}" ;;
      PIWORK_RUNTIME_IMAGE) current="${PIWORK_RUNTIME_IMAGE:-}" ;;
      PIWORK_POSTGRES_IMAGE) current="${PIWORK_POSTGRES_IMAGE:-}" ;;
      *) echo "Unknown release image variable: $variable" >&2; exit 2 ;;
    esac
    [[ -z "$current" || "$current" == "$value" ]] || {
      echo "$variable conflicts with the release manifest" >&2
      exit 1
    }
    export "$variable=$value"
  done
}

private_file_check() {
  local path="$1"
  [[ -f "$path" ]] || { echo "Missing private file: $path" >&2; return 1; }
  local mode_value
  mode_value="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  [[ "$mode_value" == "600" || "$mode_value" == "400" ]] || {
    echo "Private file has unsafe mode $mode_value: $path" >&2
    return 1
  }
}

init_config() {
  umask 077
  mkdir -p "$SELFHOST_DIR"
  chmod 700 "$SELFHOST_DIR"
  if [[ ! -f "$KEY_FILE" ]]; then
    openssl rand -out "$KEY_FILE" 32
  fi
  if [[ ! -f "$MARKER_FILE" ]]; then
    printf '%s\n' 'piwork-runtime-security-v1' >"$MARKER_FILE"
  fi
  if [[ ! -f "$POSTGRES_APP_PASSWORD_FILE" ]]; then
    openssl rand -hex 32 >"$POSTGRES_APP_PASSWORD_FILE"
  fi
  chmod 600 "$KEY_FILE" "$MARKER_FILE" "$POSTGRES_APP_PASSWORD_FILE"
  if [[ ! -f "$ENV_FILE" ]]; then
    local auth_secret postgres_password
    auth_secret="$(openssl rand -hex 32)"
    postgres_password="$(openssl rand -hex 24)"
    {
      printf 'BETTER_AUTH_SECRET=%q\n' "$auth_secret"
      printf 'POSTGRES_PASSWORD=%q\n' "$postgres_password"
      printf 'PIWORK_RUNTIME_CONTROL_KEY_FILE_HOST=%q\n' "$KEY_FILE"
      printf 'PIWORK_RUNTIME_SECURITY_MARKER_FILE=%q\n' "$MARKER_FILE"
      printf 'PIWORK_POSTGRES_APP_PASSWORD_FILE_HOST=%q\n' "$POSTGRES_APP_PASSWORD_FILE"
      printf 'PIWORK_POSTGRES_APP_USER=piwork_web\n'
      printf 'PIWORK_RUNTIME_RELEASE_MODE=source\n'
    } >"$ENV_FILE"
  else
    grep -q '^PIWORK_POSTGRES_APP_PASSWORD_FILE_HOST=' "$ENV_FILE" ||
      printf 'PIWORK_POSTGRES_APP_PASSWORD_FILE_HOST=%q\n' "$POSTGRES_APP_PASSWORD_FILE" >>"$ENV_FILE"
    grep -q '^PIWORK_POSTGRES_APP_USER=' "$ENV_FILE" ||
      printf 'PIWORK_POSTGRES_APP_USER=piwork_web\n' >>"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  if [[ -f "$ROOT_DIR/.env" ]]; then chmod 600 "$ROOT_DIR/.env"; fi
  echo "Piwork selfhost config ready: $SELFHOST_DIR"
}

doctor() {
  local require_verified=0
  if [[ "${1:-}" == "--require-verified" ]]; then require_verified=1; shift; fi
  [[ $# -eq 0 ]] || { usage; exit 2; }
  load_config
  private_file_check "$ENV_FILE"
  private_file_check "$KEY_FILE"
  private_file_check "$MARKER_FILE"
  private_file_check "${PIWORK_POSTGRES_APP_PASSWORD_FILE_HOST:-$POSTGRES_APP_PASSWORD_FILE}"
  command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
  select_mode
  if rg -n -i 'privileged\s*:|SYS_ADMIN|seccomp=unconfined|network_mode:\s*host|/var/run/docker\.sock' "$ROOT_DIR/compose"; then
    echo 'Forbidden container boundary found in Compose files.' >&2
    exit 1
  fi
  compose config --quiet
  [[ "$(docker info --format '{{.OSType}}' 2>/dev/null)" == "linux" ]] || {
    echo 'Docker must expose a Linux engine (OrbStack, WSL2, or native Linux).' >&2
    exit 1
  }
  if [[ "$mode" == "release" ]]; then
    for image in "${PIWORK_CADDY_IMAGE:-}" "${PIWORK_WEB_IMAGE:-}" "${PIWORK_RUNTIME_IMAGE:-}" "${PIWORK_POSTGRES_IMAGE:-}"; do
      [[ "$image" == *@sha256:* ]] || { echo "Release image is not digest pinned: $image" >&2; exit 1; }
    done
  fi
  if [[ "$require_verified" == 1 ]]; then
    local runtime_id
    runtime_id="$(compose ps -q runtime)"
    [[ -n "$runtime_id" ]] || { echo 'Runtime service is not running; cannot verify Compose.' >&2; exit 1; }
    local inspect
    inspect="$(docker inspect "$runtime_id")"
    if ! PIWORK_INSPECT_JSON="$inspect" node <<'NODE'
const parsed = JSON.parse(process.env.PIWORK_INSPECT_JSON || '');
const host = parsed[0]?.HostConfig || {};
const config = parsed[0]?.Config || {};
const mounts = parsed[0]?.Mounts || [];
const security = host.SecurityOpt || [];
const fail = (message) => { console.error(message); process.exit(1); };
if (host.Privileged !== false) fail('Runtime is privileged.');
if (host.NetworkMode === 'host') fail('Runtime uses host networking.');
if ((host.CapAdd || []).length !== 0) fail('Runtime has additional capabilities.');
if (!(host.CapDrop || []).some((value) => String(value).toUpperCase() === 'ALL')) fail('Runtime does not drop all capabilities.');
if (!security.some((value) => value === 'no-new-privileges:true')) fail('Runtime no-new-privileges is missing.');
if (!security.some((value) => String(value).startsWith('seccomp=')) || security.some((value) => value === 'seccomp=unconfined')) fail('Runtime custom seccomp profile is missing or unconfined.');
if (config.User !== '65532:65532') fail(`Runtime user is not non-root: ${config.User || '(empty)'}`);
if (host.ReadonlyRootfs !== true) fail('Runtime root filesystem is writable.');
if (!Number.isInteger(host.PidsLimit) || host.PidsLimit <= 0) fail('Runtime PID limit is missing.');
if (!Number.isInteger(host.Memory) || host.Memory <= 0) fail('Runtime memory limit is missing.');
if (mounts.some((mount) => `${mount.Source || ''}:${mount.Destination || ''}`.includes('docker.sock'))) fail('Runtime has Docker Socket access.');
NODE
    then
      exit 1
    fi
    local web_id
    web_id="$(compose ps -q web)"
    [[ -n "$web_id" ]] || { echo 'Web service is not running; cannot verify Compose.' >&2; exit 1; }
    local web_inspect
    web_inspect="$(docker inspect "$web_id")"
    if ! PIWORK_WEB_INSPECT_JSON="$web_inspect" node <<'NODE'
const parsed = JSON.parse(process.env.PIWORK_WEB_INSPECT_JSON || '');
const host = parsed[0]?.HostConfig || {};
const bindings = host.PortBindings || {};
if (Object.keys(bindings).length !== 0) {
  console.error('Web publishes a host port; only Caddy may publish host ports.');
  process.exit(1);
}
if (host.NetworkMode === 'host') {
  console.error('Web uses host networking.');
  process.exit(1);
}
NODE
    then
      exit 1
    fi
    local edge_headers
    edge_headers="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:${PIWORK_HTTP_PORT:-3457}/build-info" || true)"
    if ! printf '%s\n' "$edge_headers" | rg -qi '^X-Piwork-Edge:\s*piwork-caddy\r?$'; then
      echo 'Published selfhost port is not served by the fixed Piwork Caddy edge.' >&2
      exit 1
    fi
    compose exec -T runtime bun /workspace/scripts/verify-runtime-container-canary.ts
    compose exec -T web bun scripts/verify-runtime-rls.ts
  fi
  if [[ "$require_verified" == 1 ]]; then
    echo "selfhost doctor: configured and verified ($mode)"
  else
    echo "selfhost doctor: configured ($mode)"
  fi
}

up() {
  load_config
  select_mode
  if [[ "$mode" == "source" ]]; then
    # The source overlay is intentionally read-only.  Docker needs the nested
    # node_modules mountpoint to exist in that bind mount before it can attach
    # the named volume; otherwise a read-only rootfs fails container startup.
    mkdir -p "$ROOT_DIR/web/node_modules"
    compose up -d --build
  else
    compose up -d
  fi
  compose --profile migrate run --rm migrate
}

down() {
  load_config
  select_mode
  compose down
}

status() {
  load_config
  select_mode
  compose ps
}

backup() {
  load_config
  select_mode
  local output="${1:-$ROOT_DIR/backups/piwork-$(date -u +%Y%m%dT%H%M%SZ)}"
  mkdir -p "$output"
  chmod 700 "$output"
  local stop_timeout="${PIWORK_RUNTIME_STOP_TIMEOUT:-30}"
  compose stop --timeout "$stop_timeout" web runtime
  compose exec -T postgres pg_dump --format=custom --no-owner --no-acl \
    -U "${POSTGRES_USER:-piwork}" -d "${POSTGRES_DB:-piwork}" >"$output/postgres.dump"
  compose run --rm --no-deps runtime tar -C /var/lib/piwork \
    --exclude='./tmp' --exclude='./tmp/*' --exclude='*/tmp' --exclude='*/tmp/*' \
    --exclude='./recordings' --exclude='./recordings/*' --exclude='*/recordings' --exclude='*/recordings/*' \
    --exclude='./user-space-checkouts' --exclude='./user-space-checkouts/*' \
    --exclude='*/user-space-checkouts' --exclude='*/user-space-checkouts/*' \
    --exclude='./checkouts' --exclude='./checkouts/*' --exclude='*/checkouts' --exclude='*/checkouts/*' \
    --exclude='./.cache' --exclude='./.cache/*' --exclude='*/.cache' --exclude='*/.cache/*' \
    --exclude='./cache' --exclude='./cache/*' --exclude='*/cache' --exclude='*/cache/*' \
    --exclude='./caches' --exclude='./caches/*' --exclude='*/caches' --exclude='*/caches/*' \
    -cf - data >"$output/data.tar"
  local created_at source_sha piwork_version
  created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  piwork_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT_DIR/package.json")"
  node "$ROOT_DIR/scripts/backup-manifest.mjs" create \
    "$output" "$created_at" "$source_sha" "$piwork_version" data >/dev/null
  sha256sum "$output/postgres.dump" "$output/data.tar" >"$output/SHA256SUMS"
  chmod 600 "$output"/postgres.dump "$output"/data.tar "$output"/SHA256SUMS "$output"/manifest.json
  node "$ROOT_DIR/scripts/backup-manifest.mjs" verify "$output" >/dev/null
  echo "Backup written to $output"
}

restore() {
  load_config
  select_mode
  local input="${1:-}"
  [[ -n "$input" && -f "$input/manifest.json" && -f "$input/SHA256SUMS" ]] || { echo 'A verified backup directory is required.' >&2; exit 2; }
  (cd "$input" && sha256sum -c SHA256SUMS)
  node "$ROOT_DIR/scripts/backup-manifest.mjs" verify "$input" >/dev/null
  compose down
  compose run --rm --no-deps runtime sh -eu -c \
    'rm -rf /var/lib/piwork/data.restore /var/lib/piwork/data.previous
     tar -C /var/lib/piwork -xf - --transform="s#^data#data.restore#"
     test -d /var/lib/piwork/data.restore
     mv /var/lib/piwork/data /var/lib/piwork/data.previous 2>/dev/null || true
     mv /var/lib/piwork/data.restore /var/lib/piwork/data
      rm -rf /var/lib/piwork/data.previous' <"$input/data.tar"
  compose up -d postgres
  compose --profile migrate run --rm migrate
  compose exec -T postgres pg_restore --clean --if-exists --no-owner --no-acl \
    -U "${POSTGRES_USER:-piwork}" -d "${POSTGRES_DB:-piwork}" <"$input/postgres.dump"
  compose down
  echo 'Database and Pi data restore completed. The fixed stack remains stopped until selfhost up is run.'
}

upgrade() {
  local requested_mode="$mode"
  [[ "${1:-}" == "--release" ]] && requested_mode=release
  [[ "${1:-}" == "--source" ]] && requested_mode=source
  mode="$requested_mode"
  local backup_dir="$ROOT_DIR/backups/piwork-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
  backup "$backup_dir"
  up
  doctor --require-verified
  curl -fsS http://127.0.0.1:${PIWORK_HTTP_PORT:-3457}/api/health/ready >/dev/null
  echo "Upgrade smoke passed; backup: $backup_dir"
}

command_name="${1:-}"
shift || true
case "$command_name" in
  init|configure) init_config ;;
  doctor) mode="${PIWORK_SELFHOST_MODE:-source}"; doctor "$@" ;;
  up) [[ "${1:-}" == "--release" ]] && mode=release; [[ "${1:-}" == "--source" ]] && mode=source; up ;;
  down) mode="${PIWORK_SELFHOST_MODE:-source}"; down ;;
  status) mode="${PIWORK_SELFHOST_MODE:-source}"; status ;;
  backup) mode="${PIWORK_SELFHOST_MODE:-source}"; backup "$@" ;;
  restore) mode="${PIWORK_SELFHOST_MODE:-source}"; restore "$@" ;;
  upgrade) mode="${PIWORK_SELFHOST_MODE:-source}"; upgrade "$@" ;;
  *) usage; exit 2 ;;
esac
