# Observability

Metrics are disabled by default and do not require Prometheus or Grafana to run locally.

## Enabling metrics

Set:

```env
METRICS_ENABLED=true
METRICS_API_KEY=replace-with-a-long-random-value
METRICS_HOST=127.0.0.1
API_METRICS_PORT=9464
WORKER_METRICS_PORT=9465
AI_METRICS_PORT=9466
```

In production, metrics must not be enabled without a non-trivial `METRICS_API_KEY`. Do not log or commit the key.

## Endpoints

- API NestJS: separate minimal HTTP server on `METRICS_HOST:API_METRICS_PORT`.
- Worker NestJS: separate minimal HTTP server on `METRICS_HOST:WORKER_METRICS_PORT`.
- AI FastAPI: protected `/metrics` on the FastAPI app. This keeps the Python service small in this iteration; `AI_METRICS_PORT` is reserved for a future split server if needed.

Disabled metrics return 404 or no server. Enabled endpoints return 401 when credentials are missing, 403 when invalid, and 200 for valid credentials.

Use:

```http
Authorization: Bearer <METRICS_API_KEY>
```

`x-metrics-api-key` is also accepted for operational scrapers that cannot set Bearer auth. Query-string keys are not accepted.

## Example scrape config

```yaml
scrape_configs:
  - job_name: flowmind-api
    static_configs:
      - targets: ["127.0.0.1:9464"]
    authorization:
      type: Bearer
      credentials: "${METRICS_API_KEY}"
```

## Metrics

API:

- `flowmind_http_requests_total`
- `flowmind_http_request_duration_seconds`
- `flowmind_http_errors_total`
- `flowmind_webhook_requests_total`
- `flowmind_webhook_rejected_total`
- `flowmind_webhook_rate_limited_total`
- `flowmind_auth_login_total`
- `flowmind_auth_refresh_total`
- `flowmind_auth_refresh_reuse_detected_total`
- `flowmind_manual_retries_total`
- `flowmind_enqueue_failures_total`
- `flowmind_readiness_failures_total`

Worker:

- `flowmind_workflow_jobs_received_total`
- `flowmind_workflow_executions_completed_total`
- `flowmind_workflow_executions_failed_total`
- `flowmind_workflow_executions_reconciled_total`
- `flowmind_execution_lease_acquire_total`
- `flowmind_execution_lease_conflict_total`
- `flowmind_execution_lease_lost_total`
- `flowmind_step_executions_total`
- `flowmind_step_retries_total`
- `flowmind_step_failures_total`
- `flowmind_step_duration_seconds`
- `flowmind_step_wait_scheduled_total`
- `flowmind_step_wait_duration_seconds`
- `flowmind_branch_selected_total`
- `flowmind_graph_validation_failures_total`
- `flowmind_dlq_entries_total`
- `flowmind_dlq_publish_failures_total`
- `flowmind_worker_active_jobs`
- `flowmind_reconciler_runs_total`
- `flowmind_reconciler_reenqueued_total`
- `flowmind_reconciler_duration_seconds`

AI:

- `flowmind_ai_requests_total`
- `flowmind_ai_request_duration_seconds`
- `flowmind_ai_errors_total`
- `flowmind_ai_input_tokens_total`
- `flowmind_ai_output_tokens_total`
- `flowmind_ai_cost_usd_total`

The fake AI provider reports zero tokens and zero cost because it does not receive provider billing data. OpenAI reports input and output tokens when the API returns usage. Cost remains zero until a pricing catalog is introduced; values are not estimated.

AI service logs may include operation, provider, model, duration, retry count, token counts, and error category. They must not include prompts, provider request/response bodies, API keys, Authorization headers, or raw provider errors.

## Labels

Allowed labels are controlled catalogs: `service`, `method`, `route`, `status_code`, `status_class`, `outcome`, `step_type`, `error_category`, `operation`, `provider`, `queue`, `trigger_type`, `branch`, `reason`, and `reason_code`.

Prohibited labels include `requestId`, `correlationId`, `organizationId`, `userId`, `workflowId`, `workflowVersionId`, `executionId`, `stepExecutionId`, `jobId`, `workerId`, `email`, `hostname`, `IP`, full URL, free-form error message, and free-form reason.

API HTTP metrics exclude `/health`, `/health/live`, and `/health/ready` to keep functional traffic separate from probes. Readiness failures are counted by `reason_code`.

## Logs, metrics and AuditLog

Logs carry sanitized context for debugging and may include request/correlation IDs. Metrics are low-cardinality counters, gauges and histograms without business IDs. AuditLog remains the business audit trail and is not changed by metrics.

Metrics servers close during graceful shutdown. Metrics availability is not part of API or worker readiness.

AuditLog is used for critical user-visible actions such as manual retry, DLQ resolution, trigger changes, workflow activation, logout-all, and refresh-session reuse detection. Technical events such as heartbeats, step completion, metrics increments, automatic retry, and reconciler passes stay in logs/metrics rather than AuditLog.

Flow-control runtime decisions such as branch selection, skipped branches, scheduled waits, and resumed waits are logs/metrics, not AuditLog events. Creating or activating graph-backed workflow versions remains a business audit event.

Workflow test runs record business AuditLog entries for creation, cancellation, real-mode enablement, and test wait skipping. Debug payloads, prompts, outputs, resolved values, mock bodies, and comparison details must not be logged or used as metric labels.

Connection create, update, rotate, revoke, delete, and test actions are AuditLog events. Audit metadata must contain only safe fields such as connection id, type, status, and test outcome; encrypted payload fields and plaintext credentials are redacted by the shared sanitizer.
