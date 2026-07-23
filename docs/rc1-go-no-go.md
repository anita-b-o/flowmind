# RC1 GO/NO-GO record

Release:

- Candidate version:
- Git SHA:
- Planned annotated tag:
- Release manifest SHA-256:
- Baseline manifest:
- Rehearsal date UTC:
- Operator/reviewer:

## Mandatory gates

- [ ] Candidate version and Git SHA match the pre-GO release manifest.
- [ ] Planned annotated tag does not exist locally or on the remote.
- [ ] API, Worker, Web, AI, and migration images match manifest digests.
- [ ] All five digests are pullable and no production rebuild is planned.
- [ ] Unit, integration, API E2E, Worker E2E, chaos, Playwright, lint,
      typecheck, build, and compose smoke passed.
- [ ] Security audit has CRITICAL 0, HIGH 0, and only the accepted
      `@nestjs/core` MODERATE.
- [ ] Pre-deploy backup passed dump, list, checksum, upload, and download
      verification.
- [ ] Pre/post `prisma migrate status` passed and migration marker is present.
- [ ] AI, API, Worker, and Web readiness passed.
- [ ] Login → Workflow → Publish → Execution → Worker → COMPLETED passed.
- [ ] Webhook → Execution → COMPLETED passed.
- [ ] Approval PENDING → Approve → Resume → COMPLETED passed.
- [ ] FULL_REPLAY created a distinct COMPLETED execution.
- [ ] Run History timeline and safe step detail are visible.
- [ ] Cross-tenant and staging RBAC checks passed.
- [ ] Prometheus has exactly three healthy FlowMind targets.
- [ ] Backlog, notification failure, retry, lease, reconciler, dispatcher,
      event-chain, and AI metrics are present.
- [ ] Alertmanager received and resolved a controlled alert.
- [ ] Logs and image history contain no secret fingerprints.
- [ ] TLS/HSTS, Secure cookies, CORS, disabled docs, and rate limiting passed.
- [ ] Restore into a clean temporary database passed full smoke.
- [ ] Application rollback to baseline digests passed smoke.
- [ ] Upgrade preserved workflows, executions, run history, approvals,
      templates, notifications, and triggers.
- [ ] Redis outage, Worker/API restart, migration failure, partial deployment,
      readiness failure, and lease recovery rehearsals passed.

## Known risks requiring acceptance

- [ ] The accepted NestJS MODERATE remains documented and unchanged.
- [ ] Prisma migrations are not assumed reversible; database rollback is
      restore-to-new-database.
- [ ] Staging uses one VM and does not validate host high availability.
- [ ] Main smoke uses the fake AI provider; a separate real-provider probe
      passed.
- [ ] Logs are rotated locally without a centralized log backend.
- [ ] No Grafana dashboards exist for RC1.
- [ ] Current Node images remain large; image minimization is deferred.
- [ ] Retention remains an operator-run command without a scheduler.

## Decision

- [ ] GO
- [ ] NO-GO

Decision notes and unresolved evidence:

After every gate is checked and the decision is GO, validate the independent
tag operation without creating anything:

```sh
scripts/release/create-rc-tag.sh \
  .artifacts/release-manifest.json \
  .artifacts/rc1-go-no-go.md \
  --check
```

Only after explicit tag authorization, use the same command with `--create`.
It creates the annotated tag on the manifest SHA, does not push it, and never
builds images.
