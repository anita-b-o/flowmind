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

The root `test`, `test:integration`, and `test:e2e` commands run workspace packages
sequentially. Database-backed suites share the local PostgreSQL schema and Redis DB,
and their tenant-safe cleanup helpers must never run concurrently across packages.

Run History smoke coverage must use PostgreSQL, Redis, BullMQ and a real worker for: Webhook/FOR_EACH/TRY_CATCH/Data Store; Scheduled/Approval/resume; Event Trigger/EXECUTE_WORKFLOW; and failed execution/Event Trigger/Notification. Assertions must compare the public Viewer response with persisted metadata and include cross-tenant and secret-canary checks. Poll terminal state with bounded timeouts rather than fixed sleeps.

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

## Workflow Builder

- Graph v2 validation helpers cover valid connections, self-loops, cycles, disconnected nodes, duplicate step IDs/keys, If/Switch branch rules, required config, and expression availability.
- Visual editor tests cover dirty state, save success/error, duplicate-save prevention, autosave recovery, debugger source choice, and read-only activation flow.
- Autosave tests must use mocked browser storage and must not store tokens, decrypted secrets, or credentials.

## AI Service

- Pydantic schema validation.
- Invalid output behavior.
- Provider fake tests.
- OpenAI provider tests with mocked HTTP clients only; no test may call the real OpenAI API.
- Timeout, retry, rate-limit, authentication, quota, invalid JSON, structured-output validation, configuration, and sanitization tests.

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
API integration and e2e commands acquire `/tmp/flowmind-api-db-tests.lock` with `flock` before starting Jest. This is required because the legacy integration suites share one PostgreSQL database and several of them perform global fixture cleanup. `--runInBand` only serializes suites inside one Jest process; the process lock also prevents two independent API integration/e2e commands from deleting each other's parents while a Worker or dispatcher is still active. Unit tests do not acquire this lock.
