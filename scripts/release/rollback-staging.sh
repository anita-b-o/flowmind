#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
previous_release_env="${1:-}"
staging_env="${2:-}"
if [[ -z "$previous_release_env" || -z "$staging_env" ]]; then
  echo "Usage: $0 <previous-release.env> <staging.env>" >&2
  exit 2
fi

exec 9>"${FLOWMIND_DEPLOY_LOCK:-/var/lock/flowmind-staging-deploy.lock}"
flock -n 9 || { echo "Another FlowMind staging operation is active" >&2; exit 1; }

compose=(
  docker compose
  --project-name flowmind-staging
  --env-file "$staging_env"
  --env-file "$previous_release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.yml"
)

for service in ai-service api worker web caddy; do
  "${compose[@]}" up -d --wait --force-recreate "$service"
done

if [[ "${RUN_ROLLBACK_SMOKE:-true}" == "true" ]]; then
  : "${STAGING_SMOKE_ENV_FILE:?STAGING_SMOKE_ENV_FILE is required when RUN_ROLLBACK_SMOKE=true}"
  set -a
  # shellcheck disable=SC1090
  source "$STAGING_SMOKE_ENV_FILE"
  set +a
  "$repo_dir/scripts/rehearsal/staging-smoke.sh"
fi
release_dir="$(cd "$(dirname "$previous_release_env")" && pwd)"
release_root="$(dirname "$release_dir")"
ln -sfn "$release_dir" "$release_root/current"
rm -f "$release_root/candidate"
echo "Application rollback completed; database migrations were not reversed"
