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

## Metrics

Prometheus-compatible metrics are disabled by default. Enable them with `METRICS_ENABLED=true`, bind them internally with `METRICS_HOST=127.0.0.1`, and protect them with `Authorization: Bearer <METRICS_API_KEY>`.

Default ports:

- API metrics: `127.0.0.1:9464`
- Worker metrics: `127.0.0.1:9465`
- AI metrics: protected `/metrics` on the FastAPI service

See `docs/observability.md` for the metric catalog, labels policy, and scrape example.

## Webhooks

Create a webhook trigger with:

```bash
POST /workflows/:workflowId/triggers
```

The plaintext token is returned only on create or rotate. The API stores only a SHA-256 hash with `WEBHOOK_TOKEN_PEPPER`.

## Connections

Organizations can manage encrypted HTTP API key and SMTP connections at `/connections`. Generate a local connection encryption key with:

```bash
openssl rand -base64 32
```

Set it as `CONNECTION_ENCRYPTION_KEY=base64:<value>`. Connection secrets are encrypted with AES-256-GCM, are never returned after saving, and workflow steps reference them by `connectionId`.

## Authentication

The web app keeps access tokens only in memory. `POST /auth/register` and `POST /auth/login` return a short-lived Bearer access token and set a rotating refresh token in an HttpOnly cookie named `refresh_token` by default. The refresh token is never returned in JSON and is stored only as an Argon2 hash in PostgreSQL.

Browser refresh restores the session with `POST /auth/refresh` using `credentials: include`. API and CLI clients can still call protected endpoints with `Authorization: Bearer <accessToken>`; to refresh, use a cookie-preserving HTTP client and call `/auth/refresh`.

Refresh cookies use `HttpOnly`, `SameSite=Lax`, `Path=/auth`, `Secure` in production, and optional `REFRESH_COOKIE_DOMAIN`. Refresh, logout, and logout-all validate `Origin` against `CORS_ORIGIN`. Cross-site `SameSite=None` deployments require an additional CSRF token before production.

Use the returned URL:

```bash
POST /webhooks/:workflowId/:token
Idempotency-Key: external-event-id
Content-Type: application/json
```

Webhook idempotency is scoped per organization and workflow. The API creates the execution in PostgreSQL first, publishes a deterministic BullMQ job, then marks the idempotency key as `ENQUEUED`. If enqueue fails, the execution and idempotency key are marked `FAILED` so a later retry can recover instead of being falsely accepted.

Webhook intake accepts JSON only, applies `WEBHOOK_PAYLOAD_MAX_BYTES`, and rate-limits by workflow/IP before token validation plus organization/workflow/trigger/IP after validation.

## Workflow Builder

The web app includes a form-based workflow builder at `/workflows`. Users can create a workflow, edit a local draft, add linear steps, configure each step with type-specific fields, validate immediately, create a new version, and explicitly activate a selected version. Draft edits stay in the browser until `Create version`; no workflow version is activated automatically.

Supported step forms map to the existing engine types: HTTP request, AI classification, AI structured extraction, AI summary, email notification, database record, and conditional. The builder uses the existing webhook trigger definition when creating versions.

HTTP and email steps can select organization-scoped connections. New workflow versions store only `connectionId`; the worker decrypts the active secret only while executing the step. Legacy versions without connections remain readable during the transition.

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

## Dead letters and audit log

Failed executions that exhaust retries are persisted as dead letters. Users with viewer role or higher can open `/dead-letter-executions`, inspect sanitized failure details, and follow the original execution. Editors and above can request a manual retry, which creates a new queued execution with the same workflow version, original input, and correlation ID. The original execution remains unchanged.

Manual retry can repeat ambiguous external effects and does not guarantee exactly-once delivery.

Owners and admins can view `/audit-log` for critical business actions such as manual retries, DLQ resolution, trigger changes, workflow activation, logout-all, and refresh-session reuse detection.

## Principios

- PostgreSQL es la fuente de verdad.
- Redis se usa para colas, locks y rate limiting.
- La API no ejecuta workflows durante requests HTTP.
- Los prompts y llamadas LLM viven solo en `apps/ai-service`.
- Todo recurso de negocio pertenece a una organizacion.
