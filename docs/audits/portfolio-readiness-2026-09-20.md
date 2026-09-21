# Portfolio readiness audit — 2026-09-20

## Audit event gap (existing backend behavior)

The audit log endpoint and UI use the existing organization-scoped `/audit-logs` contract. Code review found these events are recorded: workflow version creation (`workflow.version.graph_created` for schema v2), workflow activation (`workflow.activated`), webhook trigger actions, webhook delivery, and execution enqueue/other execution actions. Registration and successful login do not call `AuditLogsService`. Initial workflow creation also has no audit record. Therefore, a newly registered workspace can legitimately show an empty audit log even after registration, login, and workflow creation. This is a backend audit coverage bug and is deliberately documented before the frontend deployment; the only backend change in this pass is the separate approvals pagination contract fix.

Production probe in an isolated portfolio review workspace: a workflow was created, versioned, activated and invoked through a webhook. The webhook returned HTTP 202 and produced execution `ddf69bba-544a-4cee-9e49-8b53b17e9714`. The audit API returned `workflow.version.graph_created`, `workflow.activated`, `webhook.trigger.created`, `webhook.request.accepted`, `webhook.execution.created`, and `execution.completed`. No `auth.register`, `auth.login`, or initial `workflow.created` event appeared. The only `auth.*` entries were `auth.session.reuse_detected` from session probing.

## Approvals API contract bug

Production returned HTTP 400 for `GET /api/approvals?status=PENDING&page=1&pageSize=20` with integer validation errors. The same request without pagination parameters returned HTTP 200. `ListApprovalsQueryDto` lacked numeric query conversion for `page` and `pageSize`; this pass adds `@Type(() => Number)` to those two fields. The frontend also now renders the returned error with Retry, and GET requests have a 60-second timeout to prevent a permanent loading state while allowing Render to wake from idle.

## Navigation decision

`Members` is hidden from the sidebar. The database has `OrganizationMember` and roles, and `/auth/me` returns the current user's role. There is no member-list API or supported management UI, so the existing route cannot truthfully display a member list. Direct navigation remains available but is outside the visible navigation audit.

`Settings` remains visible and shows the current organization and account data already returned by `/auth/me`. There is no settings API to expose.
