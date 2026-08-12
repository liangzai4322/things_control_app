#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ENV_FILE="${TASKBOX_ENV_FILE:-/etc/taskbox-api.env}"
BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" || ! -f "$BACKUP_DIR/code/schema.sql" ]]; then
  echo "usage: $0 /opt/taskbox-api/backups/system-candidates-YYYYMMDDTHHMMSSZ" >&2
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

systemctl stop "$SERVICE"
install -m 0644 "$BACKUP_DIR/code/package.json" "$APP_DIR/package.json"
install -m 0644 "$BACKUP_DIR/code/package-lock.json" "$APP_DIR/package-lock.json"
install -m 0644 "$BACKUP_DIR/code/schema.sql" "$APP_DIR/schema.sql"
rm -rf "$APP_DIR/src" "$APP_DIR/scripts"
cp -a "$BACKUP_DIR/code/src" "$APP_DIR/src"
cp -a "$BACKUP_DIR/code/scripts" "$APP_DIR/scripts"

if [[ "${RESTORE_TASKBOX_DATABASE:-0}" == "1" ]]; then
  rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
  for source in "$BACKUP_DIR"/data/*; do
    [[ -e "$source" ]] || continue
    cp -a "$source" "$(dirname "$DB_PATH")/"
  done
fi

cd "$APP_DIR"
npm ci --omit=dev
npm run init-db
systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE"
echo "rollback_ok"
