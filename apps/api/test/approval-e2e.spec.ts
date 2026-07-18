import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import request from "supertest";
import { ExecutionReconcilerService } from "../../worker/src/recovery/execution-reconciler.service";
import { QueueService } from "../src/queues/queue.service";
import { ScheduledTriggersService } from "../src/triggers/scheduled-triggers.service";
import { newTraceId } from "@automation/observability";

const prisma = new PrismaClient();

describe("APPROVAL PostgreSQL integration", () => {
  let app: INestApplication;
  let workerContext: any;
  let reconciler: ExecutionReconcilerService;
  let queues: QueueService;
  let scheduledTriggers: ScheduledTriggersService;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/automation_platform";
    process.env.REDIS_URL ??= "redis://localhost:6379";
    process.env.JWT_ACCESS_SECRET ??= "change-me-access-secret";
    process.env.JWT_REFRESH_SECRET ??= "change-me-refresh-secret";
    process.env.PUBLIC_API_URL ??= "http://localhost:3001";
    process.env.WEBHOOK_TOKEN_PEPPER ??= "test-webhook-token-pepper";
    const redis = new Redis(process.env.REDIS_URL); await redis.flushdb(); await redis.quit();
    await cleanDatabase();
    const { AppModule } = await import("../src/app.module");
    const { WorkerModule } = await import("../../worker/src/worker.module");
    const apiModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = apiModule.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    activeApp = app;
    const workerModule = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    workerContext = workerModule; await workerContext.init();
    reconciler = workerModule.get(ExecutionReconcilerService);
    queues = apiModule.get(QueueService);
    scheduledTriggers = apiModule.get(ScheduledTriggersService);
  }, 30_000);

  afterAll(async () => { await workerContext?.close(); await app?.close(); await prisma.$disconnect(); });

  it("enforces tenant visibility and role policy with real rows", async () => {
    const owner = await register("approval-owner@example.com", "Approval Owner");
    const viewer = await register("approval-viewer@example.com", "Viewer Home");
    const editor = await register("approval-editor@example.com", "Editor Home");
    await addMembership(viewer.email, owner.organizationId, "viewer");
    await addMembership(editor.email, owner.organizationId, "editor");
    const pending = await startApproval(owner, "rbac", ["editor"]);

    const viewerList = await request(app.getHttpServer()).get("/approvals").set(headers(viewer, owner.organizationId)).expect(200);
    expect(viewerList.body.items.map((item: any) => item.id)).toContain(pending.approval.id);
    const safe = await request(app.getHttpServer()).get(`/approvals/${pending.approval.id}`).set(headers(viewer, owner.organizationId)).expect(200);
    expect(safe.body).not.toHaveProperty("execution.contextJson");
    expect(JSON.stringify(safe.body)).not.toMatch(/authorization|password|secret|token/i);
    await request(app.getHttpServer()).post(`/approvals/${pending.approval.id}/approve`).set(headers(viewer, owner.organizationId)).send({}).expect(403);

    const outsider = await register("approval-outsider@example.com", "Outsider");
    const outsideList = await request(app.getHttpServer()).get("/approvals").set(headers(outsider)).expect(200);
    expect(outsideList.body.items).toHaveLength(0);
    await request(app.getHttpServer()).get(`/approvals/${pending.approval.id}`).set(headers(outsider)).expect(404);

    await request(app.getHttpServer()).post(`/approvals/${pending.approval.id}/approve`).set(headers(editor, owner.organizationId)).send({ comment: "Looks good" }).expect(201);
    await waitStatus(pending.executionId, "COMPLETED", owner);
    expect(await prisma.internalRecord.count({ where: { executionId: pending.executionId, collection: "approval_approved" } })).toBe(1);

    const restricted = await startApproval(owner, "restricted", ["admin"]);
    await request(app.getHttpServer()).post(`/approvals/${restricted.approval.id}/approve`).set(headers(editor, owner.organizationId)).send({}).expect(403);
    await request(app.getHttpServer()).post(`/approvals/${restricted.approval.id}/reject`).set(headers(owner)).send({}).expect(201);
    await waitStatus(restricted.executionId, "COMPLETED", owner);
  }, 40_000);

  it.each([
    ["approve", "approve"], ["approve", "reject"], ["reject", "reject"]
  ] as const)("allows exactly one concurrent %s/%s decision and one downstream", async (left, right) => {
    const owner = await register(`race-${left}-${right}@example.com`, `Race ${left} ${right}`);
    const started = await startApproval(owner, `race-${left}-${right}`, ["editor"]);
    const results = await Promise.all([
      request(app.getHttpServer()).post(`/approvals/${started.approval.id}/${left}`).set(headers(owner)).send({ comment: "left" }),
      request(app.getHttpServer()).post(`/approvals/${started.approval.id}/${right}`).set(headers(owner)).send({ comment: "right" })
    ]);
    expect(results.map((entry) => entry.status).sort()).toEqual([201, 409]);
    await waitStatus(started.executionId, "COMPLETED", owner);
    const terminal = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: started.approval.id } });
    expect(["APPROVED", "REJECTED"]).toContain(terminal.status);
    expect(terminal.version).toBe(1);
    expect(await prisma.approvalRequest.count({ where: { stepExecutionId: terminal.stepExecutionId } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: started.executionId, stepKey: terminal.status === "APPROVED" ? "approved" : "rejected" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { resourceId: terminal.id, action: { in: ["approval.approved", "approval.rejected"] } } })).toBe(1);
  }, 40_000);

  it("recovers a terminal approval without a Redis resume job idempotently", async () => {
    const owner = await register("approval-recovery@example.com", "Approval Recovery");
    const started = await startApproval(owner, "recovery", ["editor"]);
    await prisma.approvalRequest.update({ where: { id: started.approval.id }, data: { status: "APPROVED", decision: "APPROVED", decidedAt: new Date(), version: { increment: 1 } } });
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.executionId } })).status).toBe("RETRYING");
    await reconciler.reconcile(); await reconciler.reconcile();
    await waitStatus(started.executionId, "COMPLETED", owner);
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId, collection: "approval_approved" } })).toBe(1);
    await reconciler.reconcile();
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId } })).toBe(1);
  }, 40_000);

  it("expires a pending approval after downtime and runs only EXPIRED", async () => {
    const owner = await register("approval-expiry@example.com", "Approval Expiry");
    const started = await startApproval(owner, "expiry", ["editor"]);
    await prisma.approvalRequest.update({ where: { id: started.approval.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await reconciler.reconcile(); await reconciler.reconcile();
    await waitStatus(started.executionId, "COMPLETED", owner);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: started.approval.id } });
    expect(approval.status).toBe("EXPIRED"); expect(approval.version).toBe(1);
    expect(await prisma.internalRecord.findMany({ where: { executionId: started.executionId }, select: { collection: true } })).toEqual([{ collection: "approval_expired" }]);
    expect(await prisma.auditLog.count({ where: { resourceId: approval.id, action: "approval.expired" } })).toBe(1);
  }, 40_000);

  it("allows exactly one terminal transition when approval races expiration", async () => {
    const owner = await register("approval-expire-race@example.com", "Approval Expire Race");
    const started = await startApproval(owner, "expire-race", ["editor"]);
    await prisma.approvalRequest.update({ where: { id: started.approval.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    const [decision] = await Promise.all([
      request(app.getHttpServer()).post(`/approvals/${started.approval.id}/approve`).set(headers(owner)).send({}),
      reconciler.reconcile()
    ]);
    expect([201, 409]).toContain(decision.status);
    await waitStatus(started.executionId, "COMPLETED", owner);
    const terminal = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: started.approval.id } });
    expect(["APPROVED", "EXPIRED"]).toContain(terminal.status);
    expect(terminal.version).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId, collection: terminal.status === "APPROVED" ? "approval_approved" : "approval_expired" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { resourceId: terminal.id, action: { in: ["approval.approved", "approval.expired"] } } })).toBe(1);
  }, 40_000);

  it("cancels a waiting approval and rejects subsequent decisions", async () => {
    const owner = await register("approval-cancel@example.com", "Approval Cancel");
    const started = await startApproval(owner, "cancel", ["editor"]);
    await request(app.getHttpServer()).post(`/executions/${started.executionId}/cancel`).set(headers(owner)).send({ reason: "Root stopped" }).expect(201);
    const cancelled = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: started.approval.id } });
    expect(cancelled).toMatchObject({ status: "CANCELLED", version: 1 });
    await request(app.getHttpServer()).post(`/approvals/${cancelled.id}/approve`).set(headers(owner)).send({}).expect(409);
    await request(app.getHttpServer()).post(`/approvals/${cancelled.id}/reject`).set(headers(owner)).send({}).expect(409);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.executionId } })).status).toBe("CANCELLED");
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { resourceId: cancelled.id, action: "approval.cancelled" } })).toBe(1);
  }, 40_000);

  it("processes duplicate resume deliveries with one logical downstream effect", async () => {
    const owner = await register("approval-duplicate@example.com", "Approval Duplicate");
    const started = await startApproval(owner, "duplicate", ["editor"]);
    await request(app.getHttpServer()).post(`/approvals/${started.approval.id}/approve`).set(headers(owner)).send({}).expect(201);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: started.executionId } });
    const payload = { organizationId: owner.organizationId, executionId: execution.id, workflowId: execution.workflowId, workflowVersionId: execution.workflowVersionId ?? undefined, requestId: newTraceId(), correlationId: execution.correlationId ?? newTraceId(), enqueuedAt: new Date().toISOString() };
    await Promise.all([
      queues.enqueueExecution(payload, `duplicate-${execution.id}-one`).catch(() => undefined),
      queues.enqueueExecution({ ...payload, requestId: newTraceId() }, `duplicate-${execution.id}-two`).catch(() => undefined)
    ]);
    await waitStatus(started.executionId, "COMPLETED", owner);
    expect(await prisma.internalRecord.count({ where: { executionId: started.executionId } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: started.executionId, stepKey: "approved" } })).toBe(1);
    expect((await prisma.stepExecution.findUniqueOrThrow({ where: { id: started.approval.stepExecutionId } })).attemptCount).toBe(1);
  }, 40_000);

  it("materializes sequential FOR_EACH approvals one iteration at a time", async () => {
    const owner = await register("approval-foreach@example.com", "Approval For Each");
    const workflow = (await request(app.getHttpServer()).post("/workflows").set(headers(owner)).send({ name: "Approval loop" }).expect(201)).body;
    const definition = {
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} },
      steps: [
        { key: "loop", name: "Loop", type: "for_each", config: { source: "{{trigger.body.items}}", itemVariable: "record", indexVariable: "position", mode: "SEQUENTIAL", concurrency: 1, continueOnError: false, maxItems: 10, collectResults: true, maxResults: 10 } },
        { key: "approval", name: "Approval", type: "approval", config: { title: "Review {{item.id}}", allowedRoles: ["editor"], assigneePolicy: "ANY_AUTHORIZED_USER" } },
        { key: "approved_path", name: "Approved path", type: "set_variable", config: { scope: "execution", name: "loopDecision", expression: "approved" } },
        { key: "rejected_path", name: "Rejected path", type: "set_variable", config: { scope: "execution", name: "loopDecision", expression: "rejected" } },
        { key: "expired_path", name: "Expired path", type: "set_variable", config: { scope: "execution", name: "loopDecision", expression: "expired" } },
        { key: "done", name: "Done", type: "database_record", config: { collection: "approval_loop_done", data: { total: "{{steps.loop.output.total}}" } } }
      ],
      graph: { entryStepKey: "loop", edges: [
        { from: "loop", to: "approval", kind: "for_each_body" }, { from: "loop", to: "done", kind: "for_each_done" },
        { from: "approval", to: "approved_path", kind: "approval_approved" }, { from: "approval", to: "rejected_path", kind: "approval_rejected" }, { from: "approval", to: "expired_path", kind: "approval_expired" },
        { from: "approved_path", to: "done", kind: "next" }, { from: "rejected_path", to: "done", kind: "next" }, { from: "expired_path", to: "done", kind: "next" }
      ], terminalStepKeys: ["done"] }
    };
    const versionResponse = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions`).set(headers(owner)).send(definition);
    if (versionResponse.status !== 201) throw new Error(JSON.stringify(versionResponse.body));
    const version = versionResponse.body;
    const trigger = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers`).set(headers(owner)).send({}).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(headers(owner)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", "approval-foreach").send({ items: [{ id: "zero" }, { id: "one" }] }).expect(202);
    const first = await waitApproval(webhook.body.executionId);
    expect(first).toMatchObject({ iterationIndex: 0 });
    expect(await prisma.approvalRequest.count({ where: { executionId: webhook.body.executionId } })).toBe(1);
    await request(app.getHttpServer()).post(`/approvals/${first.id}/approve`).set(headers(owner)).send({}).expect(201);
    const second = await waitApprovalCount(webhook.body.executionId, 2);
    expect(second.map((item) => item.iterationIndex)).toEqual([0, 1]);
    expect(new Set(second.map((item) => item.executionPath)).size).toBe(2);
    await request(app.getHttpServer()).post(`/approvals/${second[1].id}/approve`).set(headers(owner)).send({}).expect(201);
    await waitStatus(webhook.body.executionId, "COMPLETED", owner);
    expect(await prisma.internalRecord.count({ where: { executionId: webhook.body.executionId, collection: "approval_loop_done" } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: webhook.body.executionId, stepKey: "done", executionPath: "root" } })).toBe(1);
  }, 40_000);

  it("resumes an APPROVAL child and then its EXECUTE_WORKFLOW parent exactly once", async () => {
    const owner = await register("approval-child@example.com", "Approval Child");
    const started = await startApprovalSubworkflow(owner, "resume");
    expect(started.child).toMatchObject({ parentExecutionId: started.parent.id, rootExecutionId: started.parent.id, status: "RETRYING" });
    expect(started.parent.status).toBe("RETRYING");
    expect(started.approval.executionId).toBe(started.child.id);
    await request(app.getHttpServer()).post(`/approvals/${started.approval.id}/approve`).set(headers(owner)).send({}).expect(201);
    await waitStatus(started.child.id, "COMPLETED", owner);
    await waitStatus(started.parent.id, "COMPLETED", owner);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.child.id } })).outputJson).toMatchObject({ decision: "approved" });
    expect(await prisma.internalRecord.count({ where: { executionId: started.parent.id, collection: "approval_parent_done" } })).toBe(1);
    expect(await prisma.stepExecution.count({ where: { executionId: started.parent.id, stepKey: "save" } })).toBe(1);
  }, 40_000);

  it("cancels a child approval when its root execution is cancelled", async () => {
    const owner = await register("approval-child-cancel@example.com", "Approval Child Cancel");
    const started = await startApprovalSubworkflow(owner, "cancel");
    await request(app.getHttpServer()).post(`/executions/${started.parent.id}/cancel`).set(headers(owner)).send({ reason: "Cancel tree" }).expect(201);
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.parent.id } })).status).toBe("CANCELLED");
    expect((await prisma.execution.findUniqueOrThrow({ where: { id: started.child.id } })).status).toBe("CANCELLED");
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: started.approval.id } })).status).toBe("CANCELLED");
    await request(app.getHttpServer()).post(`/approvals/${started.approval.id}/approve`).set(headers(owner)).send({}).expect(409);
    await request(app.getHttpServer()).post(`/approvals/${started.approval.id}/reject`).set(headers(owner)).send({}).expect(409);
    await delay(200);
    expect(await prisma.internalRecord.count({ where: { executionId: started.parent.id } })).toBe(0);
  }, 40_000);

  it.each(["REJECTED", "EXPIRED"] as const)("routes %s inside TRY_CATCH as business flow, not Catch", async (terminalStatus) => {
    const owner = await register(`approval-try-${terminalStatus.toLowerCase()}@example.com`, `Approval Try ${terminalStatus}`);
    const workflow = (await request(app.getHttpServer()).post("/workflows").set(headers(owner)).send({ name: `Approval try ${terminalStatus}` }).expect(201)).body;
    const branch = terminalStatus.toLowerCase();
    const definition = { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [
      { key: "guard", name: "Guard", type: "try_catch", config: {} },
      { key: "approval", name: "Approval", type: "approval", config: { title: "Review", allowedRoles: ["editor"], assigneePolicy: "ANY_AUTHORIZED_USER" } },
      { key: "approved_business", name: "Approved", type: "database_record", config: { collection: "try_approved", data: { ok: true } } },
      { key: "rejected_business", name: "Rejected", type: "database_record", config: { collection: "try_rejected", data: { ok: true } } },
      { key: "expired_business", name: "Expired", type: "database_record", config: { collection: "try_expired", data: { ok: true } } },
      { key: "caught", name: "Caught", type: "database_record", config: { collection: "try_caught", data: { caught: true } } },
      { key: "cleanup", name: "Cleanup", type: "set_variable", config: { scope: "execution", name: "tryCleanup", value: true } },
      { key: "done", name: "Done", type: "set_variable", config: { scope: "execution", name: "tryDone", value: true } }
    ], graph: { entryStepKey: "guard", edges: [
      { from: "guard", to: "approval", kind: "try_body" }, { from: "guard", to: "caught", kind: "try_catch" }, { from: "guard", to: "cleanup", kind: "try_finally" }, { from: "guard", to: "done", kind: "try_done" },
      { from: "approval", to: "approved_business", kind: "approval_approved" }, { from: "approval", to: "rejected_business", kind: "approval_rejected" }, { from: "approval", to: "expired_business", kind: "approval_expired" },
      { from: "approved_business", to: "cleanup", kind: "next" }, { from: "rejected_business", to: "cleanup", kind: "next" }, { from: "expired_business", to: "cleanup", kind: "next" }, { from: "caught", to: "cleanup", kind: "next" }, { from: "cleanup", to: "done", kind: "next" }
    ], terminalStepKeys: ["done"] } };
    const tryVersionResponse = await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions`).set(headers(owner)).send(definition);
    if (tryVersionResponse.status !== 201) throw new Error(JSON.stringify(tryVersionResponse.body));
    const version = tryVersionResponse.body;
    const trigger = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers`).set(headers(owner)).send({}).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(headers(owner)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", `approval-try-${branch}`).send({ safe: true }).expect(202);
    const approval = await waitApproval(webhook.body.executionId);
    if (terminalStatus === "REJECTED") await request(app.getHttpServer()).post(`/approvals/${approval.id}/reject`).set(headers(owner)).send({}).expect(201);
    else { await prisma.approvalRequest.update({ where: { id: approval.id }, data: { expiresAt: new Date(Date.now() - 1) } }); await reconciler.reconcile(); }
    await waitStatus(webhook.body.executionId, "COMPLETED", owner);
    expect(await prisma.internalRecord.count({ where: { executionId: webhook.body.executionId, collection: `try_${branch}` } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: webhook.body.executionId, collection: "try_caught" } })).toBe(0);
    expect((await prisma.stepExecution.findUniqueOrThrow({ where: { id: approval.stepExecutionId } })).errorHandled).toBe(false);
  }, 40_000);

  it("materializes Scheduled → APPROVAL without waiting for cron and resumes the same execution", async () => {
    const owner = await register("approval-scheduled@example.com", "Approval Scheduled");
    const workflow = (await request(app.getHttpServer()).post("/workflows").set(headers(owner)).send({ name: "Scheduled approval" }).expect(201)).body;
    const definition = approvalDefinition(["editor"]);
    const version = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions`).set(headers(owner)).send(definition).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(headers(owner)).expect(200);
    const scheduled = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers/scheduled`).set(headers(owner)).send({ cron: "0 9 * * *", timezone: "UTC" }).expect(201)).body;
    await prisma.trigger.update({ where: { id: scheduled.id }, data: { nextRunAt: new Date(Date.now() - 1_000) } });
    const materialized = await scheduledTriggers.runDue(scheduled.id, owner.organizationId) as { executionId: string };
    const approval = await waitApproval(materialized.executionId);
    const waiting = await prisma.execution.findUniqueOrThrow({ where: { id: materialized.executionId } });
    const waitingStep = await prisma.stepExecution.findUniqueOrThrow({ where: { id: approval.stepExecutionId } });
    expect(waiting).toMatchObject({ status: "RETRYING", waitReason: "approval" });
    expect(waitingStep).toMatchObject({ status: "RETRYING", effectStatus: "approval_waiting", nextRetryAt: null });
    expect(approval.status).toBe("PENDING");
    expect(await prisma.internalRecord.count({ where: { executionId: materialized.executionId } })).toBe(0);
    await request(app.getHttpServer()).post(`/approvals/${approval.id}/approve`).set(headers(owner)).send({}).expect(201);
    await waitStatus(materialized.executionId, "COMPLETED", owner);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("APPROVED");
    expect(await prisma.internalRecord.count({ where: { executionId: materialized.executionId, collection: "approval_approved" } })).toBe(1);
    expect(await prisma.internalRecord.count({ where: { executionId: materialized.executionId, collection: { in: ["approval_rejected", "approval_expired"] } } })).toBe(0);
  }, 40_000);

  async function startApproval(user: User, suffix: string, allowedRoles: string[]) {
    const workflow = (await request(app.getHttpServer()).post("/workflows").set(headers(user)).send({ name: `Approval ${suffix}` }).expect(201)).body;
    const definition = approvalDefinition(allowedRoles);
    const version = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/versions`).set(headers(user)).send(definition).expect(201)).body;
    const trigger = (await request(app.getHttpServer()).post(`/workflows/${workflow.id}/triggers`).set(headers(user)).send({}).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${workflow.id}/versions/${version.id}/activate`).set(headers(user)).expect(200);
    const webhook = await request(app.getHttpServer()).post(`/webhooks/${workflow.id}/${trigger.token}`).set("Idempotency-Key", `approval-${suffix}`).send({ safe: "context", authorization: "must-not-surface" }).expect(202);
    const approval = await waitApproval(webhook.body.executionId);
    const execution = await prisma.execution.findUniqueOrThrow({ where: { id: webhook.body.executionId } });
    const step = await prisma.stepExecution.findUniqueOrThrow({ where: { id: approval.stepExecutionId } });
    expect(execution).toMatchObject({ status: "RETRYING", waitReason: "approval", lockedBy: null, lockedUntil: null });
    expect(step).toMatchObject({ status: "RETRYING", effectStatus: "approval_waiting", nextRetryAt: null, attemptCount: 1 });
    return { executionId: webhook.body.executionId as string, approval };
  }

  async function startApprovalSubworkflow(user: User, suffix: string) {
    const childWorkflow = (await request(app.getHttpServer()).post("/workflows").set(headers(user)).send({ name: `Approval child ${suffix}` }).expect(201)).body;
    const childDefinition = {
      workflowDefinitionSchemaVersion: 2, expressionMode: "strict",
      trigger: { key: "subworkflow", name: "Subworkflow", type: "subworkflow_trigger", config: {} },
      steps: [
        { key: "approval", name: "Approval", type: "approval", config: { title: "Review child", allowedRoles: ["editor"], assigneePolicy: "ANY_AUTHORIZED_USER" } },
        { key: "approved", name: "Approved output", type: "return_workflow_output", config: { output: { decision: "{{steps.approval.output.decision}}" } } },
        { key: "rejected", name: "Rejected output", type: "return_workflow_output", config: { output: { decision: "{{steps.approval.output.decision}}" } } },
        { key: "expired", name: "Expired output", type: "return_workflow_output", config: { output: { decision: "{{steps.approval.output.decision}}" } } }
      ], graph: { entryStepKey: "approval", edges: [
        { from: "approval", to: "approved", kind: "approval_approved" }, { from: "approval", to: "rejected", kind: "approval_rejected" }, { from: "approval", to: "expired", kind: "approval_expired" }
      ], terminalStepKeys: ["approved", "rejected", "expired"] }
    };
    const childVersion = (await request(app.getHttpServer()).post(`/workflows/${childWorkflow.id}/versions`).set(headers(user)).send(childDefinition).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${childWorkflow.id}/versions/${childVersion.id}/activate`).set(headers(user)).expect(200);
    const parentWorkflow = (await request(app.getHttpServer()).post("/workflows").set(headers(user)).send({ name: `Approval parent ${suffix}` }).expect(201)).body;
    const parentDefinition = { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [
      { key: "call", name: "Call", type: "execute_workflow", config: { workflowId: childWorkflow.id, versionPolicy: "PUBLISHED", input: "{{trigger.body}}", timeoutSeconds: 30 } },
      { key: "save", name: "Save", type: "database_record", config: { collection: "approval_parent_done", data: { decision: "{{steps.call.output.output.decision}}" } } }
    ], graph: { entryStepKey: "call", edges: [{ from: "call", to: "save", kind: "next" }], terminalStepKeys: ["save"] } };
    const parentVersion = (await request(app.getHttpServer()).post(`/workflows/${parentWorkflow.id}/versions`).set(headers(user)).send(parentDefinition).expect(201)).body;
    await request(app.getHttpServer()).patch(`/workflows/${parentWorkflow.id}/versions/${parentVersion.id}/activate`).set(headers(user)).expect(200);
    const response = await request(app.getHttpServer()).post(`/workflows/${parentWorkflow.id}/executions`).set(headers(user)).send({ confirmRealEffects: true, input: { trigger: { body: { request: suffix } } } }).expect(201);
    const approval = await waitApprovalForRoot(response.body.execution.id);
    const child = await prisma.execution.findUniqueOrThrow({ where: { id: approval.executionId } });
    const parent = await prisma.execution.findUniqueOrThrow({ where: { id: response.body.execution.id } });
    return { approval, child, parent };
  }

  async function waitApproval(executionId: string) { for (let i = 0; i < 80; i++) { const row = await prisma.approvalRequest.findFirst({ where: { executionId } }); if (row) return row; await delay(100); } throw new Error("Approval was not created"); }
  async function waitApprovalCount(executionId: string, count: number) { for (let i = 0; i < 80; i++) { const rows = await prisma.approvalRequest.findMany({ where: { executionId }, orderBy: { iterationIndex: "asc" } }); if (rows.length === count) return rows; await delay(100); } throw new Error(`${count} approvals were not created`); }
  async function waitApprovalForRoot(rootExecutionId: string) { for (let i = 0; i < 80; i++) { const row = await prisma.approvalRequest.findFirst({ where: { execution: { rootExecutionId } } }); if (row) return row; await delay(100); } throw new Error("Child approval was not created"); }
  async function waitStatus(executionId: string, status: string, user: User) { for (let i = 0; i < 80; i++) { const response = await request(app.getHttpServer()).get(`/executions/${executionId}`).set(headers(user)); if (response.body.status === status) return response.body; await delay(100); } throw new Error(`Execution ${executionId} did not reach ${status}`); }
});

function approvalDefinition(allowedRoles: string[]) { return { workflowDefinitionSchemaVersion: 2, expressionMode: "strict", trigger: { key: "webhook", name: "Webhook", type: "webhook_trigger", config: {} }, steps: [
  { key: "approval", name: "Approval", type: "approval", config: { title: "Review request", description: "Safe description", summary: "Safe summary", allowedRoles, assigneePolicy: "ANY_AUTHORIZED_USER" } },
  { key: "approved", name: "Approved", type: "database_record", config: { collection: "approval_approved", data: { result: "{{steps.approval.output.decision}}" } } },
  { key: "rejected", name: "Rejected", type: "database_record", config: { collection: "approval_rejected", data: { result: "{{steps.approval.output.decision}}" } } },
  { key: "expired", name: "Expired", type: "database_record", config: { collection: "approval_expired", data: { result: "{{steps.approval.output.decision}}" } } }
], graph: { entryStepKey: "approval", edges: [
  { from: "approval", to: "approved", kind: "approval_approved" }, { from: "approval", to: "rejected", kind: "approval_rejected" }, { from: "approval", to: "expired", kind: "approval_expired" }
], terminalStepKeys: ["approved", "rejected", "expired"] } }; }

type User = { accessToken: string; organizationId: string; email: string };
async function registerUser(app: INestApplication, email: string, organizationName: string): Promise<User> { const response = await request(app.getHttpServer()).post("/auth/register").send({ email, name: email.split("@")[0], password: "password123", organizationName }).expect(201); return { accessToken: response.body.accessToken, organizationId: response.body.defaultOrganizationId, email }; }
function headers(user: User, organizationId = user.organizationId) { return { authorization: `Bearer ${user.accessToken}`, "x-organization-id": organizationId }; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function cleanDatabase() { await prisma.approvalRequest.deleteMany(); await prisma.internalRecord.deleteMany(); await prisma.stepExecution.deleteMany(); await prisma.execution.deleteMany(); await prisma.webhookEvent.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.trigger.deleteMany(); await prisma.workflowStep.deleteMany(); await prisma.workflow.updateMany({ data: { activeVersionId: null } }); await prisma.workflowVersion.deleteMany(); await prisma.workflow.deleteMany(); await prisma.refreshTokenSession.deleteMany(); await prisma.organizationMember.deleteMany(); await prisma.user.deleteMany(); await prisma.organization.deleteMany(); }

// Bound to the application instance inside the suite to keep helpers concise.
let activeApp: INestApplication;
async function register(email: string, organizationName: string) { return registerUser(activeApp, email, organizationName); }
async function addMembership(email: string, organizationId: string, role: "viewer" | "editor" | "admin" | "owner") { const user = await prisma.user.findUniqueOrThrow({ where: { email } }); await prisma.organizationMember.upsert({ where: { organizationId_userId: { organizationId, userId: user.id } }, update: { role, status: "ACTIVE" }, create: { organizationId, userId: user.id, role, status: "ACTIVE" } }); }
