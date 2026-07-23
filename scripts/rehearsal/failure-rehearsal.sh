#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scenario="${1:-}"
staging_env="${2:-}"
release_env="${3:-}"
if [[ -z "$scenario" || -z "$staging_env" || -z "$release_env" ]]; then
  echo "Usage: $0 <migration|api-restart|worker-restart|readiness|partial|redis-outage> <staging.env> <release.env>" >&2
  exit 2
fi
if [[ "${ALLOW_STAGING_FAILURE_REHEARSAL:-}" != "yes" ]]; then
  echo "Set ALLOW_STAGING_FAILURE_REHEARSAL=yes to acknowledge staging disruption" >&2
  exit 1
fi

compose=(
  docker compose
  --project-name flowmind-staging
  --env-file "$staging_env"
  --env-file "$release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.yml"
)

restore_baseline() {
  : "${BASELINE_RELEASE_ENV:?BASELINE_RELEASE_ENV is required for this scenario}"
  RUN_ROLLBACK_SMOKE=false \
    "$repo_dir/scripts/release/rollback-staging.sh" "$BASELINE_RELEASE_ENV" "$staging_env"
}

case "$scenario" in
  migration)
    if DATABASE_URL=postgresql://invalid:invalid@127.0.0.1:1/invalid \
      "${compose[@]}" --profile ops run --rm migrate; then
      echo "Migration failure rehearsal unexpectedly succeeded" >&2
      exit 1
    fi
    "${compose[@]}" ps api | grep -q "Up"
    ;;
  api-restart)
    "${compose[@]}" kill --signal SIGTERM api
    "${compose[@]}" up -d --wait api
    curl --fail --silent "${STAGING_API_URL:?STAGING_API_URL is required}/health/ready" >/dev/null
    ;;
  worker-restart)
    "${compose[@]}" kill --signal SIGTERM worker
    "${compose[@]}" up -d --wait worker
    ;;
  readiness)
    restore_baseline
    if REDIS_URL=redis://127.0.0.1:1 "${compose[@]}" up -d --wait --force-recreate api; then
      echo "Readiness failure rehearsal unexpectedly succeeded" >&2
      exit 1
    fi
    restore_baseline
    ;;
  partial)
    restore_baseline
    "${compose[@]}" up -d --wait ai-service api
    if FLOWMIND_WORKER_IMAGE=ghcr.io/anita-b-o/flowmind-worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
      "${compose[@]}" up -d --wait worker; then
      echo "Partial deployment rehearsal unexpectedly succeeded" >&2
      exit 1
    fi
    restore_baseline
    ;;
  redis-outage)
    : "${REDIS_OUTAGE_COMMAND:?REDIS_OUTAGE_COMMAND must revoke only staging VM to staging Redis access}"
    : "${REDIS_RECOVERY_COMMAND:?REDIS_RECOVERY_COMMAND must restore that exact access}"
    cleanup_redis() { bash -Eeuo pipefail -c "$REDIS_RECOVERY_COMMAND"; }
    trap cleanup_redis EXIT INT TERM
    bash -Eeuo pipefail -c "$REDIS_OUTAGE_COMMAND"
    if curl --fail --silent "${STAGING_API_URL:?STAGING_API_URL is required}/health/ready" >/dev/null; then
      echo "API remained ready while Redis was unavailable" >&2
      exit 1
    fi
    cleanup_redis
    trap - EXIT INT TERM
    "${compose[@]}" up -d --wait api worker
    ;;
  *)
    echo "Unknown failure rehearsal scenario: $scenario" >&2
    exit 2
    ;;
esac

echo "FlowMind failure rehearsal $scenario: PASS"
