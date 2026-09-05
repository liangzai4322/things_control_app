#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
DAILY_INTAKE_APP_DIR="${DAILY_INTAKE_APP_DIR:-/opt/taskbox-daily-intake}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ASSISTANT_GATEWAY_SERVICE="${ASSISTANT_GATEWAY_SERVICE:-assistant-gateway.service}"
ASSISTANT_GATEWAY_MODE_DROPIN="20-production-mode.conf"
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

disable_external_write_apis() {
  local tmp="${ENV_FILE}.tmp.$$"
  awk '
    BEGIN { execution=0; gateway=0 }
    /^EXECUTION_SYSTEM_API_ENABLED=/ { print "EXECUTION_SYSTEM_API_ENABLED=0"; execution=1; next }
    /^ASSISTANT_GATEWAY_API_ENABLED=/ { print "ASSISTANT_GATEWAY_API_ENABLED=0"; gateway=1; next }
    { print }
    END {
      if (!execution) print "EXECUTION_SYSTEM_API_ENABLED=0"
      if (!gateway) print "ASSISTANT_GATEWAY_API_ENABLED=0"
    }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

systemctl stop "$SERVICE"
systemctl disable --now "$ASSISTANT_GATEWAY_SERVICE" >/dev/null 2>&1 || true
disable_external_write_apis
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
if [[ -d "$BACKUP_DIR/code/assistant-gateway" ]]; then
  rm -rf "${ASSISTANT_GATEWAY_APP_DIR:-/opt/taskbox-assistant-gateway}"
  install -d -m 0755 "${ASSISTANT_GATEWAY_APP_DIR:-/opt/taskbox-assistant-gateway}"
  cp -a "$BACKUP_DIR/code/assistant-gateway/." "${ASSISTANT_GATEWAY_APP_DIR:-/opt/taskbox-assistant-gateway}/"
fi
if [[ -f "$BACKUP_DIR/config/$ASSISTANT_GATEWAY_SERVICE" ]]; then
  install -m 0644 "$BACKUP_DIR/config/$ASSISTANT_GATEWAY_SERVICE" "$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE"
fi
assistant_gateway_dropin_dir="$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE.d"
rm -f "$assistant_gateway_dropin_dir/$ASSISTANT_GATEWAY_MODE_DROPIN"
if [[ -f "$BACKUP_DIR/config/$ASSISTANT_GATEWAY_MODE_DROPIN" ]]; then
  install -d -m 0755 "$assistant_gateway_dropin_dir"
  install -m 0644 "$BACKUP_DIR/config/$ASSISTANT_GATEWAY_MODE_DROPIN" \
    "$assistant_gateway_dropin_dir/$ASSISTANT_GATEWAY_MODE_DROPIN"
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
