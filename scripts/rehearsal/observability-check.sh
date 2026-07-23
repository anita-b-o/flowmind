#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging_env="${1:-}"
release_env="${2:-}"
if [[ -z "$staging_env" || -z "$release_env" ]]; then
  echo "Usage: $0 <staging.env> <release.env>" >&2
  exit 2
fi

compose=(
  docker compose
  --project-name flowmind-staging
  --env-file "$staging_env"
  --env-file "$release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.yml"
)

sample_queries=(
  'up{service=~"api|worker|ai-service"}'
  'flowmind_execution_backlog'
  'flowmind_approval_backlog'
  'flowmind_notification_backlog'
  'flowmind_dead_letter_backlog'
  'flowmind_ai_requests_total'
)
metadata_metrics=(
  'flowmind_readiness_failures_total'
  'flowmind_notification_deliveries_total'
  'flowmind_step_retries_total'
  'flowmind_execution_lease_lost_total'
  'flowmind_workflow_executions_reconciled_total'
  'flowmind_reconciler_runs_total'
  'flowmind_internal_event_dispatch_failures_total'
  'flowmind_internal_event_chain_limit_exceeded_total'
)

for query in "${sample_queries[@]}"; do
  encoded="$(node -p 'encodeURIComponent(process.argv[1])' "$query")"
  result="$("${compose[@]}" exec -T prometheus wget -qO- "http://127.0.0.1:9090/api/v1/query?query=$encoded")"
  node -e 'const r=JSON.parse(process.argv[1]); if(r.status!=="success" || !r.data.result.length) process.exit(1)' "$result" || {
    echo "Missing or failed Prometheus query: $query" >&2
    exit 1
  }
done

for metric in "${metadata_metrics[@]}"; do
  result="$("${compose[@]}" exec -T prometheus wget -qO- "http://127.0.0.1:9090/api/v1/metadata?metric=$metric")"
  node -e 'const r=JSON.parse(process.argv[1]); if(r.status!=="success" || !r.data[process.argv[2]]?.length) process.exit(1)' "$result" "$metric" || {
    echo "Missing Prometheus metric metadata: $metric" >&2
    exit 1
  }
done

targets="$("${compose[@]}" exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets)"
node -e '
const response=JSON.parse(process.argv[1]);
const targets=response.data.activeTargets.filter((target)=>target.labels.job?.startsWith("flowmind-"));
if(targets.length !== 3 || targets.some((target)=>target.health !== "up")) process.exit(1);
' "$targets"

alert_payload="$(node -e '
const now = Date.now();
process.stdout.write(JSON.stringify([{
  labels: { alertname: "FlowmindRehearsal", severity: "warning", service: "release-rehearsal" },
  annotations: { summary: "Controlled RC staging alert routing test" },
  startsAt: new Date(now).toISOString(),
  endsAt: new Date(now + 300000).toISOString()
}]));
')"
"${compose[@]}" exec -T prometheus wget -qO- \
  --header='Content-Type: application/json' \
  --post-data="$alert_payload" \
  http://alertmanager:9093/api/v2/alerts >/dev/null
active_alerts="$("${compose[@]}" exec -T prometheus wget -qO- \
  'http://alertmanager:9093/api/v2/alerts?filter=alertname%3DFlowmindRehearsal')"
node -e '
const alerts=JSON.parse(process.argv[1]);
if(!alerts.some((alert)=>alert.labels?.alertname==="FlowmindRehearsal")) process.exit(1);
' "$active_alerts"

: "${ALERT_DELIVERY_VERIFICATION_HOOK:?ALERT_DELIVERY_VERIFICATION_HOOK is required to prove external alert delivery}"
if [[ ! -x "$ALERT_DELIVERY_VERIFICATION_HOOK" ]]; then
  echo "ALERT_DELIVERY_VERIFICATION_HOOK must be executable" >&2
  exit 1
fi
"$ALERT_DELIVERY_VERIFICATION_HOOK" FlowmindRehearsal

resolved_payload="$(node -e '
process.stdout.write(JSON.stringify([{
  labels: { alertname: "FlowmindRehearsal", severity: "warning", service: "release-rehearsal" },
  annotations: { summary: "Controlled RC staging alert routing test" },
  startsAt: new Date(Date.now() - 60000).toISOString(),
  endsAt: new Date().toISOString()
}]));
')"
"${compose[@]}" exec -T prometheus wget -qO- \
  --header='Content-Type: application/json' \
  --post-data="$resolved_payload" \
  http://alertmanager:9093/api/v2/alerts >/dev/null

echo "FlowMind observability validation: PASS"
