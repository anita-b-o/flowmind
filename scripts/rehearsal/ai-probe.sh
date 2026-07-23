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

"${compose[@]}" exec -T ai-service python -c '
import json, os, urllib.error, urllib.request

url = "http://127.0.0.1:8000/evaluate"
payload = json.dumps({"dataset": "rc-staging-provider-probe"}).encode()
try:
    urllib.request.urlopen(urllib.request.Request(url, data=payload, headers={"content-type": "application/json"}))
    raise SystemExit("AI request without service key unexpectedly succeeded")
except urllib.error.HTTPError as error:
    assert error.code == 401, error.code

request = urllib.request.Request(
    url,
    data=payload,
    headers={
        "content-type": "application/json",
        "x-service-api-key": os.environ["AI_SERVICE_API_KEY"],
    },
)
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)
    assert isinstance(result["passed"], bool), result
'

echo "FlowMind AI provider probe: PASS"
