#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="${1:-}"
staging_env="${2:-}"
if [[ -z "$manifest" || -z "$staging_env" ]]; then
  echo "Usage: $0 <release-manifest.json> <staging.env>" >&2
  exit 2
fi

node "$repo_dir/scripts/release/validate-manifest.mjs" "$manifest" >/dev/null
version="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.version)' "$manifest")"
release_root="${FLOWMIND_RELEASE_ROOT:-/opt/flowmind/releases}"
release_dir="$release_root/$version"
mkdir -p "$release_dir"
release_env="$release_dir/release.env"
if [[ -f "$release_dir/release-manifest.json" ]] && ! cmp -s "$manifest" "$release_dir/release-manifest.json"; then
  echo "Release version $version already exists with a different manifest" >&2
  exit 1
fi
node "$repo_dir/scripts/release/manifest-to-env.mjs" "$manifest" >"$release_env"
chmod 600 "$release_env"
if [[ ! -f "$release_dir/release-manifest.json" ]]; then
  cp "$manifest" "$release_dir/release-manifest.json"
fi

exec 9>"${FLOWMIND_DEPLOY_LOCK:-/var/lock/flowmind-staging-deploy.lock}"
if ! flock -n 9; then
  echo "Another FlowMind staging deployment is active" >&2
  exit 1
fi

previous_release_env=""
if [[ -L "$release_root/current" ]]; then
  current_release_dir="$(readlink -f "$release_root/current")"
  if [[ -f "$current_release_dir/release.env" ]]; then
    previous_release_env="$current_release_dir/release.env"
  fi
fi
application_rollout_started=false

rollback_partial_rollout() {
  local status=$?
  trap - ERR
  if [[ "$application_rollout_started" == "true" && -n "$previous_release_env" ]]; then
    echo "Deployment failed after application rollout started; restoring the current application manifest" >&2
    local previous_compose=(
      docker compose
      --project-name flowmind-staging
      --env-file "$staging_env"
      --env-file "$previous_release_env"
      --file "$repo_dir/docker-compose.production.yml"
      --file "$repo_dir/infrastructure/staging/docker-compose.yml"
    )
    set +e
    local rollback_failed=false
    for service in ai-service api worker web caddy; do
      "${previous_compose[@]}" up -d --wait --force-recreate "$service" || rollback_failed=true
    done
    set -e
    if [[ "$rollback_failed" == "true" ]]; then
      echo "Automatic application rollback failed; staging requires operator intervention" >&2
    else
      echo "Previous application manifest restored; database migrations were not reversed" >&2
    fi
  elif [[ "$application_rollout_started" == "true" ]]; then
    echo "Deployment failed and no accepted baseline manifest exists for automatic rollback" >&2
  fi
  exit "$status"
}
trap rollback_partial_rollout ERR

compose=(
  docker compose
  --project-name flowmind-staging
  --env-file "$staging_env"
  --env-file "$release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.yml"
)

while IFS='=' read -r key image; do
  [[ "$key" == FLOWMIND_*_IMAGE ]] || continue
  docker pull "$image"
done <"$release_env"

migration_status_before="pending_or_requires_deploy"
if "${compose[@]}" --profile ops run --rm migrate \
  corepack pnpm --filter @automation/api exec prisma migrate status --schema prisma/schema.prisma; then
  migration_status_before="up_to_date"
fi

if [[ "${SKIP_PREDEPLOY_BACKUP:-false}" != "true" ]]; then
  : "${BACKUP_ENV_FILE:?BACKUP_ENV_FILE is required unless SKIP_PREDEPLOY_BACKUP=true}"
  : "${BACKUP_UPLOAD_HOOK:?BACKUP_UPLOAD_HOOK is required for a staging deployment backup}"
  POSTGRES_BACKUP_ENV_FILE="$BACKUP_ENV_FILE" \
    FLOWMIND_RELEASE_VERSION="$version" \
    FLOWMIND_RELEASE_REVISION="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.revision)' "$manifest")" \
    FLOWMIND_MIGRATION_STATUS="$migration_status_before" \
    "$repo_dir/scripts/rehearsal/backup-postgres.sh"
fi

migration_marker="$release_dir/migration.ok"
if [[ ! -f "$migration_marker" ]]; then
  "${compose[@]}" --profile ops run --rm migrate
  "${compose[@]}" --profile ops run --rm migrate \
    corepack pnpm --filter @automation/api exec prisma migrate status --schema prisma/schema.prisma
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$migration_marker"
fi

application_rollout_started=true
for service in ai-service api worker web caddy prometheus alertmanager; do
  "${compose[@]}" up -d --wait "$service"
done
application_rollout_started=false
trap - ERR

ln -sfn "$release_dir" "$release_root/candidate"
echo "FlowMind staging candidate deployed and ready for acceptance: $version"
