#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]]; then
  echo "Usage: $0 <version such as 0.1.0-rc.1>" >&2
  exit 2
fi

revision="$(git rev-parse HEAD)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
registry="${FLOWMIND_REGISTRY:-ghcr.io/anita-b-o}"
manifest_path="${RELEASE_MANIFEST_PATH:-$repo_dir/release-manifest.json}"
push_images="${PUSH_IMAGES:-true}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release images require a clean worktree" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT

services=(api worker web ai-service migrate)
dockerfiles=(
  infrastructure/docker/Dockerfile.api
  infrastructure/docker/Dockerfile.worker
  infrastructure/docker/Dockerfile.web
  infrastructure/docker/Dockerfile.ai
  infrastructure/docker/Dockerfile.migrate
)

for index in "${!services[@]}"; do
  service="${services[$index]}"
  repository="$registry/flowmind-$service"
  metadata="$temporary_dir/$service.json"
  output=(--push)
  if [[ "$push_images" != "true" ]]; then
    output=(--load)
  fi
  docker buildx build \
    --platform linux/amd64 \
    --file "${dockerfiles[$index]}" \
    --build-arg "BUILD_VERSION=$version" \
    --build-arg "BUILD_REVISION=$revision" \
    --build-arg "BUILD_CREATED=$created_at" \
    --tag "$repository:$version" \
    --tag "$repository:sha-$revision" \
    --metadata-file "$metadata" \
    "${output[@]}" \
    .

  digest="$(node -e 'const m=require(process.argv[1]); process.stdout.write(m["containerimage.digest"] ?? "")' "$metadata")"
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ && "$push_images" != "true" ]]; then
    digest="$(docker image inspect "$repository:$version" --format '{{.Id}}')"
  fi
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Could not resolve immutable digest for $service" >&2
    exit 1
  fi
  printf '%s\t%s\t%s\n' "$service" "$repository" "$digest" >>"$temporary_dir/images.tsv"
done

node - "$version" "$revision" "$created_at" "$temporary_dir/images.tsv" "$manifest_path" <<'NODE'
const fs = require("node:fs");
const [version, revision, createdAt, input, output] = process.argv.slice(2);
const images = {};
for (const line of fs.readFileSync(input, "utf8").trim().split("\n")) {
  const [service, repository, digest] = line.split("\t");
  images[service] = { repository, digest, ref: `${repository}@${digest}` };
}
fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, version, revision, createdAt, platform: "linux/amd64", images }, null, 2)}\n`);
NODE

node scripts/release/validate-manifest.mjs "$manifest_path" >/dev/null
echo "Release manifest created: $manifest_path"
