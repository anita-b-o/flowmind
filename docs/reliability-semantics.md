# RC1 reliability semantics

PostgreSQL is authoritative for executions, step attempts, approvals, internal events/deliveries, notification requests/deliveries and dead letters. Redis/BullMQ is a delivery mechanism and may be rebuilt from durable `QUEUED`/`RETRYING` state by the reconciler.

## Guarantees

- BullMQ is at-least-once. A worker can receive a job again after a crash or stalled lock.
- Execution leases allow one active logical runner. A competing worker returns without running; an expired lease is recovered to `QUEUED`.
- Deterministic BullMQ job IDs reduce duplicate queue entries but are not the sole correctness boundary.
- Step rows are unique by `(execution, step key, execution path)` and attempts by `(step execution, attempt)`. Internal records use a durable dedupe key. These provide exactly-once logical materialization, not a universal exactly-once guarantee for external systems.
- Internal event delivery is unique by `(event, trigger)` and its execution reference is unique. Redis failure after materialization therefore leaves one recoverable PostgreSQL execution.
- Notification request idempotency is unique per tenant. SMTP/HTTP effects can be ambiguous if the process dies after the provider accepts the effect but before PostgreSQL records success; operators must treat those paths as at-least-once and use DLQ/retry warnings.

## Reproducible validation

Run `pnpm test:chaos`. The harness creates isolated PostgreSQL and Redis containers, deploys the existing migrations, tests outages/recovery, competing leases, duplicate jobs, reconciliation, restart and SIGTERM drain, then removes only its own project and volumes. It never touches the development compose project.

All waits use observable queue/database/process conditions with bounded deadlines. No production fault injection or destructive cron is installed.
