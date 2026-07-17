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
- AI service endpoints require `x-service-api-key`. LLM provider credentials such as `OPENAI_API_KEY` are used only inside `apps/ai-service` and are never exposed to the worker, frontend, logs, metrics, or public API responses.
- Metrics endpoints are disabled by default and, when enabled, require `Authorization: Bearer <METRICS_API_KEY>` or the operational `x-metrics-api-key` header. Metrics keys are never accepted in query strings.
- Sensitive headers are stripped from persisted webhook metadata.
- Dead-letter and audit-log APIs are tenant-scoped by `x-organization-id`. DLQ viewing requires viewer or higher; manual retry requires editor or higher; AuditLog requires owner or admin.
- Connection APIs are tenant-scoped by `x-organization-id`. Editors can list and use connection metadata, admins can manage and rotate, and only owners can delete.
- Connection secrets are encrypted at rest with AES-256-GCM using `CONNECTION_ENCRYPTION_KEY`. The key is loaded from environment, must decode to 32 bytes, and is not stored in the database.
- Connection plaintext is accepted only during create/rotate/test and is never returned after saving. Workflow versions store `connectionId`, not credentials.
- Expressions use an allowlisted namespace model and never expose connection plaintext, encrypted secrets, API keys, SMTP passwords, webhook tokens, cookies, raw sensitive headers, worker locks, queue internals, or raw provider errors.
- Expression path resolution blocks `constructor`, `prototype`, `__proto__`, `eval`, unsupported syntax, and inherited object properties.
- Graph-backed workflows reject branch cycles, self-targets, missing If/Switch branches, invalid timestamps, and non-positive waits before version persistence. Runtime wait expressions are revalidated after resolution.
- Workflow test runs are tenant-scoped and RBAC-protected. Viewers can inspect history, editors can create/cancel/rerun/skip test waits, and real mode requires explicit confirmation. Mock mode blocks HTTP, AI, email, and database effects; database remains dry-run in real mode v1.

CSRF strategy: the current browser contract assumes same-site web and API deployment with `SameSite=Lax`, Bearer access tokens in memory for normal mutations, and explicit Origin validation for cookie-backed auth mutations. If `REFRESH_COOKIE_SAME_SITE=none` is used for cross-site production, add a CSRF token mechanism before launch; CORS alone is not CSRF protection.

Planned controls:

- Advanced session management UI.
- OpenTelemetry traces.
- Sentry sanitization rules.
- Production KMS or Secrets Manager integration.
# Observability Redaction

Trace IDs are diagnostic metadata only. They are not authentication or authorization controls.

Structured logs redact sensitive fields case-insensitively, including `authorization`, `cookie`, `set-cookie`, `password`, `token`, `accessToken`, `refreshToken`, `apiKey`, `x-api-key`, `secret`, `secretValue`, `connectionSecret`, `clientSecret`, `smtpPassword`, `privateKey`, `encryptedValue`, `ciphertext`, `authTag`, `iv`, and `encryptionKey`. URL usernames/passwords and sensitive query parameters such as `token`, `key`, `secret`, and `signature` are redacted before logging.

Logs must not include full webhook bodies, prompts, provider inputs, provider outputs, cookies, bearer tokens, refresh tokens, webhook tokens, internal API keys, or secrets. Persisted execution errors remain operational data, but log events should include only sanitized summaries and categories.

OpenAI provider errors are mapped to sanitized public categories such as `authentication`, `rate_limit`, `timeout`, `validation`, `external_4xx`, and `external_5xx`. Raw OpenAI error bodies, request payloads, prompts, and headers must not be returned to clients.

Metrics are separate from logs and AuditLog. They use bounded labels only and must not contain `requestId`, `correlationId`, organization/user/workflow/execution IDs, emails, hostnames, IPs, full URLs, cookies, tokens, or free-form error messages. See `docs/observability.md`.

# DLQ and AuditLog Sanitization

Dead-letter detail exposes a public error category/code/message rather than raw provider errors. Public metadata is sanitized with the central observability sanitizer and redacts sensitive keys including `authorization`, `cookie`, `set-cookie`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `password`, and `token`.

AuditLog metadata is sanitized before storage through the audit service. It must not contain tokens, hashes, cookies, API keys, passwords, secrets, or real IP addresses.

# Debugger Sanitization

Workflow debugger responses may include user-provided test payloads, resolved configs, prompts, outputs, and errors for authorized organization members. They must pass through public sanitization and never include decrypted connection values, authorization headers, cookies, tokens, encrypted secrets, webhook tokens, or raw provider credential objects.
