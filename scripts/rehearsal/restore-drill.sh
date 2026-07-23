#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dump_file="${1:-}"
restore_env="${2:-}"
release_env="${3:-}"
if [[ -z "$dump_file" || -z "$restore_env" || -z "$release_env" ]]; then
  echo "Usage: $0 <backup.dump> <restore.env> <release.env>" >&2
  exit 2
fi
: "${POSTGRES_BACKUP_IMAGE:?POSTGRES_BACKUP_IMAGE must be pinned by digest}"

checksum_file="$dump_file.sha256"
if [[ -f "$checksum_file" ]]; then
  (cd "$(dirname "$dump_file")" && sha256sum --check "$(basename "$checksum_file")")
fi

dump_dir="$(cd "$(dirname "$dump_file")" && pwd)"
dump_name="$(basename "$dump_file")"
docker run --rm --mount "type=bind,src=$dump_dir,dst=/backup,readonly" \
  "$POSTGRES_BACKUP_IMAGE" pg_restore --list "/backup/$dump_name" >/dev/null

table_count="$(docker run --rm --env-file "$restore_env" "$POSTGRES_BACKUP_IMAGE" \
  psql --tuples-only --no-align --command "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
if [[ "$table_count" != "0" ]]; then
  echo "Restore target is not a clean database" >&2
  exit 1
fi

docker run --rm \
  --env-file "$restore_env" \
  --mount "type=bind,src=$dump_dir,dst=/backup,readonly" \
  "$POSTGRES_BACKUP_IMAGE" \
  sh -eu -c 'exec pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$PGDATABASE" "$1"' \
  sh "/backup/$dump_name"

project="${RESTORE_PROJECT:-flowmind-restore-drill}"
compose=(
  docker compose
  --project-name "$project"
  --env-file "$restore_env"
  --env-file "$release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.restore.yml"
)
"${compose[@]}" --profile ops run --rm migrate \
  corepack pnpm --filter @automation/api exec prisma migrate status --schema prisma/schema.prisma
"${compose[@]}" --profile ops run --rm migrate
"${compose[@]}" up -d --wait ai-service api worker web

if [[ "${RUN_RESTORE_SMOKE:-true}" == "true" ]]; then
  : "${RESTORE_SMOKE_ENV_FILE:?RESTORE_SMOKE_ENV_FILE is required when RUN_RESTORE_SMOKE=true}"
  set -a
  # shellcheck disable=SC1090
  source "$RESTORE_SMOKE_ENV_FILE"
  set +a
  "$repo_dir/scripts/rehearsal/staging-smoke.sh"
fi

if [[ "${KEEP_RESTORE_STACK:-false}" != "true" ]]; then
  "${compose[@]}" down --remove-orphans
fi
echo "Restore drill completed without modifying the source staging database"
