# Testing Strategy

## Commands

- `pnpm test:unit`: unit tests only; must not require PostgreSQL or Redis.
- `pnpm test:integration`: tests that may require PostgreSQL, Redis, migrations, and worker queues.
- `pnpm test:e2e`: full cross-service flows.

For integration and e2e tests, start the required services first:

```bash
docker compose up -d postgres redis
pnpm db:generate
pnpm test:integration
```

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
- Test runtime policy tests for HTTP mock success/error/timeout, AI mock tokens/cost, email preview, database dry-run, and test failures without production DLQ entries.

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

Debugger path:

```text
Builder -> Debugger -> custom payload -> mock test run -> React Flow highlights -> inspector output -> rerun/cancel/skip wait
```

Real-mode debugger path:

```text
Builder -> Debugger -> Real -> explicit confirmation -> side-effect node list -> admin/owner validation -> TEST execution
```
