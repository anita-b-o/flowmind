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
- Graph flow tests for If, Switch, skipped branches, Delay, and Wait Until resume.

## AI Service

- Pydantic schema validation.
- Invalid output behavior.
- Provider fake tests.
- Timeout/fallback tests once real providers are added.

## Expressions

- Parser accepts only `{{namespace.path}}` expressions.
- Resolver preserves JSON types for complete expressions and stringifies mixed templates.
- Strict mode reports missing paths; legacy mode keeps existing empty-string fallback.
- Validation rejects future step references and secret connection paths.
- Graph versions validate expressions against graph predecessors and reject unsafe wait expressions.
- Worker tests should cover HTTP, Email, AI, Conditional, and Database Record config resolution from previous step outputs.

## E2E

Happy path:

```text
Webhook -> extraction -> classification -> condition -> database record -> email -> completed
```

Failure path:

```text
Webhook -> HTTP failure -> retries -> DLQ -> failed execution
```

Flow-control paths:

```text
Webhook -> If/Switch -> selected branch -> completed
Webhook -> Delay/Wait Until -> queued wait -> resumed -> completed
```
