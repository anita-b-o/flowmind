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

## Step Recovery Engine

PostgreSQL is the source of truth for workflow recovery. BullMQ delivers execution jobs at least once, but step retry is controlled by `StepExecution`, not by job attempts. Each logical workflow step has one row keyed by `(execution_id, workflow_step_id)`, with `attemptCount`, `maxAttempts`, `nextRetryAt`, `effectKey`, `effectStatus`, and `workerId`.

The runner reloads `Execution`, `WorkflowVersion`, `WorkflowStep`, and `StepExecution` before progressing. Completed and skipped steps are reused from persisted output; `contextJson` is only a cache rebuilt from step rows.

Retry policies are normalized on version creation to `maxAttempts` 1..5, `backoffMs` 100..60000, `strategy` fixed/exponential, and `timeoutSeconds` 1..120. Values outside the allowed range are clamped rather than rejected so clients can submit conservative defaults without breaking version creation.

Effect idempotency is handled per step type: database records use a dedupe key, HTTP mutations receive a stable `Idempotency-Key`, and completed AI/email outputs are not re-executed during resume.
