#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
staging_env="${1:-}"
release_env="${2:-}"
if [[ -z "$staging_env" || -z "$release_env" ]]; then
  echo "Usage: $0 <staging.env> <release.env>" >&2
  exit 2
fi
: "${STAGING_WEB_URL:?STAGING_WEB_URL is required}"
: "${STAGING_API_URL:?STAGING_API_URL is required}"
: "${STAGING_SMOKE_EMAIL:?STAGING_SMOKE_EMAIL is required}"
: "${STAGING_SMOKE_PASSWORD:?STAGING_SMOKE_PASSWORD is required}"

headers="$(mktemp)"
logs="$(mktemp)"
cleanup() { rm -f "$headers" "$logs"; }
trap cleanup EXIT

curl --fail --silent --show-error --dump-header "$headers" --output /dev/null "$STAGING_WEB_URL/login"
grep -qi '^strict-transport-security:.*max-age=' "$headers"

for https_url in "$STAGING_WEB_URL/login" "$STAGING_API_URL/health"; do
  http_url="http://${https_url#https://}"
  redirect_headers="$(curl --silent --dump-header - --output /dev/null "$http_url")"
  grep -Eqi '^HTTP/[^ ]+ (301|308)' <<<"$redirect_headers"
  grep -Eqi '^location: https://' <<<"$redirect_headers"
done

for path in /docs; do
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$STAGING_API_URL$path")"
  [[ "$status" == "404" ]] || { echo "$path must return 404, got $status" >&2; exit 1; }
done

cors_headers="$(curl --silent --dump-header - --output /dev/null -H 'Origin: https://evil.example.invalid' "$STAGING_API_URL/health")"
if grep -qi '^access-control-allow-origin: https://evil.example.invalid' <<<"$cors_headers"; then
  echo "Unexpected permissive CORS response" >&2
  exit 1
fi
allowed_cors_headers="$(curl --silent --dump-header - --output /dev/null -H "Origin: $STAGING_WEB_URL" "$STAGING_API_URL/health")"
grep -Fqi "access-control-allow-origin: $STAGING_WEB_URL" <<<"$allowed_cors_headers"

login_headers="$(curl --silent --dump-header - --output /dev/null \
  -H 'content-type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({email:process.env.STAGING_SMOKE_EMAIL,password:process.env.STAGING_SMOKE_PASSWORD}))')" \
  "$STAGING_API_URL/auth/login")"
grep -Eqi '^set-cookie:.*HttpOnly' <<<"$login_headers"
grep -Eqi '^set-cookie:.*Secure' <<<"$login_headers"
grep -Eqi '^set-cookie:.*SameSite=Lax' <<<"$login_headers"
grep -Eqi '^set-cookie:.*Path=/auth' <<<"$login_headers"

compose=(
  docker compose
  --project-name flowmind-staging
  --env-file "$staging_env"
  --env-file "$release_env"
  --file "$repo_dir/docker-compose.production.yml"
  --file "$repo_dir/infrastructure/staging/docker-compose.yml"
)

"${compose[@]}" exec -T ai-service python -c '
import urllib.error, urllib.request
for path in ("/docs", "/openapi.json"):
    try:
        urllib.request.urlopen("http://127.0.0.1:8000" + path)
        raise SystemExit(path + " unexpectedly enabled")
    except urllib.error.HTTPError as error:
        assert error.code == 404, (path, error.code)
'

"${compose[@]}" logs --no-color >"$logs"
node - "$staging_env" "$logs" <<'NODE'
const fs = require("node:fs");
const [envPath, logPath] = process.argv.slice(2);
const logs = fs.readFileSync(logPath, "utf8");
const sensitiveNames = /^(JWT_.*SECRET|SESSION_IP_HASH_PEPPER|SECRET_ENCRYPTION_KEY|CONNECTION_ENCRYPTION_KEY|AI_SERVICE_API_KEY|WEBHOOK_TOKEN_PEPPER|METRICS_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/;
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  const name = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (sensitiveNames.test(name) && value.length >= 8 && logs.includes(value)) {
    throw new Error(`Secret fingerprint found in logs: ${name}`);
  }
}
NODE

while IFS='=' read -r key image; do
  [[ "$key" == FLOWMIND_*_IMAGE ]] || continue
  if docker history --no-trunc "$image" | rg -qi 'JWT_ACCESS_SECRET=|OPENAI_API_KEY=|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'; then
    echo "Potential secret embedded in image history: $key" >&2
    exit 1
  fi
  if docker run --rm --entrypoint sh "$image" -c \
    "find /app -type f \\( -name .env -o -name .env.local -o -name .env.production \\) -print -quit | grep -q ."; then
    echo "Runtime environment file embedded in image: $key" >&2
    exit 1
  fi
done <"$release_env"

node "$repo_dir/scripts/rehearsal/rate-limit-check.mjs"

echo "FlowMind staging security validation: PASS"
