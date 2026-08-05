#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${PIWORK_POSTGRES_APP_PASSWORD_FILE:-}" && -f "$PIWORK_POSTGRES_APP_PASSWORD_FILE" ]]; then
  app_password="$(<"$PIWORK_POSTGRES_APP_PASSWORD_FILE")"
  [[ "$app_password" != *$'\n'* && "$app_password" != *$'\r'* && -n "$app_password" ]] || {
    echo "Postgres application password file is invalid" >&2
    exit 1
  }
  export DATABASE_URL="postgres://${PIWORK_POSTGRES_APP_USER:-piwork_web}:${app_password}@postgres:5432/${POSTGRES_DB:-piwork}"
  unset app_password
fi

[[ -n "${DATABASE_URL:-}" ]] || {
  echo "DATABASE_URL or the Postgres application password secret is required" >&2
  exit 1
}
exec "$@"
