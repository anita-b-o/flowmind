#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="flowmind-rc1-smoke-$$"
FILE="infrastructure/chaos/docker-compose.production-smoke.yml"
API="http://127.0.0.1:3311"
cleaned=0

cleanup() {
  if [[ "$cleaned" -eq 0 ]]; then
    docker compose -p "$PROJECT" -f "$FILE" down -v --remove-orphans >/dev/null 2>&1 || true
    cleaned=1
  fi
}
trap cleanup EXIT INT TERM

json_field() {
  python3 -c 'import json,sys; value=json.load(sys.stdin); [value := value[key] for key in sys.argv[1].split(".")]; print(value)' "$1"
}

api_call() {
  local method="$1" path="$2" body="${3:-}"
  local args=(--fail-with-body --silent --show-error --request "$method" "$API$path")
  if [[ -n "${TOKEN:-}" ]]; then args+=(--header "authorization: Bearer $TOKEN" --header "x-organization-id: $ORGANIZATION_ID"); fi
  if [[ -n "$body" ]]; then args+=(--header "content-type: application/json" --data "$body"); fi
  curl "${args[@]}"
}

docker compose -p "$PROJECT" -f "$FILE" up -d --wait
MIGRATE_ID="$(docker compose -p "$PROJECT" -f "$FILE" ps -a -q migrate)"
test -n "$MIGRATE_ID"
test "$(docker inspect -f '{{.State.ExitCode}}' "$MIGRATE_ID")" -eq 0
test -n "$(docker compose -p "$PROJECT" -f "$FILE" ps -q api)"
test -n "$(docker compose -p "$PROJECT" -f "$FILE" ps -q worker)"
curl --fail --silent "$API/health/ready" >/dev/null
curl --fail --silent http://127.0.0.1:3310/login >/dev/null

EMAIL="compose-smoke-${PROJECT}@example.com"
REGISTER="$(api_call POST /auth/register "{\"email\":\"$EMAIL\",\"name\":\"Compose Smoke\",\"password\":\"compose-smoke-password-1!\",\"organizationName\":\"Compose Smoke $PROJECT\"}")"
TOKEN="$(json_field accessToken <<<"$REGISTER")"
ORGANIZATION_ID="$(json_field defaultOrganizationId <<<"$REGISTER")"

WORKFLOW="$(api_call POST /workflows '{"name":"RC1 functional compose smoke"}')"
WORKFLOW_ID="$(json_field id <<<"$WORKFLOW")"
VERSION_BODY='{"trigger":{"key":"webhook","name":"Webhook","type":"webhook_trigger","config":{}},"steps":[{"key":"persist","name":"Persist","type":"database_record","config":{"collection":"rc1_compose_smoke","data":{"completed":true}}}],"expressionMode":"strict","workflowDefinitionSchemaVersion":2,"graph":{"entryStepKey":"persist","edges":[],"terminalStepKeys":["persist"]}}'
VERSION="$(api_call POST "/workflows/$WORKFLOW_ID/versions" "$VERSION_BODY")"
VERSION_ID="$(json_field id <<<"$VERSION")"
api_call PATCH "/workflows/$WORKFLOW_ID/versions/$VERSION_ID/activate" >/dev/null
EXECUTION="$(api_call POST "/workflows/$WORKFLOW_ID/executions" '{"input":{"trigger":{"source":"compose-smoke"}},"confirmRealEffects":true}')"
EXECUTION_ID="$(json_field execution.id <<<"$EXECUTION")"

STATUS=""
DETAIL=""
for _ in $(seq 1 60); do
  DETAIL="$(api_call GET "/executions/$EXECUTION_ID")"
  STATUS="$(json_field status <<<"$DETAIL")"
  [[ "$STATUS" == "COMPLETED" ]] && break
  [[ "$STATUS" == "FAILED" || "$STATUS" == "CANCELLED" ]] && break
  sleep 1
done
[[ "$STATUS" == "COMPLETED" ]]
python3 -c 'import json,sys; d=json.load(sys.stdin); steps=d.get("steps") or d.get("stepExecutions") or []; assert any(s.get("status") == "COMPLETED" for s in steps), d' <<<"$DETAIL"

echo "production compose smoke functional: PASS execution=$EXECUTION_ID status=$STATUS"
cleanup
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
echo "production compose smoke cleanup: PASS project=$PROJECT"
