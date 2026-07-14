# Automation Platform

Mini Zapier + GPT para workflows empresariales multi-tenant.

## Stack

- Web: Next.js, React, TypeScript, TanStack Query, React Hook Form, Zod.
- API: NestJS, Prisma, PostgreSQL, JWT, Swagger.
- Worker: NestJS, BullMQ, Redis.
- IA: FastAPI, Pydantic, abstraccion de provider LLM.
- Infra local: Docker Compose, PostgreSQL, Redis, Mailpit.

## Inicio rapido

```bash
corepack pnpm install
cp .env.example .env
docker compose up -d
corepack pnpm db:generate
corepack pnpm dev
```

Servicios locales:

- API: `http://localhost:3001`
- Swagger: `http://localhost:3001/docs`
- Web: `http://localhost:3000`
- AI Service: `http://localhost:8000`
- Mailpit: `http://localhost:8025`

## Webhooks

Create a webhook trigger with:

```bash
POST /workflows/:workflowId/triggers
```

The plaintext token is returned only on create or rotate. The API stores only a SHA-256 hash with `WEBHOOK_TOKEN_PEPPER`.

Use the returned URL:

```bash
POST /webhooks/:workflowId/:token
Idempotency-Key: external-event-id
Content-Type: application/json
```

Webhook idempotency is scoped per organization and workflow. The API creates the execution in PostgreSQL first, publishes a deterministic BullMQ job, then marks the idempotency key as `ENQUEUED`. If enqueue fails, the execution and idempotency key are marked `FAILED` so a later retry can recover instead of being falsely accepted.

Webhook intake accepts JSON only, applies `WEBHOOK_PAYLOAD_MAX_BYTES`, and rate-limits by workflow/IP before token validation plus organization/workflow/trigger/IP after validation.

## Conditional Step

The MVP conditional is linear and supports `skipNextOnFalse`:

```json
{
  "left": "{{trigger.body.priority}}",
  "operator": "equals",
  "right": "high",
  "skipNextOnFalse": true
}
```

When false, the next step is persisted as `SKIPPED` and the runner continues with the following step.

## Executions

Use:

```bash
GET /executions
GET /executions/:executionId
```

Both endpoints require JWT plus `x-organization-id` and never return executions from another organization.

## Principios

- PostgreSQL es la fuente de verdad.
- Redis se usa para colas, locks y rate limiting.
- La API no ejecuta workflows durante requests HTTP.
- Los prompts y llamadas LLM viven solo en `apps/ai-service`.
- Todo recurso de negocio pertenece a una organizacion.
