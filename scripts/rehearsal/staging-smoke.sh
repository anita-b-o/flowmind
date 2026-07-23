#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${STAGING_WEB_URL:?STAGING_WEB_URL is required}"
: "${STAGING_API_URL:?STAGING_API_URL is required}"
: "${STAGING_SMOKE_EMAIL:?STAGING_SMOKE_EMAIL is required}"
: "${STAGING_SMOKE_PASSWORD:?STAGING_SMOKE_PASSWORD is required}"

mkdir -p "$repo_dir/.artifacts"
corepack pnpm --filter @automation/web exec playwright test \
  --config playwright.staging.config.ts

curl --fail --silent --show-error "$STAGING_API_URL/health/ready" >/dev/null
curl --fail --silent --show-error "$STAGING_WEB_URL/login" >/dev/null
curl --fail --silent --show-error "$STAGING_API_URL/docs" --output /dev/null && {
  echo "API Swagger must be disabled in staging" >&2
  exit 1
}

node "$repo_dir/scripts/rehearsal/rbac-check.mjs"

echo "FlowMind staging smoke: PASS"
