# Architecture

The platform starts as a pragmatic modular monorepo:

- `apps/web`: Next.js frontend.
- `apps/api`: NestJS public API, auth, tenancy, workflow management and webhook intake.
- `apps/worker`: NestJS background worker for workflow executions.
- `apps/ai-service`: FastAPI service that owns prompts, provider abstraction and strict AI schemas.
- `packages/shared-types`: domain contracts shared by Node apps.
- `packages/config`: environment validation helpers.

PostgreSQL is the source of truth. Redis powers BullMQ queues and operational locks.

The first workflow engine supports ordered linear workflows. More advanced DAG semantics are deferred until the persisted workflow definition stabilizes.

## Workflow Builder

Workflow editing is currently form-based rather than node-based. The frontend builds local drafts with React Hook Form, renders each step as an expandable card, validates type-specific config immediately, and serializes the result to the existing `POST /workflows/:workflowId/versions` DTO. Drafts are local browser state only; the backend persists immutable workflow versions.

The workflow detail API exposes all versions and ordered steps so the UI can show history, open older versions read-only, and keep only the latest version editable. Activating a version remains an explicit API call and records the existing workflow activation audit event.

## Step Recovery Engine

PostgreSQL is the source of truth for workflow recovery. BullMQ delivers execution jobs at least once, but step retry is controlled by `StepExecution`, not by job attempts. Each logical workflow step has one row keyed by `(execution_id, workflow_step_id)`, with `attemptCount`, `maxAttempts`, `nextRetryAt`, `effectKey`, `effectStatus`, and `workerId`.

The runner reloads `Execution`, `WorkflowVersion`, `WorkflowStep`, and `StepExecution` before progressing. Completed and skipped steps are reused from persisted output; `contextJson` is only a cache rebuilt from step rows.

Retry policies are normalized on version creation to `maxAttempts` 1..5, `backoffMs` 100..60000, `strategy` fixed/exponential, and `timeoutSeconds` 1..120. Values outside the allowed range are clamped rather than rejected so clients can submit conservative defaults without breaking version creation.

Effect idempotency is handled per step type: database records use a dedupe key, HTTP mutations receive a stable `Idempotency-Key`, and completed AI/email outputs are not re-executed during resume.

## Dead Letters and Manual Retry

Executions that fail definitively are preserved as `DeadLetterExecution` rows. DLQ rows remain available after resolution so incidents can be reviewed later. Public APIs expose only sanitized error category/code/message and bounded metadata; worker IDs, locks, queue job IDs, headers, secrets, and raw provider objects stay internal.

Manual retry creates a new `Execution` linked through `retryOfExecutionId`. It preserves the original workflow version, input, and correlation ID, resolves active DLQ rows as `RETRIED`, and records audit events. The original execution is immutable. Ambiguous external effects may repeat, so manual retry is an operational recovery tool rather than an exactly-once guarantee.

## Audit Log

`AuditLog` is the business audit trail for critical user-visible actions. It is distinct from structured technical logs and metrics. Current audited actions include manual retry requested, DLQ resolved, trigger created/rotated, workflow activated, logout-all, and refresh-session reuse detection.

## Trace Context

Every API HTTP request receives a boundary-local `requestId` and a flow-level `correlationId`. Clients may provide `x-request-id` and `x-correlation-id` when they match `^[A-Za-z0-9._:-]{8,128}$`; invalid values are ignored and replaced. Both IDs are returned as response headers.

`requestId` identifies one operation inside one boundary. `correlationId` follows the business flow across webhook intake, `Execution`, BullMQ jobs, worker processing, step execution, and AI service calls. These IDs are for diagnostics only and are never used for authorization.

Webhook intake stores `requestId` and `correlationId` on `WebhookEvent`, stores `correlationId` on `Execution`, and includes `correlationId` plus enqueue metadata in the BullMQ payload. Idempotent webhook repeats keep the original execution correlation ID. Manual retries inherit the original execution correlation ID so the incident and retry remain linked.

Logs in API, worker, and AI service are structured. Production uses JSON, development can use pretty output. Logs use centralized redaction for credentials and sensitive fields, and do not include webhook bodies, prompts, cookies, bearer tokens, refresh tokens, API keys, or full step outputs by default.

## Operational Metrics

API and worker each own an explicit Prometheus registry and expose metrics from a protected, minimal HTTP server only when `METRICS_ENABLED=true`. The API server binds `METRICS_HOST:API_METRICS_PORT`; the worker server binds `METRICS_HOST:WORKER_METRICS_PORT`. Metrics servers are closed during graceful shutdown and are not part of functional readiness.

The AI service exposes protected `/metrics` from FastAPI in this iteration to keep the Python service small; `AI_METRICS_PORT` remains configured for a future split server. Metrics use bounded labels only. Business IDs, trace IDs, emails, hostnames, IPs, full URLs, and free-form errors are never metric labels.

See `docs/observability.md` for the catalog and label policy.
