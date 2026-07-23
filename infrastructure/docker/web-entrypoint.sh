#!/bin/sh
set -eu

runtime_url="${FLOWMIND_PUBLIC_API_URL:-${PUBLIC_API_URL:-}}"
if [ -z "$runtime_url" ]; then
  echo "FLOWMIND_PUBLIC_API_URL or PUBLIC_API_URL is required" >&2
  exit 1
fi

RUNTIME_CONFIG_PATH=/app/apps/web/public/runtime-config.js \
FLOWMIND_PUBLIC_API_URL="$runtime_url" \
node -e '
  const fs = require("node:fs");
  const target = process.env.RUNTIME_CONFIG_PATH;
  const config = { publicApiUrl: process.env.FLOWMIND_PUBLIC_API_URL };
  fs.writeFileSync(
    target,
    `window.__FLOWMIND_RUNTIME_CONFIG__ = ${JSON.stringify(config)};\n`,
    { mode: 0o644 }
  );
'

exec "$@"
