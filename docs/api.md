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
- `GET /connections`
- `POST /connections`
- `GET /connections/:connectionId`
- `PATCH /connections/:connectionId`
- `POST /connections/:connectionId/rotate`
- `POST /connections/:connectionId/revoke`
- `POST /connections/:connectionId/enable`
- `POST /connections/:connectionId/disable`
- `DELETE /connections/:connectionId`
- `POST /connections/:connectionId/test`
- `GET /workflows`
- `GET /workflows/:workflowId`
- `POST /workflows`
- `POST /workflows/:workflowId/versions`
- `PATCH /workflows/:workflowId/versions/:versionId/activate`
- `POST /workflows/:workflowId/triggers`
- `GET /workflows/:workflowId/triggers`
- `PATCH /workflows/:workflowId/triggers/:triggerId/rotate`
- `POST /workflows/:workflowId/triggers/event`
- `GET /workflows/:workflowId/triggers/event`
- `GET /workflows/:workflowId/triggers/:triggerId/event`
- `PATCH /workflows/:workflowId/triggers/:triggerId/event`
- `PUT /data-stores/:dataStoreId/records/:key`
- `POST /webhooks/:workflowId/:token`
- `GET /executions`
- `GET /executions/:executionId`
- `POST /executions/:executionId/retry`
- `POST /workflows/:workflowId/test-runs`
- `GET /workflows/:workflowId/test-runs`
- `GET /workflows/:workflowId/test-runs/:testRunId`
- `POST /workflows/:workflowId/test-runs/:testRunId/cancel`
- `POST /workflows/:workflowId/test-runs/:testRunId/rerun`
- `POST /workflows/:workflowId/test-runs/:testRunId/steps/:stepKey/skip-wait`
- `GET /workflows/:workflowId/test-runs/:testRunId/compare-last-real`
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

## Workflow Versioning

`GET /workflows` returns organization-scoped workflows with their active version summary.

`GET /workflows/:workflowId` returns one workflow with `activeVersion`, all `versions`, ordered `steps`, and safe creator metadata for each version. It returns `404` when the workflow does not belong to the active organization.

`POST /workflows/:workflowId/versions` creates the next draft version from the submitted definition:

```json
{
  "trigger": { "key": "webhook", "name": "Webhook", "type": "webhook_trigger", "config": {} },
  "steps": [
    {
      "key": "save_lead",
      "name": "Save lead",
      "type": "database_record",
      "config": { "collection": "leads", "data": { "email": "{{trigger.body.email}}" } },
      "retryPolicy": { "maxAttempts": 1, "backoffMs": 1000, "strategy": "fixed" },
      "timeoutSeconds": 30
    }
  ],
  "workflowDefinitionSchemaVersion": 2,
  "graph": {
    "entryStepKey": "save_lead",
    "edges": [],
    "terminalStepKeys": ["save_lead"]
  },
  "expressionMode": "strict",
  "workflowVariables": {}
}
```

Retry and timeout values are normalized by existing bounds on version creation. For schema version 2, the API validates graph targets, cycles, required If/Switch branches, and Delay/Wait Until literals before persistence. `PATCH /workflows/:workflowId/versions/:versionId/activate` explicitly activates an existing version and archives the previous active version; creation never activates automatically.

HTTP and email step configs should reference connections:

```json
{ "connectionId": "connection-id", "method": "POST", "url": "/leads", "headers": {}, "body": {} }
```

```json
{ "connectionId": "connection-id", "to": "ops@example.com", "subject": "Lead", "text": "Hello" }
```

The API validates that referenced connections belong to the organization, are active, and match the step type. Plaintext secrets are never accepted in public responses. New strict versions also validate expression syntax, namespaces, unsafe segments, and references to unavailable steps.

Expression helper endpoints:

- `GET /workflows/:workflowId/variables/catalog?versionId=...`
- `POST /workflows/:workflowId/expressions/validate`
- `POST /workflows/:workflowId/expressions/preview`
- `GET /variables/organization`
- `PUT|DELETE /variables/organization/:key`
- `GET /workflows/:workflowId/variables`
- `PUT|DELETE /workflows/:workflowId/variables/:key`

Variables store JSON values for expression use and are not a secret store.

## Connections

`GET /connections` requires editor role or higher and returns metadata only: id, type, name, description, status, masked credential, created/updated/rotated timestamps.

`POST /connections` requires admin or owner. Supported public types are `HTTP` and `SMTP`. HTTP accepts `authScheme` values `API_KEY`, `BEARER`, `BASIC`, and `CUSTOM_HEADERS`. Secret fields are used only during create/rotate/test, encrypted, and never returned.

`POST /connections/:connectionId/rotate` replaces the active encrypted secret and revokes the previous one. `POST /connections/:connectionId/disable` blocks future executions without deleting the secret; `enable` reactivates it. `POST /connections/:connectionId/revoke` is a compatibility alias for disable. `DELETE /connections/:connectionId` is owner-only and returns `409 CONNECTION_IN_USE` if an active workflow version references the connection.

`POST /connections/:connectionId/test` verifies HTTP credentials with outbound request safety checks or SMTP credentials with Nodemailer `verify()`. Responses include success, duration, and optional HTTP status only.
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

Public reason catalog: `non_retryable`, `attempts_exhausted`, `ambiguous_effect`, `inconsistent_state`, `invalid_wait`, `branch_resolution_failed`, `control_validation_failed`, `execution_limit`, `unknown`.

## Manual Retry

`POST /executions/:executionId/retry` requires editor role or higher:

```json
{ "reason": "optional human-readable reason" }
```

It creates a new queued execution using the same workflow version, original input, and correlation ID. The original execution remains immutable. Any active DLQ rows are resolved as `RETRIED`. A concurrent active retry returns 409. If queue publish fails after commit, the API returns 503 with `recoverable: true` and the created retry execution so clients do not blindly resubmit.

Manual retry can repeat ambiguous external effects and is not exactly-once.

## Workflow Test Runs

`POST /workflows/:workflowId/test-runs` requires editor role or higher for mock mode and admin or owner for real mode. It creates an isolated `TEST` execution:

```json
{
  "workflowVersionId": "workflow-version-id",
  "payload": { "trigger": { "body": { "email": "ada@example.com" } }, "metadata": {} },
  "externalMode": "mock",
  "stepMocks": {},
  "compareWithLastReal": true
}
```

Default `mock` mode blocks HTTP, AI, email, and database side effects. `real` mode requires `realModeConfirmed: true`; database steps remain dry-run in this iteration.

When `draftDefinition` is provided, the backend validates the graph and stores an immutable snapshot on `WorkflowTestRun`. Later editor changes do not alter that run. Detail responses include `sideEffectNodes` so clients can display what may run for real before confirmation.

Test runs are listed through `GET /workflows/:workflowId/test-runs` and never appear in the production `GET /executions` list. Detail responses include sanitized timeline, graph state, inspector data, safe connection metadata, and optional comparison with the latest real execution for the same workflow version.

## Audit Logs

`GET /audit-logs` requires owner or admin role and scopes to `x-organization-id`. Filters: `action`, `resourceType`, `resourceId`, `userId`, `correlationId`, `from`, `to`, `page`, and `pageSize`.

Metadata is sanitized and excludes tokens, cookies, hashes, API keys, passwords, secrets, and real IP data.
