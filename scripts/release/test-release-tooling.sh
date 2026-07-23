#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
cleanup() { rm -rf "$temporary_dir"; }
trap cleanup EXIT

fail() {
  echo "Release tooling test failed: $*" >&2
  exit 1
}

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

test_repo="$temporary_dir/repository"
mkdir -p "$test_repo/scripts/release" "$test_repo/docs" "$test_repo/bin" "$test_repo/.artifacts"
cp "$repo_dir/scripts/release/build-and-push.sh" "$test_repo/scripts/release/"
cp "$repo_dir/scripts/release/create-rc-tag.sh" "$test_repo/scripts/release/"
cp "$repo_dir/scripts/release/manifest-to-env.mjs" "$test_repo/scripts/release/"
cp "$repo_dir/scripts/release/validate-build-context.sh" "$test_repo/scripts/release/"
cp "$repo_dir/scripts/release/validate-go-record.mjs" "$test_repo/scripts/release/"
cp "$repo_dir/scripts/release/validate-manifest.mjs" "$test_repo/scripts/release/"
cp "$repo_dir/docs/rc1-go-no-go.md" "$test_repo/docs/"
cp "$repo_dir/.dockerignore" "$test_repo/"

printf '%s\n' ".artifacts/" >"$test_repo/.gitignore"
printf '%s\n' "release tooling fixture" >"$test_repo/README.md"

cat >"$test_repo/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "buildx" && "${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "${1:-}" == "buildx" && "${2:-}" == "build" ]]; then
  metadata_file=""
  shift 2
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--metadata-file" ]]; then
      metadata_file="$2"
      shift 2
    else
      shift
    fi
  done
  printf '{"containerimage.digest":"sha256:%064d"}\n' 1 >"$metadata_file"
  exit 0
fi
echo "Unexpected docker invocation: $*" >&2
exit 1
DOCKER
chmod +x "$test_repo/bin/docker"

git -C "$test_repo" init -q
git -C "$test_repo" config user.name "FlowMind release test"
git -C "$test_repo" config user.email "release-test@flowmind.invalid"
git -C "$test_repo" add .
git -C "$test_repo" commit -qm "release test fixture"
git init --bare -q "$temporary_dir/origin.git"
git -C "$test_repo" remote add origin "$temporary_dir/origin.git"

git_sha="$(git -C "$test_repo" rev-parse HEAD)"
manifest="$test_repo/.artifacts/release-manifest.json"
PATH="$test_repo/bin:$PATH" \
  PUSH_IMAGES=false \
  RELEASE_MANIFEST_PATH="$manifest" \
  "$test_repo/scripts/release/build-and-push.sh" "0.1.0-rc.1" "$git_sha" >/dev/null

node "$test_repo/scripts/release/validate-manifest.mjs" "$manifest" >/dev/null
release_env="$(
  node "$test_repo/scripts/release/manifest-to-env.mjs" "$manifest"
)"
[[ "$(grep -c '^FLOWMIND_.*_IMAGE=.*@sha256:' <<<"$release_env")" -eq 5 ]] ||
  fail "manifest-to-env did not emit five digest-pinned images"
grep -Fxq "FLOWMIND_RELEASE_VERSION=0.1.0-rc.1" <<<"$release_env" ||
  fail "manifest-to-env emitted the wrong candidate version"
grep -Fxq "FLOWMIND_RELEASE_REVISION=$git_sha" <<<"$release_env" ||
  fail "manifest-to-env emitted the wrong Git SHA"

invalid_manifest="$test_repo/.artifacts/invalid-manifest.json"
node - "$manifest" "$invalid_manifest" <<'NODE'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
manifest.images.web.digest = "sha256:bad";
fs.writeFileSync(process.argv[3], JSON.stringify(manifest));
NODE
expect_failure node "$test_repo/scripts/release/validate-manifest.mjs" "$invalid_manifest"
expect_failure env \
  "PATH=$test_repo/bin:$PATH" \
  "PUSH_IMAGES=false" \
  "RELEASE_MANIFEST_PATH=$test_repo/.artifacts/wrong-sha.json" \
  "$test_repo/scripts/release/build-and-push.sh" \
  "0.1.0-rc.1" \
  "0000000000000000000000000000000000000000"

go_record="$test_repo/.artifacts/rc1-go-no-go.md"
node - "$test_repo/docs/rc1-go-no-go.md" "$manifest" "$go_record" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const template = fs.readFileSync(process.argv[2], "utf8");
const manifestBytes = fs.readFileSync(process.argv[3]);
const manifest = JSON.parse(manifestBytes);
const checksum = crypto.createHash("sha256").update(manifestBytes).digest("hex");
const decisionStart = template.indexOf("## Decision");
let gates = template.slice(0, decisionStart).replaceAll("- [ ]", "- [x]");
let decision = template.slice(decisionStart).replace("- [ ] GO", "- [x] GO");
gates = gates
  .replace("- Candidate version:", `- Candidate version: ${manifest.candidateVersion}`)
  .replace("- Git SHA:", `- Git SHA: ${manifest.gitSha}`)
  .replace("- Planned annotated tag:", `- Planned annotated tag: v${manifest.candidateVersion}`)
  .replace("- Release manifest SHA-256:", `- Release manifest SHA-256: ${checksum}`);
fs.writeFileSync(process.argv[4], `${gates}${decision}`);
NODE

node "$test_repo/scripts/release/validate-go-record.mjs" "$manifest" "$go_record" >/dev/null
(
  cd "$test_repo"
  scripts/release/create-rc-tag.sh "$manifest" "$go_record" --check >/dev/null
)
if git -C "$test_repo" show-ref --tags --quiet; then
  fail "tag validation created a tag"
fi

printf '%s\n' "dirty" >>"$test_repo/README.md"
expect_failure env \
  "PATH=$test_repo/bin:$PATH" \
  "PUSH_IMAGES=false" \
  "RELEASE_MANIFEST_PATH=$test_repo/.artifacts/dirty.json" \
  "$test_repo/scripts/release/build-and-push.sh" \
  "0.1.0-rc.1" \
  "$git_sha"

echo "Release tooling tests passed"
