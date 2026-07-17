# Architecture

The platform starts as a pragmatic modular monorepo:

- `apps/web`: Next.js frontend.
- `apps/api`: NestJS public API, auth, tenancy, workflow management and webhook intake.
- `apps/worker`: NestJS background worker for workflow executions.
- `apps/ai-service`: FastAPI service that owns prompts, provider abstraction and strict AI schemas.
- `packages/shared-types`: domain contracts shared by Node apps.
- `packages/config`: environment validation helpers.

PostgreSQL is the source of truth. Redis powers BullMQ queues and operational locks.

The workflow engine supports ordered workflows and persisted DAG routing through Graph v2 for If/Switch branches, skipped paths, Delay, and Wait Until.

## AI Service

The AI service exposes stable internal HTTP endpoints for the worker: `/classify`, `/extract`, `/summarize`, and `/evaluate`. Provider selection is configured inside the service with `LLM_PROVIDER`; the worker and frontend do not select providers directly.

`LLM_PROVIDER=fake` remains the local default. `LLM_PROVIDER=openai` uses OpenAI Responses API with strict JSON outputs. Each provider must implement the existing `complete_json(task, payload)` boundary and return validated JSON matching the existing FastAPI response contracts. Extraction additionally validates model output against the requested JSON Schema when one is supplied.

OpenAI configuration is environment-driven: `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES`, `OPENAI_TEMPERATURE`, and `OPENAI_MAX_OUTPUT_TOKENS`. Models are never hardcoded.

## Workflow Builder

Workflow editing supports a visual React Flow builder plus a form fallback. The frontend builds local drafts, validates type-specific config and Graph v2 routing immediately, and serializes the result to the existing `POST /workflows/:workflowId/versions` DTO. Drafts are local browser state until saved, except debugger test runs can persist an explicit immutable draft snapshot owned by `WorkflowTestRun`.

The visual builder distinguishes clean, dirty, saving, saved, save-error, and recovered-local states. It keeps recovery snapshots in browser storage scoped by user, organization, workflow, and base version. Recovery snapshots never contain decrypted credentials or auth tokens and are never published automatically.

The workflow detail API exposes all versions and ordered steps so the UI can show history, open older versions read-only, and keep only the latest version editable. Activating a version remains an explicit API call and records the existing workflow activation audit event.

Connections are organization-scoped metadata records with encrypted `Secret` rows. Workflow versions store `connectionId` for HTTP and email steps rather than credentials. The worker resolves and decrypts the active secret immediately before executing a step, then persists only sanitized operational output.

Workflow step configs can use the shared expression engine to reference webhook data, previous step outputs, safe workflow/execution/organization metadata, non-secret variables, and safe connection metadata. New workflow versions created by the Builder use strict expression validation; older versions remain legacy-compatible.

## Step Recovery Engine

PostgreSQL is the source of truth for workflow recovery. BullMQ delivers execution jobs at least once, but step retry is controlled by `StepExecution`, not by job attempts. Each logical workflow step has one row keyed by `(execution_id, step_key)`, with `attemptCount`, `maxAttempts`, `nextRetryAt`, `effectKey`, `effectStatus`, and `workerId`. Production rows also reference `WorkflowStep`; draft test-run snapshot rows may not.

The runner reloads `Execution`, `WorkflowVersion`, `WorkflowStep`, and `StepExecution` before progressing. Completed and skipped steps are reused from persisted output; `contextJson` is only a cache rebuilt from step rows.

Workflow versions with `workflowDefinitionSchemaVersion: 2` add an acyclic `definitionJson.graph` on top of the flat step list. The worker follows persisted control outputs for If/Switch, skips unselected branch steps, and uses `StepExecution.nextRetryAt` for durable Delay/Wait Until pauses. Versions without schema v2 continue through the legacy linear runner.

Before a handler runs, the worker reconstructs expression scope from persisted execution input and completed `StepExecution.outputJson`, resolves the current step config once, and stores only the resolved step input on `StepExecution.inputJson`.

Retry policies are normalized on version creation to `maxAttempts` 1..5, `backoffMs` 100..60000, `strategy` fixed/exponential, and `timeoutSeconds` 1..120. Values outside the allowed range are clamped rather than rejected so clients can submit conservative defaults without breaking version creation.

Effect idempotency is handled per step type: database records use a dedupe key, HTTP mutations receive a stable `Idempotency-Key`, and completed AI/email outputs are not re-executed during resume.

## Dead Letters and Manual Retry

Executions that fail definitively are preserved as `DeadLetterExecution` rows. DLQ rows remain available after resolution so incidents can be reviewed later. Public APIs expose only sanitized error category/code/message and bounded metadata; worker IDs, locks, queue job IDs, headers, secrets, and raw provider objects stay internal.

Manual retry creates a new `Execution` linked through `retryOfExecutionId`. It preserves the original workflow version, input, and correlation ID, resolves active DLQ rows as `RETRIED`, and records audit events. The original execution is immutable. Ambiguous external effects may repeat, so manual retry is an operational recovery tool rather than an exactly-once guarantee.

## Workflow Debugger

Builder test runs create `Execution` rows with `executionMode=TEST` and companion `WorkflowTestRun` rows for payloads, mocks, immutable snapshot definition, actor, and debugger history. They reuse the same runner, Graph v2 planner, leases, retries, waits, and context reconstruction as production executions.

The worker intercepts external-effect steps in test mock mode before HTTP, AI, email, or database handlers perform real work. Confirmed real-mode tests require admin/owner role; HTTP, AI, and email may run, while database steps remain dry-run. Test failures do not create operational DLQ incidents. Production execution APIs filter to `executionMode=REAL`, while debugger APIs read test history through workflow-scoped endpoints.

## Audit Log

`AuditLog` is the business audit trail for critical user-visible actions. It is distinct from structured technical logs and metrics. Current audited actions include manual retry requested, DLQ resolved, trigger created/rotated, workflow activated, logout-all, refresh-session reuse detection, and connection create/update/rotate/enable/disable/delete/test.

## Trace Context

Every API HTTP request receives a boundary-local `requestId` and a flow-level `correlationId`. Clients may provide `x-request-id` and `x-correlation-id` when they match `^[A-Za-z0-9._:-]{8,128}$`; invalid values are ignored and replaced. Both IDs are returned as response headers.

`requestId` identifies one operation inside one boundary. `correlationId` follows the business flow across webhook intake, `Execution`, BullMQ jobs, worker processing, step execution, and AI service calls. These IDs are for diagnostics only and are never used for authorization.

Webhook intake stores `requestId`, `correlationId`, method, sanitized query, sanitized headers, bounded payload, and payload hash on `WebhookEvent`; stores `correlationId` on `Execution`; and includes `correlationId` plus enqueue metadata in the BullMQ payload. Idempotency is scoped to organization and trigger before enqueue. Idempotent webhook repeats keep the original execution correlation ID, while reused keys with different payloads are rejected. Manual retries inherit the original execution correlation ID so the incident and retry remain linked.

Logs in API, worker, and AI service are structured. Production uses JSON, development can use pretty output. Logs use centralized redaction for credentials and sensitive fields, and do not include webhook bodies, prompts, cookies, bearer tokens, refresh tokens, API keys, or full step outputs by default.

## Operational Metrics

API and worker each own an explicit Prometheus registry and expose metrics from a protected, minimal HTTP server only when `METRICS_ENABLED=true`. The API server binds `METRICS_HOST:API_METRICS_PORT`; the worker server binds `METRICS_HOST:WORKER_METRICS_PORT`. Metrics servers are closed during graceful shutdown and are not part of functional readiness.

The AI service exposes protected `/metrics` from FastAPI in this iteration to keep the Python service small; `AI_METRICS_PORT` remains configured for a future split server. Metrics use bounded labels only. Business IDs, trace IDs, emails, hostnames, IPs, full URLs, and free-form errors are never metric labels.

See `docs/observability.md` for the catalog and label policy.
