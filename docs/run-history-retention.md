# Run History retention

PostgreSQL remains the source of truth for execution observability. Cleanup is operator-only; no scheduled deletion job is installed.

The default policy is 90 days for operational and observability metadata: `Execution`, `StepExecution`, `StepExecutionAttempt`, approvals, dead letters, internal events/deliveries, and notification requests/deliveries. Arbitrary execution payload fields, errors, `debugJson` artifacts, and test-run payloads have a 30-day target. Audit data is a separate compliance category: its retention must follow the organization's audit policy and must not be shortened implicitly by Run History cleanup.

Before cleanup is enabled, an operator must run a tenant-scoped dry-run report containing candidate row counts, estimated JSON bytes, and the oldest row for each model. Cleanup must be bounded, resumable and ordered from optional payload tombstoning to complete root execution trees. Data Store records and organization/workflow variables are outside this policy.

Expired optional JSON fields should be set to null. Required JSON fields should be replaced by `{ "retained": false }`. Complete executions may only be deleted from their root after the metadata period, preserving relation integrity and audit requirements. Production cleanup remains opt-in and must emit only low-cardinality outcome metrics.

Run a report first, using explicit ISO timestamps and a tenant:

```sh
pnpm --filter @automation/api build
pnpm --filter @automation/api retention --dry-run --organization-id <uuid> --payload-cutoff <iso> --metadata-cutoff <iso> --batch-size 100
```

After reviewing the structured report, repeat with `--execute` instead of `--dry-run`. Exactly one mode is mandatory, batches are limited to 1–1000, and future cutoffs are rejected. The command emits counts and estimated JSON bytes, never payloads or resource IDs. Execute repeatedly until `batchLimited` is false. Payload tombstoning precedes deletion of eligible terminal root trees; audit logs, Data Store records and variables are never selected.
