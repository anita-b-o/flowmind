# Production runbook

## Topology and release order

Deploy Web, API, Worker and AI Service as independent, non-root workloads. PostgreSQL and Redis must be persistent managed services; Redis must support the complete configured `REDIS_URL`, including credentials, database and TLS. Terminate HTTPS at the platform ingress and expose only Web and API publicly.

1. Back up PostgreSQL and record the application image digests.
2. Run the migration image once with `prisma migrate deploy`.
3. Deploy AI Service, then API, Worker and Web.
4. Require ready health checks before shifting traffic.
5. Run an authenticated smoke plus a webhook-to-worker execution.

Application rollback uses the previous image digests. Do not roll back schema migrations destructively; migrations must remain expand/contract compatible.

The executable RC staging procedure, backup/restore commands, failure
rehearsals, and evidence requirements are defined in
`docs/rc1-staging-release-runbook.md`. Production promotion must consume the
same image digests recorded in the staging release manifest; never rebuild
environment-specific images. An RC tag is created only after GO and points to
the exact SHA already represented by that manifest.

## Required configuration

Use the names and constraints in `.env.example`; inject values through the deployment platform, never a committed `.env`. Production startup rejects short/default JWT, session, webhook and AI secrets, missing connection encryption, and `SameSite=None` refresh cookies. Keep API/AI docs disabled unless access is restricted operationally.

`CORS_ORIGIN`, `PUBLIC_APP_URL`, `PUBLIC_API_URL` and the Web build-time `NEXT_PUBLIC_API_URL` must use the final HTTPS origins. The reference compose file is a topology/smoke artifact and intentionally does not provision production databases.

## Backup and restore

- Take encrypted PostgreSQL backups with PITR according to the provider's procedure; retain a pre-migration snapshot for every release.
- Redis is not the source of truth, but enable persistence appropriate to BullMQ and protect it from eviction.
- Restore into an isolated environment, run `prisma migrate status`, start one Worker and execute an end-to-end smoke before declaring the restore usable.
- A release cannot be promoted until a restore drill has succeeded for the selected provider.

## Incident actions

- **API not ready:** inspect database/Redis checks and configuration validation before routing traffic.
- **Worker not ready:** stop new triggers, inspect Redis, reconciler, dispatcher and notification checks, then restart one worker at a time.
- **Stuck executions:** inspect lease timestamps and reconciler metrics; never update execution state manually without an incident record.
- **DLQ growth:** classify the safe error, repair the dependency, then use the audited retry endpoint acknowledging ambiguous external effects.
- **Redis outage:** preserve PostgreSQL, restore Redis, then allow reconciliation to re-enqueue queued/retrying executions.
- **Key rotation:** rotate JWT/webhook keys with an explicit invalidation window. Connection encryption rotation requires a staged decrypt-old/encrypt-new procedure; never discard the old key before all rows are re-encrypted and verified.
