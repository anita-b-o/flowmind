# FlowMind staging topology

This directory is an overlay for the root production Compose topology. It adds
Caddy, Prometheus, and Alertmanager while keeping PostgreSQL and Redis external.

Run Compose with both files and two environment files:

```sh
docker compose \
  --project-name flowmind-staging \
  --env-file /opt/flowmind/config/staging.env \
  --env-file /opt/flowmind/releases/0.1.0-rc.1/release.env \
  --file docker-compose.production.yml \
  --file infrastructure/staging/docker-compose.yml \
  config
```

`staging.env` contains runtime secrets and public staging origins. `release.env`
contains only immutable image references generated from the release manifest.
Both files must be mode `0600`. The metrics key is also mounted from the
root-only path configured by `METRICS_API_KEY_FILE`.

Copy `alertmanager.yml.example` outside the repository, configure the real
on-call receiver, and point `ALERTMANAGER_CONFIG_PATH` to it. External
infrastructure image values must be pinned by digest before the first deploy.

The application uses production security behavior in staging:

- `NODE_ENV=production`;
- AI `ENVIRONMENT=production`;
- Swagger and OpenAPI disabled;
- Secure, HttpOnly, SameSite=Lax refresh cookies;
- metrics reachable only on the private Compose network.
