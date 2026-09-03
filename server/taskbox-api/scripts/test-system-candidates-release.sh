#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP_DIR="$TMP/app"
RELEASE_DIR="$TMP/release"
BACKUP_ROOT="$TMP/backups"
ENV_FILE="$TMP/taskbox-api.env"
BIN_DIR="$TMP/bin"
STATE_FILE="$TMP/service-state"
mkdir -p "$APP_DIR/data" "$RELEASE_DIR" "$BACKUP_ROOT" "$BIN_DIR"

cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/schema.sql" "$ROOT/src" "$ROOT/scripts" "$APP_DIR/"
cp -a "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/schema.sql" "$ROOT/src" "$ROOT/scripts" "$RELEASE_DIR/"
printf 'TASKBOX_DB_PATH=%s\n' "$APP_DIR/data/taskbox.sqlite" > "$ENV_FILE"
printf 'TASKBOX_API_PORT=3107\n' >> "$ENV_FILE"
printf 'TASKBOX_API_TOKEN=release-test-token\n' >> "$ENV_FILE"
printf 'EXECUTION_SYSTEM_API_TOKEN_FILE=%s\n' "$TMP/execution-token" >> "$ENV_FILE"
printf 'EXECUTION_SYSTEM_API_DISABLE_FILE=%s\n' "$TMP/execution-disabled" >> "$ENV_FILE"
printf 'DAILY_INTAKE_TOKEN_DIR=%s\n' "$TMP/daily-intake" >> "$ENV_FILE"
printf 'DAILY_INTAKE_DISABLE_FILE=%s\n' "$TMP/daily-intake-disabled" >> "$ENV_FILE"
mkdir -p "$TMP/daily-intake"
printf 'sender-test-token\n' > "$TMP/daily-intake/sender.token"
printf 'hq-test-token\n' > "$TMP/daily-intake/hq.token"
for system in execution health attention feedback mission; do printf '%s-test-token\n' "$system" > "$TMP/daily-intake/$system.token"; done
printf 'active\n' > "$STATE_FILE"
printf 'fixture\n' > "$APP_DIR/data/taskbox.sqlite"

cat > "$BIN_DIR/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  stop) printf 'inactive\n' > "$SYSTEMCTL_STATE_FILE" ;;
  start) printf 'active\n' > "$SYSTEMCTL_STATE_FILE" ;;
  is-active) grep -qx active "$SYSTEMCTL_STATE_FILE" ;;
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
if [[ "$*" == *"/v1/system-candidates?"* ]]; then
  if [[ "$*" == *"Authorization: Bearer release-test-token"* ]]; then printf '401'; exit; fi
  if [[ "$*" == *"Authorization: Bearer sender-test-token"* ]]; then printf '403'; exit; fi
  exit
fi
if [[ "$*" == *"/v1/hq/system-receipts"* ]]; then exit; fi
exit 2
EOF
chmod +x "$BIN_DIR/systemctl" "$BIN_DIR/npm" "$BIN_DIR/curl"

export PATH="$BIN_DIR:$PATH"
export SYSTEMCTL_STATE_FILE="$STATE_FILE"
export NPM_CALL_LOG="$TMP/npm.log"
export CURL_CALL_LOG="$TMP/curl.log"
export CURL_ATTEMPTS_FILE="$TMP/curl-attempts"
export TASKBOX_APP_DIR="$APP_DIR"
export TASKBOX_ENV_FILE="$ENV_FILE"
export TASKBOX_BACKUP_DIR="$BACKUP_ROOT/snapshot"

"$ROOT/scripts/deploy-system-candidates-release.sh" "$RELEASE_DIR" > "$TMP/deploy.log"
grep -qx active "$STATE_FILE"
test -f "$BACKUP_ROOT/snapshot/data/taskbox.sqlite"
grep -q 'deployment_ok' "$TMP/deploy.log"
grep -q 'ci --omit=dev' "$TMP/npm.log"
grep -q 'run init-db' "$TMP/npm.log"
grep -q 'run test:schema' "$TMP/npm.log"
grep -q 'run test:execution' "$TMP/npm.log"
grep -q 'run test:system-intake' "$TMP/npm.log"
grep -q 'Authorization: Bearer release-test-token' "$CURL_CALL_LOG"
grep -q 'http://127.0.0.1:3107/health' "$CURL_CALL_LOG"
grep -q '/v1/execution/capabilities' "$CURL_CALL_LOG"
grep -q '^EXECUTION_SYSTEM_API_ENABLED=1$' "$ENV_FILE"
test -s "$TMP/execution-token"
grep -q '^DAILY_INTAKE_API_ENABLED=1$' "$ENV_FILE"
test -s "$TMP/daily-intake/sender.token"
test -s "$TMP/daily-intake/hq.token"

printf 'changed\n' > "$APP_DIR/schema.sql"
"$ROOT/scripts/rollback-system-candidates-release.sh" "$BACKUP_ROOT/snapshot" > "$TMP/rollback.log"
cmp -s "$APP_DIR/schema.sql" "$BACKUP_ROOT/snapshot/code/schema.sql"
grep -qx active "$STATE_FILE"
grep -q 'rollback_ok' "$TMP/rollback.log"
grep -q '^EXECUTION_SYSTEM_API_ENABLED=0$' "$ENV_FILE"

echo "system candidate release script tests passed"
