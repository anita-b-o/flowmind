#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"

manifest="${1:-}"
go_record="${2:-}"
mode="${3:---check}"
if [[ -z "$manifest" || -z "$go_record" ]] ||
  [[ "$mode" != "--check" && "$mode" != "--create" ]]; then
  echo "Usage: $0 <release-manifest.json> <approved-go-record.md> [--check|--create]" >&2
  exit 2
fi

node "$repo_dir/scripts/release/validate-manifest.mjs" "$manifest" >/dev/null
node "$repo_dir/scripts/release/validate-go-record.mjs" "$manifest" "$go_record" >/dev/null

candidate_version="$(
  node -e 'const m=require(process.argv[1]); process.stdout.write(m.candidateVersion)' "$manifest"
)"
manifest_git_sha="$(
  node -e 'const m=require(process.argv[1]); process.stdout.write(m.gitSha)' "$manifest"
)"
current_git_sha="$(git rev-parse HEAD)"
tag="v$candidate_version"

if [[ "$current_git_sha" != "$manifest_git_sha" ]]; then
  echo "HEAD $current_git_sha does not match validated manifest Git SHA $manifest_git_sha" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Tag authorization requires a clean worktree" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "Tag $tag already exists" >&2
  exit 1
fi
set +e
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null
remote_tag_status=$?
set -e
if [[ "$remote_tag_status" -eq 0 ]]; then
  echo "Tag $tag already exists on origin" >&2
  exit 1
fi
if [[ "$remote_tag_status" -ne 2 ]]; then
  echo "Could not verify that tag $tag is absent on origin" >&2
  exit 1
fi

if [[ "$mode" == "--check" ]]; then
  echo "Tag authorization checks passed for $tag at $manifest_git_sha"
  echo "No tag was created and no image rebuild is required."
  exit 0
fi

git tag -a "$tag" "$manifest_git_sha" -m "FlowMind $tag"
echo "Created annotated tag $tag at $manifest_git_sha"
echo "No tag was pushed and no image was rebuilt."
