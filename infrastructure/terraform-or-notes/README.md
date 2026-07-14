# Deployment Notes

Recommended first deployment:

- Vercel for web.
- Render, Railway, Fly.io or ECS Fargate for API, worker and AI service.
- Managed PostgreSQL.
- Managed Redis.
- Platform secrets first, AWS Secrets Manager/KMS when moving to AWS.

Kubernetes is deferred until horizontal scaling and operational complexity justify it.
