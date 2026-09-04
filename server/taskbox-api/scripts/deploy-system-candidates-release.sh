#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${TASKBOX_APP_DIR:-/opt/taskbox-api}"
DAILY_INTAKE_APP_DIR="${DAILY_INTAKE_APP_DIR:-/opt/taskbox-daily-intake}"
ASSISTANT_GATEWAY_APP_DIR="${ASSISTANT_GATEWAY_APP_DIR:-/opt/taskbox-assistant-gateway}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SERVICE="${TASKBOX_SERVICE:-taskbox-api.service}"
ASSISTANT_GATEWAY_SERVICE="${ASSISTANT_GATEWAY_SERVICE:-assistant-gateway.service}"
ASSISTANT_GATEWAY_MODE_DROPIN="20-production-mode.conf"
ENV_FILE="${TASKBOX_ENV_FILE:-/etc/taskbox-api.env}"
RELEASE_DIR="${1:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${TASKBOX_BACKUP_DIR:-${APP_DIR}/backups/execution-system-${STAMP}}"
EXECUTION_TOKEN_FILE="${EXECUTION_SYSTEM_API_TOKEN_FILE:-/etc/taskbox-execution-system-token}"
EXECUTION_DISABLE_FILE="${EXECUTION_SYSTEM_API_DISABLE_FILE:-/etc/taskbox-execution-system.disabled}"
ASSISTANT_GATEWAY_TOKEN_FILE="${ASSISTANT_GATEWAY_API_TOKEN_FILE:-/etc/taskbox-assistant-gateway-token}"
ASSISTANT_GATEWAY_READ_TOKEN_FILE="${ASSISTANT_GATEWAY_READ_TOKEN_FILE:-/etc/taskbox-assistant-gateway-read-token}"
ASSISTANT_GATEWAY_DISABLE_FILE="${ASSISTANT_GATEWAY_API_DISABLE_FILE:-/etc/taskbox-assistant-gateway.disabled}"
WEIXIN_INGRESS_TOKEN_FILE="${WEIXIN_INGRESS_TOKEN_FILE:-/etc/notification-ingress/weixin-ingress.token}"
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
ASSISTANT_GATEWAY_RELEASE_DIR="${RELEASE_DIR}/assistant-gateway"

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
  for file in worker.py status.py systemd/assistant-gateway.service \
    "systemd/assistant-gateway.service.d/$ASSISTANT_GATEWAY_MODE_DROPIN" tests/test_worker.py; do
    if [[ ! -f "$ASSISTANT_GATEWAY_RELEASE_DIR/$file" ]]; then
      echo "assistant gateway release missing $file" >&2
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
ASSISTANT_GATEWAY_TOKEN_FILE="${ASSISTANT_GATEWAY_API_TOKEN_FILE:-$ASSISTANT_GATEWAY_TOKEN_FILE}"
ASSISTANT_GATEWAY_READ_TOKEN_FILE="${ASSISTANT_GATEWAY_READ_TOKEN_FILE:-$ASSISTANT_GATEWAY_READ_TOKEN_FILE}"
ASSISTANT_GATEWAY_DISABLE_FILE="${ASSISTANT_GATEWAY_API_DISABLE_FILE:-$ASSISTANT_GATEWAY_DISABLE_FILE}"
DAILY_INTAKE_TOKEN_DIR="${DAILY_INTAKE_TOKEN_DIR:-$DAILY_INTAKE_TOKEN_DIR}"
DAILY_INTAKE_DISABLE_FILE="${DAILY_INTAKE_DISABLE_FILE:-$DAILY_INTAKE_DISABLE_FILE}"

mkdir -p "$BACKUP_DIR/code" "$BACKUP_DIR/data" "$BACKUP_DIR/config"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/config"
assistant_gateway_was_active=0
if systemctl is-active --quiet "$ASSISTANT_GATEWAY_SERVICE" >/dev/null 2>&1; then
  assistant_gateway_was_active=1
fi
systemctl stop "$SERVICE"

cp -a "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$APP_DIR/schema.sql" "$BACKUP_DIR/code/"
cp -a "$APP_DIR/src" "$APP_DIR/scripts" "$BACKUP_DIR/code/"
if [[ -d "$DAILY_INTAKE_APP_DIR" ]]; then
  cp -a "$DAILY_INTAKE_APP_DIR" "$BACKUP_DIR/code/daily-intake"
fi
if [[ -d "$ASSISTANT_GATEWAY_APP_DIR" ]]; then
  cp -a "$ASSISTANT_GATEWAY_APP_DIR" "$BACKUP_DIR/code/assistant-gateway"
fi
if [[ -f "$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE" ]]; then
  cp -a "$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE" "$BACKUP_DIR/config/"
fi
assistant_gateway_dropin_dir="$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE.d"
if [[ -f "$assistant_gateway_dropin_dir/$ASSISTANT_GATEWAY_MODE_DROPIN" ]]; then
  cp -a "$assistant_gateway_dropin_dir/$ASSISTANT_GATEWAY_MODE_DROPIN" "$BACKUP_DIR/config/"
else
  : > "$BACKUP_DIR/config/$ASSISTANT_GATEWAY_MODE_DROPIN.absent"
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
  if [[ "$assistant_gateway_was_active" == "1" ]]; then
    systemctl start "$ASSISTANT_GATEWAY_SERVICE" >/dev/null 2>&1 || true
  fi
}
trap cleanup ERR

systemctl stop "$ASSISTANT_GATEWAY_SERVICE" >/dev/null 2>&1 || true

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

if [[ ! -s "$ASSISTANT_GATEWAY_TOKEN_FILE" ]]; then
  umask 077
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex') + '\n')" > "$ASSISTANT_GATEWAY_TOKEN_FILE"
fi
chmod 600 "$ASSISTANT_GATEWAY_TOKEN_FILE"
if [[ ! -s "$ASSISTANT_GATEWAY_READ_TOKEN_FILE" ]]; then
  umask 077
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex') + '\n')" > "$ASSISTANT_GATEWAY_READ_TOKEN_FILE"
fi
chmod 600 "$ASSISTANT_GATEWAY_READ_TOKEN_FILE"
rm -f "$ASSISTANT_GATEWAY_DISABLE_FILE"
upsert_env ASSISTANT_GATEWAY_API_ENABLED 1
upsert_env ASSISTANT_GATEWAY_API_TOKEN_FILE "$ASSISTANT_GATEWAY_TOKEN_FILE"
upsert_env ASSISTANT_GATEWAY_API_DISABLE_FILE "$ASSISTANT_GATEWAY_DISABLE_FILE"
upsert_env ASSISTANT_GATEWAY_API_SCOPES "proposal-replies:write,proposal-auto-approve:write,proposal-promotions:write"
upsert_env ASSISTANT_GATEWAY_READ_TOKEN_FILE "$ASSISTANT_GATEWAY_READ_TOKEN_FILE"
upsert_env ASSISTANT_GATEWAY_READ_SCOPES "proposal-decisions:read"
upsert_env ASSISTANT_GATEWAY_REPLY_MAX_AGE_SECONDS 86400

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

if [[ -f "$ASSISTANT_GATEWAY_RELEASE_DIR/worker.py" ]]; then
  python3 -m unittest discover -s "$ASSISTANT_GATEWAY_RELEASE_DIR/tests" -q
  if ! getent group taskbox-assistant-gateway >/dev/null 2>&1; then
    groupadd --system taskbox-assistant-gateway
  fi
  if ! id -u taskbox-assistant-gateway >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      --gid taskbox-assistant-gateway taskbox-assistant-gateway
  fi
  rm -rf "$ASSISTANT_GATEWAY_APP_DIR"
  install -d -m 0755 "$ASSISTANT_GATEWAY_APP_DIR"
  install -m 0755 "$ASSISTANT_GATEWAY_RELEASE_DIR/worker.py" "$ASSISTANT_GATEWAY_APP_DIR/worker.py"
  install -m 0755 "$ASSISTANT_GATEWAY_RELEASE_DIR/status.py" "$ASSISTANT_GATEWAY_APP_DIR/status.py"
  install -m 0644 "$ASSISTANT_GATEWAY_RELEASE_DIR/systemd/assistant-gateway.service" "$SYSTEMD_DIR/$ASSISTANT_GATEWAY_SERVICE"
  install -d -m 0755 "$assistant_gateway_dropin_dir"
  install -m 0644 \
    "$ASSISTANT_GATEWAY_RELEASE_DIR/systemd/assistant-gateway.service.d/$ASSISTANT_GATEWAY_MODE_DROPIN" \
    "$assistant_gateway_dropin_dir/$ASSISTANT_GATEWAY_MODE_DROPIN"
fi

cd "$APP_DIR"
npm ci --omit=dev
npm run init-db
npm run test:schema
npm run test:hq
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

if [[ ! -s "$WEIXIN_INGRESS_TOKEN_FILE" ]]; then
  echo "missing Notification Hub ingress credential source" >&2
  exit 1
fi
if [[ "${TASKBOX_SKIP_CREDENTIAL_OWNER_CHECK:-0}" != "1" ]]; then
  if [[ "$(stat -c '%U:%G:%a' "$WEIXIN_INGRESS_TOKEN_FILE")" != "root:root:600" ]]; then
    echo "invalid Notification Hub ingress credential permissions" >&2
    exit 1
  fi
  if [[ "$(stat -c '%U:%G:%a' "$ASSISTANT_GATEWAY_TOKEN_FILE")" != "root:root:600" ]]; then
    echo "invalid HQ reply credential permissions" >&2
    exit 1
  fi
  if [[ "$(stat -c '%U:%G:%a' "$ASSISTANT_GATEWAY_READ_TOKEN_FILE")" != "root:root:600" ]]; then
    echo "invalid HQ read credential permissions" >&2
    exit 1
  fi
fi
WEIXIN_INGRESS_TOKEN="$(tr -d '\r\n' < "$WEIXIN_INGRESS_TOKEN_FILE")"
WEIXIN_REPLY_PROBE_BODY='{"consumerId":"assistant-gateway","leaseToken":"deployment-probe","replyKey":"assistant-gateway:deployment-probe","text":"deployment probe"}'
weixin_reply_probe_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header "Authorization: Bearer $WEIXIN_INGRESS_TOKEN" \
  --header 'Content-Type: application/json' --data "$WEIXIN_REPLY_PROBE_BODY" \
  'http://127.0.0.1:3219/v1/weixin-inbound/assistant-gateway-deployment-probe/reply')"
[[ "$weixin_reply_probe_code" == "404" ]] || { echo "Notification Hub reply probe failed: $weixin_reply_probe_code" >&2; exit 1; }
if curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $EXECUTION_TOKEN" "$HEALTH_URL" 2>/dev/null; then
  echo "execution token unexpectedly accessed generic TaskBox API" >&2
  exit 1
fi

ASSISTANT_GATEWAY_TOKEN="$(tr -d '\r\n' < "$ASSISTANT_GATEWAY_TOKEN_FILE")"
ASSISTANT_GATEWAY_READ_TOKEN="$(tr -d '\r\n' < "$ASSISTANT_GATEWAY_READ_TOKEN_FILE")"
ASSISTANT_GATEWAY_PENDING="$API_BASE_URL/v1/assistant-gateway/proposals/pending-user-decision?limit=20"
pending_headers=(
  --header 'X-Assistant-Verified-User-Ref: notification-hub-user:deployment-probe'
  --header 'X-Assistant-Conversation-Ref-Hash: 0000000000000000000000000000000000000000000000000000000000000000'
)
curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $ASSISTANT_GATEWAY_READ_TOKEN" "${pending_headers[@]}" "$ASSISTANT_GATEWAY_PENDING"
for denied_token in "$TASKBOX_API_TOKEN" "$ASSISTANT_GATEWAY_TOKEN"; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer $denied_token" "${pending_headers[@]}" "$ASSISTANT_GATEWAY_PENDING")"
  [[ "$code" == "401" ]] || { echo "non-read identity unexpectedly accessed assistant gateway pending API: $code" >&2; exit 1; }
done
ASSISTANT_GATEWAY_PROBE="$API_BASE_URL/v1/hq/proposals/assistant-gateway-auth-probe/replies"
ASSISTANT_GATEWAY_PROBE_BODY="$(node -e 'process.stdout.write(JSON.stringify({inboundMessageId:"assistant-gateway-auth-probe",replyRef:"deployment-probe",verifiedUserRef:"deployment-probe-user",conversationRefHash:"0".repeat(64),expectedProposalRevision:1,decision:"expand",textHash:"0".repeat(64),receivedAt:new Date().toISOString(),verification:{verified:true,source:"notification_hub_weixin",signatureRef:"deployment-probe-signature"},scopeKey:"deployment-probe-binding",clarification:"deployment probe"}))')"
gateway_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header "Authorization: Bearer $ASSISTANT_GATEWAY_TOKEN" \
  --header 'Content-Type: application/json' --header 'X-Idempotency-Key: assistant-gateway:deployment-probe' \
  --data "$ASSISTANT_GATEWAY_PROBE_BODY" "$ASSISTANT_GATEWAY_PROBE")"
[[ "$gateway_code" == "404" || "$gateway_code" == "400" ]] || { echo "assistant gateway auth probe failed: $gateway_code" >&2; exit 1; }
generic_gateway_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header "Authorization: Bearer $TASKBOX_API_TOKEN" \
  --header 'Content-Type: application/json' --header 'X-Idempotency-Key: assistant-gateway:deployment-probe' \
  --data "$ASSISTANT_GATEWAY_PROBE_BODY" "$ASSISTANT_GATEWAY_PROBE")"
[[ "$generic_gateway_code" == "401" ]] || { echo "generic token unexpectedly accessed assistant gateway API: $generic_gateway_code" >&2; exit 1; }
read_gateway_code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header "Authorization: Bearer $ASSISTANT_GATEWAY_READ_TOKEN" \
  --header 'Content-Type: application/json' --header 'X-Idempotency-Key: assistant-gateway:deployment-probe' \
  --data "$ASSISTANT_GATEWAY_PROBE_BODY" "$ASSISTANT_GATEWAY_PROBE")"
[[ "$read_gateway_code" == "401" ]] || { echo "read token unexpectedly accessed assistant gateway reply API: $read_gateway_code" >&2; exit 1; }
if curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $ASSISTANT_GATEWAY_TOKEN" "$HEALTH_URL" 2>/dev/null; then
  echo "assistant gateway token unexpectedly accessed generic TaskBox API" >&2
  exit 1
fi
if curl --silent --show-error --fail --output /dev/null \
  --header "Authorization: Bearer $ASSISTANT_GATEWAY_READ_TOKEN" "$HEALTH_URL" 2>/dev/null; then
  echo "assistant gateway read token unexpectedly accessed generic TaskBox API" >&2
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
    for status in accepted retrying; do
      inbox="$API_BASE_URL/v1/system-candidates?intake=1&systemId=$system&status=$status&limit=1"
      queue_count="$(curl --silent --show-error --fail --header "Authorization: Bearer $token" "$inbox" \
        | node -e "let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{const body=JSON.parse(input);process.stdout.write(String(Number(body.count)||0));});")"
      if [[ "$queue_count" != "0" ]]; then
        echo "daily intake enable gate has $status work for $system" >&2
        exit 1
      fi
    done
  done
  # Exercise every oneshot once while timers are still disabled, so a broken runtime cannot be scheduled.
  for system in hq mission health attention feedback execution; do
    unit="taskbox-$system-daily-intake.service"
    if ! systemctl start "$unit"; then
      systemctl status --no-pager --lines=40 "$unit" || true
      journalctl --no-pager --lines=80 --unit "$unit" || true
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
systemctl daemon-reload
systemctl enable --now "$ASSISTANT_GATEWAY_SERVICE"
systemctl is-enabled --quiet "$ASSISTANT_GATEWAY_SERVICE"
systemctl is-active --quiet "$ASSISTANT_GATEWAY_SERVICE"
effective_gateway_environment="$(systemctl show "$ASSISTANT_GATEWAY_SERVICE" --property=Environment --value)"
[[ " $effective_gateway_environment " == *" ASSISTANT_GATEWAY_MODE=decision "* ]] || {
  echo "assistant gateway effective mode is not decision" >&2
  exit 1
}
trap - ERR

echo "deployment_ok"
echo "rollback_snapshot=$BACKUP_DIR"
echo "execution_token_file=$EXECUTION_TOKEN_FILE"
echo "execution_disable_file=$EXECUTION_DISABLE_FILE"
echo "assistant_gateway_token_file=$ASSISTANT_GATEWAY_TOKEN_FILE"
echo "assistant_gateway_read_token_file=$ASSISTANT_GATEWAY_READ_TOKEN_FILE"
echo "assistant_gateway_disable_file=$ASSISTANT_GATEWAY_DISABLE_FILE"
echo "assistant_gateway_worker=active"
echo "assistant_gateway_worker_mode=decision"
echo "assistant_gateway_status_file=/var/lib/taskbox-assistant-gateway/status.json"
echo -n "assistant_gateway_status="
ASSISTANT_GATEWAY_STATUS_FILE=/var/lib/taskbox-assistant-gateway/status.json \
  python3 "$ASSISTANT_GATEWAY_APP_DIR/status.py"
echo "daily_intake_sender_token_file=$DAILY_SENDER_TOKEN_FILE"
echo "daily_intake_hq_token_file=$DAILY_HQ_TOKEN_FILE"
echo "daily_intake_token_dir=$DAILY_INTAKE_TOKEN_DIR"
echo "daily_intake_disable_file=$DAILY_INTAKE_DISABLE_FILE"
echo "daily_intake_timers=$daily_intake_timer_state"
