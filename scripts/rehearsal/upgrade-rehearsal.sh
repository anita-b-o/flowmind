#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
baseline_env="${1:-}"
rc_manifest="${2:-}"
staging_env="${3:-}"
if [[ -z "$baseline_env" || -z "$rc_manifest" || -z "$staging_env" ]]; then
  echo "Usage: $0 <baseline-release.env> <rc-manifest.json> <staging.env>" >&2
  exit 2
fi
: "${STAGING_SMOKE_ENV_FILE:?STAGING_SMOKE_ENV_FILE is required}"
set -a
# shellcheck disable=SC1090
source "$STAGING_SMOKE_ENV_FILE"
set +a

artifact_dir="${REHEARSAL_ARTIFACT_DIR:-$repo_dir/.artifacts/upgrade-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$artifact_dir"
chmod 700 "$artifact_dir"

RUN_ROLLBACK_SMOKE=false "$repo_dir/scripts/release/rollback-staging.sh" "$baseline_env" "$staging_env"
"$repo_dir/scripts/rehearsal/staging-smoke.sh"
node "$repo_dir/scripts/rehearsal/capture-staging-state.mjs" "$artifact_dir/before.json"

: "${BACKUP_ENV_FILE:?BACKUP_ENV_FILE is required}"
POSTGRES_BACKUP_ENV_FILE="$BACKUP_ENV_FILE" \
  FLOWMIND_RELEASE_VERSION=baseline \
  FLOWMIND_RELEASE_REVISION=e6d727955de9dedd86c9ebf1e05f0de71f3c7cd9 \
  "$repo_dir/scripts/rehearsal/backup-postgres.sh" >"$artifact_dir/backup-path.txt"

BACKUP_ENV_FILE="$BACKUP_ENV_FILE" "$repo_dir/scripts/release/deploy-staging.sh" "$rc_manifest" "$staging_env"
rc_version="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.version)' "$rc_manifest")"
"$repo_dir/scripts/rehearsal/run-acceptance.sh" \
  "$staging_env" \
  "${FLOWMIND_RELEASE_ROOT:-/opt/flowmind/releases}/$rc_version/release.env" \
  "$STAGING_SMOKE_ENV_FILE"
node "$repo_dir/scripts/rehearsal/capture-staging-state.mjs" "$artifact_dir/after.json"
node "$repo_dir/scripts/rehearsal/compare-staging-state.mjs" "$artifact_dir/before.json" "$artifact_dir/after.json"

echo "FlowMind upgrade rehearsal: PASS artifacts=$artifact_dir"
