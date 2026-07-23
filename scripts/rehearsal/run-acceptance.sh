#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging_env="${1:-}"
release_env="${2:-}"
smoke_env="${3:-}"
if [[ -z "$staging_env" || -z "$release_env" || -z "$smoke_env" ]]; then
  echo "Usage: $0 <staging.env> <release.env> <smoke.env>" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$smoke_env"
set +a

if [[ "${SKIP_PUBLIC_SMOKE:-false}" != "true" ]]; then
  "$repo_dir/scripts/rehearsal/staging-smoke.sh"
fi
"$repo_dir/scripts/rehearsal/ai-probe.sh" "$staging_env" "$release_env"
"$repo_dir/scripts/rehearsal/observability-check.sh" "$staging_env" "$release_env"
"$repo_dir/scripts/rehearsal/security-check.sh" "$staging_env" "$release_env"

release_dir="$(cd "$(dirname "$release_env")" && pwd)"
release_root="$(dirname "$release_dir")"
ln -sfn "$release_dir" "$release_root/current"
rm -f "$release_root/candidate"

echo "FlowMind staging acceptance: PASS"
