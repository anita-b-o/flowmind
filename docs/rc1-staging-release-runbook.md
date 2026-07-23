# RC1 staging and release rehearsal

## Environment contract

Staging is one Linux amd64 VM running the application, Caddy, Prometheus, and
Alertmanager. PostgreSQL 16, Redis 7, SMTP sandbox, and S3-compatible backup
storage are separate staging-only services.

Required public origins:

- `https://staging.<domain>` for Web;
- `https://api.staging.<domain>` for API and webhooks.

Never reuse production databases, Redis, secrets, DNS names, buckets, SMTP
credentials, or provider credentials. Use `NODE_ENV=production` and
`ENVIRONMENT=production` so staging exercises production security behavior.

Before the first deploy, prepare:

1. `/opt/flowmind/config/staging.env`, mode `0600`, based on
   `infrastructure/staging/staging.env.example`.
2. `/opt/flowmind/config/backup.env`, mode `0600`, containing only `PGHOST`,
   `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE=require`.
3. `/opt/flowmind/config/smoke.env`, mode `0600`, containing
   `STAGING_WEB_URL`, `STAGING_API_URL`, canary credentials, and the required
   owner/admin/editor/viewer RBAC fixture credentials and organization ID.
4. `/opt/flowmind/secrets/metrics_api_key`, mode `0600`, with the same metrics
   key supplied to the application.
5. A real Alertmanager config outside the repository.
6. A root-owned executable backup upload/download-check hook and a root-owned
   alert-delivery verification hook.
7. Docker login to GHCR using a read-only package token.

## Release identity and build

The RC is an annotated Git tag such as `v0.1.0-rc.1`. Its commit SHA and the
five image digests are the release identity. Package versions remain `0.1.0`
because this is a private monorepo; the RC version belongs to the release
manifest and OCI labels.

The GitHub workflow validates the annotated tag, runs the full quality gate,
builds all images once for `linux/amd64`, pushes the RC/SHA tags, resolves
digests, and stores the manifest for 90 days. Deployments and production
promotion consume `repository@sha256:digest`; tags are informational.

The Web image has no environment-specific URL at build time.
`web-entrypoint.sh` writes the public API URL to `runtime-config.js` at startup,
so the same Web digest is promotable without a rebuild.

## Deployment

Run on the staging VM:

```sh
BACKUP_ENV_FILE=/opt/flowmind/config/backup.env \
POSTGRES_BACKUP_IMAGE=postgres:16-alpine@sha256:<approved-digest> \
scripts/release/deploy-staging.sh \
  /tmp/release-manifest.json \
  /opt/flowmind/config/staging.env
```

The deployment:

1. validates the manifest and image set;
2. acquires `/var/lock/flowmind-staging-deploy.lock`;
3. pulls all application digests;
4. takes and validates a pre-deploy backup;
5. runs migration status, migrate deploy, and status again;
6. writes the migration marker only after success;
7. deploys AI, API, Worker, Web, Caddy, Prometheus, and Alertmanager in order;
8. records `/opt/flowmind/releases/candidate` after every readiness gate.

No service automatically runs migrations during normal `compose up`.
Migration failure leaves the existing application running. A failure after
application rollout begins automatically reapplies the accepted `current`
application manifest under the same deployment lock; it never reverses the
database. The GitHub workflow also reapplies `current` when public smoke or
internal acceptance rejects an otherwise-ready candidate. Never run
`prisma migrate reset`.

Run the public Playwright/RBAC smoke from the trusted GitHub runner (the manual
workflow does this automatically). Run internal acceptance on the VM:

```sh
SKIP_PUBLIC_SMOKE=true \
scripts/rehearsal/run-acceptance.sh \
  /opt/flowmind/config/staging.env \
  /opt/flowmind/releases/0.1.0-rc.1/release.env \
  /opt/flowmind/config/smoke.env
```

This runs the remote Playwright journey, AI provider probe, Prometheus target
and metric checks, TLS/cookie/CORS/docs checks, image-history checks, and
secret-fingerprint scanning of logs. It also posts and resolves a controlled
`FlowmindRehearsal` alert in Alertmanager. Configure the required root-owned
`ALERT_DELIVERY_VERIFICATION_HOOK` to block until the external receiver proves
delivery. Only a fully successful acceptance moves
`/opt/flowmind/releases/current` to the candidate.

## Backup and retention

`backup-postgres.sh` uses a PostgreSQL 16 image pinned by digest and a root-only
PG environment file. It creates a compressed custom-format dump, validates it
with `pg_restore --list`, writes a SHA-256 checksum and manifest, then invokes
the root-owned executable `BACKUP_UPLOAD_HOOK` when configured.

The upload hook must copy all three paths exposed as `BACKUP_FILE`,
`BACKUP_CHECKSUM_FILE`, and `BACKUP_MANIFEST_FILE`, download or otherwise
verify the stored object checksum, and use server-side encryption.

Apply bucket lifecycle:

- 14 daily backups;
- 8 weekly backups;
- pre-release backups for at least 30 days after GO;
- managed PostgreSQL PITR for at least 7 days.

## Restore drill

Provision a clean temporary PostgreSQL database and a separate temporary Redis.
The restore environment file contains both the target `PG*` values and the
normal FlowMind runtime variables pointing only to the temporary services.

```sh
POSTGRES_BACKUP_IMAGE=postgres:16-alpine@sha256:<approved-digest> \
RESTORE_SMOKE_ENV_FILE=/opt/flowmind/config/restore-smoke.env \
scripts/rehearsal/restore-drill.sh \
  .artifacts/backups/flowmind-staging-<timestamp>.dump \
  /opt/flowmind/config/restore.env \
  /opt/flowmind/releases/0.1.0-rc.1/release.env
```

The script rejects a non-empty target, restores in one transaction, validates
Prisma status, runs migrations, starts one isolated stack, and runs smoke.
It never connects to or destroys the source staging database. Set
`KEEP_RESTORE_STACK=true` only while collecting evidence.

## Application rollback

Before rollout, confirm that every baseline digest is still pullable. Rollback
uses its previous `release.env` and never changes the database:

```sh
scripts/release/rollback-staging.sh \
  /opt/flowmind/releases/<baseline>/release.env \
  /opt/flowmind/config/staging.env
```

After rollback, require readiness and smoke. If the old application is not
compatible with the migrated schema, stop and perform database recovery
instead of attempting SQL reversal.

Database rollback means restoring the pre-release backup to a new database,
pointing the complete stack to it during an incident window, and validating
migration status/readiness/smoke before traffic moves. Preserve the affected
database for investigation.

## Upgrade rehearsal

Build and retain baseline images for
`e6d727955de9dedd86c9ebf1e05f0de71f3c7cd9`. Deploy them, run smoke to create
durable fixtures, and then run:

```sh
BACKUP_ENV_FILE=/opt/flowmind/config/backup.env \
POSTGRES_BACKUP_IMAGE=postgres:16-alpine@sha256:<approved-digest> \
STAGING_SMOKE_ENV_FILE=/opt/flowmind/config/smoke.env \
scripts/rehearsal/upgrade-rehearsal.sh \
  /opt/flowmind/releases/baseline-e6d7279/release.env \
  /tmp/rc-release-manifest.json \
  /opt/flowmind/config/staging.env
```

The tool captures safe resource identities before and after deployment and
fails if workflows, executions, run history, approvals, templates,
notifications, or triggers disappear or change tenant. This RC intentionally
expects a schema no-op.

## Failure rehearsal

All disruptive scenarios require
`ALLOW_STAGING_FAILURE_REHEARSAL=yes`. Supported scenarios are:

- `migration`: invalid database endpoint; rollout must not begin;
- `api-restart`: SIGTERM and readiness recovery;
- `worker-restart`: SIGTERM and Worker readiness recovery;
- `readiness`: bad Redis URL, failed readiness, then correct recreation;
- `partial`: AI/API update followed by an invalid Worker digest;
- `redis-outage`: user-supplied provider commands revoke and restore only the
  VM-to-staging-Redis rule.

Example:

```sh
ALLOW_STAGING_FAILURE_REHEARSAL=yes \
BASELINE_RELEASE_ENV=/opt/flowmind/releases/baseline-e6d7279/release.env \
STAGING_API_URL=https://api.staging.<domain> \
scripts/rehearsal/failure-rehearsal.sh readiness \
  /opt/flowmind/config/staging.env \
  /opt/flowmind/releases/0.1.0-rc.1/release.env
```

The `readiness` and `partial` scenarios first apply the baseline, inject the
candidate failure, and require a complete application rollback to that
baseline. Neither scenario reverses migrations.

For lease recovery, use a controlled public slow HTTP endpoint, start a GET
workflow, hard-kill the Worker after the step becomes RUNNING, and wait past
the configured lease duration. Require a new Worker to complete the execution
and verify increments in lease-loss/reconciliation metrics. The endpoint must
be staging-owned; do not disable SSRF protections.

## Evidence and abort conditions

Retain release manifest, migration output, backup checksum/manifest,
Playwright JSON/traces, before/after upgrade snapshots, Prometheus target
output, alert delivery evidence, sanitized logs, and elapsed rollback times.

Abort on migration failure, missing digest, unstable readiness, failed smoke,
critical alert, missing required metric, secret fingerprint, restore failure,
or loss/change of historical data. Application rollback is allowed after a
successful migration; SQL rollback is not.
