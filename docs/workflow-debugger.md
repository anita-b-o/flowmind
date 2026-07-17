# Workflow Debugger / Test Runner

Flowmind supports workflow test runs from the Builder without mixing them with production executions.

## Runtime Model

- A test run creates a normal `Execution` with `execution_mode=TEST`.
- The runner, leases, Graph v2 routing, retries and durable waits are reused.
- `WorkflowTestRun` stores the test payload, mock configuration, immutable snapshot definition, external mode and actor.
- Persisted-version tests snapshot that version definition at creation time.
- Draft tests snapshot the submitted draft definition; later editor changes do not affect an active or historical test run.
- Production execution APIs exclude test runs by default.

The builder makes the test source explicit. If there are no local changes, the debugger runs the selected saved workflow version. If local changes exist, the user must choose to save and test the new version, test an explicit draft snapshot, or cancel. Draft snapshots use the existing `draftDefinition` field on `POST /workflows/:workflowId/test-runs`; no separate test mechanism exists.

## Modes

- `mock`: default. HTTP, AI, email and database effects are intercepted before handlers perform external work. Mock outputs include simulated/dry-run markers.
- `real`: requires admin or owner role plus explicit UI and API confirmation. HTTP, AI and email may run; database remains dry-run in v1.

Real confirmation is not implied by selecting the mode. The frontend shows the side-effect node list and requires a separate checkbox. The backend validates `realModeConfirmed: true` and the caller role again before queueing the run.

## Side Effect Policy

- HTTP request steps are mocked in mock mode and may run only in confirmed real mode.
- AI steps are mocked in mock mode and may call the AI service only in confirmed real mode.
- Email steps are mocked as previews in mock mode and may send only in confirmed real mode.
- Database record steps are always dry-run for test runs, including real mode.

## Debug Data

Each step may expose sanitized inspector data:

- input
- resolved config
- expression results
- variable resolution rows
- output
- retry state
- error
- safe connection metadata

Secrets, decrypted credentials, authorization headers, cookies, tokens and raw provider credentials must never be persisted in debugger artifacts or returned. Step inputs, outputs, errors, resolved configs, expression traces, payloads and mock configs are sanitized recursively.

## Cancellation and Waits

Cancellation marks the underlying `Execution` as `CANCELLED`, clears the lease and prevents the worker from starting additional nodes. Artifacts already written on `StepExecution` remain available.

Skip wait is available only for test-run `delay` and `wait_until` steps that are currently waiting. It is idempotent after a successful skip, records an audit event, clears `nextRetryAt`, completes the waiting step, and requeues the same execution.

## API

- `POST /workflows/:workflowId/test-runs`
- `GET /workflows/:workflowId/test-runs`
- `GET /workflows/:workflowId/test-runs/:testRunId`
- `POST /workflows/:workflowId/test-runs/:testRunId/cancel`
- `POST /workflows/:workflowId/test-runs/:testRunId/rerun`
- `POST /workflows/:workflowId/test-runs/:testRunId/steps/:stepKey/skip-wait`
- `GET /workflows/:workflowId/test-runs/:testRunId/compare-last-real`

Create request:

```json
{
  "workflowVersionId": "version-id",
  "payload": { "trigger": { "body": { "email": "ada@example.com" } }, "metadata": {} },
  "externalMode": "mock",
  "stepMocks": {},
  "compareWithLastReal": true
}
```

For real mode:

```json
{
  "payload": { "trigger": { "body": { "email": "ada@example.com" } } },
  "externalMode": "real",
  "realModeConfirmed": true
}
```

## UI

The Builder has a `Debugger` tab with:

- payload editor
- mock/real mode selector
- run, cancel and rerun actions
- React Flow node status overlay
- per-step inspector
- timeline
- last 20 test runs
- comparison with latest real execution
- side-effect node list before real mode

## Tests

Use `pnpm test:unit` for unit tests that do not require PostgreSQL or Redis. Use `pnpm test:integration` for database/queue-backed tests and start PostgreSQL plus Redis first, for example with `docker compose up postgres redis`. `pnpm test:e2e` is reserved for full flow tests.

Known limitation: real-mode test runs can perform external HTTP, AI and email effects after confirmation. Database writes remain dry-run until an explicit, documented production-safe policy is added.

## Audit Events

- `workflow.test_run.created`
- `workflow.test_run.cancelled`
- `workflow.test_run.real_mode_enabled`
- `workflow.test_run.wait_skipped`
