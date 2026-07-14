# Security

Current controls:

- Short-lived JWT access tokens live only in frontend memory. Access tokens include `tokenType: "access"` and guards reject refresh tokens used as Bearer tokens.
- Refresh tokens are rotating JWTs stored in an HttpOnly cookie and persisted only as Argon2 hashes in `refresh_token_sessions`.
- Refresh cookie flags: `HttpOnly`, `Path=/auth`, `SameSite=Lax` by default, `Secure` in production, optional configured domain, and max age aligned with refresh JWT expiry.
- One session row is created per refresh-token rotation. Rows include `tokenFamily`, `lastUsedAt`, `revokedAt`, `replacedBySessionId`, `userAgent`, and a peppered hash of the normalized IP.
- Refresh rotation is transactional. The previous row is revoked and points to the replacement row. Concurrent reuse of the same refresh token is rejected.
- Reuse detection revokes the whole token family when a revoked or replaced refresh token is presented. The incident is logged without the raw token.
- Logout revokes the current refresh session and clears the cookie. Logout-all revokes all active sessions for the user.
- Concurrent sessions are supported and independently revocable via API endpoints.
- Cookie-backed mutations (`/auth/refresh`, `/auth/logout`, `/auth/logout-all`) validate `Origin` against configured allowed origins. In production, absent origins are rejected unless explicitly configured otherwise.
- Backend-only RBAC.
- Organization guard based on `x-organization-id` plus membership lookup.
- Every business table includes `organization_id`.
- Webhook idempotency keys are persisted.
- Webhook tokens are shown only on create/rotate and stored as SHA-256 hashes with a server-side pepper.
- Webhook intake enforces JSON content type, payload size limits and Redis-backed rate limits.
- HTTP Request steps use the safe HTTP client: protocol allowlist, URL credential rejection, DNS resolution, private/reserved/link-local/metadata IP blocking, manual redirect validation, timeout and response-size limits.
- AI service endpoints require `x-service-api-key`.
- Sensitive headers are stripped from persisted webhook metadata.

CSRF strategy: the current browser contract assumes same-site web and API deployment with `SameSite=Lax`, Bearer access tokens in memory for normal mutations, and explicit Origin validation for cookie-backed auth mutations. If `REFRESH_COOKIE_SAME_SITE=none` is used for cross-site production, add a CSRF token mechanism before launch; CORS alone is not CSRF protection.

Planned controls:

- Advanced session management UI.
- AES-GCM secret encryption helper.
- OpenTelemetry traces.
- Sentry sanitization rules.
- Production KMS or Secrets Manager integration.
