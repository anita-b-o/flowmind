#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/infrastructure/chaos/docker-compose.yml"
project="flowmind-rc1-chaos-${$}"
export CHAOS_COMPOSE_FILE="$compose_file"
export CHAOS_COMPOSE_PROJECT="$project"
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${CHAOS_POSTGRES_PORT:-55432}/flowmind_chaos"
export REDIS_URL="redis://127.0.0.1:${CHAOS_REDIS_PORT:-56379}"

cleanup() { docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker compose -p "$project" -f "$compose_file" up -d --wait
corepack pnpm --filter @automation/api prisma:deploy
corepack pnpm --filter @automation/worker exec jest --runInBand --testRegex 'src/reliability/chaos\.e2e-spec\.ts$'
