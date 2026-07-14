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
