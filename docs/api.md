# API Notes

Swagger is exposed from the NestJS API at `/docs`.

Core endpoints implemented initially:

- `POST /auth/register`
- `POST /auth/login`
- `GET /organizations`
- `POST /organizations`
- `GET /workflows`
- `POST /workflows`
- `POST /workflows/:workflowId/versions`
- `PATCH /workflows/:workflowId/versions/:versionId/activate`
- `POST /workflows/:workflowId/triggers`
- `GET /workflows/:workflowId/triggers`
- `PATCH /workflows/:workflowId/triggers/:triggerId/rotate`
- `POST /webhooks/:workflowId/:token`
- `GET /executions`
- `GET /executions/:executionId`
- `GET /health`
