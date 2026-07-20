# Observability

Planned local stack:

- Structured JSON logs.
- OpenTelemetry collector.
- Prometheus scrape config.
- Grafana dashboards.
- Sentry for error tracking.

Initial metric names:

- `workflow_executions_total`
- `workflow_failures_total`
- `step_duration_seconds`
- `queue_waiting_jobs`
- `queue_failed_jobs`
- `llm_tokens_total`
- `llm_cost_total`
- `webhook_requests_total`
# Observability deployment

`flowmind-alerts.yml` contains the bounded-label minimum alert set for RC environments: service availability, execution queue latency/failures, durable event and notification backlogs, and lease loss.

RC1 also exposes durable execution, approval and dead-letter backlog gauges plus counters for step retries, reconciler/dispatcher failures and event-chain suppression. All dimensions are bounded enums or reason codes; tenant IDs, workflow IDs, execution IDs and emails are deliberately excluded.

Scrape API and Worker metrics only on their internal metrics ports with the configured bearer key. AI metrics remain protected by the same policy. Do not relabel organization, workflow, execution, URL, email or error-message values into Prometheus labels.

Import the rules into the platform Prometheus-compatible service and route `critical` alerts to the release on-call before promoting RC1.
