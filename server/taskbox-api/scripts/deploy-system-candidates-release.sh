#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ENV_FILE="${TASKBOX_ENV_FILE:-/etc/taskbox-api.env}"
RELEASE_DIR="${1:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${TASKBOX_BACKUP_DIR:-${APP_DIR}/backups/system-candidates-${STAMP}}"

if [[ -z "$RELEASE_DIR" || ! -f "$RELEASE_DIR/schema.sql" || ! -f "$RELEASE_DIR/src/server.js" ]]; then
  echo "usage: $0 /absolute/path/to/taskbox-api-release" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a
DB_PATH="${TASKBOX_DB_PATH:-${APP_DIR}/data/taskbox.sqlite}"

mkdir -p "$BACKUP_DIR/code" "$BACKUP_DIR/data"
systemctl stop "$SERVICE"

cp -a "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/schema.sql" "$BACKUP_DIR/code/"
cp -a "$APP_DIR/src" "$APP_DIR/scripts" "$BACKUP_DIR/code/"
for suffix in '' '-wal' '-shm'; do
  if [[ -f "${DB_PATH}${suffix}" ]]; then
    cp -a "${DB_PATH}${suffix}" "$BACKUP_DIR/data/"
  fi
done

cleanup() {
  systemctl start "$SERVICE" >/dev/null 2>&1 || true
}
trap cleanup ERR

install -m 0644 "$RELEASE_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$RELEASE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
install -m 0644 "$RELEASE_DIR/schema.sql" "$APP_DIR/schema.sql"
rm -rf "$APP_DIR/src" "$APP_DIR/scripts"
cp -a "$RELEASE_DIR/src" "$APP_DIR/src"
cp -a "$RELEASE_DIR/scripts" "$APP_DIR/scripts"

cd "$APP_DIR"
npm ci --omit=dev
npm run init-db
npm run test:schema
systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE"

HEALTH_URL="http://127.0.0.1:${TASKBOX_API_PORT:-3107}/health"
health_ready=false
for _ in {1..40}; do
  if curl --silent --show-error --fail --output /dev/null \
    --header "Authorization: Bearer $TASKBOX_API_TOKEN" \
    "$HEALTH_URL" 2>/dev/null; then
    health_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$health_ready" != true ]]; then
  echo "service active but authenticated health check did not become ready: $HEALTH_URL" >&2
  exit 1
fi
trap - ERR

echo "deployment_ok"
echo "rollback_snapshot=$BACKUP_DIR"
