# API Notes

Swagger is exposed from the NestJS API at `/docs`.

Core endpoints:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/logout-all`
- `GET /auth/me`
- `GET /auth/sessions`
- `DELETE /auth/sessions/:sessionId`
- `GET /organizations`
- `POST /organizations`
- `GET /workflows`
- `POST /workflows`
- `POST /workflows/:workflowId/versions`
- `PATCH /workflows/:workflowId/versions/:versionId/activate`
- `POST /workflows/:workflowId/triggers`
- `GET /workflows/:workflowId/triggers`
- `PATCH /workflows/:workflowId/triggers/:triggerId/rotate`
- `POST /webhooks/:workflowId/:token`
- `GET /executions`
- `GET /executions/:executionId`
- `POST /executions/:executionId/retry`
- `GET /dead-letter-executions`
- `GET /dead-letter-executions/:deadLetterId`
- `GET /audit-logs`
- `GET /health`

## Auth Contract

`POST /auth/register` and `POST /auth/login` respond with:

```json
{
  "accessToken": "jwt",
  "user": { "id": "user-id", "email": "user@example.com", "name": "User" },
  "defaultOrganizationId": "organization-id"
}
```

They also set the refresh cookie. The response body never includes `refreshToken`.

`POST /auth/refresh` requires no Bearer token. It reads the refresh cookie, rotates the session, replaces the cookie, and returns the same body shape with a new access token.

Protected API calls use:

```text
Authorization: Bearer <accessToken>
x-organization-id: <organization-id>
```

`POST /auth/logout` revokes the cookie session and returns `204`, even when the cookie is missing or already revoked. `POST /auth/logout-all` requires Bearer auth, revokes every active session for the current user, clears the current cookie, and returns `204`.

`GET /auth/me` returns the current user plus active organization memberships:

```json
{
  "user": { "id": "user-id", "email": "user@example.com", "name": "User" },
  "organizations": [{ "id": "org-id", "name": "Acme", "slug": "acme", "role": "owner" }]
}
```

`GET /auth/sessions` returns safe session metadata only. Hashes, raw refresh tokens, token families, and IP addresses are never returned. `DELETE /auth/sessions/:sessionId` is scoped to the authenticated user and returns `404` for sessions owned by another user.
# API Trace Headers

All API responses include:

```text
x-request-id
x-correlation-id
```

Clients may send valid values for these headers. Invalid values are replaced without failing the request. A valid value is 8 to 128 characters and may contain letters, numbers, `.`, `_`, `:`, and `-`.

Webhook responses include the authoritative `correlationId` in the body. If an idempotent webhook request is replayed with a different correlation header, Flowmind returns the original execution and original correlation ID.

`GET /executions/:id` includes `correlationId`. Dead-letter execution list/detail responses include the correlation ID via the related execution.

## Dead Letter Executions

`GET /dead-letter-executions` requires viewer role or higher and always scopes results to `x-organization-id`. Filters: `status=active|resolved`, `workflowId`, `reason`, `from`, `to`, `page`, and `pageSize`.

`GET /dead-letter-executions/:deadLetterId` returns 404 when the row does not exist or belongs to another organization. Responses include workflow, workflow version, original execution, public failure category/code/message, resolution state, retry execution, and correlation ID. Raw provider errors, payloads, headers, queue job IDs, worker IDs, locks, tokens, cookies, and secrets are not returned.

Public reason catalog: `non_retryable`, `attempts_exhausted`, `ambiguous_effect`, `inconsistent_state`, `execution_limit`, `unknown`.

## Manual Retry

`POST /executions/:executionId/retry` requires editor role or higher:

```json
{ "reason": "optional human-readable reason" }
```

It creates a new queued execution using the same workflow version, original input, and correlation ID. The original execution remains immutable. Any active DLQ rows are resolved as `RETRIED`. A concurrent active retry returns 409. If queue publish fails after commit, the API returns 503 with `recoverable: true` and the created retry execution so clients do not blindly resubmit.

Manual retry can repeat ambiguous external effects and is not exactly-once.

## Audit Logs

`GET /audit-logs` requires owner or admin role and scopes to `x-organization-id`. Filters: `action`, `resourceType`, `resourceId`, `userId`, `correlationId`, `from`, `to`, `page`, and `pageSize`.

Metadata is sanitized and excludes tokens, cookies, hashes, API keys, passwords, secrets, and real IP data.
