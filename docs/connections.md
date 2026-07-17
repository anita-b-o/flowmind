# Connections

Connections let each organization store reusable credentials for existing workflow steps without putting secrets in workflow definitions.

## Supported Types

- `HTTP`: reusable HTTP credentials with `authScheme`.
  - `API_KEY`: optional `baseUrl`, `authLocation` (`HEADER` or `QUERY`), `authName`, secret value, and optional non-sensitive headers.
  - `BEARER`: injects `Authorization: Bearer <token>`.
  - `BASIC`: stores username as metadata and password as the encrypted secret.
  - `CUSTOM_HEADERS`: stores a JSON object of secret headers as the encrypted secret.
- `SMTP`: host, port, TLS flag, username, password, optional from name, and from email.

OAuth and provider-specific integrations are intentionally deferred.

## Encryption

Secrets are encrypted at rest with AES-256-GCM. Configure:

```env
CONNECTION_ENCRYPTION_KEY=base64:<32-byte-key>
CONNECTION_ENCRYPTION_VERSION=1
CONNECTION_TEST_TIMEOUT_MS=5000
```

Generate a key with:

```bash
openssl rand -base64 32
```

The encrypted payload stores version, algorithm, IV, ciphertext, auth tag, and key id. The master key is never stored in PostgreSQL and must not be logged.

## Lifecycle

- Create stores metadata on `Connection` and one active encrypted `Secret`.
- Rotate creates a new active secret, revokes the previous active secret, and updates `rotatedAt`.
- Disable marks the connection disabled. Future executions fail clearly until it is enabled again.
- The legacy revoke endpoint maps to disable for compatibility.
- Delete is soft delete and owner-only. Active workflow references return `409 CONNECTION_IN_USE`.
- Test stores safe status metadata (`lastTestedAt`, status, status code, duration, message) without storing request credentials.

Plaintext is never shown after save.

## Workflow Usage

HTTP steps store:

```json
{ "connectionId": "...", "method": "POST", "url": "/leads", "headers": {}, "body": {} }
```

Email steps store:

```json
{ "connectionId": "...", "to": "user@example.com", "subject": "Subject", "text": "Body" }
```

The backend validates tenant, type, and active status when creating workflow versions. The worker decrypts only during execution and does not persist plaintext in step inputs, outputs, or errors.

## Testing

HTTP tests use outbound request safety checks and return only success, duration, and status. SMTP tests call `verify()` and do not send mail.

## Future Work

Future iterations can add OAuth, provider-specific SaaS connections, KMS or Secrets Manager, master-key re-encryption jobs, and arbitrary secret variables in expressions.
