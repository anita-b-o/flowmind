#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

required_dockerignore_rules=(
  .git
  .env
  '**/.env'
  '.env.*'
  '**/.env.*'
  '**/.env.local'
  .npmrc
  '**/.npmrc'
  '*.key'
  '*.pem'
  .artifacts
  release-manifest.json
)

for rule in "${required_dockerignore_rules[@]}"; do
  if ! grep -Fxq "$rule" .dockerignore; then
    echo ".dockerignore must exclude potential secret or release artifact path: $rule" >&2
    exit 1
  fi
done

while IFS= read -r path; do
  case "$path" in
    .env.example | */.env.example | */staging.env.example)
      ;;
    .env | */.env | .env.* | */.env.* | .npmrc | */.npmrc | *.pem | */*.pem | *.key | */*.key)
      echo "Tracked potential secret file is not allowed in the release build context: $path" >&2
      exit 1
      ;;
  esac
done < <(git ls-files)

private_key_match="$(
  git grep -IlE \
    -e '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
    -- . \
    ':(exclude)**/*.spec.*' \
    ':(exclude)**/*.test.*' \
    ':(exclude)docs/**' \
    ':(exclude)scripts/release/validate-build-context.sh' |
    head -n 1 || true
)"
token_match="$(
  git grep -IlE \
    -e 'gh[pousr]_[A-Za-z0-9]{36,}' \
    -e 'github_pat_[A-Za-z0-9_]{40,}' \
    -e 'sk-(proj-)?[A-Za-z0-9_-]{32,}' \
    -- . \
    ':(exclude)scripts/release/validate-build-context.sh' |
    head -n 1 || true
)"
secret_match="${private_key_match:-$token_match}"
if [[ -n "$secret_match" ]]; then
  echo "Potential committed secret found; refusing release build: $secret_match" >&2
  exit 1
fi

echo "Release build context secret checks passed"
