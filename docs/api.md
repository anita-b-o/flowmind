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
