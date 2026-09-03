#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
DAILY_INTAKE_APP_DIR="${DAILY_INTAKE_APP_DIR:-/opt/taskbox-daily-intake}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ENV_FILE="${TASKBOX_ENV_FILE:-/etc/taskbox-api.env}"
RELEASE_DIR="${1:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${TASKBOX_BACKUP_DIR:-${APP_DIR}/backups/execution-system-${STAMP}}"
EXECUTION_TOKEN_FILE="${EXECUTION_SYSTEM_API_TOKEN_FILE:-/etc/taskbox-execution-system-token}"
EXECUTION_DISABLE_FILE="${EXECUTION_SYSTEM_API_DISABLE_FILE:-/etc/taskbox-execution-system.disabled}"
DAILY_INTAKE_TOKEN_DIR="${DAILY_INTAKE_TOKEN_DIR:-/etc/taskbox-daily-intake}"
DAILY_INTAKE_DISABLE_FILE="${DAILY_INTAKE_DISABLE_FILE:-/etc/taskbox-daily-intake.disabled}"
DAILY_INTAKE_ENABLE_TIMERS="${DAILY_INTAKE_ENABLE_TIMERS:-0}"
EXECUTION_GRANT_ID="standing-execution-taskbox-normal-2026-09-02"
EXECUTION_SCOPES="tasks:read,tasks:create,tasks:update,tasks:schedule,tasks:progress,tasks:evidence,tasks:complete,tasks:delete,tasks:audit"
if [[ -f "$RELEASE_DIR/schema.sql" ]]; then
  API_RELEASE_DIR="$RELEASE_DIR"
else
  API_RELEASE_DIR="$RELEASE_DIR/taskbox-api"
fi
DAILY_RELEASE_DIR="${RELEASE_DIR}/daily-intake"

if [[ -z "$RELEASE_DIR" || ! -f "$API_RELEASE_DIR/schema.sql" || ! -f "$API_RELEASE_DIR/src/server.js" ]]; then
  echo "usage: $0 /absolute/path/to/taskbox-api-release" >&2
  exit 2
fi
if [[ "$API_RELEASE_DIR" != "$RELEASE_DIR" ]]; then
  required_runtime_files=(
    package.json
    scripts/consume-daily-intake-attention.mjs
    scripts/consume-daily-intake-execution.mjs
    scripts/consume-daily-intake-health.mjs
    scripts/consume-daily-intake-mission.mjs
    scripts/sync-hq-daily-intake-receipts.mjs
    integrations/attention-system/daily-intake-runner.mjs
    integrations/execution-system/daily-intake-consumer.mjs
    integrations/feedback-system/daily-intake-runner.mjs
    integrations/health-system/daily-intake-worker.mjs
    integrations/mission-system/daily-intake-runner.mjs
  )
  for file in "${required_runtime_files[@]}"; do
    if [[ ! -f "$DAILY_RELEASE_DIR/$file" ]]; then
      echo "daily intake release missing $file" >&2
      exit 2
    fi
  done
  for unit in taskbox-{attention,execution,feedback,health,hq,mission}-daily-intake.{service,timer}; do
    if [[ ! -f "$DAILY_RELEASE_DIR/systemd/$unit" ]]; then
      echo "daily intake release missing systemd/$unit" >&2
      exit 2
    fi
  done
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
DAILY_INTAKE_TOKEN_DIR="${DAILY_INTAKE_TOKEN_DIR:-$DAILY_INTAKE_TOKEN_DIR}"
DAILY_INTAKE_DISABLE_FILE="${DAILY_INTAKE_DISABLE_FILE:-$DAILY_INTAKE_DISABLE_FILE}"

mkdir -p "$BACKUP_DIR/code" "$BACKUP_DIR/data" "$BACKUP_DIR/config"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/config"
systemctl stop "$SERVICE"

cp -a "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/schema.sql" "$BACKUP_DIR/code/"
cp -a "$APP_DIR/src" "$APP_DIR/scripts" "$BACKUP_DIR/code/"
if [[ -d "$DAILY_INTAKE_APP_DIR" ]]; then
  cp -a "$DAILY_INTAKE_APP_DIR" "$BACKUP_DIR/code/daily-intake"
fi
for unit in taskbox-{attention,execution,feedback,health,hq,mission}-daily-intake.{service,timer}; do
  if [[ -f "$SYSTEMD_DIR/$unit" ]]; then cp -a "$SYSTEMD_DIR/$unit" "$BACKUP_DIR/config/"; fi
done
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

install -m 0644 "$API_RELEASE_DIR/package.json" "$APP_DIR/package.json"
install -m 0644 "$API_RELEASE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
install -m 0644 "$API_RELEASE_DIR/schema.sql" "$APP_DIR/schema.sql"
rm -rf "$APP_DIR/src" "$APP_DIR/scripts"
cp -a "$API_RELEASE_DIR/src" "$APP_DIR/src"
cp -a "$API_RELEASE_DIR/scripts" "$APP_DIR/scripts"

if [[ -d "$DAILY_RELEASE_DIR" ]]; then
  rm -rf "$DAILY_INTAKE_APP_DIR"
  install -d -m 0755 "$DAILY_INTAKE_APP_DIR"
  cp -a "$DAILY_RELEASE_DIR/." "$DAILY_INTAKE_APP_DIR/"
  chown -R root:root "$DAILY_INTAKE_APP_DIR"
  find "$DAILY_INTAKE_APP_DIR" -type d -exec chmod 755 {} +
  find "$DAILY_INTAKE_APP_DIR" -type f -exec chmod 644 {} +
  find "$DAILY_INTAKE_APP_DIR" -type f -name '*.mjs' -exec chmod 755 {} +
fi

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

# Daily Review identities are deliberately separate from the browser and execution-system tokens.
install -d -m 700 "$DAILY_INTAKE_TOKEN_DIR"
create_daily_intake_token() {
  local name="$1"
  local file="$DAILY_INTAKE_TOKEN_DIR/$name.token"
  if [[ ! -s "$file" ]]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex') + '\\n')" > "$file"
  fi
  chmod 600 "$file"
  printf '%s' "$file"
}
DAILY_SENDER_TOKEN_FILE="$(create_daily_intake_token sender)"
DAILY_HQ_TOKEN_FILE="$(create_daily_intake_token hq)"
upsert_env DAILY_INTAKE_API_ENABLED 1
upsert_env DAILY_INTAKE_DISABLE_FILE "$DAILY_INTAKE_DISABLE_FILE"
upsert_env DAILY_INTAKE_SENDER_TOKEN_FILE "$DAILY_SENDER_TOKEN_FILE"
upsert_env DAILY_INTAKE_HQ_TOKEN_FILE "$DAILY_HQ_TOKEN_FILE"
for system in execution health attention feedback mission; do
  upper="$(printf '%s' "$system" | tr '[:lower:]' '[:upper:]')"
  token_file="$(create_daily_intake_token "$system")"
  upsert_env "DAILY_INTAKE_${upper}_TOKEN_FILE" "$token_file"
done
rm -f "$DAILY_INTAKE_DISABLE_FILE"

if [[ -d "$DAILY_RELEASE_DIR/systemd" ]]; then
  for system in attention execution feedback health hq mission; do
    if ! getent group "taskbox-$system" >/dev/null 2>&1; then
      groupadd --system "taskbox-$system"
    fi
    if ! id -u "taskbox-$system" >/dev/null 2>&1; then
      useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
        --gid "taskbox-$system" "taskbox-$system"
    fi
  done
  install -d -m 0755 "$SYSTEMD_DIR"
  for unit in taskbox-{attention,execution,feedback,health,hq,mission}-daily-intake.{service,timer}; do
    if [[ -f "$DAILY_RELEASE_DIR/systemd/$unit" ]]; then
      install -m 0644 "$DAILY_RELEASE_DIR/systemd/$unit" "$SYSTEMD_DIR/$unit"
    fi
  done
  systemctl daemon-reload
  # Installation never starts consumers. Enablement is a separate, post-gate action.
  for system in attention execution feedback health hq mission; do
    systemctl disable --now "taskbox-$system-daily-intake.timer" >/dev/null 2>&1 || true
    systemctl disable "taskbox-$system-daily-intake.service" >/dev/null 2>&1 || true
  done
fi

cd "$APP_DIR"
npm ci --omit=dev
npm run init-db
npm run test:schema
npm run test:execution
npm run test:system-intake
systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE"

API_BASE_URL="http://127.0.0.1:${TASKBOX_API_PORT:-3107}"
HEALTH_URL="$API_BASE_URL/health"
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

DAILY_SENDER_TOKEN="$(tr -d '\r\n' < "$DAILY_SENDER_TOKEN_FILE")"
DAILY_HQ_TOKEN="$(tr -d '\r\n' < "$DAILY_HQ_TOKEN_FILE")"
DAILY_EXECUTION_TOKEN="$(tr -d '\r\n' < "$(create_daily_intake_token execution)")"
DAILY_EXECUTION_INBOX="$API_BASE_URL/v1/system-candidates?intake=1&systemId=execution&limit=1"
DAILY_HQ_RECEIPTS="$API_BASE_URL/v1/hq/system-receipts?limit=1"
curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $DAILY_EXECUTION_TOKEN" "$DAILY_EXECUTION_INBOX"
curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $DAILY_HQ_TOKEN" "$DAILY_HQ_RECEIPTS"
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $TASKBOX_API_TOKEN" "$DAILY_EXECUTION_INBOX")" != "401" ]]; then
  echo "generic TaskBox token unexpectedly accessed daily intake API" >&2
  exit 1
fi
if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $DAILY_SENDER_TOKEN" "$DAILY_EXECUTION_INBOX")" != "403" ]]; then
  echo "daily sender unexpectedly read a consumer inbox" >&2
  exit 1
fi
for system in attention execution feedback health mission; do
  token_file="$DAILY_INTAKE_TOKEN_DIR/$system.token"
  token="$(tr -d '\r\n' < "$token_file")"
  inbox="$API_BASE_URL/v1/system-candidates?intake=1&systemId=$system&limit=1"
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $token" "$inbox")"
  [[ "$code" == "200" ]] || { echo "daily intake auth probe failed for $system: $code" >&2; exit 1; }
done
for system in attention execution feedback health mission; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --header "Authorization: Bearer $DAILY_EXECUTION_TOKEN" "$API_BASE_URL/v1/system-candidates?intake=1&systemId=$system&limit=1")"
  if [[ "$system" != execution && "$code" != "403" ]]; then
    echo "execution identity crossed into $system intake: $code" >&2
    exit 1
  fi
done
daily_intake_timer_state=disabled
if [[ "$DAILY_INTAKE_ENABLE_TIMERS" == "1" ]]; then
  for system in attention execution feedback health mission; do
    token="$(tr -d '\r\n' < "$DAILY_INTAKE_TOKEN_DIR/$system.token")"
    inbox="$API_BASE_URL/v1/system-candidates?intake=1&systemId=$system&status=accepted&limit=1"
    queue_count="$(curl --silent --show-error --fail --header "Authorization: Bearer $token" "$inbox" \
      | node -e "let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{const body=JSON.parse(input);process.stdout.write(String(Number(body.count)||0));});")"
    if [[ "$queue_count" != "0" ]]; then
      echo "daily intake enable gate is not empty for $system" >&2
      exit 1
    fi
  done
  for system in hq mission health attention feedback execution; do
    systemctl enable --now "taskbox-$system-daily-intake.timer"
    systemctl is-enabled --quiet "taskbox-$system-daily-intake.timer"
    systemctl is-active --quiet "taskbox-$system-daily-intake.timer"
  done
  daily_intake_timer_state=enabled
fi
trap - ERR

echo "deployment_ok"
echo "rollback_snapshot=$BACKUP_DIR"
echo "execution_token_file=$EXECUTION_TOKEN_FILE"
echo "execution_disable_file=$EXECUTION_DISABLE_FILE"
echo "daily_intake_sender_token_file=$DAILY_SENDER_TOKEN_FILE"
echo "daily_intake_hq_token_file=$DAILY_HQ_TOKEN_FILE"
echo "daily_intake_token_dir=$DAILY_INTAKE_TOKEN_DIR"
echo "daily_intake_disable_file=$DAILY_INTAKE_DISABLE_FILE"
echo "daily_intake_timers=$daily_intake_timer_state"
