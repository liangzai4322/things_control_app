#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
DAILY_INTAKE_APP_DIR="${DAILY_INTAKE_APP_DIR:-/opt/taskbox-daily-intake}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
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

disable_execution_api() {
  local tmp="${ENV_FILE}.tmp.$$"
  awk '
    BEGIN { replaced=0 }
    /^EXECUTION_SYSTEM_API_ENABLED=/ { print "EXECUTION_SYSTEM_API_ENABLED=0"; replaced=1; next }
    { print }
    END { if (!replaced) print "EXECUTION_SYSTEM_API_ENABLED=0" }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

systemctl stop "$SERVICE"
disable_execution_api
install -m 0644 "$BACKUP_DIR/code/package.json" "$APP_DIR/package.json"
install -m 0644 "$BACKUP_DIR/code/package-lock.json" "$APP_DIR/package-lock.json"
install -m 0644 "$BACKUP_DIR/code/schema.sql" "$APP_DIR/schema.sql"
rm -rf "$APP_DIR/src" "$APP_DIR/scripts"
cp -a "$BACKUP_DIR/code/src" "$APP_DIR/src"
cp -a "$BACKUP_DIR/code/scripts" "$APP_DIR/scripts"

if [[ -d "$BACKUP_DIR/code/daily-intake" ]]; then
  rm -rf "$DAILY_INTAKE_APP_DIR"
  install -d -m 0755 "$DAILY_INTAKE_APP_DIR"
  cp -a "$BACKUP_DIR/code/daily-intake/." "$DAILY_INTAKE_APP_DIR/"
  chown -R root:root "$DAILY_INTAKE_APP_DIR"
fi
for unit in taskbox-{attention,execution,feedback,health,hq,mission}-daily-intake.{service,timer}; do
  if [[ -f "$BACKUP_DIR/config/$unit" ]]; then install -m 0644 "$BACKUP_DIR/config/$unit" "$SYSTEMD_DIR/$unit"; fi
done

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
systemctl daemon-reload
for system in attention execution feedback health hq mission; do
  systemctl disable --now "taskbox-$system-daily-intake.timer" >/dev/null 2>&1 || true
done
systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE"
echo "rollback_ok"
