# Testing Strategy

## API

- Unit test auth, RBAC and services.
- Integration test Prisma-backed modules.
- Negative multi-tenant access tests.
- Webhook idempotency tests.

## Worker

- Step handler tests.
- Runner resume tests.
- Timeout and retry tests.
- DLQ behavior tests.

## AI Service

- Pydantic schema validation.
- Invalid output behavior.
- Provider fake tests.
- Timeout/fallback tests once real providers are added.

## E2E

Happy path:

```text
Webhook -> extraction -> classification -> condition -> database record -> email -> completed
```

Failure path:

```text
Webhook -> HTTP failure -> retries -> DLQ -> failed execution
```
