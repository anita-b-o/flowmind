# Security

Initial controls:

- JWT access tokens and refresh-token sessions.
- Backend-only RBAC.
- Organization guard based on `x-organization-id` plus membership lookup.
- Every business table includes `organization_id`.
- Webhook idempotency keys are persisted.
- Webhook tokens are shown only on create/rotate and stored as SHA-256 hashes with a server-side pepper.
- Webhook intake enforces JSON content type, payload size limits and Redis-backed rate limits.
- HTTP Request steps use the safe HTTP client: protocol allowlist, URL credential rejection, DNS resolution, private/reserved/link-local/metadata IP blocking, manual redirect validation, timeout and response-size limits.
- AI service endpoints require `x-service-api-key`.
- Sensitive headers are stripped from persisted webhook metadata.

Planned controls:

- Refresh-token rotation endpoint and revocation UI.
- AES-GCM secret encryption helper.
- OpenTelemetry traces.
- Sentry sanitization rules.
- Production KMS or Secrets Manager integration.
