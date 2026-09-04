#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP_DIR="$TMP/app"
RELEASE_DIR="$TMP/release"
API_RELEASE_DIR="$RELEASE_DIR/taskbox-api"
BACKUP_ROOT="$TMP/backups"
ENV_FILE="$TMP/taskbox-api.env"
BIN_DIR="$TMP/bin"
STATE_FILE="$TMP/service-state"
mkdir -p "$APP_DIR/data" "$API_RELEASE_DIR" "$BACKUP_ROOT" "$BIN_DIR"

cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/schema.sql" "$ROOT/src" "$ROOT/scripts" "$APP_DIR/"
cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/schema.sql" "$ROOT/src" "$ROOT/scripts" "$API_RELEASE_DIR/"
mkdir -p "$RELEASE_DIR/daily-intake/systemd" "$RELEASE_DIR/daily-intake/integrations" "$RELEASE_DIR/daily-intake/scripts"
mkdir -p "$RELEASE_DIR/assistant-gateway"
cp -a "$ROOT/systemd/." "$RELEASE_DIR/daily-intake/systemd/"
cp -a "$PROJECT_ROOT/integrations/attention-system/systemd/." "$RELEASE_DIR/daily-intake/systemd/"
for system in attention-system execution-system feedback-system health-system mission-system; do
  cp -a "$PROJECT_ROOT/integrations/$system" "$RELEASE_DIR/daily-intake/integrations/"
done
cp "$PROJECT_ROOT"/scripts/consume-daily-intake-{attention,execution,health,mission}.mjs "$PROJECT_ROOT/scripts/sync-hq-daily-intake-receipts.mjs" "$RELEASE_DIR/daily-intake/scripts/"
cp -a "$PROJECT_ROOT/js" "$RELEASE_DIR/daily-intake/"
printf '{"private":true,"type":"module"}\n' > "$RELEASE_DIR/daily-intake/package.json"
cp -a "$PROJECT_ROOT/integrations/assistant-gateway/." "$RELEASE_DIR/assistant-gateway/"
printf 'TASKBOX_DB_PATH=%s\n' "$APP_DIR/data/taskbox.sqlite" > "$ENV_FILE"
printf 'TASKBOX_API_PORT=3107\n' >> "$ENV_FILE"
printf 'TASKBOX_API_TOKEN=release-test-token\n' >> "$ENV_FILE"
printf 'EXECUTION_SYSTEM_API_TOKEN_FILE=%s\n' "$TMP/execution-token" >> "$ENV_FILE"
printf 'EXECUTION_SYSTEM_API_DISABLE_FILE=%s\n' "$TMP/execution-disabled" >> "$ENV_FILE"
printf 'ASSISTANT_GATEWAY_API_TOKEN_FILE=%s\n' "$TMP/assistant-gateway-token" >> "$ENV_FILE"
printf 'ASSISTANT_GATEWAY_READ_TOKEN_FILE=%s\n' "$TMP/assistant-gateway-read-token" >> "$ENV_FILE"
printf 'ASSISTANT_GATEWAY_API_DISABLE_FILE=%s\n' "$TMP/assistant-gateway-disabled" >> "$ENV_FILE"
printf 'DAILY_INTAKE_TOKEN_DIR=%s\n' "$TMP/daily-intake" >> "$ENV_FILE"
printf 'DAILY_INTAKE_DISABLE_FILE=%s\n' "$TMP/daily-intake-disabled" >> "$ENV_FILE"
mkdir -p "$TMP/daily-intake"
printf 'sender-test-token\n' > "$TMP/daily-intake/sender.token"
printf 'hq-test-token\n' > "$TMP/daily-intake/hq.token"
for system in execution health attention feedback mission; do printf '%s-test-token\n' "$system" > "$TMP/daily-intake/$system.token"; done
printf 'active\n' > "$STATE_FILE"
printf 'fixture\n' > "$APP_DIR/data/taskbox.sqlite"
mkdir -p "$TMP/notification-ingress"
printf 'ingress-test-token\n' > "$TMP/notification-ingress/weixin-ingress.token"
printf 'assistant-gateway-write-test-token\n' > "$TMP/assistant-gateway-token"
printf 'assistant-gateway-read-test-token\n' > "$TMP/assistant-gateway-read-token"
chmod 600 "$TMP/notification-ingress/weixin-ingress.token"
chmod 600 "$TMP/assistant-gateway-token" "$TMP/assistant-gateway-read-token"

cat > "$BIN_DIR/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  stop) printf 'inactive\n' > "$SYSTEMCTL_STATE_FILE" ;;
  start) printf 'active\n' > "$SYSTEMCTL_STATE_FILE"; printf 'start %s\n' "$2" >> "$SYSTEMCTL_CALL_LOG" ;;
  is-active) grep -qx active "$SYSTEMCTL_STATE_FILE" ;;
  enable) printf 'enable %s\n' "${3:-$2}" >> "$SYSTEMCTL_CALL_LOG" ;;
  is-enabled) : ;;
  show) printf 'ASSISTANT_GATEWAY_MODE=echo ASSISTANT_GATEWAY_MODE=decision\n' ;;
  daemon-reload|disable) printf '%s %s\n' "$1" "${2:-}" >> "$SYSTEMCTL_CALL_LOG" ;;
  *) exit 2 ;;
esac
EOF
cat > "$BIN_DIR/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$NPM_CALL_LOG"
EOF
cat > "$BIN_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
attempts=0
if [[ -f "$CURL_ATTEMPTS_FILE" ]]; then attempts="$(cat "$CURL_ATTEMPTS_FILE")"; fi
attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$CURL_ATTEMPTS_FILE"
printf '%s\n' "$*" >> "$CURL_CALL_LOG"
if [[ "$*" == *"http://127.0.0.1:3107/health"* ]]; then
  if [[ "$*" == *"Authorization: Bearer release-test-token"* ]]; then
    (( attempts >= 3 ))
    exit
  fi
  exit 1
fi
if [[ "$*" == *"/v1/execution/capabilities"* ]]; then
  [[ "$*" != *"Authorization: Bearer release-test-token"* ]]
  exit
fi
if [[ "$*" == *"/v1/hq/proposals/assistant-gateway-auth-probe/replies"* ]]; then
  if [[ "$*" == *"Authorization: Bearer release-test-token"* || "$*" == *"Authorization: Bearer assistant-gateway-read-test-token"* ]]; then printf '401'; else printf '404'; fi
  exit
fi
if [[ "$*" == *"/v1/assistant-gateway/proposals/pending-user-decision"* ]]; then
  if [[ "$*" == *"Authorization: Bearer release-test-token"* || "$*" == *"Authorization: Bearer assistant-gateway-write-test-token"* ]]; then printf '401'; fi
  exit
fi
if [[ "$*" == *"/v1/weixin-inbound/assistant-gateway-deployment-probe/reply"* ]]; then printf '404'; exit; fi
if [[ "$*" == *"/v1/system-candidates?"* ]]; then
  if [[ "$*" == *"Authorization: Bearer release-test-token"* ]]; then printf '401'; exit; fi
  if [[ "$*" == *"Authorization: Bearer sender-test-token"* ]]; then printf '403'; exit; fi
  if [[ "$*" == *"Authorization: Bearer execution-test-token"* && "$*" != *"systemId=execution"* ]]; then printf '403'; exit; fi
  if [[ "$*" == *"-test-token"* ]]; then
    if [[ "$*" == *"--output /dev/null"* ]]; then printf '200'; else printf '{"intakes":[],"count":0}'; fi
    exit
  fi
  exit
fi
if [[ "$*" == *"/v1/hq/system-receipts"* ]]; then exit; fi
exit 2
EOF
chmod +x "$BIN_DIR/systemctl" "$BIN_DIR/npm" "$BIN_DIR/curl"
cat > "$BIN_DIR/getent" <<'EOF'
#!/usr/bin/env bash
exit 2
EOF
cat > "$BIN_DIR/groupadd" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$BIN_DIR/useradd" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$BIN_DIR/id" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$BIN_DIR/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$BIN_DIR/getent" "$BIN_DIR/groupadd" "$BIN_DIR/useradd" "$BIN_DIR/id" "$BIN_DIR/chown"

export PATH="$BIN_DIR:$PATH"
export SYSTEMCTL_STATE_FILE="$STATE_FILE"
export NPM_CALL_LOG="$TMP/npm.log"
export CURL_CALL_LOG="$TMP/curl.log"
export CURL_ATTEMPTS_FILE="$TMP/curl-attempts"
export SYSTEMCTL_CALL_LOG="$TMP/systemctl.log"
export TASKBOX_APP_DIR="$APP_DIR"
export TASKBOX_ENV_FILE="$ENV_FILE"
export TASKBOX_BACKUP_DIR="$BACKUP_ROOT/snapshot"
export DAILY_INTAKE_APP_DIR="$TMP/daily-app"
export SYSTEMD_DIR="$TMP/systemd"
export DAILY_INTAKE_ENABLE_TIMERS=1
export ASSISTANT_GATEWAY_APP_DIR="$TMP/assistant-gateway-app"
export ASSISTANT_GATEWAY_SERVICE="assistant-gateway.service"
export WEIXIN_INGRESS_TOKEN_FILE="$TMP/notification-ingress/weixin-ingress.token"
export TASKBOX_SKIP_CREDENTIAL_OWNER_CHECK=1

"$ROOT/scripts/deploy-system-candidates-release.sh" "$RELEASE_DIR" > "$TMP/deploy.log"
grep -qx active "$STATE_FILE"
test -f "$BACKUP_ROOT/snapshot/data/taskbox.sqlite"
grep -q 'deployment_ok' "$TMP/deploy.log"
grep -q 'ci --omit=dev' "$TMP/npm.log"
grep -q 'run init-db' "$TMP/npm.log"
grep -q 'run test:schema' "$TMP/npm.log"
grep -q 'run test:hq' "$TMP/npm.log"
grep -q 'run test:execution' "$TMP/npm.log"
grep -q 'run test:system-intake' "$TMP/npm.log"
grep -q 'Authorization: Bearer release-test-token' "$CURL_CALL_LOG"
grep -q 'http://127.0.0.1:3107/health' "$CURL_CALL_LOG"
grep -q '/v1/execution/capabilities' "$CURL_CALL_LOG"
grep -q '^EXECUTION_SYSTEM_API_ENABLED=1$' "$ENV_FILE"
test -s "$TMP/execution-token"
grep -q '^ASSISTANT_GATEWAY_API_ENABLED=1$' "$ENV_FILE"
grep -q '^ASSISTANT_GATEWAY_API_SCOPES=proposal-replies:write,proposal-auto-approve:write,proposal-promotions:write$' "$ENV_FILE"
grep -q '^ASSISTANT_GATEWAY_READ_SCOPES=proposal-decisions:read$' "$ENV_FILE"
test -s "$TMP/assistant-gateway-token"
test -s "$TMP/assistant-gateway-read-token"
grep -q '^DAILY_INTAKE_API_ENABLED=1$' "$ENV_FILE"
test -s "$TMP/daily-intake/sender.token"
test -s "$TMP/daily-intake/hq.token"
for system in attention execution feedback health hq mission; do
  mode="$(stat -c '%a' "$TMP/daily-intake/$system.token" 2>/dev/null || stat -f '%Lp' "$TMP/daily-intake/$system.token")"
  test "$mode" = "600"
  test -f "$TMP/systemd/taskbox-$system-daily-intake.service"
  test -f "$TMP/systemd/taskbox-$system-daily-intake.timer"
  grep -Fqx 'OnCalendar=*:0/15' "$TMP/systemd/taskbox-$system-daily-intake.timer"
  ! grep -q '^OnUnit.*Sec=' "$TMP/systemd/taskbox-$system-daily-intake.timer"
  grep -q '^RuntimeDirectory=' "$TMP/systemd/taskbox-$system-daily-intake.service"
  grep -q '^ReadOnlyPaths=-' "$TMP/systemd/taskbox-$system-daily-intake.service"
  ! grep -q '%d/' "$TMP/systemd/taskbox-$system-daily-intake.service"
done
grep -q 'daily_intake_timers=enabled' "$TMP/deploy.log"
grep -q 'assistant_gateway_worker=active' "$TMP/deploy.log"
grep -q 'assistant_gateway_worker_mode=decision' "$TMP/deploy.log"
test -f "$TMP/systemd/assistant-gateway.service"
grep -q '^Environment=ASSISTANT_GATEWAY_MODE=echo$' "$TMP/systemd/assistant-gateway.service"
test -f "$TMP/systemd/assistant-gateway.service.d/20-production-mode.conf"
grep -q '^Environment=ASSISTANT_GATEWAY_MODE=decision$' \
  "$TMP/systemd/assistant-gateway.service.d/20-production-mode.conf"
test -x "$TMP/assistant-gateway-app/status.py"
grep -q '^LoadCredential=hq-read.token:' "$TMP/systemd/assistant-gateway.service"
grep -q '^StateDirectory=taskbox-assistant-gateway$' "$TMP/systemd/assistant-gateway.service"
! grep -q '/v1/tasks' "$TMP/assistant-gateway-app/worker.py"
grep -q 'start taskbox-hq-daily-intake.service' "$SYSTEMCTL_CALL_LOG"
grep -q 'enable taskbox-hq-daily-intake.timer' "$TMP/systemctl.log"

printf 'changed\n' > "$APP_DIR/schema.sql"
"$ROOT/scripts/rollback-system-candidates-release.sh" "$BACKUP_ROOT/snapshot" > "$TMP/rollback.log"
cmp -s "$APP_DIR/schema.sql" "$BACKUP_ROOT/snapshot/code/schema.sql"
grep -qx active "$STATE_FILE"
grep -q 'rollback_ok' "$TMP/rollback.log"
grep -q '^EXECUTION_SYSTEM_API_ENABLED=0$' "$ENV_FILE"
grep -q '^ASSISTANT_GATEWAY_API_ENABLED=0$' "$ENV_FILE"
test ! -f "$TMP/systemd/assistant-gateway.service.d/20-production-mode.conf"

echo "system candidate release script tests passed"
