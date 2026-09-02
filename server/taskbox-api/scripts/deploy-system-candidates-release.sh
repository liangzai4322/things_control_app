#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ENV_FILE="${TASKBOX_ENV_FILE:-/etc/taskbox-api.env}"
RELEASE_DIR="${1:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${TASKBOX_BACKUP_DIR:-${APP_DIR}/backups/execution-system-${STAMP}}"
EXECUTION_TOKEN_FILE="${EXECUTION_SYSTEM_API_TOKEN_FILE:-/etc/taskbox-execution-system-token}"
EXECUTION_DISABLE_FILE="${EXECUTION_SYSTEM_API_DISABLE_FILE:-/etc/taskbox-execution-system.disabled}"
EXECUTION_GRANT_ID="standing-execution-taskbox-normal-2026-09-02"
EXECUTION_SCOPES="tasks:read,tasks:create,tasks:update,tasks:schedule,tasks:progress,tasks:evidence,tasks:complete,tasks:delete,tasks:audit"

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
EXECUTION_TOKEN_FILE="${EXECUTION_SYSTEM_API_TOKEN_FILE:-$EXECUTION_TOKEN_FILE}"
EXECUTION_DISABLE_FILE="${EXECUTION_SYSTEM_API_DISABLE_FILE:-$EXECUTION_DISABLE_FILE}"

mkdir -p "$BACKUP_DIR/code" "$BACKUP_DIR/data" "$BACKUP_DIR/config"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/config"
systemctl stop "$SERVICE"

cp -a "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/schema.sql" "$BACKUP_DIR/code/"
cp -a "$APP_DIR/src" "$APP_DIR/scripts" "$BACKUP_DIR/code/"
cp -p "$ENV_FILE" "$BACKUP_DIR/config/taskbox-api.env"
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

upsert_env() {
  local key="$1" value="$2" tmp
  tmp="${ENV_FILE}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced=0 }
    index($0, key "=")==1 { print key "=" value; replaced=1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

if [[ ! -s "$EXECUTION_TOKEN_FILE" ]]; then
  umask 077
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex') + '\\n')" > "$EXECUTION_TOKEN_FILE"
fi
chmod 600 "$EXECUTION_TOKEN_FILE"
rm -f "$EXECUTION_DISABLE_FILE"
upsert_env EXECUTION_SYSTEM_API_ENABLED 1
upsert_env EXECUTION_SYSTEM_API_TOKEN_FILE "$EXECUTION_TOKEN_FILE"
upsert_env EXECUTION_SYSTEM_API_DISABLE_FILE "$EXECUTION_DISABLE_FILE"
upsert_env EXECUTION_SYSTEM_API_SCOPES "$EXECUTION_SCOPES"
upsert_env EXECUTION_SYSTEM_EXPLICIT_GRANT_IDS "$EXECUTION_GRANT_ID"

cd "$APP_DIR"
npm ci --omit=dev
npm run init-db
npm run test:schema
npm run test:execution
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

EXECUTION_TOKEN="$(tr -d '\r\n' < "$EXECUTION_TOKEN_FILE")"
CAPABILITY_URL="http://127.0.0.1:${TASKBOX_API_PORT:-3107}/v1/execution/capabilities"
curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $EXECUTION_TOKEN" "$CAPABILITY_URL"
if curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $TASKBOX_API_TOKEN" "$CAPABILITY_URL" 2>/dev/null; then
  echo "generic TaskBox token unexpectedly accessed execution API" >&2
  exit 1
fi
if curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $EXECUTION_TOKEN" "$HEALTH_URL" 2>/dev/null; then
  echo "execution token unexpectedly accessed generic TaskBox API" >&2
  exit 1
fi
trap - ERR

echo "deployment_ok"
echo "rollback_snapshot=$BACKUP_DIR"
echo "execution_token_file=$EXECUTION_TOKEN_FILE"
echo "execution_disable_file=$EXECUTION_DISABLE_FILE"
