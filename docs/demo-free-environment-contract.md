# FlowMind demo-free environment contract

`FLOWMIND_DEPLOYMENT_PROFILE` defaults to `production`. The combined launcher in
`apps/demo-runtime` refuses to start unless the value is exactly `demo-free`.
Production continues to start `apps/api`, `apps/worker`, and `apps/ai-service`
as independent processes.

## Runtime modes

| Variable                      | Production default | Demo value                  |
| ----------------------------- | ------------------ | --------------------------- |
| `FLOWMIND_DEPLOYMENT_PROFILE` | `production`       | `demo-free`                 |
| `FLOWMIND_AI_MODE`            | `external`         | `embedded-fake`             |
| `FLOWMIND_EMAIL_MODE`         | `smtp`             | `embedded-fake`             |
| `REFRESH_COOKIE_PATH`         | `/auth`            | `/api/auth`                 |
| `DEMO_REGISTRATION_ENABLED`   | `false`            | `false`                     |
| `BULLMQ_DRAIN_DELAY_SECONDS`  | `5`                | start at `30`, then measure |
| `DEMO_TELEMETRY_INTERVAL_MS`  | inactive           | `60000`                     |

The embedded provider modes are rejected outside `demo-free`. In external AI
mode, `AI_SERVICE_URL` and `AI_SERVICE_API_KEY` remain mandatory. SMTP and the
Python AI service are not modified.

Use [the checked example](../infrastructure/managed/demo-free.env.example) as
the operator checklist. Never put `FLOWMIND_DEMO_PASSWORD`, JWT keys, peppers,
database credentials, or Redis credentials in Vercel public variables or Git.
`RENDER_API_KEY` belongs only in the operator environment. It must never be
added to the Render service.

Local deployment and validation tooling reads the two data-service credentials
only from `~/.config/flowmind/demo-free.env`. The file must be a regular,
non-symlink file owned by the current user, outside the repository, with mode
`600`, and contain only:

```dotenv
DATABASE_URL=<Neon pooled URL>
REDIS_URL=<Upstash rediss:// URL>
```

The tooling does not source this file, does not read `.env.local`, and ignores
inherited values for these two variables. It parses and validates the file,
then passes the credentials in memory only to the child process that needs
them. The persistent file is never copied into the repository or deleted after
a gate. Harness-generated secrets such as `METRICS_API_KEY` remain random and
ephemeral for each run.

## Data services

- Local demo-free gates and the combined runtime use a pooled Neon endpoint with
  `sslmode=require&connect_timeout=15&connection_limit=3`.
- Upstash must expose its standard `rediss://` endpoint. The REST API is not a
  BullMQ transport. Eviction must remain disabled.
- In the deployed environment, `DATABASE_URL` and `REDIS_URL` belong only to
  the Render Web Service. The local persistent copy is exclusively for the
  operator gates.
- `FLOWMIND_API_ORIGIN` is a server-side Vercel value used by the rewrite.
- `NEXT_PUBLIC_API_URL` points to the Vercel deployment plus `/api`.
- `NEXT_PUBLIC_FLOWMIND_DEMO_FREE=true` displays the portfolio limitations and
  replaces public registration with the curated-account message.

The demo telemetry loop logs aggregate execution, event, notification, and
approval backlogs plus process RSS. It never uses tenant IDs as labels or log
fields and is inactive in the production profile.

## Browser boundary

The browser calls the Vercel origin. Vercel rewrites `/api/*` to Render, making
the refresh cookie first-party. The cookie remains Secure, HttpOnly,
SameSite=Lax, and is scoped to `/api/auth`. Configure `CORS_ORIGIN` and
`PUBLIC_APP_URL` to the production Vercel origin; previews are intentionally
not authorized by default.
