#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-plan}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Service credentials are accepted only through the guarded launcher.
unset DATABASE_URL REDIS_URL
credential_launcher="$repo_root/scripts/demo/run-with-demo-free-credentials.mjs"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

with_demo_free_credentials() {
  node "$credential_launcher" "$@"
}

with_demo_free_database() {
  node "$credential_launcher" --database-only "$@"
}

check_demo_free_credentials() {
  node "$credential_launcher" --check
}

working_tree_fingerprint() {
  {
    printf 'HEAD\0%s\0' "$(git rev-parse HEAD)"
    git diff --binary --no-ext-diff HEAD --
    while IFS= read -r -d '' path; do
      printf 'UNTRACKED\0%s\0' "$path"
      sha256sum -- "$path" | cut -d ' ' -f 1
    done < <(git ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
  } | sha256sum | cut -d ' ' -f 1
}

validation_identity() {
  if [[ -n "$(git status --porcelain)" ]]; then
    printf 'uncommitted:%s\n' "$(working_tree_fingerprint)"
  else
    printf 'commit:%s\n' "$(git rev-parse HEAD)"
  fi
}

print_plan() {
  cat <<PLAN
FlowMind demo-free deployment plan
  Git SHA:         ${FLOWMIND_DEPLOY_GIT_SHA:-not-set}
  Render service:  ${FLOWMIND_RENDER_SERVICE_ID:-not-set} (must already exist, plan free)
  Render region:   ${FLOWMIND_RENDER_REGION:-not-set}
  Vercel project:  ${FLOWMIND_VERCEL_PROJECT:-not-set} (must already exist, Hobby)
  API origin:      ${FLOWMIND_API_ORIGIN:-not-set}
  Web public API:  ${NEXT_PUBLIC_API_URL:-not-set}
  Database:        Neon pooled PostgreSQL/TLS; migrate deploy before application rollout
  Redis:           Upstash Redis TCP/TLS; eviction disabled
  Runtime:         API + Worker in apps/demo-runtime; embedded fake AI/email
  Remote creation: disabled; this tooling updates existing Render/Vercel resources only
PLAN
}

validate_local() {
  for name in FLOWMIND_UPSTASH_EVICTION_DISABLED; do
    require_env "$name"
  done
  [[ "${FLOWMIND_DEPLOYMENT_PROFILE:-}" == "demo-free" ]] || { echo "FLOWMIND_DEPLOYMENT_PROFILE must be demo-free" >&2; exit 1; }
  [[ "${FLOWMIND_AI_MODE:-}" == "embedded-fake" ]] || { echo "FLOWMIND_AI_MODE must be embedded-fake" >&2; exit 1; }
  [[ "${FLOWMIND_EMAIL_MODE:-}" == "embedded-fake" ]] || { echo "FLOWMIND_EMAIL_MODE must be embedded-fake" >&2; exit 1; }
  [[ "${FLOWMIND_UPSTASH_EVICTION_DISABLED:-}" == "true" ]] || { echo "Confirm Upstash eviction is disabled" >&2; exit 1; }

  echo "Validation identity: $(validation_identity)"
  echo "Validation mode permits an uncommitted worktree and can never deploy."
  check_demo_free_credentials
  migration_count="$(find apps/api/prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [[ "$migration_count" == "26" ]] || { echo "Expected 26 migrations, found $migration_count" >&2; exit 1; }
  with_demo_free_database \
    corepack pnpm --filter @automation/api prisma:demo-free-preflight-history

  corepack pnpm --filter @automation/demo-runtime... build
  env -u DATABASE_URL -u REDIS_URL \
    docker build -f infrastructure/docker/Dockerfile.demo-free -t flowmind-demo-free:validation .
  image_size="$(env -u DATABASE_URL -u REDIS_URL docker image inspect flowmind-demo-free:validation --format '{{.Size}}')"
  (( image_size <= 1610612736 )) || { echo "Demo image exceeds 1.5 GiB" >&2; exit 1; }
  echo "demo-free local validation passed"
}

preflight() {
  for name in \
    FLOWMIND_DEPLOY_GIT_SHA FLOWMIND_RENDER_SERVICE_ID \
    FLOWMIND_RENDER_REGION FLOWMIND_RENDER_PLAN \
    FLOWMIND_VERCEL_PROJECT FLOWMIND_API_ORIGIN NEXT_PUBLIC_API_URL \
    FLOWMIND_MEMORY_GATE_APPROVED_SHA RENDER_API_KEY VERCEL_TOKEN \
    VERCEL_ORG_ID VERCEL_PROJECT_ID; do
    require_env "$name"
  done
  [[ "$FLOWMIND_RENDER_PLAN" == "free" ]] || { echo "Render plan assertion must be exactly free" >&2; exit 1; }
  [[ "${FLOWMIND_VERCEL_PLAN:-}" == "hobby" ]] || { echo "Vercel plan assertion must be hobby" >&2; exit 1; }

  current_sha="$(git rev-parse HEAD)"
  [[ -z "$(git status --porcelain)" ]] || { echo "Deployment mode requires a clean worktree" >&2; exit 1; }
  [[ "$current_sha" == "$FLOWMIND_DEPLOY_GIT_SHA" ]] || { echo "FLOWMIND_DEPLOY_GIT_SHA does not match HEAD" >&2; exit 1; }
  [[ "$current_sha" == "$FLOWMIND_MEMORY_GATE_APPROVED_SHA" ]] || { echo "Memory gate was not approved for this exact SHA" >&2; exit 1; }

  command -v render >/dev/null || { echo "Render CLI is required" >&2; exit 1; }
  command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
  command -v vercel >/dev/null || { echo "Vercel CLI is required" >&2; exit 1; }
  command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }
  validate_local

  service_json="$(mktemp)"
  trap 'rm -f "$service_json"' RETURN
  curl --fail --silent --show-error \
    --header "Accept: application/json" \
    --header "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$FLOWMIND_RENDER_SERVICE_ID" \
    >"$service_json"
  node --input-type=module - "$service_json" <<'NODE'
import { readFile } from "node:fs/promises";

const service = JSON.parse(await readFile(process.argv[2], "utf8"));
const details = service.serviceDetails;
const docker = details?.envSpecificDetails;
const fail = (message) => {
  throw new Error(`Render preflight: ${message}`);
};
const expect = (condition, message) => {
  if (!condition) fail(message);
};
const normalizeOrigin = (value) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    fail(`${value} must be an HTTPS origin without a path, query, or fragment`);
  }
  return url.origin;
};
const normalizeRepoPath = (value) => String(value ?? "").replace(/^\.\//, "");

expect(service.id === process.env.FLOWMIND_RENDER_SERVICE_ID, "service ID does not match");
expect(service.type === "web_service", `expected web_service, found ${service.type ?? "not reported"}`);
expect(service.autoDeploy === "no", `auto-deploy must be off, found ${service.autoDeploy ?? "not reported"}`);
expect(service.rootDir === "", `root directory must be the repository root, found ${service.rootDir ?? "not reported"}`);
expect(details && typeof details === "object", "web service details were not reported");
expect(details.plan === "free", `expected plan free, found ${details.plan ?? "not reported"}`);
expect(details.runtime === "docker", `expected Docker runtime, found ${details.runtime ?? "not reported"}`);
expect(details.region === process.env.FLOWMIND_RENDER_REGION, `region must be ${process.env.FLOWMIND_RENDER_REGION}, found ${details.region ?? "not reported"}`);
expect(details.numInstances === 1, `expected one instance, found ${details.numInstances ?? "not reported"}`);
expect(details.healthCheckPath === "/health/ready", `health check must be /health/ready, found ${details.healthCheckPath ?? "not reported"}`);
expect((details.maxShutdownDelaySeconds ?? 30) === 30, `shutdown delay must be 30 seconds, found ${details.maxShutdownDelaySeconds}`);
expect(!details.disk, "persistent disks are not allowed");
expect((details.previews?.generation ?? "off") === "off", "pull request previews must be disabled");
expect(docker && typeof docker === "object", "Docker configuration was not reported");
expect(normalizeRepoPath(docker.dockerfilePath) === "infrastructure/docker/Dockerfile.demo-free", `unexpected Dockerfile path: ${docker.dockerfilePath ?? "not reported"}`);
expect(docker.dockerContext === ".", `Docker context must be '.', found ${docker.dockerContext ?? "not reported"}`);
expect(!docker.preDeployCommand, "pre-deploy command must be empty");
expect(
  normalizeOrigin(details.url) === normalizeOrigin(process.env.FLOWMIND_API_ORIGIN),
  "service URL does not match FLOWMIND_API_ORIGIN"
);
NODE
  vercel whoami --token "$VERCEL_TOKEN" >/dev/null
  vercel project inspect "$FLOWMIND_VERCEL_PROJECT" --token "$VERCEL_TOKEN" >/dev/null

  echo "demo-free preflight passed"
}

runtime_gate() {
  check_demo_free_credentials
  with_demo_free_credentials node scripts/demo/run-real-runtime-gate.mjs
}

apply_deployment() {
  [[ "${FLOWMIND_SECOND_GATE_APPROVED:-}" == "DEPLOY_FLOWMIND_DEMO_FREE" ]] || {
    echo "Set FLOWMIND_SECOND_GATE_APPROVED=DEPLOY_FLOWMIND_DEMO_FREE after reviewing the plan" >&2
    exit 1
  }
  preflight
  with_demo_free_database corepack pnpm --filter @automation/api prisma:deploy
  with_demo_free_database \
    corepack pnpm --filter @automation/api prisma:demo-free-verify-history
  with_demo_free_database node scripts/demo/seed-demo.mjs

  render deploys create "$FLOWMIND_RENDER_SERVICE_ID" \
    --commit "$FLOWMIND_DEPLOY_GIT_SHA" \
    --wait \
    --confirm
  (
    cd apps/web
    vercel deploy --prod --yes \
      --token "$VERCEL_TOKEN" \
      --project "$FLOWMIND_VERCEL_PROJECT"
  )
  echo "Deployment submitted. Verify /health/ready and run the documented smoke suite."
}

case "$command_name" in
  plan) print_plan ;;
  validate) validate_local ;;
  runtime-gate) runtime_gate ;;
  preflight) preflight ;;
  apply) apply_deployment ;;
  *) echo "Usage: $0 plan|validate|runtime-gate|preflight|apply" >&2; exit 2 ;;
esac
