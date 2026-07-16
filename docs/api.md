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
