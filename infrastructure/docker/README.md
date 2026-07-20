# Docker

Local infrastructure is defined in the root `docker-compose.yml`.

Production-oriented, non-root Dockerfiles for Web, API, Worker, AI Service and the one-shot migration job live in this directory. `docker-compose.production.yml` is a reference topology and smoke artifact; it expects externally supplied PostgreSQL, Redis and secrets and is not a substitute for managed production infrastructure.

See `docs/production-runbook.md` for release order, health checks, rollback and restore requirements.
