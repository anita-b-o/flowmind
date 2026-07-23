#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_env="${POSTGRES_BACKUP_ENV_FILE:-}"
if [[ -z "$backup_env" || ! -f "$backup_env" ]]; then
  echo "POSTGRES_BACKUP_ENV_FILE must reference a root-only PG* env file" >&2
  exit 2
fi
: "${POSTGRES_BACKUP_IMAGE:?POSTGRES_BACKUP_IMAGE must be pinned by digest}"

output_dir="${BACKUP_OUTPUT_DIR:-$repo_dir/.artifacts/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="flowmind-staging-$timestamp"
mkdir -p "$output_dir"
chmod 700 "$output_dir"

docker run --rm \
  --env-file "$backup_env" \
  --mount "type=bind,src=$output_dir,dst=/backup" \
  "$POSTGRES_BACKUP_IMAGE" \
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    --file="/backup/$name.dump"

test -s "$output_dir/$name.dump"
docker run --rm \
  --mount "type=bind,src=$output_dir,dst=/backup,readonly" \
  "$POSTGRES_BACKUP_IMAGE" \
  pg_restore --list "/backup/$name.dump" >/dev/null

sha256sum "$output_dir/$name.dump" >"$output_dir/$name.dump.sha256"
node - "$output_dir/$name.manifest.json" "$timestamp" "$name.dump" "$output_dir/$name.dump.sha256" <<'NODE'
const fs = require("node:fs");
const [output, timestamp, filename, checksumPath] = process.argv.slice(2);
const checksum = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
const manifest = {
  schemaVersion: 1,
  environment: "staging",
  timestamp,
  filename,
  releaseVersion: process.env.FLOWMIND_RELEASE_VERSION ?? "unknown",
  releaseRevision: process.env.FLOWMIND_RELEASE_REVISION ?? "unknown",
  migrationStatus: process.env.FLOWMIND_MIGRATION_STATUS ?? "not_recorded",
  sha256: checksum,
  integrity: "pg_restore_list_and_sha256"
};
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE

if [[ -n "${BACKUP_UPLOAD_HOOK:-}" ]]; then
  if [[ ! -x "$BACKUP_UPLOAD_HOOK" ]]; then
    echo "BACKUP_UPLOAD_HOOK must be an executable root-owned upload/verification hook" >&2
    exit 1
  fi
  BACKUP_FILE="$output_dir/$name.dump" \
  BACKUP_CHECKSUM_FILE="$output_dir/$name.dump.sha256" \
  BACKUP_MANIFEST_FILE="$output_dir/$name.manifest.json" \
    "$BACKUP_UPLOAD_HOOK"
fi

echo "$output_dir/$name.dump"
