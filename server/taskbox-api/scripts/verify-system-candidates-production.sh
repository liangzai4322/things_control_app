#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${TASKBOX_API_BASE_URL:-https://liangzai666.com/taskbox-api}"
ORIGIN="${TASKBOX_PRODUCTION_ORIGIN:-https://liangzai4322.github.io}"
TOKEN_FILE="${TASKBOX_API_TOKEN_FILE:-$HOME/.codex/secrets/taskbox-api-token}"

if [[ -z "${TASKBOX_API_TOKEN:-}" && -f "$TOKEN_FILE" ]]; then
  TASKBOX_API_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi
if [[ -z "${TASKBOX_API_TOKEN:-}" ]]; then
  echo "TASKBOX_API_TOKEN_missing" >&2
  exit 2
fi

auth_health="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TASKBOX_API_TOKEN" "$BASE_URL/health")"
unauth_health="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/health")"
cors="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET' "$BASE_URL/v1/system-candidates?systemId=mission")"
route="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TASKBOX_API_TOKEN" "$BASE_URL/v1/system-candidates?systemId=mission&status=pending&limit=1")"

printf 'authenticated_health=%s\nunauthenticated_health=%s\ncors_preflight=%s\ncandidate_route=%s\n' "$auth_health" "$unauth_health" "$cors" "$route"
[[ "$auth_health" == "200" && "$unauth_health" == "401" && "$cors" == "204" && "$route" == "200" ]]
